// PDF fixtures for the ingestion tests (unit and smoke). Built on the fly with
// pdf-lib and sharp so nothing binary is checked in, and so a test can say
// exactly which page carries which words.
//
// Two lessons from Phase 1 are baked in:
//   * pages are saved WITHOUT object streams — pdf-parse's 2017 pdf.js reads
//     those reliably (12/12) and choked on ~40% of object-stream saves
//     ("bad XRef entry" / "Invalid PDF structure");
//   * a "scanned" page is a full-page RASTER (PNG at 850×1100 — a 100 dpi
//     letter page, comfortably over ingest-core's page-sized-image floor),
//     with the text rendered INTO the pixels by sharp's SVG rasterizer, so
//     real OCR has something to read and pdf-parse has nothing.
import { PDFDocument, StandardFonts } from 'pdf-lib';

const LETTER = [612, 792];

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A page of prose long enough to be unmistakably born-digital (well over the
// 200-character floor). `seed` makes each page's text distinct.
export function proseLines(seed, n = 18) {
  const base = [
    `Page ${seed}. This memorandum of law is submitted in support of the motion.`,
    'The Court has jurisdiction under 28 U.S.C. § 1331, and venue is proper.',
    'Plaintiff alleges three causes of action, each addressed in turn below.',
    'First, the contract claim fails because no meeting of the minds occurred.',
    'Second, the tort claim is time-barred under the applicable statute.',
    'Third, the equitable claim duplicates the legal claim and adds nothing.',
  ];
  const out = [];
  for (let i = 0; i < n; i++) out.push(base[i % base.length]);
  return out;
}

// Full-page PNG of a "scanned" page carrying `lines` of legible text. Faint
// grey ground with a slight border, like a photocopy.
export async function scannedPagePng(lines, { width = 850, height = 1100 } = {}) {
  const { default: sharp } = await import('sharp');
  const text = lines.map((l, i) =>
    `<text x="80" y="${140 + i * 44}" font-family="Arial, Helvetica, sans-serif" font-size="26" fill="#111">${esc(l)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="100%" height="100%" fill="#f3f2ee"/>` +
    `<rect x="12" y="12" width="${width - 24}" height="${height - 24}" fill="none" stroke="#cfcac0" stroke-width="3"/>` +
    text + '</svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// Build a PDF from a page plan. Each entry is one of:
//   { text: [lines] }                 born-digital page (Helvetica text layer)
//   { scan: [lines] }                 raster page with the lines rendered into pixels (no text layer)
//   { scan: [lines], stamp: 'text' }  raster page PLUS a small digital stamp line (CM/ECF style)
//   { blank: true }                   nothing on it at all
//   { image: [lines], text: [lines] } a typed page that also carries a page-sized image
export async function buildPdf(plan) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of plan) {
    const page = doc.addPage(LETTER);
    if (spec.scan || spec.image) {
      const png = await scannedPagePng(spec.scan || spec.image);
      const img = await doc.embedPng(png);
      page.drawImage(img, { x: 0, y: 0, width: LETTER[0], height: LETTER[1] });
    }
    const lines = spec.text ? [...spec.text] : [];
    if (spec.stamp) lines.unshift(spec.stamp);
    let y = 740;
    for (const l of lines) {
      page.drawText(l, { x: 72, y, size: 11, font });
      y -= 16;
    }
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

export const textPdf = (lines) => buildPdf([{ text: lines }]);

// A one-page "scan" with nothing legible on it — a grey sheet with a box.
export async function imageOnlyPdf() {
  const { default: sharp } = await import('sharp');
  const box = await sharp({ create: { width: 500, height: 300, channels: 3, background: { r: 60, g: 80, b: 140 } } }).png().toBuffer();
  const png = await sharp({ create: { width: 850, height: 1100, channels: 3, background: { r: 235, g: 235, b: 230 } } })
    .composite([{ input: box, left: 175, top: 400 }])
    .png().toBuffer();
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(png);
  const page = doc.addPage(LETTER);
  page.drawImage(img, { x: 0, y: 0, width: LETTER[0], height: LETTER[1] });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

// The Phase 2 acceptance fixture (gate G1): three typed pages, then two
// scanned exhibit pages whose only text is in the pixels. `marker4` and
// `marker5` are the words a test looks for on pages 4 and 5 after OCR.
export async function mixedPdf({ marker4 = 'marmalade', marker5 = 'quixotic', tag = '' } = {}) {
  return buildPdf([
    { text: proseLines(1) },
    { text: proseLines(2) },
    { text: proseLines(3) },
    { scan: [`EXHIBIT A ${tag}`.trim(), `Scanned receipt for ${marker4} preserves, forty jars.`, 'Delivered on the fourth of the month.', 'Signed by the clerk.'] },
    { scan: [`EXHIBIT B ${tag}`.trim(), `Handwritten note: the ${marker5} witness arrived late.`, 'Interview began at ten.', 'Ended before noon.'] },
  ]);
}

// ---- Containers (Phase 3, gate G2) ------------------------------------------

// A .zip from a plan of { path: bytes }. Directory entries are implied by the
// paths. Built with JSZip, the same library the browser uses.
export async function zipFixture(files) {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  for (const [p, bytes] of Object.entries(files)) zip.file(p, bytes);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// The Phase 3 acceptance archive: a typed PDF, a text file, a nested archive
// holding another PDF, and the junk a Mac drops in (skipped). `tag` makes
// the words unique per run.
export async function archiveFixture({ tag = '' } = {}) {
  const inner = await zipFixture({
    'nested/Exhibit C.pdf': await textPdf([`EXHIBIT C ${tag}`.trim(), 'The nested exhibit mentions a vermilion ledger.']),
  });
  return zipFixture({
    'Transcript Files/Deposition of J. Walters.pdf': await textPdf([`DEPOSITION ${tag}`.trim(), 'The witness described a cobalt briefcase.']),
    'Transcript Files/notes.txt': Buffer.from(`Smoke ${tag}: the reporter noted a saffron envelope.\n`),
    'Transcript Files/inner.zip': inner,
    '__MACOSX/Transcript Files/._notes.txt': Buffer.from('junk'),
    'Transcript Files/.DS_Store': Buffer.from('junk'),
  });
}

// A multipart email: text + HTML body, an inline signature image referenced
// by cid (not an attachment), a PDF attachment, and an attached message.
export async function emlFixture({ tag = '', subject = 'Initial disclosures' } = {}) {
  const pdf = await textPdf([`DISCLOSURES ${tag}`.trim(), 'The attached disclosure names a magenta ledger.']);
  const png = await scannedPagePng(['signature'], { width: 120, height: 40 });
  const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
  const b64 = (buf) => buf.toString('base64').replace(/(.{76})/g, `$1${CRLF}`);
  const nested = [
    'From: clerk@example.com', 'To: eden@example.com', `Subject: Forwarded scheduling note ${tag}`.trim(),
    'Content-Type: text/plain; charset=utf-8', '', `The forwarded note ${tag} mentions a teal calendar.`, '',
  ].join(CRLF);
  const lines = [
    'From: "Opposing Counsel" <counsel@example.com>',
    'To: eden@example.com',
    `Subject: ${subject} ${tag}`.trim(),
    'Date: Thu, 17 Apr 2025 09:12:00 -0500',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="MIX"',
    '',
    '--MIX',
    'Content-Type: multipart/related; boundary="REL"',
    '',
    '--REL',
    'Content-Type: multipart/alternative; boundary="ALT"',
    '',
    '--ALT',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Good morning all, attached please find the disclosures ${tag}. The body mentions an ochre folder.`,
    '',
    '--ALT',
    'Content-Type: text/html; charset=utf-8',
    '',
    `<p>Good morning all, attached please find the disclosures ${tag}. The body mentions an ochre folder.</p><img src="cid:sig001">`,
    '',
    '--ALT--',
    '--REL',
    'Content-Type: image/png; name="image002.png"',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <sig001>',
    'Content-Disposition: inline; filename="image002.png"',
    '',
    b64(png),
    '--REL--',
    '--MIX',
    'Content-Type: application/pdf; name="2025.04.17 - Second Amended Initial Disclosures.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="2025.04.17 - Second Amended Initial Disclosures.pdf"',
    '',
    b64(pdf),
    '--MIX',
    'Content-Type: message/rfc822',
    'Content-Disposition: attachment',
    '',
    nested,
    '--MIX--',
    '',
  ];
  return Buffer.from(lines.join(CRLF), 'utf8');
}
