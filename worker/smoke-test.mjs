// Grapheon Discovery — offline smoke test for the worker-side engine.
// No Supabase needed. Run: node worker/smoke-test.mjs
//
// Exercises: Bates stamping (positions, sequencing), slip-sheets, the
// production letter, privilege log PDF, DAT emit->parse round-trip, OPT
// emission, and TIFF->PDF + image->PDF normalization via sharp.

import { PDFDocument, StandardFonts } from 'pdf-lib';
import { stampPdf, makeSlipSheet, makeProductionLetter, makePrivilegeLogPdf, BATES_POSITIONS } from '../lib/discovery/bates-stamp.mjs';
import { emitDat, parseDat, canonicalizeDatRecord, emitOpt, parseOpt, datLookupByFilename } from '../lib/discovery/loadfile.mjs';
import { normalizeFile } from '../lib/discovery/normalize.mjs';
import { formatBates } from '../lib/discovery/util.mjs';

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failures++;
};

// --- sample 3-page PDF -------------------------------------------------------
async function samplePdf(pages = 3) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Sample page ${i + 1}`, { x: 72, y: 700, size: 14, font });
  }
  return Buffer.from(await doc.save());
}

// --- Bates stamping ----------------------------------------------------------
{
  const pdf = await samplePdf(3);
  const r = await stampPdf(pdf, {
    prefix: 'LIT_', pad: 7, startSeq: 42, position: 'lower_right',
    endorsements: ['CONFIDENTIAL'],
  });
  check('stampPdf pageCount', r.pageCount === 3);
  check('stampPdf batesFirst', r.batesFirst === 'LIT_0000042');
  check('stampPdf batesLast', r.batesLast === 'LIT_0000044');
  const reloaded = await PDFDocument.load(r.buf);
  check('stamped PDF reloads', reloaded.getPageCount() === 3);

  for (const pos of BATES_POSITIONS) {
    const rr = await stampPdf(pdf, { prefix: 'X', pad: 3, startSeq: 1, position: pos });
    check(`position ${pos}`, rr.batesFirst === 'X001');
  }

  let threw = false;
  try { await stampPdf(pdf, { prefix: 'X', pad: 3, startSeq: 1, position: 'middle' }); }
  catch { threw = true; }
  check('invalid position rejected', threw);
}

// --- slip sheet / letter / privilege log -------------------------------------
{
  const sheet = await makeSlipSheet({
    batesNumber: 'LIT_0000099', filename: 'damages_model.xlsx',
    endorsements: ['CONFIDENTIAL'], position: 'lower_right',
  });
  check('slip sheet is 1 page', (await PDFDocument.load(sheet)).getPageCount() === 1);

  const letter = await makeProductionLetter({
    productionName: 'Defendants First Production', matterName: 'Webster v. Acme',
    receivingParty: 'Smith & Jones LLP', batesFirst: 'LIT_0000001', batesLast: 'LIT_0000098',
    docCount: 12, pageCount: 98, nativeCount: 2, confidentialCount: 3,
    requestRefs: 'RFP Nos. 1-24', dateStr: '2026-06-10',
  });
  check('production letter renders', (await PDFDocument.load(letter)).getPageCount() === 1);

  const priv = await makePrivilegeLogPdf({
    matterName: 'Webster v. Acme', productionName: 'P1',
    entries: [
      { doc_date: '2025-01-02', author: 'A. Counsel', addressee: 'C. Client', cc: '',
        subject_matter: 'Legal advice regarding indemnification clause in the draft agreement',
        basis: 'attorney_client', description: 'Email chain seeking and providing legal advice.' },
      { doc_date: '2025-02-10', author: 'C. Client', addressee: 'A. Counsel', cc: 'B. Paralegal',
        subject_matter: 'Draft litigation strategy memorandum', basis: 'work_product' },
      { doc_date: null, author: 'X', addressee: 'Y', cc: null,
        subject_matter: 'Confession to spouse', basis: 'custom', basis_custom: 'Marital communications' },
    ],
  });
  check('privilege log renders', (await PDFDocument.load(priv)).getPageCount() >= 1);
}

// --- DAT round-trip ----------------------------------------------------------
{
  const rows = [
    { bates_first: 'LIT_0000001', bates_last: 'LIT_0000003', pages: 3, custodian: 'E. Quainton',
      author: 'a@x.com', to: 'b@y.com', cc: '', subject: 'Re: contract', date: '2025-03-04',
      filename: 'contract_email.pdf', native_link: '', confidentiality: 'CONFIDENTIAL',
      image_path: 'IMAGES/LIT_0000001.pdf' },
    { bates_first: 'LIT_0000004', bates_last: 'LIT_0000004', pages: 1, custodian: '',
      author: '', to: '', cc: '', subject: '', date: '', filename: 'damages.xlsx',
      native_link: 'NATIVES/LIT_0000004.xlsx', confidentiality: '',
      image_path: 'IMAGES/LIT_0000004.pdf' },
  ];
  const dat = emitDat(rows);
  const { fields, records } = parseDat(dat);
  check('DAT round-trip record count', records.length === 2);
  check('DAT round-trip header', fields.includes('begbates') && fields.includes('nativelink'));
  const canon = canonicalizeDatRecord(records[0]);
  check('DAT canonical bates', canon.bates_first === 'LIT_0000001');
  check('DAT canonical author', canon.author === 'a@x.com');
  const lookup = datLookupByFilename(records.map((r) => r));
  check('DAT filename lookup', lookup.get('contract_email.pdf')?.bates_first === 'LIT_0000001');
  check('DAT bates-name lookup', lookup.get('lit_0000004.pdf')?.filename === 'damages.xlsx');

  const opt = emitOpt(rows, 'VOL001');
  const optPages = parseOpt(opt);
  check('OPT round-trip', optPages.length === 2 && optPages[0].docBreak && optPages[0].pageCount === 3);
}

// --- normalization -----------------------------------------------------------
{
  const pdf = await samplePdf(2);
  const n1 = await normalizeFile(pdf, 'memo.pdf');
  check('PDF passthrough', n1.kind === 'display_pdf' && n1.pageCount === 2 && n1.displayPdf === pdf);

  const sharp = (await import('sharp')).default;
  const page = await sharp({
    create: { width: 850, height: 1100, channels: 3, background: { r: 250, g: 250, b: 245 } },
  }).tiff().toBuffer();
  // two-page TIFF: libvips joins pages via toFormat with pyramid? simplest:
  // single-page TIFF check + multi-page via sharp's pages metadata on 1 page.
  const n2 = await normalizeFile(page, 'scan.tif');
  check('TIFF -> display PDF', n2.kind === 'display_pdf' && n2.pageCount === 1 && n2.displayPdf?.length > 0);
  check('TIFF display PDF loads', (await PDFDocument.load(n2.displayPdf)).getPageCount() === 1);

  const jpg = await sharp({
    create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).jpeg().toBuffer();
  const n3 = await normalizeFile(jpg, 'photo.JPG');
  check('JPG -> display PDF', n3.kind === 'display_pdf' && n3.pageCount === 1);

  const n4 = await normalizeFile(Buffer.from('a,b,c'), 'sheet.xlsx');
  check('xlsx stays native', n4.kind === 'native' && n4.displayPdf === null);

  const n5 = await normalizeFile(Buffer.from([0, 1, 2]), 'clip.mp4');
  check('A/V stays native (never text-extracted)', n5.kind === 'native' && n5.metadata.media === true);

  const eml = Buffer.from(
    'From: Alice Counsel <alice@firm.com>\r\nTo: bob@client.com\r\nCc: carol@client.com\r\n' +
    'Subject: Privileged - draft\r\n indemnity language\r\nDate: Tue, 4 Mar 2025 10:00:00 -0500\r\n' +
    '\r\nBody here.\r\n');
  const n6 = await normalizeFile(eml, 'msg.eml');
  check('EML headers parsed', n6.metadata.author?.includes('alice@firm.com')
    && n6.metadata.subject === 'Privileged - draft indemnity language'
    && n6.metadata.cc === 'carol@client.com');
}

// --- util --------------------------------------------------------------------
check('formatBates', formatBates('LIT_', 7, 1) === 'LIT_0000001' && formatBates('LIT_', 7, 98) === 'LIT_0000098');

console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
