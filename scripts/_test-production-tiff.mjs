// The TIFF image option (lib/discovery/tiff.mjs, package-docs.mjs, emitOpt).
//
//   node scripts/_test-production-tiff.mjs
//
// Offline. pdftoppm runs only in the worker image, so page rendering is
// injected (sharp-made PNGs) and the rest is real:
//   * a black-and-white page becomes a 1-bit Group IV TIFF at 300 dpi; a colour
//     page becomes a JPEG;
//   * every page image is named by its own Bates number, and the OPT has one
//     line per page, the document break (Y) and page count on the first;
//   * a render that yields the wrong number of pages refuses, never ships;
//   * PDF volumes are unchanged (one PDF and one OPT line per document).
// When pdftoppm IS on this machine, one real stamped PDF is rendered as well.
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { batesPages, pageImage, isColourPage, stampedPdfToPageImages, rasterizerAvailable, renderPdfPages }
  from '../lib/discovery/tiff.mjs';
import { packageDocument } from '../lib/discovery/package-docs.mjs';
import { emitOpt, parseOpt } from '../lib/discovery/loadfile.mjs';

let n = 0;
const ok = (m) => { n++; console.log(`  PASS  ${m}`); };

// TIFF tag reader: enough to prove compression = 4 (CCITT Group 4),
// 1 bit per sample, and 300 dpi.
function tiffTags(buf) {
  const le = buf.toString('latin1', 0, 2) === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd = u32(4);
  const tags = {};
  for (let i = 0; i < u16(ifd); i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e), type = u16(e + 2);
    if (type === 5) { const off = u32(e + 8); tags[tag] = u32(off) / u32(off + 4); }
    else tags[tag] = type === 3 ? u16(e + 8) : u32(e + 8);
  }
  return tags;
}

const page = (bg, w = 850, h = 1100) => sharp({ create: { width: w, height: h, channels: 3, background: bg } })
  .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}"><text x="80" y="120" font-size="40">PTL_0000007</text></svg>`) }])
  .png().toBuffer();
const whitePage = await page('#fbfaf6');
const colourPage = await sharp({ create: { width: 850, height: 1100, channels: 3, background: '#ffffff' } })
  .composite([{ input: await sharp({ create: { width: 400, height: 300, channels: 3, background: '#c0392b' } }).png().toBuffer(), left: 100, top: 200 }])
  .png().toBuffer();

// Numbering.
assert.deepEqual(batesPages('PTL_0000007', 'PTL_0000009', 3), ['PTL_0000007', 'PTL_0000008', 'PTL_0000009']);
assert.deepEqual(batesPages('ABC-099', 'ABC-101', 3), ['ABC-099', 'ABC-100', 'ABC-101']);
assert.throws(() => batesPages('PTL_0000007', 'PTL_0000009', 2), /not 2 page/);
assert.throws(() => batesPages('PTL_0000007', 'XYZ_0000009', 3), /cannot number/);
ok('every page gets its own Bates number, padding kept; a range that is not N pages refuses');

// Page images.
{
  assert.equal(await isColourPage(whitePage), false);
  assert.equal(await isColourPage(colourPage), true);
  const bw = await pageImage(whitePage);
  assert.equal(bw.ext, '.tif');
  const t = tiffTags(bw.buf);
  assert.equal(t[259], 4, 'Compression = CCITT Group 4');
  assert.equal(t[258], 1, 'BitsPerSample = 1');
  assert.equal(Math.round(t[282]), 300, 'XResolution = 300');
  assert.equal(t[296], 2, 'ResolutionUnit = inch');
  ok('a black-and-white page is a 1-bit Group IV TIFF at 300 dpi');
  // bates-stamp.mjs burns endorsements in dark red. At 300 dpi a 9pt bold
  // "CONFIDENTIAL" is a sliver of the page: it must not turn a black-and-white
  // page into a colour JPEG (and thresholded, it stays legible as black).
  const endorsed = await sharp({ create: { width: 2550, height: 3300, channels: 3, background: '#ffffff' } })
    .composite([{ input: Buffer.from('<svg width="2550" height="3300"><text x="1700" y="3200" font-size="38" '
      + 'font-weight="bold" fill="rgb(153,0,0)">CONFIDENTIAL - SUBJECT TO PROTECTIVE ORDER</text>'
      + '<text x="200" y="400" font-size="40">Black body text of the document</text></svg>') }])
    .png().toBuffer();
  assert.equal(await isColourPage(endorsed), false);
  assert.equal((await pageImage(endorsed)).ext, '.tif');
  ok('a black-and-white page with a red CONFIDENTIAL endorsement stays a Group IV TIFF');
  const col = await pageImage(colourPage);
  assert.equal(col.ext, '.jpg');
  assert.equal((await sharp(col.buf).metadata()).format, 'jpeg');
  ok('a colour page is a JPEG (colour is not thrown away)');
}

// A document -> page images -> package files -> page-level OPT.
{
  const render = async () => [whitePage, colourPage, whitePage];
  const imgs = await stampedPdfToPageImages(Buffer.from('%PDF'), { bates_first: 'PTL_0000007', bates_last: 'PTL_0000009' }, 3, { render });
  assert.deepEqual(imgs.map((i) => i.file), ['PTL_0000007.tif', 'PTL_0000008.jpg', 'PTL_0000009.tif']);
  await assert.rejects(
    stampedPdfToPageImages(Buffer.from('%PDF'), { bates_first: 'PTL_0000007', bates_last: 'PTL_0000009' }, 3, { render: async () => [whitePage] }),
    /rendered 1 page image\(s\) for 3 stamped page\(s\)/);
  ok('a 3-page document becomes 3 images named by Bates number; a short render refuses');

  const files = new Map();
  const doc = await packageDocument({
    item: {
      kind: 'display_pdf', original_filename: 'records.pdf', bates_first: 'PTL_0000007', bates_last: 'PTL_0000009',
      page_count: 3, display_storage_path: 'd', native_storage_path: 'd', sha256: 'c'.repeat(64), file_size_bytes: 10,
    },
    volumeName: 'VOL001', confidential: false, stampedPath: 's', imageFormat: 'tiff',
    read: async () => Buffer.from('%PDF-1.4'),
    append: (b, name) => files.set(name, b),
    pageImages: async (pdf, it, pages) => stampedPdfToPageImages(pdf, it, pages, { render }),
  });
  assert.deepEqual([...files.keys()].filter((k) => k.includes('/IMAGES/')).sort(),
    ['VOL001/IMAGES/PTL_0000007.tif', 'VOL001/IMAGES/PTL_0000008.jpg', 'VOL001/IMAGES/PTL_0000009.tif']);
  assert.ok(!files.has('VOL001/IMAGES/PTL_0000007.pdf'));
  ok('packageDocument in TIFF mode writes one image per page and no PDF');

  const native = await packageDocument({
    item: {
      kind: 'native', original_filename: 'ledger.xlsx', bates_first: 'PTL_0000010', bates_last: 'PTL_0000010',
      native_storage_path: 'n', sha256: 'd'.repeat(64), file_size_bytes: 10,
    },
    volumeName: 'VOL001', confidential: false, stampedPath: 's', imageFormat: 'tiff',
    read: async () => Buffer.from('x'), append: (b, name) => files.set(name, b),
    pageImages: async (pdf, it, pages) => stampedPdfToPageImages(pdf, it, pages, { render: async () => [whitePage] }),
  });
  assert.ok(files.has('VOL001/IMAGES/PTL_0000010.tif') && files.has('VOL001/NATIVES/PTL_0000010.xlsx'));
  ok("a native's slip sheet becomes a single TIFF; the native still goes to NATIVES/");

  const opt = emitOpt([doc.datRow, native.datRow], 'VOL001').toString('utf8');
  const lines = opt.trim().split(/\r\n/);
  assert.deepEqual(lines, [
    'PTL_0000007,VOL001,IMAGES/PTL_0000007.tif,Y,,,3',
    'PTL_0000008,VOL001,IMAGES/PTL_0000008.jpg,,,,',
    'PTL_0000009,VOL001,IMAGES/PTL_0000009.tif,,,,',
    'PTL_0000010,VOL001,IMAGES/PTL_0000010.tif,Y,,,1',
  ]);
  const parsed = parseOpt(Buffer.from(opt));
  assert.deepEqual(parsed.map((p) => p.docBreak), [true, false, false, true]);
  ok('the OPT has one line per page; the document break and page count sit on each first page');

  const pdfOpt = emitOpt([{ bates_first: 'PTL_0000001', image_path: 'IMAGES/PTL_0000001.pdf', pages: 4 }], 'VOL001').toString('utf8');
  assert.equal(pdfOpt.trim(), 'PTL_0000001,VOL001,IMAGES/PTL_0000001.pdf,Y,,,4');
  ok('PDF volumes are unchanged: one OPT line per document');
}

// The real renderer, where poppler exists (the worker image).
if (rasterizerAvailable()) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const p = pdf.addPage([612, 792]);
    p.drawText(`PTL_000000${i + 1}`, { x: 480, y: 30, size: 10, font, color: rgb(0, 0, 0) });
  }
  const pages = await renderPdfPages(Buffer.from(await pdf.save()));
  assert.equal(pages.length, 2);
  assert.equal((await sharp(pages[0]).metadata()).width, 2550);
  ok('pdftoppm is installed here: a real 2-page PDF renders to 2 pages at 300 dpi (2550 px wide)');
} else {
  console.log('  SKIP  real pdftoppm rendering (poppler not installed here; runs in the worker image)');
}

console.log(`\nTIFF image option verified offline: ${n} checks passed.`);
