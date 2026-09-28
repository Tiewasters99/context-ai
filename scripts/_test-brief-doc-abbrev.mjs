// node --test --import ./scripts/_node-src-loader.mjs scripts/_test-brief-doc-abbrev.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocumentCite } from '../src/lib/brief/doc-abbrev.ts';

test('OATH Pet. at 4 → the words a name carries, and the page', () => {
  const c = parseDocumentCite('OATH Pet. at 4');
  assert.ok(c.isDocument);
  assert.deepEqual(c.words, [['OATH'], ['Petition', 'Petitioner', 'Pet']]);
  assert.equal(c.page, 4);
  assert.equal(c.paragraph, null);
});

test('Bushell Aff. ¶ 12 → Affidavit or Affirmation, paragraph 12', () => {
  const c = parseDocumentCite('(Bushell Aff. ¶ 12)');
  assert.deepEqual(c.words, [['Bushell'], ['Affidavit', 'Affirmation', 'Aff']]);
  assert.equal(c.paragraph, 12);
  assert.equal(c.page, null);
});

test("Hr'g Tr. 33:2–5 and a dated deposition", () => {
  const c = parseDocumentCite("Hr’g Tr. 33:2–5");
  assert.deepEqual(c.words, [['Hearing', 'Hr’g'], ['Transcript', 'Tr']]);
  assert.equal(c.page, 33);
  const d = parseDocumentCite('De Camara Dep. (Mar. 4, 2026) at 17');
  assert.deepEqual(d.words, [['De'], ['Camara'], ['Deposition', 'Dep']]);
  assert.equal(d.page, 17);
});

test('words that name no court document are not a document cite', () => {
  const c = parseDocumentCite('the realities of litigation');
  assert.equal(c.isDocument, false);
  assert.equal(parseDocumentCite('at 4'), null);
});
