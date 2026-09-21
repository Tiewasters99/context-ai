// A citation SHOWS the page the court reporter printed — and says so when it
// cannot.
//
// What this proves
// ---------------------------------------------------------------------------
// PR #205 taught ingestion to read the number the reporter printed on each
// transcript page and to write it onto `passages.metadata` (`printed_page`,
// `printed_page_end`, `pdf_page`, `page_source`, `printed_page_confidence`,
// `printed_page_method`). Nothing displayed it. This branch wires it into
// every citation path in lib/mcp-core.mjs through one shared rule,
// lib/cite-page.mjs.
//
// The load-bearing assertion is the boring one. **No passage in the corpus
// carries those keys**, and none will until its document is re-indexed — a
// separate, separately approved step. So the first section is a snapshot taken
// from origin/main BEFORE any of this was written, and every citation a
// key-less passage produces must still match it character for character. If
// that section is red, the change is not a no-op and must not ship, whatever
// else passes.
//
// Then the three states, in tier order (docs/TRANSCRIPT_PRINTED_PAGES.md):
//
//   printed              the reporter's own page. Cite it, no caveat — a
//                        caveat beside a good page teaches the reader to
//                        ignore caveats.
//   pdf_index_declined   the detector looked at this page and would not claim
//                        one. Cite the PDF page and print the caveat here, on
//                        this cite, not as a blanket warning.
//   unknown              the detector never ran. Say nothing new.
//
// And the invariant that outranks all of them: A PRINTED PAGE NEVER APPEARS
// BESIDE A CAVEAT.
//
// The extra query
// ---------------------------------------------------------------------------
// The hybrid-search RPC's return type is fixed (migration 002, re-declared in
// 074 and 078, which were just rebuilt against a statement timeout on a 2.5 GB
// index) and cannot carry `metadata`. So search and grep fetch it afterwards,
// for the ids they are returning, in ONE query through the SAME client — same
// RLS, same seal, no service-role shortcut. Asserted here: one query, only the
// returned ids, and — the part that matters at 3 a.m. — when it fails the
// search still answers, with today's citations.
//
//   node scripts/_verify-cite-printed-page.mjs
//
// Offline: a stub client, no network, no .env, no database.

import {
  formatCitation, handleSearch, handleGetPassage, handleGrep,
} from '../lib/mcp-core.mjs';
import {
  citePage, pageBasis, hasPrintedLineNumbers, CITE_PAGE_STATE, PDF_INDEX_CAVEAT,
} from '../lib/cite-page.mjs';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};
const eq = (actual, expected, label) =>
  check(actual === expected, label, actual === expected ? '' : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
/** Same set of ids, in any order — and neither list longer than the other. */
const sameIds = (a, b) => {
  const x = [...new Set(a ?? [])].sort();
  const y = [...new Set(b ?? [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

// ===========================================================================
// 1. THE SNAPSHOT — captured by running origin/main's own formatCitation
//    before a line of this branch was written. A passage carrying none of the
//    new keys must still produce exactly these strings.
// ===========================================================================
console.log('\n--- 1. a passage without the new keys cites exactly as it did ---');

const SNAPSHOT = [
  ['transcript, single page, line range',
    { document_title: 'Blake Dep.', doc_type: 'transcript', page_start: 16, page_end: 16, line_start: 4, line_end: 11 },
    'Blake Dep., 16:4-11'],
  ['transcript, single page, one line',
    { document_title: 'Blake Dep.', doc_type: 'transcript', page_start: 16, page_end: 16, line_start: 4, line_end: 4 },
    'Blake Dep., 16:4'],
  ['transcript, page range, no lines',
    { document_title: 'Blake Dep.', doc_type: 'deposition', page_start: 16, page_end: 18, line_start: null, line_end: null },
    'Blake Dep., 16-18'],
  ['transcript, no lines',
    { document_title: 'Blake Dep.', doc_type: 'transcript', page_start: 16, page_end: 16, line_start: null, line_end: null },
    'Blake Dep., 16'],
  ['prose, single page',
    { document_title: 'Memo', doc_type: 'other', page_start: 3, page_end: 3, line_start: null, line_end: null },
    'Memo, p. 3'],
  ['prose, page range',
    { document_title: 'Memo', doc_type: 'other', page_start: 3, page_end: 5, line_start: null, line_end: null },
    'Memo, p. 3-5'],
  ['book (page_start is the chapter)',
    { document_title: 'Moby-Dick', doc_type: 'book', page_start: 42, page_end: 42, line_start: null, line_end: null },
    'Moby-Dick, Ch. 42'],
];

for (const [label, row, expected] of SNAPSHOT) {
  eq(formatCitation(row), expected, label);
  // The same row with an explicitly empty metadata envelope, and with the
  // line_numbers key #138 already writes, must not move either.
  eq(formatCitation({ ...row, metadata: null }), expected, `${label} · metadata null`);
  eq(formatCitation({ ...row, metadata: {} }), expected, `${label} · metadata {}`);
  eq(formatCitation({ ...row, metadata: { line_numbers: 'inferred' } }), expected, `${label} · line_numbers only`);
}

check(pageBasis(citePage(SNAPSHOT[0][1])) === null,
  'a key-less passage grows no page_basis key at all');

// ===========================================================================
// 2. THE RULE — lib/cite-page.mjs, on its own.
// ===========================================================================
console.log('\n--- 2. the rule: three states, and what each one cites --------');

const printed = citePage({
  page_start: 16, page_end: 16,
  metadata: { printed_page: 15, printed_page_end: 15, pdf_page: 16, page_source: 'printed',
    printed_page_confidence: 'high', printed_page_method: 'sequence_fit' },
});
eq(printed.state, CITE_PAGE_STATE.PRINTED, 'high confidence → printed');
eq(printed.pageStart, 15, 'cites the reporter\'s page, not the PDF\'s');
eq(printed.readerPage, 16, 'the Reader still opens the PDF page');
eq(printed.caveat, null, 'a printed page carries no caveat');

const declined = citePage({
  page_start: 16, page_end: 16,
  metadata: { page_source: 'pdf_index', printed_page_confidence: 'none' },
});
eq(declined.state, CITE_PAGE_STATE.PDF_INDEX_DECLINED, 'the detector declined → pdf_index_declined');
eq(declined.pageStart, 16, 'cites the PDF page it has');
eq(declined.readerPage, 16, 'and opens that same page');
eq(declined.caveat, PDF_INDEX_CAVEAT, 'and carries the caveat');

const unknown = citePage({ page_start: 16, page_end: 16, metadata: { line_numbers: 'inferred' } });
eq(unknown.state, CITE_PAGE_STATE.UNKNOWN, 'no page keys → unknown');
eq(unknown.caveat, null, 'and says nothing new');
eq(citePage({ page_start: 7, page_end: undefined }).pageEnd, undefined,
  'the unknown branch returns page_end exactly as the row holds it');

const range = citePage({
  page_start: 20, page_end: 21,
  metadata: { printed_page: 19, printed_page_end: 20, pdf_page: 20, page_source: 'printed',
    printed_page_confidence: 'high', printed_page_method: 'sequence_fit' },
});
eq(range.pageStart, 19, 'a range cites printed_page…');
eq(range.pageEnd, 20, '…through printed_page_end');

// A condensed 4-up sheet (PR #140): page_start was ALREADY the panel's printed
// page, and what #205 added is the sheet's own PDF page. The cite must not
// move; only the Reader target is new.
const condensed = citePage({
  page_start: 34, page_end: 34,
  metadata: { printed_page: 34, printed_page_end: 34, pdf_page: 9, page_source: 'printed',
    printed_page_confidence: 'high', printed_page_method: 'condensed' },
});
eq(condensed.pageStart, 34, 'a condensed sheet still cites the panel\'s printed page');
eq(condensed.readerPage, 9, 'and opens the PDF sheet it was printed on');
eq(condensed.caveat, null, 'and has nothing to warn about');
eq(formatCitation({ document_title: 'Okonkwo Dep.', doc_type: 'transcript',
  page_start: 34, page_end: 34, line_start: 3, line_end: 9,
  metadata: condensedMeta() }), 'Okonkwo Dep., 34:3-9',
'a condensed-sheet citation is unchanged by this branch');
function condensedMeta() {
  return { printed_page: 34, printed_page_end: 34, pdf_page: 9, page_source: 'printed',
    printed_page_confidence: 'high', printed_page_method: 'condensed' };
}

// The invariant, stated as its own assertion rather than inferred from the
// three above: there is no input for which both are true at once.
const NEVER_BOTH = [
  { printed_page: 15, page_source: 'printed', printed_page_confidence: 'high' },
  { printed_page: 15, page_source: 'pdf_index', printed_page_confidence: 'low' },
  { page_source: 'pdf_index', printed_page_confidence: 'none' },
  { page_source: 'pdf_index' },
  { line_numbers: 'inferred' },
  {},
  null,
];
check(NEVER_BOTH.every((metadata) => {
  const w = citePage({ page_start: 16, page_end: 16, metadata });
  return !(w.state === CITE_PAGE_STATE.PRINTED && w.caveat);
}), 'a printed page NEVER appears beside a caveat');

check(hasPrintedLineNumbers({ line_start: 4, metadata: null }) === true
  && hasPrintedLineNumbers({ line_start: 4, metadata: { line_numbers: 'inferred' } }) === false
  && hasPrintedLineNumbers({ line_start: null }) === false,
'line numbers count as printed only when they were read off the page');

console.log('\n--- 3. what an outside model is handed -----------------------');
eq(formatCitation({ document_title: 'Blake Dep.', doc_type: 'transcript',
  page_start: 16, page_end: 16, line_start: 4, line_end: 11,
  metadata: { printed_page: 15, printed_page_end: 15, pdf_page: 16, page_source: 'printed',
    printed_page_confidence: 'high', printed_page_method: 'sequence_fit' } }),
'Blake Dep., 15:4-11', 'the reporter\'s page, plainly');
eq(formatCitation({ document_title: 'Blake Dep.', doc_type: 'transcript',
  page_start: 16, page_end: 16, line_start: null, line_end: null,
  metadata: { page_source: 'pdf_index', printed_page_confidence: 'none' } }),
`Blake Dep., 16 (${PDF_INDEX_CAVEAT})`, 'or the PDF page, saying in words that it is one');
eq(formatCitation({ document_title: 'Exhibit 12', doc_type: 'exhibit',
  page_start: 4, page_end: 4, line_start: null, line_end: null,
  metadata: { page_source: 'pdf_index', printed_page_confidence: 'low' } }),
`Exhibit 12, p. 4 (${PDF_INDEX_CAVEAT})`, 'the caveat reaches the prose format too');
eq(formatCitation({ document_title: 'Blake Dep.', doc_type: 'transcript',
  page_start: 20, page_end: 21, line_start: null, line_end: null,
  metadata: { printed_page: 19, printed_page_end: 20, pdf_page: 20, page_source: 'printed',
    printed_page_confidence: 'high', printed_page_method: 'sequence_fit' } }),
'Blake Dep., 19-20', 'a passage spanning two pages cites the printed range');

// ===========================================================================
// 4. THE HANDLERS, over a stub client that records every query.
// ===========================================================================
console.log('\n--- 4. the connector paths -----------------------------------');

const MATTER = '11111111-1111-4111-8111-111111111111';
const TX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const HIGH = { printed_page: 15, printed_page_end: 15, pdf_page: 16, page_source: 'printed',
  printed_page_confidence: 'high', printed_page_method: 'sequence_fit' };
const DECLINED = { page_source: 'pdf_index', printed_page_confidence: 'none' };

// Four passages: a transcript page whose printed number was read, the slip
// sheet in the same document that was not, a transcript page indexed before
// the detector existed, and a page of prose.
const PASSAGES = [
  { id: 'p-printed', document_id: TX, matterspace_id: MATTER, sequence_number: 0, summary_level: 0,
    page_start: 16, page_end: 16, line_start: 4, line_end: 11,
    witness_name: null, examination_type: null, speaker: null, parent_passage_id: null,
    passage_type: 'testimony', text: 'Q. Did you sign the Ormsby letter?\nA. I did, on the ninth.',
    metadata: HIGH },
  { id: 'p-declined', document_id: TX, matterspace_id: MATTER, sequence_number: 1, summary_level: 0,
    page_start: 1, page_end: 1, line_start: null, line_end: null,
    witness_name: null, examination_type: null, speaker: null, parent_passage_id: null,
    passage_type: 'body', text: 'EXHIBIT 4 — Ormsby deposition, bound herewith.',
    metadata: DECLINED },
  { id: 'p-legacy', document_id: TX, matterspace_id: MATTER, sequence_number: 2, summary_level: 0,
    page_start: 61, page_end: 61, line_start: 7, line_end: 7,
    witness_name: null, examination_type: null, speaker: null, parent_passage_id: null,
    passage_type: 'testimony', text: 'A. The Ormsby file was closed that spring.',
    metadata: null },
  { id: 'p-prose', document_id: MEMO, matterspace_id: MATTER, sequence_number: 0, summary_level: 0,
    page_start: 3, page_end: 3, line_start: null, line_end: null,
    witness_name: null, examination_type: null, speaker: null, parent_passage_id: null,
    passage_type: 'body', text: 'First line of the memo.\nThe Ormsby letter was never received.',
    metadata: null },
];
const DOCS = [
  { id: TX, matterspace_id: MATTER, title: 'Blake Dep.', doc_type: 'transcript',
    witness_name: null, volume_number: null, page_count: 17 },
  { id: MEMO, matterspace_id: MATTER, title: 'Memo', doc_type: 'other',
    witness_name: null, volume_number: null, page_count: 4 },
];

// `queries` is the witness: every read, with the table and the columns asked
// for. The "one extra query, and only for the returned ids" assertions are
// made against it, not against the answer.
let queries = [];
let metadataQueryFails = null;   // 'error' | 'throw' | null

function makeClient() {
  const tables = { passages: PASSAGES, documents: DOCS, matterspaces: [
    { id: MATTER, parent_matterspace_id: null, ai_tier: 'A', serverspace_id: null,
      short_code: 'vashti', name: 'Vashti v. Ormsby (fiction)', description: null },
  ] };
  return {
    from(table) {
      const state = { filters: [], columns: null };
      const rows = () => {
        let r = (tables[table] ?? []).map((x) => ({ ...x }));
        for (const [col, val, kind] of state.filters) {
          if (kind === 'in') r = r.filter((x) => val.includes(x[col]));
          else if (kind === 'eq') r = r.filter((x) => x[col] === val);
          else if (kind === 'neq') r = r.filter((x) => x[col] !== val);
          else if (kind === 'gte') r = r.filter((x) => x[col] >= val);
          else if (kind === 'lte') r = r.filter((x) => x[col] <= val);
          else if (kind === 'ilike') {
            const n = String(val).replace(/^%|%$/g, '').replace(/\\(.)/g, '$1').toLowerCase();
            r = r.filter((x) => String(x[col] ?? '').toLowerCase().includes(n));
          } else if (kind === 'like') {
            const n = String(val).replace(/^%|%$/g, '').replace(/\\(.)/g, '$1');
            r = r.filter((x) => String(x[col] ?? '').includes(n));
          } else if (kind === 'match' || kind === 'imatch') {
            const re = new RegExp(val, kind === 'imatch' ? 'i' : '');
            r = r.filter((x) => re.test(String(x[col] ?? '')));
          }
        }
        return r;
      };
      const run = () => {
        const ids = state.filters.find(([c, , k]) => c === 'id' && k === 'in')?.[1] ?? null;
        queries.push({ table, columns: state.columns, ids });
        // The failure injection: only the citation-metadata query, which is
        // the one selecting exactly `id, metadata`.
        if (table === 'passages' && state.columns === 'id, metadata') {
          if (metadataQueryFails === 'throw') throw new Error('connection reset');
          if (metadataQueryFails === 'error') return { data: null, error: { message: 'statement timeout', code: '57014' } };
        }
        return { data: rows(), error: null };
      };
      const b = {
        select(cols) { state.columns = cols ?? null; return b; },
        eq(c, v) { state.filters.push([c, v, 'eq']); return b; },
        neq(c, v) { state.filters.push([c, v, 'neq']); return b; },
        in(c, v) { state.filters.push([c, v, 'in']); return b; },
        is() { return b; },
        gte(c, v) { state.filters.push([c, v, 'gte']); return b; },
        lte(c, v) { state.filters.push([c, v, 'lte']); return b; },
        ilike(c, v) { state.filters.push([c, v, 'ilike']); return b; },
        like(c, v) { state.filters.push([c, v, 'like']); return b; },
        filter(c, op, v) { state.filters.push([c, v, op]); return b; },
        order() { return b; },
        limit() { return b; },
        single() { const r = run(); return Promise.resolve(r.error ? r : { data: r.data?.[0] ?? null, error: r.data?.length ? null : { message: 'no rows' } }); },
        maybeSingle() { const r = run(); return Promise.resolve(r.error ? r : { data: r.data?.[0] ?? null, error: null }); },
        then(res, rej) { try { return Promise.resolve(run()).then(res, rej); } catch (e) { return Promise.reject(e).then(res, rej); } },
      };
      return b;
    },
    async rpc(name, params) {
      if (name === 'matterspace_descendants') return { data: [{ id: MATTER }], error: null };
      if (name === 'search_passages') {
        queries.push({ table: 'rpc:search_passages', columns: null, ids: null });
        const q = String(params.p_query_text).toLowerCase();
        // Exactly the columns migration 078 declares — no `metadata`.
        return { data: PASSAGES
          .filter((p) => p.text.toLowerCase().includes(q))
          .slice(0, params.p_limit ?? 5)
          .map((p) => {
            const d = DOCS.find((x) => x.id === p.document_id);
            return {
              passage_id: p.id, document_id: p.document_id, document_title: d.title,
              doc_type: d.doc_type, page_start: p.page_start, page_end: p.page_end,
              line_start: p.line_start, line_end: p.line_end, witness_name: null,
              examination_type: null, passage_type: p.passage_type, text: p.text,
              hybrid_score: 0.5, text_rank: 0.5, vector_score: 0,
            };
          }), error: null };
      }
      throw new Error(`stub: no rpc ${name}`);
    },
  };
}
const supabase = makeClient();
const reset = () => { queries = []; metadataQueryFails = null; };
const metaQueries = () => queries.filter((q) => q.table === 'passages' && q.columns === 'id, metadata');
const byId = (results, id) => results.find((r) => (r.passage_id ?? r.id) === id);

// --- search ---------------------------------------------------------------
reset();
const s = await handleSearch(supabase, { matter: 'vashti', q: 'Ormsby', limit: 10, full_text: true });

eq(byId(s.results, 'p-printed').citation, 'Blake Dep., 15:4-11',
  'search cites the reporter\'s printed page');
eq(byId(s.results, 'p-printed').page_basis.cites, 'printed_page', 'and says which page that is');
eq(byId(s.results, 'p-printed').page_basis.reader_page, 16, 'and hands over the PDF page to open');
eq(byId(s.results, 'p-printed').coordinates.page_start, 16,
  'coordinates still report the column as stored');
eq(byId(s.results, 'p-declined').citation, `Blake Dep., 1 (${PDF_INDEX_CAVEAT})`,
  'search says so where the detector declined');
eq(byId(s.results, 'p-declined').page_basis.cites, 'pdf_page', 'and marks that cite as the PDF\'s');
eq(byId(s.results, 'p-legacy').citation, 'Blake Dep., 61:7',
  'a passage indexed before the detector is cited exactly as it was');
check(byId(s.results, 'p-legacy').page_basis === undefined,
  'and carries no page_basis key at all');
eq(byId(s.results, 'p-prose').citation, 'Memo, p. 3', 'prose is untouched');

eq(metaQueries().length, 1, 'search makes exactly ONE extra query');
eq(sameIds(metaQueries()[0].ids, s.results.map((r) => r.passage_id)), true,
  'and asks for exactly the ids it is returning, no more');
// The ids it asks for are ids the search already returned, through the same
// client, so the seal and RLS have already decided them. And the query reads
// two columns: no passage text leaves on this round trip.
eq(queries.filter((q) => q.table === 'passages' && /text/.test(q.columns ?? '')).length, 0,
  'and the extra query never asks for a word of passage text');

// A search that returns nothing must not ask at all.
reset();
const empty = await handleSearch(supabase, { matter: 'vashti', q: 'zzzznothing' });
eq(empty.result_count, 0, 'a search with no hits returns none');
eq(metaQueries().length, 0, 'and makes no metadata query at all');

// The limit bounds it: the extra query can never be larger than the result set.
reset();
const capped = await handleSearch(supabase, { matter: 'vashti', q: 'Ormsby', limit: 2 });
eq(capped.results.length, 2, 'limit: 2 returns two results');
eq(metaQueries()[0].ids.length, 2, 'and the extra query asks for two ids');

// --- the fallback: the search must survive losing the metadata ------------
for (const mode of ['error', 'throw']) {
  reset();
  metadataQueryFails = mode;
  const degraded = await handleSearch(supabase, { matter: 'vashti', q: 'Ormsby', limit: 10 });
  eq(degraded.result_count, 4, `the metadata query ${mode === 'throw' ? 'throwing' : 'failing'} does not fail the search`);
  eq(byId(degraded.results, 'p-printed').citation, 'Blake Dep., 16:4-11',
    '  …and every citation falls back to today\'s format');
  eq(byId(degraded.results, 'p-declined').citation, 'Blake Dep., 1',
    '  …with no caveat invented from nothing');
  check(degraded.results.every((r) => r.page_basis === undefined),
    '  …and no page_basis on any of them');
}

// --- get_passage ----------------------------------------------------------
reset();
const gp = await handleGetPassage(supabase, { id: 'p-printed' });
eq(gp.passage.citation, 'Blake Dep., 15:4-11', 'get_passage cites the printed page');
eq(gp.passage.page_basis.reader_page, 16, 'and names the PDF page to open');
eq(metaQueries().length, 0,
  'get_passage adds NO extra query — it already names its own columns');

reset();
const gpLegacy = await handleGetPassage(supabase, { id: 'p-legacy' });
eq(gpLegacy.passage.citation, 'Blake Dep., 61:7', 'a legacy passage is cited as it always was');
check(gpLegacy.passage.page_basis === undefined, 'with no new key on it');

reset();
const gpDeclined = await handleGetPassage(supabase, { id: 'p-declined' });
eq(gpDeclined.passage.citation, `Blake Dep., 1 (${PDF_INDEX_CAVEAT})`,
  'and a declined page says so');

// --- grep -----------------------------------------------------------------
console.log('\n--- 5. grep: the citation it was printing was wrong -----------');
reset();
const g = await handleGrep(supabase, { matter: 'vashti', pattern: 'Ormsby' });
const gm = (id) => g.matches.find((m) => m.passage_id === id);

// The bug: `p. 1-undefined:1`. Two faults in one string — page_end was never
// selected, so every page looked like a range ending in `undefined`; and a
// line number was invented for prose, which has none.
check(!g.matches.some((m) => m.citation.includes('undefined')),
  'no grep citation contains the word "undefined"',
  g.matches.map((m) => m.citation).join(' · '));
eq(gm('p-prose').citation, 'Memo, p. 3', 'a hit in prose cites the page and stops there');
eq(gm('p-prose').line, null, 'and reports no line number, because there is none');
eq(gm('p-legacy').citation, 'Blake Dep., 61:7',
  'a hit on a transcript page with real line numbers cites page:line');
eq(gm('p-legacy').line, 7, 'and reports the line');
eq(gm('p-printed').citation, 'Blake Dep., 15:4',
  'a transcript hit cites the reporter\'s page and the line it fell on');
eq(gm('p-declined').citation, `Blake Dep., 1 (${PDF_INDEX_CAVEAT})`,
  'a hit on a page the detector declined says so');
eq(gm('p-declined').line, null, 'and that slip sheet has no lines to report');

eq(metaQueries().length, 1, 'grep makes exactly ONE extra query');
eq(sameIds(metaQueries()[0].ids, g.matches.map((m) => m.passage_id)), true,
  'for the passages that matched, not the 2000 candidates it read');

// A hit on the second line of a passage: the line offset still lands.
reset();
const g2 = await handleGrep(supabase, { matter: 'vashti', pattern: 'I did' });
eq(g2.matches[0].citation, 'Blake Dep., 15:5',
  'a hit on the second line of the passage cites line 5');

// Line numbers the chunker counted by position (PR #138) are not printed line
// numbers, and grep counts newlines on top of them — so the cite stops at the
// page rather than compounding two guesses.
reset();
PASSAGES.push({ id: 'p-inferred', document_id: TX, matterspace_id: MATTER, sequence_number: 3,
  summary_level: 0, page_start: 88, page_end: 88, line_start: 1, line_end: 12,
  witness_name: null, examination_type: null, speaker: null, parent_passage_id: null,
  passage_type: 'testimony', text: 'Q. And the Vashti retainer?\nA. Signed in April.',
  metadata: { line_numbers: 'inferred' } });
const g3 = await handleGrep(supabase, { matter: 'vashti', pattern: 'retainer' });
eq(g3.matches[0].citation, 'Blake Dep., 88',
  'positionally counted line numbers are not cited as page:line');
eq(g3.matches[0].line, null, 'and no line is reported for them');

// grep degrades the same way search does.
reset();
metadataQueryFails = 'error';
const g4 = await handleGrep(supabase, { matter: 'vashti', pattern: 'Ormsby' });
eq(g4.matches.length, 4, 'a failed metadata query does not fail the grep');
eq(g4.matches.find((m) => m.passage_id === 'p-printed').citation, 'Blake Dep., 16:4',
  '  …citations fall back to the PDF page');
eq(g4.matches.find((m) => m.passage_id === 'p-prose').citation, 'Memo, p. 3',
  '  …and the prose fix holds without it, because it needs no metadata');

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed — citations show the printed page, and say so when they cannot.');
