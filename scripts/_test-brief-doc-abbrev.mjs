// node --test --import ./scripts/_node-src-loader.mjs scripts/_test-brief-doc-abbrev.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocumentCite } from '../src/lib/brief/doc-abbrev.ts';

test('OATH Pet. at 4 → the words a name carries, and the page', () => {
  const c = parseDocumentCite('OATH Pet. at 4');
  assert.ok(c.isDocument);
  assert.equal(c.words.length, 2);
  assert.equal(c.words[0][0], 'OATH');
  assert.deepEqual(c.words[1], ['Petition', 'Petitioner']);
  assert.equal(c.page, 4);
  assert.equal(c.paragraph, null);
});

test('Bushell Aff. ¶ 12 → Affidavit or Affirmation, paragraph 12', () => {
  const c = parseDocumentCite('(Bushell Aff. ¶ 12)');
  assert.deepEqual(c.words, [['Bushell'], ['Affidavit', 'Affirmation']]);
  assert.equal(c.paragraph, 12);
  assert.equal(c.page, null);
});

test("Hr'g Tr. 33:2–5 and a dated deposition", () => {
  const c = parseDocumentCite("Hr’g Tr. 33:2–5");
  assert.deepEqual(c.words, [['Hearing', 'Hr’g'], ['Transcript']]);
  assert.equal(c.page, 33);
  const d = parseDocumentCite('De Camara Dep. (Mar. 4, 2026) at 17');
  assert.deepEqual(d.words, [['De'], ['Camara'], ['Deposition']]);
  assert.equal(d.page, 17);
});

test('words that name no court document are not a document cite', () => {
  const c = parseDocumentCite('the realities of litigation');
  assert.equal(c.isDocument, false);
  assert.equal(parseDocumentCite('at 4'), null);
});

test('an agency acronym carries its long forms, so a first page can match it', () => {
  const c = parseDocumentCite('OATH Pet. at 4');
  assert.ok(c.words[0].includes('OATH') && c.words[0].includes('Office of Administrative Trials & Hearings'));
  const d = parseDocumentCite('DCWP Compl.');
  assert.ok(d.words[0].includes('Department of Consumer and Worker Protection'));
});

test('TAC ¶ 55 → the Third Amended Complaint by its long name, never "%TAC%"', () => {
  const c = parseDocumentCite('TAC ¶¶ 85–89');
  assert.ok(c.isDocument);
  assert.deepEqual(c.words, [['Third Amended Complaint', 'Thirdamendedcomplaint', 'Third Am. Compl']]);
  assert.equal(c.paragraph, 85);
  assert.ok(parseDocumentCite('TAC').isDocument);
  assert.equal(parseDocumentCite('SAC ¶ 4').words[0][1], 'Secondamendedcomplaint');
});

test('a paragraph list leaves no number ranges behind as name words', () => {
  assert.deepEqual(parseDocumentCite('TAC ¶¶ 52–53, 79–84, 89,').words, [['Third Amended Complaint', 'Thirdamendedcomplaint', 'Third Am. Compl']]);
  assert.equal(parseDocumentCite('TAC ¶¶ 48, 79–84, 87, 89').words.length, 1);
});

test('Op. at 5 → Opinion or Order, never the letters "Op" (in "Openingbrief")', () => {
  const c = parseDocumentCite('Op. at 5');
  assert.ok(c.isDocument);
  assert.deepEqual(c.words, [['Opinion', 'Order']]);
  assert.equal(c.page, 5);
  assert.deepEqual(parseDocumentCite('Reply Br. 3').words[0], ['Reply']);
});

// Eden, 10-21: "Del Biaggio v. Bansen, No. A174647, slip op. at 16" opened the
// MEMO about the case: "No", "A174647" and "slip" were name words, no name had
// them all, and only the memo's first page said "slip op.".
test('a slip-opinion cite: the parties name it, the docket number is set aside, "slip" is no word', () => {
  const c = parseDocumentCite('Del Biaggio v. Bansen, No. A174647, slip op. at 16');
  assert.deepEqual(c.words, [['Del'], ['Biaggio'], ['Bansen']]);
  assert.equal(c.docket, 'A174647');
  assert.equal(c.page, 16);
  assert.ok(c.isDocument);
  assert.deepEqual(c.rank, [['Opinion', 'Order']]);
  const g = parseDocumentCite('Garcia v. City of Monte Vista, No. 25-cv-0769-WJM-KAS, ECF No. 126, at 2');
  assert.equal(g.docket, '25-cv-0769-WJM-KAS');
  assert.deepEqual(g.words, [['Garcia'], ['City'], ['Monte'], ['Vista']]);
  assert.equal(g.page, 2);
  const m = parseDocumentCite('Mercante v. Tarzia, No. 24-CV-8471 (MKB), slip op. at 10');
  assert.equal(m.docket, '24-CV-8471');
  assert.deepEqual(m.words, [['Mercante'], ['Tarzia']]);
});

test('an entry number is not the case number, and a document title still names it', () => {
  const o = parseDocumentCite('Murfreesboro Order, Doc. No. 330, at 5');
  assert.equal(o.docket, null);
  assert.ok(o.words.some((w) => w.includes('Order')));
  const f = parseDocumentCite('Fuller v. Hyde School Order (D. Me. May 5, 2026, ECF No. 40) at 4');
  assert.deepEqual(f.words.slice(0, 3), [['Fuller'], ['Hyde'], ['School']]);
  assert.ok(f.words[3].includes('Order'));
  assert.equal(f.page, 4);
  // a bare caption is not, by itself, a document cite (the reporter and name steps take it)
  assert.equal(parseDocumentCite('Del Biaggio v. Bansen').isDocument, false);
});

test('a district-court case number with a colon is the case number, not a transcript pin', () => {
  const b = parseDocumentCite('Barteca Holdings LLC v. Tacobarn Newtown LLC, No. 3:26-cv-00250-VDO, ECF No. 43, at 12');
  assert.equal(b.docket, '3:26-cv-00250-VDO');
  assert.equal(b.page, 12);
  assert.ok(b.isDocument);
  assert.deepEqual(b.party, [['Barteca']]);
  assert.deepEqual(parseDocumentCite('Del Biaggio v. Bansen, No. A174647, slip op. at 16').party, [['Biaggio']]);
  const t = parseDocumentCite('Tiekert v. Village of Mamaroneck, No. 23-CV-8714 (CS), slip op. at 3');
  assert.deepEqual(t.party, [['Tiekert']]);
  assert.equal(t.docket, '23-CV-8714');
});
