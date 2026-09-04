// Phase 1 ("truth & feedback") smoke test for the ingestion pipeline. Files a
// handful of tiny fixtures into a scratch matter and asserts the three honest
// outcomes the plan requires — refused with a reason, stored with a recorded
// reason (documents.metadata.text_status), or indexed — then deletes
// everything it made.
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
//   and check_ingest_status on S1 reports text_status + searchable:false.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, StandardFonts } from 'pdf-lib';

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

async function textPdf(lines) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  let y = 720;
  for (const l of lines) { page.drawText(l, { x: 72, y, size: 12, font }); y -= 18; }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
// A one-page "scan": a full-page PNG of a grey sheet with a blue box on it.
// Raster on purpose — it is what a photographed or scanned page is, and the
// pipeline's pdf-parse (2017 pdf.js) reads pdf-lib's raster pages reliably
// where a vector-only page sometimes came back "bad XRef entry".
async function imageOnlyPdf() {
  const { default: sharp } = await import('sharp');
  const box = await sharp({ create: { width: 500, height: 300, channels: 3, background: { r: 60, g: 80, b: 140 } } }).png().toBuffer();
  const png = await sharp({ create: { width: 850, height: 1100, channels: 3, background: { r: 235, g: 235, b: 230 } } })
    .composite([{ input: box, left: 175, top: 400 }])
    .png().toBuffer();
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(png);
  const page = doc.addPage([612, 792]);
  page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
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
const made = { docs: [] };
let failures = 0;
const pass = (msg) => console.log(`  ok   ${msg}`);
const fail = (msg) => { failures++; console.log(`  FAIL ${msg}`); };

async function fileAndRun({ title, filename, bytes, contentType }) {
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
    const { processDocument } = await import('../lib/ingest-core.mjs');
    const ext = '.' + filename.split('.').pop().toLowerCase();
    let ocr = null;
    if (env.GOOGLE_API_KEY && ext === '.pdf') {
      const { ocrPdf } = await import('../lib/ocr-gemini.mjs');
      ocr = (buf) => ocrPdf(buf, { apiKey: env.GOOGLE_API_KEY });
    }
    try {
      await processDocument(supabase, {
        documentId: row.id, fileBuf: bytes, ext, openaiApiKey: env.OPENAI_API_KEY, ocr,
        onProgress: ({ stage, message }) => console.log(`       ${stage.padEnd(10)} ${message}`),
      });
    } catch (err) {
      // The real callers (api/ingest, the worker) mark the row on a throw;
      // do the same here so a failure is terminal and the wait ends at once.
      console.log(`       threw: ${err.message.slice(0, 140)}`);
      await supabase.from('documents')
        .update({ processing_status: 'error', processing_error: err.message.slice(0, 500) })
        .eq('id', row.id).neq('processing_status', 'ready');
    }
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
      .select('id, processing_status, processing_error, page_count, metadata').eq('id', id).maybeSingle();
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

  console.log('\nwaiting for outcomes');
  await expectStored('S1 .obj', s1, TEXT_STATUS.BINARY_STORED);
  await expectStored('S2 image-only PDF', s2, TEXT_STATUS.IMAGE_ONLY);
  await expectStored('S3 blank .txt', s3, TEXT_STATUS.NO_TEXT);
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
  if (afterDup === after + 4) pass('R2: no second row was created');
  else fail(`R2: expected ${after + 4} rows, found ${afterDup}`);

  // ---- check_ingest_status tells the truth about a stored-without-text doc ---------
  console.log('\n[MCP] check_ingest_status on S1');
  const st = await handleCheckIngestStatus(supabase, { document_id: s1 });
  if (st.status === 'ready' && st.text_status === TEXT_STATUS.BINARY_STORED && st.searchable === false && /Kept to open or download/.test(st.note || '')) pass(`MCP: text_status=${st.text_status}, searchable=false, note="${st.note.slice(0, 60)}…"`);
  else fail(`MCP: ${JSON.stringify(st).slice(0, 200)}`);
} finally {
  console.log('\ncleanup');
  const { data: rows } = await supabase.from('documents').select('id, storage_path').in('id', made.docs);
  const paths = (rows || []).map((r) => r.storage_path).filter(Boolean);
  if (paths.length) await supabase.storage.from('vault-documents').remove(paths);
  if (made.docs.length) await supabase.from('documents').delete().in('id', made.docs);
  console.log(`  removed ${made.docs.length} doc(s)`);
}
console.log(failures ? `\n${failures} FAILED` : '\nPASS');
process.exit(failures ? 1 : 0);
