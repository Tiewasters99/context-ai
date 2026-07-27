// Re-ingest one or more documents already stored in Vault.
//
// Use this after a fix to the extraction or chunking pipeline (e.g. the
// per-page PDF extraction fix on 2026-05-29 that resolved the "every
// passage cites p. 1" bug for depositions): the file is already in
// Supabase Storage, but its passages were built with the old pipeline.
// This script:
//   1. Resets the document row's processing_status to 'pending'.
//   2. Deletes all existing passages for the document.
//   3. Re-downloads the original blob from vault-documents storage.
//   4. Runs processDocument() with the current (fixed) ingest-core logic.
//
// Usage:
//   node scripts/reingest.mjs <document_id> [<document_id> ...]
//   node scripts/reingest.mjs --matter <short_code>          (all docs in matter)
//   node scripts/reingest.mjs --matter <short_code> --ext .jpg,.jpeg,.png
//                                    (only docs whose filename has these extensions)
//
// Required env (read from ./.env):
//   VITE_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   OPENAI_API_KEY
// Optional env:
//   GOOGLE_API_KEY — wires the Gemini OCR + transcription hooks, exactly like
//   the production entry points. Without it, scanned PDFs/images re-ingest to
//   zero passages and A/V loses its transcript — so it's near-mandatory.

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
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null;
if (!GOOGLE_API_KEY) log('WARNING: no GOOGLE_API_KEY — OCR/transcription hooks disabled for this run.');

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const args = parseArgs(process.argv.slice(2));
const docIds = await resolveDocIds(args);
if (docIds.length === 0) die('No documents to re-ingest. Pass document ids or --matter <short_code>.');

log(`Re-ingesting ${docIds.length} document${docIds.length === 1 ? '' : 's'}…`);
let totalPassages = 0;
for (const id of docIds) {
  try {
    totalPassages += await reingestOne(id);
  } catch (err) {
    log(`ERROR ${id}: ${err.message}`);
  }
}
log(`\nDone. ${totalPassages} passages re-inserted across ${docIds.length} document(s).`);


async function reingestOne(documentId) {
  const { data: doc, error } = await supabase
    .from('documents')
    .select('id, title, source_filename, storage_path')
    .eq('id', documentId)
    .single();
  if (error) throw new Error(`lookup: ${error.message}`);
  if (!doc.storage_path) throw new Error('no storage_path on row — nothing to re-ingest from');

  const label = doc.title || doc.source_filename || doc.id;
  log(`\n[${label}]`);
  log(`  storage_path: ${doc.storage_path}`);

  const { data: blob, error: dlErr } = await supabase.storage
    .from('vault-documents')
    .download(doc.storage_path);
  if (dlErr || !blob) throw new Error(`download: ${dlErr?.message ?? 'no blob'}`);

  const fileBuf = Buffer.from(await blob.arrayBuffer());
  const ext = path.extname(doc.source_filename || doc.storage_path).toLowerCase();
  log(`  ext: ${ext}, bytes: ${fileBuf.length.toLocaleString()}`);

  // Wipe the old passages and reset the row so processDocument can run cleanly.
  await supabase.from('passages').delete().eq('document_id', documentId);
  await supabase
    .from('documents')
    .update({
      processing_status: 'pending',
      processing_error: null,
      ingested_at: null,
    })
    .eq('id', documentId);

  // Same Gemini hooks the production entry points wire, so a re-ingest can
  // never produce less than the original ingest did.
  let ocr;
  let transcribe;
  if (GOOGLE_API_KEY) {
    const { ocrPdf } = await import('../lib/ocr-gemini.mjs');
    ocr = (buf) => ocrPdf(buf, { apiKey: GOOGLE_API_KEY });
    const { transcribeMedia, mimeForMediaExt } = await import('../lib/transcribe-gemini.mjs');
    transcribe = (buf, { ext: mediaExt, kind, onProgress }) => {
      const mimeType = mimeForMediaExt(mediaExt);
      if (!mimeType) throw new Error(`no Gemini mime for ${mediaExt} — use scripts/transcribe-av.mjs (ffmpeg)`);
      return transcribeMedia(buf, { apiKey: GOOGLE_API_KEY, mimeType, kind, onProgress });
    };
  }

  const result = await processDocument(supabase, {
    documentId,
    fileBuf,
    ext,
    openaiApiKey: OPENAI_API_KEY,
    ocr,
    transcribe,
    onProgress: ({ stage, message }) => log(`  ${stage}: ${message}`),
  });
  log(`  ✓ ${result.passageCount} passages`);
  return result.passageCount;
}


async function resolveDocIds(args) {
  if (args.matter) {
    // Comparing a non-UUID string against the uuid `id` column 400s the whole
    // .or() query, so pick the column by shape instead.
    const col = /^[0-9a-f-]{36}$/i.test(args.matter) ? 'id' : 'short_code';
    const { data: m, error: mErr } = await supabase
      .from('matterspaces')
      .select('id')
      .eq(col, args.matter)
      .maybeSingle();
    if (mErr || !m) throw new Error(`matter lookup: ${mErr?.message ?? 'not found'}`);
    const { data: docs, error: dErr } = await supabase
      .from('documents')
      .select('id, source_filename')
      .eq('matterspace_id', m.id);
    if (dErr) throw new Error(`docs lookup: ${dErr.message}`);
    let picked = docs;
    if (args.ext) {
      const wanted = String(args.ext).split(',').map((e) => e.trim().toLowerCase())
        .map((e) => (e.startsWith('.') ? e : `.${e}`));
      picked = docs.filter((d) => wanted.includes(path.extname(d.source_filename || '').toLowerCase()));
    }
    return picked.map((d) => d.id);
  }
  return args._;
}


// -----------------------------------------------------------------------------
// Tiny CLI utils — mirror scripts/ingest.mjs so the two scripts feel familiar.
// -----------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) { out[k] = v; i++; }
      else { out[k] = true; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) die(`Missing env var ${name}`);
  return v;
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
  } catch { /* .env optional */ }
}

function log(...a) { console.log(...a); }
function die(msg) { console.error(msg); process.exit(1); }
