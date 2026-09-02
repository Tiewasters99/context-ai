// Does the document Eden is reading have a selectable text layer?
// Marginalia (and the pre-existing highlight feature) both depend on
// pdfjs's TextLayer producing selectable spans. A scanned PDF has none.
import fs from 'node:fs/promises';

const txt = await fs.readFile('../context-ai/.env', 'utf8');
const env = {};
for (const line of txt.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const U = env.VITE_SUPABASE_URL;
const K = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: K, authorization: `Bearer ${K}` };

const q = await fetch(
  `${U}/rest/v1/documents?select=id,title,page_count,storage_path&title=like.CHS%208.2*&limit=2`,
  { headers: H },
);
const docs = await q.json();
if (!docs.length) { console.log('doc not found'); process.exit(1); }
const doc = docs[0];
console.log(`document: "${doc.title}" (${doc.page_count} pages)\n  storage: ${doc.storage_path}`);

const sign = await fetch(`${U}/storage/v1/object/sign/vault-documents/${doc.storage_path}`, {
  method: 'POST',
  headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({ expiresIn: 300 }),
});
const signed = await sign.json();
if (!signed.signedURL && !signed.signedUrl) { console.log('sign failed:', JSON.stringify(signed).slice(0, 200)); process.exit(1); }
const url = U + '/storage/v1' + (signed.signedURL || signed.signedUrl);

const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
console.log(`  downloaded ${(buf.length / 1e6).toFixed(1)} MB\n`);

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const pdf = await pdfjs.getDocument({ data: buf, useSystemFonts: false }).promise;
console.log(`pdfjs reports ${pdf.numPages} pages\n`);

let withText = 0;
const sample = [1, 2, 5, 50, 120, 200, 240, 244].filter((p) => p <= pdf.numPages);
for (const p of sample) {
  const page = await pdf.getPage(p);
  const tc = await page.getTextContent();
  const chars = tc.items.map((i) => i.str).join('').trim().length;
  if (chars > 0) withText++;
  console.log(`  page ${String(p).padStart(4)}: ${String(tc.items.length).padStart(5)} text items, ${String(chars).padStart(6)} chars ${chars === 0 ? '  ← NO SELECTABLE TEXT' : ''}`);
}
console.log(
  `\n${withText === 0
    ? 'VERDICT: no text layer anywhere — text selection is IMPOSSIBLE in this document,\n         so neither the highlight popover nor the note button can ever appear.'
    : `VERDICT: ${withText}/${sample.length} sampled pages have selectable text.`}`,
);
