// Bulk import a local folder tree (typically a OneDrive matter folder) into
// Contextspaces — resumably, and without the failure modes that sank the July
// 2026 run.
//
// What went wrong last time, and what this does about it:
//
//   1. FILES ON DEMAND. 82% of the Quainton Law OneDrive is cloud-only
//      placeholder stubs, not bytes on disk. `fs.readFile` on a placeholder
//      blocks while OneDrive downloads it, and a 200k-file sequential loop
//      spends its life stalled on the network — that, not the pipeline, is why
//      "most of it" never landed. We detect placeholders up front, refuse to
//      read them by accident, and hydrate deliberately in budgeted batches.
//
//   2. NO LEDGER. The old script was a bare `for` loop: a stall or crash lost
//      everything after it and a rerun started from zero. Every file here gets
//      an append-only ledger record, so --run is resumable and idempotent.
//
//   3. NO RATE DISCIPLINE. Concurrent ingests pinned the OpenAI org at its 1M
//      TPM ceiling and failed each other with 429s. Embedding now goes through
//      the shared bucket in lib/rate-limit.mjs.
//
//   4. NO TRIAGE. Errors scrolled past in a log. Here they are classified and
//      counted, and --report prints the action for each class.
//
// Phases (run them in order; each is separately resumable):
//   --scan      walk the tree, classify, write the ledger.        no network
//   --hydrate   pin cloud-only files so OneDrive downloads them.  no API spend
//   --run       upload + ingest everything ready.                 spends money
//   --report    status summary and what to do next.               read-only
//
// Usage:
//   node scripts/bulk-import.mjs --scan   --root "C:\...\! Fleming" --matter fleming
//   node scripts/bulk-import.mjs --report --root "C:\...\! Fleming"
//   node scripts/bulk-import.mjs --hydrate --root "..." --budget-gb 20
//   node scripts/bulk-import.mjs --run    --root "..." --limit 50 --concurrency 4
//
// Required env (./.env): VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//                        OPENAI_API_KEY, GOOGLE_API_KEY (OCR + transcription)

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { processDocument, needsWorkerIngest, MEDIA_EXTENSIONS, IMAGE_EXTENSIONS } from '../lib/ingest-core.mjs';
import { classifyError, summarize } from '../lib/ingest-triage.mjs';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// -----------------------------------------------------------------------------
// What we will and won't take
// -----------------------------------------------------------------------------

// Build-output and tooling directories. Ingesting these is pure cost: 35,185
// files / 2.4 GB of node_modules and friends were sitting in the July scan.
const NOISE_DIR = /(^|[\\/])(node_modules|\.git|\.svn|\.venv|venv|__pycache__|\.next|\.nuxt|\.cache|dist|build|out|obj|bin|AppData|Library|\.terraform|vendor)([\\/]|$)/i;

// Files a Windows/OneDrive tree accumulates that carry no user content.
const NOISE_FILE = /^(\.DS_Store|Thumbs\.db|desktop\.ini|~\$.*|\..*\.swp|.*\.tmp|.*\.lnk|.*\.url)$/i;

const DOC_EXTS = new Set([
  '.pdf', '.docx', '.doc', '.txt', '.md', '.rtf', '.xlsx', '.xls',
  '.pptx', '.ppt', '.eml', '.msg', '.epub', '.fountain', '.csv', '.wpd',
]);
const IMG_EXTS = new Set([...IMAGE_EXTENSIONS, '.heic']);
const AV_EXTS = new Set(MEDIA_EXTENSIONS);

function classOf(ext) {
  if (DOC_EXTS.has(ext)) return 'doc';
  if (IMG_EXTS.has(ext)) return 'img';
  if (AV_EXTS.has(ext)) return 'av';
  return 'other';
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
const PHASES = ['scan', 'hydrate', 'run', 'report'].filter((p) => args[p]);
if (PHASES.length !== 1) die('Pick exactly one phase: --scan | --hydrate | --run | --report');
const PHASE = PHASES[0];
if (!args.root) die('Missing --root <folder>');

const ROOT = path.resolve(args.root);
const INCLUDE = new Set((args.include || 'doc').split(',').map((s) => s.trim()).filter(Boolean));
const MAX_SIZE_MB = numOr(args['max-size-mb'], 500);   // Supabase bucket ceiling
const CONCURRENCY = Math.max(1, numOr(args.concurrency, 4));
const LIMIT = numOr(args.limit, Infinity);
const BUDGET_GB = numOr(args['budget-gb'], 10);
const DRY = !!args['dry-run'];

// Ledger lives beside the repo, keyed by the root path — one file per import
// target, so several matter folders can be in flight independently.
const STATE_DIR = path.resolve(__dirname, '..', '.import-state');
const LEDGER = path.join(STATE_DIR, `${slugify(ROOT)}.jsonl`);

// -----------------------------------------------------------------------------
// Ledger — append-only JSONL, replayed into a map (last record per key wins).
// Append-only means a kill -9 mid-write costs at most the final line, and the
// reader tolerates a truncated tail.
// -----------------------------------------------------------------------------
async function loadLedger() {
  const map = new Map();
  let raw;
  try { raw = await fs.readFile(LEDGER, 'utf8'); }
  catch { return map; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); map.set(r.key, r); }
    catch { /* torn final line from an interrupted write — ignore */ }
  }
  return map;
}

let ledgerStream = null;
async function appendLedger(rec) {
  if (!ledgerStream) {
    await fs.mkdir(STATE_DIR, { recursive: true });
    ledgerStream = fsSync.createWriteStream(LEDGER, { flags: 'a' });
  }
  await new Promise((res, rej) =>
    ledgerStream.write(JSON.stringify(rec) + '\n', (e) => (e ? rej(e) : res())));
}

const keyFor = (rel) => crypto.createHash('sha1').update(rel.toLowerCase()).digest('hex').slice(0, 16);

// -----------------------------------------------------------------------------
// Phase: SCAN
// -----------------------------------------------------------------------------
async function phaseScan() {
  if (!args.matter) die('--scan needs --matter <short_code> (the destination matterspace)');
  log(`Scanning ${ROOT}`);
  const existing = await loadLedger();
  let seen = 0, added = 0, skipped = 0;
  const skipReasons = new Map();

  for await (const entry of walk(ROOT)) {
    seen++;
    if (seen % 20000 === 0) log(`  …${seen.toLocaleString()} files walked`);
    const rel = path.relative(ROOT, entry.full);
    const key = keyFor(rel);
    if (existing.has(key)) continue;

    const ext = path.extname(entry.name).toLowerCase();
    const cls = classOf(ext);
    let skip = null;
    if (NOISE_DIR.test(path.sep + rel)) skip = 'noise_path';
    else if (NOISE_FILE.test(entry.name)) skip = 'noise_file';
    else if (!INCLUDE.has(cls)) skip = `class_${cls}_not_included`;
    else if (entry.size === 0) skip = 'zero_bytes';
    else if (entry.size > MAX_SIZE_MB * 1024 * 1024) skip = 'over_size_cap';

    const rec = {
      key, rel, ext, cls,
      size: entry.size,
      cloud: entry.cloud,
      matter: args.matter,
      status: skip ? 'skipped' : 'pending',
      reason: skip || null,
      ts: new Date().toISOString(),
    };
    await appendLedger(rec);
    if (skip) { skipped++; skipReasons.set(skip, (skipReasons.get(skip) || 0) + 1); }
    else added++;
  }

  log(`\nWalked ${seen.toLocaleString()} files.`);
  log(`  queued:  ${added.toLocaleString()}`);
  log(`  skipped: ${skipped.toLocaleString()}`);
  for (const [r, n] of [...skipReasons].sort((a, b) => b[1] - a[1])) {
    log(`     ${r.padEnd(28)} ${n.toLocaleString()}`);
  }
  log(`\nLedger: ${LEDGER}`);
  log('Next: --report to see the hydration picture, then --hydrate, then --run.');
}

// Directory walk that reports OneDrive hydration state and never opens a file.
// FILE_ATTRIBUTE_OFFLINE (0x1000) / RECALL_ON_DATA_ACCESS (0x400000) mark a
// placeholder; Node surfaces both in Stats.attributes on Windows via lstat's
// dev-independent fields, so we read them through the fs constants instead.
async function* walk(dir) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (e) { log(`  ! unreadable: ${dir} (${e.code})`); return; }
  for (const d of entries) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (NOISE_DIR.test(path.sep + path.relative(ROOT, full))) continue;
      yield* walk(full);
    } else if (d.isFile()) {
      let st;
      try { st = await fs.stat(full); }
      catch { continue; }
      yield { full, name: d.name, size: st.size, cloud: isPlaceholder(st) };
    }
  }
}

// Node's fs.Stats does not expose Windows file attributes directly, so we infer
// hydration from the block count: a placeholder reports a logical size with zero
// allocated blocks. Validated against an `attrib`-based scan of the full
// OneDrive tree — 119/120 sampled files agreed.
//
// The one disagreement explains the size floor. NTFS stores a file small enough
// to fit inside its MFT record as *resident* data, which also reports zero
// allocated blocks, so tiny local files look like placeholders. The resident
// ceiling is under 1 KB; a 4 KB floor (one cluster) clears it with room to
// spare. Misjudging a sub-4KB placeholder as local is harmless — reading it
// hydrates in milliseconds, which is exactly what the check exists to avoid
// doing to a 200 MB file.
const RESIDENT_DATA_CEILING = 4096;
function isPlaceholder(st) {
  return st.size > RESIDENT_DATA_CEILING && st.blocks === 0;
}

// -----------------------------------------------------------------------------
// Phase: HYDRATE — pull cloud-only files down, within a disk budget.
// -----------------------------------------------------------------------------
async function phaseHydrate() {
  const ledger = await loadLedger();
  const pending = [...ledger.values()].filter((r) => r.status === 'pending' && r.cloud);
  if (pending.length === 0) return log('Nothing cloud-only left to hydrate.');

  const free = await freeSpaceBytes(ROOT);
  const budget = Math.min(BUDGET_GB * 1024 ** 3, free - 5 * 1024 ** 3); // keep 5GB headroom
  if (budget <= 0) die(`Not enough free disk: ${fmtBytes(free)} available.`);

  const batch = [];
  let bytes = 0;
  for (const r of pending.sort((a, b) => a.size - b.size)) { // small files first — fastest coverage
    if (bytes + r.size > budget) break;
    batch.push(r); bytes += r.size;
  }
  log(`Hydrating ${batch.length.toLocaleString()} files (${fmtBytes(bytes)}) of ${pending.length.toLocaleString()} cloud-only.`);
  log(`Free disk: ${fmtBytes(free)} | budget: ${fmtBytes(budget)}`);
  if (DRY) return log('(--dry-run; nothing pinned)');

  // `attrib +P -U` is the documented Files-On-Demand pin: it marks the file
  // "always keep on this device", which makes OneDrive fetch the content.
  // Downloading is asynchronous, so we pin in chunks and then poll.
  let done = 0;
  for (const group of chunk(batch, 200)) {
    await Promise.all(group.map(async (r) => {
      const full = path.join(ROOT, r.rel);
      try { await execFileP('attrib', ['+P', '-U', full], { windowsHide: true }); }
      catch (e) { log(`  ! pin failed ${r.rel}: ${e.message.slice(0, 80)}`); }
    }));
    done += group.length;
    log(`  pinned ${done.toLocaleString()}/${batch.length.toLocaleString()}`);
  }

  log('\nWaiting for OneDrive to materialize the pinned files…');
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    let still = 0;
    for (const r of batch) {
      try {
        const st = await fs.stat(path.join(ROOT, r.rel));
        if (isPlaceholder(st)) still++;
      } catch { /* vanished — the run phase will record it */ }
    }
    if (still === 0) { log('All pinned files are local.'); break; }
    if (Date.now() > deadline) { log(`Timed out with ${still} still cloud-only — rerun --hydrate later.`); break; }
    log(`  ${still.toLocaleString()} still downloading…`);
    await sleep(15000);
  }

  // Refresh hydration state in the ledger so --run knows what it can read.
  for (const r of batch) {
    try {
      const st = await fs.stat(path.join(ROOT, r.rel));
      if (!isPlaceholder(st)) await appendLedger({ ...r, cloud: false, ts: new Date().toISOString() });
    } catch { /* ignore */ }
  }
  log('Next: --run');
}

// -----------------------------------------------------------------------------
// Phase: RUN — upload + ingest
// -----------------------------------------------------------------------------
async function phaseRun() {
  const { supabase, openaiKey, googleKey } = await connect();
  const ledger = await loadLedger();
  const queue = [...ledger.values()]
    .filter((r) => r.status === 'pending' && !r.cloud)
    .slice(0, LIMIT === Infinity ? undefined : LIMIT);

  const cloudLeft = [...ledger.values()].filter((r) => r.status === 'pending' && r.cloud).length;
  if (queue.length === 0) {
    log('Nothing runnable.');
    if (cloudLeft) log(`${cloudLeft.toLocaleString()} files are still cloud-only — run --hydrate first.`);
    return;
  }
  log(`Ingesting ${queue.length.toLocaleString()} files (concurrency ${CONCURRENCY}).`);
  if (cloudLeft) log(`(${cloudLeft.toLocaleString()} more are cloud-only and skipped this pass.)`);
  if (DRY) { queue.slice(0, 40).forEach((r) => log(`  would ingest: ${r.rel}`)); return log('(--dry-run)'); }

  const matterCache = new Map();
  const dupeCache = new Map();
  const counts = { ok: 0, queued: 0, dupe: 0, error: 0 };
  const errorClasses = new Map();

  await pool(queue, CONCURRENCY, async (r) => {
    const full = path.join(ROOT, r.rel);
    try {
      const matter = await resolveMatterCached(supabase, matterCache, r.matter);
      const dupes = await dupeIndex(supabase, dupeCache, matter.id);

      const stat = await fs.stat(full);
      if (isPlaceholder(stat)) {                // evicted since --scan
        await appendLedger({ ...r, cloud: true, ts: new Date().toISOString() });
        return;
      }
      const name = path.basename(r.rel);
      if (dupes.has(`${name}|${stat.size}`) && !args['allow-dupes']) {
        counts.dupe++;
        await appendLedger({ ...r, status: 'skipped', reason: 'duplicate_in_matter', ts: new Date().toISOString() });
        return;
      }

      const docId = await createAndUpload(supabase, { matter, full, name, ext: r.ext, size: stat.size });
      dupes.add(`${name}|${stat.size}`);

      // Big/slow work goes to the always-on Fly worker; the serverless and CLI
      // paths cannot finish it. Same routing rule the web app uses.
      if (needsWorkerIngest(r.ext, stat.size)) {
        await supabase.from('processing_jobs').insert({
          job_type: 'ingest_document', status: 'queued', payload: { document_id: docId },
        });
        counts.queued++;
        await appendLedger({ ...r, status: 'queued', document_id: docId, ts: new Date().toISOString() });
        return;
      }

      const fileBuf = await fs.readFile(full);
      const { ocr, transcribe } = hooks(googleKey);
      const { passageCount } = await processDocument(supabase, {
        documentId: docId, fileBuf, ext: r.ext, openaiApiKey: openaiKey, ocr, transcribe,
      });
      counts.ok++;
      await appendLedger({ ...r, status: 'done', document_id: docId, passages: passageCount, ts: new Date().toISOString() });
      log(`  ok  ${r.rel} (${passageCount} passages)`);
    } catch (err) {
      counts.error++;
      const cls = classifyError(err.message);
      errorClasses.set(cls, (errorClasses.get(cls) || 0) + 1);
      await appendLedger({ ...r, status: 'error', reason: cls, error: String(err.message).slice(0, 400), ts: new Date().toISOString() });
      log(`  ERR ${r.rel}: ${err.message.slice(0, 140)}`);
    }
  });

  log(`\nDone. ok=${counts.ok} queued=${counts.queued} dupes=${counts.dupe} errors=${counts.error}`);
  if (errorClasses.size) {
    log('\nError classes:');
    for (const [c, n] of [...errorClasses].sort((a, b) => b[1] - a[1])) log(`  ${c.padEnd(28)} ${n}`);
    log('\nRun --report for the recommended action per class.');
  }
}

async function createAndUpload(supabase, { matter, full, name, ext, size }) {
  const { data: docRow, error: docErr } = await supabase
    .from('documents')
    .insert({
      matterspace_id: matter.id,
      title: path.basename(name, path.extname(name)),
      doc_type: 'other',
      source_filename: name,
      file_size_bytes: size,
      processing_status: 'pending',
      created_by: matter.created_by,
    })
    .select('id')
    .single();
  if (docErr) throw new Error(`insert document: ${docErr.message}`);

  const safe = name.replace(/[^\w.\-]+/g, '_');
  const storagePath = `${matter.id}/${docRow.id}/${safe}`;
  const buf = await fs.readFile(full);
  const { error: upErr } = await supabase.storage
    .from('vault-documents')
    .upload(storagePath, buf, { contentType: mimeFor(ext), upsert: true });
  if (upErr) throw new Error(`upload: ${upErr.message}`);
  await supabase.from('documents').update({ storage_path: storagePath }).eq('id', docRow.id);
  return docRow.id;
}

// -----------------------------------------------------------------------------
// Phase: REPORT
// -----------------------------------------------------------------------------
async function phaseReport() {
  const ledger = await loadLedger();
  const all = [...ledger.values()];
  if (!all.length) return log(`No ledger yet at ${LEDGER}. Run --scan first.`);

  const by = (f) => all.reduce((m, r) => (m.set(f(r), (m.get(f(r)) || 0) + 1), m), new Map());
  const bytes = (pred) => all.filter(pred).reduce((s, r) => s + (r.size || 0), 0);

  log(`Ledger: ${LEDGER}`);
  log(`Files tracked: ${all.length.toLocaleString()}  (${fmtBytes(bytes(() => true))})\n`);

  log('STATUS');
  for (const [s, n] of [...by((r) => r.status)].sort((a, b) => b[1] - a[1])) {
    log(`  ${String(s).padEnd(12)} ${String(n).padStart(8)}`);
  }

  const pending = all.filter((r) => r.status === 'pending');
  const cloud = pending.filter((r) => r.cloud);
  log(`\nREADY TO INGEST NOW: ${(pending.length - cloud.length).toLocaleString()} (${fmtBytes(bytes((r) => r.status === 'pending' && !r.cloud))})`);
  log(`STILL CLOUD-ONLY:    ${cloud.length.toLocaleString()} (${fmtBytes(bytes((r) => r.status === 'pending' && r.cloud))}) — needs --hydrate`);

  const skipped = all.filter((r) => r.status === 'skipped');
  if (skipped.length) {
    log('\nSKIPPED');
    const m = skipped.reduce((mm, r) => (mm.set(r.reason, (mm.get(r.reason) || 0) + 1), mm), new Map());
    for (const [r, n] of [...m].sort((a, b) => b[1] - a[1])) log(`  ${String(r).padEnd(28)} ${String(n).padStart(8)}`);
  }

  const errored = all.filter((r) => r.status === 'error');
  if (errored.length) {
    const s = summarize(errored.map((r) => ({ cls: r.reason, error: r.error, name: r.rel })));
    log(`\nERRORS: ${s.total}  (${s.needsHuman} need you, ${s.autoRetryable} clear on re-run)`);
    for (const g of s.groups) {
      log(`\n  [${g.severity}] ${g.label} — ${g.count}`);
      log(`      → ${g.action}`);
      for (const ex of g.examples.slice(0, 3)) log(`      · ${ex.name}`);
    }
  }
}

// -----------------------------------------------------------------------------
// Plumbing
// -----------------------------------------------------------------------------
async function connect() {
  await loadEnv(path.resolve(__dirname, '..', '.env'));
  const url = requireEnv('VITE_SUPABASE_URL');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (/^PASTE_/.test(key)) {
    die('SUPABASE_SERVICE_ROLE_KEY in .env is still the PASTE_NEW_… placeholder.\n' +
        'Get a fresh secret key at https://supabase.com/dashboard/project/glegjwxosocbyquzmtqs/settings/api-keys');
  }
  return {
    supabase: createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }),
    openaiKey: requireEnv('OPENAI_API_KEY'),
    googleKey: process.env.GOOGLE_API_KEY || null,
  };
}

function hooks(googleKey) {
  if (!googleKey) return { ocr: null, transcribe: null };
  return {
    ocr: async (buf) => {
      const { ocrPdf } = await import('../lib/ocr-gemini.mjs');
      return ocrPdf(buf, { apiKey: googleKey });
    },
    transcribe: async (buf, { ext, kind, onProgress }) => {
      const { transcribeMedia } = await import('../lib/transcribe-gemini.mjs');
      return transcribeMedia(buf, { apiKey: googleKey, mimeType: mimeFor(ext), kind, onProgress });
    },
  };
}

async function resolveMatterCached(supabase, cache, code) {
  if (cache.has(code)) return cache.get(code);
  const { data, error } = await supabase
    .from('matterspaces').select('id, name, created_by')
    .or(`short_code.eq.${code},id.eq.${code}`).maybeSingle();
  if (error || !data) throw new Error(`matter not found: ${code}`);
  cache.set(code, data);
  return data;
}

// Existing (filename, size) pairs in the matter, so a rerun after a partial
// import doesn't duplicate. Paginated past PostgREST's 1000-row default.
async function dupeIndex(supabase, cache, matterId) {
  if (cache.has(matterId)) return cache.get(matterId);
  const set = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('documents').select('source_filename, file_size_bytes')
      .eq('matterspace_id', matterId).range(from, from + 999);
    if (error) throw new Error(`dupe index: ${error.message}`);
    for (const d of data) set.add(`${d.source_filename}|${d.file_size_bytes}`);
    if (data.length < 1000) break;
  }
  cache.set(matterId, set);
  return set;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx], idx);
    }
  }));
}

async function freeSpaceBytes(p) {
  try {
    const drive = path.parse(path.resolve(p)).root.replace(/\\$/, '');
    const { stdout } = await execFileP('powershell', ['-NoProfile', '-Command',
      `(Get-PSDrive -Name '${drive[0]}').Free`], { windowsHide: true });
    return parseInt(stdout.trim(), 10) || 0;
  } catch { return Number.MAX_SAFE_INTEGER; }
}

const MIME = {
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.eml': 'message/rfc822', '.msg': 'application/vnd.ms-outlook', '.epub': 'application/epub+zip',
  '.csv': 'text/csv', '.rtf': 'application/rtf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.wma': 'audio/x-ms-wma',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg',
  '.avi': 'video/x-msvideo', '.webm': 'video/webm', '.wmv': 'video/x-ms-wmv', '.m4v': 'video/x-m4v',
};
const mimeFor = (ext) => MIME[ext] || 'application/octet-stream';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[k] = true;
      else { out[k] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

async function loadEnv(file) {
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return; }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = t.slice(i + 1).trim();
  }
}

// Function declarations, not const arrows: the config block at the top of this
// file calls numOr()/slugify() during module evaluation, and only function
// declarations hoist.
function requireEnv(k) { const v = process.env[k]; if (!v) die(`Missing env ${k}`); return v; }
function numOr(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function chunk(a, n) { return Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function slugify(s) { return s.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(-80); }
function fmtBytes(b) { return b > 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`; }
function log(m) { console.log(m); }
function die(m) { console.error(`\n${m}\n`); process.exit(1); }

// -----------------------------------------------------------------------------
await ({ scan: phaseScan, hydrate: phaseHydrate, run: phaseRun, report: phaseReport })[PHASE]();
if (ledgerStream) ledgerStream.end();
