// The bar on a Vault row reads the worker's own progress note (lib/ingest-
// progress.mjs): page fractions out of the OCR loop's sentences, stages laid
// end to end, the worker's stage integer kept as a floor, and a retry note
// never mistaken for a page count. Pure; no network, no database.
//   node --test scripts/_test-ingest-progress.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readIngestProgress, parseProgressNote, INGEST_WHY, INGEST_WHY_SHORT,
} from '../lib/ingest-progress.mjs';

// The sentences the worker actually writes (lib/ocr-protocol.mjs,
// lib/ingest-core.mjs, worker/discovery-worker.mjs), verbatim in shape.
const TEXTRACT_MID = 'OCR via AWS Textract (us-east-1) 120/318 pages';
const TEXTRACT_FAULT = 'OCR via AWS Textract (us-east-1) 121/318 pages (page 216 not read: throttled)';
const GEMINI_OPEN = 'OCR via gemini-3.8-flash: 318 page(s) in 40 window(s)';
const MIXED_OPEN = 'Running OCR on 40 of 318 page(s) (the rest have a text layer)';
const OCR_DONE = 'OCR read 318 of 318 page(s)';
const CHUNKING = 'Chunking 318 page(s)';
const EMBEDDING = 'Embedding 711 passages';
const DOWNLOADING = 'Downloading Anthropic S-1.pdf';
const RETRY = 'Attempt 1 of 3 failed — OCR timed out; retrying in 5 minutes';

test('the note parser reads each sentence the worker writes', () => {
  assert.deepEqual(parseProgressNote(TEXTRACT_MID), { done: 120, total: 318 });
  assert.deepEqual(parseProgressNote(TEXTRACT_FAULT), { done: 121, total: 318 });
  assert.deepEqual(parseProgressNote(GEMINI_OPEN), { done: 0, total: 318 });
  assert.deepEqual(parseProgressNote(MIXED_OPEN), { done: 0, total: 40, pageCount: 318 });
  assert.deepEqual(parseProgressNote(OCR_DONE), { done: 318, total: 318 });
  assert.deepEqual(parseProgressNote(CHUNKING), { pageCount: 318 });
  assert.deepEqual(parseProgressNote(EMBEDDING), { passages: 711 });
  assert.equal(parseProgressNote(DOWNLOADING), null);
  assert.equal(parseProgressNote('Extracting text'), null);
  assert.equal(parseProgressNote(null), null);
  assert.equal(parseProgressNote(42), null);
});

test('a retry note is never read as a page count', () => {
  assert.equal(parseProgressNote(RETRY), null);
  const r = readIngestProgress({ stage: 'extracting', note: RETRY, attempts: 2, progress: 20 });
  assert.equal(r.pages, null);
  assert.equal(r.retrying, true);
  assert.match(r.label, /^Retrying — /);
  assert.equal(r.indeterminate, true);
});

test('mid-OCR on a scan: the page fraction moves the bar across the extraction span', () => {
  const r = readIngestProgress({ stage: 'extracting', progress: 20, note: TEXTRACT_MID, pageCount: 318 });
  assert.deepEqual(r.pages, { done: 120, total: 318 });
  assert.equal(r.label, 'OCR: 120 of 318 pages read');
  assert.equal(r.indeterminate, false);
  assert.equal(r.retrying, false);
  assert.equal(r.detail, TEXTRACT_MID);
  // 6 + 66 * 120/318 ≈ 31, above the worker's floor of 20.
  assert.ok(r.pct > 25 && r.pct < 40, `pct ${r.pct}`);
  const later = readIngestProgress({ stage: 'extracting', progress: 20, note: 'OCR via AWS Textract (us-east-1) 300/318 pages' });
  assert.ok(later.pct > r.pct, 'more pages read = further along');
  assert.ok(later.pct < 72, 'extraction never claims the chunking span');
});

test('the opening line of a pass counts the pages but none read yet', () => {
  const r = readIngestProgress({ stage: 'extracting', progress: 20, note: GEMINI_OPEN });
  assert.deepEqual(r.pages, { done: 0, total: 318 });
  assert.equal(r.label, 'Reading 318 scanned pages');
  assert.equal(r.indeterminate, false);
  assert.equal(r.pct, 20, 'the worker floor holds until the fraction passes it');
});

test('a mixed document: the fraction is over the scanned pages, the page count is the document\'s', () => {
  const r = readIngestProgress({ stage: 'extracting', note: MIXED_OPEN });
  assert.deepEqual(r.pages, { done: 0, total: 40 });
  assert.equal(r.label, 'Reading 40 scanned pages');
});

test('the worker integer is a floor, never a ceiling', () => {
  const noNote = readIngestProgress({ stage: 'extracting', progress: 20, note: 'Extracting text' });
  assert.equal(noNote.pct, 20);
  assert.equal(noNote.label, 'Extracting text');
  assert.equal(noNote.indeterminate, true);
  const ocrWord = readIngestProgress({ stage: 'extracting', progress: 20, note: 'Scanned image — running OCR' });
  assert.equal(ocrWord.label, 'Running OCR');
  const high = readIngestProgress({ stage: 'extracting', progress: 99, note: TEXTRACT_MID });
  assert.equal(high.pct, 99, 'capped below ready');
});

test('the later stages sit after extraction and say what they do', () => {
  const ch = readIngestProgress({ stage: 'chunking', progress: 55, note: CHUNKING });
  assert.equal(ch.label, 'Splitting 318 pages into passages');
  assert.ok(ch.pct >= 72 && ch.pct < 82, `pct ${ch.pct}`);
  const chNoCount = readIngestProgress({ stage: 'chunking', note: null });
  assert.equal(chNoCount.label, 'Splitting into passages');
  const em = readIngestProgress({ stage: 'embedding', progress: 75, note: EMBEDDING, pageCount: 318 });
  assert.equal(em.label, 'Indexing 711 passages for search');
  assert.ok(em.pct >= 82 && em.pct <= 99, `pct ${em.pct}`);
  const one = readIngestProgress({ stage: 'embedding', note: 'Embedding 1 passage' });
  assert.equal(one.label, 'Indexing 1 passage for search');
});

test('before the pipeline starts: queued, then fetching; nothing is claimed', () => {
  const q = readIngestProgress({ stage: 'pending', note: null });
  assert.equal(q.label, 'Queued');
  assert.equal(q.indeterminate, true);
  assert.ok(q.pct <= 3, `pct ${q.pct}`);
  const d = readIngestProgress({ stage: 'pending', progress: 5, note: DOWNLOADING });
  assert.equal(d.label, 'Fetching the file');
  assert.ok(d.pct >= 3 && d.pct <= 6, `pct ${d.pct}`);
  const nothing = readIngestProgress();
  assert.equal(nothing.label, 'Queued');
  assert.equal(nothing.detail, null);
});

test('ready is 100 and says so, whatever the last note was', () => {
  const r = readIngestProgress({ stage: 'ready', progress: 99, note: '711 passages indexed (text-embedding-3-small)' });
  assert.equal(r.pct, 100);
  assert.equal(r.label, 'Ready');
  assert.equal(r.indeterminate, false);
});

test('a stage this table does not know lands in the long middle, never off the bar', () => {
  const r = readIngestProgress({ stage: 'transcribing', progress: 40, note: 'Transcribing audio' });
  assert.ok(r.pct >= 6 && r.pct <= 99, `pct ${r.pct}`);
  assert.equal(r.label, 'Extracting text');
});

test('the bar never runs backwards within a stage as pages accumulate', () => {
  let last = -1;
  for (const done of [0, 1, 40, 120, 200, 318]) {
    const r = readIngestProgress({ stage: 'extracting', progress: 20, note: `OCR via AWS Textract (us-east-1) ${done}/318 pages` });
    assert.ok(r.pct >= last, `${done} pages: ${r.pct} < ${last}`);
    last = r.pct;
  }
  assert.equal(last, 72, 'every page read = the top of the extraction span, where chunking begins');
});

test('the explanation names the three things that take the time', () => {
  for (const s of [INGEST_WHY, INGEST_WHY_SHORT]) {
    assert.match(s, /read/i);
    assert.match(s, /OCR/);
    assert.match(s, /index/i);
  }
  assert.match(INGEST_WHY, /opened and read while/);
  assert.ok(INGEST_WHY_SHORT.length < 60, 'fits beside the bar');
});
