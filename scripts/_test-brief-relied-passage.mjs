// node --test --import ./scripts/_node-src-loader.mjs scripts/_test-brief-relied-passage.mjs
// The relied-on language at the pincite: the brief's words → the source's.
// Keenan (290 F.3d 252) and the Fifth Circuit's Atkinson opinion are the real
// passages as stored; the transcript sheet is synthetic in the appendix's
// exact format (client testimony stays out of the repo).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  claimFor, pickRelied, depoLines, transcriptLines, locatePhrase, quoteSegments, sentenceEnds, normalizeQuote,
} from '../src/lib/brief/relied-passage.ts';

const FX = JSON.parse(readFileSync(new URL('./fixtures/relied-passage.json', import.meta.url), 'utf8'));
const k258 = FX.keenan.find((p) => p.id === 'keenan-258');
const k259 = FX.keenan.find((p) => p.id === 'keenan-259');
const k261 = FX.keenan.find((p) => p.id === 'keenan-261');

// The Atkinson rehearing petition's paragraph, as the desk stores it (10-16).
const ATKINSON = 'The parties agreed that only the second element of the claim was in dispute. Op. 6. Keenan defines that element as an injury “that would chill a person of ordinary firmness from continuing to engage in” protected activity, adopting that formulation as “[t]he settled law of other circuits.” 290 F.3d at 258. Keenan held that a felony traffic stop at gunpoint and a later prosecution that ended in acquittal met that standard, relying on decisions that had sustained claims based on a county board’s withdrawal of legal-notice advertising from a newspaper and a sheriff’s release of confidential information about a rape investigation. Id. at 259 (collecting cases); see Bloch v. Ribar, 156 F.3d 673, 681 (6th Cir. 1998).';

test('sentences: legal abbreviations do not end one', () => {
  const t = 'See North Miss. Comm., Inc. v. Jones, 951 F.2d 652 (5th Cir. 1992). The court held so. Id. at 4.';
  const ends = sentenceEnds(t).map((e) => t.slice(0, e).slice(-12));
  assert.deepEqual(ends, ['h Cir. 1992).', 'e court held so.'].map((s) => s.slice(-12)));
});

test('claim: a standalone cite takes the sentence before it; quotes come with it', () => {
  const c = claimFor(ATKINSON, '290 F.3d at 258');
  assert.match(c.claim, /^Keenan defines that element/);
  assert.deepEqual(c.quotes, ['that would chill a person of ordinary firmness from continuing to engage in', '[t]he settled law of other circuits.']);
  const id = claimFor(ATKINSON, 'Id. at 259');
  assert.match(id.claim, /^Keenan held that a felony traffic stop/);
  assert.deepEqual(id.quotes, []);
});

test('claim: a cite inside its sentence takes the words before it, and a (holding …) parenthetical', () => {
  const c = claimFor('Retaliation must chill a person of ordinary firmness. See Keenan v. Tejeda, 290 F.3d 252, 258 (5th Cir. 2002) (holding that a traffic stop at gunpoint suffices).', 'Keenan v. Tejeda, 290 F.3d 252, 258 (5th Cir. 2002)');
  assert.match(c.claim, /^Retaliation must chill/);
  assert.match(c.claim, /traffic stop at gunpoint suffices$/);
});

test('quotes: [t]he alteration, ellipses, a bracketed insertion', () => {
  assert.equal(normalizeQuote('“[t]he settled law”'), '"the settled law"');
  assert.deepEqual(quoteSegments('if another family member dies in Fort Bend County ... [she] now knows that she had better not make any complaint'),
    ['if another family member dies in Fort Bend County', 'now knows that she had better not make any complaint']);
});

test('Keenan at 258: both quotes, exact', () => {
  const pick = pickRelied(claimFor(ATKINSON, '290 F.3d at 258'), [k258, k259]);
  assert.equal(pick.basis, 'quote');
  assert.deepEqual(pick.phrases.map((p) => p.text), [
    'The settled law of other circuits',
    'that would chill a person of ordinary firmness from continuing to engage in',
  ]);
});

test('Keenan Id. at 259: the paraphrase finds the collecting sentence, not page 258', () => {
  const pick = pickRelied(claimFor(ATKINSON, 'Id. at 259'), [k259, k261]);
  assert.equal(pick.basis, 'closest');
  assert.equal(pick.phrases[0].passageId, 'keenan-259');
  assert.match(pick.phrases[0].text, /^Decisions of this and other circuits/);
  assert.match(pick.phrases[0].text, /rape investigation/);
});

test('below the cutoff: nothing is lit', () => {
  const pick = pickRelied({ claim: 'The statute of limitations on breach of warranty runs four years from tender of delivery.', quotes: [] }, [k258, k259]);
  assert.equal(pick.basis, 'none');
  assert.deepEqual(pick.phrases, []);
});

test('a quote that is not on the page falls back to paraphrase, not to a wrong page', () => {
  // "Id. at 259" with the 258 quote in the claim: 259 must not claim it.
  const pick = pickRelied({ claim: 'an injury “that would chill a person of ordinary firmness from continuing to engage in” protected activity', quotes: ['that would chill a person of ordinary firmness from continuing to engage in'] }, [k261]);
  assert.notEqual(pick.basis, 'quote');
});

test('the Opinion PDF: a quote across ragged spacing and line breaks', () => {
  const op = FX.opinion[0];
  const pick = pickRelied(claimFor('The panel affirmed on the ground that she “failed to replead this claim when she filed her third amended complaint.” Op. 6. She did replead it.', 'Op. 6'), [op]);
  assert.equal(pick.basis, 'quote');
  assert.match(pick.phrases[0].text, /^failed\s+to\s+replead[\s\S]*complaint$/);
});

test('locate: line numbers, star pages and a hyphenated break between words', () => {
  const layer = '·3· ·first nutri- tionist.·She was working *259 with diagnosing';
  const at = locatePhrase(layer, 'first nutritionist. She was working with diagnosing');
  assert.ok(at);
  assert.equal(layer.slice(at.start, at.end), 'first nutri- tionist.·She was working *259 with diagnosing');
  assert.equal(locatePhrase('nothing like it', 'first nutritionist'), null);
});

test('locate: a long phrase by its ends when a middle word differs', () => {
  const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike';
  const at = locatePhrase(text, 'alpha bravo charlie delta echo FOXTROTT golf hotel india juliet kilo lima mike');
  assert.ok(at);
  assert.equal(text.slice(at.start, at.end), text);
});

test('transcript sheet: pages and lines, a page with no header runs on', () => {
  const lines = transcriptLines(FX.sheet);
  const at = (pg, ln) => lines.find((l) => l.page === pg && l.line === ln);
  assert.match(at(62, 1).text, /page 62 number 1 here$/);
  assert.match(at(62, 10).text, /page 62 number 10 here$/);   // "10·", no leading dot
  assert.match(at(63, 25).text, /page 63 number 25 here$/);
  assert.match(at(64, 3).text, /page 64 number 3 here$/);      // no "Page 64" header
  assert.equal(at(65, 1), undefined);
  assert.ok(lines.every((l) => !/Reporting|www/.test(l.text)), 'the footer is not a line');
});

test('depo cite: 63:21–64:2 lights seven lines across the page break', () => {
  const pick = depoLines(FX.sheet, { page: 63, line: 21, endPage: 64, endLine: 2 });
  assert.equal(pick.basis, 'lines');
  assert.equal(pick.phrases.length, 7);
  assert.match(pick.phrases[0].text, /page 63 number 21/);
  assert.match(pick.phrases[6].text, /page 64 number 2 here/);
  assert.equal(pick.detail, '63:21–64:2');
  assert.equal(pick.phrases[0].page, 147);
  // 62:9–11: three lines on one page.
  assert.equal(depoLines(FX.sheet, { page: 62, line: 9, endPage: null, endLine: 11 }).phrases.length, 3);
  // A page the sheet does not hold.
  assert.equal(depoLines(FX.sheet, { page: 90, line: 1, endPage: null, endLine: 4 }).basis, 'none');
});

test('depo: a full-size Q/A passage maps line by line only when the count fits', () => {
  const qa = { id: 'qa', page: 20, page_start: 19, line_start: 12, line_end: 14, text: 'Q What was the meeting about?\nA Well, it was an introductory meeting.\nWe introduced ourselves.' };
  const pick = depoLines([qa], { page: 19, line: 13, endPage: null, endLine: 14 });
  assert.deepEqual(pick.phrases.map((p) => p.text), ['A Well, it was an introductory meeting.', 'We introduced ourselves.']);
  assert.equal(depoLines([{ ...qa, line_end: 20 }], { page: 19, line: 13, endPage: null, endLine: 14 }).basis, 'none');
});

test('each picked phrase can be found again in its passage (the painter relies on it)', () => {
  const pick = pickRelied(claimFor(ATKINSON, 'Id. at 259'), [k259]);
  for (const p of pick.phrases) assert.ok(locatePhrase(k259.text, p.text));
});
