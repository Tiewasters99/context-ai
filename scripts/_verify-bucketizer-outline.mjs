// Probe: the evidence pass and the trial outline. Entirely offline — no
// network, no .env, no database, no model. Node 22.18+ strips the .ts types.
//
// What is asserted here, and why each one is a bug that would otherwise ship:
//
//   1. VERBATIM QUOTATION. A quotation that the stored passage does not hold
//      word for word is DROPPED, never repaired. A model that re-flowed the
//      line breaks is accepted (a PDF text layer wraps where the page broke);
//      a model that changed a WORD, a spelling or the capitalisation is not.
//      This is the one invariant in the product that ends up read aloud in a
//      courtroom (feedback: deposition-fidelity).
//   2. CITATIONS DEGRADE HONESTLY. page:line where the transcript carries line
//      numbers; page-only, MARKED, where it does not — which is the state
//      every Fleming deposition is in today; positional line numbers marked as
//      positional; and the standing note about the PDF page index, which is a
//      live system-wide fidelity problem with no per-passage flag to read.
//      No line number is ever synthesized.
//   3. GAPS COME FIRST, and in the order a trial team works them.
//   4. THE ASSEMBLY IS DETERMINISTIC. The same tree and the same confirmed
//      evidence produce a BYTE-IDENTICAL .md. Without that, "the outline has
//      changed" means nothing.
//   5. THE .docx IS A REAL WORD FILE, with the DRAFT legend on every page (it
//      rides in the running header), a real block quote, and the citation.
//   6. A RE-RUN IS A NEW VERSION. Nothing filed is overwritten.
//   7. RESUME. A pairing already read is not paid for again.
//   8. THE SEALED PATH. A refusal from the sealed pen fails that pairing
//      plainly and the pass carries on; 402 stops the pass and keeps the work.
//
//   node --import ./scripts/_node-src-loader.mjs scripts/_verify-bucketizer-outline.mjs

import {
  findVerbatim,
  normalizeQuoteText,
  MIN_QUOTE_CHARS,
  MAX_QUOTE_CHARS,
} from '../src/lib/bucketizer/quote.ts';
import { buildCite, isTranscript, readerUrl, PDF_INDEX_PAGE_NOTE } from '../src/lib/bucketizer/cite.ts';
import {
  buildOutline,
  outlineFilename,
  isFiledOutline,
  roman,
  alpha,
  DRAFT_LEGEND,
} from '../src/lib/bucketizer/outline-model.ts';
import { renderOutlineMarkdown } from '../src/lib/bucketizer/outline-md.ts';
import { renderOutlineDocx } from '../src/lib/bucketizer/outline-docx.ts';
import {
  findEvidenceForPair,
  runEvidencePass,
  partitionPairs,
} from '../src/lib/bucketizer/evidence-run.ts';
import { checkEvidenceContract } from '../src/lib/bucketizer/evidence-prompt.ts';
import { estimateEvidenceRun } from '../src/lib/bucketizer/evidence-estimate.ts';
import { LlmCallError } from '../src/lib/bucketizer/llm-error.ts';

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}`); if (detail !== undefined) console.log(`      ${detail}`); }
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// Fixtures — a synthetic matter. No real client material appears in this repo.
//
// Voss v. Harbor Municipal Authority: a §1983 excessive-force claim with a
// Monell count that has nothing under it yet, and a negligent-supervision
// count that is thin. The four documents between them cover every citation
// tier the corpus actually produces.
// ---------------------------------------------------------------------------

const MATTER = { id: 'm-voss', title: 'Voss v. Harbor Municipal Authority', shortCode: 'voss' };

const NODES = [
  { id: 'n1', parent_id: null, kind: 'claim', label: 'Excessive force (§ 1983, Fourth Amendment)', description: 'The March 4 stairwell contact and the force used in it.', position: 0 },
  { id: 'n1a', parent_id: 'n1', kind: 'element', label: 'The force was objectively unreasonable', description: 'Graham factors: severity of the offence, immediacy of the threat, active resistance.', position: 0 },
  { id: 'n1a1', parent_id: 'n1a', kind: 'subissue', label: 'Whether Mr. Voss was restrained before the strikes', description: 'Testimony and reports bearing on whether he was already handcuffed.', position: 0 },
  { id: 'n1b', parent_id: 'n1', kind: 'element', label: 'Municipal policy or custom (Monell)', description: 'A policy, custom or failure to train that caused the violation.', position: 1 },
  { id: 'n2', parent_id: null, kind: 'claim', label: 'Negligent supervision', description: 'The Authority\'s supervision of Sgt. Marlow.', position: 1 },
  { id: 'n2a', parent_id: 'n2', kind: 'element', label: 'Duty', description: 'The supervisory relationship and its scope.', position: 0 },
  { id: 'n2b', parent_id: 'n2', kind: 'element', label: 'Damages', description: 'Medical, economic and non-economic loss.', position: 1 },
  { id: 't1', parent_id: null, kind: 'theme', label: 'Credibility of Sgt. Marlow', description: 'Prior inconsistent statements and the incident report.', position: 2 },
];

// D1 — a transcript indexed WITH line numbers (what a re-ingested deposition
// looks like). D2 — a transcript with a page and no lines, witness null,
// doc_type 'other': exactly the state every Fleming deposition is in today,
// and only the TITLE says it is a deposition. D3 — an ordinary exhibit.
// D4 — line numbers counted by position, flagged 'inferred' (PR #138).
const DOCUMENTS = [
  { id: 'd1', title: '2026-02-11 - PDF - FULL SIZE - ALMA RIVERA', doc_type: 'deposition', witness_name: 'ALMA RIVERA' },
  { id: 'd2', title: 'Deposition of Sgt. Dale Marlow 11.02.25 (Confidential)', doc_type: 'other', witness_name: null },
  { id: 'd3', title: 'Harbor Municipal incident report 114-A.pdf', doc_type: 'other', witness_name: null },
  { id: 'd4', title: '2026-03-12 - PDF - FULL SIZE - RAY OKONKWO, M.D.', doc_type: 'other', witness_name: null },
];

const P1_TEXT =
  'Q.   And at the moment the first strike landed, were\n'
  + 'Mr. Voss\'s hands behind his back?\n'
  + 'A.   They were. I had already put the cuffs on him\n'
  + 'and I had hold of the chain.';
const P2_TEXT =
  'A. I did not see the stairwell at all. I was on the landing above, facing the other way, '
  + 'and the first I knew of it was the sound.';
const P3_TEXT =
  'At 21:14 the subject was secured in restraints. No further force was applied thereafter.';
const P4_TEXT =
  'A. The orbital fracture is consistent with a blunt impact delivered while the head was '
  + 'immobilised against a hard surface.';

const PASSAGES = [
  { id: 'p1', page_start: 61, page_end: 61, line_start: 4, line_end: 11, witness_name: 'ALMA RIVERA', metadata: {} },
  { id: 'p2', page_start: 88, page_end: 88, line_start: null, line_end: null, witness_name: null, metadata: {} },
  { id: 'p3', page_start: 3, page_end: 3, line_start: null, line_end: null, witness_name: null, metadata: {} },
  { id: 'p4', page_start: 47, page_end: 47, line_start: 9, line_end: 12, witness_name: 'RAY OKONKWO, M.D.', metadata: { line_numbers: 'inferred' } },
];
const PASSAGE_TEXT = { p1: P1_TEXT, p2: P2_TEXT, p3: P3_TEXT, p4: P4_TEXT };
const PASSAGE_DOC = { p1: 'd1', p2: 'd2', p3: 'd3', p4: 'd4' };

// ===========================================================================
section('1. Verbatim quotation — the span must be in the passage, or it is gone');
// ===========================================================================

{
  // Exact.
  const exact = findVerbatim(P1_TEXT, 'They were. I had already put the cuffs on him');
  check('an exact span is found', exact.ok === true);
  check(
    'and what is stored is the PASSAGE\'s characters, not the model\'s',
    exact.ok && P1_TEXT.slice(exact.match.offset, exact.match.offset + exact.match.quote.length) === exact.match.quote,
    exact.ok ? JSON.stringify(exact.match.quote) : '',
  );

  // Whitespace variant: the model re-flowed the line breaks and collapsed the
  // reporter's double spaces. A PDF text layer wraps where the PAGE broke, so
  // this is the normal case, not an edge case.
  const reflowed = findVerbatim(
    P1_TEXT,
    'They were. I had already put the cuffs on him and I had hold of the chain.',
  );
  check('a re-flowed span (newlines collapsed to spaces) is found', reflowed.ok === true,
    reflowed.ok ? '' : reflowed.reason);
  check(
    'and the stored quote carries the PASSAGE\'s own line break back',
    reflowed.ok && reflowed.match.quote.includes('\n'),
    reflowed.ok ? JSON.stringify(reflowed.match.quote) : '',
  );
  check(
    'the stored quote normalizes back to exactly what was asked for',
    reflowed.ok
      && normalizeQuoteText(reflowed.match.quote)
        === 'They were. I had already put the cuffs on him and I had hold of the chain.',
  );

  // Fabricated — the shape that must never reach a brief.
  const invented = findVerbatim(P1_TEXT, 'They were already handcuffed at that point.');
  check('a fabricated quotation is dropped', invented.ok === false && invented.reason === 'not_found');

  // One word changed. This is the dangerous one: it reads as verbatim.
  const oneWord = findVerbatim(P1_TEXT, 'They were. I had already put the cuffs on them');
  check('changing a single word is a miss, not a near-match', oneWord.ok === false);

  // Case changed. "Heyman" must stay "Heyman".
  const cased = findVerbatim(P1_TEXT, 'they were. I had already put the cuffs on him');
  check('changing capitalisation is a miss', cased.ok === false);

  // Ellipsis-joined spans are not continuous text.
  const joined = findVerbatim(P1_TEXT, 'They were … and I had hold of the chain.');
  check('two spans joined with an ellipsis are refused', joined.ok === false);

  check('a quotation under the floor is refused',
    findVerbatim(P1_TEXT, 'They were.').ok === false);
  check('a quotation over the ceiling is refused',
    findVerbatim('x'.repeat(MAX_QUOTE_CHARS + 50), 'x'.repeat(MAX_QUOTE_CHARS + 20)).ok === false);
  check('an empty quotation is refused', findVerbatim(P1_TEXT, '   ').ok === false);
  check(`the floor and ceiling are ${MIN_QUOTE_CHARS} and ${MAX_QUOTE_CHARS} characters`,
    MIN_QUOTE_CHARS > 0 && MAX_QUOTE_CHARS > MIN_QUOTE_CHARS);

  // A non-breaking space is whitespace: Veritext text layers emit them.
  const nbsp = findVerbatim('A.  I observed the pen at that time.', 'A. I observed the pen at that time.');
  check('a non-breaking space in the passage still matches a plain space', nbsp.ok === true);
}

// ===========================================================================
section('2. Citations degrade honestly, and never invent a line number');
// ===========================================================================

{
  const docById = Object.fromEntries(DOCUMENTS.map((d) => [d.id, d]));

  const c1 = buildCite(PASSAGES[0], docById.d1);
  check('a transcript with line numbers cites page:line', c1.text === 'Dep. of Rivera 61:4–11', c1.text);
  check('and carries no caveat', c1.caveat === null && c1.tier === 'page_line');

  // The live state of every Fleming deposition: doc_type 'other', witness
  // null, no line numbers. Only the TITLE says "Deposition", and if the title
  // did not count this would cite as an ordinary exhibit with no warning at
  // all — false confidence, which is the failure this tier exists to prevent.
  check('a transcript is recognised from its title alone', isTranscript(PASSAGES[1], docById.d2) === true);
  const c2 = buildCite(PASSAGES[1], docById.d2);
  check('a transcript with no line numbers stops at the page',
    c2.text === 'Deposition of Sgt. Dale Marlow 11.02.25 (Confidential), p. 88', c2.text);
  check('and says so on its own line',
    c2.caveat === 'page only — line numbers unavailable for this transcript' && c2.tier === 'page_only');
  check('no line number is synthesized for it', c2.lineStart === null && c2.lineEnd === null);

  const c3 = buildCite(PASSAGES[2], docById.d3);
  check('an ordinary exhibit cites document and page',
    c3.text === 'Harbor Municipal incident report 114-A, p. 3', c3.text);
  check('and is not marked as a transcript', c3.isTranscript === false && c3.caveat === null);

  const c4 = buildCite(PASSAGES[3], docById.d4);
  check('positionally numbered lines still cite page:line', c4.text === 'Dep. of Okonkwo, M.D. 47:9–12', c4.text);
  check('but say the numbers were counted, not printed',
    c4.tier === 'page_line_inferred'
    && c4.caveat === 'line numbers counted by position, not printed on the page', c4.caveat);

  // The branch that catches a Veritext PDF the title pattern misses: doc_type
  // "other", no witness recorded anywhere, but the passage carries line
  // numbers — which only the transcript chunker ever sets.
  check('a passage carrying line numbers is a transcript however the document is titled',
    isTranscript({ id: 'pz', page_start: 47, line_start: 9 }, docById.d4) === true);
  check('and it then cites the document rather than inventing a witness',
    buildCite({ id: 'pz', page_start: 47, line_start: 9, line_end: 12 }, docById.d4).text
      === '2026-03-12 - PDF - FULL SIZE - RAY OKONKWO, M.D. 47:9–12',
    buildCite({ id: 'pz', page_start: 47, line_start: 9, line_end: 12 }, docById.d4).text);

  const noPage = buildCite({ id: 'px', page_start: null, page_end: null }, docById.d3);
  check('a passage with no page cites the document and says the page is missing',
    noPage.tier === 'no_page' && noPage.caveat === 'no page recorded for this passage');

  const single = buildCite({ id: 'py', page_start: 12, line_start: 7, line_end: 7, witness_name: 'ALMA RIVERA' }, docById.d1);
  check('a one-line cite does not print a range', single.text === 'Dep. of Rivera 12:7', single.text);

  check('the reader deep link is the page-level one the app uses',
    readerUrl('d1', 61) === '/app/document/d1?page=61');
  check('and falls back to the document when there is no page',
    readerUrl('d1', null) === '/app/document/d1');
}

// ===========================================================================
section('3. The evidence pass — the model points, the code verifies');
// ===========================================================================

/** A fake world: passages, a call counter, and what was saved. */
function makeWorld({ answer, throwOn } = {}) {
  const world = { calls: [], saved: [] };
  world.deps = {
    now: () => '2026-09-20T14:32:00.000Z',
    async fetchPassages(ids) {
      return ids.map((id) => ({
        ...PASSAGES.find((p) => p.id === id),
        text: PASSAGE_TEXT[id],
      })).filter((p) => p.id);
    },
    async call(call) {
      world.calls.push({ attempt: call.attempt, nodeId: call.nodeId, documentId: call.documentId });
      if (throwOn && throwOn(call)) throw throwOn(call);
      return answer(call, world.calls.length);
    },
    async savePair(save) {
      world.saved.push({
        pair: save.pair.classificationId,
        items: save.items.map((i) => ({ passage_id: i.passage_id, quote: i.quote, position: i.position })),
        failed: save.failed,
        at: save.at,
      });
    },
  };
  return world;
}

const PAIR_D1 = {
  classificationId: 'c1', nodeId: 'n1a1', documentId: 'd1',
  documentTitle: DOCUMENTS[0].title, docType: 'deposition',
  documentWitness: 'ALMA RIVERA', passageIds: ['p1'],
};
const NODE_N1A1 = {
  id: 'n1a1', label: NODES[2].label, kind: 'subissue', description: NODES[2].description,
  ancestors: [{ kind: 'claim', label: NODES[0].label }, { kind: 'element', label: NODES[1].label }],
};

{
  const good = makeWorld({
    answer: () => ({
      evidence: [{
        ref: 'P1',
        quote: 'They were. I had already put the cuffs on him and I had hold of the chain.',
        why: 'Puts the handcuffs on before the first strike.',
      }],
    }),
  });
  const out = await findEvidenceForPair({
    pair: PAIR_D1, node: NODE_N1A1, deps: good.deps, modelId: 'claude-opus-4-8',
  });
  check('a good answer yields one validated item', out.status === 'found' && out.items === 1, JSON.stringify(out));
  check('and exactly one model call was made', good.calls.length === 1);
  check('the saved quote is the passage\'s own text, with its line break',
    good.saved[0].items[0].quote.includes('\n'), JSON.stringify(good.saved[0].items[0].quote));
  check('the pair is marked run, with no failure', good.saved[0].failed === null && good.saved[0].at === '2026-09-20T14:32:00.000Z');

  // Fabrication: the answer is well-formed and the quotation is invented.
  const liar = makeWorld({
    answer: () => ({ evidence: [{ ref: 'P1', quote: 'He was handcuffed before any force was used.', why: 'Says so.' }] }),
  });
  const lied = await findEvidenceForPair({
    pair: PAIR_D1, node: NODE_N1A1, deps: liar.deps, modelId: 'claude-opus-4-8',
  });
  check('every quotation invented → the PAIR FAILS, and nothing is written',
    lied.status === 'failed' && lied.items === 0 && liar.saved[0].items.length === 0, JSON.stringify(lied));
  check('and the failure says so in a sentence an attorney can act on',
    /is not present in the stored passage word for word/.test(liar.saved[0].failed ?? ''),
    liar.saved[0].failed ?? '');

  // Mixed: one real, one invented. The real one survives; the invented one is
  // dropped and counted, never "fixed".
  const mixed = makeWorld({
    answer: () => ({
      evidence: [
        { ref: 'P1', quote: 'He was handcuffed before any force was used.', why: 'Invented.' },
        { ref: 'P2', quote: 'I was on the landing above, facing the other way', why: 'Puts her elsewhere.' },
      ],
    }),
  });
  const mixedOut = await findEvidenceForPair({
    pair: { ...PAIR_D1, passageIds: ['p1', 'p2'] }, node: NODE_N1A1, deps: mixed.deps, modelId: 'claude-opus-4-8',
  });
  check('one real quotation survives beside one invented one',
    mixedOut.status === 'found' && mixedOut.items === 1 && mixedOut.dropped === 1, JSON.stringify(mixedOut));
  check('and the drop is reported, with the citation it was attributed to',
    mixedOut.notes.some((n) => /was dropped/.test(n)), mixedOut.notes.join(' | '));

  // Nothing fits: a real and useful answer.
  const empty = makeWorld({ answer: () => ({ evidence: [] }) });
  const emptyOut = await findEvidenceForPair({
    pair: PAIR_D1, node: NODE_N1A1, deps: empty.deps, modelId: 'claude-opus-4-8',
  });
  check('an honest "none of these supports the issue" is recorded, not failed',
    emptyOut.status === 'none' && empty.saved[0].failed === null);

  // No candidates on the row: skipped plainly, with no call and no charge.
  const none = makeWorld({ answer: () => ({ evidence: [] }) });
  const noneOut = await findEvidenceForPair({
    pair: { ...PAIR_D1, passageIds: [] }, node: NODE_N1A1, deps: none.deps, modelId: 'claude-opus-4-8',
  });
  check('a classification with no recorded passages is skipped without a call',
    noneOut.status === 'no_candidates' && none.calls.length === 0 && noneOut.charged === false);
  check('and the outline will say why', /Re-classify the document/.test(none.saved[0].failed ?? ''));
}

// ===========================================================================
section('4. The strict contract, and the one repair');
// ===========================================================================

{
  const refs = new Set(['P1', 'P2']);
  check('a non-object is refused', checkEvidenceContract('nope', refs).ok === false);
  check('a missing evidence array is refused', checkEvidenceContract({ items: [] }, refs).ok === false);
  check('a missing explanation is refused',
    checkEvidenceContract({ evidence: [{ ref: 'P1', quote: 'x'.repeat(40) }] }, refs).ok === false);
  check('a non-string quotation is refused',
    checkEvidenceContract({ evidence: [{ ref: 'P1', quote: 42, why: 'x' }] }, refs).ok === false);
  check('refs invented wholesale are refused',
    checkEvidenceContract({ evidence: [{ ref: 'P99', quote: 'x'.repeat(40), why: 'x' }] }, refs).ok === false);
  check('a few unknown refs among good ones are dropped, not fatal', (() => {
    const r = checkEvidenceContract({
      evidence: [
        { ref: 'P99', quote: 'x'.repeat(40), why: 'x' },
        { ref: 'P1', quote: 'y'.repeat(40), why: 'y' },
      ],
    }, refs);
    return r.ok && r.items.length === 1;
  })());

  // One malformed answer is repaired once; a second is a plain sentence.
  let attempts = 0;
  const repaired = makeWorld({
    answer: () => {
      attempts += 1;
      return attempts === 1
        ? { buckets: 'wrong shape entirely' }
        : { evidence: [{ ref: 'P1', quote: 'They were. I had already put the cuffs on him', why: 'Cuffed.' }] };
    },
  });
  const rOut = await findEvidenceForPair({
    pair: PAIR_D1, node: NODE_N1A1, deps: repaired.deps, modelId: 'kimi-k2.5',
  });
  check('a malformed answer is repaired once and then works',
    rOut.status === 'found' && repaired.calls.length === 2
    && repaired.calls[1].attempt === 2, JSON.stringify(repaired.calls));

  const twice = makeWorld({ answer: () => ({ buckets: 'still wrong' }) });
  const tOut = await findEvidenceForPair({
    pair: PAIR_D1, node: NODE_N1A1, deps: twice.deps, modelId: 'kimi-k2.5',
  });
  check('twice malformed → the pair fails plainly and writes nothing',
    tOut.status === 'failed' && twice.saved[0].items.length === 0 && twice.calls.length === 2);
  check('and the sentence tells the attorney what to do next',
    /could not be used .*, twice/.test(twice.saved[0].failed ?? ''), twice.saved[0].failed ?? '');
}

// ===========================================================================
section('5. The pass: sealed refusals, the meter, and resume');
// ===========================================================================

const NODES_BY_ID = new Map([[NODE_N1A1.id, NODE_N1A1]]);

{
  // A sealed matter is served by Kimi inside our own AWS account. When that
  // route refuses, it is THIS pairing's problem: the pass must not stop, and
  // it must not write an unvalidated row to look busy.
  const sealedError = new LlmCallError(
    'The sealed model could not answer this request.', 502, 'sealed_pen_error', null,
  );
  const sealed = makeWorld({
    answer: () => ({ evidence: [] }),
    throwOn: (call) => (call.documentId === 'd1' ? sealedError : null),
  });
  const pairs = [
    PAIR_D1,
    { ...PAIR_D1, classificationId: 'c2', documentId: 'd2', documentTitle: DOCUMENTS[1].title, passageIds: ['p2'] },
  ];
  const out = await runEvidencePass({
    pairs, nodesById: NODES_BY_ID, deps: sealed.deps, modelId: 'kimi-k2.5',
  });
  check('a sealed refusal on one pairing does not stop the pass',
    out.done === 2 && out.failed === 1, JSON.stringify({ done: out.done, failed: out.failed }));
  check('it writes no evidence for that pairing',
    sealed.saved.every((s) => s.pair !== 'c1'), JSON.stringify(sealed.saved.map((s) => s.pair)));
  check('and it is NOT marked run, so it is retried rather than lost',
    sealed.saved.filter((s) => s.pair === 'c1').length === 0);
  check('the refusal reaches the attorney in the server\'s own words',
    out.notes.some((n) => /sealed model could not answer/.test(n)), out.notes.join(' | '));

  // 402: the wallet. Stop, keep everything, say when to come back.
  const broke = makeWorld({
    answer: () => ({ evidence: [] }),
    throwOn: (call) => (call.documentId === 'd2'
      ? new LlmCallError('Your monthly budget is spent.', 402, 'budget_exhausted', 900)
      : null),
  });
  const pausedOut = await runEvidencePass({
    pairs, nodesById: NODES_BY_ID, deps: broke.deps, modelId: 'claude-opus-4-8',
  });
  check('402 stops the pass', pausedOut.pausedMessage === 'Your monthly budget is spent.');
  check('and says when to come back', pausedOut.retryAfterSeconds === 900);
  check('and keeps what was already finished', pausedOut.done === 1 && broke.saved.length === 1);

  // 429 behaves the same way.
  const limited = makeWorld({
    answer: () => ({ evidence: [] }),
    throwOn: () => new LlmCallError('Too many requests.', 429, 'rate_limited', 60),
  });
  const rlOut = await runEvidencePass({
    pairs, nodesById: NODES_BY_ID, deps: limited.deps, modelId: 'claude-opus-4-8',
  });
  check('429 stops the pass too', rlOut.pausedMessage === 'Too many requests.' && rlOut.done === 0);
}

{
  // Resume. The record lives on the classification row, so it survives a
  // closed tab, another browser and another machine.
  const candidates = [
    { ...PAIR_D1, evidenceRunAt: '2026-09-20T09:00:00.000Z', evidenceFailed: null },
    { ...PAIR_D1, classificationId: 'c2', documentId: 'd2', evidenceRunAt: null, evidenceFailed: null },
    { ...PAIR_D1, classificationId: 'c3', documentId: 'd3', evidenceRunAt: '2026-09-20T09:01:00.000Z', evidenceFailed: 'the model\'s answer could not be used, twice.' },
    { ...PAIR_D1, classificationId: 'c4', documentId: 'd4', evidenceRunAt: null, evidenceFailed: null, passageIds: [] },
  ];
  const first = partitionPairs(candidates);
  check('a pairing already read is not run again',
    first.todo.map((p) => p.classificationId).join(',') === 'c2,c4',
    first.todo.map((p) => p.classificationId).join(','));
  check('and the ones already done are counted', first.alreadyRun === 2 && first.failed === 1);
  check('a pairing with no recorded passages is still listed, and counted',
    first.withoutPassages === 1);

  const retry = partitionPairs(candidates, { retryFailed: true });
  check('"retry the failures" is deliberate, and only then picks the failed one up',
    retry.todo.map((p) => p.classificationId).join(',') === 'c2,c3,c4',
    retry.todo.map((p) => p.classificationId).join(','));

  const done = partitionPairs(candidates.map((c) => ({ ...c, evidenceRunAt: '2026-09-20T09:00:00.000Z' })));
  check('when everything has been read, the pass has nothing to charge for', done.todo.length === 0);
}

{
  // The estimate: quoted before the run, from the price table /api/llm charges
  // from. A pairing with no candidate passages costs nothing and is declared.
  const est = estimateEvidenceRun(
    [
      { nodeId: 'n1a1', documentId: 'd1', passageCount: 12 },
      { nodeId: 'n1a1', documentId: 'd2', passageCount: 4 },
      { nodeId: 'n2a', documentId: 'd3', passageCount: 0 },
    ],
    { modelId: 'claude-opus-4-8', provider: 'anthropic', alreadyRun: 7 },
  );
  check('the estimate charges one call per pairing that has candidates', est.pairs === 2);
  check('and declares the pairing it will skip', est.pairsWithoutPassages === 1);
  check('and carries the resumed count through', est.pairsAlreadyRun === 7);
  check('and produces a positive, finite price', est.cents > 0 && Number.isFinite(est.cents), String(est.cents));
}

// ===========================================================================
section('6. The outline — gaps first, deterministic, and honest about cites');
// ===========================================================================

const CLASSIFICATIONS = [
  { id: 'c1', node_id: 'n1a1', document_id: 'd1', status: 'confirmed', confidence: 0.96, rationale: 'Rivera on the cuffs.', evidence_run_at: '2026-09-20T09:00:00.000Z', evidence_failed: null },
  { id: 'c2', node_id: 'n1a1', document_id: 'd2', status: 'confirmed', confidence: 0.88, rationale: 'Marlow on his vantage point.', evidence_run_at: '2026-09-20T09:00:00.000Z', evidence_failed: null },
  { id: 'c3', node_id: 'n1a', document_id: 'd3', status: 'confirmed', confidence: null, rationale: 'The incident report.', evidence_run_at: '2026-09-20T09:00:00.000Z', evidence_failed: null },
  { id: 'c4', node_id: 'n2a', document_id: 'd4', status: 'confirmed', confidence: 0.71, rationale: 'Okonkwo on causation.', evidence_run_at: '2026-09-20T09:00:00.000Z', evidence_failed: null },
  { id: 'c5', node_id: 'n2b', document_id: 'd4', status: 'confirmed', confidence: 0.6, rationale: 'Damages.', evidence_run_at: null, evidence_failed: null },
  { id: 'c6', node_id: 't1', document_id: 'd2', status: 'confirmed', confidence: 0.8, rationale: 'Marlow credibility.', evidence_run_at: '2026-09-20T09:00:00.000Z', evidence_failed: 'the model\'s answer could not be used, twice.' },
  // Confirmed into the tree, and the evidence pass has not reached it yet.
  { id: 'c7', node_id: 'n1a', document_id: 'd4', status: 'confirmed', confidence: 0.64, rationale: 'Okonkwo on the mechanism of injury.', evidence_run_at: null, evidence_failed: null },
];

const EVIDENCE = [
  { id: 'e1', node_id: 'n1a1', document_id: 'd1', passage_id: 'p1', quote: P1_TEXT.slice(P1_TEXT.indexOf('They were.')), rationale: 'Puts the handcuffs on before the first strike.', status: 'confirmed', position: 0 },
  { id: 'e2', node_id: 'n1a1', document_id: 'd2', passage_id: 'p2', quote: 'I was on the landing above, facing the other way', rationale: 'Marlow could not see what he reported.', status: 'confirmed', position: 1 },
  { id: 'e3', node_id: 'n1a', document_id: 'd3', passage_id: 'p3', quote: 'At 21:14 the subject was secured in restraints.', rationale: 'The Authority\'s own timeline.', status: 'confirmed', position: 0 },
  { id: 'e4', node_id: 'n2a', document_id: 'd4', passage_id: 'p4', quote: 'The orbital fracture is consistent with a blunt impact', rationale: 'Causation.', status: 'confirmed', position: 0 },
  { id: 'e5', node_id: 'n2b', document_id: 'd4', passage_id: 'p4', quote: 'immobilised against a hard surface', rationale: 'Bears on the extent of injury.', status: 'proposed', position: 0 },
];

const buildAt = (at, reviewed = false) => buildOutline({
  matter: MATTER,
  nodes: NODES,
  classifications: CLASSIFICATIONS,
  evidence: EVIDENCE,
  documents: DOCUMENTS,
  passages: PASSAGES,
  generatedAt: at,
  reviewedAt: reviewed ? at : null,
});

const MODEL = buildAt('2026-09-20T14:32:00.000Z');
const MD = renderOutlineMarkdown(MODEL);

{
  check('claims number I, II; elements A, B; subissues 1', roman(1) === 'I' && roman(2) === 'II' && alpha(1) === 'A' && alpha(2) === 'B');
  check('the subissue is numbered I.A.1', MODEL.claims[0].children[0].children[0].number === 'I.A.1',
    MODEL.claims[0].children[0].children[0].number);
  check('the Monell element is I.B', MODEL.claims[0].children[1].number === 'I.B');

  // Gaps, in the order a trial team works them.
  const order = MODEL.gaps.map((g) => `${g.gap}:${g.number}`);
  check('gaps are ordered nothing-at-all, then nothing-confirmed, then thin',
    order.join(' ') === 'empty:I.B unconfirmed:II.B thin:I.A.1 thin:II.A', order.join(' '));
  check('and a theme is never listed as a gap — a theme is not something to prove',
    !MODEL.gaps.some((g) => g.number.startsWith('T')), order.join(' '));
  check('the Monell element is flagged as empty',
    MODEL.gaps[0].number === 'I.B' && /no documents are filed/.test(MODEL.gaps[0].reason));
  check('the damages element is flagged as proposed-only',
    MODEL.gaps[1].gap === 'unconfirmed' && /none confirmed by counsel/.test(MODEL.gaps[1].reason),
    MODEL.gaps[1].reason);
  check('and the gaps section comes BEFORE the claims in the rendered file',
    MD.indexOf('## What still needs evidence') < MD.indexOf('## The case, claim by claim'));

  // Nothing unconfirmed is presented as established.
  const damages = MODEL.claims[1].children[1];
  check('a proposed quotation is never counted as confirmed',
    damages.confirmed.length === 0 && damages.proposed.length === 1);
  check('and is marked PROPOSED where it is rendered',
    /\*\*PROPOSED — not confirmed\.\*\*/.test(MD), 'the proposed marker is missing');

  // The cites.
  check('the outline carries the page:line cite', MD.includes('Dep. of Rivera 61:4–11'));
  check('the page-only cite is marked as page only',
    MD.includes('page only — line numbers unavailable for this transcript'));
  check('the positional line numbers are marked as counted, not printed',
    MD.includes('line numbers counted by position, not printed on the page'));
  check('and the standing PDF-page-index note is at the top, once',
    MD.includes(PDF_INDEX_PAGE_NOTE)
    && MD.indexOf(PDF_INDEX_PAGE_NOTE) < MD.indexOf('## What still needs evidence'));
  check('the cite tiers are counted',
    MODEL.counts.citeTiers.page_line === 1
    && MODEL.counts.citeTiers.page_only === 1
    && MODEL.counts.citeTiers.document_page === 1
    && MODEL.counts.citeTiers.page_line_inferred === 2
    && MODEL.counts.citeTiers.no_page === 0,
    JSON.stringify(MODEL.counts.citeTiers));

  // A pairing that could not be read says so where the attorney is reading.
  check('a pairing the model could not answer about is named in the outline',
    MD.includes('could not be used, twice'), 'the failed pairing is silent');
  check('and one not yet read says THAT instead',
    MD.includes('not yet read for quotable evidence'));
  check('the counts distinguish the two',
    MODEL.counts.pairsFailed === 1 && MODEL.counts.pairsNotRun === 1,
    JSON.stringify({ failed: MODEL.counts.pairsFailed, notRun: MODEL.counts.pairsNotRun }));

  // The legend.
  check('an unreviewed outline carries the DRAFT legend at the top', MD.includes(`**${DRAFT_LEGEND}**`));
  check('and again at the foot, because a .md has no pages',
    MD.lastIndexOf(DRAFT_LEGEND) > MD.indexOf('## Documents cited'));
  const reviewedMd = renderOutlineMarkdown(buildAt('2026-09-20T14:32:00.000Z', true));
  check('marking it reviewed removes the legend', !reviewedMd.includes(DRAFT_LEGEND));
  check('and records who said so, and when', reviewedMd.includes('Reviewed by counsel'));

  // The indices.
  check('the witness index names every witness quoted, surname first',
    MODEL.witnesses.map((w) => w.name).join(', ') === 'Okonkwo, M.D., Rivera',
    MODEL.witnesses.map((w) => w.name).join(', '));
  check('the document index lists every document with a confirmed quotation',
    MODEL.documents.length === 4,
    JSON.stringify(MODEL.documents.map((d) => [d.title, d.numbers])));
  check('a quoted passage whose page is missing does not crash the index',
    MODEL.documents.every((d) => typeof d.readerUrl === 'string'));
}

// ===========================================================================
section('7. Determinism, and versioning');
// ===========================================================================

{
  const again = renderOutlineMarkdown(buildAt('2026-09-20T14:32:00.000Z'));
  check('the same inputs produce a BYTE-IDENTICAL .md', again === MD,
    again === MD ? '' : `lengths ${again.length} vs ${MD.length}`);

  // Shuffled inputs must not move anything: sorts are total, with the id as
  // the last tiebreaker.
  const shuffled = buildOutline({
    matter: MATTER,
    nodes: [...NODES].reverse(),
    classifications: [...CLASSIFICATIONS].reverse(),
    evidence: [...EVIDENCE].reverse(),
    documents: [...DOCUMENTS].reverse(),
    passages: [...PASSAGES].reverse(),
    generatedAt: '2026-09-20T14:32:00.000Z',
  });
  check('and so does the same data in a different order',
    renderOutlineMarkdown(shuffled) === MD,
    renderOutlineMarkdown(shuffled) === MD ? '' : 'row order changed the file');

  check('the version is the date and the minute',
    MODEL.version === '2026-09-20 1432', MODEL.version);
  const mdName = outlineFilename(MODEL, '.md');
  const later = buildAt('2026-09-20T16:05:00.000Z');
  check('a re-run this afternoon is a NEW file, not an overwrite',
    outlineFilename(later, '.md') !== mdName,
    `${mdName} vs ${outlineFilename(later, '.md')}`);
  check('and the filename is safe for the filesystem and the Vault',
    !/[\\/:*?"<>|]/.test(mdName) && mdName.endsWith('.md'), mdName);
  // persistVaultFile makes the title by stripping the extension, so two files
  // with the same stem would sit in the Vault under one identical name.
  check('the Word copy is distinguishable in the Vault, where titles lose the extension',
    outlineFilename(MODEL, '.docx').replace(/\.docx$/, '') !== mdName.replace(/\.md$/, ''),
    outlineFilename(MODEL, '.docx'));

  // THE SELF-CITATION GUARD. The outline is filed and ingested on purpose, so
  // it is an ordinary ready document and would otherwise be a classification
  // candidate — the classifier would file it under the elements it quotes, and
  // the next evidence pass would quote the outline quoting the deposition.
  check('a filed outline is recognised as one, so the classifier skips it',
    isFiledOutline(mdName.replace(/\.md$/, ''))
    && isFiledOutline(outlineFilename(MODEL, '.docx').replace(/\.docx$/, '')),
    mdName);
  check('and an ordinary document that merely says "outline" is not',
    !isFiledOutline('Outline of duties under the consent decree')
    && !isFiledOutline('Trial Outline notes (Eden)')
    && !isFiledOutline(null));
}

// ===========================================================================
section('8. The .docx is a real Word file, in plain litigation format');
// ===========================================================================

{
  const blob = await renderOutlineDocx(MODEL);
  const bytes = Buffer.from(await blob.arrayBuffer());
  check('it is a non-trivial file', bytes.length > 5_000, `${bytes.length} bytes`);
  check('and it is a ZIP, which is what a .docx is',
    bytes[0] === 0x50 && bytes[1] === 0x4b);

  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files);
  check('it holds the parts Word requires',
    names.includes('word/document.xml') && names.includes('[Content_Types].xml'),
    names.join(', '));

  const documentXml = await zip.file('word/document.xml').async('string');
  const headerName = names.find((n) => /^word\/header\d*\.xml$/.test(n));
  check('it has a running header — which is how the legend gets on EVERY page',
    Boolean(headerName), names.join(', '));
  const headerXml = headerName ? await zip.file(headerName).async('string') : '';
  check('and the header carries the DRAFT legend', headerXml.includes(DRAFT_LEGEND), headerXml.slice(0, 400));
  check('bold and underlined, as Eden writes it',
    /<w:b\b/.test(headerXml) && /<w:u\b/.test(headerXml));

  check('the page margins are one inch all round',
    /w:top="1440"/.test(documentXml) && /w:left="1440"/.test(documentXml)
    && /w:right="1440"/.test(documentXml) && /w:bottom="1440"/.test(documentXml),
    (documentXml.match(/<w:pgMar[^/]*\/>/) ?? ['no pgMar'])[0]);

  const stylesXml = await zip.file('word/styles.xml').async('string');
  check('the document is set in Times New Roman 12',
    /Times New Roman/.test(stylesXml) && /w:sz w:val="24"/.test(stylesXml));
  check('the body introduces no colour at all',
    !/w:color w:val="(?!auto|000000)/i.test(documentXml),
    (documentXml.match(/w:color w:val="[^"]*"/g) ?? []).join(' '));

  // `docx` writes its own blue Heading1..6 into styles.xml and an override
  // under the SAME styleId does not replace it — the file ends up with two
  // elements carrying w:styleId="Heading1", which is invalid OOXML and leaves
  // the colour up to whichever one Word reads first. The outline therefore
  // brings its own ids.
  const ourHeadings = stylesXml.match(/<w:style [^>]*w:styleId="TrialOutlineHeading\d"[\s\S]*?<\/w:style>/g) ?? [];
  check('the outline brings its own heading styles rather than overriding Word\'s',
    ourHeadings.length === 6, `${ourHeadings.length} found`);
  check('and every one of them is black Times New Roman',
    ourHeadings.every((b) => /Times New Roman/.test(b) && !/w:color w:val="(?!auto|000000)/i.test(b)));
  check('no duplicate style id was written',
    (stylesXml.match(/w:styleId="Heading1"/g) ?? []).length <= 1,
    `${(stylesXml.match(/w:styleId="Heading1"/g) ?? []).length} Heading1 definitions`);
  check('every heading in the body uses one of the outline\'s own styles',
    (documentXml.match(/<w:pStyle w:val="([^"]*)"/g) ?? [])
      .every((m) => !/w:val="Heading\d"/.test(m)),
    (documentXml.match(/<w:pStyle w:val="[^"]*"/g) ?? []).slice(0, 4).join(' '));
  check('and the headings still carry an outline level, so Word can navigate them',
    ourHeadings.every((b) => /<w:outlineLvl/.test(b)));

  // Testimony is set as a block quote: indented both sides.
  check('testimony is set as an indented block quote',
    /<w:ind [^>]*w:left="720"[^>]*w:right="720"/.test(documentXml)
    || /<w:ind [^>]*w:right="720"[^>]*w:left="720"/.test(documentXml),
    (documentXml.match(/<w:ind[^/]*\/>/g) ?? []).slice(0, 4).join(' '));

  const { default: mammoth } = await import('mammoth');
  const { value: text } = await mammoth.extractRawText({ buffer: bytes });
  check('the file opens with the repo\'s own docx reader', text.length > 500, `${text.length} characters`);
  check('and holds the numbered headings', text.includes('I.A.1.') && text.includes('II.B.'),
    text.slice(0, 200));
  check('the quotation is in it, verbatim',
    text.includes('I had already put the cuffs on him'));
  check('the citation is in it', text.includes('Dep. of Rivera 61:4–11'));
  check('the page-only caveat is in it',
    text.includes('page only — line numbers unavailable for this transcript'));
  check('the gaps section is in it', text.includes('What still needs evidence'));
  check('and the Monell gap is named there', text.includes('Municipal policy or custom (Monell)'));

  // The reviewed copy loses the legend from the header too.
  const reviewedZip = await JSZip.loadAsync(
    Buffer.from(await (await renderOutlineDocx(buildAt('2026-09-20T14:32:00.000Z', true))).arrayBuffer()),
  );
  const reviewedHeaderName = Object.keys(reviewedZip.files).find((n) => /^word\/header\d*\.xml$/.test(n));
  const reviewedHeader = reviewedHeaderName ? await reviewedZip.file(reviewedHeaderName).async('string') : '';
  check('a reviewed outline carries no DRAFT legend in the header',
    !reviewedHeader.includes(DRAFT_LEGEND), reviewedHeader.slice(0, 200));
}

// ===========================================================================
section('9. The sample outline, for the pull request');
// ===========================================================================

if (process.argv.includes('--print-sample')) {
  console.log('\n----- BEGIN SAMPLE -----');
  console.log(MD);
  console.log('----- END SAMPLE -----\n');
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
