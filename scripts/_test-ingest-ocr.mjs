// Unit checks for per-page OCR (Phase 2 of the ingestion plan, 2026-09-04):
// which pages of a PDF are sent to OCR, how OCR text merges back by page
// number, the record of pages still awaiting OCR and its retry schedule, and
// the triage classes that read it. No network, no database — the OCR hook is
// a stub. Run: node scripts/_test-ingest-ocr.mjs
import assert from 'node:assert';
import {
  extractPages, pagesNeedingOcr, planPdfOcr, mergeOcrPages, subsetPdf, buildOcrPending,
  PAGE_TEXT_MIN_CHARS,
} from '../lib/ingest-core.mjs';
import {
  TEXT_STATUS, describeTextStatus, describeOcrPending, ocrRetryDelayMs, OCR_RETRY_DELAYS_MS,
} from '../lib/ingest-formats.mjs';
import {
  classifyOcrPending, classifyTextStatus, TEXT_STATUS_CLASSES, describe,
} from '../lib/ingest-triage.mjs';
import { buildPdf, proseLines, mixedPdf } from './_fixtures-ingest.mjs';

let n = 0;
const ok = (msg) => { n++; console.log(`  ok  ${msg}`); };

// --- which pages -------------------------------------------------------------
{
  // A brief: typed pages, an exhibit slip sheet (short, no image), a blank
  // back, two scanned exhibit pages, and a typed page that carries a full-page
  // image (a letterhead scan behind typed text).
  const pdf = await buildPdf([
    { text: proseLines(1) },
    { text: proseLines(2) },
    { text: ['EXHIBIT 12'] },
    { blank: true },
    { scan: ['Scanned exhibit page one, the receipt.'] },
    { scan: ['Scanned exhibit page two, the note.'], stamp: 'Case 1:23-cv-01234 Document 45 Filed 01/02/24 Page 6 of 7 PageID #: 567' },
    { image: ['background art'], text: proseLines(7) },
  ]);
  const pages = await extractPages(pdf, '.pdf');
  assert.strictEqual(pages.length, 7);
  assert(pages[0].text.trim().length > PAGE_TEXT_MIN_CHARS, 'typed page is over the floor');
  assert(pages[2].text.trim().length < PAGE_TEXT_MIN_CHARS, 'slip sheet is under the floor');
  assert.strictEqual(pages[4].text.trim().length, 0, 'scanned page has no text layer');
  assert(pages[5].text.includes('Document 45'), 'stamp is real digital text');
  const targets = await pagesNeedingOcr(pdf, pages);
  assert.deepStrictEqual(targets, [5, 6]);
  ok('mostly-typed PDF: OCR only the short pages that carry a page-sized image (not the slip sheet, the blank, or the typed page with art)');

  const plan = await planPdfOcr(pdf);
  assert.deepStrictEqual(plan, { pageCount: 7, ocrPages: [5, 6] });
  ok('planPdfOcr reports the same pages for the inline routers');

  const sub = await subsetPdf(pdf, [5, 6]);
  const subPages = await extractPages(sub, '.pdf');
  assert.strictEqual(subPages.length, 2);
  assert(subPages[1].text.includes('Document 45'), 'subset keeps the pages in order with their content');
  ok('subsetPdf copies exactly the target pages, in order, readable by pdf-parse');
}

{
  const scan = await buildPdf([
    { scan: ['one'], stamp: 'Case 1:23-cv-01234 Document 45 Filed 01/02/24 Page 1 of 3 PageID #: 567' },
    { scan: ['two'], stamp: 'Case 1:23-cv-01234 Document 45 Filed 01/02/24 Page 2 of 3 PageID #: 568' },
    { blank: true },
  ]);
  const pages = await extractPages(scan, '.pdf');
  assert.deepStrictEqual(await pagesNeedingOcr(scan, pages), [1, 2, 3]);
  ok('a document that looks scanned overall (stamps only) sends every short page, blank included — the pre-Phase-2 rule');
}

{
  const typed = await buildPdf([{ text: proseLines(1) }, { text: ['EXHIBIT A'] }, { text: proseLines(3) }]);
  const pages = await extractPages(typed, '.pdf');
  assert.deepStrictEqual(await pagesNeedingOcr(typed, pages), []);
  assert.deepStrictEqual((await planPdfOcr(typed)).ocrPages, []);
  ok('a typed brief with a slip sheet needs no OCR at all — stays on the inline path');
  assert.deepStrictEqual(await pagesNeedingOcr(typed, []), []);
  const garbage = await planPdfOcr(Buffer.from('not a pdf at all'));
  assert.deepStrictEqual(garbage.ocrPages, []);
  assert(garbage.error, 'unparseable bytes report an error and no pages');
  ok('empty page lists and unparseable bytes plan no OCR (the pipeline fails with its own cause)');
}

// --- merge ------------------------------------------------------------------------
{
  const pages = [
    { pageNumber: 1, text: 'typed one' },
    { pageNumber: 2, text: 'Case 1:23 Document 45 Page 2 of 4' },
    { pageNumber: 3, text: '' },
    { pageNumber: 4, text: 'typed four' },
  ];
  const ocr = new Map([[2, '  Scanned text of page two. \n'], [3, '[no legible text]'.replace(/^\[no legible text\]$/i, '')]]);
  const r = mergeOcrPages(pages, ocr, [2, 3]);
  assert.strictEqual(r.pages[0].text, 'typed one');
  assert.strictEqual(r.pages[1].text, 'Scanned text of page two.');
  assert.strictEqual(r.pages[2].text, '', 'a page OCR found nothing on keeps its (empty) text');
  assert.strictEqual(r.pages[3].text, 'typed four');
  assert.strictEqual(r.filled, 1);
  assert.deepStrictEqual(r.stillEmpty, [3]);
  assert.strictEqual(pages[1].text, 'Case 1:23 Document 45 Page 2 of 4', 'input pages are not mutated');
  ok('mergeOcrPages: OCR text replaces a target page only when OCR found words; other pages untouched');

  const keep = mergeOcrPages(pages, new Map([[2, '']]), [2]);
  assert.strictEqual(keep.pages[1].text, 'Case 1:23 Document 45 Page 2 of 4', 'stamp text survives an empty OCR result');
  ok('mergeOcrPages never trades a stamp line for nothing');
}

// --- the record of pages awaiting OCR and its schedule ------------------------------
{
  assert.strictEqual(ocrRetryDelayMs(0), null);
  assert.strictEqual(ocrRetryDelayMs(1), 5 * 60_000);
  assert.strictEqual(ocrRetryDelayMs(5), 6 * 60 * 60_000);
  assert.strictEqual(ocrRetryDelayMs(6), null);
  assert.strictEqual(OCR_RETRY_DELAYS_MS.length, 5);
  ok('retry schedule: 5 min → 15 min → 1 h → 3 h → 6 h, then nothing');

  const t0 = Date.now();
  const first = buildOcrPending(null, { pages: [4, 5], pageCount: 5, reason: 'gemini 503: overloaded\nsecond line' });
  assert.deepStrictEqual(first.pages, [4, 5]);
  assert.strictEqual(first.page_count, 5);
  assert.strictEqual(first.reason, 'gemini 503: overloaded', 'reason is the first line only');
  assert.strictEqual(first.attempts, 1);
  assert(!first.exhausted && !first.held);
  const due = new Date(first.next_retry_at).getTime() - t0;
  assert(due > 4.9 * 60_000 && due < 5.2 * 60_000, `first retry ~5 min out (got ${Math.round(due / 1000)}s)`);
  ok('first failure: attempt 1, retry in 5 minutes');

  const fifth = buildOcrPending({ ocr_pending: { attempts: 4 } }, { pages: [4], pageCount: 5, reason: 'x' });
  assert.strictEqual(fifth.attempts, 5);
  assert(fifth.next_retry_at && !fifth.exhausted, 'fifth failure still schedules (6 h)');
  const sixth = buildOcrPending({ ocr_pending: fifth }, { pages: [4], pageCount: 5, reason: 'x' });
  assert.strictEqual(sixth.attempts, 6);
  assert.strictEqual(sixth.next_retry_at, null);
  assert.strictEqual(sixth.exhausted, true);
  ok('attempts carry across runs; the sixth failure is exhausted with no next retry');

  const held = buildOcrPending({ ocr_pending: { attempts: 2 } }, { pages: [2], pageCount: 3, reason: 'sealed', held: true });
  assert.strictEqual(held.held, true);
  assert.strictEqual(held.attempts, 2, 'a seal refusal is not an attempt');
  assert.strictEqual(held.next_retry_at, null);
  assert(!held.exhausted);
  ok('a sealed refusal is recorded as held: no attempt spent, never scheduled');

  const image = buildOcrPending(null, { pages: null, pageCount: null, reason: 'net' });
  assert.strictEqual(image.pages, null);
  ok('an image whose page list is unknown records pages: null');
}

// --- words ----------------------------------------------------------------------------
{
  assert.strictEqual(TEXT_STATUS.OCR_PENDING, 'ocr_pending');
  assert.match(describeTextStatus('ocr_pending').label, /awaiting OCR/);
  const retrying = describeOcrPending({ pages: [4, 5], page_count: 5, reason: 'gemini 503', attempts: 1, next_retry_at: new Date(Date.now() + 300_000).toISOString() });
  assert.strictEqual(retrying.label, '2 pages awaiting OCR');
  assert.match(retrying.detail, /gemini 503\. Retrying automatically after/);
  const all = describeOcrPending({ pages: [1, 2, 3], page_count: 3, reason: 'r', attempts: 1, next_retry_at: null });
  assert.strictEqual(all.label, 'All 3 pages awaiting OCR');
  const one = describeOcrPending({ pages: [7], page_count: 9, reason: 'r', attempts: 6, exhausted: true });
  assert.strictEqual(one.label, "1 page could not be OCR'd");
  assert.match(one.detail, /Gave up after 6 tries/);
  const sealed = describeOcrPending({ pages: [2, 3], page_count: 4, reason: 'SecureSpace seal', held: true });
  assert.match(sealed.label, /SecureSpace seal/);
  const img = describeOcrPending({ pages: null, page_count: null, reason: 'net', attempts: 1, next_retry_at: null });
  assert.strictEqual(img.label, 'Scanned pages awaiting OCR');
  assert.strictEqual(describeOcrPending(null), null);
  ok('describeOcrPending: counts, all-pages, singular, exhausted, sealed, unknown-pages, null');
}

// --- triage -----------------------------------------------------------------------------
{
  assert.strictEqual(classifyOcrPending({ pages: [1], attempts: 1 }), 'ocr_pending');
  assert.strictEqual(classifyOcrPending({ pages: [1], attempts: 6, exhausted: true }), 'ocr_exhausted');
  assert.strictEqual(classifyOcrPending({ pages: [1], held: true }), 'ocr_held_sealed');
  assert.strictEqual(classifyOcrPending(null), null);
  assert.strictEqual(describe('ocr_pending').severity, 'transient');
  assert.strictEqual(describe('ocr_pending').retryable, false, 'the worker sweep owns the schedule; --fix stays out');
  assert.strictEqual(describe('ocr_exhausted').severity, 'blocking');
  assert.strictEqual(describe('ocr_exhausted').retryable, true);
  assert.strictEqual(describe('ocr_held_sealed').severity, 'benign');
  assert.strictEqual(classifyTextStatus('ocr_pending'), 'ocr_pending');
  assert(!TEXT_STATUS_CLASSES.includes('ocr_pending'), 'ocr_pending is not a muted stored_* class');
  assert(TEXT_STATUS_CLASSES.includes('stored_image_only'));
  ok('triage: retrying is transient, exhausted is blocking and retryable, sealed is benign; ocr_pending never muted');
}

// --- the acceptance fixture itself ------------------------------------------------------
{
  const pdf = await mixedPdf({ tag: 'unit' });
  const pages = await extractPages(pdf, '.pdf');
  assert.strictEqual(pages.length, 5);
  assert.deepStrictEqual(await pagesNeedingOcr(pdf, pages), [4, 5]);
  assert(!pages[3].text.includes('marmalade') && !pages[4].text.includes('quixotic'), 'the markers live only in the pixels');
  ok('mixedPdf: 3 typed + 2 scanned pages; exactly pages 4 and 5 need OCR');
}

console.log(`\nPASS (${n} checks)`);
