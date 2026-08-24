// Prove the TIFF OCR path on real files from the vault (2026-08-22 ingestion
// audit, fix 4).
//
// Downloads a sample of the stored .tif documents, runs them through
// lib/ingest-core.mjs's own imageToPdf() — the function the pipeline calls —
// and reports what came out: how many TIFF pages sharp found, how many PDF
// pages were produced, and how big the intermediate PDF is.
//
// With --ocr it also sends the sample to Gemini and prints the first lines of
// the transcription, which is the only way to know the Bates numbers actually
// come back. That is billable, so it is opt-in and capped: ~$0.002 a page.
//
//   node scripts/_test-tiff-ocr.mjs                    # 5 files, transcode only, free
//   node scripts/_test-tiff-ocr.mjs --limit 3 --ocr    # 3 files, real OCR, ~$0.006
//   node scripts/_test-tiff-ocr.mjs --matter decamara --ocr
//
// Reads documents + storage. Writes nothing anywhere.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SB = env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE = env.GOOGLE_API_KEY;
if (!SB || !KEY) { console.error('VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env'); process.exit(2); }

const args = { limit: 5, ocr: false, matter: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--limit') args.limit = Number(process.argv[++i]);
  else if (a === '--ocr') args.ocr = true;
  else if (a === '--matter') args.matter = process.argv[++i];
  else if (a === '--help') { console.log('usage: _test-tiff-ocr.mjs [--limit N] [--ocr] [--matter name]'); process.exit(0); }
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const rest = async (p) => {
  const r = await fetch(`${SB}/rest/v1/${p}`, { headers: H });
  if (!r.ok) throw new Error(`${p} → ${r.status} ${await r.text()}`);
  return r.json();
};

// ---------------------------------------------------------------------------
let filter = '';
if (args.matter) {
  const ms = await rest(`matterspaces?select=id,name&name=ilike.*${encodeURIComponent(args.matter)}*`);
  if (!ms.length) { console.error(`no matterspace matching "${args.matter}"`); process.exit(2); }
  filter = `&matterspace_id=in.(${ms.map((m) => m.id).join(',')})`;
  console.log(`matter filter: ${ms.map((m) => m.name).join(', ')}`);
}
const docs = await rest(
  `documents?select=id,source_filename,file_size_bytes,storage_path,page_count,processing_status` +
  `&or=(source_filename.ilike.*.tif,source_filename.ilike.*.tiff)${filter}` +
  `&storage_path=not.is.null&order=file_size_bytes.desc&limit=${args.limit}`
);
console.log(`\nSampling ${docs.length} TIFF document(s), largest first.\n`);

const { default: sharp } = await import('sharp');
const { PDFDocument } = await import('pdf-lib');
const { imageToPdf } = await import('../lib/ingest-core.mjs');

let totalPages = 0;
for (const d of docs) {
  const sres = await fetch(`${SB}/storage/v1/object/vault-documents/${d.storage_path}`, { headers: H });
  if (!sres.ok) { console.log(`  ${d.source_filename}: download failed ${sres.status}`); continue; }
  const buf = Buffer.from(await sres.arrayBuffer());

  let meta;
  try { meta = await sharp(buf).metadata(); }
  catch (e) { console.log(`  ${d.source_filename}: sharp cannot decode — ${e.message}`); continue; }

  const t0 = Date.now();
  let pdf;
  try { pdf = await imageToPdf(buf, '.tif'); }
  catch (e) { console.log(`  ${d.source_filename}: imageToPdf failed — ${e.message}`); continue; }
  const ms = Date.now() - t0;
  const pdfPages = (await PDFDocument.load(pdf)).getPageCount();
  totalPages += pdfPages;

  console.log(`  ${d.source_filename}`);
  console.log(`     source     ${(buf.length / 1024).toFixed(0)} KB  ${meta.width}x${meta.height}  ${meta.compression || '?'}  ${meta.space}  tiff pages=${meta.pages ?? 1}`);
  console.log(`     → pdf      ${(pdf.length / 1024).toFixed(0)} KB  ${pdfPages} page(s)  in ${ms} ms`);
  console.log(`     db says    page_count=${d.page_count ?? 'null'}  status=${d.processing_status}`);

  if (args.ocr) {
    if (!GOOGLE) { console.log('     OCR        skipped — no GOOGLE_API_KEY'); continue; }
    const { ocrPdf } = await import('../lib/ocr-gemini.mjs');
    const t1 = Date.now();
    try {
      const pages = await ocrPdf(pdf, { apiKey: GOOGLE });
      const chars = pages.reduce((s, p) => s + (p.text || '').trim().length, 0);
      console.log(`     OCR        ${pages.length} page(s), ${chars} chars in ${Date.now() - t1} ms  ${chars >= 40 ? '→ WOULD INDEX' : '→ below the 40-char floor, store-and-display'}`);
      const first = (pages[0]?.text || '').trim().split('\n').slice(0, 6);
      for (const line of first) console.log(`       | ${line.slice(0, 96)}`);
    } catch (e) {
      console.log(`     OCR        FAILED — ${e.message}`);
    }
  }
  console.log('');
}
console.log(`${totalPages} PDF page(s) produced from ${docs.length} file(s).`);
if (!args.ocr) console.log('Transcode only — nothing was sent to Gemini. Add --ocr to test the full path.');
