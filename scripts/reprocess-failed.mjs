// Reprocess documents stuck in processing_status='error', re-running the
// (now hardened) ingest pipeline against the file already in Vault storage.
//
// Targets only file types the text pipeline can actually handle — pdf, txt,
// md, docx, epub, fountain. Audio/video/binary are skipped (they belong in the
// deferred A/V pipeline, not the text index). Scanned image-only PDFs that have
// no text layer will fail again with "no passages extracted"; those need OCR
// (handled separately) and are reported at the end.
//
// Usage:
//   node scripts/reprocess-failed.mjs --matter fleming --dry-run
//   node scripts/reprocess-failed.mjs --matter fleming --limit 3
//   node scripts/reprocess-failed.mjs --matter fleming
//   node scripts/reprocess-failed.mjs --matter fleming --concurrency 3
//
// Required env (./.env): VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processDocument } from '../lib/ingest-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));

const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
const SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const OPENAI_API_KEY = requireEnv('OPENAI_API_KEY');

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// File types the current text pipeline understands.
const TEXT_EXTS = new Set(['.pdf', '.txt', '.md', '.docx', '.epub', '.fountain']);

const args = parseArgs(process.argv.slice(2));
const DRY = !!args['dry-run'];
const LIMIT = args.limit ? parseInt(args.limit, 10) : Infinity;
const CONCURRENCY = args.concurrency ? Math.max(1, parseInt(args.concurrency, 10)) : 2;
if (!args.matter) die('Missing --matter <short_code_or_uuid>');

const matter = await resolveMatter(args.matter);
log(`Matter: ${matter.name} (${matter.id})`);

// All error docs in the matter (paginated past the 1000-row cap).
const errored = await fetchAllErrored(matter.id);
const extOf = (n) => path.extname(n || '').toLowerCase();
const targets = errored.filter((d) => d.storage_path && TEXT_EXTS.has(extOf(d.source_filename))).slice(0, LIMIT);
const skipped = errored.length - errored.filter((d) => TEXT_EXTS.has(extOf(d.source_filename))).length;

log(`Errored docs: ${errored.length}  |  text-pipeline targets: ${targets.length}  |  non-text skipped: ${skipped}`);
if (DRY) {
  for (const d of targets) log(`  would reprocess: ${d.source_filename}`);
  log('\n(--dry-run; nothing changed)');
  process.exit(0);
}
if (targets.length === 0) { log('Nothing to reprocess.'); process.exit(0); }

const results = { ok: 0, passages: 0, stillNoText: [], stillError: [] };
let idx = 0;
async function worker() {
  while (idx < targets.length) {
    const d = targets[idx++];
    const n = idx;
    try {
      const passages = await reprocessOne(d);
      results.ok++;
      results.passages += passages;
      log(`  [${n}/${targets.length}] ✓ ${d.source_filename} — ${passages} passages`);
    } catch (err) {
      const msg = err.message || String(err);
      // processDocument leaves the row mid-pipeline (e.g. 'embedding') when an
      // embed call throws; mark it terminally 'error' so a later pass can find
      // it again and it doesn't sit in limbo.
      await supabase.from('documents')
        .update({ processing_status: 'error', processing_error: msg.slice(0, 500) })
        .eq('id', d.id);
      if (/no passages extracted/i.test(msg)) results.stillNoText.push(d.source_filename);
      else results.stillError.push(`${d.source_filename}: ${msg.slice(0, 120)}`);
      log(`  [${n}/${targets.length}] ✗ ${d.source_filename} — ${msg.slice(0, 120)}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

log(`\n=== Done ===`);
log(`  recovered: ${results.ok} docs, ${results.passages} passages`);
log(`  still "no passages" (likely scanned — need OCR): ${results.stillNoText.length}`);
for (const f of results.stillNoText) log(`     • ${f}`);
if (results.stillError.length) {
  log(`  other errors: ${results.stillError.length}`);
  for (const e of results.stillError) log(`     • ${e}`);
}

async function reprocessOne(doc) {
  const { data: blob, error: dlErr } = await supabase.storage
    .from('vault-documents')
    .download(doc.storage_path);
  if (dlErr || !blob) throw new Error(`download: ${dlErr?.message ?? 'no blob'}`);
  const fileBuf = Buffer.from(await blob.arrayBuffer());
  const ext = extOf(doc.source_filename) || extOf(doc.storage_path);

  await supabase.from('passages').delete().eq('document_id', doc.id);
  await supabase.from('documents')
    .update({ processing_status: 'pending', processing_error: null, ingested_at: null })
    .eq('id', doc.id);

  const { passageCount } = await processDocument(supabase, {
    documentId: doc.id,
    fileBuf,
    ext,
    openaiApiKey: OPENAI_API_KEY,
  });
  return passageCount;
}

async function fetchAllErrored(matterId) {
  let all = []; let from = 0;
  for (;;) {
    // Include docs stuck mid-pipeline, not just terminal 'error' — a crashed or
    // rate-limited run can leave rows in extracting/chunking/embedding/pending.
    const { data, error } = await supabase
      .from('documents')
      .select('id, source_filename, storage_path')
      .eq('matterspace_id', matterId)
      .in('processing_status', ['error', 'pending', 'extracting', 'chunking', 'embedding'])
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function resolveMatter(key) {
  const isUuid = /^[0-9a-f-]{36}$/i.test(key);
  const { data, error } = await supabase
    .from('matterspaces')
    .select('id, name, short_code')
    .eq(isUuid ? 'id' : 'short_code', key)
    .maybeSingle();
  if (error || !data) die(`matter lookup failed for '${key}': ${error?.message ?? 'not found'}`);
  return data;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2); const v = argv[i + 1];
      if (v && !v.startsWith('--')) { out[k] = v; i++; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}
async function loadEnv(file) {
  try {
    const txt = await fs.readFile(file, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2];
      if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = val;
    }
  } catch {}
}
function requireEnv(n) { const v = process.env[n]; if (!v) die(`Missing env ${n}`); return v; }
function log(...a) { console.log(...a); }
function die(m) { console.error(m); process.exit(1); }
