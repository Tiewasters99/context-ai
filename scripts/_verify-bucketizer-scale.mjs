// Probe: the Bucketizer at real-matter scale, and the silent 1,000-row
// truncation it shares with Discovery. Entirely offline — no network, no
// .env, no database, no model. Node 22.18+ strips the .ts types.
//
// What is asserted here, and why each one is a bug that shipped:
//
//   1. WHOLE-DOCUMENT COVERAGE. A 247-page deposition is planned into windows
//      that between them contain every passage exactly once. The classifier
//      used to read `.range(0, 199)` and bucket the witness on the first
//      thirty pages.
//   2. MERGE DETERMINISM. The same windows, shuffled, merge to identical
//      rows — which is what makes a run resumed across two sessions the same
//      run as one that never stopped.
//   3. RESUME. A tab closed after four windows comes back and pays for the
//      remaining eight only.
//   4. THE METER. 402 and 429 stop the run and keep the work; an ordinary
//      failure does not stop anything.
//   5. PAGED READS. 2,500 rows with TIED sort keys come back whole and in
//      order — ties are what break a naive `.range()` loop.
//   6. JSON REPAIR. A malformed answer is repaired once; a second malformed
//      answer becomes a plain sentence, not a row.
//   7. THE MATTER'S RECORD KNOWS WHICH ACT WAS PERFORMED. Every Bucketizer
//      model call names itself to `/api/llm` — 'bucketizer.tree',
//      'bucketizer.classify', 'bucketizer.evidence' — and names the documents
//      it is working on, by id. A sealed classification ran in production on
//      09-19 and the matter's Record did not know it had happened; after
//      #190 it would have been recorded as 'unspecified'. Asserted against
//      the REAL call sites with `/api/llm` stubbed: the label, the ids, that
//      no prompt or excerpt text rides in either field, and that the bytes
//      forwarded to the provider are byte-for-byte what they were without
//      them.
//   8. THE TREE HAS AN OUTPUT CONTRACT TOO. Tree generation checked
//      `result.claims.length` and then walked the answer inserting rows, so a
//      claim with no label, a duplicated element or a flattened parent-ref
//      list became buckets in the attorney's tree. It is now validated whole
//      BEFORE the first insert, repaired once through the same metered
//      'bucketizer.tree' call, and otherwise refused in a sentence that says
//      nothing was changed — which is true because no write is attempted.
//
// Untracked by convention elsewhere in scripts/, but this one runs in CI.

import {
  planWindows,
  buildWindowUserContent,
  buildRepairUserContent,
  checkWindowContract,
  mergeWindowResults,
  MERGED_ASSIGNMENT_CAP,
  MERGED_PASSAGE_CAP,
} from '../src/lib/bucketizer/windows.ts';
import { classifyDocumentWindowed } from '../src/lib/bucketizer/classify-run.ts';
import { LlmCallError } from '../src/lib/bucketizer/llm-error.ts';
import { fetchPaged, showingOf } from '../src/lib/paged.ts';
import { estimateRun, windowsForPages } from '../src/lib/bucketizer/estimate.ts';
import {
  serializeOutline,
  CLASSIFY_TOOL_NAME,
  CLASSIFY_TOOL_DESCRIPTION,
  CLASSIFY_SCHEMA,
} from '../lib/bucketizer-core.mjs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}`); if (detail !== undefined) console.log(`      ${detail}`); }
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// Fixtures: a 247-page deposition, and a trial tree to file it into.
// ---------------------------------------------------------------------------

/**
 * Blake Desmond's shape: 247 pages, transcript mode, ~4 Q/A chunks a page,
 * ~280 characters a chunk. ~988 passages, ~277,000 characters — which is
 * about four and a half times the old 60,000-character single-call budget,
 * and nineteen times the 200-passage read.
 */
function syntheticTranscript({ pages = 247, chunksPerPage = 4 } = {}) {
  const out = [];
  let seq = 0;
  for (let page = 1; page <= pages; page++) {
    for (let c = 0; c < chunksPerPage; c++) {
      const line = c * 6 + 1;
      out.push({
        id: `p-${String(seq).padStart(5, '0')}`,
        text:
          `Q.${' And directing your attention to the events of August 16,'.repeat(2)} `
          + `A.${' I observed the officers enter the mental-health pen at that time.'.repeat(2)} `
          + `[page ${page} line ${line}]`,
        page_start: page,
        page_end: page,
        sequence_number: seq++,
      });
    }
  }
  return out;
}

const NODES = [
  { id: 'n-claim', parent_id: null, kind: 'claim', label: 'Excessive force (§ 1983)', description: 'Force claims.', position: 0 },
  { id: 'n-el-1', parent_id: 'n-claim', kind: 'element', label: 'Objective unreasonableness', description: 'Graham factors.', position: 0 },
  { id: 'n-sub-1', parent_id: 'n-el-1', kind: 'subissue', label: 'Aug. 16 AMKC pen assault', description: 'Eyewitness accounts of the pen.', position: 0 },
  { id: 'n-el-2', parent_id: 'n-claim', kind: 'element', label: 'Causation', description: 'Injury traced to the force.', position: 1 },
  { id: 'n-theme', parent_id: null, kind: 'theme', label: 'Key witnesses', description: 'Anyone who saw anything.', position: 1 },
];
const { outline, refToId } = serializeOutline(NODES);
const REFS = [...refToId.keys()];
const KNOWN_REFS = new Set(REFS);
const NODE_BY_REF = refToId;

// ---------------------------------------------------------------------------
section('1. Whole-document coverage — a 247-page deposition');
// ---------------------------------------------------------------------------

const passages = syntheticTranscript();
const plan = planWindows(passages);

check(
  'the fixture is genuinely long (the old read saw 200 of these)',
  passages.length === 988 && plan.totalChars > 250_000,
  `${passages.length} passages, ${plan.totalChars.toLocaleString()} chars`,
);
check('the document is split into more than one window', plan.windows.length > 1, `${plan.windows.length} windows`);

// EVERY passage in EXACTLY one window. This is the assertion the whole change
// exists for: a partition, not a sample.
const seenCount = new Map();
for (const w of plan.windows) for (const p of w.passages) seenCount.set(p.id, (seenCount.get(p.id) ?? 0) + 1);
const missing = passages.filter((p) => !seenCount.has(p.id));
const duplicated = [...seenCount.entries()].filter(([, n]) => n !== 1);

check('every passage id appears in a window', missing.length === 0, `${missing.length} missing`);
check('no passage id appears twice', duplicated.length === 0, `${duplicated.length} duplicated`);
check(
  'the windows hold exactly the document',
  [...seenCount.keys()].length === passages.length,
  `${seenCount.size} vs ${passages.length}`,
);
check(
  'reading order is preserved across the windows',
  plan.windows.flatMap((w) => w.passages.map((p) => p.sequence_number))
    .every((n, i) => n === i),
);
check('the last page of the document is inside the last window', plan.lastPage === 247, plan.lastPage);
check('page 1 is inside the first window', plan.windows[0].firstPage === 1);
check(
  'no window exceeds its character budget by more than one passage',
  plan.windows.every((w, i) => w.chars <= plan.windowChars || w.passages.length === 1 || i === plan.windows.length - 1
    || w.chars - (w.passages.at(-1).text.length) < plan.windowChars),
);

// A short document must still be exactly one call, built as it always was.
const shortPlan = planWindows(passages.slice(0, 12));
check('a short document is still a single window', shortPlan.windows.length === 1);

// A single passage bigger than the whole budget keeps its own window rather
// than being dropped.
const giant = planWindows([{ id: 'g1', text: 'x'.repeat(400_000), page_start: 1, page_end: 9, sequence_number: 0 }]);
check('an over-budget passage is kept, in a window of its own', giant.windows.length === 1 && giant.windows[0].passages.length === 1);

// The window prompt locates itself in the document.
const prompt = buildWindowUserContent({ title: 'Blake Desmond 10.28.22', docType: 'deposition' }, plan, plan.windows[2], outline);
check('the window prompt says which part of the document it is', /Part 3 of \d+/.test(prompt.userContent));
check('the window prompt carries page numbers', /pages \d+–\d+ of 247/.test(prompt.userContent), prompt.userContent.slice(0, 400));
check('excerpt refs map back to real passage ids', prompt.refToPassageId.get('P1') === plan.windows[2].passages[0].id);
check('the tree travels with every window', prompt.userContent.includes('Aug. 16 AMKC pen assault'));

// ---------------------------------------------------------------------------
section('2. Token arithmetic and the cost estimate');
// ---------------------------------------------------------------------------

check('a 247-page deposition is priced as more than one call', windowsForPages(247) > 1, `${windowsForPages(247)} windows`);
check('a 2-page letter is one call', windowsForPages(2) === 1);
check('a document with no page count is assumed short', windowsForPages(null) === 1);

const est = estimateRun(
  [
    { id: 'd1', title: 'Blake Desmond 10.28.22', page_count: 247 },
    { id: 'd2', title: 'Engagement letter', page_count: 2 },
    { id: 'd3', title: 'Unknown length', page_count: null },
  ],
  { modelId: 'claude-opus-4-8', provider: 'anthropic', outlineChars: outline.length },
);
check('the estimate counts every document', est.documents === 3);
check('the estimate counts the long one as several calls', est.windows === windowsForPages(247) + 2, est.windows);
check('the estimate names how many have no page count', est.documentsWithoutPageCount === 1);
check('the estimate costs something, and is a whole number of cents', est.cents > 0 && Number.isInteger(est.cents), `${est.cents}c`);
console.log(`      → ${est.documents} docs, ${est.windows} calls, ${(est.cents / 100).toFixed(2)} USD at claude-opus-4-8 list rates`);

// ---------------------------------------------------------------------------
section('3. Merge determinism');
// ---------------------------------------------------------------------------

const REF_SUB = REFS[2];   // the Aug. 16 subissue
const REF_CAUSE = REFS[3]; // causation
const REF_THEME = REFS[4]; // key witnesses

const windowResults = [
  { index: 0, firstPage: 1, lastPage: 30, assignments: [
    { node_id: NODE_BY_REF.get(REF_THEME), confidence: 0.55, rationale: 'Appearance page names the witnesses.', passage_ids: ['p-00000', 'p-00001'] },
  ] },
  { index: 1, firstPage: 31, lastPage: 60, assignments: [
    { node_id: NODE_BY_REF.get(REF_SUB), confidence: 0.61, rationale: 'Background on the housing assignment.', passage_ids: ['p-00200'] },
  ] },
  { index: 2, firstPage: 180, lastPage: 210, assignments: [
    { node_id: NODE_BY_REF.get(REF_SUB), confidence: 0.94, rationale: 'Eyewitness account of the pen assault.', passage_ids: ['p-00700', 'p-00701'] },
    { node_id: NODE_BY_REF.get(REF_CAUSE), confidence: 0.88, rationale: 'Ties the injury to the force used.', passage_ids: ['p-00705'] },
  ] },
];

const merged = mergeWindowResults(windowResults, { windowsTotal: 3, knownNodeIds: new Set(NODE_BY_REF.values()) });

check('the merge yields one row per bucket', merged.length === 3);
const sub = merged.find((m) => m.node_id === NODE_BY_REF.get(REF_SUB));
check('the deep window wins on confidence — the front of the document does not bury it', sub.confidence === 0.94);
check('the merged row cites the pages the model actually read', sub.rationale.startsWith('pp. 180–210: '), sub.rationale);
check('the merged row says how many parts agreed', sub.rationale.includes('2 of 3 parts'), sub.rationale);
check('passage ids are unioned across windows, in reading order',
  JSON.stringify(sub.passage_ids) === JSON.stringify(['p-00200', 'p-00700', 'p-00701']), JSON.stringify(sub.passage_ids));
check('rows are ordered by confidence', merged[0].confidence >= merged[1].confidence && merged[1].confidence >= merged[2].confidence);

// Shuffle the windows: the merge must not notice.
const shuffles = [
  [2, 0, 1], [1, 2, 0], [2, 1, 0], [0, 2, 1], [1, 0, 2],
].map((order) => JSON.stringify(mergeWindowResults(order.map((i) => windowResults[i]), {
  windowsTotal: 3, knownNodeIds: new Set(NODE_BY_REF.values()),
})));
check('the merge is byte-identical whatever order the windows finished in',
  shuffles.every((s) => s === JSON.stringify(merged)));

// A bucket deleted mid-run does not come back.
const pruned = mergeWindowResults(windowResults, {
  windowsTotal: 3,
  knownNodeIds: new Set([NODE_BY_REF.get(REF_SUB)]),
});
check('a bucket deleted while the run was going is dropped at the merge', pruned.length === 1);

// Caps.
const many = mergeWindowResults(
  [{ index: 0, firstPage: 1, lastPage: 2, assignments: Array.from({ length: 30 }, (_, i) => ({
    node_id: `node-${String(i).padStart(2, '0')}`, confidence: 0.5, rationale: 'r',
    passage_ids: Array.from({ length: 80 }, (_, j) => `pp-${i}-${j}`),
  })) }],
  { windowsTotal: 1 },
);
check('the merged document is capped at the merged assignment cap', many.length === MERGED_ASSIGNMENT_CAP, many.length);
check('passage ids per bucket are capped', many.every((m) => m.passage_ids.length === MERGED_PASSAGE_CAP));
check('the cap is applied deterministically (ties broken by node id)',
  many[0].node_id === 'node-00' && many.at(-1).node_id === `node-${String(MERGED_ASSIGNMENT_CAP - 1).padStart(2, '0')}`);

// ---------------------------------------------------------------------------
section('4. The output contract, and one repair');
// ---------------------------------------------------------------------------

const good = { assignments: [{ ref: REF_SUB, confidence: 0.9, rationale: 'because', passageRefs: ['P1'] }] };
check('a well-formed answer passes', checkWindowContract(good, KNOWN_REFS).ok);
check('an empty list is a valid answer — "nothing here fits" is a real finding',
  checkWindowContract({ assignments: [] }, KNOWN_REFS).ok);
check('a non-object is rejected', checkWindowContract('yes', KNOWN_REFS).ok === false);
check('a missing assignments array is rejected', checkWindowContract({ buckets: [] }, KNOWN_REFS).ok === false);
check('confidence as a percentage string is rejected',
  checkWindowContract({ assignments: [{ ref: REF_SUB, confidence: '87%', rationale: 'x' }] }, KNOWN_REFS).ok === false);
check('a missing rationale is rejected — an attorney cannot check a bare score',
  checkWindowContract({ assignments: [{ ref: REF_SUB, confidence: 0.9 }] }, KNOWN_REFS).ok === false);
check('wholly invented refs are rejected rather than filed',
  checkWindowContract({ assignments: [{ ref: 'N99', confidence: 0.9, rationale: 'x' }] }, KNOWN_REFS).ok === false);

const mixed = checkWindowContract({ assignments: [
  { ref: 'N99', confidence: 0.9, rationale: 'invented' },
  { ref: REF_SUB, confidence: 0.9, rationale: 'real' },
] }, KNOWN_REFS);
check('one bad ref among good ones is dropped, not fatal', mixed.ok && mixed.assignments.length === 1);
check('confidence is clamped into 0..1',
  checkWindowContract({ assignments: [{ ref: REF_SUB, confidence: 4, rationale: 'x' }] }, KNOWN_REFS).assignments[0].confidence === 1);

const repair = buildRepairUserContent('ORIGINAL PROMPT', 'no "assignments" array', { buckets: [] });
check('the repair prompt keeps the original', repair.includes('ORIGINAL PROMPT'));
check('the repair prompt says what was wrong', repair.includes('no "assignments" array'));
check('the repair prompt shows the model its own answer', repair.includes('{"buckets":[]}'));
check('the repair prompt restates the exact shape', repair.includes('"assignments":[{"ref"'));

// ---------------------------------------------------------------------------
section('5. The run: resume, no double charge, failures that do not spread');
// ---------------------------------------------------------------------------

/** A fake world: passages, a metadata blob per document, and a call counter. */
function makeWorld({ passages: ps, answer, failAt, throwAt }) {
  const meta = new Map();
  const world = {
    calls: [],
    finished: [],
    deps: {
      now: () => '2026-09-20T00:00:00.000Z',
      async fetchPassages() { return ps; },
      async loadRun(id) { return meta.get(id)?.run ?? null; },
      async saveRun(id, run) { meta.set(id, { ...(meta.get(id) ?? {}), run: structuredClone(run) }); },
      async finish(id, result) {
        const prior = { ...(meta.get(id) ?? {}) };
        delete prior.run;
        meta.set(id, { ...prior, coverage: result.coverage });
        world.finished.push({ id, ...result });
      },
      async callWindow(call) {
        world.calls.push({ windowIndex: call.windowIndex, attempt: call.attempt });
        if (throwAt && throwAt(call)) throw throwAt(call);
        return (failAt && failAt(call)) ? { buckets: 'nope' } : answer(call);
      },
    },
    meta,
  };
  return world;
}

const DOC = { id: 'doc-blake', title: 'Blake Desmond 10.28.22', doc_type: 'deposition' };
const answerOK = (call) => ({ assignments: [
  { ref: REF_SUB, confidence: 0.5 + call.windowIndex / 100, rationale: `part ${call.windowIndex}`, passageRefs: ['P1'] },
] });

// -- a clean run -------------------------------------------------------------
{
  const w = makeWorld({ passages, answer: answerOK });
  const out = await classifyDocumentWindowed({ doc: DOC, nodes: NODES, deps: w.deps, modelId: 'claude-opus-4-8' });
  check('a clean run classifies the document', out.status === 'classified');
  check('one model call per window', w.calls.length === plan.windows.length, `${w.calls.length} calls / ${plan.windows.length} windows`);
  check('every window index was actually called',
    new Set(w.calls.map((c) => c.windowIndex)).size === plan.windows.length);
  check('rows were written once, at the end', w.finished.length === 1);
  check('the coverage record says the whole document was read',
    w.finished[0].coverage.passages === passages.length && w.finished[0].coverage.last_page === 247);
  check('the working state is gone and the coverage record stays',
    w.meta.get(DOC.id).run === undefined && w.meta.get(DOC.id).coverage != null);
  check('the supporting passage ids survive onto the row', w.finished[0].rows[0].passage_ids.length > 0);
}

// -- the tab closes after four windows ---------------------------------------
{
  const first = makeWorld({ passages, answer: answerOK });
  const stop = new AbortController();
  let done = 0;
  await classifyDocumentWindowed({
    doc: DOC, nodes: NODES, deps: first.deps, modelId: 'claude-opus-4-8', signal: stop.signal,
    onWindow: () => { if (++done >= 4) stop.abort(); },
  });
  const callsBefore = first.calls.length;
  check('the interrupted run stopped early', callsBefore < plan.windows.length, `${callsBefore} calls`);
  check('the interrupted run wrote NO rows — a partial read is not a classification', first.finished.length === 0);
  check('the interrupted run saved its progress', first.meta.get(DOC.id).run.w.length === callsBefore);

  // Come back: same world (the metadata survived the tab), fresh counter.
  const resumed = makeWorld({ passages, answer: answerOK });
  resumed.meta.set(DOC.id, first.meta.get(DOC.id));
  const out = await classifyDocumentWindowed({ doc: DOC, nodes: NODES, deps: resumed.deps, modelId: 'claude-opus-4-8' });
  check('coming back finishes the document', out.status === 'classified');
  check('the finished windows were NOT paid for again',
    resumed.calls.length === plan.windows.length - callsBefore,
    `${resumed.calls.length} new calls, ${callsBefore} resumed`);
  check('the run reports what it resumed', out.windowsResumed === callsBefore);
  check('no window was called twice across the two sessions',
    new Set([...first.calls, ...resumed.calls].map((c) => c.windowIndex)).size === plan.windows.length);

  // And the resumed result equals the uninterrupted one.
  const straight = makeWorld({ passages, answer: answerOK });
  await classifyDocumentWindowed({ doc: DOC, nodes: NODES, deps: straight.deps, modelId: 'claude-opus-4-8' });
  check('a resumed run produces exactly the rows an uninterrupted run would',
    JSON.stringify(resumed.finished[0].rows) === JSON.stringify(straight.finished[0].rows));
}

// -- progress from a DIFFERENT text is not resumed ---------------------------
{
  const w = makeWorld({ passages, answer: answerOK });
  w.meta.set(DOC.id, { run: { v: 1, hash: 'stale-hash', windows_total: 99, started_at: 'x', model: 'm', w: [
    { i: 0, done_at: 'x', a: [] }, { i: 1, done_at: 'x', a: [] },
  ] } });
  await classifyDocumentWindowed({ doc: DOC, nodes: NODES, deps: w.deps, modelId: 'claude-opus-4-8' });
  check('progress recorded against different text (a re-ingest) is discarded, not resumed',
    w.calls.length === plan.windows.length);
}

// -- the meter says stop -----------------------------------------------------
for (const [status, label] of [[402, 'budget spent'], [429, 'rate limited']]) {
  const w = makeWorld({
    passages,
    answer: answerOK,
    throwAt: (c) => (c.windowIndex === 3
      ? new LlmCallError(`meter: ${label}`, status, 'usage_limit', status === 429 ? 120 : null)
      : null),
  });
  let thrown = null;
  try {
    await classifyDocumentWindowed({ doc: DOC, nodes: NODES, deps: w.deps, modelId: 'claude-opus-4-8' });
  } catch (e) { thrown = e; }
  check(`${status} (${label}) stops the run rather than being counted as this document's fault`,
    thrown instanceof LlmCallError && thrown.isUsagePause);
  check(`${status}: the windows already finished are kept`, w.meta.get(DOC.id).run.w.length === 3);
  check(`${status}: no rows were written from the partial read`, w.finished.length === 0);
  check(`${status}: the run stopped AT the refusal, not after it`, w.calls.length === 4, `${w.calls.length} calls`);
  if (status === 429) check('429 carries how long to wait', thrown.retryAfterSeconds === 120);
}

check('an ordinary 500 is NOT a pause', new LlmCallError('boom', 500).isUsagePause === false);
check('an ordinary 403 is NOT a pause', new LlmCallError('nope', 403).isUsagePause === false);

// 413 is a fact about THIS window and is just as true tomorrow, so pausing on
// it would let one oversized document block every document behind it.
{
  const w = makeWorld({
    passages, answer: answerOK,
    throwAt: (c) => (c.windowIndex === 2
      ? new LlmCallError('That request is larger than your plan allows (256 KB).', 413, 'request_too_large', null)
      : null),
  });
  const out = await classifyDocumentWindowed({ doc: DOC, nodes: NODES, deps: w.deps, modelId: 'claude-opus-4-8' });
  check('413 does NOT pause the run — it would never succeed on a retry', new LlmCallError('x', 413).isUsagePause === false);
  check('413 is recorded against the window and the document still finishes', out.status === 'classified');
  check('413 is not repaired — a repair prompt is longer, not shorter',
    w.calls.filter((c) => c.windowIndex === 2).length === 1);
  check('413 counts as a failed window, and says the plan is the reason',
    out.windowsFailed === 1 && out.notes.some((n) => n.includes('larger than your plan allows')), out.notes[0]);
  check('the other windows still ran', w.calls.length === plan.windows.length);
}

// -- a window that cannot be reached leaves the document for next time -------
{
  const w = makeWorld({
    passages, answer: answerOK,
    throwAt: (c) => (c.windowIndex === 2 && c.attempt === 1 ? new Error('network hiccup') : null),
  });
  const out = await classifyDocumentWindowed({ doc: DOC, nodes: NODES, deps: w.deps, modelId: 'claude-opus-4-8' });
  check('an unreachable window leaves the document incomplete', out.status === 'incomplete');
  check('nothing is written from a partially-read document', w.finished.length === 0);
  check('the other windows still ran — one failure does not end the document',
    w.calls.filter((c) => c.attempt === 1).length === plan.windows.length);
  check('the failure is reported in plain language, naming the part',
    out.notes.length === 1 && /part 3 of \d+ could not be read/.test(out.notes[0]), out.notes[0]);
  check('and the document is retried next run', w.meta.get(DOC.id).run.w.every((x) => x.i !== 2));
}

// -- the JSON repair path ----------------------------------------------------
{
  // First attempt malformed on window 1 only; the repair succeeds.
  const w = makeWorld({ passages, answer: answerOK, failAt: (c) => c.windowIndex === 1 && c.attempt === 1 });
  const out = await classifyDocumentWindowed({ doc: DOC, nodes: NODES, deps: w.deps, modelId: 'claude-opus-4-8' });
  const repairCalls = w.calls.filter((c) => c.attempt === 2);
  check('a malformed answer is repaired exactly once', repairCalls.length === 1 && repairCalls[0].windowIndex === 1);
  check('the repaired window counts as read', out.status === 'classified' && out.windowsFailed === 0);
  check('the repair is not attempted on windows that answered correctly',
    w.calls.filter((c) => c.attempt === 2 && c.windowIndex !== 1).length === 0);
}
{
  // Malformed twice on window 1: a plain sentence, and the rest still lands.
  const w = makeWorld({ passages, answer: answerOK, failAt: (c) => c.windowIndex === 1 });
  const out = await classifyDocumentWindowed({ doc: DOC, nodes: NODES, deps: w.deps, modelId: 'claude-opus-4-8' });
  check('a second malformed answer is not retried a third time',
    w.calls.filter((c) => c.windowIndex === 1).length === 2);
  check('the document still finishes on the windows that did answer', out.status === 'classified');
  check('the failed window is counted', out.windowsFailed === 1);
  check('and it is reported as a sentence an attorney can act on',
    out.notes.some((n) => n.includes('could not be used') && n.includes('by hand')), out.notes[0]);
  check('the failed window is never merged as if it were an answer',
    w.finished[0].coverage.failed_windows === 1);
}

// -- a document with no text -------------------------------------------------
{
  const w = makeWorld({ passages: [], answer: answerOK });
  const out = await classifyDocumentWindowed({ doc: DOC, nodes: NODES, deps: w.deps, modelId: 'claude-opus-4-8' });
  check('a document with no text is skipped without a model call', out.status === 'no_text' && w.calls.length === 0);
}

// ---------------------------------------------------------------------------
section('6. The paged read — 2,500 rows, tied sort keys');
// ---------------------------------------------------------------------------

/**
 * A fake PostgREST: caps every response at 1,000 rows, exactly as the real
 * one does, and honours the range. The rows carry a TIED sort key on purpose
 * — `confidence` and `sort_order` tie constantly in the real tables, and an
 * ORDER BY that leaves ties unbroken is what makes a `.range()` loop drop and
 * duplicate rows between pages.
 */
function fakeTable(n, { tie = true } = {}) {
  const rows = Array.from({ length: n }, (_, i) => ({
    id: `row-${String(i).padStart(6, '0')}`,
    sort_order: tie ? 0 : i,
    label: `item ${i}`,
  }));
  let requests = 0;
  return {
    get requests() { return requests; },
    rows,
    page(from, to) {
      requests += 1;
      const capped = Math.min(to - from + 1, 1000);
      return Promise.resolve({ data: rows.slice(from, from + capped), error: null, count: n });
    },
  };
}

{
  const t = fakeTable(2500);
  const res = await fetchPaged((from, to) => t.page(from, to), { label: 'production items' });
  check('2,500 rows come back whole — not the 1,000 an unpaged read returned', res.rows.length === 2500);
  check('the server-reported total is carried', res.total === 2500);
  check('nothing is marked truncated when it is not', res.truncated === false);
  check('every row is present exactly once', new Set(res.rows.map((r) => r.id)).size === 2500);
  check('and in order, with the sort key tied throughout',
    res.rows.every((r, i) => r.id === `row-${String(i).padStart(6, '0')}`));
  check('it took the expected number of requests', t.requests === 3, `${t.requests}`);
  check('a whole list says nothing to the user', showingOf(res, 'documents') === null);
}
{
  const t = fakeTable(1000);
  const res = await fetchPaged((from, to) => t.page(from, to));
  check('an exactly-1,000-row list is fetched whole (the boundary the old code could not see past)',
    res.rows.length === 1000 && res.truncated === false);
  check('and it costs one extra request to prove there is no more', t.requests === 2);
}
{
  const t = fakeTable(500);
  const res = await fetchPaged((from, to) => t.page(from, to));
  check('a short list is one request', t.requests === 1 && res.rows.length === 500);
}
{
  const t = fakeTable(9000);
  const res = await fetchPaged((from, to) => t.page(from, to), { ceiling: 3000 });
  check('the ceiling stops the loop', res.rows.length === 3000 && res.truncated === true);
  const notice = showingOf(res, 'documents');
  check('and a truncated list SAYS SO — this is the whole point', typeof notice === 'string');
  check('the notice names both numbers', notice.includes('3,000') && notice.includes('9,000'), notice);
}
{
  const res = await fetchPaged(() => Promise.resolve({ data: [], error: null, count: 0 }));
  check('an empty list is not an error', res.rows.length === 0 && res.total === 0 && res.truncated === false);
}
{
  let caught = null;
  try {
    await fetchPaged(() => Promise.resolve({ data: null, error: { message: 'permission denied' } }), { label: 'bucket documents' });
  } catch (e) { caught = e; }
  check('an error names the list that broke', caught?.message === 'bucket documents: permission denied', caught?.message);
}
{
  // A page size above PostgREST's cap must not be read as "the server ran out".
  const t = fakeTable(2500);
  const res = await fetchPaged((from, to) => t.page(from, to), { pageSize: 5000 });
  check('an over-large page size is clamped rather than silently truncating', res.rows.length === 2500);
}

// ---------------------------------------------------------------------------
section("7. The matter's Record — what each Bucketizer call SAYS it is");
// ---------------------------------------------------------------------------

/**
 * This section drives the REAL call sites — `generateTreeFromPleadings`,
 * `supabaseRunDeps().callWindow` and `supabaseEvidenceDeps().call` — with
 * `/api/llm` replaced by a witness. Nothing is asserted about a copy of the
 * wiring: the envelope examined is the one the product sends.
 *
 * Those three modules import `@/lib/supabase`, which reads `import.meta.env`
 * at module scope and cannot be loaded by plain node. So a second resolve
 * hook, registered here and reaching no further than that one specifier,
 * swaps it for a proxy onto `globalThis.__bkzSupabase`. Everything between
 * the call site and `fetch` — `llm-call.ts`, `structured.ts`, `auth.ts`, the
 * adapter — is the real module.
 *
 * Registering AFTER the static imports above is deliberate and safe: they are
 * hoisted and already evaluated, and none of them touches supabase (see the
 * note at the top of llm-error.ts). The modules below are imported
 * dynamically so they resolve through the new hook.
 */
{
  const SUPABASE_STUB = 'data:text/javascript,' + encodeURIComponent(
    'export const supabase = new Proxy({}, { get: (_t, k) => globalThis.__bkzSupabase[k] });',
  );
  register(
    new URL(`data:text/javascript,${encodeURIComponent(`
      const STUB = ${JSON.stringify(SUPABASE_STUB)};
      export async function resolve(specifier, context, next) {
        if (specifier === '@/lib/supabase') return { url: STUB, format: 'module', shortCircuit: true };
        return next(specifier, context);
      }
    `)}`).href,
    pathToFileURL('./'),
  );

  const { LLM_FEATURES } = await import('../src/lib/llm/features.ts');
  const { callStructured } = await import('../src/lib/bucketizer/llm-call.ts');
  const {
    BUCKETIZER_DEFAULT_MODEL, generateTreeFromPleadings, supabaseRunDeps,
    checkTreeContract, buildTreeRepairContent, TREE_CONTRACT_FAILURE, TREE_MAX_CLAIMS,
  } = await import('../src/lib/bucketizer/index.ts');
  const { supabaseEvidenceDeps } = await import('../src/lib/bucketizer/evidence.ts');

  // Real uuids: `lib/ledger.mjs` uuidList() drops the WHOLE list if one
  // element is not a uuid, so an id that is merely a string would be recorded
  // as `{items:n}` and the Record would name no document at all.
  const MATTER = '2f1a9f4e-6c3b-4a17-9d21-0b6e8c5a7d10';
  const PLEADING_A = 'aa11bb22-cc33-4d44-8e55-ff6677889900';
  const PLEADING_B = 'bb22cc33-dd44-4e55-9f66-001122334455';
  const CLASSIFY_DOC = 'cc33dd44-ee55-4f66-8a77-112233445566';
  const EVIDENCE_DOC = 'dd44ee55-ff66-4a77-9b88-223344556677';
  const EVIDENCE_NODE = 'ee55ff66-aa77-4b88-8c99-334455667788';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * One phrase, planted in the system prompt, in the user content and in the
   * passage text the tree call loads. It is what a leak would look like: the
   * words of a client's deposition arriving in a row nobody can delete.
   */
  const SENTINEL = 'the mental-health pen was left unlocked at 04:12 on August 16';

  // A chainable, thenable PostgREST stand-in — `.range()` is awaited on the
  // builder itself, `.maybeSingle()` is called.
  const q = (result) => {
    const chain = {
      select: () => chain, eq: () => chain, order: () => chain, range: () => chain,
      maybeSingle: async () => result,
      single: async () => result,
      then: (res, rej) => Promise.resolve(result).then(res, rej),
    };
    return chain;
  };

  // EVERY attempted write is recorded rather than performed, so "nothing was
  // persisted from the failed attempt" is an assertion about an empty list and
  // not about a stub that happened to throw.
  let writes = [];
  let nextNodeId = 0;
  globalThis.__bkzSupabase = {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      getUser: async () => ({ data: { user: { id: '11111111-2222-4333-8444-555555555555' } }, error: null }),
    },
    from: (table) => {
      if (table === 'bucketizer_nodes') {
        return {
          ...q({ data: null, error: null }),
          insert: (row) => {
            const written = { ...row, id: `n-${nextNodeId++}` };
            writes.push({ table, row: written });
            return q({ data: written, error: null });
          },
        };
      }
      if (table === 'documents') {
        return {
          ...q({ data: { id: PLEADING_A, title: 'Complaint', source_filename: 'complaint.pdf', processing_status: 'ready', matterspace_id: MATTER, metadata: {} }, error: null }),
          update: (row) => { writes.push({ table, row }); return q({ data: null, error: null }); },
        };
      }
      if (table === 'passages') {
        return q({ data: [{ text: `Paragraph 14. ${SENTINEL}.`, sequence_number: 0 }], error: null });
      }
      throw new Error(`section 7 did not expect a read of "${table}"`);
    },
  };

  // The egress witness. Any url but /api/llm is a failure, not a fixture.
  const seen = [];
  const realFetch = globalThis.fetch;
  let reply = { content: [{ type: 'tool_use', input: {} }] };
  globalThis.fetch = async (url, init) => {
    if (url !== '/api/llm') throw new Error(`section 7 saw egress to ${url}`);
    seen.push({ init, env: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  /** Everything every one of the three envelopes must satisfy. */
  const commonChecks = (where, env, feature, documentIds) => {
    check(`${where}: the envelope names the act — '${feature}'`, env.feature === feature, env.feature);
    check(`${where}: and it is a label the server will accept, not free text`,
      LLM_FEATURES.includes(env.feature));
    check(`${where}: the envelope names the document(s), by id`,
      JSON.stringify(env.documentIds) === JSON.stringify(documentIds), JSON.stringify(env.documentIds));
    check(`${where}: every id is a uuid — a non-uuid drops the whole list from the Record`,
      Array.isArray(env.documentIds) && env.documentIds.length > 0 && env.documentIds.every((d) => UUID.test(d)));

    // The Record fields carry metadata and nothing else.
    const recorded = JSON.stringify({ feature: env.feature, documentIds: env.documentIds });
    check(`${where}: NO prompt or excerpt text rides in the recorded fields`,
      !recorded.includes(SENTINEL) && !recorded.includes('Paragraph 14'), recorded);

    // ... and the bytes for the provider carry the prompt and nothing new.
    check(`${where}: the provider body still carries the prompt (so the check above is not vacuous)`,
      env.body.includes(SENTINEL));
    check(`${where}: the provider body carries no feature label and no document id`,
      !env.body.includes('bucketizer.') && !env.body.includes('"feature"')
      && !env.body.includes('"documentIds"') && documentIds.every((d) => !env.body.includes(d)));
    check(`${where}: the envelope gained exactly two keys and no others`,
      Object.keys(env).sort().join(',') === 'body,documentIds,feature,matterId,model,provider',
      Object.keys(env).sort().join(','));
  };

  // -- the tree, from the pleadings it was drawn from ------------------------
  //
  // An off-contract answer now buys ONE repair turn and then stops, which is
  // how this case reaches the model twice without a database behind it: the
  // insert loop is never entered, so no `bucketizer_nodes` write is attempted.
  // That is the assertion, not a convenience — a failed tree must leave the
  // matter exactly as it was.
  {
    seen.length = 0;
    writes = [];
    reply = { content: [{ type: 'tool_use', input: { claims: [] } }] };
    let threw = null;
    try {
      await generateTreeFromPleadings({ matterId: MATTER, pleadingDocIds: [PLEADING_A, PLEADING_B] });
    } catch (e) { threw = e; }

    check('tree: NOTHING was written — the existing tree is untouched by a failed answer',
      writes.length === 0, JSON.stringify(writes));
    check('tree: the failure is the plain sentence, and says nothing was changed',
      typeof threw?.message === 'string' && threw.message.startsWith(TREE_CONTRACT_FAILURE),
      threw?.message);
    check('tree: and it names what was wrong, twice',
      /Twice: the "claims" array was empty\.\)$/.test(threw?.message ?? ''), threw?.message);
    check('tree: TWO calls to /api/llm — the first answer, and one repair',
      seen.length === 2, seen.length);
    if (seen.length === 2) {
      commonChecks('tree', seen[0].env, 'bucketizer.tree', [PLEADING_A, PLEADING_B]);
      check('tree: both pleadings are named — the tree was drawn from both',
        seen[0].env.documentIds.length === 2);

      // THE REPAIR IS A METERED, RECORDED CALL. It goes through the same
      // /api/llm with the same feature label and the same document ids, so
      // the matter's Record and the wallet both see it.
      commonChecks('tree repair', seen[1].env, 'bucketizer.tree', [PLEADING_A, PLEADING_B]);
      check('tree repair: it shows the model its own answer and the reason',
        seen[1].env.body.includes('Your previous answer could not be used')
        && seen[1].env.body.includes('the \\"claims\\" array was empty'));
      check('tree repair: and asks for the nested shape by name',
        seen[1].env.body.includes('subissues') && seen[1].env.body.includes('do not send a flat list'));
      check('tree repair: same model, same tool, same allowance — only the user content differs',
        seen[1].env.model === seen[0].env.model && seen[1].env.provider === seen[0].env.provider
        && JSON.parse(seen[1].env.body).max_tokens === JSON.parse(seen[0].env.body).max_tokens
        && JSON.stringify(JSON.parse(seen[1].env.body).tools) === JSON.stringify(JSON.parse(seen[0].env.body).tools));
    }
  }

  // -- the FIRST turn's bytes are what they always were ----------------------
  //
  // Rebuilt from the same prompt pieces through the same adapter, so a valid
  // first answer sends exactly what it sent before the contract existed.
  {
    const { adapters } = await import('../src/lib/llm/adapters.ts');
    const { findModel } = await import('../src/lib/llm/providers.ts');
    const {
      TREE_SYSTEM, TREE_TOOL_NAME, TREE_TOOL_DESCRIPTION, TREE_SCHEMA, buildTreeUserContent,
    } = await import('../lib/bucketizer-core.mjs');
    const { provider, model } = findModel(BUCKETIZER_DEFAULT_MODEL);
    const expected = adapters[provider.id].buildStructuredRequestBody({
      system: TREE_SYSTEM,
      // The stub answers both pleading ids with the same row, so the real
      // call loads two pleadings — and the budget is split between them.
      userContent: buildTreeUserContent([
        { title: 'Complaint', text: `Paragraph 14. ${SENTINEL}.` },
        { title: 'Complaint', text: `Paragraph 14. ${SENTINEL}.` },
      ]),
      toolName: TREE_TOOL_NAME,
      toolDescription: TREE_TOOL_DESCRIPTION,
      inputSchema: TREE_SCHEMA,
      maxTokens: 16_000,
    }, model);
    check('tree: the first turn\'s request bytes are unchanged by the contract check',
      seen[0]?.env.body === expected,
      seen[0]?.env.body?.slice(0, 200));
  }

  const goodTree = () => ({
    claims: [{
      label: 'Excessive force (§ 1983)',
      description: 'Force used during the August 16 entry.',
      elements: [{
        label: 'Seizure',
        description: 'Records showing a seizure occurred.',
        subissues: [{ label: 'Was the pen locked?', description: 'Logs and footage.' }],
      }],
    }],
    themes: [{ label: 'Pattern of indifference', description: 'Prior complaints.' }],
  });

  // -- invalid → repair → VALID, all the way into the insert loop ------------
  //
  // The only case that executes the loop the contract now guards. It also
  // proves the repair is not a dead end: a pen that missed the shape the first
  // time and got it right the second builds the tree it was asked for.
  {
    seen.length = 0;
    writes = [];
    nextNodeId = 0;
    const replies = [
      { content: [{ type: 'tool_use', input: { claims: [] } }] },
      { content: [{ type: 'tool_use', input: goodTree() }] },
    ];
    let i = 0;
    const saveFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (url !== '/api/llm') throw new Error(`section 7 saw egress to ${url}`);
      seen.push({ init, env: JSON.parse(init.body) });
      return new Response(JSON.stringify(replies[i++]), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const created = await generateTreeFromPleadings({ matterId: MATTER, pleadingDocIds: [PLEADING_A, PLEADING_B] });
    globalThis.fetch = saveFetch;

    check('tree: a repaired answer is used, and the tree is built', created.length === 4, created.length);
    check('tree: exactly two calls — the bad answer and one repair', seen.length === 2, seen.length);

    const nodes = writes.filter((w) => w.table === 'bucketizer_nodes').map((w) => w.row);
    check('tree: four bucketizer_nodes rows — claim, element, subissue, theme',
      nodes.length === 4, nodes.length);
    check('tree: every row is marked as generated, not hand-made',
      nodes.every((n) => n.origin === 'generated'));
    check('tree: the claim and the theme are roots',
      nodes[0].parent_id === null && nodes[0].kind === 'claim'
      && nodes[3].parent_id === null && nodes[3].kind === 'theme');
    check('tree: the element hangs off its claim, and the subissue off its element',
      nodes[1].kind === 'element' && nodes[1].parent_id === nodes[0].id
      && nodes[2].kind === 'subissue' && nodes[2].parent_id === nodes[1].id,
      JSON.stringify(nodes.map((n) => [n.kind, n.parent_id, n.id])));
    check('tree: labels and descriptions survive the contract check unchanged',
      nodes[0].label === 'Excessive force (§ 1983)'
      && nodes[2].description === 'Logs and footage.');
    check('tree: the pleadings are marked as the tree’s sources, AFTER the inserts',
      writes.filter((w) => w.table === 'documents').length === 2
      && writes.findIndex((w) => w.table === 'documents')
        > writes.findLastIndex((w) => w.table === 'bucketizer_nodes'));
  }

  // -- the contract itself ---------------------------------------------------
  section('7b. The tree contract — what is refused, and what survives');

  check('a valid tree passes, and counts every bucket it would create',
    (() => { const r = checkTreeContract(goodTree()); return r.ok && r.value.nodeCount === 4; })());
  check('a non-object is refused', checkTreeContract('nope').ok === false);
  check('a null answer is refused', checkTreeContract(null).ok === false);
  check('an array is refused', checkTreeContract([{ label: 'x' }]).ok === false);
  check('no "claims" array is refused', checkTreeContract({ themes: [] }).ok === false);
  check('an EMPTY claims array is refused — a tree with no claims is not a tree',
    checkTreeContract({ claims: [] }).reason === 'the "claims" array was empty');
  check('a claim with no label is refused, and the reason says which one',
    checkTreeContract({ claims: [{ description: 'x' }] }).reason === 'claim 1 has no label');
  check('a label that is a number, not text, is refused',
    checkTreeContract({ claims: [{ label: 7, description: 'x' }] }).ok === false);
  check('a description that is not text is refused',
    checkTreeContract({ claims: [{ label: 'A', description: { note: 'x' } }] }).reason
      === 'the description for claim 1 was not text');
  check('elements that are not an array are refused',
    checkTreeContract({ claims: [{ label: 'A', description: 'x', elements: 'Seizure' }] }).reason
      === 'the elements of claim 1 was not an array');
  check('an element with no label is refused, named by its claim',
    checkTreeContract({ claims: [{ label: 'A', description: 'x', elements: [{ description: 'y' }] }] }).reason
      === 'element 1 of claim 1 has no label');

  // DANGLING PARENT REF — the flattening failure mode, refused not adopted.
  {
    const flat = checkTreeContract({
      nodes: [
        { id: 'c1', label: 'Excessive force' },
        { id: 'e1', label: 'Seizure', parent: 'c1' },
        { id: 'e2', label: 'Objective reasonableness', parent: 'c9' },
        { id: 'e3', label: 'Causation', parent: 'c7' },
      ],
    });
    check('a FLAT node list with parent refs is refused', flat.ok === false);
    check('and the reason counts the refs that point at nothing',
      flat.reason === 'the answer was a flat list of 4 nodes with parent references '
        + '(2 of them naming a parent that is not in the answer), not the nested '
        + 'claims → elements → subissues shape',
      flat.reason);
  }
  {
    const r = checkTreeContract({
      claims: [
        { label: 'Excessive force', description: 'x' },
        { label: 'Seizure', description: 'y', parent: 'Negligence' },
      ],
    });
    check('a claim naming a parent that is not in the answer is refused', r.ok === false);
    check('and it is told the shape is nested, not a reference list',
      (r.reason ?? '').includes('elements belong inside their claim'), r.reason);
  }
  {
    const r = checkTreeContract({
      claims: [
        { label: 'Excessive force', description: 'x' },
        { label: 'Seizure', description: 'y', parent: 'Excessive force' },
      ],
    });
    check('a parent ref that RESOLVES is refused too — a claim has no parent either way',
      r.ok === false && (r.reason ?? '').includes('a claim has no parent'), r.reason);
  }

  check('two claims with the same label are refused — one bucket typed twice',
    checkTreeContract({ claims: [{ label: 'Negligence', description: 'x' }, { label: ' negligence ', description: 'y' }] }).reason
      === 'two claims share the label "negligence"');
  check('two elements with the same label under one claim are refused',
    (checkTreeContract({ claims: [{ label: 'A', description: 'x', elements: [
      { label: 'Duty', description: 'd' }, { label: 'DUTY', description: 'd2' },
    ] }] }).reason ?? '').includes('two elements labelled'));
  check('a tree past the bucket ceiling is refused',
    (checkTreeContract({ claims: Array.from({ length: TREE_MAX_CLAIMS + 1 }, (_, i) => ({ label: `C${i}`, description: 'x' })) }).reason ?? '')
      .includes(`no more than ${TREE_MAX_CLAIMS}`));
  check('themes that are not an array are refused',
    checkTreeContract({ ...goodTree(), themes: 'indifference' }).ok === false);
  check('a theme with no label is refused',
    checkTreeContract({ ...goodTree(), themes: [{ description: 'x' }] }).reason === 'theme 1 has no label');
  check('a missing themes array is FINE — themes are optional',
    (() => { const t = goodTree(); delete t.themes; return checkTreeContract(t).ok === true; })());
  check('descriptions are trimmed, and an empty one becomes null rather than ""',
    (() => {
      const r = checkTreeContract({ claims: [{ label: '  Negligence  ', description: '   ' }] });
      return r.ok && r.value.claims[0].label === 'Negligence' && r.value.claims[0].description === null;
    })());

  // The repair prompt echoes the model's own answer back at it.
  {
    const body = buildTreeRepairContent('BUILD THE TREE', 'claim 1 has no label', { claims: [{ description: 'x' }] });
    check('the repair shows the model what it sent', body.includes('"description":"x"'));
    check('the repair names the precise reason', body.includes('Reason: claim 1 has no label.'));
    check('the repair keeps the original request above it', body.startsWith('BUILD THE TREE\n\n'));
    check('the repair asks for the corrected answer only, with no second chance offered',
      body.includes('Answer again by calling the tool, with exactly this shape and nothing else:'));
  }

  // -- one classification window --------------------------------------------
  const classifyCall = {
    system: `You file passages into the buckets on offer. ${SENTINEL}`,
    userContent: `Window 1 of 3.\n[p1] Q. ${SENTINEL}?\nA. Yes.`,
    maxTokens: 4_000,
    attempt: 1,
    documentId: CLASSIFY_DOC,
    windowIndex: 0,
  };
  {
    seen.length = 0;
    reply = { content: [{ type: 'tool_use', input: { assignments: [] } }] };
    const deps = supabaseRunDeps({ matterId: MATTER, modelId: BUCKETIZER_DEFAULT_MODEL });
    await deps.callWindow(classifyCall);
    check('classify: exactly one call to /api/llm', seen.length === 1, seen.length);
    if (seen.length === 1) commonChecks('classify', seen[0].env, 'bucketizer.classify', [CLASSIFY_DOC]);
  }

  // -- one evidence pairing --------------------------------------------------
  {
    seen.length = 0;
    reply = { content: [{ type: 'tool_use', input: { quotes: [] } }] };
    const deps = supabaseEvidenceDeps({ matterId: MATTER, modelId: BUCKETIZER_DEFAULT_MODEL });
    await deps.call({
      system: `You quote verbatim. ${SENTINEL}`,
      userContent: `[e1] ${SENTINEL}`,
      maxTokens: 4_000,
      attempt: 1,
      nodeId: EVIDENCE_NODE,
      documentId: EVIDENCE_DOC,
    });
    check('evidence: exactly one call to /api/llm', seen.length === 1, seen.length);
    if (seen.length === 1) commonChecks('evidence', seen[0].env, 'bucketizer.evidence', [EVIDENCE_DOC]);
  }

  // -- the bytes the provider sees are unchanged -----------------------------
  //
  // A/B through the real `callStructured`: the same StructuredRequest twice,
  // once with the two Record fields and once without. If the destructure in
  // llm-call.ts ever stopped pulling them out of `...request`, the adapter
  // would see them and these two bodies would differ.
  {
    seen.length = 0;
    reply = { content: [{ type: 'tool_use', input: { assignments: [] } }] };
    const base = {
      modelId: BUCKETIZER_DEFAULT_MODEL,
      system: classifyCall.system,
      userContent: classifyCall.userContent,
      toolName: CLASSIFY_TOOL_NAME,
      toolDescription: CLASSIFY_TOOL_DESCRIPTION,
      inputSchema: CLASSIFY_SCHEMA,
      maxTokens: classifyCall.maxTokens,
      matterId: MATTER,
    };
    await callStructured({ ...base, feature: 'bucketizer.classify', documentIds: [CLASSIFY_DOC] });
    await callStructured(base);
    const [withFields, without] = seen.map((s) => s.env);
    check('A/B: the provider body is BYTE-IDENTICAL with and without the Record fields',
      withFields.body === without.body);
    check('A/B: a call that says nothing sends no label and no ids',
      !('feature' in without) && !('documentIds' in without),
      Object.keys(without).join(','));
    check('A/B: and the rest of the envelope is the same either way',
      withFields.provider === without.provider && withFields.model === without.model
      && withFields.matterId === without.matterId);
  }

  globalThis.fetch = realFetch;
  delete globalThis.__bkzSupabase;
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
