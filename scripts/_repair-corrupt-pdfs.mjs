// Repair PDFs the ingest parser rejected ("bad XRef entry", "Command token too
// long", "Invalid PDF structure", "stream must have data", "Illegal
// character") and re-run the shared ingest pipeline on them.
//
// Since 2026-09-07 the pipeline itself reads a rejected file four ways before
// giving up — pdf-parse twice (its first call in a fresh process fails on
// some files and the second succeeds), modern pdfjs, then the bytes rewritten
// through pdf-lib (see extractPdfPages in lib/ingest-core.mjs) — so most rows
// on this list succeed on a plain re-run of the ORIGINAL bytes. Step 1 tries
// exactly that. Only a file every parser rejects is rewritten through PyMuPDF
// (a tolerant parser): text-preserving when it finds a text layer, rasterized
// to images (then OCR'd by the pipeline's own hook) when it finds none.
// Storage originals are never touched; passages are rebuilt.
//
// Usage:
//   node scripts/_repair-corrupt-pdfs.mjs --matter <short_code> [--dry-run]
//   node scripts/_repair-corrupt-pdfs.mjs --all [--dry-run]
//   node scripts/_repair-corrupt-pdfs.mjs --ids <id,id,...> [--dry-run]
// --dry-run downloads each candidate and reports which step would apply.
// Needs python + PyMuPDF (`pip install pymupdf`) only for the fallback step.
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processDocument, extractPages, isPdfStructureError } from '../lib/ingest-core.mjs';
import { makeOcrProvider } from '../lib/ocr-routes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const txt = await fs.readFile(path.resolve(__dirname, '..', '.env'), 'utf8');
for (const line of txt.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]] : []).filter((x) => x.length));
const DRY = !!args['dry-run'];
if (!args.matter && !args.all && !args.ids) { console.error('Give --matter <short_code>, --all, or --ids <id,id>'); process.exit(1); }

const PATTERNS = ['bad XRef', 'Command token too long', 'stream must have data', 'Invalid PDF structure', 'Illegal character'];
let q = supabase.from('documents')
  .select('id, matterspace_id, source_filename, storage_path, processing_error, file_size_bytes, matterspaces!inner(short_code)')
  .eq('processing_status', 'error');
if (args.ids) q = q.in('id', String(args.ids).split(',').map((s) => s.trim()).filter(Boolean));
else q = q.or(PATTERNS.map((p) => `processing_error.ilike.%${p}%`).join(','));
if (args.matter) {
  const { data: matter } = await supabase.from('matterspaces').select('id, name').eq('short_code', args.matter).maybeSingle();
  if (!matter) { console.error('matter not found'); process.exit(1); }
  console.log(`Matter: ${matter.name} (${matter.id})`);
  q = q.eq('matterspace_id', matter.id);
}
const { data: docs, error: qErr } = await q.order('created_at');
if (qErr) { console.error(qErr.message); process.exit(2); }
console.log(`Candidates: ${docs.length}${DRY ? ' (dry run — nothing is written)' : ''}`);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-repair-'));
const ocr = makeOcrProvider(process.env);
let ok = 0; const failed = [];
for (const d of docs) {
  const code = d.matterspaces?.short_code || '?';
  process.stdout.write(`\n${code}  ${d.source_filename}  (${d.file_size_bytes} B) — was: ${(d.processing_error || '').slice(0, 50)}\n`);
  try {
    if (!d.storage_path) throw new Error('no storage_path (nothing was uploaded)');
    const { data: blob, error: dlErr } = await supabase.storage.from('vault-documents').download(d.storage_path);
    if (dlErr || !blob) throw new Error(`download: ${dlErr?.message ?? 'no blob'}`);
    const original = Buffer.from(await blob.arrayBuffer());

    // Step 1: does the CURRENT pipeline read the original bytes?
    let plan; let bytes = original;
    try {
      const pages = await extractPages(original, '.pdf');
      const chars = pages.reduce((n, p) => n + (p.text || '').trim().length, 0);
      plan = `re-run original (pipeline reads it: ${pages.length} page(s), ${chars} chars${chars < 20 ? ' → the OCR hook will read the pages' : ''})`;
    } catch (err) {
      if (!isPdfStructureError(err)) throw err;
      // Step 2: PyMuPDF. Text layer present → clean rewrite; none → rasterize.
      const inFile = path.join(tmp, `${d.id}.in.pdf`);
      const outFile = path.join(tmp, `${d.id}.out.pdf`);
      await fs.writeFile(inFile, original);
      const verdict = execFileSync('python', ['-c', `
import fitz, sys
src = fitz.open(sys.argv[1])
chars = sum(len(p.get_text().strip()) for p in src)
if chars >= 20:
    src.save(sys.argv[2], garbage=4, deflate=True, clean=True)
    print(f"text pages={src.page_count} chars={chars}")
else:
    out = fitz.open()
    for page in src:
        pix = page.get_pixmap(dpi=200)
        p = out.new_page(width=page.rect.width, height=page.rect.height)
        p.insert_image(p.rect, pixmap=pix)
    out.save(sys.argv[2], garbage=4, deflate=True)
    print(f"raster pages={src.page_count}")
`, inFile, outFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      bytes = await fs.readFile(outFile);
      plan = `PyMuPDF ${verdict} (${bytes.length} B) after pdf-parse/pdfjs/pdf-lib all refused: ${err.message.slice(0, 40)}`;
    }
    console.log(`  plan: ${plan}`);
    if (DRY) continue;

    await supabase.from('passages').delete().eq('document_id', d.id);
    await supabase.from('documents').update({ processing_status: 'pending', processing_error: null, ingested_at: null }).eq('id', d.id);
    const { passageCount, textStatus } = await processDocument(supabase, {
      documentId: d.id, fileBuf: bytes, ext: '.pdf', openaiApiKey: OPENAI_API_KEY, ocr,
      onProgress: ({ message }) => process.stdout.write(`    ${message}\r`),
    });
    console.log(`  ✓ ${passageCount} passage(s)${textStatus ? `, text_status=${textStatus}` : ''}`);
    ok++;
  } catch (err) {
    const msg = (err.message || String(err)).slice(0, 300);
    if (!DRY) await supabase.from('documents').update({ processing_status: 'error', processing_error: msg }).eq('id', d.id);
    failed.push(`${d.source_filename}: ${msg}`);
    console.log(`  ✗ ${msg}`);
  }
}
if (!DRY) {
  console.log(`\n=== Done: ${ok}/${docs.length} repaired ===`);
  for (const f of failed) console.log(`  failed • ${f}`);
}
