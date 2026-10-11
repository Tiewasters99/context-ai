// Grapheon Discovery — the TIFF image option.
//
// Many ESI protocols still call for the classic image format: one file per
// PAGE, named by that page's Bates number, black-and-white Group IV TIFF at
// 300 dpi, with colour pages as JPEG, and an Opticon (.opt) line per page.
// This module turns a document's STAMPED PDF into those page images, so the
// Bates number and endorsements burned onto the PDF are on the TIFF too.
//
// Rendering uses poppler's pdftoppm, which is in the worker's Docker image.
// Where it is missing, rasterizerAvailable() is false and the worker refuses
// a TIFF package with a sentence. It never quietly ships PDFs to someone who
// asked for TIFF. Nothing leaves the machine.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const TIFF_DPI = 300;
const RENDER_TIMEOUT_MS = 300_000;

// A page is "colour" when some pixel's channels differ by more than this
// (out of 255) across more than a sliver of the page. Scans of black text on
// off-white paper stay under it; photos, highlighting and letterhead logos
// in colour go over.
const COLOUR_SPREAD = 40;
const COLOUR_SHARE = 0.002;

let cachedBinary;
export function pdftoppmBinary() {
  if (cachedBinary !== undefined) return cachedBinary;
  for (const bin of [process.env.PDFTOPPM_PATH, 'pdftoppm'].filter(Boolean)) {
    try {
      const r = spawnSync(bin, ['-v'], { timeout: 20_000, stdio: ['ignore', 'ignore', 'pipe'] });
      if (r.status === 0 || /pdftoppm version/i.test(String(r.stderr ?? ''))) return (cachedBinary = bin);
    } catch { /* not installed under this name */ }
  }
  return (cachedBinary = null);
}

export const rasterizerAvailable = () => pdftoppmBinary() !== null;

/**
 * Render every page of a PDF to PNG at `dpi`. Returns one Buffer per page,
 * in page order.
 */
export async function renderPdfPages(pdfBuf, { dpi = TIFF_DPI, timeoutMs = RENDER_TIMEOUT_MS } = {}) {
  const bin = pdftoppmBinary();
  if (!bin) throw new Error('pdftoppm (poppler) is not installed on this machine');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'disc-tif-'));
  try {
    const input = path.join(dir, 'in.pdf');
    await fs.writeFile(input, pdfBuf);
    await new Promise((resolve, reject) => {
      const child = spawn(bin, ['-r', String(dpi), '-png', input, path.join(dir, 'p')],
        { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`rendering took longer than ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`pdftoppm exit ${code}: ${err.slice(-300)}`));
      });
    });
    // pdftoppm names pages p-1.png … p-N.png, zero-padded to the width of N.
    const files = (await fs.readdir(dir))
      .map((f) => ({ f, m: /^p-(\d+)\.png$/.exec(f) }))
      .filter((x) => x.m)
      .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));
    const pages = [];
    for (const { f } of files) pages.push(await fs.readFile(path.join(dir, f)));
    return pages;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** True when a rendered page carries real colour (see COLOUR_SPREAD). */
export async function isColourPage(png) {
  const sharp = (await import('sharp')).default;
  // A small thumbnail is plenty to tell colour from grey, and fast.
  const { data, info } = await sharp(png).resize(200, 200, { fit: 'inside' })
    .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  if (info.channels < 3) return false;
  let coloured = 0;
  const px = data.length / info.channels;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > COLOUR_SPREAD) coloured++;
  }
  return coloured / px > COLOUR_SHARE;
}

/**
 * One rendered page -> its production image.
 * Black-and-white pages: 1-bit Group IV TIFF. Colour pages: JPEG (the usual
 * protocol term: "colour documents produced as JPG").
 * @returns {Promise<{buf: Buffer, ext: '.tif'|'.jpg', colour: boolean}>}
 */
export async function pageImage(png, { dpi = TIFF_DPI } = {}) {
  const sharp = (await import('sharp')).default;
  const pxPerMm = dpi / 25.4;
  if (await isColourPage(png)) {
    const buf = await sharp(png).flatten({ background: '#ffffff' })
      .withMetadata({ density: dpi }).jpeg({ quality: 85, chromaSubsampling: '4:4:4' }).toBuffer();
    return { buf, ext: '.jpg', colour: true };
  }
  const buf = await sharp(png).flatten({ background: '#ffffff' })
    .toColourspace('b-w').threshold(160)
    .tiff({ compression: 'ccittfax4', bitdepth: 1, xres: pxPerMm, yres: pxPerMm })
    .toBuffer();
  return { buf, ext: '.tif', colour: false };
}

/**
 * The Bates number of every page of a document, from its first and last.
 * "PTL_0000007".."PTL_0000009" -> [PTL_0000007, PTL_0000008, PTL_0000009].
 * Throws if the two do not describe exactly `count` consecutive numbers.
 */
export function batesPages(first, last, count) {
  const a = /^(.*?)(\d+)$/.exec(String(first ?? ''));
  const b = /^(.*?)(\d+)$/.exec(String(last ?? ''));
  if (!a || !b || a[1] !== b[1]) throw new Error(`cannot number pages from ${first} to ${last}`);
  const width = a[2].length;
  const start = Number(a[2]);
  if (Number(b[2]) - start + 1 !== count) {
    throw new Error(`${first}–${last} is not ${count} page(s)`);
  }
  return Array.from({ length: count }, (_, i) => `${a[1]}${String(start + i).padStart(width, '0')}`);
}

/**
 * A stamped PDF -> one image per page, each named by its own Bates number.
 * @param {Buffer} stampedPdf
 * @param {{ bates_first: string, bates_last: string }} item
 * @param {number} pages  the produced page count (must match the render)
 * @param {{ render?: typeof renderPdfPages }} [opts]  injectable for tests
 * @returns {Promise<Array<{bates: string, file: string, buf: Buffer, colour: boolean}>>}
 */
export async function stampedPdfToPageImages(stampedPdf, item, pages, { render = renderPdfPages } = {}) {
  const labels = batesPages(item.bates_first, item.bates_last, pages);
  const rendered = await render(stampedPdf);
  if (rendered.length !== pages) {
    throw new Error(`${item.bates_first} rendered ${rendered.length} page image(s) for ${pages} stamped page(s)`);
  }
  const out = [];
  for (let i = 0; i < rendered.length; i++) {
    const img = await pageImage(rendered[i]);
    out.push({ bates: labels[i], file: `${labels[i]}${img.ext}`, buf: img.buf, colour: img.colour });
  }
  return out;
}
