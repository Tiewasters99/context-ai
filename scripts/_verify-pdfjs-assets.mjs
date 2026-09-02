// Prove the pdfjs asset parameters actually change behaviour, by running the
// real page-processing path (getOperatorList triggers font + image decoding,
// which is where the assets are consumed) with and without them.
//
// No browser needed: this is the same pdfjs the app loads.
import fs from 'node:fs/promises';
import path from 'node:path';

const env = {};
for (const line of (await fs.readFile('../context-ai/.env', 'utf8')).split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const U = env.VITE_SUPABASE_URL;
const K = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: K, authorization: `Bearer ${K}` };

const PKG = path.resolve('node_modules/pdfjs-dist');
const WITH_ASSETS = {
  cMapUrl: `${PKG}/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${PKG}/standard_fonts/`,
  wasmUrl: `${PKG}/wasm/`,
  iccUrl: `${PKG}/iccs/`,
};

async function fetchPdf(title) {
  const q = await fetch(
    `${U}/rest/v1/documents?select=title,storage_path&title=like.${encodeURIComponent(title)}*&limit=1`,
    { headers: H },
  );
  const [doc] = await q.json();
  const sign = await fetch(`${U}/storage/v1/object/sign/vault-documents/${doc.storage_path}`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ expiresIn: 300 }),
  });
  const s = await sign.json();
  const url = U + '/storage/v1' + (s.signedURL || s.signedUrl);
  return { title: doc.title, data: new Uint8Array(await (await fetch(url)).arrayBuffer()) };
}

async function run(label, file, page, params) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const messages = [];
  const origWarn = console.warn, origLog = console.log, origErr = console.error;
  console.warn = console.log = console.error = (...a) => messages.push(a.join(' '));
  let ok = false, err = null;
  try {
    const pdf = await pdfjs.getDocument({ data: file.data.slice(), ...params }).promise;
    const p = await pdf.getPage(page);
    await p.getOperatorList();          // decodes fonts + images
    ok = true;
    await pdf.destroy();
  } catch (e) {
    err = e?.message ?? String(e);
  } finally {
    console.warn = origWarn; console.log = origLog; console.error = origErr;
  }
  const complaints = messages.filter((m) =>
    /standardFontDataUrl|wasmUrl|cMapUrl|iccUrl|OpenJPEG|JpxError|Unable to decode|isn't ready|fallback/i.test(m),
  );
  console.log(`\n${label}`);
  console.log(`  completed: ${ok}${err ? ` (error: ${err})` : ''}`);
  console.log(`  asset complaints: ${complaints.length}`);
  for (const c of [...new Set(complaints)].slice(0, 4)) console.log(`    - ${c.slice(0, 110)}`);
  return complaints.length;
}

console.log('Fetching test documents…');
const transcript = await fetchPdf('Gg9321 302 Transcript');   // Courier → standard-14 fonts
const scan = await fetchPdf('CHS 8.2');                        // JPEG2000 images

console.log(`\n=== ${transcript.title} (page 5) — standard fonts ===`);
const a1 = await run('WITHOUT asset params (what the app did before):', transcript, 5, {});
const b1 = await run('WITH asset params (what the app does now):', transcript, 5, WITH_ASSETS);

console.log(`\n=== ${scan.title} (page 244) — JPEG2000 images ===`);
const a2 = await run('WITHOUT asset params:', scan, 244, {});
const b2 = await run('WITH asset params:', scan, 244, WITH_ASSETS);

console.log('\n────────────────────────────────');
console.log(`transcript complaints: ${a1} → ${b1}`);
console.log(`scan complaints:       ${a2} → ${b2}`);
console.log(a1 + a2 > b1 + b2 ? 'VERDICT: the parameters fix real failures.' : 'VERDICT: no measurable difference.');
