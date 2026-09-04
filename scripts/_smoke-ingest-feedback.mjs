// Phase 1 ("truth & feedback") + Phase 2 ("mixed documents") smoke test for
// the ingestion pipeline. Files a handful of tiny fixtures into a scratch
// matter and asserts the honest outcomes the plan requires — refused with a
// reason, stored with a recorded reason (documents.metadata.text_status),
// indexed, or indexed with pages recorded as awaiting OCR
// (documents.metadata.ocr_pending) — then deletes everything it made.
//
//   node scripts/_smoke-ingest-feedback.mjs <scratch matter short_code|uuid>          # DEPLOYED worker (queue)
//   node scripts/_smoke-ingest-feedback.mjs <scratch matter short_code|uuid> --local  # this checkout's lib, in-process
//
// --local runs lib/ingest-core.mjs from this checkout against the live
// database (service role, Gemini OCR from .env) — the pre-deploy check. The
// default queues each fixture and lets whatever build the Fly worker is
// running process it — the post-deploy check, and what the nightly suite
// (Phase 5) will grow from.
//
// Fixtures and what each must come back as:
//   refusals (no bytes move, no row):
//     R1  file_document with an unsupported extension (.exe)      → error names the type + supported list
//     R2  file_document of a file already in the matter           → already_filed + "Already filed as …"
//     R3  checkUpload() on an over-cap size                        → too_large with the cap in words
//   stored with a reason (ready, 0 passages, text_status set):
//     S1  .obj 3D asset                                             → binary_stored
//     S2  image-only PDF (one page, a drawn box, no text)           → image_only   (OCR ran, found nothing)
//     S3  whitespace-only .txt                                      → no_text
//   indexed (control):
//     C1  a real .txt                                               → ready, passages > 0, NO text_status
//   mixed document (Phase 2, gate G1) — 3 typed pages + 2 scanned exhibit pages:
//     M1  every page searchable: passages cite pages 4 and 5 with the OCR'd words, no ocr_pending
//   OCR failure paths (Phase 2, gate G6) — --local only, with an OCR hook that throws:
//     F1  mixed PDF → ready, typed pages indexed, ocr_pending = pages [4,5], attempt 1, retry scheduled;
//         re-run with real OCR → ocr_pending cleared, pages 4–5 searchable
//     F2  image-only PDF → ready, 0 passages, text_status ocr_pending
//     F3  .png scan → ready, 0 passages, text_status ocr_pending (not image_only)
//   containers (Phase 3, gate G2):
//     Z1  .zip (2 files + a nested zip + Mac junk) → archive stored with reason, moved into a folder
//         named after it; 3 children filed there and indexed; junk skipped
//     Z2  file_document with a .zip → accepted and queued (was refused before Phase 3)
//     E1  .eml with a PDF, an attached message and an inline signature image → message indexed;
//         PDF + message filed BESIDE it (no folder) and indexed; the image skipped
//   and check_ingest_status on S1 reports text_status + searchable:false, on F1 names the pages,
//   on Z1 names the children.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { imageOnlyPdf, mixedPdf, scannedPagePng, archiveFixture, emlFixture } from './_fixtures-ingest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }),
);
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const LOCAL = process.argv.includes('--local');

const matterArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!matterArg) { console.error('usage: <scratch matter short_code|uuid> [--local]'); process.exit(2); }
const isUuid = /^[0-9a-f-]{36}$/i.test(matterArg);
const { data: matter, error: mErr } = await supabase.from('matterspaces')
  .select('id, name, short_code').eq(isUuid ? 'id' : 'short_code', matterArg).single();
if (mErr) throw new Error(`matter: ${mErr.message}`);
console.log(`scratch matter: ${matter.name} (${matter.short_code}, ${matter.id}) — ${LOCAL ? 'LOCAL lib, in-process' : 'DEPLOYED worker via queue'}`);

// documents.created_by is NOT NULL. Use SMOKE_CREATED_BY when set; otherwise
// borrow the owner of the matter's most recent document (or any document).
const CREATED_BY = process.env.SMOKE_CREATED_BY || await (async () => {
  const { data } = await supabase.from('documents').select('created_by')
    .eq('matterspace_id', matter.id).not('created_by', 'is', null)
    .order('created_at', { ascending: false }).limit(1);
  if (data?.[0]?.created_by) return data[0].created_by;
  const { data: any } = await supabase.from('documents').select('created_by')
    .not('created_by', 'is', null).limit(1);
  if (any?.[0]?.created_by) return any[0].created_by;
  throw new Error('no created_by available — set SMOKE_CREATED_BY=<user uuid>');
})();

const { checkUpload, VAULT_MAX_BYTES, TEXT_STATUS } = await import('../lib/ingest-formats.mjs');
const { handleFileDocument, handleCheckIngestStatus } = await import('../lib/mcp-core.mjs');

// --- fixtures ----------------------------------------------------------------
const tag = crypto.randomUUID().slice(0, 8);

// Fixtures live in _fixtures-ingest.mjs (shared with the unit test). The
// image-only "scan" is a full-page raster on purpose — it is what a
// photographed or scanned page is, and the pipeline's pdf-parse (2017 pdf.js)
// reads pdf-lib's raster pages reliably where a vector-only page sometimes
// came back "bad XRef entry".
// An OCR hook standing in for a provider outage (F1–F3).
const brokenOcr = async () => { throw new Error('gemini 503: simulated outage for the smoke test'); };
const objAsset = Buffer.from(
  `# smoke ${tag}\no cube\n` +
  Array.from({ length: 400 }, (_, i) => `v ${(i % 7) - 3}.${i % 10} ${(i % 5) - 2}.${i % 9} ${(i % 3) - 1}.${i % 8}`).join('\n') +
  '\n' + Array.from({ length: 200 }, (_, i) => `f ${i + 1} ${i + 2} ${i + 3}`).join('\n') + '\n', 'utf8');
const blankTxt = Buffer.from('   \n\n\t \n   \n', 'utf8');
const realTxt = Buffer.from(
  `Smoke test ${tag}. This control document says obsidian. ` +
  'It exists so the harness proves the pipeline still indexes ordinary text, and that an indexed document ' +
  'carries no text_status. '.repeat(3), 'utf8');

// --- helpers ------------------------------------------------------------------
const made = { docs: [], folders: [] };
let failures = 0;
const pass = (msg) => console.log(`  ok   ${msg}`);
const fail = (msg) => { failures++; console.log(`  FAIL ${msg}`); };

// Run this checkout's pipeline on a stored row, the way the worker does
// (passages cleared first). `ocr`: 'real' wires Gemini from .env for PDFs and
// OCR-able images; a function is used as the hook itself (F1–F3); null = none.
async function runLocal(id, bytes, filename, ocr = 'real') {
  const { processDocument, OCRABLE_IMAGE_EXTENSIONS } = await import('../lib/ingest-core.mjs');
  const ext = '.' + filename.split('.').pop().toLowerCase();
  let hook = typeof ocr === 'function' ? ocr : null;
  if (ocr === 'real' && env.GOOGLE_API_KEY && (ext === '.pdf' || OCRABLE_IMAGE_EXTENSIONS.includes(ext))) {
    const { ocrPdf } = await import('../lib/ocr-gemini.mjs');
    hook = (buf) => ocrPdf(buf, { apiKey: env.GOOGLE_API_KEY });
  }
  await supabase.from('passages').delete().eq('document_id', id);
  try {
    return await processDocument(supabase, {
      documentId: id, fileBuf: bytes, ext, openaiApiKey: env.OPENAI_API_KEY, ocr: hook,
      onProgress: ({ stage, message }) => console.log(`       ${stage.padEnd(10)} ${message}`),
    });
  } catch (err) {
    // The real callers (api/ingest, the worker) mark the row on a throw;
    // do the same here so a failure is terminal and the wait ends at once.
    console.log(`       threw: ${err.message.slice(0, 140)}`);
    await supabase.from('documents')
      .update({ processing_status: 'error', processing_error: err.message.slice(0, 500) })
      .eq('id', id).neq('processing_status', 'ready');
    return null;
  }
}

async function fileAndRun({ title, filename, bytes, contentType, ocr = 'real' }) {
  const { data: row, error } = await supabase.from('documents').insert({
    matterspace_id: matter.id, title, doc_type: 'other', source_filename: filename,
    file_size_bytes: bytes.length, processing_status: 'pending', created_by: CREATED_BY,
  }).select('id').single();
  if (error) throw new Error(`insert ${title}: ${error.message}`);
  made.docs.push(row.id);
  const storagePath = `${matter.id}/${row.id}/${filename.replace(/[^a-zA-Z0-9._-]+/g, '_')}`;
  const { error: upErr } = await supabase.storage.from('vault-documents')
    .upload(storagePath, bytes, { contentType, upsert: true });
  if (upErr) throw new Error(`upload ${title}: ${upErr.message}`);
  await supabase.from('documents').update({ storage_path: storagePath }).eq('id', row.id);

  if (LOCAL) {
    await runLocal(row.id, bytes, filename, ocr);
  } else {
    const { error: qErr } = await supabase.from('processing_jobs').insert({
      matterspace_id: matter.id, job_type: 'ingest_document', payload: { document_id: row.id },
    });
    if (qErr) throw new Error(`enqueue ${title}: ${qErr.message}`);
  }
  return row.id;
}

async function waitTerminal(id, ms = 8 * 60_000) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < ms) {
    const { data } = await supabase.from('documents')
      .select('id, processing_status, processing_error, page_count, matterspace_id, metadata').eq('id', id).maybeSingle();
    const line = data ? `${data.processing_status}${data.processing_error ? ' | ' + data.processing_error.slice(0, 100) : ''}` : 'gone';
    if (line !== last) { console.log(`       ${new Date().toISOString().slice(11, 19)} ${line}`); last = line; }
    if (data && (data.processing_status === 'ready' || data.processing_status === 'error')) return data;
    await new Promise((r) => setTimeout(r, LOCAL ? 500 : 5000));
  }
  throw new Error(`timeout waiting on ${id}`);
}

async function passageCount(id) {
  const { count } = await supabase.from('passages').select('id', { count: 'exact', head: true }).eq('document_id', id);
  return count || 0;
}

// Does some passage on `page` contain `word`? (chunkPages cites one page per
// passage, so page_start is the page.)
async function pageHasWord(id, page, word) {
  const { data } = await supabase.from('passages').select('page_start, text')
    .eq('document_id', id).eq('page_start', page);
  return (data || []).some((p) => (p.text || '').toLowerCase().includes(word.toLowerCase()));
}

// The Phase 2 acceptance check (gate G1) on a stored mixed document: every
// page searchable, the scanned pages cited by their true page numbers, no
// pages left waiting.
async function expectMixedIndexed(label, id) {
  const d = await waitTerminal(id);
  const n = await passageCount(id);
  const md = d.metadata || {};
  const p4 = await pageHasWord(id, 4, 'marmalade');
  const p5 = await pageHasWord(id, 5, 'quixotic');
  const p1 = await pageHasWord(id, 1, 'memorandum');
  if (d.processing_status === 'ready' && n > 0 && !md.text_status && !md.ocr_pending && d.page_count === 5 && p1 && p4 && p5) {
    pass(`${label}: ready, ${n} passages over 5 pages; p.1 typed text, p.4 "marmalade" and p.5 "quixotic" from OCR; no ocr_pending`);
  } else {
    fail(`${label}: status=${d.processing_status} passages=${n} page_count=${d.page_count} text_status=${md.text_status} ocr_pending=${JSON.stringify(md.ocr_pending || null).slice(0, 120)} p1=${p1} p4=${p4} p5=${p5} error=${(d.processing_error || '').slice(0, 100)}`);
  }
  return d;
}

// ---- containers (Phase 3) ------------------------------------------------------
// A container's children are queued for the worker. In --local mode nothing
// drains that queue, so the children are run here, in-process, the way the
// worker would: download the stored bytes, run this checkout's pipeline.
// Either way every child and folder is remembered for cleanup.
async function adoptChildren(summary) {
  for (const c of summary?.children || []) if (c.id && !made.docs.includes(c.id)) made.docs.push(c.id);
  if (summary?.folder_id && !made.folders.includes(summary.folder_id)) made.folders.push(summary.folder_id);
}
async function runChildrenLocal(summary) {
  if (!LOCAL) return;
  for (const c of summary?.children || []) {
    const { data: row } = await supabase.from('documents').select('id, storage_path, source_filename, processing_status').eq('id', c.id).maybeSingle();
    if (!row?.storage_path || row.processing_status === 'ready') continue;
    const { data: blob, error } = await supabase.storage.from('vault-documents').download(row.storage_path);
    if (error) { fail(`child ${row.source_filename}: download ${error.message}`); continue; }
    console.log(`       child ${row.source_filename}`);
    await runLocal(row.id, Buffer.from(await blob.arrayBuffer()), row.source_filename, 'real');
    // A child that is itself a container (the nested .eml) files its own
    // children; adopt and run those too.
    const { data: after } = await supabase.from('documents').select('metadata').eq('id', row.id).maybeSingle();
    const nested = after?.metadata?.archive || after?.metadata?.email_attachments || null;
    if (nested?.children?.length) { await adoptChildren(nested); await runChildrenLocal(nested); }
  }
}
// The child named `title` is ready, searchable, and cites `word` on page 1.
async function expectChildIndexed(label, summary, titleRe, word) {
  const c = (summary?.children || []).find((k) => titleRe.test(k.title || ''));
  if (!c) { fail(`${label}: no child matching ${titleRe}`); return null; }
  const d = await waitTerminal(c.id);
  const n = await passageCount(c.id);
  const hit = await pageHasWord(c.id, 1, word);
  if (d.processing_status === 'ready' && n > 0 && !d.metadata?.text_status && hit) pass(`${label}: child "${c.title}" ready, ${n} passage(s), cites "${word}"`);
  else fail(`${label}: child "${c.title}" status=${d.processing_status} passages=${n} text_status=${d.metadata?.text_status} hit=${hit} error=${(d.processing_error || '').slice(0, 100)}`);
  return d;
}

async function expectStored(label, id, want) {
  const d = await waitTerminal(id);
  const n = await passageCount(id);
  const ts = d.metadata?.text_status;
  const at = d.metadata?.text_status_at;
  if (d.processing_status === 'ready' && ts === want && n === 0 && at) pass(`${label}: ready, 0 passages, text_status=${ts}`);
  else fail(`${label}: status=${d.processing_status} passages=${n} text_status=${ts} text_status_at=${at ? 'set' : 'MISSING'} error=${(d.processing_error || '').slice(0, 100)}`);
  return d;
}

try {
  // ---- Refusals ---------------------------------------------------------------
  console.log('\n[R1] file_document: unsupported extension');
  const { count: before } = await supabase.from('documents').select('id', { count: 'exact', head: true }).eq('matterspace_id', matter.id);
  try {
    await handleFileDocument(supabase, { matter: matter.id, filename: `smoke-${tag}.exe`, content: 'MZ' + 'x'.repeat(64) },
      { openaiApiKey: env.OPENAI_API_KEY });
    fail('R1: .exe was accepted');
  } catch (err) {
    if (/\.exe file, which the Vault can't read/.test(err.message) && /Supported: PDF/.test(err.message)) pass(`R1: refused — "${err.message.slice(0, 90)}…"`);
    else fail(`R1: wrong message: ${err.message}`);
  }
  const { count: after } = await supabase.from('documents').select('id', { count: 'exact', head: true }).eq('matterspace_id', matter.id);
  if (before === after) pass('R1: no document row was created');
  else fail(`R1: row count changed ${before} → ${after}`);

  console.log('\n[R3] checkUpload: over the storage cap');
  const r3 = checkUpload({ name: 'giant-record.pdf', size: VAULT_MAX_BYTES + 1 });
  if (r3?.code === 'too_large' && /up to 500 MB/.test(r3.message)) pass(`R3: ${r3.message.slice(0, 90)}…`);
  else fail(`R3: ${JSON.stringify(r3)}`);

  // ---- Stored with a reason -------------------------------------------------------
  console.log('\n[S1] .obj asset → binary_stored');
  const s1 = await fileAndRun({ title: `Smoke obj ${tag}`, filename: `smoke-${tag}.obj`, bytes: objAsset, contentType: 'application/octet-stream' });
  console.log('\n[S2] image-only PDF → image_only');
  const s2 = await fileAndRun({ title: `Smoke image-only ${tag}`, filename: `smoke-image-only-${tag}.pdf`, bytes: await imageOnlyPdf(), contentType: 'application/pdf' });
  console.log('\n[S3] whitespace-only .txt → no_text');
  const s3 = await fileAndRun({ title: `Smoke blank ${tag}`, filename: `smoke-blank-${tag}.txt`, bytes: blankTxt, contentType: 'text/plain' });
  console.log('\n[C1] real .txt → indexed, no text_status');
  const c1 = await fileAndRun({ title: `Smoke control ${tag}`, filename: `smoke-control-${tag}.txt`, bytes: realTxt, contentType: 'text/plain' });
  console.log('\n[M1] mixed PDF (3 typed + 2 scanned pages) → every page searchable');
  const mixedBytes = await mixedPdf({ tag });
  const m1 = await fileAndRun({ title: `Smoke mixed ${tag}`, filename: `smoke-mixed-${tag}.pdf`, bytes: mixedBytes, contentType: 'application/pdf' });

  console.log('\nwaiting for outcomes');
  await expectStored('S1 .obj', s1, TEXT_STATUS.BINARY_STORED);
  await expectStored('S2 image-only PDF', s2, TEXT_STATUS.IMAGE_ONLY);
  await expectStored('S3 blank .txt', s3, TEXT_STATUS.NO_TEXT);
  await expectMixedIndexed('M1 mixed PDF', m1);
  {
    const d = await waitTerminal(c1);
    const n = await passageCount(c1);
    const ts = d.metadata?.text_status;
    if (d.processing_status === 'ready' && n > 0 && !ts) pass(`C1 control: ready, ${n} passage(s), no text_status`);
    else fail(`C1 control: status=${d.processing_status} passages=${n} text_status=${ts} error=${(d.processing_error || '').slice(0, 100)}`);
  }

  // ---- R2 needs a filed copy to collide with: reuse C1 ---------------------------
  console.log('\n[R2] file_document: duplicate of a filed copy');
  const r2 = await handleFileDocument(supabase,
    { matter: matter.id, filename: `smoke-control-${tag}.txt`, content: realTxt.toString('utf8') },
    { openaiApiKey: env.OPENAI_API_KEY });
  if (r2.already_filed && r2.document_id === c1 && /^Already filed as "Smoke control/.test(r2.note || '')) pass(`R2: ${r2.note.slice(0, 100)}`);
  else fail(`R2: ${JSON.stringify(r2).slice(0, 200)}`);
  const { count: afterDup } = await supabase.from('documents').select('id', { count: 'exact', head: true }).eq('matterspace_id', matter.id);
  // Every row this run has made so far (S1–S3, C1, M1), and not one more.
  if (afterDup === after + made.docs.length) pass('R2: no second row was created');
  else fail(`R2: expected ${after + made.docs.length} rows, found ${afterDup}`);

  // ---- check_ingest_status tells the truth about a stored-without-text doc ---------
  console.log('\n[MCP] check_ingest_status on S1');
  const st = await handleCheckIngestStatus(supabase, { document_id: s1 });
  if (st.status === 'ready' && st.text_status === TEXT_STATUS.BINARY_STORED && st.searchable === false && /Kept to open or download/.test(st.note || '')) pass(`MCP: text_status=${st.text_status}, searchable=false, note="${st.note.slice(0, 60)}…"`);
  else fail(`MCP: ${JSON.stringify(st).slice(0, 200)}`);

  // ---- OCR failure paths: the provider is down, the document must not fail ----------
  // Only in-process: the deployed worker's OCR cannot be made to fail on cue.
  if (LOCAL) {
    console.log('\n[F1] mixed PDF, OCR throws → typed pages indexed, pages 4–5 recorded as awaiting OCR');
    const f1 = await fileAndRun({ title: `Smoke mixed outage ${tag}`, filename: `smoke-mixed-outage-${tag}.pdf`, bytes: mixedBytes, contentType: 'application/pdf', ocr: brokenOcr });
    {
      const d = await waitTerminal(f1);
      const n = await passageCount(f1);
      const op = d.metadata?.ocr_pending;
      const p1 = await pageHasWord(f1, 1, 'memorandum');
      const p4 = await pageHasWord(f1, 4, 'marmalade');
      if (d.processing_status === 'ready' && n > 0 && p1 && !p4 && !d.metadata?.text_status &&
          op && JSON.stringify(op.pages) === '[4,5]' && op.page_count === 5 && op.attempts === 1 && op.next_retry_at && !op.exhausted && /simulated outage/.test(op.reason || '')) {
        pass(`F1: ready, ${n} typed passages searchable; ocr_pending pages [4,5], attempt 1, retry at ${op.next_retry_at.slice(11, 19)}Z, reason "${op.reason.slice(0, 40)}…"`);
      } else {
        fail(`F1: status=${d.processing_status} passages=${n} p1=${p1} p4=${p4} text_status=${d.metadata?.text_status} ocr_pending=${JSON.stringify(op || null).slice(0, 200)} error=${(d.processing_error || '').slice(0, 100)}`);
      }
      const st1 = await handleCheckIngestStatus(supabase, { document_id: f1 });
      if (st1.status === 'ready' && st1.searchable === true && st1.ocr_pending?.pages?.length === 2 && /2 pages awaiting OCR/.test(st1.note || '')) pass(`F1 MCP: searchable=true, note="${st1.note.slice(0, 70)}…"`);
      else fail(`F1 MCP: ${JSON.stringify(st1).slice(0, 240)}`);

      console.log('       re-running F1 with real OCR (what the worker sweep does when the retry comes due)');
      await runLocal(f1, mixedBytes, `smoke-mixed-outage-${tag}.pdf`, 'real');
      await expectMixedIndexed('F1 re-run', f1);
    }

    console.log('\n[F2] image-only PDF, OCR throws → stored as ocr_pending (not image_only)');
    const f2 = await fileAndRun({ title: `Smoke scan outage ${tag}`, filename: `smoke-scan-outage-${tag}.pdf`, bytes: await imageOnlyPdf(), contentType: 'application/pdf', ocr: brokenOcr });
    {
      const d = await expectStored('F2 image-only PDF (OCR down)', f2, TEXT_STATUS.OCR_PENDING);
      const op = d.metadata?.ocr_pending;
      if (op && JSON.stringify(op.pages) === '[1]' && op.attempts === 1 && op.next_retry_at) pass(`F2: ocr_pending pages [1], attempt 1, retry scheduled`);
      else fail(`F2: ocr_pending=${JSON.stringify(op || null).slice(0, 200)}`);
    }

    console.log('\n[F3] .png scan, OCR throws → stored as ocr_pending (not image_only)');
    const png = await scannedPagePng([`Scanned page ${tag}`, 'The obsidian clause survives.']);
    const f3 = await fileAndRun({ title: `Smoke png outage ${tag}`, filename: `smoke-png-outage-${tag}.png`, bytes: png, contentType: 'image/png', ocr: brokenOcr });
    {
      const d = await expectStored('F3 .png scan (OCR down)', f3, TEXT_STATUS.OCR_PENDING);
      const op = d.metadata?.ocr_pending;
      if (op && op.attempts === 1 && op.next_retry_at && /simulated outage/.test(op.reason || '')) pass('F3: ocr_pending recorded with the reason and a retry');
      else fail(`F3: ocr_pending=${JSON.stringify(op || null).slice(0, 200)}`);
    }
  } else {
    console.log('\n[F1–F3] skipped — OCR failure injection runs with --local only');
  }

  // ---- containers (Phase 3, gate G2) ---------------------------------------------
  console.log('\n[Z1] .zip (2 files + nested zip + Mac junk) → archive stored, unpacked into a folder, children indexed');
  const zipBytes = await archiveFixture({ tag });
  const z1 = await fileAndRun({ title: `Smoke archive ${tag}`, filename: `smoke-archive-${tag}.zip`, bytes: zipBytes, contentType: 'application/zip' });
  {
    const d = await waitTerminal(z1);
    const a = d.metadata?.archive;
    await adoptChildren(a);
    const titles = (a?.children || []).map((c) => c.title).sort();
    if (d.processing_status === 'ready' && d.metadata?.text_status === TEXT_STATUS.ARCHIVE && a && a.entry_count === 3 &&
        JSON.stringify(titles) === JSON.stringify(['Deposition of J. Walters', 'Exhibit C', 'notes']) &&
        a.folder_id && d.matterspace_id === a.folder_id && (a.skipped || []).length === 2) {
      pass(`Z1: ready, text_status=archive; folder "${a.folder_name}"; archive moved in; 3 children ${JSON.stringify(titles)}; 2 junk entries skipped`);
    } else {
      fail(`Z1: status=${d.processing_status} text_status=${d.metadata?.text_status} archive=${JSON.stringify(a || null).slice(0, 300)} in_folder=${d.matterspace_id === a?.folder_id}`);
    }
    await runChildrenLocal(a);
    await expectChildIndexed('Z1', a, /Deposition/, 'cobalt');
    await expectChildIndexed('Z1', a, /^notes$/, 'saffron');
    await expectChildIndexed('Z1', a, /Exhibit C/, 'vermilion');
    const { data: kids } = await supabase.from('documents').select('id, matterspace_id, container_kind:metadata->>container_kind, container_entry:metadata->>container_entry').in('id', (a?.children || []).map((c) => c.id));
    const nested = (kids || []).find((k) => /inner\.zip\//.test(k.container_entry || ''));
    if ((kids || []).every((k) => k.matterspace_id === a?.folder_id && k.container_kind === 'zip') && nested) pass(`Z1: every child in the folder with container_kind=zip; nested entry recorded as "${nested.container_entry}"`);
    else fail(`Z1: children=${JSON.stringify(kids || []).slice(0, 300)}`);
    const st = await handleCheckIngestStatus(supabase, { document_id: z1 });
    if (st.container?.kind === 'zip' && st.container.children?.length === 3 && /unpacked: 3 document\(s\) filed in the folder/.test(st.container_note || '')) pass(`Z1 MCP: check_ingest_status names 3 children — "${st.container_note.slice(0, 80)}…"`);
    else fail(`Z1 MCP: ${JSON.stringify(st).slice(0, 300)}`);
  }

  console.log('\n[Z2] file_document with a .zip → accepted and queued for the worker');
  {
    const r = await handleFileDocument(supabase,
      { matter: matter.id, filename: `smoke-archive-mcp-${tag}.zip`, content: zipBytes.toString('base64'), encoding: 'base64', title: `Smoke archive via MCP ${tag}` },
      { openaiApiKey: env.OPENAI_API_KEY, userId: CREATED_BY });
    if (r.document_id) made.docs.push(r.document_id);
    if (r.status === 'queued' && r.job_id && /unpacks it into a folder/.test(r.note || '')) pass(`Z2: queued (job ${String(r.job_id).slice(0, 8)}…), note="${r.note.slice(0, 70)}…"`);
    else fail(`Z2: ${JSON.stringify(r).slice(0, 300)}`);
    if (LOCAL) {
      // Nothing drains the queue here: cancel the job so the deployed worker
      // does not unpack a second copy after this run has cleaned up.
      await supabase.from('processing_jobs').delete().eq('job_type', 'ingest_document').contains('payload', { document_id: r.document_id });
    } else {
      const d = await waitTerminal(r.document_id);
      await adoptChildren(d.metadata?.archive);
      if (d.processing_status === 'ready' && d.metadata?.text_status === TEXT_STATUS.ARCHIVE) pass('Z2: worker unpacked it');
      else fail(`Z2: status=${d.processing_status} error=${(d.processing_error || '').slice(0, 100)}`);
    }
  }

  console.log('\n[E1] .eml with a PDF, an attached message and an inline signature → message indexed; attachments filed beside it');
  const emlBytes = await emlFixture({ tag });
  const e1 = await fileAndRun({ title: `Smoke email ${tag}`, filename: `smoke-email-${tag}.eml`, bytes: emlBytes, contentType: 'message/rfc822' });
  {
    const d = await waitTerminal(e1);
    const n = await passageCount(e1);
    const ea = d.metadata?.email_attachments;
    await adoptChildren(ea);
    const body = await pageHasWord(e1, 1, 'ochre folder');
    const titles = (ea?.children || []).map((c) => c.title).sort();
    if (d.processing_status === 'ready' && n > 0 && !d.metadata?.text_status && body && ea && ea.entry_count === 2 && !ea.folder_id &&
        d.matterspace_id === matter.id && titles.length === 2 && /Disclosures/.test(titles[0]) && /Forwarded scheduling note/.test(titles[1]) && (ea.skipped || []).length === 1) {
      pass(`E1: email ready, ${n} passage(s), body searchable; 2 attachments filed beside it (${titles.join(' | ')}); inline image skipped`);
    } else {
      fail(`E1: status=${d.processing_status} passages=${n} body=${body} text_status=${d.metadata?.text_status} email_attachments=${JSON.stringify(ea || null).slice(0, 300)}`);
    }
    await runChildrenLocal(ea);
    await expectChildIndexed('E1', ea, /Disclosures/, 'magenta ledger');
    await expectChildIndexed('E1', ea, /Forwarded scheduling note/, 'teal calendar');
    const { data: kids } = await supabase.from('documents').select('id, matterspace_id, container_kind:metadata->>container_kind').in('id', (ea?.children || []).map((c) => c.id));
    if ((kids || []).length === 2 && kids.every((k) => k.matterspace_id === matter.id && k.container_kind === 'eml')) pass('E1: both attachments sit in the same matter as the email (no folder), container_kind=eml');
    else fail(`E1: children=${JSON.stringify(kids || []).slice(0, 300)}`);
  }
} finally {
  console.log('\ncleanup');
  const { data: rows } = await supabase.from('documents').select('id, storage_path').in('id', made.docs);
  const paths = (rows || []).map((r) => r.storage_path).filter(Boolean);
  if (paths.length) await supabase.storage.from('vault-documents').remove(paths);
  if (made.docs.length) await supabase.from('documents').delete().in('id', made.docs);
  // Jobs the children left behind (queued for a worker that, in --local
  // mode, never ran) would fail on a deleted document; drop them.
  for (const id of made.docs) {
    await supabase.from('processing_jobs').delete().eq('job_type', 'ingest_document').in('status', ['queued']).contains('payload', { document_id: id });
  }
  let removedFolders = 0;
  for (const f of made.folders) {
    const { count } = await supabase.from('documents').select('id', { count: 'exact', head: true }).eq('matterspace_id', f);
    if (count === 0) { await supabase.from('matterspaces').delete().eq('id', f); removedFolders++; }
    else console.log(`  folder ${f} kept (${count} docs)`);
  }
  console.log(`  removed ${made.docs.length} doc(s), ${removedFolders} folder(s)`);
}
console.log(failures ? `\n${failures} FAILED` : '\nPASS');
process.exit(failures ? 1 : 0);
