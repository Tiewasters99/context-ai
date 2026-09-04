// Unit checks for containers (Phase 3 of the ingestion plan, 2026-09-04):
// which entries of a .zip are filed and which are skipped, the nested-archive
// and Office-package rules, the flattened unique filenames, and which parts
// of an email count as attachments. No network, no database. Run:
//   node scripts/_test-ingest-containers.mjs
import assert from 'node:assert';
import { listZipEntries, looksLikeZip, ZIP_MAX_FILES } from '../lib/zip-container.mjs';
import { extractEmlAttachments } from '../lib/eml-attachments.mjs';
import { containerSummary, safeFilename, stripExt } from '../lib/container-unpack.mjs';
import { extractPages, sniffExtension, needsWorkerIngest } from '../lib/ingest-core.mjs';
import { TEXT_STATUS, describeTextStatus, checkUpload } from '../lib/ingest-formats.mjs';
import { classifyTextStatus, TEXT_STATUS_CLASSES, describe } from '../lib/ingest-triage.mjs';
import { zipFixture, archiveFixture, emlFixture, textPdf } from './_fixtures-ingest.mjs';

let n = 0;
const ok = (msg) => { n++; console.log(`  ok  ${msg}`); };

// --- archives ----------------------------------------------------------------
{
  const zip = await archiveFixture({ tag: 'unit' });
  assert(looksLikeZip(zip), 'PK magic');
  assert.strictEqual(sniffExtension(zip), '.zip', 'an extensionless archive sniffs as .zip');
  assert(needsWorkerIngest('.zip', 1000), 'every .zip goes to the worker');
  const r = await listZipEntries(zip);
  assert.strictEqual(r.ooxml, null);
  assert.strictEqual(r.truncated, false);
  const names = r.entries.map((e) => e.filename).sort();
  assert.deepStrictEqual(names, ['Deposition_of_J._Walters.pdf', 'Exhibit_C.pdf', 'notes.txt']);
  const inner = r.entries.find((e) => e.filename === 'Exhibit_C.pdf');
  assert.strictEqual(inner.entry, 'Transcript Files/inner.zip/nested/Exhibit C.pdf', 'nested entries keep their full path');
  assert.strictEqual(inner.title, 'Exhibit C');
  const pages = await extractPages(inner.bytes, '.pdf');
  assert.match(pages[0].text, /vermilion/, 'nested bytes are the real file');
  assert.deepStrictEqual(r.skipped.map((s) => s.reason).sort(), ['hidden or system file', 'hidden or system file']);
  ok('archive: three files filed (one from a nested zip), Mac junk skipped, paths kept, titles from basenames');
}

{
  const zip = await zipFixture({
    'a/Exhibit A.pdf': await textPdf(['A one']),
    'b/Exhibit A.pdf': await textPdf(['A two, a different size entirely']),
    'c/Exhibit A.pdf': await textPdf(['A three, different again and longer still']),
    'empty.txt': Buffer.alloc(0),
  });
  const r = await listZipEntries(zip);
  assert.deepStrictEqual(r.entries.map((e) => e.filename), ['Exhibit_A.pdf', 'b_Exhibit_A.pdf', 'c_Exhibit_A.pdf']);
  assert.deepStrictEqual(r.skipped, [{ entry: 'empty.txt', reason: 'empty file' }]);
  ok('archive: same basename in three folders → unique filenames by parent folder; empty entries skipped');
}

{
  const many = {};
  for (let i = 0; i < ZIP_MAX_FILES + 3; i++) many[`f${String(i).padStart(4, '0')}.txt`] = Buffer.from(`line ${i}`);
  const r = await listZipEntries(await zipFixture(many));
  assert.strictEqual(r.entries.length, ZIP_MAX_FILES);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.skipped.length, 3);
  assert.match(r.skipped[0].reason, /cap/);
  ok(`archive: capped at ${ZIP_MAX_FILES} files, the rest recorded as skipped`);
}

{
  const deepest = await zipFixture({ 'd4.txt': Buffer.from('four deep') });
  const deep = await zipFixture({ 'deepest.zip': deepest, 'd3.txt': Buffer.from('three deep') });
  const mid = await zipFixture({ 'deep.zip': deep, 'd2.txt': Buffer.from('two deep') });
  const top = await zipFixture({ 'mid.zip': mid, 'd1.txt': Buffer.from('one deep') });
  const r = await listZipEntries(top);
  assert.deepStrictEqual(r.entries.map((e) => e.filename).sort(), ['d1.txt', 'd2.txt', 'd3.txt']);
  assert.strictEqual(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /too deep/);
  assert.strictEqual(r.skipped[0].entry, 'mid.zip/deep.zip/deepest.zip');
  ok('archive: an archive inside an archive inside an archive still reads; the fourth level is skipped as too deep');
}

{
  // An Office package is a zip; it must be recognised, not unpacked.
  const docx = await zipFixture({
    '[Content_Types].xml': Buffer.from('<Types/>'),
    'word/document.xml': Buffer.from('<w:document/>'),
    '_rels/.rels': Buffer.from('<Relationships/>'),
  });
  const r = await listZipEntries(docx);
  assert.strictEqual(r.ooxml, '.docx');
  assert.deepStrictEqual(r.entries, []);
  const xlsx = await zipFixture({ '[Content_Types].xml': Buffer.from(''), 'xl/workbook.xml': Buffer.from('') });
  assert.strictEqual((await listZipEntries(xlsx)).ooxml, '.xlsx');
  await assert.rejects(() => listZipEntries(Buffer.from('PK not really a zip file at all')), 'garbage throws');
  ok('archive: an Office package reports its real format and is not unpacked; garbage bytes throw');
}

// --- email attachments ---------------------------------------------------------
{
  const eml = await emlFixture({ tag: 'unit' });
  const pages = await extractPages(eml, '.eml');
  assert.match(pages[0].text, /ochre folder/, 'the message body is still extracted by eml-extract');
  const { attachments, skipped, subject } = await extractEmlAttachments(eml);
  assert.match(subject, /Initial disclosures unit/);
  const names = attachments.map((a) => a.filename).sort();
  assert.deepStrictEqual(names, ['2025.04.17_-_Second_Amended_Initial_Disclosures.pdf', 'Forwarded_scheduling_note_unit.eml']);
  const pdf = attachments.find((a) => /Disclosures/.test(a.filename));
  assert.strictEqual(pdf.title, '2025.04.17 - Second Amended Initial Disclosures');
  assert.match((await extractPages(pdf.bytes, '.pdf'))[0].text, /magenta ledger/, 'attachment bytes decode to the real PDF');
  const nested = attachments.find((a) => /\.eml$/.test(a.filename));
  assert.match((await extractPages(nested.bytes, '.eml'))[0].text, /teal calendar/, 'an attached message is filed as .eml');
  assert.deepStrictEqual(skipped.map((s) => s.reason), ['inline image']);
  ok('email: the PDF and the attached message are attachments; the cid signature image is not');
}

// --- summaries, names, words ------------------------------------------------------
{
  const s = containerSummary({ folder: { id: 'f1', name: 'Job 1' }, children: [{ id: 'c1', title: 'One', filename: 'one.pdf' }], notes: [] }, { count: 2, skipped: [{ entry: 'x', reason: 'empty file' }] });
  assert.strictEqual(s.entry_count, 2);
  assert.strictEqual(s.folder_name, 'Job 1');
  assert.deepStrictEqual(s.children, [{ id: 'c1', title: 'One', filename: 'one.pdf' }]);
  assert.strictEqual(s.skipped.length, 1);
  assert(!('notes' in s));
  assert.strictEqual(safeFilename('Job 2490375 - Transcript Files (1).pdf'), 'Job_2490375_-_Transcript_Files_1_.pdf');
  assert.strictEqual(stripExt('a.b.pdf'), 'a.b');
  ok('containerSummary and filename helpers');

  assert.strictEqual(TEXT_STATUS.ARCHIVE, 'archive');
  assert.match(describeTextStatus('archive').label, /Archive unpacked/);
  assert.strictEqual(classifyTextStatus('archive'), 'stored_archive');
  assert(TEXT_STATUS_CLASSES.includes('stored_archive'));
  assert.strictEqual(describe('stored_archive').severity, 'benign');
  assert.strictEqual(checkUpload({ name: 'prod.zip', size: 10 }), null);
  ok('words: archive is a benign stored reason; .zip is accepted on every path');
}

console.log(`\nPASS (${n} checks)`);
