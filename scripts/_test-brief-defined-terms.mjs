// node --test --import ./scripts/_node-src-loader.mjs scripts/_test-brief-defined-terms.mjs
// Defined terms: "Op. 13" → the document the lawyer said Op. means, at page 13.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchDefinedTerm, parsePin, briefDefinitions, paragraphPage, stampedPageHits, termKey } from '../src/lib/brief/defined-terms.ts';

const terms = [
  { term: 'Op.', kind: 'document', documentId: 'op', title: 'Fifth Circuit Opinion' },
  { term: 'Pet. App.', kind: 'document', documentId: 'app', title: 'Petition Appendix' },
  { term: 'Pet.', kind: 'document', documentId: 'pet', title: 'Petition' },
  { term: 'ROA', kind: 'stamped', matterId: 'eroa', title: 'Electronic Record on Appeal (EROA)' },
];

test('match: the term the highlight starts with, longest first, whole words only', () => {
  assert.equal(matchDefinedTerm('Op. 13', terms).def.documentId, 'op');
  assert.equal(matchDefinedTerm('Op. 13', terms).rest, '13');
  assert.equal(matchDefinedTerm('See Op. 9–10.', terms).rest, '9–10.');
  assert.equal(matchDefinedTerm('(citing Op. 6)', terms).def.documentId, 'op');
  assert.equal(matchDefinedTerm('Pet. App. 23', terms).def.documentId, 'app');
  assert.equal(matchDefinedTerm('Pet. 4', terms).def.documentId, 'pet');
  assert.equal(matchDefinedTerm('ROA.583–85', terms).rest, '583–85');
  assert.equal(matchDefinedTerm('Opposition at 4', terms), null);
  assert.equal(matchDefinedTerm('Opinion 4', terms), null);
  assert.equal(termKey(' Op. '), 'op');
});

test('pin: page, paragraph, stamp', () => {
  assert.deepEqual(parsePin('13'), { number: 13, paragraph: null });
  assert.deepEqual(parsePin('9–10.'), { number: 9, paragraph: null });
  assert.deepEqual(parsePin('at 5'), { number: 5, paragraph: null });
  assert.deepEqual(parsePin('¶¶ 85–89'), { number: null, paragraph: 85 });
  assert.deepEqual(parsePin('583–85'), { number: 583, paragraph: null });
  assert.deepEqual(parsePin(''), { number: null, paragraph: null });
});

test('the brief defines its own terms', () => {
  const text = 'Atkinson filed a Third Amended Complaint (“TAC”) in 2024. The Electronic Record on Appeal ("ROA") holds it. Under the panel opinion (“Op.”) the claim fails.';
  const d = briefDefinitions(text);
  assert.equal(d.get('tac'), 'Third Amended Complaint');
  assert.equal(d.get('roa'), 'Electronic Record on Appeal');
  assert.equal(d.get('op'), 'the panel opinion');
});

test('paragraph: the line a numbered paragraph opens, not a stray number', () => {
  const rows = [
    { document_id: 'tac', page_start: 3, sequence_number: 2, text: 'filed in 2055. The court', metadata: null },
    { document_id: 'tac', page_start: 15, sequence_number: 14, text: 'defendants.  \n55. Atkinson was then', metadata: null },
    { document_id: 'tac', page_start: 37, sequence_number: 36, text: 'harm.   \n155. The County', metadata: null },
  ];
  assert.equal(paragraphPage(rows, 55), 15);
  assert.equal(paragraphPage(rows, 155), 37);
  assert.equal(paragraphPage(rows, 56), null);
});

test('stamp: the page whose head or foot carries the number, not an index', () => {
  const titles = new Map([['v2', 'EROA - Pleadings, Vol. 2'], ['v1', 'EROA - Pleadings, Vol. 1']]);
  const body = 'x'.repeat(400);
  const rows = [
    { document_id: 'v2', page_start: 208, text: body + ' Case 4:22-cv-4315 25-20513.583', metadata: null },
    { document_id: 'v1', page_start: 4, text: 'INDEX 101 150 210 333 401 583 600 702 815 900 ' + body, metadata: null },
    { document_id: 'v1', page_start: 9, text: body.slice(0, 200) + ' paid $583 in fees ' + body, metadata: null },
    { document_id: 'v2', page_start: 30, text: body + ' 25-20513.5830', metadata: null },
  ];
  assert.deepEqual(stampedPageHits(rows, titles, 583), [{ documentId: 'v2', title: 'EROA - Pleadings, Vol. 2', page: 208 }]);
  // Bates
  assert.equal(stampedPageHits([{ document_id: 'p', page_start: 2, text: body + ' DEF000583', metadata: null }], new Map([['p', 'Production']]), 583)[0].page, 2);
});

test('stamp: the clerk\'s stamp outranks the same number in the court\'s header', () => {
  const body = 'x'.repeat(400);
  const titles = new Map([['v1', 'EROA - Pleadings, Vol. 1'], ['v3', 'EROA - Pleadings, Vol. 3']]);
  const rows = [
    { document_id: 'v1', page_start: 3, text: 'Case 4:22-cv-04315 Document 56 Filed 01/02/24 ' + body + ' 25-20513.102', metadata: null },
    { document_id: 'v3', page_start: 9, text: body + ' 25-20513.56', metadata: null },
  ];
  assert.equal(stampedPageHits(rows, titles, 56)[0].documentId, 'v3');
});

test('stamp: a real EROA foot (court header + clerk stamp) is a page, not an index', () => {
  const foot = 'harm. \fCase 4:22-cv-04315     Document 75     Filed on 01/27/25 in TXSD     Page 24 of 43\f25-20513.1527';
  const rows = [{ document_id: 'v5', page_start: 24, text: 'x'.repeat(500) + foot, metadata: null }];
  assert.deepEqual(stampedPageHits(rows, new Map([['v5', 'Vol. 5']]), 1527), [{ documentId: 'v5', title: 'Vol. 5', page: 24 }]);
  const index = 'INDEX ' + [1500, 1510, 1527, 1530, 1600].map((x) => `25-20513.${x}`).join(' ') + ' ' + 'x'.repeat(400) + ' 25-20513.3';
  assert.equal(stampedPageHits([{ document_id: 'v1', page_start: 3, text: index, metadata: null }], new Map([['v1', 'Vol. 1']]), 1527).length, 0);
});

test('stamp: a header-only number is not offered beside a true stamp', () => {
  const body = 'x'.repeat(400);
  const rows = [
    { document_id: 'v1', page_start: 42, text: body + ' Page 3 of 9\f25-20513.56', metadata: null },
    { document_id: 'v2', page_start: 70, text: 'Case 4:22-cv-04315 Document 56 Filed ' + body + '\f25-20513.445', metadata: null },
  ];
  assert.deepEqual(stampedPageHits(rows, new Map([['v1', 'Vol. 1'], ['v2', 'Vol. 2']]), 56).map((h) => h.documentId), ['v1']);
});
