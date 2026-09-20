// Probe: choosing the documents the Bucketizer classifies.
//
// Entirely offline — no network, no .env, no database, no model. Node 22.18+
// strips the .ts types; run it with the '@/' loader:
//
//   node --import ./scripts/_node-src-loader.mjs scripts/_verify-bucketizer-chooser.mjs
//
// What is asserted here, and what each one is the fix for:
//
//   1. THE CLICK IS NEVER SILENT. "Classify new documents (N)" listed the
//      matter's unclassified documents and, on an empty list, returned — no
//      dialog, no message, nothing on screen. Step 2 now opens the list every
//      time, and a count of zero is a sentence with somewhere to go.
//   2. THE RUN NAMES WHAT IT WILL READ. Eden added a document, was asked
//      whether to run "1 document", said run — and the classifier read the
//      COMPLAINT the tree was built from: his upload was still processing, and
//      the complaint was the only ready document with no classification rows.
//      So: pleadings the tree came from are marked and excluded from
//      "everything not yet classified", documents still processing are named
//      in the chooser with the reason, and the confirmation lists titles.
//   3. A SEALED MATTER'S HELD DOCUMENT IS STILL CLASSIFIABLE. A mixed PDF in a
//      SecureSpace finishes `held` with its typed pages indexed; classification
//      reads passage text, not vectors, so "is ready" was the wrong test.
//   4. STRICT MATTER ISOLATION, in the library rather than in the UI.
//   5. A RE-RUN NEVER OVERWRITES A DECISION and never deletes a row.
//   6. A RUN GOES OVER EXACTLY THE CHOSEN DOCUMENTS, and still resumes.
//
// Untracked by convention elsewhere in scripts/, but this one runs in CI.

import { readFileSync } from 'node:fs';
import {
  buildChooserRows,
  choosableIn,
  classifyAction,
  docRowsForRun,
  freshCandidates,
  freshCandidateRows,
  groupChosen,
  isChoosable,
  planClassificationWrites,
  reclassifyNotices,
  sentinelAfterRun,
  summarizeChosen,
  NOTHING_NEW_MESSAGE,
} from '../src/lib/bucketizer/chooser.ts';
import { classifyDocumentWindowed } from '../src/lib/bucketizer/classify-run.ts';
import { serializeOutline } from '../lib/bucketizer-core.mjs';

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`PASS  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name}`); if (detail !== undefined) console.log(`      ${detail}`); }
};
const section = (t) => console.log(`\n${t}`);

const SRC = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Fixtures: one matter, two sub-matters, and one document of every kind.
// ---------------------------------------------------------------------------

const MATTER = 'm-fleming';
const DEPOS = 'm-fleming-depos';
const OTHER = 'm-someone-else';          // another client. Never offered.
const TREE = [MATTER, DEPOS];

const DOCS = [
  // The complaint the tree was generated from — ready, no rows, and NOT new.
  {
    id: 'd-complaint', title: 'Voss v. Harbor Municipal — Complaint', matterspace_id: MATTER,
    processing_status: 'ready', page_count: 24,
    metadata: { bucketizer: { tree_source_at: '2026-09-19T10:00:00.000Z' } },
  },
  // The upload that was still processing when the run went off.
  {
    id: 'd-uploading', title: 'Marlow deposition 11.02.25', matterspace_id: DEPOS,
    processing_status: 'extracting', page_count: null, metadata: null,
  },
  { id: 'd-new', title: 'Harbor incident report 114-A', matterspace_id: DEPOS, processing_status: 'ready', page_count: 6, metadata: null },
  { id: 'd-new-2', title: 'Aug 16 use-of-force log', matterspace_id: DEPOS, processing_status: 'ready', page_count: 3, metadata: null },
  {
    id: 'd-classified', title: 'Rivera deposition', matterspace_id: DEPOS,
    processing_status: 'ready', page_count: 247, metadata: null,
  },
  {
    id: 'd-empty', title: 'Parking receipt', matterspace_id: MATTER, processing_status: 'ready',
    page_count: 1, metadata: { bucketizer: { no_buckets_at: '2026-09-15T12:00:00.000Z' } },
  },
  {
    id: 'd-image', title: 'Scene photograph', matterspace_id: MATTER, processing_status: 'ready',
    page_count: 1, text_status: 'image_only', metadata: null,
  },
  {
    id: 'd-outline', title: 'Voss v. Harbor Municipal Authority — Trial Outline 2026-09-19 1432',
    matterspace_id: MATTER, processing_status: 'ready', page_count: 40, metadata: null,
  },
  // A SecureSpace's mixed PDF: 12 typed pages indexed, 8 scanned pages not sent out.
  {
    id: 'd-held-part', title: 'Sealed medical file (mixed scan)', matterspace_id: MATTER,
    processing_status: 'held', page_count: 20,
    metadata: { ocr_pending: { pages: [13, 14, 15, 16, 17, 18, 19, 20], page_count: 20, held: true, reason: 'SecureSpace seal — 8 scanned page(s) were not sent out for OCR.' } },
  },
  // A SecureSpace's whole-document scan: nothing was read at all.
  {
    id: 'd-held-none', title: 'Sealed exhibit (scan)', matterspace_id: MATTER,
    processing_status: 'held', processing_error: 'SecureSpace seal — OCR has no sealed route.',
    page_count: 9,
    metadata: { ocr_pending: { pages: [1, 2, 3, 4, 5, 6, 7, 8, 9], page_count: 9, held: true, reason: 'seal' } },
  },
  // Another client's document, in the same table. Never in this list.
  { id: 'd-elsewhere', title: 'Someone else v. Someone', matterspace_id: OTHER, processing_status: 'ready', page_count: 5, metadata: null },
];

const CLASSIFICATIONS = [
  { document_id: 'd-classified', status: 'confirmed', proposed_at: '2026-09-10T09:00:00.000Z', decided_at: '2026-09-12T15:00:00.000Z' },
  { document_id: 'd-classified', status: 'proposed', proposed_at: '2026-09-10T09:00:00.000Z', decided_at: null },
];

const NAMES = new Map([[MATTER, 'Fleming'], [DEPOS, 'Depositions']]);

const rows = buildChooserRows({
  matterIds: TREE, documents: DOCS, classifications: CLASSIFICATIONS, matterNames: NAMES,
});
const byId = new Map(rows.map((r) => [r.id, r]));

// ---------------------------------------------------------------------------
section('1. The chooser lists this matter tree, and nothing else');
// ---------------------------------------------------------------------------

check(
  'every row belongs to this matter or a sub-matter of it',
  rows.every((r) => TREE.includes(r.matterId)),
  rows.filter((r) => !TREE.includes(r.matterId)).map((r) => r.id).join(', '),
);
check('another client\'s document is not in the list', !byId.has('d-elsewhere'));
check('every document of this tree IS in the list', rows.length === DOCS.length - 1, `${rows.length} rows`);
check(
  'rows carry the matter they live in, for grouping',
  byId.get('d-new').matterName === 'Depositions' && byId.get('d-complaint').matterName === 'Fleming',
);

// ---------------------------------------------------------------------------
section('2. Every document says what has happened to it');
// ---------------------------------------------------------------------------

const expectState = (id, state) => check(`${id} → ${state}`, byId.get(id)?.state === state, byId.get(id)?.state);
expectState('d-new', 'unclassified');
expectState('d-classified', 'classified');
expectState('d-empty', 'examined_empty');
expectState('d-uploading', 'not_ready');
expectState('d-image', 'no_text');
expectState('d-outline', 'outline');
expectState('d-held-part', 'held_partial');
expectState('d-held-none', 'not_ready');
expectState('d-complaint', 'unclassified');

check(
  'a classified document shows the date it was classified',
  byId.get('d-classified').status.includes('12 Sep 2026'),
  byId.get('d-classified').status,
);
check(
  'a classified document counts the decisions you made',
  byId.get('d-classified').rows === 2 && byId.get('d-classified').decided === 1,
);

// A blocked row is SHOWN with its reason — never hidden.
for (const id of ['d-uploading', 'd-image', 'd-outline', 'd-held-none']) {
  const row = byId.get(id);
  check(`${id} cannot be chosen, and says why`, !isChoosable(row) && Boolean(row.blockedReason), row.blockedReason);
}
check(
  'a document still ingesting says so in plain words',
  /still processing/i.test(byId.get('d-uploading').blockedReason),
  byId.get('d-uploading').blockedReason,
);
check(
  'a sealed document with nothing read says the seal is the reason',
  /sealed/i.test(byId.get('d-held-none').blockedReason),
  byId.get('d-held-none').blockedReason,
);
check(
  'an image-only scan says there is nothing to read',
  /nothing for the classifier to read/i.test(byId.get('d-image').blockedReason),
  byId.get('d-image').blockedReason,
);

// ---------------------------------------------------------------------------
section('3. A sealed matter\'s held document, read in part');
// ---------------------------------------------------------------------------

const held = byId.get('d-held-part');
check('a held document with typed pages CAN be chosen', isChoosable(held));
check(
  'it says how much of it was read, and how much was not',
  held.caution.includes('12 page') && held.caution.includes('8 scanned page'),
  held.caution,
);
check(
  'it is NOT swept up by "everything not yet classified"',
  !freshCandidates(rows).some((d) => d.id === 'd-held-part'),
);

// ---------------------------------------------------------------------------
section('4. The tree\'s own pleadings are not "new documents"');
// ---------------------------------------------------------------------------

const fresh = freshCandidates(rows);
check('the complaint is marked as a source of the tree', byId.get('d-complaint').treeSource === true);
check(
  'the complaint is NOT in "everything not yet classified"',
  !fresh.some((d) => d.id === 'd-complaint'),
  fresh.map((d) => d.id).join(', '),
);
check(
  'the complaint is still offered, labelled',
  isChoosable(byId.get('d-complaint')) && /used to build the tree/i.test(byId.get('d-complaint').status),
  byId.get('d-complaint').status,
);
check(
  'what IS new is exactly the two unread documents',
  fresh.map((d) => d.id).sort().join(',') === 'd-new,d-new-2',
  fresh.map((d) => d.id).join(','),
);
check(
  'an image-only scan is not counted as new for ever',
  !fresh.some((d) => d.id === 'd-image'),
);
check('the count and the selection come from the same rows', freshCandidateRows(rows).length === fresh.length);

// ---------------------------------------------------------------------------
section('5. What the button says, and what a count of zero says');
// ---------------------------------------------------------------------------

check('the button always opens the list', classifyAction(3).opensChooser === true && classifyAction(0).opensChooser === true);
check('the label never promises a run', classifyAction(3).label === 'Choose documents…', classifyAction(3).label);
check('the count rides as a badge', classifyAction(3).badge === '3 not yet classified', classifyAction(3).badge);
check('zero is said, not left blank', classifyAction(0).badge === 'nothing new');
check('an unknown count claims nothing', classifyAction(null).badge === null);
check(
  'the empty message names the Vault and choosing again',
  /Vault/.test(NOTHING_NEW_MESSAGE) && /choose documents/i.test(NOTHING_NEW_MESSAGE),
  NOTHING_NEW_MESSAGE,
);

// ---------------------------------------------------------------------------
section('6. Choosing: folders, and the isolation check');
// ---------------------------------------------------------------------------

const folder = choosableIn(rows, [DEPOS]);
check(
  'selecting a folder selects its choosable documents',
  folder.map((r) => r.id).sort().join(',') === 'd-classified,d-new,d-new-2',
  folder.map((r) => r.id).join(','),
);
check(
  'a folder never selects a document that cannot be read',
  !folder.some((r) => r.id === 'd-uploading'),
);

const picked = docRowsForRun(rows, ['d-new', 'd-classified', 'd-uploading', 'd-elsewhere', 'd-not-a-document']);
check(
  'the run takes exactly the choosable ids that are in this tree',
  picked.map((d) => d.id).sort().join(',') === 'd-classified,d-new',
  picked.map((d) => d.id).join(','),
);
check('an id from another matter is dropped before the run', !picked.some((d) => d.id === 'd-elsewhere'));
check('a document that cannot be read is dropped before the run', !picked.some((d) => d.id === 'd-uploading'));
check(
  'the run gets what the estimate needs',
  picked.every((d) => typeof d.title === 'string' && 'page_count' in d && 'doc_type' in d),
);

// ---------------------------------------------------------------------------
section('7. The confirmation names the documents');
// ---------------------------------------------------------------------------

const groups = groupChosen(rows, ['d-new', 'd-classified', 'd-complaint']);
check('the chosen documents are grouped by the matter they live in', groups.length === 2, JSON.stringify(groups));
check(
  'each group names its documents',
  groups.find((g) => g.matterName === 'Fleming').titles.includes('Voss v. Harbor Municipal — Complaint'),
  JSON.stringify(groups),
);
check(
  'the depositions group holds both of its documents',
  groups.find((g) => g.matterName === 'Depositions').titles.sort().join('|')
    === ['Harbor incident report 114-A', 'Rivera deposition'].sort().join('|'),
);
check('a blocked document never reaches the confirmation', !JSON.stringify(groups).includes('Scene photograph'));

const summary = summarizeChosen(rows, ['d-new', 'd-classified']);
check('the summary counts what is being read again', summary.documents === 2 && summary.alreadyClassified === 1);
check('and how much of it you have already decided', summary.withDecisions === 1);
const notices = reclassifyNotices(summary);
check(
  'the dialog says decisions stay as they are',
  notices.some((n) => /decisions you made; those stay as they are/.test(n)),
  notices.join(' | '),
);
check(
  'the dialog says a re-read is charged again',
  notices.some((n) => /charged again/.test(n)),
  notices.join(' | '),
);
check('a first pass says none of that', reclassifyNotices(summarizeChosen(rows, ['d-new'])).length === 0);

// ---------------------------------------------------------------------------
section('8. A re-run adds and refreshes. It never overwrites a decision.');
// ---------------------------------------------------------------------------

const existing = [
  { id: 'c-confirmed', node_id: 'n-1', status: 'confirmed' },
  { id: 'c-rejected', node_id: 'n-2', status: 'rejected' },
  { id: 'c-proposed', node_id: 'n-3', status: 'proposed' },
  { id: 'c-stale', node_id: 'n-4', status: 'proposed' },
];
const proposed = [
  { node_id: 'n-1', confidence: 0.4, rationale: 'the re-read disagrees', passage_ids: ['p9'] },
  { node_id: 'n-2', confidence: 0.9, rationale: 'the re-read disagrees', passage_ids: ['p9'] },
  { node_id: 'n-3', confidence: 0.95, rationale: 'pages 180–195, read this time', passage_ids: ['p180'] },
  { node_id: 'n-5', confidence: 0.8, rationale: 'a bucket added since', passage_ids: ['p7'] },
];
const plan = planClassificationWrites(existing, proposed);

check('the plan has no delete of any kind', !('delete' in plan) && !JSON.stringify(Object.keys(plan)).includes('delete'), Object.keys(plan).join(','));
check('a confirmed row is untouched', plan.keptDecided.includes('c-confirmed'));
check('a rejected row is untouched', plan.keptDecided.includes('c-rejected'));
check(
  'a decided row is never refreshed and never re-inserted',
  !plan.refresh.some((r) => ['c-confirmed', 'c-rejected'].includes(r.id))
    && !plan.insert.some((r) => ['n-1', 'n-2'].includes(r.node_id)),
);
check(
  'an undecided proposal is refreshed from the new read',
  plan.refresh.length === 1 && plan.refresh[0].id === 'c-proposed'
    && plan.refresh[0].row.rationale === 'pages 180–195, read this time',
  JSON.stringify(plan.refresh),
);
check('a bucket the document is not in yet gets a new row', plan.insert.length === 1 && plan.insert[0].node_id === 'n-5');
check(
  'an undecided proposal the re-read no longer makes is kept, not deleted',
  plan.keptStale.includes('c-stale'),
);
check(
  'every existing row is accounted for exactly once',
  [...plan.keptDecided, ...plan.keptStale, ...plan.refresh.map((r) => r.id)].sort().join(',')
    === existing.map((e) => e.id).sort().join(','),
);

// A first pass over a document with no rows is the plain insert it always was.
const firstPass = planClassificationWrites([], proposed);
check('a first pass inserts everything and refreshes nothing', firstPass.insert.length === 4 && firstPass.refresh.length === 0);

check(
  'the sentinel is set only when the document ends in no bucket at all',
  sentinelAfterRun({ existingRows: 0, writtenRows: 0, completedAt: 'T' }) === 'T'
  && sentinelAfterRun({ existingRows: 0, writtenRows: 2, completedAt: 'T' }) === null
  && sentinelAfterRun({ existingRows: 3, writtenRows: 0, completedAt: 'T' }) === null,
);

// ---------------------------------------------------------------------------
section('9. The run goes over exactly the chosen documents, and still resumes');
// ---------------------------------------------------------------------------

const NODES = [
  { id: 'n-claim', parent_id: null, kind: 'claim', label: 'Excessive force', description: 'Force claims.', position: 0 },
  { id: 'n-el', parent_id: 'n-claim', kind: 'element', label: 'Causation', description: 'Injury traced to the force.', position: 0 },
];
const { refToId } = serializeOutline(NODES);
const FIRST_REF = [...refToId.keys()][0];

/** A document long enough to need several windows. */
function longPassages(count = 200, chars = 1500) {
  return Array.from({ length: count }, (_, i) => ({
    id: `p-${i}`,
    text: `Q. ${'And directing your attention to that day, '.repeat(Math.ceil(chars / 42))}`.slice(0, chars),
    page_start: i + 1,
    page_end: i + 1,
    sequence_number: i,
  }));
}

function makeDeps({ failWindow = -1 } = {}) {
  const state = { runs: new Map(), finished: new Map(), calls: [] };
  const deps = {
    async fetchPassages() { return longPassages(); },
    async loadRun(id) { return state.runs.get(id) ?? null; },
    async saveRun(id, run) { state.runs.set(id, JSON.parse(JSON.stringify(run))); },
    async finish(id, result) { state.finished.set(id, result); state.runs.delete(id); },
    async callWindow(call) {
      state.calls.push(`${call.documentId}#${call.windowIndex}`);
      if (call.windowIndex === failWindow) throw new Error('the network went away');
      return { assignments: [{ ref: FIRST_REF, confidence: 0.9, rationale: 'it is about causation', passageRefs: ['P1'] }] };
    },
    now: () => '2026-09-20T00:00:00.000Z',
  };
  return { deps, state };
}

const chosen = docRowsForRun(rows, ['d-new', 'd-classified']);
const { deps, state } = makeDeps();
for (const doc of chosen) {
  await classifyDocumentWindowed({ doc, nodes: NODES, deps, modelId: 'test-model' });
}
const documentsRead = [...new Set(state.calls.map((c) => c.split('#')[0]))].sort();
check(
  'exactly the chosen documents were read — no others',
  documentsRead.join(',') === 'd-classified,d-new',
  documentsRead.join(','),
);
check('and both of them finished', state.finished.size === 2);

// Resume: a window that could not be reached leaves the document unfinished,
// and the next run pays only for what is left.
const { deps: flaky, state: s1 } = makeDeps({ failWindow: 2 });
const first = await classifyDocumentWindowed({ doc: chosen[0], nodes: NODES, deps: flaky, modelId: 'test-model' });
check('an unreachable window leaves the document incomplete', first.status === 'incomplete', first.status);
check('nothing is written from a partial read', s1.finished.size === 0);

flaky.callWindow = async (call) => {
  s1.calls.push(`${call.documentId}#${call.windowIndex}`);
  return { assignments: [{ ref: FIRST_REF, confidence: 0.9, rationale: 'it is about causation', passageRefs: ['P1'] }] };
};
const callsBefore = s1.calls.length;
const second = await classifyDocumentWindowed({ doc: chosen[0], nodes: NODES, deps: flaky, modelId: 'test-model' });
const paidAgain = s1.calls.length - callsBefore;
check('the re-run finishes the document', second.status === 'classified', second.status);
check('and pays only for the windows that were never answered', second.windowsResumed > 0 && paidAgain < second.windowsTotal, `${paidAgain} of ${second.windowsTotal}`);

// ---------------------------------------------------------------------------
section('10. The surface and the engine do what this harness describes');
// ---------------------------------------------------------------------------

const surface = SRC('src/components/matter/BucketizerSurface.tsx');
const engine = SRC('src/lib/bucketizer/index.ts');
const picker = SRC('src/components/matter/CorpusDocumentPicker.tsx');

// The silent path was: list the unclassified documents, and on an empty list
// return. There is no longer a classify click that ends in a bare `return` —
// the surface does not call that function at all; step 2 opens the list.
check(
  'the click that returned in silence is gone',
  !/listUnclassifiedDocs/.test(surface) && !/handlePrepareRun/.test(surface),
);
check('step 2 opens the chooser', /onClick=\{\(\) => void openChooser\(\)\}/.test(surface));
check('the chooser is confined to this matter', /confineToRoot/.test(surface));
check('the chooser is multi-select, with folders and search', /multi\b/.test(surface) && /onSelectFolder=/.test(surface) && /searchAll=/.test(surface));
check('the confirmation is given the names', /groups=\{pending\.groups\}/.test(surface));
check('a count of zero has somewhere to go', /NothingNewNotice/.test(surface) && /app\/vault\?matter=/.test(surface));
check('there is a way back out of the module', /Back to the matter/.test(surface) && /ArrowLeft/.test(surface));
check('the browser\'s Back closes the chooser', /popstate/.test(surface));

check('the engine plans its writes', /planClassificationWrites\(/.test(engine));
check('a refresh can only touch an undecided row', /\.eq\('status', 'proposed'\)/.test(engine));
check(
  'the engine never deletes a classification row',
  !/from\('bucketizer_classifications'\)[\s\S]{0,300}?\.delete\(/.test(engine),
);
check('the tree records the pleadings it was built from', /tree_source_at/.test(engine));
check('a document with no text is reported rather than passed over', /no text to read/.test(engine));

check('Escape closes the picker', /e\.key === 'Escape'/.test(picker));
check('the picker\'s ribbon drags and the panel resizes', /onPointerDown/.test(picker) && /resize: 'both'/.test(picker));
check('shift-click takes a range', /shiftKey/.test(picker));

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
