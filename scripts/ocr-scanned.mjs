// OCR scanned, image-only PDFs that failed ingestion with "no passages
// extracted", using Gemini (lib/ocr-gemini.mjs) wired into the shared pipeline
// as processDocument's `ocr` hook.
//
// Dedup: many scanned exhibits are byte-identical duplicates (e.g. an exhibit
// also filed as an inmate-folder part, or the same production scanned twice).
// We OCR each unique file ONCE, then clone the resulting passages onto the
// duplicate rows — no second Gemini OCR, no second embedding pass.
//
// Usage:
//   node scripts/ocr-scanned.mjs --matter fleming --dry-run
//   node scripts/ocr-scanned.mjs --matter fleming --limit 1        (validate one)
//   node scripts/ocr-scanned.mjs --matter fleming                  (full run)
//   node scripts/ocr-scanned.mjs --matter fleming --model gemini-2.5-pro
//
// Env (./.env): VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, GOOGLE_API_KEY

import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processDocument } from '../lib/ingest-core.mjs';
import { ocrPdf } from '../lib/ocr-gemini.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));
const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
const SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const OPENAI_API_KEY = requireEnv('OPENAI_API_KEY');

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const args = parseArgs(process.argv.slice(2));
const DRY = !!args['dry-run'];
// OCR key only needed for a real run; --dry-run just reports dedup stats.
const GOOGLE_API_KEY = DRY ? (process.env.GOOGLE_API_KEY || '') : requireEnv('GOOGLE_API_KEY');
const LIMIT = args.limit ? parseInt(args.limit, 10) : Infinity;
const MODEL = args.model || 'gemini-2.5-flash';
if (!args.matter) die('Missing --matter');

const matter = await resolveMatter(args.matter);
log(`Matter: ${matter.name} (${matter.id})  |  OCR model: ${MODEL}`);

// Scanned candidates: error PDFs whose failure was "no passages extracted".
// --only <substr> (repeatable via comma) targets specific files by filename;
// --max-pages N skips files larger than N pages (defer the giant productions).
const ONLY = args.only ? String(args.only).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean) : null;
const MAX_PAGES = args['max-pages'] ? parseInt(args['max-pages'], 10) : Infinity;
const candidates = (await fetchScanned(matter.id))
  .filter((d) => d.storage_path && /\.pdf$/i.test(d.source_filename || ''))
  .filter((d) => !ONLY || ONLY.some((s) => (d.source_filename || '').toLowerCase().includes(s)))
  .filter((d) => !Number.isFinite(MAX_PAGES) || (d.page_count || 0) <= MAX_PAGES);
log(`Scanned PDF candidates: ${candidates.length}${ONLY ? `  (filtered by --only ${ONLY.join(',')})` : ''}${Number.isFinite(MAX_PAGES) ? `  (--max-pages ${MAX_PAGES})` : ''}`);

// Group by file content hash (download once to hash).
const groups = new Map(); // hash -> { rows:[], buf }
for (const d of candidates) {
  const { data: blob, error } = await supabase.storage.from('vault-documents').download(d.storage_path);
  if (error || !blob) { log(`  ! download failed: ${d.source_filename}`); continue; }
  const buf = Buffer.from(await blob.arrayBuffer());
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  if (!groups.has(hash)) groups.set(hash, { rows: [], buf });
  groups.get(hash).rows.push(d);
}
const uniqueGroups = [...groups.values()];
const dupRows = candidates.length - uniqueGroups.length;
log(`Unique files: ${uniqueGroups.length}  |  byte-identical duplicate rows (cloned, not re-OCR'd): ${dupRows}`);

if (DRY) {
  for (const g of uniqueGroups) {
    log(`  ${String(g.rows[0].page_count || '?').padStart(4)}p  ${g.rows[0].source_filename}${g.rows.length > 1 ? `   (+${g.rows.length - 1} dup)` : ''}`);
  }
  log('\n(--dry-run; nothing changed)');
  process.exit(0);
}

const summary = { ocrOk: 0, pagesOcr: 0, passages: 0, cloned: 0, failed: [] };
let processed = 0;
for (const g of uniqueGroups) {
  if (processed >= LIMIT) break;
  processed++;
  const primary = g.rows[0];
  log(`\n[${processed}/${Math.min(LIMIT, uniqueGroups.length)}] OCR: ${primary.source_filename} (${primary.page_count || '?'}p)`);
  try {
    await resetRow(primary.id);
    const { passageCount } = await processDocument(supabase, {
      documentId: primary.id,
      fileBuf: g.buf,
      ext: '.pdf',
      openaiApiKey: OPENAI_API_KEY,
      ocr: (buf) => ocrPdf(buf, { apiKey: GOOGLE_API_KEY, model: MODEL, onProgress: ({ message }) => process.stdout.write(`    ${message}\r`) }),
    });
    process.stdout.write('\n');
    summary.ocrOk++; summary.passages += passageCount; summary.pagesOcr += (primary.page_count || 0);
    log(`    ✓ ${passageCount} passages`);

    // Clone passages onto byte-identical duplicates.
    for (const dup of g.rows.slice(1)) {
      const n = await clonePassages(primary.id, dup);
      summary.cloned++; summary.passages += n;
      log(`    + clone -> ${dup.source_filename}: ${n} passages`);
    }
  } catch (err) {
    process.stdout.write('\n');
    const msg = (err.message || String(err)).slice(0, 200);
    await supabase.from('documents').update({ processing_status: 'error', processing_error: msg }).eq('id', primary.id);
    summary.failed.push(`${primary.source_filename}: ${msg}`);
    log(`    ✗ ${msg}`);
  }
}

log(`\n=== Done ===`);
log(`  OCR'd: ${summary.ocrOk} files (${summary.pagesOcr} pages)`);
log(`  duplicate rows cloned: ${summary.cloned}`);
log(`  total passages inserted: ${summary.passages}`);
if (summary.failed.length) { log(`  failed: ${summary.failed.length}`); for (const f of summary.failed) log(`     • ${f}`); }

// ---- helpers ---------------------------------------------------------------
async function resetRow(id) {
  await supabase.from('passages').delete().eq('document_id', id);
  await supabase.from('documents').update({ processing_status: 'pending', processing_error: null, ingested_at: null }).eq('id', id);
}

async function clonePassages(fromId, dupRow) {
  await supabase.from('passages').delete().eq('document_id', dupRow.id);
  // page through source passages
  let from = 0, total = 0;
  for (;;) {
    const { data: ps, error } = await supabase.from('passages').select('*').eq('document_id', fromId).order('sequence_number').range(from, from + 499);
    if (error) throw new Error(`clone read: ${error.message}`);
    if (!ps.length) break;
    // Drop the source PK/FK/timestamp AND generated columns (text_length, tsv)
    // — Postgres rejects explicit writes to GENERATED ALWAYS columns.
    const rows = ps.map((p) => { const { id, document_id, created_at, text_length, tsv, ...rest } = p; return { ...rest, document_id: dupRow.id }; });
    const { error: insErr } = await supabase.from('passages').insert(rows);
    if (insErr) throw new Error(`clone insert: ${insErr.message}`);
    total += rows.length;
    if (ps.length < 500) break;
    from += 500;
  }
  const { data: src } = await supabase.from('documents').select('page_count').eq('id', fromId).single();
  await supabase.from('documents').update({ processing_status: 'ready', processing_error: null, page_count: src?.page_count ?? null, ingested_at: new Date().toISOString() }).eq('id', dupRow.id);
  return total;
}

async function fetchScanned(matterId) {
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await supabase.from('documents')
      .select('id, source_filename, storage_path, page_count, processing_error')
      .eq('matterspace_id', matterId).eq('processing_status', 'error')
      // "no passages extracted" = the scanned-PDF signature; the other two are
      // post-OCR failures from a prior run (insert timeout / clone bug) so a
      // re-run with fixed code re-picks them. The .pdf filename filter below
      // keeps A/V and other binaries out.
      .or('processing_error.ilike.no passages extracted%,processing_error.ilike.insert passages:%,processing_error.ilike.clone insert:%')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    all = all.concat(data);
    if (data.length < 1000) break; from += 1000;
  }
  return all;
}

async function resolveMatter(key) {
  const isUuid = /^[0-9a-f-]{36}$/i.test(key);
  const { data, error } = await supabase.from('matterspaces').select('id, name, short_code').eq(isUuid ? 'id' : 'short_code', key).maybeSingle();
  if (error || !data) die(`matter '${key}': ${error?.message ?? 'not found'}`);
  return data;
}
function parseArgs(argv) { const out = { _: [] }; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2), v = argv[i + 1]; if (v && !v.startsWith('--')) { out[k] = v; i++; } else out[k] = true; } else out._.push(a); } return out; }
async function loadEnv(file) { try { const t = await fs.readFile(file, 'utf8'); for (const line of t.split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2]; if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v; } } catch {} }
function requireEnv(n) { const v = process.env[n]; if (!v) die(`Missing env ${n}`); return v; }
function log(...a) { console.log(...a); }
function die(m) { console.error(m); process.exit(1); }
