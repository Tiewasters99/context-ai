// node --test --import ./scripts/_node-src-loader.mjs scripts/_test-brief-roa-cite.mjs
// Fifth Circuit record cites → the EROA page carrying the clerk's stamp.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoaCite, docketOfCaption, stampedPages } from '../src/lib/brief/roa-cite.ts';

test('parse: the forms a Fifth Circuit brief uses', () => {
  assert.deepEqual(parseRoaCite('ROA.1527'), { docket: null, first: 1527, last: null });
  assert.deepEqual(parseRoaCite('ROA.1527.'), { docket: null, first: 1527, last: null });
  assert.deepEqual(parseRoaCite('ROA.1506–07, 1510'), { docket: null, first: 1506, last: 1507 });
  assert.deepEqual(parseRoaCite('ROA.583–85.'), { docket: null, first: 583, last: 585 });
  assert.deepEqual(parseRoaCite('see ROA.25-20513.1527'), { docket: '25-20513', first: 1527, last: null });
  assert.deepEqual(parseRoaCite('ROA 1821'), { docket: null, first: 1821, last: null });
  assert.equal(parseRoaCite('A-10'), null);
  assert.equal(parseRoaCite('Broad 12'), null);
});

test('caption: the docket an unnumbered cite belongs to', () => {
  assert.equal(docketOfCaption('IN THE UNITED STATES COURT OF APPEALS FOR THE FIFTH CIRCUIT No. 25-20513 ATKINSON'), '25-20513');
  assert.equal(docketOfCaption('no caption here'), null);
});

test('pages: the stamped page, not an index listing many', () => {
  const titles = new Map([['v5', 'EROA - Pleadings, Vol. 5'], ['v1', 'EROA - Pleadings, Vol. 1']]);
  const rows = [
    { document_id: 'v5', page_start: 24, text: 'text of the order 25-20513.1527', metadata: null },
    { document_id: 'v5', page_start: 23, text: 'text 25-20513.1526', metadata: null },
    { document_id: 'v1', page_start: 3, text: 'Index 25-20513.1500 25-20513.1527 25-20513.1600 25-20513.1700', metadata: null },
    { document_id: 'v5', page_start: 2, text: 'neighbour 25-20513.15270', metadata: null },
  ];
  assert.deepEqual(stampedPages(rows, titles, 1527), [{ documentId: 'v5', title: 'EROA - Pleadings, Vol. 5', docket: '25-20513', page: 24 }]);
  // a transcript's physical page wins over its printed one
  assert.equal(stampedPages([{ document_id: 'v5', page_start: 90, text: '25-20513.42', metadata: { pdf_page: 7 } }], titles, 42)[0].page, 7);
});
