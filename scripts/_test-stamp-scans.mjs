// Regression checks for the stamp-only scan defect (2026-09-18): two scanned
// DeCamara orders (ECF 53, ECF 58) were stored "ready" with one passage each
// holding only the CM/ECF header stamp, page_count 1 for 2-page PDFs, and
// ingest_document refused to re-run them. What must hold now:
//   - a stamp is recognised as a stamp, and never counts as content;
//   - page_count is the PDF's own page count, whatever the extractor returned;
//   - a CM/ECF-stamped scan routes to OCR, its body text is indexed, page_count
//     matches the PDF, and the row records that OCR read it (ingest_outcome);
//   - OCR reading nothing on a stamped filing is "awaiting OCR", not "ready";
//   - a typed filing with the same stamps is untouched (no OCR, text layer);
//   - a ready document can be re-run, swapping text in, never wiping it first;
//   - ingest_document takes force: true and keeps the row searchable meanwhile.
// No network (OCR and embeddings are stubs) and no database (an in-memory fake).
// Run: node scripts/_test-stamp-scans.mjs
import assert from 'node:assert';
import { PDFDocument } from 'pdf-lib';
import {
  extractPages, pagesNeedingOcr, planPdfOcr, processDocument, fitToPageCount, ingestOutcome, compactPages,
} from '../lib/ingest-core.mjs';
import { isStampOnlyText, isStampLine, contentChars, stampedPageCount } from '../lib/court-stamps.mjs';
import { reprocessInPlace } from '../lib/reprocess.mjs';
import { handleIngestDocument } from '../lib/mcp-core.mjs';
import { buildPdf, proseLines, stampedScanPdf, ecfStamp } from './_fixtures-ingest.mjs';
import { fakeSupabase, stubEmbeddings } from './_fake-supabase.mjs';

let n = 0;
const ok = (msg) => { n++; console.log(`  ok  ${msg}`); };
const restoreFetch = stubEmbeddings();

const MATTER = '00000000-0000-4000-8000-000000000001';
const DOC = '00000000-0000-4000-8000-0000000000d0';
const seed = (row = {}, passages = []) => fakeSupabase({
  matterspaces: [{ id: MATTER, parent_matterspace_id: null, ai_tier: 'A', name: 'Test' }],
  documents: [{ id: DOC, matterspace_id: MATTER, source_filename: 'Order.pdf', witness_name: null, metadata: {}, processing_status: 'pending', storage_path: `${MATTER}/${DOC}/Order.pdf`, ...row }],
  passages,
});
const pageCountOf = async (buf) => (await PDFDocument.load(buf)).getPageCount();
const passagesOf = (db) => db.tables.passages.filter((p) => p.document_id === DOC);
const docOf = (db) => db.tables.documents.find((d) => d.id === DOC);
const run = (db, fileBuf, ocr) => processDocument(db, { documentId: DOC, fileBuf, ext: '.pdf', openaiApiKey: 'sk-test', ocr });

// --- what a stamp is -----------------------------------------------------------
{
  const cases = [
    [`${ecfStamp(1, 2)}\n\n${ecfStamp(2, 2)}`, true],                      // the May 2026 shape: two pages' stamps on one "page"
    ['Case 2:25-cv-02287-MAK     Document 53     Filed 02/25/26     Page 1 of 2', true],
    ['Case: 26-2097    Document: 12    Page: 1    Date Filed: 09/01/2026', true],
    ['Case 1:23-cv-01234 Document 45 Filed 01/02/24 Page 6 of 7 PageID #: 567', true],
    ['Case 4:24-cv-00988-P     Document 147     Filed 12/02/25      Page 1 of 3     PageID 3574', true],
    ['FILED: NEW YORK COUNTY CLERK 01/02/2026 10:00 AM INDEX NO. 123/2026\nNYSCEF DOC. NO. 5 RECEIVED NYSCEF: 01/02/2026', true],
    ['Case 2:25 ev 02287 MAK Document 73 Filed 04/02/26 Page 1 of 1\nIN THE UNITED STATES DISTRICT COURT', false], // OCR'd page: real text
    ['Case 2:25-cv-02287-MAK Document 53 Filed 02/25/26 Page 1 of 2\nORDER', false],
    ['Page 3', false],
    ['Case law is clear that the movant must show prejudice.', false],
    ['', false],
  ];
  for (const [text, want] of cases) assert.strictEqual(isStampOnlyText(text), want, `isStampOnlyText(${JSON.stringify(text.slice(0, 50))})`);
  assert(isStampLine('Page 2 of 7 PageID #: 88'));
  assert.strictEqual(stampedPageCount(`${ecfStamp(1, 2)}\n${ecfStamp(2, 2)}`), 2);
  assert.strictEqual(contentChars([{ text: ecfStamp(1, 2) }, { text: ecfStamp(2, 2) }]), 0);
  const typed = `${ecfStamp(1, 1)}\n${proseLines(1).join('\n')}`;
  assert.strictEqual(contentChars([{ text: typed }]), typed.trim().length, 'a typed page with a stamp counts in full');
  ok('stamps: district, appellate, PageID, NYSCEF recognised; an OCR\'d page, a stamp plus one word, a bare page number and prose are not; stamps count zero content, typed pages count in full');
}

// --- page_count follows the PDF --------------------------------------------------
{
  const two = [{ pageNumber: 1, text: 'a' }, { pageNumber: 2, text: 'b' }];
  assert.strictEqual(fitToPageCount(two, 2), two, 'agreeing list is returned as is');
  assert.deepStrictEqual(fitToPageCount([{ pageNumber: 1, text: 'stamps of both pages' }], 3).map((p) => [p.pageNumber, p.text]),
    [[1, 'stamps of both pages'], [2, ''], [3, '']], 'missing pages are added, empty, numbered on');
  assert.deepStrictEqual(fitToPageCount([...two, { pageNumber: 3, text: '  ' }], 2).map((p) => p.text), ['a', 'b'], 'an empty trailing split is dropped');
  assert.deepStrictEqual(fitToPageCount([...two, { pageNumber: 3, text: 'tail' }], 2).map((p) => p.text), ['a', 'b\ntail'], 'text past the last page is folded in, never dropped');
  assert.strictEqual(fitToPageCount(two, null), two, 'no count, no change');
  assert.strictEqual(compactPages([8, 1, 2, 3, 5, 7, 3]), '1-3,5,7-8');
  ok('fitToPageCount pads, trims and folds to the PDF\'s page count; compactPages writes ranges');
}

// --- a CM/ECF-stamped scan routes to OCR -------------------------------------------
const scan = await stampedScanPdf({ words: ['tamarind', 'bergamot'] });
{
  const pages = await extractPages(scan, '.pdf');
  assert.strictEqual(pages.length, await pageCountOf(scan));
  assert(pages.every((p) => isStampOnlyText(p.text)), 'the only text layer on each page is its stamp');
  assert.deepStrictEqual(await pagesNeedingOcr(scan, pages), [1, 2]);
  const plan = await planPdfOcr(scan);
  assert.deepStrictEqual(plan, { pageCount: await pageCountOf(scan), ocrPages: [1, 2] });
  ok('stamped scan: every page is stamp-only text, both pages route to OCR, planPdfOcr.pageCount equals the PDF\'s page count');
}

const ocrReads = (words) => async () => words.map((w, i) => ({ pageNumber: i + 1, text: `ORDER\nThe motion concerning the ${w} schedule is granted in part.\nSO ORDERED.` }));

{
  const db = seed();
  const res = await run(db, scan, ocrReads(['tamarind', 'bergamot']));
  const d = docOf(db);
  const ps = passagesOf(db);
  assert.strictEqual(d.processing_status, 'ready');
  assert.strictEqual(d.page_count, 2, 'page_count is the PDF\'s');
  assert(!d.metadata.text_status, 'indexed, not stored-without-text');
  assert(ps.some((p) => p.page_start === 1 && /tamarind/.test(p.text)), 'page 1 body is indexed on page 1');
  assert(ps.some((p) => p.page_start === 2 && /bergamot/.test(p.text)), 'page 2 body is indexed on page 2');
  assert(!ps.some((p) => isStampOnlyText(p.text)), 'no passage is a stamp and nothing else');
  assert.strictEqual(res.passageCount, ps.length);
  const o = d.metadata.ingest_outcome;
  assert.deepStrictEqual({ ocr: o.ocr, text_source: o.text_source, pdf_pages: o.pdf_pages, ocr_pages: o.ocr_pages, ocr_no_text: o.ocr_no_text },
    { ocr: 'read', text_source: 'ocr', pdf_pages: 2, ocr_pages: '1-2', ocr_no_text: null });
  ok('stamped scan end to end: OCR\'d, body text indexed on its own page, page_count 2, ingest_outcome says OCR read pages 1-2');
}

{
  // The provider answers without page markers → parseDelimited gives '' for
  // every page. Before 2026-09-18 the merge kept each stamp and the document
  // went "ready" as stamps.
  const db = seed();
  await run(db, scan, async () => [{ pageNumber: 1, text: '' }, { pageNumber: 2, text: '' }]);
  const d = docOf(db);
  assert.strictEqual(d.processing_status, 'ready');
  assert.strictEqual(d.metadata.text_status, 'ocr_pending', 'awaiting OCR, not searchable');
  assert.strictEqual(passagesOf(db).length, 0, 'the stamps are not indexed as the document');
  assert.match(d.metadata.ocr_pending.reason, /court filing stamp/);
  assert.deepStrictEqual(d.metadata.ocr_pending.pages, [1, 2]);
  assert.strictEqual(d.metadata.ingest_outcome.ocr, 'failed');
  assert.strictEqual(d.page_count, 2);
  ok('OCR reads nothing on a stamped filing → stored as awaiting OCR (retried), zero passages — never "ready" on its stamps');
}

{
  // A stamped order whose back page is blank (no stamp, no text): the blank
  // page must not tip the document into image-only.
  const withBlank = await buildPdf([
    { scan: ['ORDER', 'The juniper motion is denied.'], stamp: ecfStamp(1, 2) },
    { scan: ['SO ORDERED.'], stamp: ecfStamp(2, 2) },
    { blank: true },
  ]);
  const db = seed();
  await run(db, withBlank, async () => [{ pageNumber: 1, text: '' }, { pageNumber: 2, text: '' }, { pageNumber: 3, text: '' }]);
  assert.strictEqual(docOf(db).metadata.text_status, 'ocr_pending');
  assert.deepStrictEqual(docOf(db).metadata.ocr_pending.pages, [1, 2, 3]);
  assert.strictEqual(passagesOf(db).length, 0);
  ok('stamped scan with a blank back page, OCR reads nothing → still awaiting OCR, not image-only');
}

{
  const db = seed();
  await run(db, scan, async () => { throw new Error('gemini 503: simulated outage'); });
  const d = docOf(db);
  assert.strictEqual(d.metadata.text_status, 'ocr_pending');
  assert.strictEqual(passagesOf(db).length, 0, 'an OCR outage no longer indexes the stamps as "typed pages"');
  assert.match(d.metadata.ocr_pending.reason, /simulated outage/);
  ok('OCR outage on a stamped scan → awaiting OCR with the cause, zero passages');
}

{
  // A scan with NO stamp that OCR reads nothing on is still image-only.
  const db = seed();
  await run(db, await buildPdf([{ scan: ['a photograph'] }]), async () => [{ pageNumber: 1, text: '' }]);
  assert.strictEqual(docOf(db).metadata.text_status, 'image_only');
  assert.strictEqual(docOf(db).metadata.ingest_outcome.text_source, 'none');
  ok('an unstamped scan OCR reads nothing on is still image-only (unchanged)');
}

{
  // A born-digital filing carries the same stamp over a real text layer: no
  // OCR, stamp and all kept, recorded as text layer.
  const typed = await buildPdf([
    { text: [ecfStamp(1, 2), ...proseLines(1)] },
    { text: [ecfStamp(2, 2), ...proseLines(2)] },
  ]);
  const db = seed();
  let called = 0;
  await run(db, typed, async () => { called++; return []; });
  const d = docOf(db);
  assert.strictEqual(called, 0, 'OCR is not called for a typed filing');
  assert.strictEqual(d.page_count, 2);
  assert(!d.metadata.text_status);
  assert.deepStrictEqual({ ocr: d.metadata.ingest_outcome.ocr, text_source: d.metadata.ingest_outcome.text_source }, { ocr: 'not_needed', text_source: 'text_layer' });
  assert(passagesOf(db).some((p) => p.text.includes('Document 53') && p.text.length > 200), 'the typed page is indexed whole, stamp included');
  ok('typed filing with CM/ECF stamps: no OCR, text layer indexed as before, outcome text_layer');
}

{
  // Mixed: two typed stamped pages, one scanned stamped exhibit page.
  const mixed = await buildPdf([
    { text: [ecfStamp(1, 3), ...proseLines(1)] },
    { text: [ecfStamp(2, 3), ...proseLines(2)] },
    { scan: ['EXHIBIT', 'The marzipan receipt.'], stamp: ecfStamp(3, 3) },
  ]);
  const db = seed();
  const sent = [];
  await run(db, mixed, async (buf) => { sent.push(await pageCountOf(buf)); return [{ pageNumber: 1, text: 'EXHIBIT\nThe marzipan receipt.' }]; });
  const d = docOf(db);
  assert.deepStrictEqual(sent, [1], 'only the scanned page left the machine');
  assert(passagesOf(db).some((p) => p.page_start === 3 && /marzipan/.test(p.text)));
  assert.deepStrictEqual({ ocr: d.metadata.ingest_outcome.ocr, text_source: d.metadata.ingest_outcome.text_source, ocr_pages: d.metadata.ingest_outcome.ocr_pages }, { ocr: 'read', text_source: 'mixed', ocr_pages: '3' });

  const db2 = seed();
  await run(db2, mixed, async () => [{ pageNumber: 1, text: '' }]);
  const d2 = docOf(db2);
  assert(!d2.metadata.text_status, 'the typed pages are searchable');
  assert.deepStrictEqual(d2.metadata.ocr_pending.pages, [3], 'the stamped scanned page is awaiting OCR, not silently a stamp');
  ok('mixed filing: only the scanned page is OCR\'d (outcome mixed); if OCR reads nothing there, that page is awaiting OCR while the typed pages index');
}

// --- a ready document can be re-run, by swapping --------------------------------------
{
  // The May 2026 state: ready, page_count 1, one passage holding both stamps.
  const stale = { id: '00000000-0000-4000-8000-0000000000a1', document_id: DOC, matterspace_id: MATTER, page_start: 1, page_end: 1, sequence_number: 0, text: `${ecfStamp(1, 2)}\n\n${ecfStamp(2, 2)}`, created_at: '2026-05-25T20:01:13.855592+00:00' };
  const db = seed({ processing_status: 'ready', page_count: 1, ingested_at: '2026-05-25T20:01:13.865+00:00' }, [stale]);
  const res = await reprocessInPlace(db, DOC, () => run(db, scan, ocrReads(['tamarind', 'bergamot'])));
  const d = docOf(db);
  assert.strictEqual(res.replacedPassages, 1);
  assert(!passagesOf(db).some((p) => p.id === stale.id), 'the stamp-only passage is gone');
  assert(passagesOf(db).some((p) => /tamarind/.test(p.text)) && passagesOf(db).some((p) => /bergamot/.test(p.text)));
  assert.strictEqual(d.page_count, 2);
  assert.strictEqual(d.metadata.reprocess.ok, true);
  assert.strictEqual(d.metadata.ingest_outcome.text_source, 'ocr');
  ok('re-run of the May 2026 state: stamp passage replaced by the OCR\'d body, page_count 1 → 2, re-run recorded');
}

{
  // A re-run that fails after writing leaves the document as it was.
  const good = { id: '00000000-0000-4000-8000-0000000000a2', document_id: DOC, matterspace_id: MATTER, page_start: 1, page_end: 1, sequence_number: 0, text: 'Good indexed text.', created_at: '2026-06-01T00:00:00.000000+00:00' };
  const db = seed({ processing_status: 'ready', page_count: 4, ingested_at: '2026-06-01T00:00:00Z', metadata: { keep: 'me' } }, [good]);
  await assert.rejects(reprocessInPlace(db, DOC, async () => {
    await db.from('documents').update({ processing_status: 'embedding', page_count: 9 }).eq('id', DOC);
    await db.from('passages').insert([{ document_id: DOC, matterspace_id: MATTER, page_start: 1, page_end: 1, sequence_number: 0, text: 'half-written' }]);
    throw new Error('embed 429: simulated');
  }), /simulated/);
  const d = docOf(db);
  assert.deepStrictEqual(passagesOf(db).map((p) => p.text), ['Good indexed text.'], 'old passages kept, partial new ones removed');
  assert.deepStrictEqual({ s: d.processing_status, pc: d.page_count, keep: d.metadata.keep }, { s: 'ready', pc: 4, keep: 'me' }, 'row restored');
  assert.strictEqual(d.metadata.reprocess.ok, false);
  assert.match(d.metadata.reprocess.error, /simulated/);
  ok('failed re-run: the document keeps its passages and its row; the failure is recorded on it');
}

{
  // A forced run whose worker died mid-way is reclaimed with the row at
  // 'embedding', the originals still there and a crashed run's partial
  // passages after them. The worker swaps every forced job, so: success
  // removes both; failure keeps the originals.
  const original = { id: '00000000-0000-4000-8000-0000000000b1', document_id: DOC, matterspace_id: MATTER, page_start: 1, page_end: 1, sequence_number: 0, text: 'Original indexed text.', created_at: '2026-06-01T00:00:00.000000+00:00' };
  const partial = { id: '00000000-0000-4000-8000-0000000000b2', document_id: DOC, matterspace_id: MATTER, page_start: 1, page_end: 1, sequence_number: 0, text: 'half of a crashed run', created_at: '2026-09-18T10:00:00.000000+00:00' };
  const crashed = () => seed({ processing_status: 'embedding', page_count: 1, metadata: {} }, [original, partial]);

  const db = crashed();
  await reprocessInPlace(db, DOC, () => run(db, scan, ocrReads(['tamarind', 'bergamot'])));
  const texts = passagesOf(db).map((p) => p.text).join(' | ');
  assert(!texts.includes('Original indexed text.') && !texts.includes('half of a crashed run') && /tamarind/.test(texts), 'success replaces the originals and the crashed partials');
  assert.strictEqual(docOf(db).processing_status, 'ready');

  const db2 = crashed();
  await assert.rejects(reprocessInPlace(db2, DOC, async () => { throw new Error('embed 429: simulated'); }), /simulated/);
  assert(passagesOf(db2).some((p) => p.text === 'Original indexed text.'), 'failure keeps the originals');
  ok('forced run reclaimed after a crash: success replaces originals and partials; failure keeps the originals');
}

// --- ingest_document force -----------------------------------------------------------
{
  const db = seed({ processing_status: 'ready', page_count: 1 });
  db.tables.processing_jobs = [];
  const plain = await handleIngestDocument(db, { document_id: DOC });
  assert.strictEqual(plain.status, 'ready');
  assert.match(plain.note, /force: true/, 'the refusal names the way out');
  assert.strictEqual(db.tables.processing_jobs.length, 0);

  const forced = await handleIngestDocument(db, { document_id: DOC, force: true });
  assert.strictEqual(forced.status, 'queued');
  assert.strictEqual(forced.forced, true);
  assert.deepStrictEqual(db.tables.processing_jobs.map((j) => j.payload), [{ document_id: DOC, force: true }]);
  assert.strictEqual(docOf(db).processing_status, 'ready', 'stays searchable while queued');

  const errored = seed({ processing_status: 'error' });
  errored.tables.processing_jobs = [];
  const retry = await handleIngestDocument(errored, { document_id: DOC });
  assert.strictEqual(retry.status, 'queued');
  assert.deepStrictEqual(errored.tables.processing_jobs.map((j) => j.payload), [{ document_id: DOC }], 'an ordinary retry carries no force');
  assert.strictEqual(docOf(errored).processing_status, 'pending');
  ok('ingest_document: ready + no force refuses and names force; force queues a forced job and leaves the row ready; an error retry is unchanged');
}

restoreFetch();
console.log(`\nPASS (${n} checks)`);
