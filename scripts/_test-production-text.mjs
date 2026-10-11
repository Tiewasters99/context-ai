// The four-part production volume: TEXT/ and the fuller load file.
//
//   node scripts/_test-production-text.mjs
//
// Offline. lib/discovery/package-docs.mjs decides what goes in each produced
// document's TEXT/<BEGBATES>.txt; lib/discovery/loadfile.mjs emitDat writes
// the DAT. scripts/_verify-discovery-pipeline.mjs checks the whole package;
// this file pins the text rules one at a time:
//   * a PDF with a text layer reads from it, one form feed per page break;
//   * a scanned page (no text layer) takes the OCR the corpus already holds,
//     and packaging never calls OCR itself;
//   * natives read by content (real .xlsx, .eml), A/V and unknown binaries
//     get an empty file, never their bytes read as text;
//   * the text always has exactly pages-1 form feeds, so page N lines up.
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import XLSX from 'xlsx';
import { documentText, fitPages, passagesToPages, packageDocument } from '../lib/discovery/package-docs.mjs';
import { emitDat, parseDat } from '../lib/discovery/loadfile.mjs';

let n = 0;
const ok = (m) => { n++; console.log(`  PASS  ${m}`); };
const FF = '\f';

async function pdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const p = doc.addPage([612, 792]);
    if (text) p.drawText(text, { x: 72, y: 700, size: 12, font });
  }
  return Buffer.from(await doc.save());
}
const reader = (buf) => async () => buf;
const fail = async () => { throw new Error('must not be read'); };

// fitPages: always exactly `count` slots.
assert.deepEqual(fitPages(['a', 'b'], 3), ['a', 'b', '']);
assert.deepEqual(fitPages(['a', 'b', 'c'], 2), ['a', 'b\nc']);
assert.deepEqual(fitPages([], 1), ['']);
ok('fitPages pads short text and folds extra pages into the last, so N pages -> N-1 form feeds');

// A text-layer PDF.
{
  const buf = await pdf(['Purchase order number 4471 for widgets', 'Delivery schedule for March shipments']);
  const r = await documentText({
    item: { kind: 'display_pdf', original_filename: 'po.pdf' }, pages: 2,
    readDisplay: reader(buf), readNative: fail, corpusPages: async () => { throw new Error('not needed'); },
  });
  assert.equal(r.source, 'text-layer');
  assert.equal(r.text.split(FF).length, 2);
  assert.match(r.text.split(FF)[0], /Purchase order number 4471/);
  assert.match(r.text.split(FF)[1], /Delivery schedule/);
  ok('a text-layer PDF reads page by page from its own text, a form feed between pages');
}

// A scan: page 2 has no text layer; the corpus holds its OCR.
{
  const buf = await pdf(['Cover letter from Dr. Iyer regarding treatment', '']);
  let corpusCalls = 0;
  const r = await documentText({
    item: { kind: 'display_pdf', original_filename: 'scan.pdf' }, pages: 2,
    readDisplay: reader(buf), readNative: fail,
    corpusPages: async () => { corpusCalls++; return new Map([[2, 'OCR TEXT of the handwritten intake form']]); },
  });
  assert.equal(r.source, 'mixed');
  assert.equal(corpusCalls, 1);
  assert.match(r.text.split(FF)[0], /Cover letter/);
  assert.equal(r.text.split(FF)[1], 'OCR TEXT of the handwritten intake form');
  ok("a scanned page with no text layer takes the corpus's existing OCR for that page (looked up once)");

  const none = await documentText({
    item: { kind: 'display_pdf', original_filename: 'photo.pdf' }, pages: 1,
    readDisplay: reader(await pdf([''])), readNative: fail, corpusPages: async () => null,
  });
  assert.equal(none.source, 'none');
  assert.equal(none.text, '');
  ok('an image-only page the corpus never OCR\'d gives an empty text file, reported as "none"');
}

// passagesToPages groups by page_start in sequence order.
{
  const m = passagesToPages([
    { text: 'second half of p1', page_start: 1, sequence_number: 2 },
    { text: 'p2', page_start: 2, sequence_number: 3 },
    { text: 'first half of p1', page_start: 1, sequence_number: 1 },
    { text: 'no page', page_start: null, sequence_number: 0 },
  ]);
  assert.equal(m.get(1), 'no page\nfirst half of p1\nsecond half of p1');
  assert.equal(m.get(2), 'p2');
  ok('corpus passages regroup into pages in sequence order (an unpaged passage counts as page 1)');
}

// Natives: real spreadsheet, real email, A/V, unknown binary.
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Invoice', 'Amount'], ['INV-2291', 18450]]), 'Q1');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Notes'], ['late fee waived']]), 'Notes');
  const xlsx = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const r = await documentText({
    item: { kind: 'native', original_filename: 'ledger.xlsx' }, pages: 1,
    readDisplay: fail, readNative: reader(xlsx),
  });
  assert.equal(r.source, 'native');
  assert.match(r.text, /INV-2291/);
  assert.match(r.text, /late fee waived/);
  ok('a native spreadsheet\'s text file holds its cell contents, every sheet');

  const eml = Buffer.from([
    'From: Priya Patel <priya@example.test>', 'To: Dr. Iyer <iyer@example.test>',
    'Subject: Follow-up appointment', 'Date: Mon, 3 Mar 2025 09:00:00 -0500', '',
    'Please confirm the follow-up for Thursday.', ''].join('\r\n'));
  const e = await documentText({
    item: { kind: 'native', original_filename: 'msg.eml' }, pages: 1, readDisplay: fail, readNative: reader(eml),
  });
  assert.match(e.text, /Follow-up appointment/);
  assert.match(e.text, /confirm the follow-up for Thursday/);
  ok('a native email\'s text file holds its headers and body');

  for (const name of ['clip.mp4', 'call.wav', 'thing.msg', 'archive.zip']) {
    const r2 = await documentText({
      item: { kind: 'native', original_filename: name }, pages: 1,
      readDisplay: fail, readNative: async () => { throw new Error(`${name} must not be read for text`); },
    });
    assert.equal(r2.text, '');
    assert.equal(r2.source, 'none');
  }
  ok('A/V, .msg and archives get an empty text file and are never read as text');

  const broken = await documentText({
    item: { kind: 'native', original_filename: 'broken.docx' }, pages: 1,
    readDisplay: fail, readNative: reader(Buffer.from('PK not really a docx')),
  });
  assert.equal(broken.text, '');
  ok('a native that cannot be read gives an empty text file instead of failing the package');
}

// packageDocument: the three files and the DAT row.
{
  const files = new Map();
  const stamped = await pdf(['stamped page']);
  const display = await pdf(['Monthly statement for account ending 1188']);
  const store = { 's/stamped.pdf': stamped, 's/display.pdf': display };
  const img = await packageDocument({
    item: {
      kind: 'display_pdf', original_filename: 'statement.pdf', bates_first: 'PTL_0000007', bates_last: 'PTL_0000007',
      page_count: 1, display_storage_path: 's/display.pdf', native_storage_path: 's/display.pdf',
      sha256: 'a'.repeat(64), file_size_bytes: display.length, source_metadata: { custodian: 'P. Patel' },
    },
    volumeName: 'VOL001', confidential: true, stampedPath: 's/stamped.pdf',
    read: async (p) => store[p], append: (b, name) => files.set(name, b),
  });
  assert.deepEqual([...files.keys()].sort(), ['VOL001/IMAGES/PTL_0000007.pdf', 'VOL001/TEXT/PTL_0000007.txt']);
  assert.match(files.get('VOL001/TEXT/PTL_0000007.txt').toString('utf8'), /account ending 1188/);
  assert.equal(img.datRow.produced_as, 'IMAGE');
  assert.equal(img.datRow.native_link, '');
  assert.equal(img.datRow.text_link, 'TEXT/PTL_0000007.txt');
  ok('an imaged document: IMAGES/ + TEXT/, no NATIVES/; PRODUCEDAS=IMAGE');

  files.clear();
  const wav = Buffer.from('RIFF....WAVE');
  const nat = await packageDocument({
    item: {
      kind: 'native', original_filename: 'voicemail.wav', bates_first: 'PTL_0000008', bates_last: 'PTL_0000008',
      native_storage_path: 's/native.wav', sha256: 'b'.repeat(64), file_size_bytes: wav.length,
    },
    volumeName: 'VOL001', confidential: false, stampedPath: 's/slip.pdf',
    read: async (p) => ({ 's/slip.pdf': stamped, 's/native.wav': wav })[p], append: (b, name) => files.set(name, b),
  });
  assert.deepEqual([...files.keys()].sort(),
    ['VOL001/IMAGES/PTL_0000008.pdf', 'VOL001/NATIVES/PTL_0000008.wav', 'VOL001/TEXT/PTL_0000008.txt']);
  assert.equal(files.get('VOL001/TEXT/PTL_0000008.txt').length, 0);
  assert.equal(nat.datRow.produced_as, 'NATIVE');
  assert.equal(nat.datRow.native_link, 'NATIVES/PTL_0000008.wav');
  assert.equal(nat.datRow.file_ext, 'WAV');
  ok('a native: slip sheet in IMAGES/, the original in NATIVES/, an (empty) TEXT/ file; PRODUCEDAS=NATIVE');

  // The DAT round-trips, every column present, and a value cannot break a record.
  const dat = emitDat([img.datRow, { ...nat.datRow, subject: 'line one\r\nline two' }]);
  const { fields, records } = parseDat(dat);
  for (const f of ['begbates', 'endbates', 'pages', 'custodian', 'from', 'to', 'cc', 'bcc', 'subject', 'date',
    'filename', 'fileext', 'filesize', 'sha256', 'prodvol', 'producedas', 'nativelink', 'textlink', 'confidentiality']) {
    assert.ok(fields.includes(f), `DAT column ${f}`);
  }
  assert.equal(records.length, 2);
  assert.equal(records[0].confidentiality, 'CONFIDENTIAL');
  assert.equal(records[0].custodian, 'P. Patel');
  assert.equal(records[1].subject, 'line one line two');
  ok('the DAT carries all 19 columns, round-trips, and a line break inside a value cannot split a record');
}

console.log(`\nProduction TEXT/ and load file verified offline: ${n} checks passed.`);
