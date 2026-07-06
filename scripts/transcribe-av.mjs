// Transcribe audio/video evidence that failed ingestion (or was stored without
// a transcript), using Gemini (lib/transcribe-gemini.mjs) wired into the shared
// pipeline as processDocument's `transcribe` hook.
//
// Gemini accepts wav/mp3/flac/ogg/aac/aiff audio and mp4/mov/mpg/webm/wmv video
// natively. Formats it won't take (.wma) — and .m4a, which is unreliable — are
// transcoded to 16 kHz mono mp3 with ffmpeg first (speech-optimized, small).
//
// Dedup: many A/V files are byte-identical duplicates across sub-matters. We
// transcribe each unique file ONCE and clone the resulting passages onto the
// duplicate rows — no second Gemini call, no second embedding pass.
//
// Usage:
//   node scripts/transcribe-av.mjs --matter atkinson --dry-run
//   node scripts/transcribe-av.mjs --matter atkinson --limit 1      (validate one)
//   node scripts/transcribe-av.mjs --matter atkinson                (full run)
//   node scripts/transcribe-av.mjs --matter atkinson --only 911     (filter by filename)
//
// Env (./.env): VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, GOOGLE_API_KEY

import { createClient } from '@supabase/supabase-js';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processDocument, AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, MEDIA_EXTENSIONS } from '../lib/ingest-core.mjs';
import { transcribeMedia, mimeForMediaExt } from '../lib/transcribe-gemini.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));
const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
const SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const OPENAI_API_KEY = requireEnv('OPENAI_API_KEY');

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const args = parseArgs(process.argv.slice(2));
const DRY = !!args['dry-run'];
const GOOGLE_API_KEY = DRY ? (process.env.GOOGLE_API_KEY || '') : requireEnv('GOOGLE_API_KEY');
const LIMIT = args.limit ? parseInt(args.limit, 10) : Infinity;
const MODEL = args.model || 'gemini-2.5-flash';
const ONLY = args.only ? String(args.only).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean) : null;
if (!args.matter) die('Missing --matter');

// Formats Gemini takes as-is; everything else in MEDIA_EXTENSIONS is transcoded.
const NATIVE_OK = new Set(['.mp3', '.wav', '.flac', '.ogg', '.aac', '.aiff', ...VIDEO_EXTENSIONS]);
const extOf = (n) => path.extname(n || '').toLowerCase();

const matter = await resolveMatter(args.matter);
log(`Matter: ${matter.name} (${matter.id})  |  model: ${MODEL}`);

// Candidates: A/V docs in the matter that don't already have passages (covers
// 'error' rows AND store-and-display 'ready' rows with 0 passages).
const candidates = (await fetchMedia(matter.id))
  .filter((d) => d.storage_path && MEDIA_EXTENSIONS.includes(extOf(d.source_filename)))
  .filter((d) => !ONLY || ONLY.some((s) => (d.source_filename || '').toLowerCase().includes(s)));
log(`A/V candidates without transcript: ${candidates.length}${ONLY ? `  (--only ${ONLY.join(',')})` : ''}`);

// Group by content hash (download once to hash + reuse buffer).
const groups = new Map();
for (const d of candidates) {
  const { data: blob, error } = await supabase.storage.from('vault-documents').download(d.storage_path);
  if (error || !blob) { log(`  ! download failed: ${d.source_filename}`); continue; }
  const buf = Buffer.from(await blob.arrayBuffer());
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  if (!groups.has(hash)) groups.set(hash, { rows: [], buf });
  groups.get(hash).rows.push(d);
}
const uniqueGroups = [...groups.values()];
log(`Unique files: ${uniqueGroups.length}  |  duplicate rows (cloned, not re-transcribed): ${candidates.length - uniqueGroups.length}`);

if (DRY) {
  for (const g of uniqueGroups) {
    const ext = extOf(g.rows[0].source_filename);
    const kind = VIDEO_EXTENSIONS.includes(ext) ? 'video' : 'audio';
    const route = NATIVE_OK.has(ext) ? 'native' : 'transcode->mp3';
    log(`  ${(g.buf.length / 1e6).toFixed(1).padStart(6)}MB  ${kind}/${route}  ${g.rows[0].source_filename}${g.rows.length > 1 ? `  (+${g.rows.length - 1} dup)` : ''}`);
  }
  log('\n(--dry-run; nothing changed)');
  process.exit(0);
}

const summary = { ok: 0, passages: 0, cloned: 0, failed: [] };
let processed = 0;
for (const g of uniqueGroups) {
  if (processed >= LIMIT) break;
  processed++;
  const primary = g.rows[0];
  const origExt = extOf(primary.source_filename);
  const kind = VIDEO_EXTENSIONS.includes(origExt) ? 'video' : 'audio';
  log(`\n[${processed}/${Math.min(LIMIT, uniqueGroups.length)}] ${kind}: ${primary.source_filename} (${(g.buf.length / 1e6).toFixed(1)}MB)`);
  try {
    // Normalize the format Gemini will receive.
    let sendBuf = g.buf;
    let sendExt = origExt;
    if (!NATIVE_OK.has(origExt)) {
      log(`    transcoding ${origExt} -> mp3 (ffmpeg)`);
      sendBuf = await transcodeToMp3(g.buf, origExt);
      sendExt = '.mp3';
      log(`    transcoded: ${(sendBuf.length / 1e6).toFixed(1)}MB`);
    }

    await resetRow(primary.id);
    const { passageCount } = await processDocument(supabase, {
      documentId: primary.id,
      fileBuf: sendBuf,
      ext: sendExt,
      openaiApiKey: OPENAI_API_KEY,
      transcribe: (buf, { ext, kind: k, onProgress }) =>
        transcribeMedia(buf, {
          apiKey: GOOGLE_API_KEY,
          mimeType: mimeForMediaExt(ext),
          kind: k,
          model: MODEL,
          displayName: primary.source_filename,
          onProgress: ({ message }) => process.stdout.write(`    ${message}\r`),
        }),
    });
    process.stdout.write('\n');
    summary.ok++; summary.passages += passageCount;
    log(`    ✓ ${passageCount} transcript passages`);

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
log(`  transcribed: ${summary.ok} files  |  duplicate rows cloned: ${summary.cloned}  |  passages: ${summary.passages}`);
if (summary.failed.length) { log(`  failed: ${summary.failed.length}`); for (const f of summary.failed) log(`     • ${f}`); }

// ---- helpers ---------------------------------------------------------------
function transcodeToMp3(buf, ext) {
  return new Promise(async (resolve, reject) => {
    const tmp = os.tmpdir();
    const tag = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
    const inPath = path.join(tmp, `av_${tag}${ext}`);
    const outPath = path.join(tmp, `av_${tag}.mp3`);
    try {
      await fs.writeFile(inPath, buf);
      // -vn drop video, 16kHz mono 64k mp3: speech-grade, ~10x smaller.
      const ff = spawn('ffmpeg', ['-y', '-i', inPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '64k', outPath], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      ff.stderr.on('data', (d) => { err += d.toString(); });
      ff.on('error', reject);
      ff.on('close', async (code) => {
        try {
          if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${err.slice(-200)}`));
          const out = await fs.readFile(outPath);
          resolve(out);
        } catch (e) { reject(e); }
        finally { fs.unlink(inPath).catch(() => {}); fs.unlink(outPath).catch(() => {}); }
      });
    } catch (e) { reject(e); }
  });
}

async function resetRow(id) {
  await supabase.from('passages').delete().eq('document_id', id);
  await supabase.from('documents').update({ processing_status: 'pending', processing_error: null, ingested_at: null }).eq('id', id);
}

async function clonePassages(fromId, dupRow) {
  await supabase.from('passages').delete().eq('document_id', dupRow.id);
  let from = 0, total = 0;
  for (;;) {
    const { data: ps, error } = await supabase.from('passages').select('*').eq('document_id', fromId).order('sequence_number').range(from, from + 499);
    if (error) throw new Error(`clone read: ${error.message}`);
    if (!ps.length) break;
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

async function fetchMedia(matterId) {
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await supabase.from('documents')
      .select('id, source_filename, storage_path, processing_status, processing_error, passages(count)')
      .eq('matterspace_id', matterId)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    all = all.concat(data);
    if (data.length < 1000) break; from += 1000;
  }
  // keep only rows with no passages yet
  return all.filter((d) => {
    const cnt = Array.isArray(d.passages) ? (d.passages[0]?.count ?? 0) : 0;
    return cnt === 0;
  });
}

async function resolveMatter(key) {
  const isUuid = /^[0-9a-f-]{36}$/i.test(key);
  const { data, error } = await supabase.from('matterspaces').select('id, name, short_code').eq(isUuid ? 'id' : 'short_code', key).maybeSingle();
  if (error || !data) die(`matter '${key}': ${error?.message ?? 'not found'}`);
  return data;
}
function parseArgs(argv) { const out = { _: [] }; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2), v = argv[i + 1]; if (v && !v.startsWith('--')) { out[k] = v; i++; } else out[k] = true; } else out._.push(a); } return out; }
async function loadEnv(file) { try { const t = await fs.readFile(file, 'utf8'); for (const line of t.split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2]; if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v.trim(); } } catch {} }
function requireEnv(n) { const v = process.env[n]; if (!v) die(`Missing env ${n}`); return v; }
function log(...a) { console.log(...a); }
function die(m) { console.error(m); process.exit(1); }
