// Probe: the deterministic reading reflow, against the shapes real ingested
// text arrives in. Run with `node scripts/_verify-reflow.mjs` (Node 22.18+
// strips the types out of the .ts import on its own).
//
// Untracked by convention — scripts/_*.mjs are probes, not code.

import { reflowReading, readingParagraphs } from '../src/lib/student-hub-reflow.ts';

let failures = 0;

function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}`);
    if (detail !== undefined) console.log(`      ${String(detail).split('\n').join('\n      ')}`);
  }
}

/* ---------------- Fixture 1: a PDF text layer ----------------
   Hard-wrapped at ~90 characters, no blank line anywhere, and a paragraph's
   last line short and sentence-ending. */

const pdfShaped = [
  'The doctrine of consideration has never been a single rule, and the cases collected here do not',
  'pretend otherwise; they are the residue of a century of argument about what makes a promise',
  'enforceable at law, and about which promises the courts will leave where they found them, on',
  'the moral side of the line.',
  'Holmes put the bargain theory in its narrowest form, and for a generation the casebooks put',
  'Holmes first. The difficulty is that the theory explains the easy cases and leaves the hard',
  'ones to be decided elsewhere.',
  'Section 90 was the answer the Restatement gave, and it is the answer this chapter takes up',
  'next. It is not a small one.',
].join('\n');

{
  const out = reflowReading(pdfShaped);
  const paras = out.split('\n\n');
  check('pdf prose — three paragraphs', paras.length === 3, `got ${paras.length}:\n${out}`);
  check('pdf prose — no mid-sentence break', paras.every((p) => /[.!?]$/.test(p)), out);
  check('pdf prose — lines joined, no double spaces', !/ {2}/.test(out) && !out.includes('not\npretend'), out);
  check(
    'pdf prose — first paragraph reads whole',
    paras[0] === 'The doctrine of consideration has never been a single rule, and the cases collected here do not '
      + 'pretend otherwise; they are the residue of a century of argument about what makes a promise enforceable '
      + 'at law, and about which promises the courts will leave where they found them, on the moral side of the line.',
    paras[0],
  );
}

/* ---------------- Fixture 2: hyphenation ---------------- */

const hyphenated = [
  'The parties met in November to negotiate the terms of a written con-',
  'tract, and the Anglo-',
  'American rule they invoked has never sat comfortably beside the civil law of obligations.',
].join('\n');

{
  const out = reflowReading(hyphenated);
  check('hyphenation — broken word closes up', out.includes('a written contract,'), out);
  check('hyphenation — compound keeps its hyphen', out.includes('the Anglo-American rule'), out);
  check('hyphenation — one paragraph', out.split('\n\n').length === 1, out);
}

/* ---------------- Fixture 3: verse ---------------- */

const stanza = [
  'Whose woods these are I think I know.',
  'His house is in the village though;',
  'He will not see me stopping here',
  'To watch his woods fill up with snow.',
].join('\n');

const withVerse = [
  'The poem was set for Thursday, and the class was told to read it twice before',
  'anyone said a word about it.',
  '',
  stanza,
  '',
  'What the second reading gives you is the sound of the thing, which is where the',
  'argument about it has to start.',
].join('\n');

{
  const out = reflowReading(withVerse);
  check('verse — stanza survives byte-identical', out.includes(stanza), out);
  const paras = readingParagraphs(out);
  check('verse — stanza is one paragraph, flagged verse',
    paras.length === 3 && paras[1].text === stanza && paras[1].verse === true,
    paras.map((p) => `${p.verse ? 'V' : 'P'} ${JSON.stringify(p.text.slice(0, 40))}`).join('\n'));
  check('verse — prose neighbours are not verse',
    paras[0]?.verse === false && paras[2]?.verse === false);
}

/* ---------------- Fixture 4: page-number noise ---------------- */

const withPageNumber = [
  'The court below treated the question as one of fact, and on that footing there was',
  'nothing left to review.',
  '',
  '247',
  '',
  'On appeal the parties agreed that the footing was wrong, which left the question of',
  'what to do about the finding.',
  '',
  'xiv',
].join('\n');

{
  const out = reflowReading(withPageNumber);
  check('page noise — the bare 247 is dropped', !out.includes('247'), out);
  check('page noise — the roman numeral is dropped', !/\bxiv\b/.test(out), out);
  check('page noise — the two paragraphs remain', out.split('\n\n').length === 2, out);
}

/* ---------------- Fixture 5: a heading on its own line ---------------- */

const withHeading = [
  'BOOK ONE',
  '',
  '§ 2 Consideration',
  '',
  'A promise is not made binding by the mere fact that the promisor meant it to be, and the',
  'reporter said so in the first sentence of the section.',
].join('\n');

{
  const out = reflowReading(withHeading);
  const paras = out.split('\n\n');
  check('headings — each passes through as its own paragraph',
    paras.length === 3 && paras[0] === 'BOOK ONE' && paras[1] === '§ 2 Consideration', out);
}

/* ---------------- Fixture 6: running heads + page seams ----------------
   A born-digital novel the way pdfTextPages hands it over: each page is one
   block, a running head with the page number as its first line, sometimes a
   bare folio as its last, and paragraphs cut mid-flow at the page break. */

const page = (head, ...lines) => [head, ...lines].join('\n');
const tenderShaped = [
  page('TENDER IS THE NIGHT 41',
    'On the pleasant shore of the French Riviera, about half way between Marseilles and',
    'the Italian border, stands a large, proud, rose-colored hotel. Deferential palms',
    'cool its flushed facade, and before it stretches a short dazzling beach. Lately it'),
  page('F. SCOTT FITZGERALD 42',
    'has become a summer resort of notable and fashionable people; a decade ago it was',
    'almost deserted after its English clientele went north in April. Now, many',
    'bungalows cluster near it.',
    '42'),
  page('TENDER IS THE NIGHT 43',
    'The hotel and its bright tan prayer rug of a beach were one. In the early morning',
    'the distant image of Cannes, the pink and cream of old fortifications, the purple',
    'Alp that bounded Italy, were cast across the water and lay quavering in the ripples'),
  page('F. SCOTT FITZGERALD 44',
    'and rings sent up by sea-plants through the clear shallows. Before eight a man came',
    'down to the beach in a blue bathrobe and with much preliminary application to his',
    'person of the chilly water, and much grunting and loud breathing, floundered a',
    'minute in the sea.'),
  page('TENDER IS THE NIGHT 45',
    'When he had gone, beach and bay were quiet for an hour. Merchantmen crawled',
    'westward on the horizon; bus boys shouted in the hotel court; the dew dried upon',
    'the pines. In another hour the horns of motors began to blow down the winding road'),
  page('F. SCOTT FITZGERALD 46',
    'along the low range of the Maures, which separates the littoral from true Provencal',
    'France.'),
].join('\n\n');

{
  const out = reflowReading(tenderShaped);
  check('running heads — both heads gone', !/TENDER IS THE NIGHT|FITZGERALD/.test(out), out);
  check('running heads — folios gone with them', !/\b4[1-6]\b/.test(out), out);
  check('page seams — mid-flow seam joined', out.includes('Lately it has become a summer resort'), out);
  check('page seams — second seam joined', out.includes('ripples and rings sent up'), out);
  check('page seams — third seam joined', out.includes('winding road along the low range'), out);
  check('page seams — real paragraph breaks kept', out.split('\n\n').length === 3,
    `got ${out.split('\n\n').length} paragraphs:\n${out}`);
}

/* ---------------- Fixture 7: too short to judge heads ----------------
   Two pages cannot establish a running-head pattern; nothing may be shed. */

const twoPages = [
  page('AN ESSAY 1',
    'The first page of a very short handout says what the handout is going to say, and',
    'it says it plainly enough that nobody could mistake the plan.'),
  page('AN ESSAY 2',
    'The second page says it again, more slowly, which is the whole of the method.'),
].join('\n\n');

{
  const out = reflowReading(twoPages);
  check('short text — would-be heads survive', /AN ESSAY 1/.test(out) && /AN ESSAY 2/.test(out), out);
}

/* ---------------- Fixture 8: a refrain is not a running head ----------------
   The refrain repeats at stanza edges the way a head repeats at page edges;
   verse blocks neither vote nor lose lines, so it must come through. */

const REFRAIN = 'Do not go gentle into that good night.';
const villanelleish = [
  ['Old age should burn and rave at close of day;', 'Rage, rage against the dying of the light.', REFRAIN].join('\n'),
  ['Though wise men at their end know dark is right,', 'Because their words had forked no lightning they', REFRAIN].join('\n'),
  ['Good men, the last wave by, crying how bright', 'Their frail deeds might have danced in a green bay,', REFRAIN].join('\n'),
  ...tenderShaped.split('\n\n'),
].join('\n\n');

{
  const out = reflowReading(villanelleish);
  const kept = out.split(REFRAIN).length - 1;
  check('refrain — all three stand', kept === 3, `kept ${kept}:\n${out}`);
}

/* ---------------- Idempotence, everywhere ---------------- */

const corpus = {
  'pdf prose': pdfShaped,
  hyphenation: hyphenated,
  verse: withVerse,
  'page noise': withPageNumber,
  headings: withHeading,
  'crlf + ragged blanks': 'One line here.  \r\n\r\n\r\n\r\nAnd another, after four blank lines.  \r\n',
  'running heads': tenderShaped,
  'two pages': twoPages,
  villanelle: villanelleish,
  empty: '',
  'already reflowed': reflowReading(pdfShaped),
};

for (const [name, raw] of Object.entries(corpus)) {
  const once = reflowReading(raw);
  const twice = reflowReading(once);
  check(`idempotent — ${name}`, once === twice, `once:\n${once}\n---\ntwice:\n${twice}`);
}

/* ---------------- Paragraph offsets ---------------- */

for (const [name, raw] of Object.entries(corpus)) {
  const out = reflowReading(raw);
  const paras = readingParagraphs(out);
  const ok = paras.every((p) => out.slice(p.start, p.start + p.text.length) === p.text);
  check(`offsets — ${name}`, ok, out);
}

console.log('');
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
