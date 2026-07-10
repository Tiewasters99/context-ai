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

import { processDocument, MEDIA_EXTENSIONS, needsWorkerIngest } from '../lib/ingest-core.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Optional: enables OCR of scanned, image-only PDFs (no text layer). Same key
// the MCP ingest path uses (api/mcp.mjs). When absent, scanned PDFs still fail
// with "no passages extracted" as before — OCR is purely additive.
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
    .select('id, storage_path, source_filename, processing_status, matterspace_id, file_size_bytes')
    .eq('id', documentId)
    .maybeSingle();
  if (docErr) return json(res, 500, { error: `lookup: ${docErr.message}` });
  if (!doc) return json(res, 404, { error: 'document_not_found_or_no_access' });
  if (!doc.storage_path) {
    return json(res, 400, { error: 'document has no storage_path; upload the file first' });
  }
  if (doc.processing_status === 'ready') {
    return json(res, 200, { ok: true, alreadyReady: true });
  }

  // Heavy-job routing: files this function cannot finish inside the 60s
  // serverless budget go to the always-on worker via the processing_jobs
  // queue (worker/discovery-worker.mjs, job_type ingest_document). The Vault
  // UI polls documents.processing_status either way, so queueing is invisible
  // to the caller. Files below the thresholds keep the fast inline path and
  // don't depend on worker uptime at all.
  const ext0 = '.' + (doc.source_filename || '').split('.').pop().toLowerCase();
  if (needsWorkerIngest(ext0, doc.file_size_bytes)) {
    // Don't double-enqueue when the user mashes Retry.
    const { data: existing } = await sb.from('processing_jobs')
      .select('id').eq('job_type', 'ingest_document')
      .in('status', ['queued', 'running'])
      .contains('payload', { document_id: doc.id })
      .limit(1);
    if (!existing?.length) {
      const { error: qErr } = await sb.from('processing_jobs').insert({
        matterspace_id: doc.matterspace_id,
        job_type: 'ingest_document',
        payload: { document_id: doc.id },
      });
      // Queue insert failing (e.g. RLS/schema drift) must not strand the doc —
      // fall through to the inline attempt, which is what happened before.
      if (qErr) {
        console.error('enqueue ingest_document failed, falling back inline:', qErr.message);
      } else {
        await sb.from('documents')
          .update({ processing_status: 'pending', processing_error: null })
          .eq('id', doc.id);
        return json(res, 202, { ok: true, queued: true });
      }
    } else {
      return json(res, 202, { ok: true, queued: true, deduped: true });
    }
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

  // Scanned-PDF OCR fallback. Only wired for PDFs and only when a key is
  // present. Gemini OCR of a large scan can exceed the 60s serverless budget,
  // so the pipeline only invokes this when the PDF extracts to ~no text; small
  // and medium scans (exhibits) finish comfortably. Big image-only productions
  // still need the CLI (scripts/ocr-scanned.mjs) or the background worker.
  let ocr = null;
  if (GOOGLE_API_KEY && ext === '.pdf') {
    const { ocrPdf } = await import('../lib/ocr-gemini.mjs');
    ocr = (buf) => ocrPdf(buf, { apiKey: GOOGLE_API_KEY });
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


function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
