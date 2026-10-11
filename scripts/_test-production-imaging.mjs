// Word documents and email produced as IMAGES (lib/discovery/office-image.mjs).
//
//   node scripts/_test-production-imaging.mjs
//
// Offline. LibreOffice runs only in the worker's Docker image, so the
// converter is injected here and the plumbing is what is tested:
//   * a Word file or an email becomes a display PDF (kind 'display_pdf') with
//     its page count, and an email keeps its header metadata;
//   * the email page is built from the same text the corpus indexes, HTML-
//     escaped, attachments listed by name;
//   * no LibreOffice, a failed conversion, or an empty file -> produced
//     natively behind a slip sheet, exactly as before, with the reason kept;
//   * spreadsheets, A/V and .msg are never imaged.
// When soffice IS on this machine, one real .docx conversion runs as well.
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { Document, Packer, Paragraph } from 'docx';
import { normalizeFile } from '../lib/discovery/normalize.mjs';
import { emailToHtml, officeAvailable, sofficeToPdf } from '../lib/discovery/office-image.mjs';

let n = 0;
const ok = (m) => { n++; console.log(`  PASS  ${m}`); };

async function blankPdf(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

const calls = [];
const fakeToPdf = async (buf, ext) => { calls.push({ ext, buf }); return blankPdf(ext === '.html' ? 1 : 2); };
const imaging = { available: true, toPdf: fakeToPdf };

const eml = Buffer.from([
  'From: Priya Patel <priya@example.test>',
  'To: Dr. Iyer <iyer@example.test>',
  'Subject: Records <attached> & follow-up',
  'Date: Mon, 3 Mar 2025 09:00:00 -0500',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Please see the attached records before Thursday.',
  '--b1',
  'Content-Type: application/pdf; name="intake-form.pdf"',
  'Content-Disposition: attachment; filename="intake-form.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  'JVBERi0xLjQK',
  '--b1--',
  ''].join('\r\n'));

// Word -> image.
{
  const r = await normalizeFile(Buffer.from('PK fake docx bytes'), 'Engagement Letter.docx', { imaging });
  assert.equal(r.kind, 'display_pdf');
  assert.equal(r.pageCount, 2);
  assert.equal(r.metadata.imaged_from, 'docx');
  assert.equal(calls.at(-1).ext, '.docx');
  for (const name of ['old.doc', 'draft.rtf', 'brief.odt', 'legacy.wpd']) {
    const r2 = await normalizeFile(Buffer.from('x'), name, { imaging });
    assert.equal(r2.kind, 'display_pdf', name);
  }
  ok('a Word file (.docx .doc .rtf .odt .wpd) is imaged: display PDF, its page count, imaged_from recorded');
}

// Email -> image.
{
  const r = await normalizeFile(eml, 'msg.eml', { imaging });
  assert.equal(r.kind, 'display_pdf');
  assert.equal(r.metadata.imaged_from, 'eml');
  assert.match(r.metadata.author, /priya@example\.test/);
  assert.match(r.metadata.subject, /Records/);
  const call = calls.at(-1);
  assert.equal(call.ext, '.html');
  const html = call.buf.toString('utf8');
  assert.match(html, /Records &lt;attached&gt; &amp; follow-up/);
  assert.match(html, /Please see the attached records before Thursday\./);
  assert.match(html, /intake-form\.pdf/);
  assert.doesNotMatch(html, /<attached>/);
  ok('an email is imaged from its header block, body and attachment names, HTML-escaped; header metadata kept');

  const html2 = await emailToHtml(eml);
  assert.match(html2, /<th>From:<\/th>/);
  ok('the email page lays headers out as a From/To/Subject/Date table above the body');
}

// Fallbacks: exactly today's behaviour.
{
  const before = calls.length;
  const off = await normalizeFile(Buffer.from('PK'), 'letter.docx', { imaging: { available: false, toPdf: fakeToPdf } });
  assert.equal(off.kind, 'native');
  assert.equal(off.displayPdf, null);
  assert.equal(calls.length, before);
  const offEml = await normalizeFile(eml, 'msg.eml', { imaging: { available: false } });
  assert.equal(offEml.kind, 'native');
  assert.match(offEml.metadata.author, /priya@example\.test/);
  ok('without LibreOffice a Word file or email is produced natively, as before (headers still parsed)');

  const broken = await normalizeFile(Buffer.from('PK'), 'corrupt.docx', {
    imaging: { available: true, toPdf: async () => { throw new Error('LibreOffice exit 1: source file could not be loaded'); } },
  });
  assert.equal(broken.kind, 'native');
  assert.match(broken.metadata.imaging_error, /could not be loaded/);
  ok('a failed conversion falls back to native and keeps the reason (metadata.imaging_error)');

  const empty = await normalizeFile(Buffer.alloc(0), 'empty.docx', { imaging });
  assert.equal(empty.kind, 'native');
  const noPages = await normalizeFile(Buffer.from('PK'), 'odd.docx', {
    imaging: { available: true, toPdf: async () => Buffer.from('not a pdf') },
  });
  assert.equal(noPages.kind, 'native');
  ok('an empty file is not imaged, and a conversion that yields no readable PDF falls back to native');

  const n0 = calls.length;
  for (const name of ['ledger.xlsx', 'deck.pptx', 'clip.mp4', 'note.msg']) {
    const r = await normalizeFile(Buffer.from('x'), name, { imaging });
    assert.equal(r.kind, 'native', name);
  }
  assert.equal(calls.length, n0);
  ok('spreadsheets, presentations, A/V and .msg are never sent for imaging');
}

// The real thing, where LibreOffice exists (the worker image; not CI or a laptop).
if (officeAvailable()) {
  const docx = await Packer.toBuffer(new Document({
    sections: [{ children: [new Paragraph('Engagement letter for Patel v. Example Corp.')] }],
  }));
  const pdf = await sofficeToPdf(docx, '.docx');
  const pages = (await PDFDocument.load(pdf)).getPageCount();
  assert.ok(pages >= 1);
  ok(`LibreOffice is installed here: a real .docx converted to a ${pages}-page PDF`);
  const html = Buffer.from(await emailToHtml(eml), 'utf8');
  const epdf = await sofficeToPdf(html, '.html');
  assert.ok((await PDFDocument.load(epdf)).getPageCount() >= 1);
  ok('LibreOffice is installed here: a real email converted to PDF');
} else {
  console.log('  SKIP  real LibreOffice conversion (soffice not installed here; runs in the worker image)');
}

console.log(`\nWord/email imaging verified offline: ${n} checks passed.`);
