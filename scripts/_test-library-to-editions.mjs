// The Library mirror's pure rules (lib/library-mirror.mjs), offline.
//   node --test scripts/_test-library-to-editions.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLibraryName, displayTitle, assignVolumes, sampleLength, slugFor, queueDays,
  parseAuthorsCsv, renderAuthorsCsv, romanToInt, applyTitleOverride, dropRawDuplicates,
} from '../lib/library-mirror.mjs';

test('roman numerals', () => {
  assert.equal(romanToInt('I'), 1);
  assert.equal(romanToInt('IV'), 4);
  assert.equal(romanToInt('IX'), 9);
  assert.equal(romanToInt('XIV'), 14);
  assert.equal(romanToInt('XL'), 40);
  assert.equal(romanToInt('Q'), null);
});

test('a single: the marker goes, the title stays', () => {
  const p = parseLibraryName('A Wonder Book - Cleaned.pdf', 'A Wonder Book - Cleaned');
  assert.equal(p.cleanTitle, 'A Wonder Book');
  assert.equal(p.collectionKey, null);
  assert.equal(p.partLabel, null);
  assert.equal(displayTitle(p), 'A Wonder Book');
  assert.equal(p.needsTitle, false);
});

test('"Book" without a numeral is a word, not a token', () => {
  const p = parseLibraryName('A First Book of Jurisprudence - Cleaned.pdf', 'A First Book of Jurisprudence - Cleaned');
  assert.equal(p.cleanTitle, 'A First Book of Jurisprudence');
  assert.equal(p.collectionKey, null);
});

test('Vol before the marker', () => {
  const p = parseLibraryName('A History of Egypt Vol II - Cleaned.pdf', 'A History of Egypt Vol II - Cleaned');
  assert.equal(p.cleanTitle, 'A History of Egypt');
  assert.equal(p.collectionKey, 'A History of Egypt');
  assert.deepEqual(p.sortKey, [2]);
  assert.equal(displayTitle(p), 'A History of Egypt, Vol. II');
});

test('Vol after the marker, with a comma', () => {
  const p = parseLibraryName('Ants - Cleaned, Vol I.pdf', 'Ants - Cleaned, Vol I');
  assert.equal(p.cleanTitle, 'Ants');
  assert.equal(displayTitle(p), 'Ants, Vol. I');
});

test('arabic volumes', () => {
  const p = parseLibraryName('A Short History of the English People Vol 1 - Cleaned.pdf', null);
  assert.equal(p.cleanTitle, 'A Short History of the English People');
  assert.deepEqual(p.sortKey, [1]);
  assert.equal(displayTitle(p), 'A Short History of the English People, Vol. 1');
});

test('Vol and Part before the marker', () => {
  const p = parseLibraryName('Arctic Explorations Vol I Part 2 - Cleaned.pdf', 'Arctic Explorations Vol I Part 2 - Cleaned');
  assert.equal(p.cleanTitle, 'Arctic Explorations');
  assert.deepEqual(p.sortKey, [1, 2]);
  assert.equal(displayTitle(p), 'Arctic Explorations, Vol. I, Part 2');
});

test('Vol before, Part after the marker', () => {
  const p = parseLibraryName('Farthest North Vol II - Cleaned, Part 3.pdf', 'Farthest North Vol II - Cleaned, Part 3');
  assert.equal(p.cleanTitle, 'Farthest North');
  assert.deepEqual(p.sortKey, [2, 3]);
  assert.equal(displayTitle(p), 'Farthest North, Vol. II, Part 3');
});

test('Part and Section', () => {
  const p = parseLibraryName('Anthology of Russian Literature Part II - Cleaned, Section 1.pdf', null);
  assert.equal(p.cleanTitle, 'Anthology of Russian Literature');
  assert.deepEqual(p.sortKey, [2, 1]);
  assert.equal(displayTitle(p), 'Anthology of Russian Literature, Part II, Section 1');
});

test('a title with its own commas', () => {
  const p = parseLibraryName('Commentaries on the Conflict of Laws, Foreign and Domestic - Cleaned, Vol I.pdf', 'Commentaries on the Conflict of Laws, Foreign and Domestic - Cleaned, Vol I');
  assert.equal(p.cleanTitle, 'Commentaries on the Conflict of Laws, Foreign and Domestic');
  assert.equal(displayTitle(p), 'Commentaries on the Conflict of Laws, Foreign and Domestic, Vol. I');
});

test("the document's own title wins over the filename for the words", () => {
  const p = parseLibraryName('Tender is the Night.pdf', 'Tender Is the Night');
  assert.equal(p.cleanTitle, 'Tender Is the Night');
  assert.equal(p.collectionKey, null);
});

test('a shortened title still takes its volume from the filename', () => {
  const p = parseLibraryName('Cape Cod Vol II - Cleaned.pdf', 'Cape Cod');
  assert.equal(p.cleanTitle, 'Cape Cod');
  assert.deepEqual(p.sortKey, [2]);
});

test('a raw archive name is flagged for a title', () => {
  const p = parseLibraryName('treasureisland00steviala.pdf', 'treasureisland00steviala');
  assert.equal(p.needsTitle, true);
  assert.equal(parseLibraryName('The Tempest.pdf', 'The Tempest').needsTitle, false);
});

test('a CSV title reaches the collection key, so a corrected set still groups', () => {
  const a = applyTitleOverride(parseLibraryName('Russias Message Vol I - Cleaned.pdf', 'Russias Message Vol I - Cleaned'), "Russia's Message");
  const b = applyTitleOverride(parseLibraryName('Russias Message Vol II - Cleaned.pdf', 'Russias Message Vol II - Cleaned'), "Russia's Message");
  assert.equal(a.collectionKey, "Russia's Message");
  assert.equal(displayTitle(b), "Russia's Message, Vol. II");
  const items = [{ parsed: a }, { parsed: b }];
  assignVolumes(items);
  assert.deepEqual(items.map((i) => i.volume), [1, 2]);
  const single = applyTitleOverride(parseLibraryName('treasureisland00steviala.pdf', 'treasureisland00steviala'), 'Treasure Island');
  assert.equal(single.cleanTitle, 'Treasure Island');
  assert.equal(single.collectionKey, null);
  assert.equal(single.needsTitle, false);
  assert.equal(applyTitleOverride(parseLibraryName('Ants - Cleaned, Vol I.pdf', null), '  ').cleanTitle, 'Ants');
});

test('volumes are numbered in reading order within a collection; singles stay null', () => {
  const items = [
    'Farthest North Vol II - Cleaned, Part 1.pdf',
    'Farthest North Vol I - Cleaned, Part 2.pdf',
    'Farthest North Vol II - Cleaned, Part 3.pdf',
    'Farthest North Vol I - Cleaned, Part 1.pdf',
    'Farthest North Vol II - Cleaned, Part 2.pdf',
    'The Tempest.pdf',
    'Ants - Cleaned, Vol II.pdf',
    'Ants - Cleaned, Vol I.pdf',
  ].map((f) => ({ parsed: parseLibraryName(f, null) }));
  assignVolumes(items);
  const byFile = Object.fromEntries(items.map((i) => [i.parsed.filename, i.volume]));
  assert.equal(byFile['Farthest North Vol I - Cleaned, Part 1.pdf'], 1);
  assert.equal(byFile['Farthest North Vol I - Cleaned, Part 2.pdf'], 2);
  assert.equal(byFile['Farthest North Vol II - Cleaned, Part 1.pdf'], 3);
  assert.equal(byFile['Farthest North Vol II - Cleaned, Part 2.pdf'], 4);
  assert.equal(byFile['Farthest North Vol II - Cleaned, Part 3.pdf'], 5);
  assert.equal(byFile['The Tempest.pdf'], null);
  assert.equal(byFile['Ants - Cleaned, Vol I.pdf'], 1);
  assert.equal(byFile['Ants - Cleaned, Vol II.pdf'], 2);
});

test('a lone volume is still volume 1 (its sibling may come later)', () => {
  const items = [{ parsed: parseLibraryName('Ants - Cleaned, Vol II.pdf', null) }];
  assignVolumes(items);
  assert.equal(items[0].volume, 1);
});

test('a raw scan filed beside its cleaned copy is skipped; two cleaned copies are both kept', () => {
  const items = [
    'Law and Public Opinion.pdf',
    'Law and Public Opinion - Cleaned.pdf',
    'The Tempest.pdf',
    'Moby Dick - Cleaned, Vol I.pdf',
    'Moby Dick - Cleaned, Vol II.pdf',
    'Ants - Cleaned.pdf',
    'Ants - Cleaned.pdf',
    'Bees - Cleaned.pdf',
    'Bees (second scan) - Cleaned.pdf',
  ].map((f, i) => ({ parsed: parseLibraryName(f, null), filedAt: `2026-10-${String(10 + i).padStart(2, '0')}` }));
  items[7].parsed.cleanTitle = 'Bees'; // two different cleaned files of one title
  assignVolumes(items);
  dropRawDuplicates(items);
  assert.match(items[0].skip, /raw duplicate of Law and Public Opinion - Cleaned\.pdf/);
  assert.equal(items[1].skip, undefined);
  assert.equal(items[2].skip, undefined);
  assert.equal(items[3].skip, undefined);
  assert.equal(items[4].skip, undefined);
  assert.equal(items[5].skip, undefined, 'the first filing of a double upload is kept');
  assert.match(items[6].skip, /the same file filed again \(first filed 2026-10-15\)/);
  assert.equal(items[7].skip, undefined, 'two different cleaned files of one title are both kept (reported by the script)');
  assert.equal(items[8].skip, undefined);
});

test('D13: the sample is 10%, floor 8, ceiling 30, never more than the book', () => {
  assert.equal(sampleLength(220), 22);
  assert.equal(sampleLength(60), 8);
  assert.equal(sampleLength(5), 5);
  assert.equal(sampleLength(1136), 30);
  assert.equal(sampleLength(0), 0);
  assert.equal(sampleLength(null), 0);
  assert.equal(sampleLength(84), 8);
  assert.equal(sampleLength(85), 9);
});

test('slugs: 112 shape, volume suffix, collisions take -2, -3', () => {
  assert.match(slugFor('A History of Egypt', 2), /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.equal(slugFor('A History of Egypt', 2), 'a-history-of-egypt-vol-2');
  assert.equal(slugFor("Other people_s money, and how the bankers use it", null), 'other-people-s-money-and-how-the-bankers-use-it');
  const taken = new Set(['the-tempest']);
  assert.equal(slugFor('The Tempest', null, taken), 'the-tempest-2');
  taken.add('the-tempest-2');
  assert.equal(slugFor('The Tempest', null, taken), 'the-tempest-3');
  assert.ok(slugFor('Él', null).length >= 3);
  assert.ok(slugFor('x'.repeat(200), 12).length <= 80);
});

test('D17: three a day, a collection kept together', () => {
  const items = [
    'A.pdf', 'B.pdf',
    'Set - Cleaned, Vol I.pdf', 'Set - Cleaned, Vol II.pdf',
    'C.pdf', 'D.pdf', 'E.pdf', 'F.pdf',
  ].map((f) => ({ parsed: parseLibraryName(f, null) }));
  const days = queueDays(items, '2026-11-02', 3);
  const d = (i) => days.get(items[i]);
  assert.equal(d(0), '2026-11-02');
  assert.equal(d(1), '2026-11-02');
  // the two-volume set would not fit on day 1 with A and B; it moves whole to day 2
  assert.equal(d(2), '2026-11-03');
  assert.equal(d(3), '2026-11-03');
  assert.equal(d(4), '2026-11-03');
  assert.equal(d(5), '2026-11-04');
  assert.equal(d(6), '2026-11-04');
  assert.equal(d(7), '2026-11-04');
});

test('the authors CSV round-trips, quotes included', () => {
  const rows = [
    { document_id: '1', filename: 'Ants - Cleaned, Vol I.pdf', title: 'Ants', author: null },
    { document_id: '2', filename: 'Other people_s money.pdf', title: "Other People's Money, and How the Bankers Use It", author: 'Louis D. "Louie" Brandeis' },
  ];
  const text = renderAuthorsCsv(rows);
  const back = parseAuthorsCsv(text);
  assert.equal(back.get('1').author, null);
  assert.equal(back.get('1').title, 'Ants');
  assert.equal(back.get('2').author, 'Louis D. "Louie" Brandeis');
  assert.equal(back.get('2').title, "Other People's Money, and How the Bankers Use It");
  assert.equal(parseAuthorsCsv('').size, 0);
});
