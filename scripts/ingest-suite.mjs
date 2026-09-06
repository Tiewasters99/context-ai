// The nightly ingestion suite — Phase 5 of the ingestion plan (2026-09-04),
// built 2026-09-06. This is the definition of "100% ready": a fixture corpus
// of ~25 files, every kind a solo practitioner actually uploads, pushed
// through the DEPLOYED pipeline (the Fly worker, the real queue, the real
// bucket) into a scratch matter, with every acceptance gate asserted, every
// row cleaned up, and the result emailed. "100% ready" = this suite green
// three nights running.
//
//   node scripts/ingest-suite.mjs <scratch matter short_code|uuid> [flags]
//     --email        send the report to GMAIL_ADDRESS (the monitor's mailbox)
//     --skip-heavy   skip the 300-page / 50-page-scan / 200 MB fixtures (dev runs)
//     --no-g6        skip the in-process provider-outage section
//     --no-g9        skip the monitor run at the end
//     --keep         leave everything in the matter (debugging)
//
// Gates (the plan memo's G1–G10, plus two the plan implies):
//   G0  Formats: docx / xlsx / epub / md / txt / photographed page are indexed and searchable
//   G1  Mixed PDF (typed + scanned pages): every page searchable, cited by its true page number
//   G2  Containers: PDF portfolio, .zip, .eml — children filed and searchable; wrapper stored with reason
//   G3  Stored with a reason: image-only PDF, photo TIFF, silent recording, 3D asset, blank text
//   GA  Audio / video: a SPOKEN mp3 and mp4 are transcribed and searchable by their words
//   G4  Refused or failed with a cause: oversize and unsupported at selection time (no bytes move),
//       duplicate refused with the filed copy named, corrupt PDF fails visibly on the first attempt
//   G5  Nothing stuck: every upload reaches a terminal state within its budget
//   G6  Provider outage (OCR down): typed pages index, scanned pages queue for retry with the reason;
//       when OCR is back the retry clears them. Runs IN-PROCESS on this checkout's lib (the deployed
//       worker's OCR cannot be broken on cue), so it proves the code, not the deployment.
//   G7  Time-to-searchable, queue → ready: 300-page text PDF < 3 min; 50-page scan < 5 min;
//       200 MB record (resumable upload) < 10 min
//   G8  One tenant's bulk production never blocks another's single upload: six BULK-priority
//       PDFs are queued first, then one NORMAL text file, which must finish before the batch does
//   G9  Monitor green means green: scripts/ingest-monitor.mjs --quiet exits 0 after cleanup
//   G10 iPhone Files-app upload — manual, reported as such
//
// Every run writes one line to logs/ingest-suite.jsonl (git-ignored) so the
// report can say how many consecutive nights have been green. Exit 0 = every
// gate that ran passed; 1 = something failed; 2 = the suite itself broke.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { checkUpload, VAULT_MAX_BYTES, TEXT_STATUS } from '../lib/ingest-formats.mjs';
import { handleFileDocument, handleCheckIngestStatus } from '../lib/mcp-core.mjs';
import { JOB_PRIORITY } from '../lib/ingest-core.mjs';
import { uploadResumable, shouldUploadResumable } from '../lib/tus-upload.mjs';
import * as F from './_fixtures-suite.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }),
);
const present = (v) => Boolean(v) && v !== 'PASTE';
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const matterArg = argv.find((a) => !a.startsWith('--'));
if (!matterArg) { console.error('usage: node scripts/ingest-suite.mjs <scratch matter short_code|uuid> [--email] [--skip-heavy] [--no-g6] [--no-g9] [--keep]'); process.exit(2); }
const SKIP_HEAVY = flag('--skip-heavy');
const KEEP = flag('--keep');

const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const isUuid = /^[0-9a-f-]{36}$/i.test(matterArg);
const { data: matter, error: mErr } = await supabase.from('matterspaces').select('id, name, short_code, serverspace_id').eq(isUuid ? 'id' : 'short_code', matterArg).single();
if (mErr || !matter) { console.error(`matter: ${mErr?.message || 'not found'}`); process.exit(2); }
const CREATED_BY = process.env.SMOKE_CREATED_BY || await (async () => {
  const { data } = await supabase.from('documents').select('created_by').eq('matterspace_id', matter.id).not('created_by', 'is', null).order('created_at', { ascending: false }).limit(1);
  if (data?.[0]?.created_by) return data[0].created_by;
  const { data: any } = await supabase.from('documents').select('created_by').not('created_by', 'is', null).limit(1);
  return any?.[0]?.created_by || null;
})();
if (!CREATED_BY) { console.error('no created_by to borrow — set SMOKE_CREATED_BY'); process.exit(2); }

const tag = crypto.randomUUID().slice(0, 8);
const startedAt = new Date();
const stamp = () => new Date().toISOString().slice(11, 19);
console.log(`Ingestion suite ${startedAt.toISOString()} — matter "${matter.name}" (${matter.short_code}) — run ${tag}${SKIP_HEAVY ? ' — heavy fixtures SKIPPED' : ''}`);

// ---- The ledger ----------------------------------------------------------------
const GATES = {
  G0: 'Formats: docx / xlsx / epub / md / txt / photographed page indexed and searchable',
  G1: 'Mixed PDF: every page searchable, cited by its true page number',
  G2: 'Containers: portfolio / zip / eml children filed and searchable',
  G3: 'Stored with a reason: image-only PDF, TIFF photo, silent recording, 3D asset, blank text',
  GA: 'Audio / video: spoken mp3 + mp4 transcribed and searchable',
  G4: 'Refused or failed with a cause: oversize, unsupported, duplicate, corrupt',
  G5: 'Nothing stuck: every upload terminal within its budget',
  G6: 'Provider outage: typed pages index, scans queue for retry, retry clears them (in-process)',
  G7: 'Time-to-searchable: 300 pp < 3 min, 50-pp scan < 5 min, 200 MB < 10 min',
  G8: 'Bulk never blocks a single upload (priority + two workers)',
  G9: 'Monitor green means green',
  G10: 'iPhone Files-app upload (manual)',
};
const ledger = Object.fromEntries(Object.keys(GATES).map((g) => [g, { checks: [], skipped: null }]));
const failures = [];
function check(gate, ok, msg) {
  ledger[gate].checks.push({ ok, msg });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} [${gate}] ${msg}`);
  if (!ok) failures.push(`[${gate}] ${msg}`);
}
function skip(gate, reason) { ledger[gate].skipped = reason; console.log(`  skip [${gate}] ${reason}`); }

// ---- Bookkeeping -----------------------------------------------------------------
const made = { docs: [], folders: [] };
const timings = {}; // label → { bytes, uploadMs, queuedAt, readyAt, pipelineMs, status }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fileAndQueue({ label, title, filename, bytes, contentType, priority = JOB_PRIORITY.NORMAL }) {
  const { data: row, error } = await supabase.from('documents').insert({
    matterspace_id: matter.id, title, doc_type: 'other', source_filename: filename,
    file_size_bytes: bytes.length, processing_status: 'pending', created_by: CREATED_BY,
  }).select('id').single();
  if (error) throw new Error(`insert ${title}: ${error.message}`);
  made.docs.push(row.id);
  const storagePath = `${matter.id}/${row.id}/${filename.replace(/[^a-zA-Z0-9._-]+/g, '_')}`;
  const t0 = Date.now();
  if (shouldUploadResumable(bytes.length)) {
    await uploadResumable({
      supabaseUrl: env.VITE_SUPABASE_URL, token: env.SUPABASE_SERVICE_ROLE_KEY, apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      bucket: 'vault-documents', objectName: storagePath, blob: new Blob([bytes]), contentType,
    });
  } else {
    const { error: upErr } = await supabase.storage.from('vault-documents').upload(storagePath, bytes, { contentType, upsert: true });
    if (upErr) throw new Error(`upload ${title}: ${upErr.message}`);
  }
  const uploadMs = Date.now() - t0;
  await supabase.from('documents').update({ storage_path: storagePath }).eq('id', row.id);
  const { error: qErr } = await supabase.from('processing_jobs').insert({
    matterspace_id: matter.id, job_type: 'ingest_document', payload: { document_id: row.id, suite: tag }, priority,
  });
  if (qErr) throw new Error(`enqueue ${title}: ${qErr.message}`);
  timings[label] = { id: row.id, bytes: bytes.length, uploadMs, queuedAt: Date.now(), readyAt: null, pipelineMs: null, status: 'pending', resumable: shouldUploadResumable(bytes.length) };
  console.log(`  ${stamp()} queued ${label.padEnd(14)} ${(bytes.length / 1048576).toFixed(bytes.length > 1048576 ? 1 : 2)} MB, upload ${(uploadMs / 1000).toFixed(1)} s${timings[label].resumable ? ' (resumable)' : ''}`);
  return row.id;
}

const TERMINAL = new Set(['ready', 'error', 'held']);
async function readDoc(id) {
  const { data } = await supabase.from('documents').select('id, processing_status, processing_error, page_count, matterspace_id, metadata, ingested_at').eq('id', id).maybeSingle();
  return data;
}

// Wait for every entry ({ label, budgetMs }) to reach a terminal state, each
// within its own budget. A document that is still non-terminal at its budget
// is "stuck" — that is gate G5's failure — and is no longer waited on.
async function waitAll(entries) {
  const pending = new Map(entries.map((e) => [e.label, e]));
  const rows = {};
  while (pending.size) {
    for (const [label, e] of [...pending]) {
      const t = timings[label];
      const d = await readDoc(t.id);
      if (!d) { rows[label] = null; pending.delete(label); check('G5', false, `${label}: row vanished`); continue; }
      if (TERMINAL.has(d.processing_status)) {
        // The pipeline's own clock (ingested_at) where it has one — polling
        // every 5 s would otherwise blur the order two documents finished in.
        t.readyAt = d.ingested_at ? Math.min(Date.now(), Date.parse(d.ingested_at)) : Date.now();
        t.pipelineMs = Math.max(0, t.readyAt - t.queuedAt); t.status = d.processing_status;
        rows[label] = d; pending.delete(label);
        console.log(`  ${stamp()} ${d.processing_status.padEnd(6)} ${label.padEnd(14)} ${(t.pipelineMs / 1000).toFixed(0)} s${d.processing_error ? ' | ' + d.processing_error.slice(0, 90) : ''}`);
        continue;
      }
      if (Date.now() - t.queuedAt > e.budgetMs) {
        t.status = `stuck:${d.processing_status}`;
        rows[label] = d; pending.delete(label);
        check('G5', false, `${label}: still "${d.processing_status}" after ${(e.budgetMs / 60000).toFixed(0)} min (${(d.processing_error || 'no note').slice(0, 100)})`);
      }
    }
    if (pending.size) await sleep(5000);
  }
  return rows;
}

async function passageCount(id) {
  const { count } = await supabase.from('passages').select('id', { count: 'exact', head: true }).eq('document_id', id);
  return count || 0;
}
async function pageHasWord(id, page, word) {
  const { data } = await supabase.from('passages').select('text').eq('document_id', id).eq('page_start', page).limit(50);
  return (data || []).some((p) => (p.text || '').toLowerCase().includes(word.toLowerCase()));
}
async function hasWord(id, word) {
  const { data } = await supabase.from('passages').select('text').eq('document_id', id).ilike('text', `%${word}%`).limit(1);
  return (data || []).length > 0;
}
// PostgREST caps a response at 1,000 rows — page by range.
async function distinctPages(id) {
  const pages = new Set();
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase.from('passages').select('page_start').eq('document_id', id).range(from, from + 999);
    for (const p of data || []) pages.add(p.page_start);
    if (!data || data.length < 1000) break;
  }
  return pages.size;
}
function adoptChildren(summary) {
  for (const c of summary?.children || []) if (c.id && !made.docs.includes(c.id)) made.docs.push(c.id);
  if (summary?.folder_id && !made.folders.includes(summary.folder_id)) made.folders.push(summary.folder_id);
}
async function expectStored(gate, label, d, want) {
  if (!d) return check(gate, false, `${label}: no row`);
  const n = await passageCount(d.id);
  const ts = d.metadata?.text_status;
  check(gate, d.processing_status === 'ready' && ts === want && n === 0 && Boolean(d.metadata?.text_status_at),
    `${label}: ${d.processing_status}, ${n} passages, text_status=${ts}${want !== ts ? ` (want ${want})` : ''}${d.processing_error ? ' | ' + d.processing_error.slice(0, 80) : ''}`);
}
async function expectIndexed(gate, label, d, word, { page = null, minPassages = 1 } = {}) {
  if (!d) return check(gate, false, `${label}: no row`);
  const n = await passageCount(d.id);
  const hit = page ? await pageHasWord(d.id, page, word) : await hasWord(d.id, word);
  check(gate, d.processing_status === 'ready' && n >= minPassages && !d.metadata?.text_status && hit,
    `${label}: ${d.processing_status}, ${n} passage(s), "${word}"${page ? ` on p.${page}` : ''} ${hit ? 'found' : 'NOT found'}${d.metadata?.text_status ? `, text_status=${d.metadata.text_status}` : ''}${d.processing_error ? ' | ' + d.processing_error.slice(0, 80) : ''}`);
}
async function waitChild(id, budgetMs = 5 * 60_000) {
  const t0 = Date.now();
  for (;;) {
    const d = await readDoc(id);
    if (!d || TERMINAL.has(d.processing_status) || Date.now() - t0 > budgetMs) return d;
    await sleep(4000);
  }
}
async function expectChild(gate, label, summary, titleRe, word) {
  const c = (summary?.children || []).find((k) => titleRe.test(k.title || ''));
  if (!c) return check(gate, false, `${label}: no child matching ${titleRe}`);
  const d = await waitChild(c.id);
  await expectIndexed(gate, `${label} child "${c.title}"`, d, word);
}

// =====================================================================================
try {
  // ---- G4: selection-time refusals — no bytes move, no row --------------------------
  console.log('\n[G4] selection-time refusals');
  const r3 = checkUpload({ name: 'giant-record.pdf', size: VAULT_MAX_BYTES + 1 });
  check('G4', r3?.code === 'too_large' && /up to 500 MB/.test(r3.message || ''), `oversize refused at selection: "${(r3?.message || JSON.stringify(r3)).slice(0, 90)}"`);
  const { count: rowsBefore } = await supabase.from('documents').select('id', { count: 'exact', head: true }).eq('matterspace_id', matter.id);
  try {
    await handleFileDocument(supabase, { matter: matter.id, filename: `suite-${tag}.exe`, content: 'MZ' + 'x'.repeat(64) }, { openaiApiKey: env.OPENAI_API_KEY });
    check('G4', false, 'unsupported .exe was accepted');
  } catch (err) {
    check('G4', /\.exe file, which the Vault can't read/.test(err.message) && /Supported: PDF/.test(err.message), `unsupported .exe refused with the supported list: "${err.message.slice(0, 80)}…"`);
  }
  const { count: rowsAfter } = await supabase.from('documents').select('id', { count: 'exact', head: true }).eq('matterspace_id', matter.id);
  check('G4', rowsBefore === rowsAfter, 'no row was created by the refusals');

  // ---- G8: contention — six BULK scans first, then one NORMAL text file -----------------
  // The bulk fixtures are OCR-bound (12 scanned pages each, ~10–25 s of Gemini
  // per document) so both workers are genuinely busy for a couple of rounds;
  // born-digital PDFs clear in seconds and prove nothing. The single upload
  // is queued after them at NORMAL priority and must be picked up as soon as
  // a lane frees — long before the batch is done.
  console.log('\n[G8] bulk production vs a single upload');
  const { count: depth } = await supabase.from('processing_jobs').select('id', { count: 'exact', head: true }).in('status', ['queued', 'running']);
  console.log(`  queue depth before: ${depth || 0} job(s) queued/running`);
  const bulkLabels = [];
  for (let i = 1; i <= 6; i++) {
    const label = `bulk${i}`;
    bulkLabels.push(label);
    await fileAndQueue({ label, title: `Suite bulk ${i} ${tag}`, filename: `suite-bulk-${i}-${tag}.pdf`, bytes: await F.scanPdfPages(12, { tag: `bulk${i}` }), contentType: 'application/pdf', priority: JOB_PRIORITY.BULK });
  }
  await sleep(3000);
  await fileAndQueue({ label: 'single', title: `Suite single ${tag}`, filename: `suite-single-${tag}.txt`, bytes: F.controlTxt({ tag: 'single' }), contentType: 'text/plain', priority: JOB_PRIORITY.NORMAL });
  const g8 = await waitAll([...bulkLabels.map((label) => ({ label, budgetMs: 8 * 60_000 })), { label: 'single', budgetMs: 8 * 60_000 }]);
  {
    const single = timings.single;
    const lastBulk = Math.max(...bulkLabels.map((l) => timings[l].readyAt || Infinity));
    const bulkOk = bulkLabels.every((l) => g8[l]?.processing_status === 'ready');
    const batchMs = lastBulk === Infinity ? null : lastBulk - Math.min(...bulkLabels.map((l) => timings[l].queuedAt));
    check('G8', g8.single?.processing_status === 'ready' && single.readyAt < lastBulk,
      `single upload ready ${(single.pipelineMs / 1000).toFixed(0)} s after queueing — ${lastBulk === Infinity ? 'bulk never finished' : `${((lastBulk - single.readyAt) / 1000).toFixed(0)} s before the bulk batch finished (batch took ${(batchMs / 1000).toFixed(0)} s)`}`);
    check('G8', single.pipelineMs < 120_000, `single upload's queue→ready under 2 min (${(single.pipelineMs / 1000).toFixed(0)} s) with 6 bulk scans queued ahead of it`);
    check('G8', bulkOk, `all 6 bulk scans finished (${bulkLabels.map((l) => `${(timings[l].pipelineMs / 1000).toFixed(0)}s`).join(', ')})`);
  }

  // ---- The corpus: queue everything, heaviest first ---------------------------------
  console.log('\n[corpus] queueing');
  const waits = [];
  const q = async (label, budgetMs, spec) => { await fileAndQueue({ label, ...spec }); waits.push({ label, budgetMs }); };

  if (SKIP_HEAVY) {
    skip('G7', '--skip-heavy');
  } else {
    console.log(`  ${stamp()} building the 200 MB record…`);
    const big = await F.bigRecordPdf({ pages: 400, tag });
    await q('record200', 10 * 60_000, { title: `Suite 200 MB record ${tag}`, filename: `suite-record-${tag}.pdf`, bytes: big, contentType: 'application/pdf' });
    await q('text300', 3 * 60_000, { title: `Suite 300-page brief ${tag}`, filename: `suite-300pp-${tag}.pdf`, bytes: await F.textPdfPages(300, { tag }), contentType: 'application/pdf' });
    await q('scan50', 5 * 60_000, { title: `Suite 50-page scan ${tag}`, filename: `suite-scan50-${tag}.pdf`, bytes: await F.scanPdfPages(50, { tag }), contentType: 'application/pdf' });
  }
  await q('mixed', 5 * 60_000, { title: `Suite mixed ${tag}`, filename: `suite-mixed-${tag}.pdf`, bytes: await F.mixedPdf({ tag }), contentType: 'application/pdf' });
  await q('portfolio', 5 * 60_000, { title: `Suite portfolio ${tag}`, filename: `suite-portfolio-${tag}.pdf`, bytes: await F.portfolioPdf({ tag }), contentType: 'application/pdf' });
  await q('zip', 5 * 60_000, { title: `Suite archive ${tag}`, filename: `suite-archive-${tag}.zip`, bytes: await F.archiveFixture({ tag }), contentType: 'application/zip' });
  await q('eml', 5 * 60_000, { title: `Suite email ${tag}`, filename: `suite-email-${tag}.eml`, bytes: await F.emlFixture({ tag }), contentType: 'message/rfc822' });
  await q('docx', 5 * 60_000, { title: `Suite memo docx ${tag}`, filename: `suite-memo-${tag}.docx`, bytes: await F.docxWithImage({ tag }), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  await q('xlsx', 5 * 60_000, { title: `Suite workbook ${tag}`, filename: `suite-book-${tag}.xlsx`, bytes: await F.xlsxFixture({ tag }), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  await q('epub', 5 * 60_000, { title: `Suite e-book ${tag}`, filename: `suite-book-${tag}.epub`, bytes: await F.epubFixture({ tag }), contentType: 'application/epub+zip' });
  await q('md', 5 * 60_000, { title: `Suite notes md ${tag}`, filename: `suite-notes-${tag}.md`, bytes: F.mdFixture({ tag }), contentType: 'text/markdown' });
  await q('control', 5 * 60_000, { title: `Suite control ${tag}`, filename: `suite-control-${tag}.txt`, bytes: F.controlTxt({ tag }), contentType: 'text/plain' });
  await q('jpgscan', 5 * 60_000, { title: `Suite photographed page ${tag}`, filename: `suite-page-${tag}.jpg`, bytes: await F.jpgScan({ tag }), contentType: 'image/jpeg' });
  await q('imageonly', 5 * 60_000, { title: `Suite image-only ${tag}`, filename: `suite-image-only-${tag}.pdf`, bytes: await F.imageOnlyPdf(), contentType: 'application/pdf' });
  await q('tiff', 5 * 60_000, { title: `Suite photo tiff ${tag}`, filename: `suite-photo-${tag}.tiff`, bytes: await F.tiffBlank(), contentType: 'image/tiff' });
  await q('obj', 5 * 60_000, { title: `Suite 3D asset ${tag}`, filename: `suite-cube-${tag}.obj`, bytes: F.objAsset(), contentType: 'application/octet-stream' });
  await q('blank', 5 * 60_000, { title: `Suite blank ${tag}`, filename: `suite-blank-${tag}.txt`, bytes: F.blankTxt(), contentType: 'text/plain' });
  await q('silent', 5 * 60_000, { title: `Suite silent wav ${tag}`, filename: `suite-silent-${tag}.wav`, bytes: F.silentWav(3), contentType: 'audio/wav' });

  const spoken = F.spokenWav('This is the fixture recording. The witness described a lavender umbrella and a copper kettle. End of recording.');
  const mp3 = F.mediaFromWav(spoken, 'mp3');
  const mp4 = F.mediaFromWav(spoken, 'mp4');
  if (!spoken) skip('GA', 'no text-to-speech available on this machine (Windows System.Speech)');
  else if (!mp3 || !mp4) skip('GA', 'ffmpeg not found — cannot make the mp3/mp4 from the spoken WAV');
  else {
    await q('mp3', 6 * 60_000, { title: `Suite spoken mp3 ${tag}`, filename: `suite-spoken-${tag}.mp3`, bytes: mp3, contentType: 'audio/mpeg' });
    await q('mp4', 6 * 60_000, { title: `Suite spoken mp4 ${tag}`, filename: `suite-spoken-${tag}.mp4`, bytes: mp4, contentType: 'video/mp4' });
  }

  // The corrupt PDF is watched separately: what matters is that the FIRST
  // attempt fails visibly, with a readable cause, within a minute. It is not
  // waited to exhaustion (three attempts with backoff) — cleanup deletes it
  // and its job.
  const corruptId = await fileAndQueue({ label: 'corrupt', title: `Suite corrupt ${tag}`, filename: `suite-corrupt-${tag}.pdf`, bytes: F.corruptPdf(), contentType: 'application/pdf' });

  console.log('\n[corpus] waiting');
  const rows = await waitAll(waits);

  // ---- G7 timings ------------------------------------------------------------------
  if (!SKIP_HEAVY) {
    console.log('\n[G7] time-to-searchable');
    for (const [label, pages, budget, wantResumable] of [['text300', 300, 3, false], ['scan50', 50, 5, false], ['record200', 400, 10, true]]) {
      const d = rows[label]; const t = timings[label];
      if (!d) { check('G7', false, `${label}: no row`); continue; }
      const n = await passageCount(d.id);
      const pagesSeen = await distinctPages(d.id);
      const first = await pageHasWord(d.id, 1, F.wordForPage(1));
      const last = await pageHasWord(d.id, pages, F.wordForPage(pages));
      const okContent = d.processing_status === 'ready' && !d.metadata?.text_status && !d.metadata?.ocr_pending && n >= pages && pagesSeen === pages && first && last;
      check(label === 'scan50' ? 'G1' : 'G0', okContent, `${label}: ${d.processing_status}, ${n} passages over ${pagesSeen}/${pages} pages, p.1 "${F.wordForPage(1)}" ${first ? 'found' : 'NOT found'}, p.${pages} "${F.wordForPage(pages)}" ${last ? 'found' : 'NOT found'}${d.metadata?.ocr_pending ? ', ocr_pending=' + JSON.stringify(d.metadata.ocr_pending).slice(0, 80) : ''}${d.processing_error ? ' | ' + d.processing_error.slice(0, 80) : ''}`);
      check('G7', t.pipelineMs != null && t.pipelineMs < budget * 60_000 && d.processing_status === 'ready', `${label}: queue→ready ${t.pipelineMs == null ? 'never' : (t.pipelineMs / 1000).toFixed(0) + ' s'} (budget ${budget} min; upload ${(t.uploadMs / 1000).toFixed(0)} s${t.resumable ? ', resumable' : ''})`);
      if (wantResumable) check('G7', t.resumable && t.bytes >= 50 * 1024 * 1024, `${label}: ${(t.bytes / 1048576).toFixed(0)} MB went through the resumable (TUS) path`);
    }
  }

  // ---- G1 mixed --------------------------------------------------------------------
  console.log('\n[G1] mixed PDF');
  {
    const d = rows.mixed;
    if (!d) check('G1', false, 'mixed: no row');
    else {
      const n = await passageCount(d.id);
      const p1 = await pageHasWord(d.id, 1, 'memorandum'); const p4 = await pageHasWord(d.id, 4, 'marmalade'); const p5 = await pageHasWord(d.id, 5, 'quixotic');
      check('G1', d.processing_status === 'ready' && n > 0 && !d.metadata?.text_status && !d.metadata?.ocr_pending && d.page_count === 5 && p1 && p4 && p5,
        `mixed: ${d.processing_status}, ${n} passages over ${d.page_count} pages; p.1 typed ${p1}, p.4 "marmalade" ${p4}, p.5 "quixotic" ${p5}; ocr_pending=${JSON.stringify(d.metadata?.ocr_pending || null).slice(0, 60)}${d.processing_error ? ' | ' + d.processing_error.slice(0, 80) : ''}`);
    }
  }

  // ---- G2 containers ---------------------------------------------------------------
  console.log('\n[G2] containers');
  {
    const d = rows.portfolio; const pf = d?.metadata?.portfolio;
    adoptChildren(pf);
    check('G2', d?.processing_status === 'ready' && d.metadata?.text_status === TEXT_STATUS.PORTFOLIO && pf?.children?.length === 2 && pf.folder_id && d.matterspace_id === pf.folder_id,
      `portfolio: ${d?.processing_status}, text_status=${d?.metadata?.text_status}, ${pf?.children?.length ?? 0} children, moved into folder "${pf?.folder_name || '?'}"${d?.processing_error ? ' | ' + d.processing_error.slice(0, 80) : ''}`);
    await expectChild('G2', 'portfolio', pf, /Alpha/, 'cobalt');
    await expectChild('G2', 'portfolio', pf, /Beta/, 'saffron');
  }
  {
    const d = rows.zip; const a = d?.metadata?.archive;
    adoptChildren(a);
    const titles = (a?.children || []).map((c) => c.title).sort();
    check('G2', d?.processing_status === 'ready' && d.metadata?.text_status === TEXT_STATUS.ARCHIVE && a?.entry_count === 3 && JSON.stringify(titles) === JSON.stringify(['Deposition of J. Walters', 'Exhibit C', 'notes']) && a.folder_id && d.matterspace_id === a.folder_id && (a.skipped || []).length === 2,
      `zip: ${d?.processing_status}, text_status=${d?.metadata?.text_status}, children ${JSON.stringify(titles)}, folder "${a?.folder_name || '?'}", ${(a?.skipped || []).length} junk skipped${d?.processing_error ? ' | ' + d.processing_error.slice(0, 80) : ''}`);
    await expectChild('G2', 'zip', a, /Deposition/, 'cobalt');
    await expectChild('G2', 'zip', a, /^notes$/, 'saffron');
    await expectChild('G2', 'zip', a, /Exhibit C/, 'vermilion');
    const st = await handleCheckIngestStatus(supabase, { document_id: d?.id });
    check('G2', st?.container?.kind === 'zip' && st.container.children?.length === 3, `zip: check_ingest_status names ${st?.container?.children?.length ?? 0} children`);
  }
  {
    const d = rows.eml; const ea = d?.metadata?.email_attachments;
    adoptChildren(ea);
    const n = d ? await passageCount(d.id) : 0;
    const body = d ? await pageHasWord(d.id, 1, 'ochre folder') : false;
    const titles = (ea?.children || []).map((c) => c.title).sort();
    check('G2', d?.processing_status === 'ready' && n > 0 && !d.metadata?.text_status && body && ea?.entry_count === 2 && !ea.folder_id && titles.length === 2 && (ea.skipped || []).length === 1,
      `eml: ${d?.processing_status}, ${n} passage(s), body ${body ? 'searchable' : 'NOT searchable'}, ${titles.length} attachments filed beside it, ${(ea?.skipped || []).length} inline image skipped${d?.processing_error ? ' | ' + d.processing_error.slice(0, 80) : ''}`);
    await expectChild('G2', 'eml', ea, /Disclosures/, 'magenta ledger');
    await expectChild('G2', 'eml', ea, /Forwarded scheduling note/, 'teal calendar');
  }

  // ---- G0 formats --------------------------------------------------------------------
  console.log('\n[G0] formats');
  await expectIndexed('G0', 'docx', rows.docx, 'periwinkle');
  await expectIndexed('G0', 'xlsx', rows.xlsx, 'chartreuse');
  await expectIndexed('G0', 'epub', rows.epub, 'emerald');
  await expectIndexed('G0', 'md', rows.md, 'topaz');
  await expectIndexed('G0', 'control txt', rows.control, 'garnet');
  await expectIndexed('G0', 'photographed page (jpg → OCR)', rows.jpgscan, 'onyx');

  // ---- G3 stored with a reason -------------------------------------------------------
  console.log('\n[G3] stored with a reason');
  await expectStored('G3', 'image-only PDF', rows.imageonly, TEXT_STATUS.IMAGE_ONLY);
  await expectStored('G3', 'photo TIFF', rows.tiff, TEXT_STATUS.IMAGE_ONLY);
  await expectStored('G3', '3D .obj', rows.obj, TEXT_STATUS.BINARY_STORED);
  await expectStored('G3', 'blank .txt', rows.blank, TEXT_STATUS.NO_TEXT);
  // A silent clip must NOT come out "searchable" over a passage that reads
  // "[00:00] [silence]" (what Gemini returns for it) — it is a recording
  // without a transcript, stored with that reason.
  await expectStored('G3', 'silent recording', rows.silent, TEXT_STATUS.MEDIA_NO_TRANSCRIPT);
  const st3 = rows.obj ? await handleCheckIngestStatus(supabase, { document_id: rows.obj.id }) : null;
  check('G3', st3?.text_status === TEXT_STATUS.BINARY_STORED && st3.searchable === false && /Kept to open or download/.test(st3.note || ''), `check_ingest_status on the .obj: searchable=false, note="${(st3?.note || '').slice(0, 60)}…"`);

  // ---- GA audio / video ----------------------------------------------------------------
  if (rows.mp3 || rows.mp4) {
    console.log('\n[GA] audio / video');
    for (const label of ['mp3', 'mp4']) {
      const d = rows[label];
      if (!d) { check('GA', false, `${label}: no row`); continue; }
      const n = await passageCount(d.id);
      const w1 = await hasWord(d.id, 'lavender'); const w2 = await hasWord(d.id, 'copper');
      check('GA', d.processing_status === 'ready' && n > 0 && !d.metadata?.text_status && w1 && w2,
        `${label}: ${d.processing_status}, ${n} transcript passage(s), "lavender" ${w1 ? 'found' : 'NOT found'}, "copper" ${w2 ? 'found' : 'NOT found'} (${(timings[label].pipelineMs / 1000).toFixed(0)} s)${d.processing_error ? ' | ' + d.processing_error.slice(0, 80) : ''}`);
    }
  }

  // ---- G4: duplicate + corrupt --------------------------------------------------------
  console.log('\n[G4] duplicate and corrupt');
  {
    const r2 = await handleFileDocument(supabase, { matter: matter.id, filename: `suite-control-${tag}.txt`, content: F.controlTxt({ tag }).toString('utf8') }, { openaiApiKey: env.OPENAI_API_KEY });
    if (r2?.document_id && !r2.already_filed) made.docs.push(r2.document_id);
    check('G4', r2?.already_filed && r2.document_id === rows.control?.id && /^Already filed as "Suite control/.test(r2.note || ''), `duplicate refused: "${(r2?.note || JSON.stringify(r2)).slice(0, 90)}"`);
  }
  {
    const t0 = Date.now();
    let d = null;
    while (Date.now() - t0 < 120_000) {
      d = await readDoc(corruptId);
      if (!d || d.processing_error || TERMINAL.has(d.processing_status)) break;
      await sleep(4000);
    }
    const note = d?.processing_error || '';
    const visible = /^Attempt 1 of 3 failed/.test(note) || d?.processing_status === 'error';
    check('G4', visible && note.length > 20, `corrupt PDF: first attempt failed visibly in ${((Date.now() - t0) / 1000).toFixed(0)} s — status=${d?.processing_status} note="${note.slice(0, 100)}"`);
    check('G5', visible, 'corrupt PDF did not sit silently: the failure note appeared within 2 min');
  }

  // ---- G5 summary -----------------------------------------------------------------------
  {
    const stuck = Object.entries(timings).filter(([, t]) => String(t.status).startsWith('stuck'));
    check('G5', stuck.length === 0, stuck.length ? `${stuck.length} document(s) stuck: ${stuck.map(([l]) => l).join(', ')}` : `every one of ${Object.keys(timings).length} uploads reached a terminal state within its budget`);
  }

  // ---- G6: provider outage, in-process ----------------------------------------------------
  if (flag('--no-g6')) skip('G6', '--no-g6');
  else if (!present(env.OPENAI_API_KEY) || !present(env.GOOGLE_API_KEY)) skip('G6', 'OPENAI_API_KEY / GOOGLE_API_KEY not in this checkout\'s .env');
  else {
    console.log('\n[G6] provider outage (in-process, this checkout\'s lib)');
    const { processDocument } = await import('../lib/ingest-core.mjs');
    const { makeOcrProvider } = await import('../lib/ocr-routes.mjs');
    const brokenOcr = async () => { throw new Error('gemini 503: simulated outage for the suite'); };
    const runLocal = async (id, bytes, filename, ocr) => {
      await supabase.from('passages').delete().eq('document_id', id);
      try {
        return await processDocument(supabase, { documentId: id, fileBuf: bytes, ext: '.' + filename.split('.').pop(), openaiApiKey: env.OPENAI_API_KEY, ocr });
      } catch (err) {
        await supabase.from('documents').update({ processing_status: 'error', processing_error: err.message.slice(0, 500) }).eq('id', id).neq('processing_status', 'ready');
        return null;
      }
    };
    const insertLocal = async (title, filename, bytes, contentType) => {
      const { data: row, error } = await supabase.from('documents').insert({ matterspace_id: matter.id, title, doc_type: 'other', source_filename: filename, file_size_bytes: bytes.length, processing_status: 'pending', created_by: CREATED_BY }).select('id').single();
      if (error) throw new Error(`insert ${title}: ${error.message}`);
      made.docs.push(row.id);
      const storagePath = `${matter.id}/${row.id}/${filename}`;
      await supabase.storage.from('vault-documents').upload(storagePath, bytes, { contentType, upsert: true });
      await supabase.from('documents').update({ storage_path: storagePath }).eq('id', row.id);
      return row.id;
    };
    const mixedBytes = await F.mixedPdf({ tag: `g6${tag}` });
    const f1 = await insertLocal(`Suite outage mixed ${tag}`, `suite-outage-mixed-${tag}.pdf`, mixedBytes, 'application/pdf');
    await runLocal(f1, mixedBytes, `suite-outage-mixed-${tag}.pdf`, brokenOcr);
    let d = await readDoc(f1);
    let op = d?.metadata?.ocr_pending;
    const typed = await pageHasWord(f1, 1, 'memorandum');
    check('G6', d?.processing_status === 'ready' && typed && op && JSON.stringify(op.pages) === '[4,5]' && /503/.test(op.reason || '') && op.attempts === 1 && op.next_retry_at && !op.held,
      `OCR down: mixed PDF ready, typed pages indexed, pages ${JSON.stringify(op?.pages)} awaiting OCR (attempt ${op?.attempts}, retry ${op?.next_retry_at ? 'scheduled' : 'NOT scheduled'}, reason "${(op?.reason || '').slice(0, 40)}")`);
    const st6 = await handleCheckIngestStatus(supabase, { document_id: f1 });
    check('G6', st6?.ocr_pending && st6.searchable === true && /awaiting OCR/.test(st6.note || ''), `check_ingest_status says which pages wait and that the typed pages are searchable: "${(st6?.note || '').slice(0, 70)}…"`);
    await runLocal(f1, mixedBytes, `suite-outage-mixed-${tag}.pdf`, makeOcrProvider(env));
    d = await readDoc(f1); op = d?.metadata?.ocr_pending;
    const p4 = await pageHasWord(f1, 4, 'marmalade'); const p5 = await pageHasWord(f1, 5, 'quixotic');
    check('G6', d?.processing_status === 'ready' && !op && p4 && p5, `OCR back: retry cleared ocr_pending; p.4 "marmalade" ${p4}, p.5 "quixotic" ${p5}`);
    const f2 = await insertLocal(`Suite outage scan ${tag}`, `suite-outage-scan-${tag}.pdf`, await F.imageOnlyPdf(), 'application/pdf');
    await runLocal(f2, await F.imageOnlyPdf(), `suite-outage-scan-${tag}.pdf`, brokenOcr);
    d = await readDoc(f2);
    check('G6', d?.processing_status === 'ready' && d.metadata?.text_status === TEXT_STATUS.OCR_PENDING && (await passageCount(f2)) === 0, `OCR down: image-only PDF stored as ocr_pending (not error, not image_only) — text_status=${d?.metadata?.text_status}`);
  }
} catch (err) {
  failures.push(`suite crashed: ${err.message}`);
  console.error(`\nSUITE CRASHED: ${err.stack || err.message}`);
} finally {
  // ---- cleanup ------------------------------------------------------------------------------
  if (KEEP) console.log('\n--keep: leaving everything in place');
  else {
    console.log('\ncleanup');
    const { data: rowsToDrop } = await supabase.from('documents').select('id, storage_path').in('id', made.docs);
    const paths = (rowsToDrop || []).map((r) => r.storage_path).filter(Boolean);
    for (let i = 0; i < paths.length; i += 100) await supabase.storage.from('vault-documents').remove(paths.slice(i, i + 100));
    for (const id of made.docs) await supabase.from('processing_jobs').delete().eq('job_type', 'ingest_document').in('status', ['queued', 'held']).contains('payload', { document_id: id });
    if (made.docs.length) await supabase.from('documents').delete().in('id', made.docs);
    let removedFolders = 0;
    for (const f of made.folders) {
      const { count } = await supabase.from('documents').select('id', { count: 'exact', head: true }).eq('matterspace_id', f);
      if (count === 0) { await supabase.from('matterspaces').delete().eq('id', f); removedFolders++; } else console.log(`  folder ${f} kept (${count} docs)`);
    }
    console.log(`  removed ${made.docs.length} doc(s), ${removedFolders} folder(s), ${paths.length} stored object(s)`);
  }
}

// ---- G9: the monitor, after cleanup ----------------------------------------------------------
if (flag('--no-g9')) skip('G9', '--no-g9');
else {
  console.log('\n[G9] monitor');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ingest-monitor.mjs'), '--quiet'], { cwd: ROOT, encoding: 'utf8', timeout: 5 * 60_000 });
  const tail = String(r.stdout || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' / ');
  check('G9', r.status === 0, r.status === 0 ? 'ingest-monitor --quiet exit 0: nothing needs attention' : `ingest-monitor exit ${r.status}: ${(tail || String(r.stderr || '').slice(0, 200)) || 'no output'}`);
}
skip('G10', 'manual: iPhone Files-app upload of a scan and a photo (per the plan memo)');

// ---- Report ------------------------------------------------------------------------------------
const finishedAt = new Date();
const pass = failures.length === 0;
const logDir = path.join(ROOT, 'logs');
const logFile = path.join(logDir, 'ingest-suite.jsonl');
let prevStreak = 0;
try {
  const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  for (let i = lines.length - 1; i >= 0 && lines[i].pass; i--) prevStreak++;
} catch { /* first run */ }
const streak = pass ? prevStreak + 1 : 0;
const L = [];
L.push(`Ingestion suite — ${finishedAt.toISOString().slice(0, 16).replace('T', ' ')}Z — ${pass ? 'PASS' : 'FAIL'} — ${((finishedAt - startedAt) / 60000).toFixed(1)} min — run ${tag}`);
L.push(pass ? (streak >= 3 ? `100% READY: green ${streak} nights running.` : `Green ${streak} night(s) running (100% ready = 3).`) : 'Streak reset.');
L.push('');
for (const [g, title] of Object.entries(GATES)) {
  const e = ledger[g];
  const n = e.checks.length; const bad = e.checks.filter((c) => !c.ok).length;
  const state = e.skipped ? `SKIP (${e.skipped})` : n === 0 ? 'no checks' : bad ? `FAIL ${bad}/${n}` : `PASS ${n}/${n}`;
  L.push(`${g.padEnd(4)} ${state.padEnd(28)} ${title}`);
}
L.push('');
L.push('Timings (queue → ready):');
for (const [label, t] of Object.entries(timings)) L.push(`  ${label.padEnd(12)} ${String((t.bytes / 1048576).toFixed(t.bytes > 1048576 ? 1 : 2)).padStart(7)} MB  upload ${String((t.uploadMs / 1000).toFixed(1)).padStart(6)} s  pipeline ${t.pipelineMs == null ? '   —  ' : String((t.pipelineMs / 1000).toFixed(0)).padStart(4) + ' s'}  ${t.status}${t.resumable ? '  (resumable)' : ''}`);
if (failures.length) { L.push(''); L.push('Failures:'); for (const f of failures) L.push(`  - ${f}`); }
const report = L.join('\n');
console.log('\n' + '='.repeat(100) + '\n' + report + '\n' + '='.repeat(100));

try {
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(logFile, JSON.stringify({
    at: finishedAt.toISOString(), pass, streak, minutes: Number(((finishedAt - startedAt) / 60000).toFixed(1)), run: tag, skipHeavy: SKIP_HEAVY,
    gates: Object.fromEntries(Object.entries(ledger).map(([g, e]) => [g, e.skipped ? 'skip' : e.checks.length === 0 ? 'none' : e.checks.every((c) => c.ok) ? 'pass' : 'fail'])),
    timings: Object.fromEntries(Object.entries(timings).map(([l, t]) => [l, { bytes: t.bytes, uploadMs: t.uploadMs, pipelineMs: t.pipelineMs, status: t.status }])),
    failures,
  }) + '\n');
} catch (e) { console.error(`(could not write ${logFile}: ${e.message})`); }

if (flag('--email')) {
  const to = env.GMAIL_ADDRESS; const pw = env.GMAIL_APP_PASSWORD;
  if (!present(to) || !present(pw)) console.log('(--email skipped: GMAIL_ADDRESS / GMAIL_APP_PASSWORD not set)');
  else {
    try {
      const { default: nodemailer } = await import('nodemailer');
      const t = nodemailer.createTransport({ service: 'gmail', auth: { user: to, pass: pw } });
      await t.sendMail({ from: to, to, subject: `Ingestion suite ${finishedAt.toISOString().slice(0, 10)}: ${pass ? `PASS (green ${streak} night${streak === 1 ? '' : 's'})` : `FAIL — ${failures.length} check(s)`}`, text: report });
      console.log(`emailed ${to}`);
    } catch (e) { console.error(`(--email failed: ${String(e.message || e).split('\n')[0]})`); }
  }
}
process.exit(pass ? 0 : 1);
