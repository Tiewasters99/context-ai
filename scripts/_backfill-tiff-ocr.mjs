// Backfill OCR for the stored TIFFs (2026-08-22 ingestion audit, fix 4).
//
// The state this repairs
// ---------------------------------------------------------------------------
// 5,782 documents whose filename ends .tif/.tiff are stored, marked `ready`,
// and carry zero passages between them. 5,775 are `BMC_00xxxx.tif` — Bryn
// Mawr's Bates production in the live DeCamara matter. They are invisible to
// search, to the Orchestrator and to MCP: a keyword that appears on a hundred
// produced pages returns nothing, with no error anywhere to suggest the answer
// is incomplete. That is the worst failure mode a document system has.
//
// The cause was one list. `.tif` was in IMAGE_EXTENSIONS but not in
// OCRABLE_IMAGE_EXTENSIONS, so processDocument took the store-and-display
// branch. The code fix on this branch adds it and teaches imageToPdf() to
// transcode TIFF with sharp. That fixes every TIFF uploaded from now on; this
// script is for the ones already sitting in the vault.
//
// Why it does the work locally instead of enqueueing
// ---------------------------------------------------------------------------
// The obvious move is to insert 5,782 `ingest_document` jobs and let the shared
// worker drain them. Don't. worker/discovery-worker.mjs claims and runs ONE job
// at a time in a `for(;;)` loop — 5,782 jobs at ~12s each is roughly 19 hours
// during which every ordinary upload in every matter queues behind a Bates
// backlog. This script downloads and processes directly, with its own
// concurrency, and never touches processing_jobs. The shared worker stays free.
//
// `--queue` is kept for the case where you would rather the worker do it.
//
// Safety
// ---------------------------------------------------------------------------
//   * Writes nothing at all without --apply (or --queue).
//   * Idempotent and resumable: a document that already has passages is
//     skipped, so re-running after an interruption picks up where it stopped.
//   * Never deletes, never edits existing text, never touches storage.
//   * On failure a document is restored to the processing_status it had, so an
//     interrupted run cannot strand documents mid-pipeline.
//   * Duplicates are skipped by default — see the note in section 1b.
//   * --limit is your friend. Do a pilot batch, look at the passages, then run
//     the rest.
//
//   node scripts/_backfill-tiff-ocr.mjs                          # report, free
//   node scripts/_backfill-tiff-ocr.mjs --apply --limit 25       # pilot, ~$0.05
//   node scripts/_backfill-tiff-ocr.mjs --apply --concurrency 6  # the rest
//   node scripts/_backfill-tiff-ocr.mjs --queue --limit 100      # hand to the worker
//   node scripts/_backfill-tiff-ocr.mjs --manifest dupes.json    # record what is skipped
//
// Cost: Gemini Flash OCR is ~$0.002 a page and every sampled TIFF is a single
// 300 dpi letter page. Skipping duplicates, the backlog is ~$5.81 rather than
// ~$11.56. Confirm against the current price sheet before a big run.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { processDocument } from '../lib/ingest-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SB = env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE = env.GOOGLE_API_KEY;
const OPENAI = env.OPENAI_API_KEY;
if (!SB || !KEY) { console.error('VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env'); process.exit(2); }

const args = { limit: Infinity, apply: false, queue: false, concurrency: 4, matter: null, includeDuplicates: false, manifest: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--limit') args.limit = Number(process.argv[++i]);
  else if (a === '--apply') args.apply = true;
  else if (a === '--queue') args.queue = true;
  else if (a === '--concurrency') args.concurrency = Math.max(1, Number(process.argv[++i]));
  else if (a === '--matter') args.matter = process.argv[++i];
  else if (a === '--include-duplicates') args.includeDuplicates = true;
  else if (a === '--manifest') args.manifest = process.argv[++i];
  else if (a === '--help') {
    console.log('usage: _backfill-tiff-ocr.mjs [--limit N] [--concurrency C] [--matter name]');
    console.log('                              [--include-duplicates] [--manifest FILE] [--apply | --queue]');
    process.exit(0);
  }
}
if (args.apply && args.queue) { console.error('--apply and --queue are alternatives; pick one.'); process.exit(2); }
if (args.apply && (!GOOGLE || !OPENAI)) { console.error('--apply needs GOOGLE_API_KEY (OCR) and OPENAI_API_KEY (embeddings) in .env'); process.exit(2); }

const supabase = createClient(SB, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const rest = async (p) => {
  const r = await fetch(`${SB}/rest/v1/${p}`, { headers: H });
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${await r.text()}`);
  return r.json();
};

// ---------------------------------------------------------------------------
// 1. The population
// ---------------------------------------------------------------------------
console.log('--- population ------------------------------------------------');
let matterFilter = '';
if (args.matter) {
  const ms = await rest(`matterspaces?select=id,name&name=ilike.*${encodeURIComponent(args.matter)}*`);
  if (!ms.length) { console.error(`no matterspace matching "${args.matter}"`); process.exit(2); }
  matterFilter = `&matterspace_id=in.(${ms.map((m) => m.id).join(',')})`;
  console.log(`matter filter: ${ms.map((m) => m.name).join(', ')}`);
}

const docs = [];
for (let off = 0; ; off += 1000) {
  const page = await rest(
    `documents?select=id,matterspace_id,source_filename,file_size_bytes,storage_path,processing_status,page_count,created_at` +
    `&or=(source_filename.ilike.*.tif,source_filename.ilike.*.tiff)${matterFilter}` +
    `&order=source_filename&limit=1000&offset=${off}`
  );
  docs.push(...page);
  if (page.length < 1000) break;
}
const names = await rest('matterspaces?select=id,name');
const nameOf = Object.fromEntries(names.map((m) => [m.id, m.name]));

// Which of them already have passages? One batched lookup rather than 5,782
// head counts: passages only come back for documents that have them.
const withPassages = new Set();
for (let i = 0; i < docs.length; i += 150) {
  const ids = docs.slice(i, i + 150).map((d) => d.id);
  const rows = await rest(`passages?select=document_id&document_id=in.(${ids.join(',')})&limit=10000`);
  for (const r of rows) withPassages.add(r.document_id);
}

const MB = 1024 * 1024;
const noFile = docs.filter((d) => !d.storage_path);
const done = docs.filter((d) => withPassages.has(d.id));
const todo = docs.filter((d) => d.storage_path && !withPassages.has(d.id));

// ---------------------------------------------------------------------------
// 1b. Duplicates.
//
// Same matter + same filename + same byte size is the same page filed twice.
// 2,875 of the 5,782 TIFFs are duplicates on that key — the DeCamara production
// appears to have been filed roughly twice over. OCR'ing both copies costs
// twice and puts the same page into the index twice, so a search for a term on
// that page returns it as two hits. Eden's call, 2026-08-23: don't OCR them.
//
// One copy per group is OCR'd — the OLDEST by created_at, i.e. the original
// filing, with the document id as a tiebreak so the choice is stable across
// runs. A copy that somehow already has passages wins outright, so re-running
// never picks a different canonical than last time.
//
// The skipped twins stay `ready` with zero passages, which is exactly how they
// look now. That is a deliberate trade and it has a cost worth stating: an
// audit of "ready but empty" will still find them, and opening one in the Vault
// shows a page with no text behind it. The content is reachable through its
// canonical twin in the same matter. --include-duplicates OCRs everything if
// that trade turns out to be wrong; --manifest writes the full skip list so the
// decision is recoverable rather than folklore.
// Group over EVERY stored TIFF, not just the unprocessed ones. Grouping over
// the to-do list looks right and is wrong on the second run: once a canonical
// copy has passages it drops out of the to-do list, its twin becomes the only
// member of its group, and the twin gets promoted to canonical and OCR'd. Any
// resume would quietly reinstate the duplicates this is meant to skip — and a
// multi-hour run over thousands of pages will be resumed.
const groups = new Map();
for (const d of docs.filter((x) => x.storage_path)) {
  const k = `${d.matterspace_id}|${d.source_filename}|${d.file_size_bytes}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(d);
}
const canonical = [];
const dupeSkipped = [];
for (const copies of groups.values()) {
  // Oldest first (the original filing), document id as a stable tiebreak, and
  // a copy that already has passages wins outright — so the canonical never
  // changes between runs.
  const sorted = [...copies].sort((a, b) =>
    (withPassages.has(b.id) ? 1 : 0) - (withPassages.has(a.id) ? 1 : 0) ||
    String(a.created_at).localeCompare(String(b.created_at)) ||
    a.id.localeCompare(b.id));
  const keep = sorted[0];
  // The group is satisfied the moment ANY copy carries passages: the page is
  // in the index and searchable, which is the whole objective.
  const satisfied = copies.some((c) => withPassages.has(c.id));
  if (!satisfied) canonical.push(keep);
  for (const twin of sorted.slice(1)) dupeSkipped.push({ skipped: twin, keep });
}

const work = args.includeDuplicates ? todo : canonical;
const byMatter = {};
for (const d of work) { const n = nameOf[d.matterspace_id] || d.matterspace_id; byMatter[n] = (byMatter[n] || 0) + 1; }

console.log(`  ${docs.length} TIFF document(s)`);
console.log(`  ${done.length} already have passages (skipped)`);
console.log(`  ${noFile.length} have no storage_path (upload never landed - skipped)`);
if (dupeSkipped.length) {
  console.log(args.includeDuplicates
    ? `  ${dupeSkipped.length} are exact duplicates - INCLUDED because --include-duplicates was passed`
    : `  ${dupeSkipped.length} are exact duplicates (same matter, filename, size) - skipped, saving ~$${(dupeSkipped.length * 0.002).toFixed(2)}`);
}
console.log(`  ${work.length} to process, ${(work.reduce((s, d) => s + (d.file_size_bytes || 0), 0) / MB).toFixed(1)} MB`);
for (const [m, n] of Object.entries(byMatter).sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(6)}  ${m}`);
console.log(`  estimated OCR cost @ $0.002/page, 1 page/file: $${(work.length * 0.002).toFixed(2)}`);

if (args.manifest) {
  const out = dupeSkipped.map((x) => ({
    skipped_id: x.skipped.id,
    keep_id: x.keep.id,
    matter: nameOf[x.skipped.matterspace_id] || x.skipped.matterspace_id,
    filename: x.skipped.source_filename,
    file_size_bytes: x.skipped.file_size_bytes,
  }));
  fs.writeFileSync(args.manifest, JSON.stringify(out, null, 1));
  console.log(`  duplicate skip list written to ${args.manifest} (${out.length} entries)`);
}

const target = work.slice(0, args.limit === Infinity ? work.length : args.limit);
if (!args.apply && !args.queue) {
  console.log(`\n  REPORT ONLY - nothing was written.`);
  console.log(`  Pilot:    node scripts/_backfill-tiff-ocr.mjs --apply --limit 25`);
  console.log(`  Full run: node scripts/_backfill-tiff-ocr.mjs --apply --concurrency 6`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. --queue: hand them to the shared worker instead. Read the note at the top
//    before using this on the whole backlog.
// ---------------------------------------------------------------------------
if (args.queue) {
  console.log(`\n--- queueing ${target.length} to the shared worker ---------------`);
  if (target.length > 250) console.log('  ! the worker runs one job at a time; this will monopolize it for hours.');
  let queued = 0, skipped = 0;
  for (const d of target) {
    const { data: open } = await supabase.from('processing_jobs')
      .select('id').eq('job_type', 'ingest_document')
      .in('status', ['queued', 'running'])
      .contains('payload', { document_id: d.id }).limit(1);
    if (open?.length) { skipped += 1; continue; }
    const { error } = await supabase.from('processing_jobs').insert({
      matterspace_id: d.matterspace_id, job_type: 'ingest_document', payload: { document_id: d.id },
    });
    if (error) { console.log(`  enqueue failed ${d.source_filename}: ${error.message}`); continue; }
    await supabase.from('documents').update({ processing_status: 'pending', processing_error: null }).eq('id', d.id);
    queued += 1;
  }
  console.log(`  ${queued} queued, ${skipped} already had an open job.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 3. --apply: do the work here, `concurrency` documents at a time.
// ---------------------------------------------------------------------------
const { ocrPdf } = await import('../lib/ocr-gemini.mjs');
const ocr = (buf) => ocrPdf(buf, { apiKey: GOOGLE });

console.log(`\n--- processing ${target.length} document(s), concurrency ${args.concurrency} ---`);
const t0 = Date.now();
const stats = { indexed: 0, noText: 0, failed: 0, passages: 0 };
let cursor = 0;
let stopped = false;
process.on('SIGINT', () => { stopped = true; console.log('\n  SIGINT - finishing in-flight documents, then stopping.'); });

async function one(d) {
  const priorStatus = d.processing_status;
  try {
    const res = await fetch(`${SB}/storage/v1/object/vault-documents/${d.storage_path}`, { headers: H });
    if (!res.ok) throw new Error(`download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = '.' + (d.source_filename || '').split('.').pop().toLowerCase();
    const out = await processDocument(supabase, {
      documentId: d.id, fileBuf: buf, ext, openaiApiKey: OPENAI, ocr,
    });
    const n = out?.passageCount ?? 0;
    if (n > 0) { stats.indexed += 1; stats.passages += n; }
    else {
      // OCR found nothing legible. processDocument has already put it back to
      // 'ready' as store-and-display, which is the correct resting state for a
      // page that genuinely has no text on it.
      stats.noText += 1;
    }
    return n;
  } catch (err) {
    stats.failed += 1;
    // Never leave a document mid-pipeline because this script died on it.
    await supabase.from('documents')
      .update({ processing_status: priorStatus, processing_error: null })
      .eq('id', d.id)
      .in('processing_status', ['pending', 'extracting', 'chunking', 'embedding']);
    console.log(`  FAIL ${d.source_filename}: ${err.message}`);
    return 0;
  }
}

async function lane() {
  for (;;) {
    if (stopped) return;
    const i = cursor++;
    if (i >= target.length) return;
    const n = await one(target[i]);
    void n;
    const seen = stats.indexed + stats.noText + stats.failed;
    const rate = seen / ((Date.now() - t0) / 1000);
    const left = target.length - seen;
    if (seen % 10 === 0 || left < 5) {
      process.stdout.write(
        `  ${String(seen).padStart(5)}/${target.length}  ` +
        `indexed ${stats.indexed} - no-text ${stats.noText} - failed ${stats.failed}  ` +
        `${rate.toFixed(2)}/s  eta ${(left / Math.max(rate, 0.001) / 60).toFixed(0)}m   \r`
      );
    }
  }
}

await Promise.all(Array.from({ length: args.concurrency }, () => lane()));

const mins = (Date.now() - t0) / 60000;
console.log(`\n\n--- done in ${mins.toFixed(1)} min ------------------------------`);
console.log(`  ${stats.indexed} indexed (${stats.passages} passages)`);
console.log(`  ${stats.noText} had no legible text - left as store-and-display`);
console.log(`  ${stats.failed} failed`);
console.log(`  ~$${((stats.indexed + stats.noText) * 0.002).toFixed(2)} of OCR spent`);
if (stopped) console.log('  Stopped early. Re-run the same command to resume - documents with passages are skipped.');
