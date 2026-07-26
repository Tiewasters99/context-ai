// Grapheon Discovery — file normalization: the image/native/metadata triplet.
//
// Every intake file becomes:
//   display PDF  — click-through rendering (PDF passthrough; TIFF/image -> PDF)
//   native       — the original bytes, always retained
//   metadata     — extracted properties (email headers for .eml; more later)
//
// Files that can't be rendered honestly as pages (.xlsx, .msg, A/V, ...) stay
// kind='native' and get a Bates slip-sheet at production time.
//
// sharp is lazy-imported so retrieval-only code paths never pay for libvips.

import { PDFDocument } from 'pdf-lib';
import { extOf } from './util.mjs';

const PDF_EXTS = new Set(['.pdf']);
const TIFF_EXTS = new Set(['.tif', '.tiff']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
// Never attempt text extraction on these (Fleming lesson: A/V read as text
// poisons the corpus).
const AV_EXTS = new Set([
  '.mp3', '.mp4', '.m4a', '.mov', '.avi', '.wav', '.wmv', '.mkv', '.flac',
  '.ogg', '.webm', '.aac', '.3gp',
]);

/**
 * Normalize one intake file.
 * @param {Buffer} buf - original file bytes
 * @param {string} filename
 * @returns {Promise<{
 *   kind: 'display_pdf'|'native',
 *   displayPdf: Buffer|null,
 *   pageCount: number|null,
 *   metadata: object,
 * }>}
 */
export async function normalizeFile(buf, filename) {
  const ext = extOf(filename);
  const metadata = {};

  if (PDF_EXTS.has(ext)) {
    const pageCount = await pdfPageCount(buf);
    return { kind: 'display_pdf', displayPdf: buf, pageCount, metadata };
  }

  if (TIFF_EXTS.has(ext)) {
    const { pdf, pageCount } = await tiffToPdf(buf);
    return { kind: 'display_pdf', displayPdf: pdf, pageCount, metadata };
  }

  if (IMAGE_EXTS.has(ext)) {
    const pdf = await imageToPdf(buf, ext);
    return { kind: 'display_pdf', displayPdf: pdf, pageCount: 1, metadata };
  }

  if (ext === '.eml') {
    Object.assign(metadata, parseEmlHeaders(buf));
    // Body rendering to PDF is a later pass; keep the message native for now.
    return { kind: 'native', displayPdf: null, pageCount: null, metadata };
  }

  if (AV_EXTS.has(ext)) {
    metadata.media = true;
    return { kind: 'native', displayPdf: null, pageCount: null, metadata };
  }

  // Office docs, .msg, spreadsheets, unknowns: native with slip-sheet.
  // (LibreOffice-headless conversion to display PDF is a Phase-3 upgrade.)
  return { kind: 'native', displayPdf: null, pageCount: null, metadata };
}

export async function pdfPageCount(buf) {
  // ignoreEncryption: produced PDFs are sometimes flagged encrypted with an
  // empty user password; we only need the page count here.
  const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
  return doc.getPageCount();
}

// Multi-page TIFF -> PDF. Each TIFF page is converted to PNG via sharp
// (libvips) and embedded at its native pixel dimensions at 96 dpi equivalent.
async function tiffToPdf(buf) {
  const sharp = (await import('sharp')).default;
  const meta = await sharp(buf).metadata();
  const pages = meta.pages && meta.pages > 1 ? meta.pages : 1;

  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const png = await sharp(buf, { page: i }).png().toBuffer();
    const img = await pdf.embedPng(png);
    // Scale to letter width (612pt) when wider, preserving aspect ratio,
    // so scanned legal pages come out page-sized rather than pixel-sized.
    const scale = img.width > 612 ? 612 / img.width : 1;
    const w = img.width * scale;
    const h = img.height * scale;
    const page = pdf.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return { pdf: Buffer.from(await pdf.save()), pageCount: pages };
}

async function imageToPdf(buf, ext) {
  const pdf = await PDFDocument.create();
  let img;
  if (ext === '.png') {
    img = await pdf.embedPng(buf);
  } else if (ext === '.jpg' || ext === '.jpeg') {
    img = await pdf.embedJpg(buf);
  } else {
    // gif/webp/bmp: transcode to PNG via sharp first.
    const sharp = (await import('sharp')).default;
    const png = await sharp(buf).png().toBuffer();
    img = await pdf.embedPng(png);
  }
  const scale = img.width > 612 ? 612 / img.width : 1;
  const w = img.width * scale;
  const h = img.height * scale;
  const page = pdf.addPage([w, h]);
  page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  return Buffer.from(await pdf.save());
}

// Minimal RFC-822 header parse for privilege-log pre-fill. Headers only —
// the body is never normalized or autocorrected.
export function parseEmlHeaders(buf) {
  const head = buf.toString('utf8', 0, Math.min(buf.length, 32768));
  const headerBlock = head.split(/\r?\n\r?\n/)[0] ?? '';
  // Unfold continuation lines.
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const out = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const m = /^(From|To|Cc|Bcc|Subject|Date):\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const map = { from: 'author', to: 'to', cc: 'cc', bcc: 'bcc', subject: 'subject', date: 'date' };
    if (!out[map[key]]) out[map[key]] = m[2].trim();
  }
  return out;
}
