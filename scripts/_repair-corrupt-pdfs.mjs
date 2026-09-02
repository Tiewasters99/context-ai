// One-off: repair structurally-corrupt PDFs that crash text extraction
// ("bad XRef entry", "Command token too long", "stream must have data"),
// then re-run the shared ingest pipeline (with the Gemini OCR fallback for
// image-only files) on the repaired bytes.
//
// Repair = round-trip through PyMuPDF (tolerant parser) with garbage
// collection, via a temp dir. Storage originals are left untouched.
//
// Usage: node scripts/_repair-corrupt-pdfs.mjs --matter full-docket [--dry-run]
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processDocument } from '../lib/ingest-core.mjs';
import { ocrPdf } from '../lib/ocr-gemini.mjs';

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
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]] : []).filter((x) => x.length));
const DRY = !!args['dry-run'];
if (!args.matter) { console.error('Missing --matter'); process.exit(1); }

const { data: matter } = await supabase.from('matterspaces').select('id, name').eq('short_code', args.matter).maybeSingle();
if (!matter) { console.error('matter not found'); process.exit(1); }
console.log(`Matter: ${matter.name} (${matter.id})`);

const { data: docs } = await supabase.from('documents')
  .select('id, source_filename, storage_path, processing_error')
  .eq('matterspace_id', matter.id).eq('processing_status', 'error')
  .or('processing_error.ilike.%bad XRef%,processing_error.ilike.%Command token too long%,processing_error.ilike.%stream must have data%');
console.log(`Corrupt-PDF candidates: ${docs.length}`);
for (const d of docs) console.log(`  "${d.source_filename}" — ${d.processing_error?.slice(0, 60)}`);
if (DRY) process.exit(0);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-repair-'));
let ok = 0; const failed = [];
for (const d of docs) {
  console.log(`\nRepairing: ${d.source_filename}`);
  try {
    const { data: blob, error: dlErr } = await supabase.storage.from('vault-documents').download(d.storage_path);
    if (dlErr || !blob) throw new Error(`download: ${dlErr?.message ?? 'no blob'}`);
    const inFile = path.join(tmp, 'in.pdf');
    const outFile = path.join(tmp, 'out.pdf');
    await fs.writeFile(inFile, Buffer.from(await blob.arrayBuffer()));
    // Rasterize to a clean image-only PDF: guarantees a structure pdf.js can
    // parse; the OCR hook then recovers the text.
    execFileSync('python', ['-c', `
import fitz, sys
src = fitz.open(sys.argv[1])
out = fitz.open()
for page in src:
    pix = page.get_pixmap(dpi=200)
    p = out.new_page(width=page.rect.width, height=page.rect.height)
    p.insert_image(p.rect, pixmap=pix)
out.save(sys.argv[2], garbage=4, deflate=True)
print(f"pages={src.page_count}")
`, inFile, outFile], { stdio: ['ignore', 'inherit', 'inherit'] });
    const repaired = await fs.readFile(outFile);

    await supabase.from('passages').delete().eq('document_id', d.id);
    await supabase.from('documents').update({ processing_status: 'pending', processing_error: null, ingested_at: null }).eq('id', d.id);
    const { passageCount } = await processDocument(supabase, {
      documentId: d.id,
      fileBuf: repaired,
      ext: '.pdf',
      openaiApiKey: OPENAI_API_KEY,
      ocr: (buf) => ocrPdf(buf, { apiKey: GOOGLE_API_KEY, model: 'gemini-2.5-flash', onProgress: ({ message }) => process.stdout.write(`    ${message}\r`) }),
    });
    console.log(`  ✓ ${passageCount} passages`);
    ok++;
  } catch (err) {
    const msg = (err.message || String(err)).slice(0, 300);
    await supabase.from('documents').update({ processing_status: 'error', processing_error: msg }).eq('id', d.id);
    failed.push(`${d.source_filename}: ${msg}`);
    console.log(`  ✗ ${msg}`);
  }
}
console.log(`\n=== Done: ${ok}/${docs.length} repaired ===`);
for (const f of failed) console.log(`  failed • ${f}`);
