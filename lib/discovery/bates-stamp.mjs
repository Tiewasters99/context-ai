// Grapheon Discovery — Bates stamping and endorsements.
//
// Stamps are drawn as vector text overlays with pdf-lib (no rasterization):
// files stay small, original text stays searchable, and the pre-stamp display
// PDF is retained in storage — stamping is non-destructive internally,
// immutable externally (bates_registry has no update/delete policies).

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { formatBates } from './util.mjs';

export const BATES_POSITIONS = [
  'lower_left', 'lower_center', 'lower_right',
  'upper_left', 'upper_center', 'upper_right',
];

const MARGIN = 20; // pt from page edge
const BATES_SIZE = 10;
const ENDORSE_SIZE = 11;

function placeText(page, font, text, size, position) {
  const { width, height } = page.getSize();
  const textWidth = font.widthOfTextAtSize(text, size);
  let x;
  if (position.endsWith('left')) x = MARGIN;
  else if (position.endsWith('right')) x = width - MARGIN - textWidth;
  else x = (width - textWidth) / 2;
  const y = position.startsWith('lower') ? MARGIN : height - MARGIN - size;
  return { x, y };
}

// Endorsements (PRIVILEGED / CONFIDENTIAL) go on the opposite edge from the
// Bates stamp so the two never collide: Bates lower_* -> endorsement
// upper_center, and vice versa.
function endorsementPosition(batesPosition) {
  return batesPosition.startsWith('lower') ? 'upper_center' : 'lower_center';
}

/**
 * Stamp every page of a display PDF with sequential Bates numbers and
 * optional endorsements.
 *
 * @param {Buffer} pdfBuf - the display PDF
 * @param {object} opts
 * @param {string} opts.prefix      e.g. 'LIT_'
 * @param {number} opts.pad         leading-zero width, e.g. 7
 * @param {number} opts.startSeq    numeric part of this document's first page
 * @param {string} opts.position    one of BATES_POSITIONS
 * @param {string[]} [opts.endorsements] e.g. ['CONFIDENTIAL']
 * @returns {Promise<{buf: Buffer, pageCount: number, batesFirst: string, batesLast: string}>}
 */
export async function stampPdf(pdfBuf, { prefix, pad, startSeq, position, endorsements = [] }) {
  if (!BATES_POSITIONS.includes(position)) {
    throw new Error(`stampPdf: invalid position '${position}'`);
  }
  const doc = await PDFDocument.load(pdfBuf, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();

  pages.forEach((page, i) => {
    const bates = formatBates(prefix, pad, startSeq + i);
    const { x, y } = placeText(page, font, bates, BATES_SIZE, position);
    page.drawText(bates, { x, y, size: BATES_SIZE, font, color: rgb(0, 0, 0) });

    if (endorsements.length > 0) {
      const text = endorsements.join('  ·  ');
      const pos = endorsementPosition(position);
      const e = placeText(page, bold, text, ENDORSE_SIZE, pos);
      page.drawText(text, { x: e.x, y: e.y, size: ENDORSE_SIZE, font: bold, color: rgb(0.6, 0, 0) });
    }
  });

  return {
    buf: Buffer.from(await doc.save()),
    pageCount: pages.length,
    batesFirst: formatBates(prefix, pad, startSeq),
    batesLast: formatBates(prefix, pad, startSeq + pages.length - 1),
  };
}

/**
 * Slip-sheet for a natively produced file: a single stamped page standing in
 * for the native in the IMAGES set.
 */
export async function makeSlipSheet({ batesNumber, filename, endorsements = [], position = 'lower_right' }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]); // US letter

  const lines = [
    'DOCUMENT PRODUCED IN NATIVE FORMAT',
    '',
    `Bates No. ${batesNumber}`,
    `Original filename: ${filename}`,
  ];
  let y = 460;
  for (const [i, line] of lines.entries()) {
    const f = i === 0 ? bold : font;
    const size = i === 0 ? 16 : 12;
    const w = f.widthOfTextAtSize(line, size);
    page.drawText(line, { x: (612 - w) / 2, y, size, font: f });
    y -= 28;
  }

  const { x, y: by } = placeText(page, font, batesNumber, BATES_SIZE, position);
  page.drawText(batesNumber, { x, y: by, size: BATES_SIZE, font });

  if (endorsements.length > 0) {
    const text = endorsements.join('  ·  ');
    const pos = endorsementPosition(position);
    const e = placeText(page, bold, text, ENDORSE_SIZE, pos);
    page.drawText(text, { x: e.x, y: e.y, size: ENDORSE_SIZE, font: bold, color: rgb(0.6, 0, 0) });
  }

  return Buffer.from(await doc.save());
}

/**
 * Simple generated production cover letter.
 */
export async function makeProductionLetter({
  productionName, matterName, receivingParty, batesFirst, batesLast,
  docCount, pageCount, nativeCount, confidentialCount, requestRefs, dateStr,
}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);

  let y = 720;
  const write = (text, { size = 11, f = font, gap = 20 } = {}) => {
    page.drawText(text, { x: 72, y, size, font: f });
    y -= gap;
  };

  write('PRODUCTION TRANSMITTAL', { size: 16, f: bold, gap: 36 });
  if (dateStr) write(`Date: ${dateStr}`);
  if (matterName) write(`Matter: ${matterName}`);
  if (receivingParty) write(`Produced to: ${receivingParty}`);
  write(`Production: ${productionName}`, { gap: 28 });
  if (requestRefs) write(`In response to: ${requestRefs}`, { gap: 28 });
  write(`Bates range: ${batesFirst} - ${batesLast}`, { f: bold });
  write(`Documents: ${docCount}    Pages: ${pageCount}    Native files: ${nativeCount}`);
  if (confidentialCount > 0) {
    write(`Documents designated CONFIDENTIAL: ${confidentialCount}`, { gap: 28 });
  } else {
    y -= 8;
  }
  write('Produced subject to all applicable protective orders and without', { size: 10, gap: 14 });
  write('waiver of any privilege or protection, including under FRE 502(d).', { size: 10 });

  return Buffer.from(await doc.save());
}

/**
 * Privilege log PDF from privilege_log_entries rows.
 */
export async function makePrivilegeLogPdf({ matterName, productionName, entries }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const BASIS_LABELS = {
    attorney_client: 'Attorney-Client Privilege',
    work_product: 'Attorney Work-Product',
    marital: 'Marital Privilege',
    physician_patient: 'Physician/Patient Privilege',
    pastor_parishioner: 'Pastor/Parishioner Privilege',
    custom: 'Other',
  };

  let page = doc.addPage([792, 612]); // landscape letter
  let y = 560;
  const newPageIfNeeded = (needed = 60) => {
    if (y < needed) {
      page = doc.addPage([792, 612]);
      y = 560;
    }
  };

  page.drawText('PRIVILEGE LOG', { x: 60, y, size: 16, font: bold });
  y -= 18;
  page.drawText(`${matterName ?? ''}  —  ${productionName ?? ''}`, { x: 60, y, size: 10, font });
  y -= 30;

  const wrap = (text, width, size) => {
    const words = String(text ?? '').split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(candidate, size) > width && line) {
        lines.push(line);
        line = w;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines;
  };

  for (const [i, e] of entries.entries()) {
    newPageIfNeeded(110);
    const basis = e.basis === 'custom' && e.basis_custom
      ? e.basis_custom
      : (BASIS_LABELS[e.basis] ?? e.basis);
    page.drawText(`${i + 1}.`, { x: 60, y, size: 10, font: bold });
    page.drawText(
      `Date: ${e.doc_date ?? '—'}   Author: ${e.author ?? '—'}   To: ${e.addressee ?? '—'}   Cc: ${e.cc ?? '—'}`,
      { x: 85, y, size: 10, font },
    );
    y -= 14;
    for (const line of wrap(`Subject matter: ${e.subject_matter ?? '—'}`, 640, 10)) {
      newPageIfNeeded();
      page.drawText(line, { x: 85, y, size: 10, font });
      y -= 13;
    }
    newPageIfNeeded();
    page.drawText(`Basis: ${basis}`, { x: 85, y, size: 10, font: bold });
    y -= 13;
    if (e.description) {
      for (const line of wrap(e.description, 640, 9)) {
        newPageIfNeeded();
        page.drawText(line, { x: 85, y, size: 9, font });
        y -= 12;
      }
    }
    y -= 10;
  }

  return Buffer.from(await doc.save());
}
