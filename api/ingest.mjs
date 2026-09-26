// POST /api/ingest
//
// Server-side ingestion endpoint called from the Vault UI. Processes one
// already-uploaded document: downloads from storage, extracts text, chunks,
// embeds, and writes passages — same pipeline scripts/ingest.mjs uses.
//
// Auth: Supabase session JWT (the user's browser is already logged in via
// Supabase Auth; we forward their access token as Authorization). All Supabase
// queries run through a client carrying that JWT, so RLS enforces matter
// access — a user cannot ingest into a document they don't own.
//
// Request body:
//   { documentId: uuid }
//
// Response:
//   { ok: true, passageCount: number }     on success
//   { error: string }                       on failure (with status code)
//
// Constraints:
//   - Vercel serverless function timeout is 30s (vercel.json). For documents
//     up to ~100K words / 200 chunks this fits comfortably. Larger inputs
//     will need a different runtime (Edge Function with background, or a
//     dedicated worker). See PATH-B notes for the upgrade path.
//   - On error, the document's processing_status is set to 'error' with the
//     error message in processing_error so the UI can surface it.

import { createClient } from '@supabase/supabase-js';

import { processDocument, planPdfOcr, MEDIA_EXTENSIONS, OCRABLE_IMAGE_EXTENSIONS, needsWorkerIngest, isPdfStructureError } from '../lib/ingest-core.mjs';
import { HELD_STATUS, heldReason, isSealedPipeError } from '../lib/seal-pipes.mjs';
import { makeOcrProvider } from '../lib/ocr-routes.mjs';
import { consumeUsage, sendUsageRefusal } from '../lib/usage-meter.mjs';
import { estimateIngestCents } from '../lib/usage-prices.mjs';
import { verifyIngestConfirmation } from '../lib/ingest-estimate.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Optional: enables transcription of short recordings inline. OCR of a
// scanned JPEG/PNG runs inline too, through the tier's OCR routes
// (lib/ocr-routes.mjs: GOOGLE_API_KEY and/or ANTHROPIC_API_KEY for an
// unsealed matter, the TEXTRACT_* trio for a sealed one). PDFs with scanned
// pages never OCR here — they are routed to the worker below (Phase 2) — so
// for them the keys only matter where the worker runs.
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;


export default async function handler(req, res) {
  // CORS — same pattern as api/mcp.mjs but tighter; only the web app calls this.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'method_not_allowed' });
  }

  // Env sanity
  const missing = [];
  if (!SUPABASE_URL) missing.push('VITE_SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) missing.push('VITE_SUPABASE_ANON_KEY');
  if (!OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (missing.length) {
    return json(res, 500, { error: 'config_error', missing_env: missing });
  }

  // Auth: forward the user's Supabase session JWT.
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return json(res, 401, { error: 'missing_bearer' });
  }
  const userToken = authHeader.slice(7).trim();
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Parse body. Vercel parses JSON automatically when content-type is
  // application/json; req.body is already an object.
  const body = typeof req.body === 'string' ? safeJsonParse(req.body) : req.body;
  const documentId = body?.documentId;
  if (!documentId) return json(res, 400, { error: 'documentId required' });

  // Look up the document. RLS rejects this if the user doesn't have access.
  const { data: doc, error: docErr } = await sb
    .from('documents')
    .select('id, storage_path, source_filename, processing_status, matterspace_id, file_size_bytes, page_count, text_status:metadata->>text_status, ocr_pending:metadata->ocr_pending')
    .eq('id', documentId)
    .maybeSingle();
  if (docErr) return json(res, 500, { error: `lookup: ${docErr.message}` });
  if (!doc) return json(res, 404, { error: 'document_not_found_or_no_access' });
  if (!doc.storage_path) {
    return json(res, 400, { error: 'document has no storage_path; upload the file first' });
  }
  // 'ready' with a recorded text_status (image_only, media_no_transcript, …)
  // is stored-without-text, and 'ready' with ocr_pending still owes OCR on
  // some pages; a re-run from the Vault is how either gets another chance.
  // Only a fully indexed document is "already ready".
  if (doc.processing_status === 'ready' && !doc.text_status && !doc.ocr_pending) {
    return json(res, 200, { ok: true, alreadyReady: true });
  }

  // A big upload must have been quoted before it is read (2026-09-20).
  //
  // The browser shows an estimate above a threshold and sends back what it
  // measured. This does NOT believe the arithmetic: the cents are recomputed
  // here from lib/usage-prices.mjs over the row's OWN file_size_bytes and
  // source_filename, and `ack_cents` is only ever compared against them — a
  // body claiming a penny for a 900-page scan is refused. A page count or
  // duration that was actually measured (declared, or already on the row) is
  // used; only when nothing was measured does the size decide, and then at the
  // cautious end, so this never refuses an upload the browser correctly judged
  // small. Above the threshold it requires the confirmation flag; below it the
  // request body is the `{ documentId }` this endpoint has always taken and
  // nothing here fires at all.
  //
  // The meter below remains the real enforcement. This is about a person being
  // told the price before the work, not about trusting the client.
  //
  // Tier 'A' and an EMPTY env, both deliberately, and both for the same
  // reason: this gate answers "was a quote owed", not "which route will read
  // it". The browser can only ever compute from the tier's policy DEFAULT — it
  // has no process.env — so passing this deployment's env here would make the
  // two sides compute different numbers the moment OCR_TIER_A_ROUTES is
  // flipped to anthropic-vision (which lib/ocr-routes.mjs plans for), and
  // every honest confirmation of a big scan would fail the ack comparison at
  // fifteen times the price. Like for like on both sides; a forged ack is
  // still caught, and Tier A is the dearer of the two OCR routes, so the
  // figure a sealed matter confirms still clears it.
  //
  // It runs BEFORE the meter, so a refusal costs nothing.
  const confirmation = verifyIngestConfirmation({ doc, body, tier: 'A', env: {} });
  if (confirmation) {
    const { status, ...payload } = confirmation;
    return json(res, status, payload);
  }

  // Spend cap (migration 063) — AFTER the alreadyReady short-circuit, so the
  // Vault's polling never spends budget, and BEFORE the file is downloaded or
  // queued, so a refusal costs nothing.
  //
  // What can be metered here is only what is knowable at request time: the
  // declared file size, and page_count when a previous pass filled it in. The
  // real cost of ingestion is per OCR page and per minute of audio, and both
  // are discovered inside lib/ingest-core.mjs and the Fly worker, which this
  // change deliberately does not touch (PR #153 is open on those files). So
  // this is a REQUEST-RATE and declared-size gate, not a page meter: the
  // hourly window is what stops a 5,000-file production, and
  // public.usage_monthly_pages (migration 063) is where the pages that were
  // actually read can be read back per user per month. True per-page metering
  // needs a usage_consume call inside the worker once #153 lands.
  //
  // So the CENTS charged here are the ones knowable now — embedding the text,
  // plus one OCR call for a scanned page that arrived as a JPEG or PNG. That
  // image leaves for the worker a few lines below (since 2026-09-26; before
  // that its OCR ran here), but it is still exactly one OCR call, known at
  // request time, so it is still charged here. A scanned PDF leaves without
  // this function calling any provider, and charging it here for pages
  // nobody has counted would refuse ordinary uploads to bill for work that
  // happens elsewhere.
  const ext0 = '.' + (doc.source_filename || '').split('.').pop().toLowerCase();
  const ingestMeter = await consumeUsage({
    supabaseUrl: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    bearer: userToken,
    kind: 'ingest',
    estimateCents: estimateIngestCents({
      bytes: doc.file_size_bytes || 0,
      ocrableImage: OCRABLE_IMAGE_EXTENSIONS.includes(ext0),
    }),
  });
  if (!ingestMeter.allowed) return sendUsageRefusal(res, ingestMeter);

  // Heavy-job routing: files this function cannot finish inside the 60s
  // serverless budget go to the always-on worker via the processing_jobs
  // queue (worker/discovery-worker.mjs, job_type ingest_document). The Vault
  // UI polls documents.processing_status either way, so queueing is invisible
  // to the caller. Files below the thresholds keep the fast inline path and
  // don't depend on worker uptime at all.
  if (needsWorkerIngest(ext0, doc.file_size_bytes)) {
    const queued = await enqueueForWorker(sb, doc);
    if (queued) return json(res, 202, queued);
  }

  // A RECOVERABLE STATE, written before anything heavy (2026-09-20).
  //
  // Everything below this line — the storage download, extraction, OCR,
  // embedding — can be cut off mid-flight when the 60 s function budget
  // expires, and nothing runs afterwards to record that it happened. What the
  // row says at that moment is the only thing that can save the document, so
  // it is written here, while there is still certainty to write.
  //
  // 'extracting' is what makes it recoverable: the worker's idle sweep
  // (recover_stranded_documents, migration 058) requeues documents sitting in
  // pending/extracting/chunking/embedding with a storage_path and no open
  // job, and the monitor's stalled-document query keys on updated_at, which
  // this write refreshes. Without it a re-run of a document that is already
  // 'ready' — an image_only row, one that still owes OCR — stayed 'ready'
  // when the function was killed: no sweep looks at a ready row, so the
  // re-run simply never happened and nothing anywhere said so.
  //
  // It is written AFTER the spend cap (a refusal must cost nothing) and after
  // the queue decision (a queued document is already marked 'pending').
  const { error: markErr } = await sb
    .from('documents')
    .update({ processing_status: 'extracting', processing_error: null })
    .eq('id', doc.id);
  if (markErr) {
    // Not fatal: the ingestion attempt is still worth making, and
    // processDocument writes its own statuses. But a row that could not be
    // marked is a row the sweep may not find, so say so in the log.
    console.error(`inline ingest marker failed for ${doc.id}: ${markErr.message}`);
  }

  // Download the file from storage. RLS on the storage bucket enforces
  // matter access; if the user can read the document row they can also
  // download the file.
  const { data: blob, error: dlErr } = await sb.storage
    .from('vault-documents')
    .download(doc.storage_path);
  if (dlErr || !blob) {
    return json(res, 500, { error: `download: ${dlErr?.message || 'unknown'}` });
  }
  const arrayBuf = await blob.arrayBuffer();
  const fileBuf = Buffer.from(arrayBuf);
  const ext = '.' + (doc.source_filename || '').split('.').pop().toLowerCase();

  // A PDF with scanned pages goes to the worker too (Phase 2, 2026-09-04) —
  // see planPdfOcr for why size alone was the wrong test. The text layer is
  // extracted once here to decide (a second or two); a born-digital PDF, with
  // no page awaiting OCR, continues inline exactly as before.
  if (ext === '.pdf') {
    const plan = await planPdfOcr(fileBuf);
    if (plan.ocrPages.length) {
      const queued = await enqueueForWorker(sb, doc);
      if (queued) return json(res, 202, { ...queued, reason: 'ocr', ocr_pages: plan.ocrPages.length, page_count: plan.pageCount });
    }
  }

  // OCR provider, wired as a backstop. A JPEG/PNG is routed to the worker by
  // needsWorkerIngest (since 2026-09-26 — one OCR call is 20–60 s the
  // browser used to wait for), and a PDF that needs OCR was routed just
  // above, so neither runs here; the wiring stays so that a queue insert
  // that failed and fell through inline still ends in OCR, not in
  // "image_only". The provider picks the route the matter's tier allows and
  // falls back within the tier (Phase 4).
  let ocr = null;
  if (ext === '.pdf' || OCRABLE_IMAGE_EXTENSIONS.includes(ext)) {
    ocr = makeOcrProvider(process.env);
  }

  // Audio/video transcription. Handles Gemini-native formats (wav/mp3/mov/mpg/
  // mp4/etc.) inline within the serverless budget. Formats Gemini won't take
  // (.wma) or long recordings can exceed 60s — those route to the CLI
  // (scripts/transcribe-av.mjs, which also transcodes) or the background worker.
  let transcribe = null;
  if (GOOGLE_API_KEY && MEDIA_EXTENSIONS.includes(ext)) {
    const { transcribeMedia, mimeForMediaExt } = await import('../lib/transcribe-gemini.mjs');
    const mimeType = mimeForMediaExt(ext);
    if (mimeType) {
      transcribe = (buf, { kind }) => transcribeMedia(buf, { apiKey: GOOGLE_API_KEY, mimeType, kind });
    }
    // No mimeType (e.g. .wma) → leave transcribe null; ingest-core stores the
    // file as-is (viewable) instead of erroring. Transcript comes from the CLI.
  }

  try {
    const { passageCount } = await processDocument(sb, {
      documentId: doc.id,
      fileBuf,
      ext,
      openaiApiKey: OPENAI_API_KEY,
      ocr,
      transcribe,
    });
    return json(res, 200, { ok: true, passageCount });
  } catch (err) {
    // The SecureSpace seal refused a pipe (lib/seal-pipes.mjs): the file is
    // uploaded and viewable, it simply cannot be read by an outside provider.
    // That is a 409 with an explanation, not a 500 — and 'held', not 'error',
    // so nothing retries what will be refused identically every time.
    if (isSealedPipeError(err)) {
      await sb
        .from('documents')
        .update({ processing_status: HELD_STATUS, processing_error: heldReason(err) })
        .eq('id', doc.id);
      return json(res, 409, { error: 'sealed_pipe', held: true, message: err.message });
    }
    // A PDF the serverless parser rejected goes to the worker, whose parsers
    // read what pdf-parse's 2017 build will not (isPdfStructureError). The
    // Vault keeps polling the row either way; only a file the worker rejects
    // too ends in 'error'.
    if (ext === '.pdf' && isPdfStructureError(err)) {
      const queued = await enqueueForWorker(sb, doc);
      if (queued) return json(res, 202, { ...queued, reason: 'parser', note: err.message?.slice(0, 120) });
    }
    // Mark the document as error so the UI shows it. processDocument may
    // have already set this for the 'no passages' case; our update is
    // idempotent for the user-visible error message.
    await sb
      .from('documents')
      .update({
        processing_status: 'error',
        processing_error: err.message?.slice(0, 500) || 'ingestion failed',
      })
      .eq('id', doc.id);
    return json(res, 500, { error: err.message || 'ingestion_failed' });
  }
}


// Queue one ingest_document job for the always-on worker and mark the row
// pending. Returns the 202 body, or null when the insert failed (RLS/schema
// drift) so the caller falls through to the inline attempt — the queue
// failing must never strand the document. Dedupes against a job already in
// flight so a mashed Retry button enqueues once.
async function enqueueForWorker(sb, doc) {
  const { data: existing } = await sb.from('processing_jobs')
    .select('id').eq('job_type', 'ingest_document')
    .in('status', ['queued', 'running'])
    .contains('payload', { document_id: doc.id })
    .limit(1);
  if (existing?.length) return { ok: true, queued: true, deduped: true };
  const { error: qErr } = await sb.from('processing_jobs').insert({
    matterspace_id: doc.matterspace_id,
    job_type: 'ingest_document',
    payload: { document_id: doc.id },
  });
  if (qErr) {
    console.error('enqueue ingest_document failed, falling back inline:', qErr.message);
    return null;
  }
  await sb.from('documents')
    .update({ processing_status: 'pending', processing_error: null })
    .eq('id', doc.id);
  return { ok: true, queued: true };
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
