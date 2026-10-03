// node --test --import ./scripts/_node-src-loader.mjs scripts/_test-brief-versions.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextVersionTitle, versionNumber, redline, redlineBlocks, redlineOfBlocks } from '../src/lib/brief/versions.ts';

test('the next version keeps the name and moves the number on', () => {
  assert.equal(nextVersionTitle('Bushell-Verified-Petition-Art78-v18-FILING'), 'Bushell-Verified-Petition-Art78-v19-FILING');
  assert.equal(nextVersionTitle('Bushell-Verified-Petition-Art78-v8'), 'Bushell-Verified-Petition-Art78-v9');
  assert.equal(nextVersionTitle('Reply Brief v. 3'), 'Reply Brief v. 4');
  assert.equal(nextVersionTitle('Opposition V9 (EQ edits)'), 'Opposition V10 (EQ edits)');
  assert.equal(nextVersionTitle('Draft version 2'), 'Draft version 3');
  assert.equal(nextVersionTitle('Memo v09'), 'Memo v10');
  assert.equal(nextVersionTitle('Motion to Dismiss'), 'Motion to Dismiss v2');
  assert.equal(nextVersionTitle('Brief under Art78'), 'Brief under Art78 v2', '"Art78" is not a version');
  assert.equal(nextVersionTitle('Brief with 3 points v5 final'), 'Brief with 3 points v6 final');
  assert.equal(versionNumber('Bushell-Verified-Petition-Art78-v18-FILING'), 18);
  assert.equal(versionNumber('Motion to Dismiss'), null);
});

const p = (...content) => ({ type: 'paragraph', content });
const t = (text) => ({ type: 'text', text });
const fn = (text) => ({ type: 'footnote', content: [t(text)] });
const doc = (...content) => ({ type: 'doc', content });

test('the redline text: blocks in order, footnotes as [n] in place and listed at the end', () => {
  const d = doc({ type: 'heading', attrs: { level: 2 }, content: [t('ARGUMENT')] },
    p(t('The Department lacks power.'), fn('See Charter § 2203.'), t(' It may not pursue.')),
    { type: 'blockquote', content: [p(t('Quoted.'))] });
  assert.deepEqual(redlineBlocks(d), ['ARGUMENT', 'The Department lacks power.[1] It may not pursue.', 'Quoted.', 'Footnotes', '1. See Charter § 2203.']);
});

test('a rewritten paragraph is a word redline; untouched paragraphs are unchanged', () => {
  const v18 = doc(p(t('88. Unchanged.')),
    p(t('90. Speech loses protection only where “there are plausible ways to complete a proposed transaction lawfully.”')),
    p(t('91. Also unchanged.')));
  const v19 = doc(p(t('88. Unchanged.')),
    p(t('90. However, if there are plausible ways to complete a proposed transaction lawfully, speech is protected.')),
    p(t('91. Also unchanged.')));
  const r = redline(v18, v19);
  assert.deepEqual(r.blocks.map((b) => b.kind), ['same', 'chg', 'same']);
  assert.equal(r.changes, 1);
  const chg = r.blocks[1].pieces;
  assert.ok(chg.some((x) => x.op === '+' && /However/.test(x.text)));
  assert.ok(chg.some((x) => x.op === '-' && /loses/.test(x.text)));
  assert.ok(chg.some((x) => x.op === '=' && /plausible ways to complete a proposed transaction/.test(x.text)), 'the shared words stay plain');
  // The redline rebuilds both versions exactly.
  const older = r.blocks.filter((b) => b.kind !== 'ins').map((b) => b.pieces.filter((x) => x.op !== '+').map((x) => x.text).join(''));
  const newer = r.blocks.filter((b) => b.kind !== 'del').map((b) => b.pieces.filter((x) => x.op !== '-').map((x) => x.text).join(''));
  assert.deepEqual(older, redlineBlocks(v18));
  assert.deepEqual(newer, redlineBlocks(v19));
});

test('paragraphs added and cut are whole insertions and deletions, and the counts add up', () => {
  const r = redlineOfBlocks(['A one.', 'B two words.', 'C three.'], ['A one.', 'C three.', 'D four new words.']);
  assert.deepEqual(r.blocks.map((b) => b.kind), ['same', 'del', 'same', 'ins']);
  assert.equal(r.wordsDeleted, 3);
  assert.equal(r.wordsAdded, 4);
  assert.equal(r.changes, 2);
});

test('identical versions: no changes', () => {
  const d = doc(p(t('Same.')), p(t('Same again.'), fn('A note.')));
  const r = redline(d, structuredClone(d));
  assert.equal(r.changes, 0);
  assert.equal(r.wordsAdded + r.wordsDeleted, 0);
});

test('a 60-page brief with scattered edits compares quickly', () => {
  const para = (i) => `${i}. ` + 'The Department may pursue relief only as the Charter allows. '.repeat(6);
  const a = Array.from({ length: 600 }, (_, i) => para(i));
  const b = a.map((s, i) => (i % 50 === 0 ? s.replace('only as', 'solely as') : s));
  const t0 = performance.now();
  const r = redlineOfBlocks(a, b);
  const ms = performance.now() - t0;
  assert.equal(r.changes, 12);
  assert.ok(ms < 1500, `${Math.round(ms)} ms`);
});
