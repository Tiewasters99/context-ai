// Fixture corpus for the nightly ingestion suite (Phase 5 of the ingestion
// plan, 2026-09-06). Everything is generated on the fly — nothing binary is
// checked in — and every fixture carries words a test can look for, on the
// page (or in the seconds) where it expects to find them.
//
// Built on scripts/_fixtures-ingest.mjs (PDFs, zips, emails) plus:
//   * sharp for JPEG / TIFF / noise images
//   * the `docx` and `xlsx` packages for Office files, jszip for the EPUB
//   * Windows text-to-speech (System.Speech via PowerShell) for a SPOKEN
//     recording, so the transcription gate asserts real words, not silence
//   * ffmpeg (on PATH, or the WinGet link) to make the .mp3 and .mp4 from it
//
// When a tool is missing the generator returns null and the suite marks that
// fixture SKIPPED with the reason, rather than failing the night.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildPdf, proseLines, scannedPagePng, textPdf } from './_fixtures-ingest.mjs';

export { mixedPdf, imageOnlyPdf, archiveFixture, emlFixture } from './_fixtures-ingest.mjs';

// OCR-robust page markers: real words, one per page number, so a test can ask
// "does page N cite its word" without depending on the OCR reading a random
// token. The word for page N is stable across runs.
const WORDS = [
  'marmalade', 'quixotic', 'cobalt', 'saffron', 'vermilion', 'magenta', 'teal', 'ochre', 'indigo', 'umber',
  'sienna', 'cerulean', 'crimson', 'amber', 'olive', 'maroon', 'lavender', 'periwinkle', 'chartreuse', 'burgundy',
  'turquoise', 'scarlet', 'emerald', 'sapphire', 'topaz', 'garnet', 'onyx', 'ivory', 'ebony', 'copper',
  'bronze', 'silver', 'golden', 'pewter', 'russet', 'mauve', 'taupe', 'coral', 'salmon', 'plum',
  'walnut', 'hazel', 'chestnut', 'almond', 'pecan', 'cashew', 'pistachio', 'juniper', 'cedar', 'cypress',
];
export const wordForPage = (n) => WORDS[(n - 1) % WORDS.length];

// ---- PDFs -------------------------------------------------------------------

// n born-digital pages. Page N carries "Page N" and its marker word.
export async function textPdfPages(n, { tag = '' } = {}) {
  const plan = [];
  for (let p = 1; p <= n; p++) {
    plan.push({ text: [`Page ${p} of ${n} ${tag}`.trim(), `The ${wordForPage(p)} exhibit is discussed on this page.`, ...proseLines(p, 14)] });
  }
  return buildPdf(plan);
}

// n scanned pages: every page is a raster with the words in the pixels only.
export async function scanPdfPages(n, { tag = '' } = {}) {
  const plan = [];
  for (let p = 1; p <= n; p++) {
    plan.push({ scan: [`SCANNED PAGE ${p} OF ${n} ${tag}`.trim(), `Receipt for ${wordForPage(p)} preserves, forty jars.`, 'Delivered on the fourth of the month.', 'Signed by the clerk.'] });
  }
  return buildPdf(plan);
}

// A large born-digital record: `pages` typed pages (every one searchable)
// padded with incompressible JPEG photographs on every k-th page until the
// file is at least `targetBytes`. The images are embedded as-is (DCTDecode),
// so the PDF is big on disk and cheap to build. Exercises the resumable
// upload path (≥ 50 MB), the worker's download, pdf-parse on a big file and
// a large passage insert — the "200 MB record" of gate G7.
export async function bigRecordPdf({ pages = 400, targetBytes = 200 * 1024 * 1024, tag = '' } = {}) {
  const { default: sharp } = await import('sharp');
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const LETTER = [612, 792];
  // One noise photograph ≈ 18–22 MB at 4200×4200 q100. Make as many as needed.
  const photoBytes = async () => {
    const side = 4200;
    const raw = crypto.randomBytes(side * side * 3);
    return sharp(raw, { raw: { width: side, height: side, channels: 3 } }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
  };
  const photos = [];
  let padded = 0;
  while (padded < targetBytes) {
    const jpg = await photoBytes();
    photos.push(await doc.embedJpg(jpg));
    padded += jpg.length;
  }
  const every = Math.max(1, Math.floor(pages / photos.length));
  let used = 0;
  for (let p = 1; p <= pages; p++) {
    const page = doc.addPage(LETTER);
    if (p % every === 0 && used < photos.length) {
      page.drawImage(photos[used++], { x: 36, y: 300, width: 540, height: 400 });
    }
    const lines = [`Page ${p} of ${pages} ${tag}`.trim(), `The ${wordForPage(p)} exhibit is discussed on this page.`, ...proseLines(p, 10)];
    let y = 740;
    for (const l of lines) { page.drawText(l, { x: 72, y, size: 11, font }); y -= 16; }
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

// A PDF portfolio: a cover sheet with two attached PDFs (the wrapper is
// stored with a reason; the attachments are filed as children).
export async function portfolioPdf({ tag = '' } = {}) {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const alpha = await textPdf([`ALPHA EXHIBIT ${tag}`.trim(), 'The alpha exhibit concerns a cobalt briefcase.']);
  const beta = await textPdf([`BETA EXHIBIT ${tag}`.trim(), 'The beta exhibit concerns a saffron envelope.']);
  const cover = await PDFDocument.create();
  const font = await cover.embedFont(StandardFonts.Helvetica);
  const page = cover.addPage([612, 792]);
  page.drawText(`Portfolio cover ${tag}`.trim(), { x: 72, y: 720, size: 14, font });
  page.drawText('This PDF portfolio wraps two exhibits.', { x: 72, y: 700, size: 11, font });
  await cover.attach(alpha, 'Alpha Exhibit.pdf', { mimeType: 'application/pdf', description: 'Alpha Exhibit' });
  await cover.attach(beta, 'Beta Exhibit.pdf', { mimeType: 'application/pdf', description: 'Beta Exhibit' });
  return Buffer.from(await cover.save({ useObjectStreams: false }));
}

export function corruptPdf() {
  return Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(4096)]);
}

// ---- Office, e-book, text -----------------------------------------------------

// A Word document with a heading, prose and an embedded PNG.
export async function docxWithImage({ tag = '' } = {}) {
  const { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel } = await import('docx');
  const png = await scannedPagePng(['figure'], { width: 200, height: 80 });
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: `Memorandum ${tag}`.trim(), heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [new TextRun('This Word memorandum mentions a periwinkle ledger and a walnut desk.')] }),
        new Paragraph({ children: [new ImageRun({ type: 'png', data: png, transformation: { width: 200, height: 80 } })] }),
        new Paragraph({ children: [new TextRun('The figure above is a placeholder image; the text around it is what must be indexed.')] }),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

// A workbook with two sheets of cell text.
export async function xlsxFixture({ tag = '' } = {}) {
  const XLSX = (await import('xlsx')).default ?? (await import('xlsx'));
  const wb = XLSX.utils.book_new();
  const s1 = XLSX.utils.aoa_to_sheet([
    ['Exhibit', 'Description', 'Amount'],
    [`A-${tag}`.trim(), 'Invoice for chartreuse fabric', 1250],
    [`B-${tag}`.trim(), 'Receipt for burgundy ink', 80],
  ]);
  const s2 = XLSX.utils.aoa_to_sheet([['Note'], ['The second sheet records a turquoise deposit.']]);
  XLSX.utils.book_append_sheet(wb, s1, 'Exhibits');
  XLSX.utils.book_append_sheet(wb, s2, 'Notes');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

// A minimal, valid EPUB 2 with two chapters.
export async function epubFixture({ tag = '' } = {}) {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const xhtml = (title, body) => `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Suite e-book ${tag}</dc:title><dc:creator>Fixture</dc:creator><dc:language>en</dc:language><dc:identifier id="bookid">urn:uuid:${crypto.randomUUID()}</dc:identifier></metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`);
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="x"/></head><docTitle><text>Suite e-book</text></docTitle>
<navMap><navPoint id="n1" playOrder="1"><navLabel><text>Chapter One</text></navLabel><content src="chapter1.xhtml"/></navPoint><navPoint id="n2" playOrder="2"><navLabel><text>Chapter Two</text></navLabel><content src="chapter2.xhtml"/></navPoint></navMap></ncx>`);
  zip.file('OEBPS/chapter1.xhtml', xhtml('Chapter One', `The first chapter describes an emerald lantern ${tag}.`.trim()));
  zip.file('OEBPS/chapter2.xhtml', xhtml('Chapter Two', 'The second chapter describes a sapphire compass.'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export const mdFixture = ({ tag = '' } = {}) => Buffer.from(`# Notes ${tag}\n\nThe markdown note mentions a topaz ring.\n\n- item one\n- item two\n`, 'utf8');
export const blankTxt = () => Buffer.from('   \n\n\t \n   \n', 'utf8');
export const controlTxt = ({ tag = '' } = {}) => Buffer.from(
  `Control document ${tag}.\n\nThis born-digital text mentions a garnet clasp and exists so the suite has a searchable control.\n`, 'utf8');
export const objAsset = () => Buffer.from(
  ['# fixture cube', 'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'v 0 0 1', 'v 1 0 1', 'v 1 1 1', 'v 0 1 1',
    'f 1 2 3 4', 'f 5 6 7 8', 'f 1 2 6 5', 'f 2 3 7 6', 'f 3 4 8 7', 'f 4 1 5 8', ''].join('\n'), 'utf8');

// ---- Images -------------------------------------------------------------------

// A scanned page saved as a JPEG (phone camera / vFlat): a document, must OCR.
export async function jpgScan({ tag = '' } = {}) {
  const { default: sharp } = await import('sharp');
  const png = await scannedPagePng([`PHOTOGRAPHED PAGE ${tag}`.trim(), 'The photographed page mentions an onyx paperweight.', 'Signed and dated.']);
  return sharp(png).jpeg({ quality: 88 }).toBuffer();
}

// A TIFF with no words on it (a photograph): stored as image_only.
export async function tiffBlank() {
  const { default: sharp } = await import('sharp');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b5876"/><stop offset="1" stop-color="#4e4376"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="400" cy="300" r="120" fill="#f9d423" opacity="0.8"/></svg>';
  return sharp(Buffer.from(svg)).tiff().toBuffer();
}

// ---- Audio / video -------------------------------------------------------------

function ffmpegPath() {
  for (const cand of ['ffmpeg', path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe')]) {
    const r = spawnSync(cand, ['-version'], { stdio: 'ignore' });
    if (r.status === 0) return cand;
  }
  return null;
}

// Spoken words via Windows text-to-speech → 16 kHz mono WAV. Null when the
// synthesizer is unavailable (not Windows, no voices).
export function spokenWav(text) {
  if (process.platform !== 'win32') return null;
  const out = path.join(os.tmpdir(), `suite-tts-${crypto.randomUUID().slice(0, 8)}.wav`);
  const ps = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    '$s.Rate = -1;',
    `$s.SetOutputToWaveFile('${out.replace(/'/g, "''")}', (New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)));`,
    `$s.Speak('${text.replace(/'/g, "''")}');`,
    '$s.Dispose();',
  ].join(' ');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
  if (r.status !== 0 || !fs.existsSync(out)) return null;
  const buf = fs.readFileSync(out);
  try { fs.unlinkSync(out); } catch { /* temp */ }
  return buf.length > 1000 ? buf : null;
}

// WAV → MP3 (audio) or MP4 (a plain colour video carrying the audio track).
export function mediaFromWav(wav, kind) {
  const ff = ffmpegPath();
  if (!ff || !wav) return null;
  const id = crypto.randomUUID().slice(0, 8);
  const inFile = path.join(os.tmpdir(), `suite-${id}.wav`);
  const outFile = path.join(os.tmpdir(), `suite-${id}.${kind}`);
  fs.writeFileSync(inFile, wav);
  const args = kind === 'mp4'
    ? ['-y', '-f', 'lavfi', '-i', 'color=c=0x1f2a44:s=320x240:r=10', '-i', inFile, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', outFile]
    : ['-y', '-i', inFile, '-ar', '16000', '-ac', '1', '-b:a', '48k', outFile];
  const r = spawnSync(ff, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
  let out = null;
  if (r.status === 0 && fs.existsSync(outFile)) out = fs.readFileSync(outFile);
  for (const f of [inFile, outFile]) { try { fs.unlinkSync(f); } catch { /* temp */ } }
  return out;
}

// A silent 16 kHz mono PCM WAV, written by hand — no ffmpeg needed.
export function silentWav(seconds = 3) {
  const rate = 16000;
  const n = rate * seconds;
  const data = Buffer.alloc(n * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
