// Transcript mode must survive the blank numbered lines every reporter
// leaves in a page. No network. Run: node scripts/_test-transcript-parse.mjs
//
// 2026-09-10: parseTranscriptPage's line regex let the gap after a line
// number match a newline, so a blank numbered line swallowed the next line's
// text ("5\n6  Q. Why" → line 5 = "6  Q. Why"); the Q./A. test then never
// fired and the page — and with it a whole deposition — fell to prose.
import assert from 'node:assert';
import { chunkPages } from '../lib/ingest-core.mjs';

let n = 0;
const ok = (msg) => { n++; console.log(`  ok  ${msg}`); };

// A reporter's page: 25 numbered lines, several of them blank, Q./A. prefixes,
// a witness call and an examination header — as a PDF text layer emits it.
const page = [
  ' 1',
  ' 2      JOHANNE SAINT-FLEUR, having been first duly sworn,',
  ' 3   was examined and testified as follows:',
  ' 4',
  ' 5             DIRECT EXAMINATION',
  ' 6   BY MR. QUAINTON:',
  ' 7',
  ' 8   Q.   Where were you on August 16, 2015?',
  ' 9',
  '10   A.   In the AMKC clinic, the mental health',
  '11   pen area.',
  '12',
  '13   Q.   Who else was there?',
  '14   A.   Captain Blake, Officer Owens and',
  '15   Officer Ward.',
  '16',
  '17   Q.   Did you see the detainee struck?',
  '18',
  '19   A.   I did not see that, no.',
  '20',
  '21',
  '22   Q.   Did you hear anything?',
  '23   A.   Shouting.',
  '24',
  '25',
].join('\n');

const passages = chunkPages([{ pageNumber: 42, text: page }]);
// Consecutive short chunks of one type are merged (< 300 chars): the four
// heading lines become one heading passage and the four short Q/A pairs one
// Q/A passage. What matters is that none of it fell to prose.
assert(passages.length >= 2, `transcript mode engaged (${passages.length} passages, not one prose block)`);
const qa = passages.filter((p) => p.passage_type === 'qa_pair');
assert(qa.length >= 1, `Q/A passages found: ${qa.length}`);
assert(passages.every((p) => p.passage_type !== 'monologue'), 'nothing on the page fell to prose');
assert(passages.some((p) => p.passage_type === 'section_heading' && /DIRECT EXAMINATION/.test(p.text)), 'the examination header is a heading, not testimony');
ok(`blank numbered lines do not knock the page out of transcript mode (${passages.length} passages, ${qa.length} Q/A)`);

const first = qa[0];
assert.strictEqual(first.page_start, 42);
assert.strictEqual(first.line_start, 8, 'first Q starts at line 8');
assert(first.line_end >= 10 && first.line_end <= 25, `the Q/A passage ends within the page (line_end ${first.line_end})`);
assert.match(first.text, /^Q\.\s+Where were you on August 16, 2015\?/);
assert.match(first.text, /A\.\s+In the AMKC clinic/);
assert(!/^\d/m.test(first.text.replace(/^Q\.|^A\./gm, '')), 'no line numbers leak into the text');
ok('page:line coordinates are the reporter\'s (42:8-…), text is verbatim');

assert(passages.every((p) => p.witness_name === 'JOHANNE SAINT-FLEUR' || p.passage_type === 'section_heading'), 'witness carried onto every Q/A');
assert(qa.every((p) => p.examination_type === 'direct'), 'examination type carried');
ok('witness name and examination type populate from the call and header');

const last = qa[qa.length - 1];
assert.match(last.text, /Did you hear anything\?/);
assert.match(last.text, /Shouting\./);
ok('the last pair on the page survives trailing blank lines');

// A reporter's PDF whose line numbers live outside the text layer (Veritext:
// middle-dot spacing, no digits, the witness named on its own line before the
// oath) — every Fleming deposition looks like this. Lines are numbered by
// position and the passages say so.
const veritext = [
  'THEREUPON,',
  '                             FELIX EZEKWE, M.D.,',
  '     having first been duly sworn, testified as follows:',
  '                          DIRECT EXAMINATION',
  'BY MR. QUAINTON:',
  '· · ·Q.· ·Doctor, first of all, let me thank you for',
  'making yourself available.· I know there was a little bit',
  'of a misunderstanding about the timing of the deposition.',
  '· · ·A.· ·Yes.',
  '· · ·Q.· ·Have you ever been deposed before?',
  '· · ·A.· ·Yes.· Once, many years ago.',
  '· · ·Q.· ·On the morning of August 16, what did you see',
  'when the patient came into the clinic?',
  '· · ·A.· ·He was walking, he was talking, he had no',
  'visible injury.· That is what I wrote in the chart.',
  '· · ·Q.· ·Did you examine his abdomen?',
  '· · ·A.· ·I did a general examination, yes.',
  '· · ·Q.· ·And the scrotal area?',
  '· · ·A.· ·That was not part of the complaint at the time.',
  '· · ·Q.· ·Did anyone tell you he had been struck?',
  '· · ·A.· ·No.',
  '· · ·Q.· ·Did you ask?',
  '· · ·A.· ·I asked what happened; he said he was fine.',
  '· · ·Q.· ·Nothing further at this time.',
].join('\n');
const vt = chunkPages([{ pageNumber: 9, text: veritext }]);
const vtQa = vt.filter((p) => p.passage_type === 'qa_pair');
assert(vtQa.length >= 2 && vt.every((p) => p.passage_type !== 'monologue'), `a Veritext page is a transcript (${vt.length} passages, ${vtQa.length} Q/A, no prose)`);
assert(vtQa.every((p) => p.witness_name === 'FELIX EZEKWE'), `the witness comes from the name line before the oath (${JSON.stringify([...new Set(vt.map((p) => p.witness_name))])})`);
assert(vt.every((p) => p.passage_type !== 'qa_pair' || /^(Q|A)\./.test(p.text)), 'the reporter\'s cue and the call are headings, not testimony');
assert(vtQa.every((p) => p.line_start >= 1 && p.line_end <= 24 && p.metadata?.line_numbers === 'inferred'), 'line numbers are positional and flagged as inferred');
assert.strictEqual(vtQa[0].line_start, 6, 'first Q is the sixth text line');
assert(!/·/.test(vt.map((p) => p.text).join('')), 'middle-dot spacing is read as spaces');
ok('no line numbers in the text layer: transcript mode still engages, witness found, lines inferred and flagged');

// New York reporters set the witness's name letter-spaced on its own line,
// two lines above the oath, and the text layer keeps the line numbers.
const nyPage = [
  ' 1', ' 2                 D E S M O N D   B L A K E,', ' 3      the Witness herein,', ' 4   called as a witness, having been first duly',
  ' 5   sworn by a Notary Public, was examined and', ' 6   testified as follows:', ' 7   EXAMINATION BY', ' 8   MR. QUAINTON:',
  ' 9   Q.    Captain, where were you posted on', '10   August 16, 2015?', '11   A.    AMKC, the clinic.', '12',
  '13   Q.    Who was with you?', '14   A.    Saint-Fleur and the escort team.', '15', '16   Q.    Did you go into the pen?',
  '17   A.    I did not.', '18', '19   Q.    Did you see anyone go in?', '20   A.    Officers went in, yes.', '21',
  '22   Q.    Which officers?', '23   A.    I could not tell you today.', '24', '25',
].join('\n');
const ny = chunkPages([{ pageNumber: 12, text: nyPage }]);
assert(ny.every((p) => p.passage_type !== 'monologue'), 'a New York page is a transcript');
assert(ny.filter((p) => p.passage_type === 'qa_pair').every((p) => p.witness_name === 'DESMOND BLAKE'), `letter-spaced name collapses to the witness (${JSON.stringify([...new Set(ny.map((p) => p.witness_name))])})`);
assert(ny.filter((p) => p.passage_type === 'qa_pair')[0].line_start === 9, 'testimony starts at line 9, after the call and the examiner');
ok('letter-spaced witness name above the oath is read; the call lines are headings');

// A condensed sheet: four transcript pages per PDF page, "Page N" markers,
// the line number alone on a line and the text on the next.
const condensed = [
  '10 (Pages 34 to 37)', 'Page 34', '1', '     (JOON PARK, M.D. - CONFIDENTIAL TESTIMONY)', '2', '          Q.   When did you first see the patient?',
  '3', '          A.   That morning, in the intake area of the', '4', '          clinic.', '5', '          Q.   What did he complain of?', '6',
  '          A.   Pain in the groin.', '7', '8', '          Q.   Did you examine him?', '9', '          A.   I did a visual examination.',
  'Page 35', '1', '     (JOON PARK, M.D. - CONFIDENTIAL TESTIMONY)', '2', '          Q.   Did you document it?', '3',
  '          A.   I wrote what I saw.', '4', '          Q.   Which was?', '5', '          A.   Swelling.', '6', '7',
  '          Q.   Did you order imaging?', '8', '          A.   Not that day.',
].join('\n');
const cd = chunkPages([{ pageNumber: 10, text: condensed }]);
const cdQa = cd.filter((p) => p.passage_type === 'qa_pair');
assert(cdQa.length >= 2 && cd.every((p) => p.passage_type !== 'monologue'), `a condensed sheet is a transcript (${cd.length} passages)`);
assert(cdQa.some((p) => p.page_start === 34) && cdQa.some((p) => p.page_start === 35), `cites name the transcript page, not the sheet (${JSON.stringify([...new Set(cdQa.map((p) => p.page_start))])})`);
assert(cdQa[0].line_start === 2 && cdQa[0].line_end >= 4, `first pair is 34:2-4 (${cdQa[0].line_start}-${cdQa[0].line_end})`);
assert(cd.every((p) => p.witness_name === 'JOON PARK'), `the sheet header names the witness (${JSON.stringify([...new Set(cd.map((p) => p.witness_name))])})`);
assert(!cd.some((p) => /CONFIDENTIAL TESTIMONY/.test(p.text)), 'the sheet header is not testimony');
ok('condensed transcript: pages and lines come from the markers, witness from the header');

// An interior page of a transcript with no Q./A. on it (a long answer) is
// still testimony on the second pass; the word index after the last page is not.
const longAnswer = Array.from({ length: 25 }, (_, i) => `${String(i + 1).padStart(2)}   and then the officers took him down the corridor toward the clinic, line ${i + 1}.`).join('\n');
const index = Array.from({ length: 25 }, (_, i) => `${String(i + 1).padStart(2)}   corridor 41:2, 88:${i + 1}`).join('\n');
const doc = chunkPages([{ pageNumber: 1, text: page }, { pageNumber: 2, text: longAnswer }, { pageNumber: 3, text: nyPage }, { pageNumber: 4, text: index }]);
assert(doc.filter((p) => p.page_start === 2).every((p) => p.passage_type !== 'monologue' && p.line_start != null), 'the interior long-answer page keeps its line numbers');
assert(doc.filter((p) => p.page_start === 4).every((p) => p.passage_type === 'monologue'), 'the word index after the last transcript page stays prose');
ok('interior pages without Q./A. are read on the second pass; trailing index pages are not');

// A page of prose with a couple of digit-led lines must still be prose.
const prose = chunkPages([{ pageNumber: 3, text: 'The court held that the officers acted reasonably.\n1 Fed. R. Civ. P. 56.\n2 See also id. at 14.\n' + 'More discussion follows here. '.repeat(20) }]);
assert(prose.every((p) => p.passage_type !== 'qa_pair'), 'citation footnotes are not a transcript');
ok('prose with numbered footnotes stays prose');

console.log(`\nPASS (${n} checks)`);
