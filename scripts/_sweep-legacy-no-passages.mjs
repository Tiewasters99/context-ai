// Sweep the legacy "no passages extracted" documents (2026-08-22 ingestion
// audit, fix 5).
//
// 94 documents on prod sit in processing_status = 'error' with
// processing_error = 'no passages extracted'. Every one of them was ingested
// between May and July 2026 — before the OCR fallback was wired into
// processDocument — and they were deliberately excluded from the July sweep.
// 90 are scanned PDFs, 542 MB in total, mostly small exhibits. The pipeline
// that failed them is not the pipeline we run today.
//
// This script re-checks each one against the CURRENT extractor and reports
// what would happen if it were re-queued now. It writes nothing unless you
// pass --apply, and even then it only re-queues: it never deletes, never
// edits text, never touches storage.
//
//   node scripts/_sweep-legacy-no-passages.mjs                 # report, full probe
//   node scripts/_sweep-legacy-no-passages.mjs --limit 10      # probe the first 10
//   node scripts/_sweep-legacy-no-passages.mjs --no-fetch      # metadata only, no downloads
//   node scripts/_sweep-legacy-no-passages.mjs --apply         # re-queue the retryable ones
//
// The probe downloads each file and runs lib/ingest-core.mjs's own
// extractPages() over it — the same call the real pipeline makes — then applies
// the same "looks scanned" test processDocument uses to decide whether to reach
// for OCR. It deliberately does NOT call the OCR API: that is billable work
// (~$0.002/page) and the worker will do it properly on re-queue. What this
// tells you is which of the 94 the current pipeline would take a different
// path on, and therefore which are worth re-queueing.
//
// --apply enqueues one ingest_document job per retryable document and resets it
// to 'pending', exactly the way /api/ingest routes a heavy file. The worker
// picks them up on its normal poll. It de-duplicates against open jobs, so
// running it twice is harmless.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { extractPages, sniffExtension, SUPPORTED_EXTENSIONS } from '../lib/ingest-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SB = env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error('VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env'); process.exit(2); }
const supabase = createClient(SB, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const args = { limit: Infinity, fetch: true, apply: false, error: 'no passages extracted' };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--limit') args.limit = Number(process.argv[++i]);
  else if (a === '--no-fetch') args.fetch = false;
  else if (a === '--apply') args.apply = true;
  else if (a === '--error') args.error = process.argv[++i];
  else if (a === '--help') {
    console.log('usage: _sweep-legacy-no-passages.mjs [--limit N] [--no-fetch] [--apply] [--error "substring"]');
    process.exit(0);
  }
}

const MB = 1024 * 1024;
const fmtMB = (b) => `${((b || 0) / MB).toFixed(2)} MB`;
const extOf = (name) => (name || '').includes('.') ? '.' + name.split('.').pop().toLowerCase() : '';

// ---------------------------------------------------------------------------
// 1. The population
// ---------------------------------------------------------------------------
const { data: docs, error: listErr } = await supabase
  .from('documents')
  .select('id, title, source_filename, file_size_bytes, storage_path, processing_error, created_at, matterspace_id')
  .eq('processing_status', 'error')
  .ilike('processing_error', `%${args.error}%`)
  .order('created_at', { ascending: true });
if (listErr) { console.error(`list: ${listErr.message}`); process.exit(2); }

const { data: matters } = await supabase.from('matterspaces').select('id, name, short_code');
const matterName = new Map((matters ?? []).map((m) => [m.id, m.short_code || m.name]));

console.log(`${docs.length} document(s) with processing_error like "${args.error}"`);
const byExt = {};
const byMatter = {};
let totalBytes = 0;
for (const d of docs) {
  byExt[extOf(d.source_filename) || '(none)'] = (byExt[extOf(d.source_filename) || '(none)'] ?? 0) + 1;
  const mn = matterName.get(d.matterspace_id) ?? d.matterspace_id;
  byMatter[mn] = (byMatter[mn] ?? 0) + 1;
  totalBytes += d.file_size_bytes || 0;
}
console.log(`  ${fmtMB(totalBytes)} total`);
console.log(`  by extension: ${Object.entries(byExt).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} ${n}`).join(' · ')}`);
console.log(`  by matter:    ${Object.entries(byMatter).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(' · ')}`);

// ---------------------------------------------------------------------------
// 2. Re-check each one against the current extractor
// ---------------------------------------------------------------------------
// Verdicts:
//   ocr        — a PDF with no usable text layer. The pipeline that failed it
//                had no OCR hook; today's worker does. Re-queue.
//   text       — the current extractor gets real text out of it. Whatever the
//                extractor could not read in May it can read now. Re-queue.
//   no_text    — extraction succeeds and there genuinely is nothing to index.
//                Re-queueing changes nothing; the honest end state is
//                store-and-display, not 'error'.
//   unreadable — extraction throws. Needs a human or a different file.
//   no_file    — no storage_path: the upload never landed. Cannot be retried.
const VERDICT = { ocr: [], text: [], no_text: [], unreadable: [], no_file: [], unprobed: [] };

const probeList = docs.slice(0, args.limit === Infinity ? docs.length : args.limit);
let i = 0;
for (const d of probeList) {
  i += 1;
  const label = `[${String(i).padStart(3)}/${probeList.length}] ${(d.source_filename || d.title || d.id).slice(0, 58)}`;

  if (!d.storage_path) { VERDICT.no_file.push({ d, why: 'no storage_path' }); console.log(`${label}  no_file`); continue; }
  if (!args.fetch) { VERDICT.unprobed.push({ d, why: '--no-fetch' }); continue; }

  const { data: blob, error: dlErr } = await supabase.storage.from('vault-documents').download(d.storage_path);
  if (dlErr || !blob) { VERDICT.unreadable.push({ d, why: `download: ${dlErr?.message ?? 'empty'}` }); console.log(`${label}  unreadable (download)`); continue; }
  const buf = Buffer.from(await blob.arrayBuffer());

  // processDocument trusts magic bytes over the filename when the extension is
  // not one it knows; mirror that so the verdict matches what would really run.
  let ext = extOf(d.source_filename);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) ext = sniffExtension(buf) || ext;

  let pages = null;
  try {
    pages = await extractPages(buf, ext);
  } catch (err) {
    VERDICT.unreadable.push({ d, why: `${ext || '?'}: ${err.message}`.slice(0, 140) });
    console.log(`${label}  unreadable (${err.message.slice(0, 60)})`);
    continue;
  }

  const chars = (pages ?? []).reduce((s, p) => s + (p.text || '').trim().length, 0);
  // The same test processDocument uses. A CM/ECF header stamp is real digital
  // text on a scanned page, so "found some text" is not "readable document".
  const looksScanned = ext === '.pdf' && chars < Math.max(40, (pages?.length ?? 0) * 200);

  if (looksScanned) {
    VERDICT.ocr.push({ d, pages: pages?.length ?? 0, chars });
    console.log(`${label}  ocr        ${pages?.length ?? 0}pp, ${chars} chars of text layer`);
  } else if (chars >= 40) {
    VERDICT.text.push({ d, pages: pages?.length ?? 0, chars });
    console.log(`${label}  text       ${pages?.length ?? 0}pp, ${chars} chars extract cleanly now`);
  } else {
    VERDICT.no_text.push({ d, pages: pages?.length ?? 0, chars });
    console.log(`${label}  no_text    ${pages?.length ?? 0}pp, ${chars} chars`);
  }
}

// ---------------------------------------------------------------------------
// 3. Report
// ---------------------------------------------------------------------------
const pages = (list) => list.reduce((s, x) => s + (x.pages || 0), 0);
console.log('\n─── verdict ───────────────────────────────────────────────────');
console.log(`  re-queue → OCR      ${String(VERDICT.ocr.length).padStart(4)}   ${pages(VERDICT.ocr)} pages, ~$${(pages(VERDICT.ocr) * 0.002).toFixed(2)} of Gemini OCR`);
console.log(`  re-queue → text     ${String(VERDICT.text.length).padStart(4)}   the current extractor reads these`);
console.log(`  genuinely no text   ${String(VERDICT.no_text.length).padStart(4)}   store-and-display is the honest state`);
console.log(`  unreadable          ${String(VERDICT.unreadable.length).padStart(4)}   needs a human or a fresh copy`);
console.log(`  upload never landed ${String(VERDICT.no_file.length).padStart(4)}   cannot be retried`);
if (VERDICT.unprobed.length) console.log(`  not probed          ${String(VERDICT.unprobed.length).padStart(4)}   (--no-fetch)`);

for (const [k, why] of [['unreadable', 'unreadable'], ['no_file', 'upload never landed']]) {
  if (VERDICT[k].length) {
    console.log(`\n  ${why}:`);
    for (const x of VERDICT[k]) console.log(`    ${(x.d.source_filename || x.d.id).slice(0, 60).padEnd(62)} ${x.why ?? ''}`);
  }
}

const retryable = [...VERDICT.ocr, ...VERDICT.text].map((x) => x.d);
console.log(`\n  ${retryable.length} document(s) would be re-queued.`);

if (!args.apply) {
  console.log('\n  REPORT ONLY — nothing was written. Re-run with --apply to enqueue them.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 4. --apply: enqueue. Mirrors /api/ingest's heavy-job route exactly.
// ---------------------------------------------------------------------------
console.log('\n─── applying ──────────────────────────────────────────────────');
let queued = 0;
let skipped = 0;
for (const d of retryable) {
  const { data: existing } = await supabase.from('processing_jobs')
    .select('id').eq('job_type', 'ingest_document')
    .in('status', ['queued', 'running'])
    .contains('payload', { document_id: d.id })
    .limit(1);
  if (existing?.length) { skipped += 1; continue; }

  const { error: qErr } = await supabase.from('processing_jobs').insert({
    matterspace_id: d.matterspace_id,
    job_type: 'ingest_document',
    payload: { document_id: d.id },
  });
  if (qErr) { console.log(`  enqueue failed for ${d.source_filename}: ${qErr.message}`); continue; }

  const { error: uErr } = await supabase.from('documents')
    .update({ processing_status: 'pending', processing_error: null })
    .eq('id', d.id);
  if (uErr) console.log(`  status reset failed for ${d.source_filename}: ${uErr.message}`);
  queued += 1;
}
console.log(`  ${queued} queued, ${skipped} already had an open job.`);
console.log('  The worker will pick them up on its next poll. Watch with:');
console.log('    node scripts/ingest-monitor.mjs');
