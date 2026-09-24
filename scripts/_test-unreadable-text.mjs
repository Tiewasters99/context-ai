// Unreadable text layers and extension-less web pages — offline.
//   node scripts/_test-unreadable-text.mjs
//
// The two DeCamara defects of 2026-09-24: a browser-printed PDF whose text
// layer is Type 3 glyph codes (Cornell LII's Rule 56), indexed as noise under
// "ready"; and a PACER screen saved with no extension, indexed as HTML source.
import assert from 'node:assert/strict';
import { isUnreadableText, textStats } from '../lib/text-quality.mjs';
import { pagesNeedingOcr, sniffExtension, extractPages } from '../lib/ingest-core.mjs';

let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };

// 1. The verdict.
{
  // What pdf.js / Poppler / MuPDF all returned for Rule 56 (shape reproduced).
  const glyphCodes = '\u0000\u0001\u0001\u0003\u0003\u0004\u0005\u0006\u0005\u0007\u0008\t\u0003\n\u000b\t\u0005\u000c\u0003\r\u000e\u0003\u000f\u0010\u0011\u0010\t\u0003\u0012'.repeat(12);
  // Poppler's rendering of the same page: codes landed on printable ASCII.
  const asciiCodes = '9:;M=>?@>A B>C DE==FCG HEIJ=KA? >C LFC?@FM DE==FCG HEIJ=KA?N O:PQR S:R STUV WTP XYSS:PR ZY[\\SV]Q^ [VWV]XV QTV `b:_S'.repeat(3);
  const prose = 'A party may move for summary judgment, identifying each claim or defense on which summary judgment is sought. The court shall grant summary judgment if the movant shows that there is no genuine dispute as to any material fact and the movant is entitled to judgment as a matter of law.';
  const spanish = 'La parte podrá solicitar que se dicte sentencia sumaria, identificando cada pretensión o defensa respecto de la cual se solicita. El tribunal dictará sentencia si no existe controversia genuina sobre los hechos.';
  const table = 'Revenue 2021 2022 2023\n1,204,331 1,388,002 1,512,440\nCost of goods 611,201 702,334 744,019\nGross margin 593,130 685,668 768,421\nOperating expenses 402,118 431,556 470,003\nNet income 191,012 254,112 298,418\n'.repeat(3);
  const docket = '09/12/2026 23 ORDER reinstating appeal. (ABC) [Entered: 09/12/2026]\n09/15/2026 24 NOTICE of appearance by Coleman on behalf of Appellant. (DEF)\n'.repeat(4);
  assert.equal(isUnreadableText(glyphCodes), true, 'control-character glyph codes');
  assert.equal(isUnreadableText(asciiCodes), true, 'glyph codes that land on printable ASCII');
  assert.equal(isUnreadableText(prose), false, 'English prose');
  assert.equal(isUnreadableText(spanish), false, 'Spanish prose');
  assert.equal(isUnreadableText(table), false, 'a table of figures (the false positive the first rule had)');
  assert.equal(isUnreadableText(docket), false, 'a docket sheet');
  assert.equal(isUnreadableText('Page 1'), false, 'too short to judge — the short-page rule handles it');
  assert(textStats(glyphCodes).controlRatio > 0.5);
  ok('glyph codes (control or ASCII) are unreadable; prose, Spanish, figures, dockets and short text are not');
}

// 2. An unreadable page is OCR'd even with no image on it (a Type 3 page has none).
{
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 3; i++) pdf.addPage([612, 792]);
  const buf = Buffer.from(await pdf.save());
  const typed = 'The court shall grant summary judgment if the movant shows there is no genuine dispute. '.repeat(30);
  const targets = await pagesNeedingOcr(buf, [
    { pageNumber: 1, text: typed },
    { pageNumber: 2, text: '', unreadable: true },   // glyph codes, emptied by the extractor
    { pageNumber: 3, text: '' },                      // a blank page with no image: nothing to read
  ]);
  assert.deepEqual(targets, [2]);
  ok('in a typed document, the unreadable page is OCR\'d and the blank imageless page is not');
}

// 3. A web page saved without an extension is read as HTML — and a PACER screen refused.
{
  const pacer = Buffer.from('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">\n<html><head><title>Case Search</title></head><body><form action="TransportRoom?servlet=CaseSearch.jsp"><script>function CheckCaseNum(){}</script>Case Search. Enter a case number. PACER login.</form></body></html>');
  assert.equal(sniffExtension(pacer), '.html');
  assert.equal(sniffExtension(Buffer.from('﻿  <html><body>Hello</body></html>')), '.html');
  assert.equal(sniffExtension(Buffer.from('Just a line of plain text, nothing more.')), null);
  const plain = await extractPages(Buffer.from('<html><head><title>Memo</title></head><body><p>The meeting is Tuesday.</p><script>x()</script></body></html>'), '.html');
  assert.match(plain[0].text, /The meeting is Tuesday/);
  assert(!/<script|x\(\)/.test(plain[0].text), 'markup and scripts are not indexed');
  ok('an extension-less web page sniffs as .html and is read without its markup');
}

console.log(`\nPASS (${n} checks)`);
