// Transcript mode must survive the blank numbered lines every reporter
// leaves in a page, and a transcript citation must name the page the REPORTER
// printed. No network. Run: node scripts/_test-transcript-parse.mjs
//
// 2026-09-10: parseTranscriptPage's line regex let the gap after a line
// number match a newline, so a blank numbered line swallowed the next line's
// text ("5\n6  Q. Why" → line 5 = "6  Q. Why"); the Q./A. test then never
// fired and the page — and with it a whole deposition — fell to prose.
//
// 2026-09-21: every full-size transcript was cited by the PDF's page INDEX.
// Part 2 of this file (below the first PASS block) exercises the printed-page
// detector on one synthetic fixture per layout the corpus actually holds.
// Every fixture here is invented; no client transcript is copied into this
// repo.
import assert from 'node:assert';
import { chunkPages, analyzeTranscriptPages, paginatePlainText } from '../lib/ingest-core.mjs';

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

console.log(`\nchunking: ${n} checks`);


// =============================================================================
// PART 2 — the reporter's printed page
//
// Until 2026-09-21 a full-size transcript's page_start was the PDF's page
// index. On a clean PDF the two agree by luck; wrap the same transcript as an
// exhibit and every cite in it is one page high. "Blake Dep. 16:4" then reads
// like a real citation and points at the wrong answer.
//
// Each fixture below is one layout the corpus holds. All are synthetic.
// =============================================================================

// A reporter's page: the printed page number set to the right above the
// line-number column, then 25 numbered lines of testimony.
const RIGHT = ' '.repeat(50);
const BODY = [
  'Q.   Where were you on the morning in question?',
  '',
  'A.   In the clinic, in the intake area.',
  'That is where I was posted.',
  '',
  'Q.   Who else was there?',
  'A.   Captain Blake and Officer Owens.',
  '',
];
function reporterPage(printed, { firstLine = 1, count = 25, header = true, footer = false, headerText } = {}) {
  const out = [];
  const mark = headerText === undefined ? (printed == null ? null : String(printed)) : headerText;
  if (header && mark != null) out.push(RIGHT + mark);
  for (let i = 0; i < count; i++) {
    const body = BODY[i % BODY.length];
    const num = String(firstLine + i).padStart(2);
    out.push(body ? `${num}   ${body}` : num);
  }
  if (footer && mark != null) out.push(RIGHT + mark);
  return out.join('\n');
}
const slipSheet = 'EXHIBIT F\n\nDeposition of Desmond Blake\nOctober 28, 2022\n';
const exhibitPage = 'NEW YORK CITY DEPARTMENT OF CORRECTION\nUse of Force Report\n\nIncident 2015-0816-AMKC\nReporting officer: Owens\n';

const asPages = (texts) => texts.map((text, i) => ({ pageNumber: i + 1, text }));
const printedOf = (passages) => [...new Set(passages.map((p) => p.metadata?.printed_page))];

// ---- 1. A plain full-size transcript: index and printed page agree ---------
{
  const pages = asPages(Array.from({ length: 12 }, (_, i) => reporterPage(i + 1)));
  const v = analyzeTranscriptPages(pages);
  assert.strictEqual(v.is_transcript, true, 'read as a transcript');
  assert.strictEqual(v.confidence, 'high', `confidence high (${v.confidence}: ${v.reason})`);
  assert.strictEqual(v.claimed, true, 'a printed page is claimed');
  assert.strictEqual(v.segments.length, 1, `one run (${JSON.stringify(v.segments)})`);
  assert.strictEqual(v.segments[0].offset, 0, 'offset 0');
  assert.strictEqual(v.map.get(7), 7, 'PDF p. 7 is printed p. 7');
  const passages = chunkPages(pages);
  assert(passages.every((p) => p.metadata?.page_source === 'printed'), 'every passage cites a printed page');
  assert(passages.filter((p) => p.page_start === 7).every((p) => p.metadata.printed_page === 7), 'the passage records printed page 7');
  assert(passages.every((p) => p.metadata.pdf_page === p.page_start), 'the PDF index is kept beside it, for the Reader');
  ok('full-size transcript, no wrapper: printed page read on every page, offset 0');
}

// ---- 2. THE RECORDED EXAMPLE: exhibit-wrapped, constant -1 ----------------
// Bañuelos Exh. F, 2026-09-19: PDF p. 16 is transcript p. 15.
{
  const pages = asPages([slipSheet, ...Array.from({ length: 16 }, (_, i) => reporterPage(i + 1))]);
  const v = analyzeTranscriptPages(pages);
  assert.strictEqual(v.confidence, 'high', `confidence high (${v.confidence}: ${v.reason})`);
  assert.strictEqual(v.segments.length, 1, `one run (${JSON.stringify(v.segments)})`);
  assert.strictEqual(v.segments[0].offset, -1, `offset -1 (${v.segments[0].offset})`);
  assert.strictEqual(v.map.get(16), 15, 'PDF p. 16 is transcript p. 15 — the recorded example');
  assert.strictEqual(v.map.has(1), false, 'the slip sheet itself gets no printed page');
  const passages = chunkPages(pages);
  const onPdf16 = passages.filter((p) => p.page_start === 16);
  assert(onPdf16.length > 0 && onPdf16.every((p) => p.metadata.printed_page === 15), 'the passages on PDF p. 16 cite transcript p. 15');
  ok('exhibit-wrapped transcript: PDF p. 16 = transcript p. 15 (the off-by-the-slip-sheet bug)');
}

// ---- 3. Pages inserted mid-transcript: the offset changes once ------------
{
  const pages = asPages([
    ...Array.from({ length: 6 }, (_, i) => reporterPage(i + 1)),
    exhibitPage, exhibitPage,
    ...Array.from({ length: 8 }, (_, i) => reporterPage(i + 7)),
  ]);
  const v = analyzeTranscriptPages(pages);
  assert.strictEqual(v.confidence, 'high', `confidence high (${v.confidence}: ${v.reason})`);
  assert.strictEqual(v.segments.length, 2, `two runs (${JSON.stringify(v.segments)})`);
  assert.deepStrictEqual(v.segments.map((s) => s.offset), [0, -2], 'offset 0, then -2');
  assert.strictEqual(v.map.get(6), 6, 'before the insert, PDF p. 6 is printed p. 6');
  assert.strictEqual(v.map.get(9), 7, 'after two inserted pages, PDF p. 9 is printed p. 7');
  assert.strictEqual(v.map.has(7), false, 'the inserted exhibit pages get no printed page');
  ok('front matter / inserted pages: the offset changes once and both runs are mapped');
}

// ---- 4. Volume 2 — the numbering continues from volume 1 ------------------
{
  const pages = asPages(Array.from({ length: 12 }, (_, i) => reporterPage(214 + i)));
  const v = analyzeTranscriptPages(pages);
  assert.strictEqual(v.confidence, 'high', `confidence high (${v.confidence}: ${v.reason})`);
  assert.strictEqual(v.segments[0].offset, 213, `offset +213 (${v.segments[0].offset})`);
  assert.strictEqual(v.map.get(1), 214, 'PDF p. 1 is printed p. 214');
  assert.strictEqual(v.map.get(12), 225, 'PDF p. 12 is printed p. 225');
  ok('volume 2: printed page 214 on PDF page 1, and the whole volume follows');
}

// ---- 5. A noisy OCR page number, and two pages with none -----------------
// "15" comes back "l5", "18" comes back "I8", two headers are lost entirely.
// The sequence is what recovers them: no page is read in isolation.
{
  const texts = Array.from({ length: 12 }, (_, i) => {
    const pdf = i + 1;
    const printed = pdf + 10;
    if (pdf === 3 || pdf === 9) return reporterPage(printed, { header: false, headerText: null });
    if (pdf === 5) return reporterPage(printed, { headerText: 'l5' });
    if (pdf === 8) return reporterPage(printed, { headerText: 'I8' });
    return reporterPage(printed);
  });
  const v = analyzeTranscriptPages(asPages(texts));
  assert.strictEqual(v.confidence, 'high', `confidence high (${v.confidence}: ${v.reason})`);
  assert.strictEqual(v.segments[0].offset, 10, `offset +10 (${v.segments[0].offset})`);
  assert.strictEqual(v.map.get(5), 15, '"l5" is read as 15');
  assert.strictEqual(v.map.get(8), 18, '"I8" is read as 18');
  assert.strictEqual(v.map.get(3), 13, 'the page with no readable number is recovered from the run');
  assert.strictEqual(v.map.get(9), 19, 'and so is the second one');
  assert.strictEqual(v.mapped_pages, 12, 'all twelve pages are mapped');
  assert(v.evidence_pages < 12, `two pages carried no evidence of their own (${v.evidence_pages})`);
  ok('OCR noise ("l5", "I8") and missing headers are recovered by the sequence fit');
}

// ---- 6. Line numbers that do not reset: the mapping is not trusted --------
// A printout whose line numbers run on through 40-line blocks rather than
// starting again on each page. The page numbers look perfect; the pagination
// underneath them is the printer's, not the reporter's.
{
  const control = asPages(Array.from({ length: 12 }, (_, i) => reporterPage(i + 1, { count: 8 })));
  const cv = analyzeTranscriptPages(control);
  assert.strictEqual(cv.confidence, 'high', `control is high (${cv.confidence}: ${cv.reason})`);
  assert.deepStrictEqual(cv.conflicts, [], 'the control has no conflict');

  const runOn = asPages(Array.from({ length: 12 }, (_, i) =>
    reporterPage(i + 1, { count: 8, firstLine: 1 + (i % 5) * 8 })));
  const v = analyzeTranscriptPages(runOn);
  assert(v.conflicts.some((c) => /line numbers do not reset/.test(c)), `the conflict is named (${JSON.stringify(v.conflicts)})`);
  assert.notStrictEqual(v.confidence, 'high', `confidence is below high (${v.confidence})`);
  assert.strictEqual(v.claimed, false, 'nothing is claimed');
  const passages = chunkPages(runOn);
  assert(passages.every((p) => p.metadata?.page_source === 'pdf_index'), 'every passage says its page is the PDF index');
  assert(passages.every((p) => p.metadata.printed_page === undefined), 'no printed page is invented');
  assert(passages.every((p) => p.metadata.printed_page_confidence === v.confidence), 'the confidence rides on the passage for the citation builder');
  ok('line numbers that do not reset at a page boundary lower the confidence, and nothing is claimed');
}

// ---- 7. Genuinely ambiguous: two tokens, no sequence ---------------------
{
  const texts = Array.from({ length: 12 }, (_, i) => {
    if (i === 2) return reporterPage(3);
    if (i === 7) return reporterPage(41);
    return reporterPage(null, { header: false, headerText: null });
  });
  const v = analyzeTranscriptPages(asPages(texts));
  assert.strictEqual(v.confidence, 'none', `confidence none (${v.confidence}: ${v.reason})`);
  assert.strictEqual(v.claimed, false, 'nothing is claimed');
  assert.deepStrictEqual(v.segments, [], 'no run was believed');
  assert.match(v.reason, /sequence|printed outside/, `the reason says why (${v.reason})`);
  const passages = chunkPages(asPages(texts));
  assert(passages.every((p) => p.metadata?.page_source === 'pdf_index' && p.metadata.printed_page_confidence === 'none'),
    'the passages carry "this page is the PDF index"');
  ok('an ambiguous document claims no printed page and says the page is the PDF index');
}

// ---- 8. A document that is not a transcript is left alone ----------------
{
  const brief = (p) => `MEMORANDUM OF LAW\n\nThe court held that the officers acted reasonably under the\n`
    + `circumstances then known to them. ${'The record shows otherwise. '.repeat(12)}\n\n${p}\n`;
  const pages = asPages(Array.from({ length: 8 }, (_, i) => brief(i + 1)));
  const v = analyzeTranscriptPages(pages);
  assert.strictEqual(v.is_transcript, false, 'not a transcript');
  assert.strictEqual(v.claimed, false, 'nothing claimed');
  assert.strictEqual(v.method, 'none', 'no method ran');
  const passages = chunkPages(pages);
  assert(passages.length > 0, 'it still chunks');
  assert(passages.every((p) => p.metadata === undefined), 'no page-source metadata is written on a non-transcript');
  assert(passages.every((p) => p.passage_type === 'monologue'), 'it is still prose');
  ok('a brief with page numbers in the footer is not touched');
}

// ---- 9. Condensed 4-up sheets: unchanged, plus the PDF page recovered ----
{
  const cd2 = chunkPages([{ pageNumber: 10, text: condensed }]);
  const cd2Qa = cd2.filter((p) => p.passage_type === 'qa_pair');
  assert(cd2Qa.some((p) => p.page_start === 34) && cd2Qa.some((p) => p.page_start === 35),
    'cites still name the transcript page, not the sheet');
  assert(cd2.every((p) => p.metadata.page_source === 'printed'), 'a condensed panel is a printed page');
  assert(cd2.every((p) => p.metadata.printed_page === p.page_start), 'printed_page agrees with the cite');
  assert(cd2.every((p) => p.metadata.pdf_page === 10), 'and the sheet\'s own PDF page is now kept, for the Reader');
  const v = analyzeTranscriptPages([{ pageNumber: 10, text: condensed }]);
  assert.strictEqual(v.method, 'condensed_marker', `method is the marker (${v.method})`);
  assert.strictEqual(v.confidence, 'high', 'confidence high');
  ok('condensed sheets are unchanged, and the sheet\'s PDF page is no longer thrown away');
}

// ---- 10. A transcript printed to a text file -----------------------------
// The "TXT FILE" copy every reporter ships. Form feeds between pages: until
// now the whole file arrived as ONE page and every passage cited p. 1.
{
  const txt = Array.from({ length: 10 }, (_, i) => reporterPage(101 + i)).join('\f\n');
  const pages = paginatePlainText(txt);
  assert.strictEqual(pages.length, 10, `form feeds paginate the file (${pages.length} pages)`);
  const v = analyzeTranscriptPages(pages);
  assert.strictEqual(v.confidence, 'high', `confidence high (${v.confidence}: ${v.reason})`);
  assert.strictEqual(v.map.get(1), 101, 'the first block is printed p. 101');
  assert.strictEqual(v.map.get(10), 110, 'the last block is printed p. 110');
  ok('a form-feed TXT printout paginates, and its cites carry the reporter\'s page');
}

// ---- 11. A TXT printout with zero-padded marker lines, no form feeds -----
{
  const txt = Array.from({ length: 8 }, (_, i) =>
    `${String(15 + i).padStart(5, '0')}\n${reporterPage(null, { header: false, headerText: null })}`).join('\n');
  const pages = paginatePlainText(txt);
  assert.strictEqual(pages.length, 8, `the marker lines paginate the file (${pages.length} pages)`);
  const v = analyzeTranscriptPages(pages);
  assert.strictEqual(v.claimed, true, `a printed page is claimed (${v.confidence}: ${v.reason})`);
  assert.strictEqual(v.map.get(1), 15, 'the first block is printed p. 15');
  assert.strictEqual(v.map.get(8), 22, 'the last block is printed p. 22');
  ok('a marker-line TXT printout paginates and carries the reporter\'s page');
}

// ---- 12. Ordinary text files are NOT paginated ---------------------------
{
  const note = 'Call with client 2026-09-02.\n\n1\n2\n3\n4\n5\n6\n\nFollow up on the scheduling order.\n';
  assert.strictEqual(paginatePlainText(note).length, 1, 'a numbered list is not a transcript printout');
  const md = '# Heading\n\nSome notes about the motion.\n\n- one\n- two\n';
  assert.strictEqual(paginatePlainText(md).length, 1, 'a markdown note is one page, as before');
  ok('a plain text file without form feeds or a page-marker sequence is still one page');
}

// ---- 13. The detector's verdict is on the document, for a later audit ----
{
  const pages = asPages([slipSheet, ...Array.from({ length: 16 }, (_, i) => reporterPage(i + 1))]);
  const report = {};
  chunkPages(pages, { report });
  const v = report.printedPages;
  assert(v && v.is_transcript && v.claimed, 'chunkPages reports its verdict through opts.report');
  assert.strictEqual(typeof v.reason, 'string', 'the verdict carries a reason in words');
  assert(v.segments.length === 1 && v.segments[0].printed_from === 1 && v.segments[0].printed_to === 16,
    `the segments are compact enough to store (${JSON.stringify(v.segments)})`);
  ok('the verdict rides out of chunkPages for documents.metadata.transcript_pages');
}

// ---- 14. The header as a PDF text layer really emits it ------------------
// pdf-parse joins a baseline with NO separator and NO indentation. So a page
// number set to the right arrives at column 0 ("15"), or welded to the running
// header ("DESMOND BLAKE15"). And on printed pages 1 and 2 that bare header is
// indistinguishable from the first line of the line-number column unless the
// column is anchored on a line whose successor follows it.
{
  const flat = (printed) => [String(printed), ...Array.from({ length: 25 }, (_, i) => {
    const body = BODY[i % BODY.length];
    const num = String(1 + i).padStart(2);
    return body ? `${num}   ${body}` : num;
  })].join('\n');

  const pages = asPages([slipSheet, ...Array.from({ length: 16 }, (_, i) => flat(i + 1))]);
  const v = analyzeTranscriptPages(pages);
  assert.strictEqual(v.confidence, 'high', `confidence high (${v.confidence}: ${v.reason})`);
  assert.strictEqual(v.segments[0].offset, -1, `offset -1 (${JSON.stringify(v.segments)})`);
  assert.strictEqual(v.map.get(2), 1, 'PDF p. 2 is printed p. 1 — the bare "1" header is not read as line 1');
  assert.strictEqual(v.map.get(3), 2, 'and PDF p. 3 is printed p. 2');
  assert.strictEqual(v.map.get(16), 15, 'the recorded example still holds at column 0');
  assert.strictEqual(v.evidence_pages, 16, `every page carried its own evidence (${v.evidence_pages})`);

  const welded = (printed) => flat(printed).replace(/^(\d+)\n/, `DESMOND BLAKE${printed}\n`);
  const w = analyzeTranscriptPages(asPages(Array.from({ length: 12 }, (_, i) => welded(i + 31))));
  assert.strictEqual(w.confidence, 'high', `a welded running header is still read (${w.confidence}: ${w.reason})`);
  assert.strictEqual(w.map.get(1), 31, '"DESMOND BLAKE31" is printed p. 31');
  assert.strictEqual(w.map.get(12), 42, 'and the run carries to p. 42');
  ok('a bare column-0 header, including on printed pages 1 and 2, and a header welded to the witness name');
}

// ---- 15. A page outside every run says it knows nothing about itself -----
{
  const pages = asPages([slipSheet, ...Array.from({ length: 16 }, (_, i) => reporterPage(i + 1))]);
  const passages = chunkPages(pages);
  const onSlip = passages.filter((p) => p.page_start === 1);
  assert(onSlip.length > 0, 'the slip sheet is indexed');
  assert(onSlip.every((p) => p.metadata.page_source === 'pdf_index'), 'the slip sheet keeps the PDF index');
  assert(onSlip.every((p) => p.metadata.printed_page_confidence === 'none'),
    `and claims no confidence about ITSELF, whatever the document scored (${onSlip[0].metadata.printed_page_confidence})`);
  ok('a page outside every run never carries the document\'s confidence next to a caveat');
}

// ---- 16. The audit reports what would change, from a fixture -------------
// Offline by construction: the same two functions the --db mode calls, fed
// page text and parsed passages held here. No network, no credentials.
{
  const { auditFixture, auditParsed } = await import('./audit-transcript-pages.mjs');

  const wrapped = auditFixture({
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    pages: [slipSheet, ...Array.from({ length: 16 }, (_, i) => reporterPage(i + 1))]
      .map((text, i) => ({ pageNumber: i + 1, text })),
  });
  assert.strictEqual(wrapped.claimed, true, 'the exhibit-wrapped fixture claims a printed page');
  assert.strictEqual(wrapped.maxShift, 1, `every cite in it moves by one page (${wrapped.maxShift})`);
  // Every citation except the slip sheet's own — it is outside the transcript,
  // so it is mapped to nothing and keeps the PDF index it always had.
  assert.strictEqual(wrapped.changing, wrapped.citations - 1,
    `every citation in the transcript would change (${wrapped.changing} of ${wrapped.citations})`);
  assert.strictEqual(wrapped.id.length, 8, 'the report prints an id, shortened');

  const clean = auditFixture({
    id: 'bbbbbbbb-1111-2222-3333-444444444444',
    pages: Array.from({ length: 12 }, (_, i) => ({ pageNumber: i + 1, text: reporterPage(i + 1) })),
  });
  assert.strictEqual(clean.changing, 0, 'a transcript whose index already matches changes nothing');

  const legacy = auditParsed({
    id: 'cccccccc-1111-2222-3333-444444444444',
    page_count: 172,
    passages: [{ id: 'p1', page_start: 16 }, { id: 'p2', page_start: 17 }],
  });
  assert.strictEqual(legacy.claimed, false, 'a document with no recorded verdict claims nothing');
  assert.match(legacy.reason, /before the detector existed/, 'and says why');
  assert.strictEqual(legacy.changing, 0, 'nothing can be said to change until it is re-indexed');

  const reindexed = auditParsed({
    id: 'dddddddd-1111-2222-3333-444444444444',
    transcript_pages: { is_transcript: true, method: 'sequence_fit', confidence: 'high', claimed: true,
      pages_total: 17, transcript_pages: 16, evidence_pages: 16, mapped_pages: 16,
      segments: [{ from_pdf: 2, to_pdf: 17, offset: -1, printed_from: 1, printed_to: 16, evidence: 16 }],
      reason: 'recorded at ingest' },
    passages: [
      { id: 'p1', page_start: 16, metadata: { printed_page: 15 } },
      { id: 'p2', page_start: 16, metadata: { printed_page: 15 } },
      { id: 'p3', page_start: 1, metadata: { page_source: 'pdf_index' } },
    ],
  });
  assert.strictEqual(reindexed.changing, 2, 'two of the three citations move');
  assert.strictEqual(reindexed.maxShift, 1, 'by one page');
  assert.strictEqual(reindexed.offsets, '2–17:-1', `the offsets read plainly (${reindexed.offsets})`);
  ok('the audit reports the mapping, the confidence and how many cites would change — offline, ids and numbers only');
}

// =============================================================================
// PART 3 — the number the reporter printed is not a line
//
// A connector search on 2026-09-21 returned, from a deposition in the demo
// record, a passage cited "35:35-7": page 35, lines 35 through 7. A transcript
// page has 25 lines, line 35 does not exist, and an end before the start is
// nonsense. The passage text began "1  A. It did…" — the reporter's own line
// number sitting INSIDE the testimony.
//
// One cause for both halves. The page number the reporter prints in the
// running header is a 1-2 digit token alone on its line, shaped exactly like a
// line number; read as one it becomes "line 35" on a 25-line page. Under the
// pre-2026-09-10 gap (`\s{1,6}`, which crossed the newline) it also swallowed
// the first real line and carried its "1" into the text. That gap was fixed by
// PR #138 — the cite above was indexed before it — but the header itself was
// still read as a line, and it is the same mistake PR #205 §8 recorded for
// pages with no numbers in the text layer. Nothing above the line-number
// column is a line: that is now read once, in lineColumnBounds.
//
// Fixtures are invented. No transcript from any matter is copied into this repo.
// =============================================================================

// A reporter's page as a PDF text layer emits it: running header, date, the
// printed page number alone on its line, then the numbered column.
const LINES_PER_PAGE = 25;
const depoPage = (printed, lines) => {
  assert.strictEqual(lines.length, LINES_PER_PAGE, `a reporter's page holds ${LINES_PER_PAGE} lines`);
  return [
    'MARGUERITE OYELARAN -- Vol. I',
    'March 3, 2026',
    String(printed),
    ...lines.map((t, i) => `${String(i + 1).padStart(2, ' ')}${t ? '  ' + t : ''}`),
    'Quainton Reporting Services -- INVENTED FIXTURE',
  ].join('\n');
};

const P34 = [
  'Q. When did you first see the revised specification?',
  'A. In the first week of February.',
  '',
  'Q. Who gave it to you?',
  'A. It came around on the distribution list.',
  '',
  'Q. Did you read it that week?',
  'A. I read the parts that touched procurement.',
  '',
  'Q. Which parts were those?',
  'A. Seven and eight, and the tables at the back.',
  '',
  'Q. Did section 7.3 change?',
  'A. No. Section 7.3 stayed the same.',
  '',
  'Q. You are certain of that?',
  'A. I am certain of that.',
  '',
  'Q. Are you familiar with Revision C?',
  'A. I know there was a Revision C in March.',
  '',
  'Q. Did Revision C change anything you bought to?',
  'A. No. The alloy stayed the same.',
  'Q. So the specification still called for the same alloy in',
  'March of that year.',
];
const P35 = [
  'A. It did. And it still did in May, and it still did the',
  'following March. No one ever revised 7.3.',
  'Q. The change order superseded it?',
  'A. A change order is a deviation from the specification.',
  'That is what a change order is.',
  '',
  'Q. Was the specification ever revised to reflect it?',
  'A. Not that I have seen.',
  '',
  'Q. Would a reader of the specification know?',
  'A. They would have to go and find the change order.',
  '',
  'Q. Where would they find it?',
  'A. In the change order log.',
  '',
  'Q. Would they know to look?',
  'A. They would have to know that one existed.',
  '',
  'Q. Did you tell anyone?',
  'A. I told my project manager.',
  '',
  'Q. When?',
  'A. The same week.',
  'Q. In writing?',
  'A. In writing, yes.',
];
// The pages around them: the same testimony rotated, so the run of printed
// numbers is long enough for the detector to fit (it wants six).
const rot = (body, k) => [...body.slice(k), ...body.slice(0, k)];

{
  const pages = [31, 32, 33, 34, 35, 36, 37, 38].map((n2) => ({
    pageNumber: n2,
    text: depoPage(n2, n2 === 34 ? P34 : n2 === 35 ? P35 : rot(n2 % 2 ? P34 : P35, n2 % 5)),
  }));
  const report = {};
  const ps = chunkPages(pages, { report });
  const lined = ps.filter((p) => p.line_start != null);
  assert(lined.length >= 8, `the four pages are read as transcript (${lined.length} located passages)`);

  const impossible = lined.filter((p) => p.line_start < 1 || p.line_start > 25 || p.line_end < 1 || p.line_end > 25);
  assert.deepStrictEqual(impossible.map((p) => `${p.page_start}:${p.line_start}-${p.line_end}`), [],
    'no line number outside the 25 lines of a page');
  const backwards = lined.filter((p) => p.page_start === p.page_end && p.line_end < p.line_start);
  assert.deepStrictEqual(backwards.map((p) => `${p.page_start}:${p.line_start}-${p.line_end}`), [],
    'no citation ends before it starts');
  const leaked = ps.filter((p) => /^\s*\d{1,2}[ \t]{1,6}\S/.test(p.text));
  assert.deepStrictEqual(leaked.map((p) => p.text.slice(0, 40)), [],
    'no line-number token is left inside a passage');
  assert(!ps.some((p) => /^3[3-6]$/m.test(p.text.trim())), 'the printed page number is not testimony');

  const p35 = lined.filter((p) => p.page_start === 35);
  assert.strictEqual(p35[0].line_start, 1, `the answer at the top of p. 35 is line 1, not line 35 (${p35[0].line_start})`);
  assert.match(p35[0].text, /^A\. It did\./, `and its text is the answer, not "1  A. It did…" (${JSON.stringify(p35[0].text.slice(0, 24))})`);
  assert(p35[0].line_end >= 2 && p35[0].line_end <= 25, `ending inside the page (${p35[0].line_end})`);
  const p34 = lined.filter((p) => p.page_start === 34);
  assert.strictEqual(p34[p34.length - 1].line_end, 25, 'the question it answers runs to the foot of p. 34');
  ok(`the page-number header is not a line: p. 34 ends at 34:25 and p. 35 opens at 35:1-${p35[0].line_end} (was "35:35-7")`);

  // The page reader and the line reader now share one boundary. Reading the
  // header out of the line column must not blind the detector to it.
  assert.strictEqual(report.printedPages.claimed, true, 'the printed page is still read from that same header');
  assert.strictEqual(p35[0].metadata?.printed_page, 35, `and the cite carries it (${JSON.stringify(p35[0].metadata)})`);
  ok('the printed-page detector still reads the header the line reader ignores');
}

{
  // Same page, from a text layer that sets the header number on the same
  // baseline as the first line and welds them: "35  1  A. It did…". The line is
  // testimony and must survive with its own number.
  const welded = depoPage(35, P35).replace('35\n 1  A. It did.', '35  1  A. It did.');
  assert(/^35 {2}1 {2}A\./m.test(welded), 'the fixture really is welded');
  const ps = chunkPages([{ pageNumber: 35, text: welded }]).filter((p) => p.line_start != null);
  assert.strictEqual(ps[0].line_start, 1, `the welded line is line 1 (${ps[0].line_start})`);
  assert.match(ps[0].text, /^A\. It did\./, `carrying its own text (${JSON.stringify(ps[0].text.slice(0, 24))})`);
  assert(ps.every((p) => p.line_start >= 1 && p.line_end <= 25), 'and the rest of the page is unmoved');
  ok('a header welded to the first line keeps the testimony and drops the page number');
}

{
  // The same header on a page with NO numbers in the text layer — the case
  // PR #205 §8 recorded and did not fix: the bare "35" was counted as text
  // line 1 and every inferred cite on the page sat one line low.
  const body = [
    'Q. Was the specification ever revised to reflect it?',
    'A. Not that I have seen.',
    'Q. Would a reader of the specification know?',
    'A. They would have to go and find the change order.',
    'Q. Where would they find it?',
    'A. In the change order log, and in document control.',
    'Q. Would they know to look?',
    'A. They would have to know that one existed.',
    'Q. Did you tell anyone?',
    'A. I told my project manager the same week.',
    'Q. In writing?',
    'A. In writing, yes.',
    'Q. Did he answer?',
    'A. He said he would raise it.',
    'Q. Did he?',
    'A. I never saw anything come back.',
  ];
  const inferredPage = ['35', ...body].join('\n');
  const ps = chunkPages([{ pageNumber: 35, text: inferredPage }]).filter((p) => p.line_start != null);
  assert(ps.length >= 1 && ps[0].metadata?.line_numbers === 'inferred', 'the page is read with inferred line numbers');
  assert.strictEqual(ps[0].line_start, 1, `the first question is line 1, not line 2 (${ps[0].line_start})`);
  assert.match(ps[0].text, /^Q\. Was the specification/, 'and the page number is not the first line of testimony');
  assert(!ps.some((p) => /(^|\n)35(\n|$)/.test(p.text)), 'the page number is nowhere in the text');
  ok('inferred line numbers no longer count the page-number header as line 1 (PR #205 §8)');
}

console.log(`\nPASS (${n} checks)`);
