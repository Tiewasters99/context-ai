// Text anchors, offline: how a mark on a document without pages (Word, text,
// markdown, screenplay) is written down, and how it is found again.
//
// The pure half of src/lib/text-anchor.ts: offsets -> anchor, and anchor ->
// offsets when the text is unchanged, when it has shifted, and when the words
// are gone. The DOM half (turning a selection into offsets and offsets into a
// Range) is exercised only in a browser. Run it the way CI does:
//
//   node --import ./scripts/_node-src-loader.mjs --test scripts/_test-text-anchor.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANCHOR_CONTEXT,
  anchorFromOffsets,
  isTextAnchor,
  offsetsFromAnchor,
} from '../src/lib/text-anchor.ts';

const SCRIPT =
  'INT. CADILLAC - NIGHT\n' +
  'The engine ticks. RAY looks at the road.\n' +
  'RAY: We drive.\n' +
  'EXT. HIGHWAY - DAWN\n' +
  'The road runs on. RAY looks at the road again.\n';

test('offsets -> anchor: the words, their offsets, and up to 32 characters either side', () => {
  const start = SCRIPT.indexOf('RAY looks');
  const end = start + 'RAY looks at the road'.length;
  const a = anchorFromOffsets(SCRIPT, start, end);
  assert.deepEqual(a, {
    start,
    end,
    exact: 'RAY looks at the road',
    prefix: SCRIPT.slice(start - ANCHOR_CONTEXT, start),
    suffix: SCRIPT.slice(end, end + ANCHOR_CONTEXT),
  });
  assert.equal(a.prefix.length, 32);
  assert.equal(a.suffix.length, 32);
  assert.ok(isTextAnchor(a));
});

test('offsets -> anchor: edge whitespace is trimmed, context is clipped at the ends, empty is null', () => {
  const a = anchorFromOffsets(SCRIPT, 0, 'INT. CADILLAC - NIGHT\n'.length);
  assert.equal(a.exact, 'INT. CADILLAC - NIGHT');
  assert.equal(a.start, 0);
  assert.equal(a.end, 21);
  assert.equal(a.prefix, '');
  const b = anchorFromOffsets('  hello  ', 0, 9);
  assert.deepEqual([b.start, b.end, b.exact, b.prefix, b.suffix], [2, 7, 'hello', '  ', '  ']);
  // Reversed offsets are the same selection.
  assert.deepEqual(anchorFromOffsets(SCRIPT, 30, 10), anchorFromOffsets(SCRIPT, 10, 30));
  assert.equal(anchorFromOffsets(SCRIPT, 5, 5), null);
  assert.equal(anchorFromOffsets('a \n b', 1, 4), null); // whitespace only
  assert.equal(anchorFromOffsets('', 0, 0), null);
});

test('anchor -> offsets: unchanged text gives back the same offsets', () => {
  for (const word of ['INT. CADILLAC', 'We drive.', 'again.']) {
    const start = SCRIPT.indexOf(word);
    const a = anchorFromOffsets(SCRIPT, start, start + word.length);
    assert.deepEqual(offsetsFromAnchor(SCRIPT, a), { start, end: start + word.length });
  }
  // The second of two identical phrases stays the second.
  const second = SCRIPT.lastIndexOf('RAY looks at the road');
  const a = anchorFromOffsets(SCRIPT, second, second + 21);
  assert.deepEqual(offsetsFromAnchor(SCRIPT, a), { start: second, end: second + 21 });
});

test('anchor -> offsets: after the text shifted, prefix/suffix pick the right one of several identical quotes', () => {
  // Mark the SECOND "RAY looks at the road".
  const second = SCRIPT.lastIndexOf('RAY looks at the road');
  const a = anchorFromOffsets(SCRIPT, second, second + 21);

  // A re-render put a title page in front and dropped a line in between.
  // The stored offsets now point at the wrong words.
  const shifted =
    'CADILLAC\nWritten by E.\n\n' +
    'INT. CADILLAC - NIGHT\n' +
    'The engine ticks. RAY looks at the road.\n' +
    'RAY: We drive.\n' +
    'RAY: Faster.\n' +
    'EXT. HIGHWAY - DAWN\n' +
    'The road runs on. RAY looks at the road again.\n';
  assert.notEqual(shifted.slice(a.start, a.end), a.exact);
  const want = shifted.lastIndexOf('RAY looks at the road');
  assert.deepEqual(offsetsFromAnchor(shifted, a), { start: want, end: want + 21 });

  // The first one, re-anchored in the same shifted text, finds the first.
  const first = SCRIPT.indexOf('RAY looks at the road');
  const b = anchorFromOffsets(SCRIPT, first, first + 21);
  const wantB = shifted.indexOf('RAY looks at the road');
  assert.deepEqual(offsetsFromAnchor(shifted, b), { start: wantB, end: wantB + 21 });
});

test('anchor -> offsets: context beats distance when the stored offset is nearer the wrong copy', () => {
  // Three identical words; the anchor's context says "the middle one", while
  // its stale offset sits right on top of the first.
  const text = 'alpha STOP one. beta STOP two. gamma STOP three.';
  const mid = text.indexOf('STOP', text.indexOf('beta'));
  // The stale offsets are one character past the first copy, so the words
  // there ("TOP ") do not verify and the search decides.
  const first = text.indexOf('STOP');
  const anchor = { start: first + 1, end: first + 5, exact: 'STOP', prefix: 'beta ', suffix: ' two.' };
  assert.notEqual(text.slice(anchor.start, anchor.end), 'STOP');
  assert.deepEqual(offsetsFromAnchor(text, anchor), { start: mid, end: mid + 4 });
});

test('anchor -> offsets: words that no longer exist give null', () => {
  const start = SCRIPT.indexOf('We drive.');
  const a = anchorFromOffsets(SCRIPT, start, start + 9);
  const edited = SCRIPT.replace('We drive.', 'We walk.');
  assert.equal(offsetsFromAnchor(edited, a), null);
  assert.equal(offsetsFromAnchor('', a), null);
  assert.equal(offsetsFromAnchor(SCRIPT, { ...a, exact: '' }), null);
});

test('isTextAnchor refuses rows that are not anchors', () => {
  assert.equal(isTextAnchor(null), false);
  assert.equal(isTextAnchor(undefined), false);
  assert.equal(isTextAnchor({}), false);
  assert.equal(isTextAnchor({ start: 1, end: 2, exact: '' }), false);
  assert.equal(isTextAnchor({ start: '1', end: 2, exact: 'x' }), false);
  assert.equal(isTextAnchor({ start: 1, end: 2, exact: 'x', prefix: '', suffix: '' }), true);
});
