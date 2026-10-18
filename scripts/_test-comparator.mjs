// The Model Comparator, offline: the Comparison-notes template (a pure
// function: grades + margin notes in, Markdown out) and the one server action,
// add_comparison_candidate, driven against a stub Supabase client.
//
//   node --import ./scripts/_node-src-loader.mjs --test scripts/_test-comparator.mjs
//
// The template is imported through src/lib/comparator/assemble.ts, the path
// the browser uses; the action from lib/comparator.mjs, the path
// api/sandbox.mjs uses. No network, no database, no secrets.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assembleComparisonNotes,
  countWords,
  dimensionOf,
  noteLocation,
  GENERAL,
} from '../src/lib/comparator/assemble.ts';
import { addComparisonCandidate, nextLabel, blindNames, slug } from '../lib/comparator.mjs';

const RUBRIC = [
  { key: 'strategy', label: 'Strategy' },
  { key: 'authority', label: 'Authority' },
  { key: 'prose', label: 'Prose' },
];

const fixture = (over = {}) => ({
  matter: { name: 'Patel World — Open Record', short_code: 'sbx-patel-open' },
  comparison: {
    title: 'Novak 702 motion',
    type: 'motion_brief',
    type_label: 'Draft a motion or brief',
    instructions: 'Draft a motion to exclude Dr. Novak under Rule 702.\nUse only the packet.',
    packet: [{ id: 'p1', title: 'Novak report' }, { id: 'p2', title: 'Novak deposition' }],
    packet_hash: 'ab'.repeat(32),
    rubric: RUBRIC,
    revealed_at: null,
    ...(over.comparison ?? {}),
  },
  candidates: over.candidates ?? [
    { id: 'cB', label: 'B', word_count: 2300, revealed_label: 'Model Two' },
    { id: 'cA', label: 'A', word_count: 1980, revealed_label: 'Model One' },
    { id: 'cC', label: 'C', word_count: null, revealed_label: 'Model Three' },
  ],
  grades: over.grades ?? [
    { candidate_id: 'cA', scores: { strategy: 8, authority: 6, prose: 7 }, overall: 7, comment: 'Strong frame.\nThin on the record.', initials: 'EQ', graded_at: '2026-10-19T14:02:31Z' },
    { candidate_id: 'cB', scores: { strategy: 6, authority: 9, prose: 6 }, overall: 6, comment: '', initials: 'EQ', graded_at: '2026-10-19T15:10:00Z' },
  ],
  notes: over.notes ?? [
    { id: 'n3', candidate_id: 'cA', note: 'Good use of Daubert.', tag: 'authority', page: 1, text_anchor: { start: 4200 }, anchor_text: 'Daubert v. Merrell Dow', created_at: '2026-10-19T14:00:00Z' },
    { id: 'n1', candidate_id: 'cA', note: 'Opens with the theme.', tag: 'strategy', page: 1, text_anchor: { start: 120 }, anchor_text: 'This motion   asks one question', created_at: '2026-10-19T13:50:00Z' },
    { id: 'n2', candidate_id: 'cA', note: 'Authority: cites the packet as (Doc. 1).', tag: null, page: 1, text_anchor: { start: 900 }, anchor_text: '(Doc. 1)', created_at: '2026-10-19T13:55:00Z' },
    { id: 'n4', candidate_id: 'cA', note: 'Typo here.', tag: 'vibes', page: 1, text_anchor: { start: 3000 }, anchor_text: 'teh', created_at: '2026-10-19T13:57:00Z' },
    { id: 'n5', candidate_id: 'cB', note: 'Pincite is wrong.\nShould be 45:3.', tag: 'Authority', page: 2, line_start: 4, line_end: 6, text_anchor: null, anchor_text: 'Novak Dep. 44:2', created_at: '2026-10-19T15:00:00Z' },
    { id: 'n6', candidate_id: 'cB', note: '   ', tag: 'prose', page: 1, text_anchor: { start: 10 }, anchor_text: 'blank highlight', created_at: '2026-10-19T15:01:00Z' },
  ],
  generated_at: '2026-10-19T16:00:00Z',
});

test('the notes are deterministic: the same input gives the same bytes', () => {
  assert.equal(assembleComparisonNotes(fixture()), assembleComparisonNotes(fixture()));
});

test('header: matter, type, packet with hash, instructions, blind candidate labels in order', () => {
  const md = assembleComparisonNotes(fixture());
  assert.match(md, /^# Comparison notes — Novak 702 motion\n/);
  assert.match(md, /- \*\*Matter:\*\* Patel World — Open Record \(sbx-patel-open\)/);
  assert.match(md, /- \*\*Type:\*\* Draft a motion or brief/);
  assert.match(md, /- \*\*Packet:\*\* 2 documents — sha256 `(ab){32}`\n  - Novak report\n  - Novak deposition/);
  assert.match(md, /- \*\*Candidates:\*\* A; B; C \(blind — not yet revealed\)/);
  assert.match(md, /> Draft a motion to exclude Dr\. Novak under Rule 702\.\n> Use only the packet\./);
  assert.match(md, /No model wrote any part of this document\./);
});

test('blind: before the reveal no revealed name appears anywhere, even if one is passed in', () => {
  const md = assembleComparisonNotes(fixture());
  for (const name of ['Model One', 'Model Two', 'Model Three']) assert.ok(!md.includes(name), name);
});

test('after the reveal the names are appended to the labels', () => {
  const md = assembleComparisonNotes(fixture({ comparison: { revealed_at: '2026-10-19T15:30:00Z' } }));
  assert.match(md, /- \*\*Candidates:\*\* A — Model One; B — Model Two; C — Model Three\n/);
  assert.match(md, /- \*\*Revealed:\*\* 2026-10-19 15:30 UTC/);
  assert.match(md, /## Candidate A — Model One/);
});

test('grade table: candidates × dimensions + overall + words + who signed; ungraded shown as such; mean row', () => {
  const md = assembleComparisonNotes(fixture());
  assert.match(md, /\| Candidate \| Strategy \| Authority \| Prose \| Overall \| Words \| Signed \|/);
  assert.match(md, /\| A \| 8 \| 6 \| 7 \| 7 \| 1,980 \| EQ 2026-10-19 14:02 UTC \|/);
  assert.match(md, /\| B \| 6 \| 9 \| 6 \| 6 \| 2,300 \| EQ 2026-10-19 15:10 UTC \|/);
  assert.match(md, /\| C \| — \| — \| — \| — \| — \| not graded \|/);
  assert.match(md, /\| \*Mean of 2 graded\* \| 7\.0 \| 7\.5 \| 6\.5 \| 6\.5 \| \| \|/);
});

test('per candidate: comment, then notes in offset order grouped by dimension, General last', () => {
  const md = assembleComparisonNotes(fixture());
  const a = md.slice(md.indexOf('## Candidate A'), md.indexOf('## Candidate B'));
  assert.match(a, /\*\*Grade-card comment \(EQ\):\*\* \n\n> Strong frame\.\n> Thin on the record\./);
  assert.match(a, /4 margin notes, in reading order/);
  const order = ['### Strategy', '“This motion asks one question” (offset 120)', '### Authority', '“(Doc. 1)” (offset 900)', '“Daubert v. Merrell Dow” (offset 4,200)', '### General', '“teh” (offset 3,000)'];
  let at = -1;
  for (const s of order) {
    const i = a.indexOf(s);
    assert.ok(i > at, `"${s}" out of order`);
    at = i;
  }
  assert.ok(!a.includes('### Prose'), 'an empty dimension is not printed under the candidate');
});

test('a PDF note shows page:line; a multi-line note keeps its lines; blank notes are dropped', () => {
  const md = assembleComparisonNotes(fixture());
  const b = md.slice(md.indexOf('## Candidate B'), md.indexOf('## Candidate C'));
  assert.match(b, /- “Novak Dep\. 44:2” \(p\. 2:4-6\)\n  Pincite is wrong\.\n  Should be 45:3\./);
  assert.match(b, /\*\*Grade-card comment \(EQ\):\*\* \(none\)/);
  assert.ok(!b.includes('blank highlight'));
  const c = md.slice(md.indexOf('## Candidate C'), md.indexOf('## By dimension'));
  assert.match(c, /\(not graded\)/);
  assert.match(c, /No margin notes\./);
});

test('by dimension: each dimension lists every candidate side by side with its score', () => {
  const md = assembleComparisonNotes(fixture());
  const auth = md.slice(md.indexOf('### Authority', md.indexOf('## By dimension')), md.indexOf('### Prose', md.indexOf('## By dimension')));
  assert.match(auth, /\*\*A\*\* — 6\/10\n\n- “\(Doc\. 1\)”/);
  assert.match(auth, /\*\*B\*\* — 9\/10\n\n- “Novak Dep\. 44:2”/);
  assert.match(auth, /\*\*C\*\* — not graded\n\n- \(no notes\)/);
});

test('the synthetic overview is a labelled placeholder (slice 2)', () => {
  const md = assembleComparisonNotes(fixture());
  assert.match(md, /## Synthetic overview — not generated in this version\n/);
  assert.ok(md.trimEnd().endsWith('Nothing in this document was written by a model.'));
});

test('authors are named only when more than one person wrote notes', () => {
  const one = assembleComparisonNotes(fixture({ notes: [{ id: 'x', candidate_id: 'cA', note: 'n', page: 1, author: 'Eden' }] }));
  assert.ok(!one.includes('— Eden'));
  const two = assembleComparisonNotes(fixture({ notes: [
    { id: 'x', candidate_id: 'cA', note: 'n', page: 1, author: 'Eden' },
    { id: 'y', candidate_id: 'cB', note: 'm', page: 1, author: 'Ari' },
  ] }));
  assert.ok(two.includes('(p. 1) — Eden') && two.includes('(p. 1) — Ari'));
});

test('dimensionOf: tag by key or label (any case), else a "Label:" prefix, else General', () => {
  assert.equal(dimensionOf({ tag: 'authority' }, RUBRIC).key, 'authority');
  assert.equal(dimensionOf({ tag: 'PROSE' }, RUBRIC).key, 'prose');
  assert.equal(dimensionOf({ tag: null, note: 'Strategy: weak' }, RUBRIC).key, 'strategy');
  assert.equal(dimensionOf({ tag: 'nope', note: 'Strategy: weak' }, RUBRIC), GENERAL);
  assert.equal(dimensionOf({ tag: null, note: 'plain' }, RUBRIC), GENERAL);
});

test('noteLocation and countWords', () => {
  assert.equal(noteLocation({ text_anchor: { start: 12345 }, page: 1 }), 'offset 12,345');
  assert.equal(noteLocation({ page: 3 }), 'p. 3');
  assert.equal(noteLocation({ page: 3, line_start: 7 }), 'p. 3:7');
  assert.equal(countWords('# Heading\n\n**Bold** words, and a [link](http://x.y).\n\n- item one\n> quoted'), 9);
  assert.equal(countWords(''), 0);
});

// ---------------------------------------------------------------------------
// add_comparison_candidate against a stub Supabase client
// ---------------------------------------------------------------------------
const CMP = '11111111-1111-4111-8111-111111111111';
const BOX = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

function stubClient({ existingLabels = [], revealed = false, candidateError = null, keyError = null } = {}) {
  const ops = [];
  const result = (table, op, payload, opts) => {
    if (table === 'comparisons') return { data: { id: CMP, box_matter_id: BOX, title: 'Novak 702 motion', revealed_at: revealed ? '2026-10-19T00:00:00Z' : null }, error: null };
    if (table === 'comparison_candidates' && op === 'select') return { data: existingLabels.map((label) => ({ label })), error: null };
    if (table === 'comparison_candidates' && op === 'insert') return candidateError ? { data: null, error: candidateError } : { data: { id: 'cand-1' }, error: null };
    if (table === 'comparison_candidate_keys' && op === 'insert') return { data: null, error: keyError, returning: opts.returning };
    if (table === 'documents' && op === 'select') return { data: { storage_path: `${BOX}/doc-1/x.md` }, error: null };
    return { data: null, error: null };
  };
  const builder = (table) => {
    const st = { table, op: 'select', payload: null, returning: false, filters: [] };
    const run = () => { const r = result(table, st.op, st.payload, st); ops.push({ ...st, result: r }); return Promise.resolve(r); };
    const b = {
      select() { if (st.op === 'insert') st.returning = true; return b; },
      insert(p) { st.op = 'insert'; st.payload = p; return b; },
      delete() { st.op = 'delete'; return b; },
      eq(c, v) { st.filters.push([c, v]); return b; },
      maybeSingle: run, single: run,
      then(res, rej) { return run().then(res, rej); },
    };
    return b;
  };
  const removed = [];
  return {
    ops, removed,
    from: builder,
    storage: { from: () => ({ remove: async (paths) => { removed.push(...paths); return { error: null }; } }) },
  };
}

function deps(over = {}) {
  const filed = [];
  const recorded = [];
  return {
    filed, recorded,
    userId: USER,
    fileDocument: async (a) => { filed.push(a); return over.fileResult ?? { document_id: 'doc-1', status: 'ready' }; },
    record: async (_sb, o) => { recorded.push(o); return { ok: true }; },
  };
}

const MD = '# Motion\n\nThe Court should exclude Dr. Novak.\n';

test('add: files the next blind label under a blind title and filename, whatever the file was called', async () => {
  const sb = stubClient({ existingLabels: ['A'] });
  const d = deps();
  const out = await addComparisonCandidate(sb, { comparison_id: CMP, filename: 'OPUS-draft-final.md', content: MD, revealed_label: 'Opus 4.8' }, d);
  assert.equal(out.label, 'B');
  assert.equal(d.filed[0].title, 'Candidate B — Novak 702 motion');
  assert.equal(d.filed[0].filename, 'candidate-b-novak-702-motion.md');
  assert.equal(d.filed[0].matter, BOX);
  assert.equal(d.filed[0].doc_type, 'other');
  assert.ok(!JSON.stringify(d.filed).includes('OPUS'), 'the original filename never reaches the Vault');
  assert.equal(out.word_count, 7);
});

test('add: the key is inserted without RETURNING, and the Record never carries the revealed name', async () => {
  const sb = stubClient();
  const d = deps();
  await addComparisonCandidate(sb, { comparison_id: CMP, filename: 'x.md', content: Buffer.from(MD).toString('base64'), encoding: 'base64', revealed_label: 'Muse Spark' }, d);
  const key = sb.ops.find((o) => o.table === 'comparison_candidate_keys');
  assert.equal(key.payload.revealed_label, 'Muse Spark');
  assert.equal(key.returning, false, 'no .select() on the key insert');
  assert.equal(d.recorded.length, 1);
  assert.equal(d.recorded[0].kind, 'comparison.candidate');
  assert.equal(d.recorded[0].matterId, BOX);
  assert.ok(!JSON.stringify(d.recorded).includes('Muse'), 'no revealed name in the Record payload');
  const cand = sb.ops.find((o) => o.table === 'comparison_candidates' && o.op === 'insert');
  assert.equal(cand.payload.source, 'upload');
  assert.equal(cand.payload.model, undefined, 'an upload names no model');
});

test('add: a revealed comparison, a bad file type, a taken label, a duplicate file are refused', async () => {
  await assert.rejects(addComparisonCandidate(stubClient({ revealed: true }), { comparison_id: CMP, filename: 'x.md', content: MD }, deps()), /revealed/);
  await assert.rejects(addComparisonCandidate(stubClient(), { comparison_id: CMP, filename: 'x.exe', content: MD }, deps()), /Markdown, text, PDF or Word/);
  await assert.rejects(addComparisonCandidate(stubClient({ existingLabels: ['A'] }), { comparison_id: CMP, filename: 'x.md', content: MD, label: 'a' }, deps()), /already exists/);
  await assert.rejects(addComparisonCandidate(stubClient(), { comparison_id: 'nope', filename: 'x.md', content: MD }, deps()), /comparison_id/);
  await assert.rejects(addComparisonCandidate(stubClient(), { comparison_id: CMP, filename: 'x.md', content: MD }, deps({ fileResult: { document_id: 'old', already_filed: true, note: 'Already filed.' } })), /own document/);
});

test('add: when the key cannot be filed, the candidate and its document are rolled back', async () => {
  const sb = stubClient({ keyError: { code: '42501', message: 'new row violates row-level security policy' } });
  const d = deps();
  await assert.rejects(addComparisonCandidate(sb, { comparison_id: CMP, filename: 'x.md', content: MD, revealed_label: 'X' }, d), /key:/);
  assert.ok(sb.ops.some((o) => o.table === 'comparison_candidates' && o.op === 'delete'), 'candidate removed');
  assert.ok(sb.ops.some((o) => o.table === 'documents' && o.op === 'delete'), 'document removed');
  assert.deepEqual(sb.removed, [`${BOX}/doc-1/x.md`], 'stored file removed');
  assert.equal(d.recorded.length, 0, 'nothing recorded');
});

test('labels run A…Z then AA; slugs and blind names are filesystem-safe', () => {
  assert.equal(nextLabel([]), 'A');
  assert.equal(nextLabel(['A', 'C']), 'B');
  assert.equal(nextLabel('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')), 'AA');
  assert.equal(slug('Novak — 702 Motion (v2)'), 'novak-702-motion-v2');
  assert.deepEqual(blindNames('C', '  Novak   702 ', '.pdf'), { title: 'Candidate C — Novak 702', filename: 'candidate-c-novak-702.pdf' });
});
