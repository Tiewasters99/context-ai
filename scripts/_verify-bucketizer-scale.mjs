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
import { serializeOutline } from '../lib/bucketizer-core.mjs';

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
for (const [status, label] of [[402, 'budget spent'], [429, 'rate limited'], [413, 'request too large for the plan']]) {
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

console.log(failures ? `\n${failures} FAILURES` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
