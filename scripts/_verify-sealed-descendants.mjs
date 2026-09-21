// Prove that a SEALED SUB-MATTER inside an OPEN parent is invisible to an
// external connector, and still visible in the app.
//
// What this is
// ---------------------------------------------------------------------------
// `enforceConnectorSeal` (lib/mcp-core.mjs) refuses a sealed matter that a
// connector NAMES, and drops sealed matters from `list_matters` and from the
// all-matters search scope. What it did not do until 2026-09-20 is reach the
// matters a parent EXPANDS to: `search` and `grep` scope a matter to itself +
// every descendant (`matterspace_descendants`, migration 012), and that list
// was used unfiltered. So a sealed child inside an open parent was searched,
// and its passages were returned to the connected model — the one thing the
// seal exists to prevent. docs/strategy/006 §6.1 named this gap; this harness
// is the proof that it is closed and stays closed.
//
// The database underneath is a stub — a chainable object answering the handful
// of supabase-js calls these paths make, over an in-memory fixture of a
// fictional dispute. No network, no .env, no client data, nothing deployed.
//
// THE WITNESS IS THE QUERY, NOT THE RESULT. Every read that could carry a
// matter's own words — `search_passages`, and any select on `passages` or
// `documents` keyed by matterspace_id — is recorded with the matter ids it
// asked for. A fix that filtered the RESULTS would still have sent the sealed
// child's id to Postgres; the assertions below are that the id never appears
// in a content query at all.
//
// The two halves that must both hold:
//   * connector path (opts.sealConnector) — the sealed child is not searched;
//   * in-app path (no flag) — the sealed child IS searched. Inside
//     Contextspaces a member searching a parent legitimately sees its sealed
//     children; the seal is about what leaves to an outside model, and a fix
//     that hid them from their own lawyer would be a different bug.
//
//   node scripts/_verify-sealed-descendants.mjs
//
// Exit 0 = the sealed child never left.

import { callTool } from '../lib/mcp-core.mjs';
import { ROUTES } from '../lib/embed-routes.mjs';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

// Tier A embeds through the OpenAI route and Tier B through the SageMaker one.
// Both are answered by the stubbed fetch below; any real credentials on this
// machine must not join in, or the harness would reach a live endpoint.
for (const k of [
  'OPENAI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN', 'AWS_REGION', 'SAGEMAKER_VOYAGE_ENDPOINT',
]) delete process.env[k];

const EMBED_DIM = ROUTES['openai-3-small'].dim;
const realFetch = globalThis.fetch;
let outbound = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  outbound.push(new URL(url).hostname);
  if (url.includes('api.openai.com/v1/embeddings')) {
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(JSON.stringify({
      data: inputs.map(() => ({ embedding: Array(EMBED_DIM).fill(0.01) })),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`unexpected outbound call to ${url}`);
};

// ---------------------------------------------------------------------------
// The fixture. One open parent holding one open child and one sealed child,
// plus an unrelated matter so "search everywhere" has somewhere else to look.
//
// The sealed child carries ai_tier 'B' on its own row — that is what
// sealedMatterIds() reads. Its PARENT is Tier A: this is the shape the gap was
// about, a sealed room inside an open building.
// ---------------------------------------------------------------------------
const PARENT = '11111111-1111-4111-8111-111111111111';
const OPEN_CHILD = '22222222-2222-4222-8222-222222222222';
const SEALED_CHILD = '33333333-3333-4333-8333-333333333333';
const ELSEWHERE = '44444444-4444-4444-8444-444444444444';

const SPACE = '99999999-9999-4999-8999-999999999999';

const db = {
  serverspaces: [{ id: SPACE, name: 'Litigation' }],
  matterspaces: [
    { id: PARENT, parent_matterspace_id: null, ai_tier: 'A', serverspace_id: SPACE,
      short_code: 'vashti', name: 'Vashti v. Ormsby (fiction)', description: null },
    { id: OPEN_CHILD, parent_matterspace_id: PARENT, ai_tier: 'A', serverspace_id: SPACE,
      short_code: 'vashti-pleadings', name: 'Vashti — Pleadings', description: null },
    { id: SEALED_CHILD, parent_matterspace_id: PARENT, ai_tier: 'B', serverspace_id: SPACE,
      short_code: 'vashti-privileged', name: 'Vashti — Privileged', description: null },
    { id: ELSEWHERE, parent_matterspace_id: null, ai_tier: 'A', serverspace_id: SPACE,
      short_code: 'reading', name: 'Public Domain Reading', description: null },
  ],
  documents: [],
  passages: [],
};

const DOC = {
  [PARENT]: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  [OPEN_CHILD]: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  [SEALED_CHILD]: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  [ELSEWHERE]: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
};
const TEXT = {
  [PARENT]: 'Ormsby was served on the ninth of March, per the docket.',
  [OPEN_CHILD]: 'The answer denies that Ormsby ever received the letter.',
  [SEALED_CHILD]: 'PRIVILEGED: our view is that Ormsby will settle by June.',
  [ELSEWHERE]: 'Ormsby is also a minor character in an unrelated novel.',
};
let seq = 0;
for (const m of [PARENT, OPEN_CHILD, SEALED_CHILD, ELSEWHERE]) {
  db.documents.push({
    id: DOC[m], matterspace_id: m, title: `Memo (${m.slice(0, 4)})`, doc_type: 'other',
    witness_name: null, volume_number: null, processing_status: 'ready',
    source_filename: 'memo.txt', created_at: '2026-09-01', page_count: 1,
  });
  db.passages.push({
    id: `eeeeeeee-eeee-4eee-8eee-00000000000${++seq}`,
    document_id: DOC[m], matterspace_id: m, sequence_number: seq, summary_level: 0,
    page_start: 1, page_end: 1, line_start: 1, line_end: 4, text: TEXT[m],
    passage_type: 'body', witness_name: null, examination_type: null,
    speaker: null, parent_passage_id: null,
  });
}

// ---------------------------------------------------------------------------
// The stub client, and the query log.
//
// `contentQueries` holds only the reads that can carry a matter's own words.
// The seal's OWN lookups mention the sealed id by design (sealedMatterIds asks
// for its descendants), so a blanket "the id is never mentioned" assertion
// would be false for a correct implementation. The question that matters is
// narrower and sharper: was the sealed matter ever asked for its CONTENT.
// ---------------------------------------------------------------------------
const contentQueries = [];
const noteContent = (what, ids) => {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (list.length) contentQueries.push({ what, ids: list });
};
const contentScope = () => new Set(contentQueries.flatMap((q) => q.ids));

function makeClient() {
  const rowsOf = (t) => db[t] ?? (() => { throw new Error(`stub: no table ${t}`); })();
  return {
    from(table) {
      const state = { table, filters: [], count: false, head: false };
      const apply = () => {
        let rows = rowsOf(state.table);
        for (const [col, val, kind] of state.filters) {
          if (kind === 'in') rows = rows.filter((r) => val.includes(r[col]));
          else if (kind === 'eq') rows = rows.filter((r) => r[col] === val);
          else if (kind === 'neq') rows = rows.filter((r) => r[col] !== val);
          else if (kind === 'is') rows = rows.filter((r) => r[col] === val);
          else if (kind === 'gte') rows = rows.filter((r) => r[col] >= val);
          else if (kind === 'lte') rows = rows.filter((r) => r[col] <= val);
          else if (kind === 'ilike') {
            const needle = String(val).replace(/^%|%$/g, '').replace(/\\(.)/g, '$1').toLowerCase();
            rows = rows.filter((r) => String(r[col] ?? '').toLowerCase().includes(needle));
          } else if (kind === 'like') {
            const needle = String(val).replace(/^%|%$/g, '').replace(/\\(.)/g, '$1');
            rows = rows.filter((r) => String(r[col] ?? '').includes(needle));
          } else if (kind === 'match' || kind === 'imatch') {
            const re = new RegExp(val, kind === 'imatch' ? 'i' : '');
            rows = rows.filter((r) => re.test(String(r[col] ?? '')));
          } else throw new Error(`stub: no filter kind ${kind}`);
        }
        return rows;
      };
      const run = () => {
        // Record the content reads before answering them.
        if (state.table === 'passages' || state.table === 'documents') {
          for (const [col, val, kind] of state.filters) {
            if (col !== 'matterspace_id') continue;
            noteContent(`${state.table}.${kind}(matterspace_id)`, val);
          }
        }
        const rows = apply();
        return state.head
          ? { data: null, count: rows.length, error: null }
          : { data: rows, count: state.count ? rows.length : null, error: null };
      };
      const builder = {
        select(_cols, opts = {}) {
          state.count = Boolean(opts.count);
          state.head = Boolean(opts.head);
          return builder;
        },
        eq(col, val) { state.filters.push([col, val, 'eq']); return builder; },
        neq(col, val) { state.filters.push([col, val, 'neq']); return builder; },
        in(col, vals) { state.filters.push([col, vals, 'in']); return builder; },
        is(col, val) { state.filters.push([col, val, 'is']); return builder; },
        gte(col, val) { state.filters.push([col, val, 'gte']); return builder; },
        lte(col, val) { state.filters.push([col, val, 'lte']); return builder; },
        ilike(col, val) { state.filters.push([col, val, 'ilike']); return builder; },
        like(col, val) { state.filters.push([col, val, 'like']); return builder; },
        filter(col, op, val) { state.filters.push([col, val, op]); return builder; },
        order() { return builder; },
        limit() { return builder; },
        single() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: null }); },
        maybeSingle() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: null }); },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return builder;
    },
    async rpc(name, params) {
      if (name === 'matterspace_descendants') {
        const out = [];
        const queue = [params.p_root];
        while (queue.length) {
          const id = queue.shift();
          out.push({ id });
          for (const m of db.matterspaces) {
            if (m.parent_matterspace_id === id) queue.push(m.id);
          }
        }
        return { data: out, error: null };
      }
      if (name === 'search_passages') {
        noteContent('rpc search_passages(p_matterspace_ids)', params.p_matterspace_ids);
        const scope = new Set(params.p_matterspace_ids);
        const q = String(params.p_query_text).toLowerCase();
        const hits = db.passages
          .filter((p) => scope.has(p.matterspace_id))
          .filter((p) => p.text.toLowerCase().includes(q))
          .slice(0, params.p_limit ?? 5)
          .map((p) => ({
            passage_id: p.id, document_id: p.document_id,
            document_title: 'Memo', doc_type: 'other',
            page_start: p.page_start, page_end: p.page_end,
            line_start: p.line_start, line_end: p.line_end,
            witness_name: null, examination_type: null, passage_type: p.passage_type,
            text: p.text, hybrid_score: 0.5, text_rank: 0.5, vector_score: 0,
          }));
        return { data: hits, error: null };
      }
      throw new Error(`stub: no rpc ${name}`);
    },
  };
}
const supabase = makeClient();

const reset = () => { contentQueries.length = 0; outbound = []; };
const CONNECTOR = { sealConnector: true, openaiApiKey: 'sk-test' };
const IN_APP = { openaiApiKey: 'sk-test' };
const textOf = (r) => JSON.stringify(r);

// ---------------------------------------------------------------------------
// 1. Connector search scoped to the OPEN PARENT.
// ---------------------------------------------------------------------------
console.log('\n--- connector: search scoped to the open parent -----------------');
reset();
const cSearch = await callTool(supabase, 'search', { matter: 'vashti', q: 'Ormsby' }, CONNECTOR);

check(!contentScope().has(SEALED_CHILD),
  'the sealed child id was never asked for its content',
  contentQueries.filter((q) => q.ids.includes(SEALED_CHILD)).map((q) => q.what).join('; ') || 'no such query');
check(contentScope().has(PARENT) && contentScope().has(OPEN_CHILD),
  'the parent and the OPEN child were searched');
check(!textOf(cSearch).includes('PRIVILEGED'),
  'no sealed passage text came back');
check(!textOf(cSearch).includes(DOC[SEALED_CHILD]),
  'no sealed document id came back');
check(cSearch.result_count === 2,
  'exactly the parent + open child hits came back', `n=${cSearch.result_count}`);
check(!contentScope().has(ELSEWHERE), 'and the scope did not widen past the tree');

// ---------------------------------------------------------------------------
// 2. Connector grep scoped to the OPEN PARENT.
// ---------------------------------------------------------------------------
console.log('\n--- connector: grep scoped to the open parent -------------------');
reset();
const cGrep = await callTool(supabase, 'grep', { matter: 'vashti', pattern: 'Ormsby' }, CONNECTOR);

check(!contentScope().has(SEALED_CHILD),
  'grep never asked the sealed child for its content',
  contentQueries.filter((q) => q.ids.includes(SEALED_CHILD)).map((q) => q.what).join('; ') || 'no such query');
check(contentScope().has(PARENT) && contentScope().has(OPEN_CHILD),
  'grep did read the parent and the open child');
check(!textOf(cGrep).includes('PRIVILEGED'), 'no sealed passage text came back');
check(cGrep.match_count === 2, 'exactly two matches — parent and open child',
  `n=${cGrep.match_count}`);

// ---------------------------------------------------------------------------
// 3. Connector search with matter OMITTED (the all-matters scope). This branch
//    has always filtered; the assertion is a regression guard, and it is what
//    makes the pair of them a complete statement about `search`.
// ---------------------------------------------------------------------------
console.log('\n--- connector: search with no matter (everywhere) ---------------');
reset();
const cAll = await callTool(supabase, 'search', { q: 'Ormsby' }, CONNECTOR);
check(!contentScope().has(SEALED_CHILD),
  'an everywhere-search never asked the sealed child for its content');
check(!textOf(cAll).includes('PRIVILEGED'), 'no sealed passage text came back');
check(cAll.result_count === 3, 'the three unsealed matters answered', `n=${cAll.result_count}`);

// ---------------------------------------------------------------------------
// 4. The sealed child NAMED directly: refused, as it always was.
// ---------------------------------------------------------------------------
console.log('\n--- connector: the sealed child named directly ------------------');
reset();
let named = null;
try {
  await callTool(supabase, 'search', { matter: 'vashti-privileged', q: 'Ormsby' }, CONNECTOR);
} catch (err) { named = err; }
check(named?.code === 'sealed_matter', 'naming the sealed matter is refused',
  named?.code ?? 'no error thrown');
check(!contentScope().has(SEALED_CHILD), 'and nothing was read from it');

// ---------------------------------------------------------------------------
// 5. list_matters and list_matter_contents: the sealed child is invisible, and
//    listing the parent does not walk into it.
// ---------------------------------------------------------------------------
console.log('\n--- connector: listings ----------------------------------------');
reset();
// The DEFAULT shape since 2026-09-20 is a compact tree — text, not rows — so
// the seal can no longer be a filter over an array on the way out: the handler
// prunes the hidden ids and everything under them BEFORE it counts a single
// document. Both halves are asserted here: the sealed child is not in the map,
// and its id never reached a `documents` query either.
const tree = await callTool(supabase, 'list_matters', {}, CONNECTOR);
check(typeof tree?.tree === 'string', 'list_matters answers with a tree', typeof tree?.tree);
check(!tree.tree.includes(SEALED_CHILD), 'list_matters omits the sealed child');
check(!tree.tree.includes('Privileged'), 'and does not name it either');
check(tree.tree.includes(OPEN_CHILD), 'and still shows the open one');
check(tree.tree.includes(PARENT), 'under their open parent');
check(!contentScope().has(SEALED_CHILD),
  'the sealed child was never asked how many documents it holds',
  contentQueries.filter((q) => q.ids.includes(SEALED_CHILD)).map((q) => q.what).join('; ') || 'no such query');
check(tree.matter_count === 3, 'three matters are visible to the connector', `n=${tree.matter_count}`);

// The same seal, asked of the `format:'full'` escape hatch that existing
// callers use.
reset();
const listed = await callTool(supabase, 'list_matters', { format: 'full' }, CONNECTOR);
check(!listed.some((m) => m.id === SEALED_CHILD), 'format:"full" omits the sealed child too');
check(listed.some((m) => m.id === OPEN_CHILD), 'and still shows the open one');

// NEGATIVE CONTROL for the two assertions above: with no connector seal the
// sealed child IS on the map and IS counted. If this ever goes quiet, the
// assertions above have stopped proving anything.
reset();
const inAppTree = await callTool(supabase, 'list_matters', {}, IN_APP);
check(inAppTree.tree.includes(SEALED_CHILD), 'in-app, the sealed child is on the map');
check(contentScope().has(SEALED_CHILD), 'and it was counted like any other matter');

reset();
const contents = await callTool(supabase, 'list_matter_contents', { matter: 'vashti' }, CONNECTOR);
check(!contentScope().has(SEALED_CHILD),
  'list_matter_contents on the parent never reads the sealed child');
check(contents.document_count === 1,
  'it lists the parent\'s own documents only — it does not expand the tree',
  `n=${contents.document_count}`);

// ---------------------------------------------------------------------------
// 6. THE IN-APP PATH. No sealConnector flag: a member searching the parent
//    inside Contextspaces still sees the sealed child. If this section ever
//    goes green by hiding it, the fix has broken the product.
// ---------------------------------------------------------------------------
console.log('\n--- in-app: the same search, with no connector seal -------------');
reset();
const aSearch = await callTool(supabase, 'search', { matter: 'vashti', q: 'Ormsby' }, IN_APP);
check(contentScope().has(SEALED_CHILD),
  'the in-app search DOES read the sealed child — the seal is about egress');
check(textOf(aSearch).includes('PRIVILEGED'), 'and returns its passage to the member');
check(aSearch.result_count === 3, 'all three matters in the tree answered',
  `n=${aSearch.result_count}`);

reset();
const aGrep = await callTool(supabase, 'grep', { matter: 'vashti', pattern: 'Ormsby' }, IN_APP);
check(contentScope().has(SEALED_CHILD), 'the in-app grep DOES read the sealed child');
check(aGrep.match_count === 3, 'all three matches returned in-app', `n=${aGrep.match_count}`);

// ---------------------------------------------------------------------------
// 7. Egress control: the sealed group is never embedded at a provider, and the
//    unsealed group still is. Proves the harness is wired to a real search.
// ---------------------------------------------------------------------------
console.log('\n--- egress -----------------------------------------------------');
reset();
await callTool(supabase, 'search', { matter: 'vashti', q: 'Ormsby' }, CONNECTOR);
check(outbound.includes('api.openai.com'),
  'the unsealed scope still embedded its query', `calls=[${outbound.join(', ')}]`);
check(!outbound.some((h) => h.includes('sagemaker')),
  'and nothing was embedded on the sealed route');

// ---------------------------------------------------------------------------
globalThis.fetch = realFetch;
console.log(`\n${failures === 0
  ? 'SEALED — no sealed descendant was searched, and the app still sees it.'
  : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
