// Agent connections (migration 085): an agent sees ONLY the matters it was
// granted, never a sealed one, and works a task board — and a user token is
// exactly what it was.
//
// What this proves, offline
// ---------------------------------------------------------------------------
//   A3  scope — through the real callTool, over a stub supabase client (the
//       one scripts/_verify-sealed-descendants.mjs uses, with writes added):
//         * an agent granted [A] sees A and A's open child; never B, never
//           A's SEALED child, never anything on the all-matters search;
//         * an agent granted only a SUB-matter sees that sub-matter (its
//           parent is not granted and must not take it down with it);
//         * an agent granted a sealed matter sees nothing — the seal wins;
//         * an agent with scope '{}' sees nothing, and every content tool
//           refuses or returns empty;
//         * refusals are typed (code 'agent_scope') and never name the
//           matter; documents, passages, edit_pdf inserts, search
//           document_ids are all checked; create_matter at top level and
//           send_to_sandbox are refused; the AI pause still applies;
//         * every agent call is recorded as that agent (actor ref).
//   B6  the task tools — my_tasks / claim_task / ask_human / post_result:
//         * only the calling token's tasks, only in visible matters;
//         * attachments resolved (in scope) or withheld (out of scope);
//         * the claim → ask → answer → result loop, each step logged in
//         agent_task_events with the token id;
//         * result_refs outside the grant are refused.
//   AUTH  lib/connector-token-auth.mjs + api/mcp.mjs authenticate():
//         * a pre-085 row (no `kind` column) is a user token;
//         * an agent row carries its scope; path A reads with select('*');
//         * /api/ext refuses agent tokens (403 agent_token_not_allowed);
//         * a user token's callTool options are byte-for-byte the old ones.
//
// THE WITNESS IS THE QUERY, NOT ONLY THE RESULT: every read that could carry
// a matter's own words is logged with the matter ids it asked for.
//
//   node scripts/_test-agent-scope.mjs
//
// No network, no .env, no client data. Exit 0 = every check passed.

import { createHash } from 'node:crypto';

// Env for the two auth modules, set BEFORE they are imported (both read it at
// module load). Nothing here is real; the stubbed fetch answers everything.
process.env.VITE_SUPABASE_URL = 'http://stub.supabase.local';
process.env.VITE_SUPABASE_ANON_KEY = 'anon-stub';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-stub';
for (const k of [
  'OPENAI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN', 'AWS_REGION', 'SAGEMAKER_VOYAGE_ENDPOINT', 'MCP_OAUTH_SECRET',
]) delete process.env[k];

const { callTool, TOOLS, AGENT_TOOLS_ONLY_MESSAGE } = await import('../lib/mcp-core.mjs');
const { ROUTES } = await import('../lib/embed-routes.mjs');
const { connectorTokenIdentity, authenticateConnectorToken } = await import('../lib/connector-token-auth.mjs');
const { authenticate, callToolOptsFor } = await import('../api/mcp.mjs');

let failures = 0;
let passes = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (ok) passes += 1; else failures += 1;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 62 - t.length))}`);

// ---------------------------------------------------------------------------
// Outbound: embeddings (search) and the PostgREST calls the auth modules make.
// ---------------------------------------------------------------------------
const EMBED_DIM = ROUTES['openai-3-small'].dim;
const tokenRows = new Map();   // token_hash -> connector_tokens row
const authRequests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.includes('api.openai.com/v1/embeddings')) {
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(JSON.stringify({
      data: inputs.map(() => ({ embedding: Array(EMBED_DIM).fill(0.01) })),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.startsWith('http://stub.supabase.local/rest/v1/connector_tokens')) {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    authRequests.push({ method, select: u.searchParams.get('select') });
    if (method !== 'GET') return new Response(null, { status: 204 });
    const hash = (u.searchParams.get('token_hash') || '').replace(/^eq\./, '');
    const row = tokenRows.get(hash);
    const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers) : (init.headers || {});
    const accept = String(headers.Accept || headers.accept || '');
    const body = accept.includes('vnd.pgrst.object') ? (row ?? null) : (row ? [row] : []);
    if (accept.includes('vnd.pgrst.object') && !row) {
      return new Response(JSON.stringify({ code: 'PGRST116', message: 'no rows' }), {
        status: 406, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`unexpected outbound call to ${url}`);
};

// ---------------------------------------------------------------------------
// The fixture. Fictional throughout.
// ---------------------------------------------------------------------------
const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = id(1);
const SPACE = id(2);
const A = id(10);             // granted
const A_CHILD = id(11);       // open child of A — inherits the grant
const A_SEALED = id(12);      // sealed child of A — never, grant or not
const B = id(20);             // not granted
const C = id(30);             // parent of a granted sub-matter, itself NOT granted
const C_CHILD = id(31);       // granted on its own

const AG_A = id(100);         // scope [A]
const AG_EMPTY = id(101);     // scope []
const AG_CHILD = id(102);     // scope [C_CHILD]
const AG_SEALED = id(103);    // scope [A_SEALED]
const AG_OTHER = id(104);     // someone else's agent (same user, different token)

const NAMES = {
  [A]: 'Vashti v. Ormsby (fiction)', [A_CHILD]: 'Vashti — Pleadings',
  [A_SEALED]: 'Vashti — Privileged', [B]: 'Brannock Estate (fiction)',
  [C]: 'Corvel Holdings (fiction)', [C_CHILD]: 'Corvel — Discovery',
};
const CODES = {
  [A]: 'vashti', [A_CHILD]: 'vashti-pleadings', [A_SEALED]: 'vashti-privileged',
  [B]: 'brannock', [C]: 'corvel', [C_CHILD]: 'corvel-discovery',
};
const PARENT = { [A_CHILD]: A, [A_SEALED]: A, [C_CHILD]: C };
const TIER = { [A_SEALED]: 'B' };
const MATTERS = [A, A_CHILD, A_SEALED, B, C, C_CHILD];

const DOC = {};
const PASSAGE = {};
const TEXT = {
  [A]: 'Ormsby was served on the ninth of March.',
  [A_CHILD]: 'The answer denies that Ormsby received the letter.',
  [A_SEALED]: 'PRIVILEGED: Ormsby will settle by June.',
  [B]: 'BRANNOCK-ONLY: the Ormsby codicil was witnessed twice.',
  [C]: 'CORVEL-PARENT: Ormsby sat on the board.',
  [C_CHILD]: 'Ormsby produced 400 pages in discovery.',
};

const db = {
  serverspaces: [{ id: SPACE, name: 'Litigation' }],
  matterspaces: MATTERS.map((m) => ({
    id: m, parent_matterspace_id: PARENT[m] ?? null, ai_tier: TIER[m] ?? 'A', ai_paused: false,
    serverspace_id: SPACE, short_code: CODES[m], name: NAMES[m], description: null,
    created_at: '2026-09-01',
  })),
  documents: [],
  passages: [],
  content_items: [],
  calendar_events: [],
  agent_tasks: [],
  agent_task_events: [],
};
MATTERS.forEach((m, i) => {
  DOC[m] = id(200 + i);
  PASSAGE[m] = id(300 + i);
  db.documents.push({
    id: DOC[m], matterspace_id: m, title: `Memo ${CODES[m]}`, doc_type: 'other',
    witness_name: null, volume_number: null, processing_status: 'ready',
    source_filename: 'memo.txt', created_at: '2026-09-01', page_count: 1,
  });
  db.passages.push({
    id: PASSAGE[m], document_id: DOC[m], matterspace_id: m, sequence_number: i + 1, summary_level: 0,
    page_start: 1, page_end: 1, line_start: 1, line_end: 4, text: TEXT[m],
    passage_type: 'body', witness_name: null, examination_type: null, speaker: null, parent_passage_id: null,
  });
});
const PAGE_A = id(400);
const PAGE_B = id(401);
db.content_items.push(
  { id: PAGE_A, title: 'Deposition checklist', content_type: 'list', space_id: A, space_type: 'matterspace',
    content: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Confirm the court reporter.' }] },
      { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'text', text: 'Serve the notice.' }] },
    ] } },
  { id: PAGE_B, title: 'Brannock strategy', content_type: 'page', space_id: B, space_type: 'matterspace',
    content: { type: 'doc', content: [{ type: 'text', text: 'BRANNOCK-PAGE secret plan' }] } },
);
const EVENT_A = id(500);
db.calendar_events.push({
  id: EVENT_A, title: 'Hearing on the motion', notes: 'Courtroom 14A', location: 'SDNY',
  start_date: '2026-10-02', start_time: '10:00', end_date: null, end_time: null,
  event_type: 'hearing', matterspace_id: A,
});

const T_OPEN = id(600);       // AG_A, matter A — the one that should show
const T_IN_B = id(601);       // AG_A, matter B — the grant no longer covers it
const T_OTHER = id(602);      // AG_OTHER, matter A — not this agent's
const T_SEALED = id(603);     // AG_A, the sealed child
const T_FAIL = id(604);       // AG_A, matter A_CHILD — will be failed
const T_DONE = id(605);       // AG_A, matter A — already done
const task = (tid, matter, token, extra = {}) => ({
  id: tid, matterspace_id: matter, created_by: USER, assigned_token_id: token,
  title: `Task ${tid.slice(-3)}`, instructions: 'Summarise the service history.',
  attachments: [], due_at: null, status: 'open', question: null, answer: null,
  result: null, result_refs: [], claimed_at: null, completed_at: null,
  created_at: `2026-09-2${tid.slice(-1)}T00:00:00Z`, updated_at: null, ...extra,
});
db.agent_tasks.push(
  task(T_OPEN, A, AG_A, {
    attachments: [
      { kind: 'document', id: DOC[A], label: 'Service memo' },
      { kind: 'document', id: DOC[B], label: 'BRANNOCK-LABEL memo' },
      { kind: 'content_item', id: PAGE_A, label: 'Checklist' },
      { kind: 'content_item', id: PAGE_B, label: 'BRANNOCK-LABEL page' },
      { kind: 'calendar_event', id: EVENT_A },
      { kind: 'document', id: DOC[A_SEALED], label: 'PRIVILEGED-LABEL' },
    ],
  }),
  task(T_IN_B, B, AG_A, { title: 'BRANNOCK-TASK' }),
  task(T_OTHER, A, AG_OTHER, { title: 'OTHER-AGENT-TASK' }),
  task(T_SEALED, A_SEALED, AG_A, { title: 'SEALED-TASK' }),
  task(T_FAIL, A_CHILD, AG_A),
  task(T_DONE, A, AG_A, { status: 'done', result: 'Filed.', completed_at: '2026-09-22T00:00:00Z' }),
);

// ---------------------------------------------------------------------------
// The stub client (after _verify-sealed-descendants.mjs), with writes.
// ---------------------------------------------------------------------------
const contentQueries = [];
const taskQueries = [];
const ledger = [];
const noteContent = (what, ids) => {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (list.length) contentQueries.push({ what, ids: list });
};
const contentScope = () => new Set(contentQueries.flatMap((q) => q.ids));
const matterIdOfDoc = new Map(db.documents.map((d) => [d.id, d.matterspace_id]));
const matterIdOfPassage = new Map(db.passages.map((p) => [p.id, p.matterspace_id]));

function makeClient() {
  const rowsOf = (t) => db[t] ?? (() => { throw new Error(`stub: no table ${t}`); })();
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    from(table) {
      const state = { table, filters: [], count: false, head: false, op: 'select', patch: null, orders: [] };
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
        for (const [col, asc] of [...state.orders].reverse()) {
          rows = [...rows].sort((x, y) => (String(x[col] ?? '') < String(y[col] ?? '') ? -1 : String(x[col] ?? '') > String(y[col] ?? '') ? 1 : 0) * (asc ? 1 : -1));
        }
        return rows;
      };
      const run = () => {
        if (state.table === 'passages' || state.table === 'documents') {
          for (const [col, val, kind] of state.filters) {
            if (col === 'matterspace_id') noteContent(`${state.table}.${kind}(matterspace_id)`, val);
            if (col === 'id' && state.table === 'documents') {
              const ids = (Array.isArray(val) ? val : [val]).map((d) => matterIdOfDoc.get(d)).filter(Boolean);
              noteContent('documents.id→matter', ids);
            }
            if (col === 'id' && state.table === 'passages') {
              const ids = (Array.isArray(val) ? val : [val]).map((p) => matterIdOfPassage.get(p)).filter(Boolean);
              noteContent('passages.id→matter', ids);
            }
          }
        }
        if (state.table === 'agent_tasks' || state.table === 'agent_task_events') {
          taskQueries.push({ table: state.table, op: state.op });
        }
        if (state.op === 'insert') {
          const rows = (Array.isArray(state.patch) ? state.patch : [state.patch])
            .map((r) => ({ id: r.id ?? id(9000 + rowsOf(state.table).length), at: new Date().toISOString(), ...r }));
          rowsOf(state.table).push(...rows);
          return { data: rows, error: null };
        }
        const rows = apply();
        if (state.op === 'update') {
          for (const r of rows) Object.assign(r, state.patch, { updated_at: new Date().toISOString() });
        }
        return state.head
          ? { data: null, count: rows.length, error: null }
          : { data: rows.map((r) => ({ ...r })), count: state.count ? rows.length : null, error: null };
      };
      const builder = {
        select(_cols, opts = {}) {
          state.count = Boolean(opts.count);
          state.head = Boolean(opts.head);
          return builder;
        },
        insert(row) { state.op = 'insert'; state.patch = row; return builder; },
        update(patch) { state.op = 'update'; state.patch = patch; return builder; },
        eq(col, val) { state.filters.push([col, val, 'eq']); return builder; },
        neq(col, val) { state.filters.push([col, val, 'neq']); return builder; },
        in(col, vals) { state.filters.push([col, vals, 'in']); return builder; },
        is(col, val) { state.filters.push([col, val, 'is']); return builder; },
        gte(col, val) { state.filters.push([col, val, 'gte']); return builder; },
        lte(col, val) { state.filters.push([col, val, 'lte']); return builder; },
        ilike(col, val) { state.filters.push([col, val, 'ilike']); return builder; },
        textSearch() { return builder; },
        range() { return builder; },
        like(col, val) { state.filters.push([col, val, 'like']); return builder; },
        filter(col, op, val) { state.filters.push([col, val, op]); return builder; },
        order(col, o = {}) { state.orders.push([col, o.ascending !== false]); return builder; },
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
          const cur = queue.shift();
          if (!db.matterspaces.some((m) => m.id === cur)) continue;
          out.push({ id: cur });
          for (const m of db.matterspaces) if (m.parent_matterspace_id === cur) queue.push(m.id);
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
          .slice(0, params.p_limit ?? 10)
          .map((p) => ({
            passage_id: p.id, document_id: p.document_id, document_title: 'Memo', doc_type: 'other',
            page_start: p.page_start, page_end: p.page_end, line_start: p.line_start, line_end: p.line_end,
            witness_name: null, examination_type: null, passage_type: p.passage_type,
            text: p.text, hybrid_score: 0.5, text_rank: 0.5, vector_score: 0,
          }));
        return { data: hits, error: null };
      }
      if (name === 'ledger_append' || name === 'ledger_append_account') {
        ledger.push({ rpc: name, ...params });
        return { data: [{ id: 'evt', seq: ledger.length, hash: 'h' }], error: null };
      }
      return { data: null, error: { message: `stub: no rpc ${name}` } };
    },
  };
}
const supabase = makeClient();

const reset = () => { contentQueries.length = 0; taskQueries.length = 0; ledger.length = 0; };
const SCOPES = {
  [AG_A]: [A], [AG_EMPTY]: [], [AG_CHILD]: [C_CHILD], [AG_SEALED]: [A_SEALED], [AG_OTHER]: [A],
};
const USER_OPTS = callToolOptsFor({ kind: 'user', userId: USER }, { openaiApiKey: 'sk-test' });
const agentOpts = (tok) => callToolOptsFor(
  { kind: 'agent', userId: USER, tokenId: tok, matterScope: SCOPES[tok], provider: 'grok', name: 'Grok bot' },
  { openaiApiKey: 'sk-test' },
);
const call = async (tool, args, opts) => {
  try { return { ok: true, out: await callTool(supabase, tool, args, opts) }; }
  catch (err) { return { ok: false, err }; }
};
const text = (r) => JSON.stringify(r?.out ?? r?.err?.message ?? r);
const refusedScope = (r) => !r.ok && r.err?.code === 'agent_scope';
const onlyIn = (allowed) => [...contentScope()].every((m) => allowed.includes(m));
const LEAK_MARKERS = ['PRIVILEGED', 'BRANNOCK', 'CORVEL-PARENT'];
const leaks = (r) => LEAK_MARKERS.filter((s) => text(r).includes(s));

// ===========================================================================
section('A3 — an agent granted [A]');
// ===========================================================================
reset();
{
  const r = await call('list_matters', {}, agentOpts(AG_A));
  const tree = r.out?.tree ?? '';
  check(r.ok && tree.includes(A) && tree.includes(A_CHILD), 'list_matters shows A and A\'s open child');
  check(!tree.includes(A_SEALED) && !tree.includes('Privileged'), 'never the sealed child of A');
  check(!tree.includes(B) && !tree.includes(C) && !tree.includes(C_CHILD), 'never B, never C');
  check(r.out?.matter_count === 2, 'exactly two matters on its map', `n=${r.out?.matter_count}`);
  check(onlyIn([A, A_CHILD]), 'no other matter was even counted', [...contentScope()].join(','));
}
reset();
{
  const r = await call('list_matters', { format: 'full' }, agentOpts(AG_A));
  const ids = (r.out ?? []).map((m) => m.id).sort();
  check(r.ok && JSON.stringify(ids) === JSON.stringify([A, A_CHILD].sort()), 'format:"full" — the same two', ids.join(','));
}
reset();
{
  const r = await call('search', { matter: 'vashti', q: 'Ormsby' }, agentOpts(AG_A));
  check(r.ok && r.out.result_count === 2, 'search in A answers from A and its open child', `n=${r.out?.result_count}`);
  check(!contentScope().has(A_SEALED), 'the sealed child was never asked for its content');
  check(leaks(r).length === 0, 'no sealed or foreign text came back', leaks(r).join(','));
}
reset();
{
  const r = await call('search', { q: 'Ormsby' }, agentOpts(AG_A));
  check(r.ok && r.out.result_count === 2, 'search everywhere = A + A\'s open child only', `n=${r.out?.result_count}`);
  check(onlyIn([A, A_CHILD]), 'the all-matters scope never reached B, C or the sealed child', [...contentScope()].join(','));
  check(leaks(r).length === 0, 'no foreign text', leaks(r).join(','));
}
reset();
{
  const r = await call('grep', { matter: 'vashti', pattern: 'Ormsby' }, agentOpts(AG_A));
  check(r.ok && r.out.match_count === 2, 'grep in A: parent + open child', `n=${r.out?.match_count}`);
  check(!contentScope().has(A_SEALED), 'grep never read the sealed child');
}
reset();
{
  const r = await call('list_matter_contents', { matter: 'vashti-pleadings' }, agentOpts(AG_A));
  check(r.ok && r.out.document_count === 1, 'a granted matter\'s sub-matter can be listed');
}
reset();
{
  const r = await call('search', { matter: 'brannock', q: 'Ormsby' }, agentOpts(AG_A));
  check(refusedScope(r), 'naming B is refused with code agent_scope', r.err?.code ?? 'no error');
  check(!String(r.err?.message).includes(NAMES[B]) && !String(r.err?.message).includes('brannock'),
    'and the refusal does not name B');
  check(!contentScope().has(B), 'nothing was read from B');
}
reset();
{
  const r = await call('search', { matter: 'vashti-privileged', q: 'Ormsby' }, agentOpts(AG_A));
  check(refusedScope(r), 'naming the sealed child is refused as out of scope', r.err?.code ?? 'no error');
  check(!String(r.err?.message).includes('Privileged'), 'without naming it');
  check(!contentScope().has(A_SEALED), 'and it was not read');
}
reset();
{
  const byId = await call('search', { matter: A_SEALED, q: 'Ormsby' }, agentOpts(AG_A));
  check(refusedScope(byId) && !String(byId.err?.message).includes('Privileged'),
    'by UUID too — and the name still does not come back');
}
reset();
for (const [label, tool, args] of [
  ['get_outline on B\'s document', 'get_outline', { doc: DOC[B] }],
  ['get_media on the sealed child\'s document', 'get_media', { document_id: DOC[A_SEALED] }],
  ['get_passage on B\'s passage', 'get_passage', { id: PASSAGE[B] }],
  ['search with document_ids reaching into B', 'search', { q: 'Ormsby', document_ids: [DOC[A], DOC[B]] }],
  ['edit_pdf inserting pages from B into A', 'edit_pdf', { document_id: DOC[A], inserts: [{ at: 1, document_id: DOC[B], pages: '1' }] }],
  ['copy_document from A into B', 'copy_document', { document_ids: [DOC[A]], to_matter: 'brannock' }],
  ['create_matter at the top level', 'create_matter', { name: 'Agent-made matter' }],
  ['create_matter under B', 'create_matter', { name: 'x', parent: 'brannock' }],
  ['send_to_sandbox (writes outside the grant)', 'send_to_sandbox', { document_ids: [DOC[A]] }],
  ['check_ingest_status with nothing named', 'check_ingest_status', {}],
  ['a document id that is not an id', 'get_outline', { doc: 'Memo brannock' }],
  ['an unknown document id', 'get_media', { document_id: id(9999) }],
]) {
  reset();
  const r = await call(tool, args, agentOpts(AG_A));
  check(refusedScope(r), `refused: ${label}`, r.ok ? 'it ran' : r.err?.code ?? r.err?.message);
}
reset();
{
  const r = await call('get_passage', { id: PASSAGE[A_CHILD] }, agentOpts(AG_A));
  check(r.ok && !refusedScope(r), 'get_passage inside the grant works');
}

// The AI pause still applies inside the grant.
reset();
db.matterspaces.find((m) => m.id === A_CHILD).ai_paused = true;
{
  const r = await call('search', { matter: 'vashti-pleadings', q: 'Ormsby' }, agentOpts(AG_A));
  check(!r.ok && r.err?.code === 'ai_paused', 'a paused matter inside the grant is refused as paused', r.err?.code ?? 'ran');
  const l = await call('list_matters', {}, agentOpts(AG_A));
  check(l.ok && !l.out.tree.includes(A_CHILD) && l.out.tree.includes(A), 'and drops off the agent\'s map');
}
db.matterspaces.find((m) => m.id === A_CHILD).ai_paused = false;

// Attribution: every agent call is recorded as that agent.
reset();
await call('search', { matter: 'vashti', q: 'Ormsby' }, agentOpts(AG_A));
{
  const row = ledger.find((p) => p.rpc === 'ledger_append' && p.p_kind === 'tool.invoked');
  check(row?.p_matter === A, 'the call is recorded in A\'s Record');
  check(row?.p_actor_kind === 'connector' && row?.p_actor_ref === `agent:${AG_A}`,
    'as this agent (actor ref = agent:<token id>)', `${row?.p_actor_kind} ${row?.p_actor_ref}`);
  check(row?.p_payload?.connector_client_id === `agent:${AG_A}`, 'and the payload names the agent too');
}
reset();
await call('search', { matter: 'brannock', q: 'Ormsby' }, agentOpts(AG_A));
{
  const row = ledger.find((p) => p.rpc === 'ledger_append' && p.p_kind === 'tool.invoked');
  check(row?.p_payload?.refused === 'agent_scope', 'a refused reach is recorded as refused: agent_scope');
}

// ===========================================================================
section('A3 — a sub-matter grant, a sealed grant, an empty grant');
// ===========================================================================
reset();
{
  const r = await call('list_matters', {}, agentOpts(AG_CHILD));
  const tree = r.out?.tree ?? '';
  check(r.ok && tree.includes(C_CHILD), 'granted only C\'s sub-matter: it is on the map');
  check(!tree.includes(`| ${C}`) && !tree.includes(NAMES[C]), 'its parent C is not');
  const s = await call('search', { matter: 'corvel-discovery', q: 'Ormsby' }, agentOpts(AG_CHILD));
  check(s.ok && s.out.result_count === 1 && leaks(s).length === 0, 'search in the sub-matter works, and only there');
  const p = await call('search', { matter: 'corvel', q: 'Ormsby' }, agentOpts(AG_CHILD));
  check(refusedScope(p), 'naming the ungranted parent is refused');
}
reset();
{
  const r = await call('list_matters', {}, agentOpts(AG_SEALED));
  check(r.ok && r.out.matter_count === 0, 'granted a SEALED matter: it sees nothing — the seal wins', `n=${r.out?.matter_count}`);
  const s = await call('search', { matter: 'vashti-privileged', q: 'Ormsby' }, agentOpts(AG_SEALED));
  check(refusedScope(s) && !contentScope().has(A_SEALED), 'naming it is refused and nothing is read');
  const all = await call('search', { q: 'Ormsby' }, agentOpts(AG_SEALED));
  check(all.ok && all.out.result_count === 0, 'search everywhere returns nothing');
}
reset();
{
  const r = await call('list_matters', {}, agentOpts(AG_EMPTY));
  check(r.ok && r.out.matter_count === 0, 'scope {}: list_matters shows nothing', `n=${r.out?.matter_count}`);
  const all = await call('search', { q: 'Ormsby' }, agentOpts(AG_EMPTY));
  check(all.ok && all.out.result_count === 0, 'scope {}: search everywhere returns nothing');
  check(contentScope().size === 0, 'scope {}: no content query was made at all', [...contentScope()].join(','));
  for (const [tool, args] of [
    ['search', { matter: 'vashti', q: 'Ormsby' }], ['grep', { matter: 'vashti', pattern: 'x' }],
    ['get_outline', { doc: DOC[A] }], ['get_media', { document_id: DOC[A] }],
    ['list_matter_contents', { matter: 'vashti' }], ['file_document', { matter: 'vashti', filename: 'a.txt', content: 'x' }],
    ['create_matter', { name: 'x', parent: 'vashti' }],
  ]) {
    const r2 = await call(tool, args, agentOpts(AG_EMPTY));
    check(refusedScope(r2), `scope {}: ${tool} refuses`);
  }
  const t = await call('my_tasks', {}, agentOpts(AG_EMPTY));
  check(t.ok && t.out.task_count === 0, 'scope {}: the task tools still answer (no tasks)');
}
reset();
{
  const r = await call('list_matters', {}, { ...agentOpts(AG_A), agentToken: { id: 'not-a-uuid', matterScope: [A] } });
  check(refusedScope(r), 'a malformed agent token is refused, not waved through');
}

// ===========================================================================
section('USER tokens — exactly as before');
// ===========================================================================
check(JSON.stringify(USER_OPTS) === JSON.stringify({ openaiApiKey: 'sk-test', googleApiKey: undefined, sealConnector: true }),
  'a user token\'s callTool options are the old literal: {openaiApiKey, googleApiKey, sealConnector:true}');
check(!('agentToken' in USER_OPTS) && !('actor' in USER_OPTS), 'no agentToken, no actor');
check(!('agentToken' in callToolOptsFor({ userId: USER, kind: 'user' })), 'OAuth identities (kind user) likewise');
reset();
{
  const r = await call('list_matters', { format: 'full' }, USER_OPTS);
  const ids = (r.out ?? []).map((m) => m.id).sort();
  check(JSON.stringify(ids) === JSON.stringify([A, A_CHILD, B, C, C_CHILD].sort()),
    'user token: every matter except the sealed one, as before', ids.length);
  const s = await call('search', { q: 'Ormsby' }, USER_OPTS);
  check(s.ok && s.out.result_count === 5 && !contentScope().has(A_SEALED), 'user token: search everywhere = 5 unsealed matters');
  const b = await call('search', { matter: 'brannock', q: 'Ormsby' }, USER_OPTS);
  check(b.ok && b.out.result_count === 1, 'user token: B is searchable');
  const sealed = await call('search', { matter: 'vashti-privileged', q: 'Ormsby' }, USER_OPTS);
  check(!sealed.ok && sealed.err?.code === 'sealed_matter', 'user token: the sealed child is refused as SEALED, as before');
  // edit_pdf's inserts bring ANOTHER document's pages into the output. The
  // seal used to look only at document_id, so a user token could pull a
  // sealed matter's pages into an open matter's PDF (PR #228 closed this for
  // agents only). The refusal must come from the seal, before any PDF loads.
  const sealedInsert = await call('edit_pdf',
    { document_id: DOC[A], inserts: [{ at: 1, document_id: DOC[A_SEALED], pages: '1' }] }, USER_OPTS);
  check(!sealedInsert.ok && sealedInsert.err?.code === 'sealed_matter',
    'user token: edit_pdf inserting pages FROM a sealed document is refused as SEALED',
    sealedInsert.ok ? 'it ran' : sealedInsert.err?.code ?? sealedInsert.err?.message);
  const openInsert = await call('edit_pdf',
    { document_id: DOC[A], inserts: [{ at: 1, document_id: DOC[B], pages: '1' }] }, USER_OPTS);
  check(openInsert.err?.code !== 'sealed_matter' && openInsert.err?.code !== 'agent_scope',
    'user token: negative control — an insert from an unsealed document is not refused by the seal',
    openInsert.ok ? 'ran' : `${openInsert.err?.code ?? ''} ${String(openInsert.err?.message).slice(0, 60)}`);
  db.matterspaces.find((m) => m.id === B).ai_paused = true;
  const pausedInsert = await call('edit_pdf',
    { document_id: DOC[A], inserts: [{ at: 1, document_id: DOC[B], pages: '1' }] }, USER_OPTS);
  db.matterspaces.find((m) => m.id === B).ai_paused = false;
  check(!pausedInsert.ok && pausedInsert.err?.code === 'ai_paused',
    'user token: and an insert from a PAUSED matter is refused as paused (the pause reads inserts too)',
    pausedInsert.ok ? 'it ran' : pausedInsert.err?.code);
  const top = await call('create_matter', { name: '' }, USER_OPTS);
  check(!top.ok && top.err?.code !== 'agent_scope', 'user token: create_matter is not agent-gated');
  check(taskQueries.length === 0, 'user token: no task table was touched by any of that');
}
reset();
for (const tool of ['my_tasks', 'claim_task', 'ask_human', 'post_result']) {
  const r = await call(tool, { task_id: T_OPEN, question: 'q', result: 'r' }, USER_OPTS);
  check(r.ok && r.out?.error === AGENT_TOOLS_ONLY_MESSAGE, `user token: ${tool} answers the one-line pointer`);
}
check(taskQueries.length === 0, 'and read no task');
check(db.agent_tasks.find((t) => t.id === T_OPEN).status === 'open', 'and changed nothing');
{
  const names = TOOLS.map((t) => t.name);
  check(['my_tasks', 'claim_task', 'ask_human', 'post_result'].every((n) => names.includes(n)),
    'the four task tools are listed for every connector');
  check(names.length === 24, 'and the 20 existing tools are all still there', `n=${names.length}`);
}

// ===========================================================================
section('B6 — the task board');
// ===========================================================================
reset();
{
  const r = await call('my_tasks', {}, agentOpts(AG_A));
  const ids = (r.out?.tasks ?? []).map((t) => t.task_id).sort();
  check(r.ok && JSON.stringify(ids) === JSON.stringify([T_OPEN, T_FAIL].sort()),
    'my_tasks: only this token\'s live tasks in visible matters', ids.join(','));
  check(!text(r).includes('BRANNOCK-TASK') && !text(r).includes('OTHER-AGENT-TASK') && !text(r).includes('SEALED-TASK'),
    'not the task in B, not another agent\'s, not the sealed one');
  const t = r.out.tasks.find((x) => x.task_id === T_OPEN);
  check(t.matter.short_code === 'vashti' && t.matter.name === NAMES[A], 'each task names its matter (short_code + name)');
  const att = t.attachments;
  const doc = att.find((a) => a.id === DOC[A]);
  check(doc?.available && doc.title === 'Memo vashti' && /get_outline/.test(doc.how_to_read),
    'a document attachment in scope: title + how to read it');
  const page = att.find((a) => a.id === PAGE_A);
  check(page?.available && page.text.includes('Serve the notice.'), 'a page/list attachment comes with its text');
  const ev = att.find((a) => a.id === EVENT_A);
  check(ev?.available && ev.start_date === '2026-10-02', 'a calendar attachment comes with its date');
  const foreign = att.filter((a) => [DOC[B], PAGE_B, DOC[A_SEALED]].includes(a.id));
  check(foreign.length === 3 && foreign.every((a) => a.available === false && !('label' in a) && !('title' in a)),
    'out-of-scope and sealed attachments are withheld: no label, no title, no text');
  check(leaks(r).length === 0, 'no foreign text anywhere in my_tasks', leaks(r).join(','));
  check(t.next.startsWith('claim_task'), 'an open task says what to do next');
  const all = await call('my_tasks', { status: 'all' }, agentOpts(AG_A));
  check((all.out?.tasks ?? []).some((x) => x.task_id === T_DONE && x.result === 'Filed.'), 'status:"all" includes finished tasks, with their result');
  const bad = await call('my_tasks', { status: 'nonsense' }, agentOpts(AG_A));
  check(!bad.ok, 'an unknown status is an error');
}
reset();
{
  const other = await call('claim_task', { task_id: T_OTHER }, agentOpts(AG_A));
  check(!other.ok && /No task with that id/.test(other.err.message), 'another agent\'s task: "not found"');
  const inB = await call('claim_task', { task_id: T_IN_B }, agentOpts(AG_A));
  check(refusedScope(inB), 'a task in an ungranted matter: agent_scope');
  const sealed = await call('claim_task', { task_id: T_SEALED }, agentOpts(AG_A));
  check(refusedScope(sealed), 'a task in the sealed child: agent_scope');
  check(['open'].includes(db.agent_tasks.find((t) => t.id === T_IN_B).status)
    && db.agent_tasks.find((t) => t.id === T_SEALED).status === 'open'
    && db.agent_tasks.find((t) => t.id === T_OTHER).status === 'open', 'none of them changed');
}
reset();
{
  const r = await call('claim_task', { task_id: T_OPEN }, agentOpts(AG_A));
  const row = db.agent_tasks.find((t) => t.id === T_OPEN);
  check(r.ok && r.out.status === 'claimed' && row.status === 'claimed' && row.claimed_at, 'claim_task: open → claimed');
  const ev = db.agent_task_events.filter((e) => e.task_id === T_OPEN);
  check(ev.length === 1 && ev[0].kind === 'claimed' && ev[0].actor_kind === 'agent'
    && ev[0].actor_token_id === AG_A && ev[0].actor_user === USER, 'one "claimed" event, by this agent token');
  const tool = ledger.find((p) => p.rpc === 'ledger_append' && p.p_kind === 'tool.invoked');
  check(tool?.p_matter === A && tool?.p_actor_ref === `agent:${AG_A}`, 'and the call is in A\'s Record as this agent');
  const again = await call('claim_task', { task_id: T_OPEN }, agentOpts(AG_A));
  check(again.ok && again.out.already_claimed === true, 'claiming again is idempotent');
  check(db.agent_task_events.filter((e) => e.task_id === T_OPEN).length === 1, 'and logs nothing new');
}
reset();
{
  const r = await call('ask_human', { task_id: T_OPEN, question: 'Which service date controls?' }, agentOpts(AG_A));
  const row = db.agent_tasks.find((t) => t.id === T_OPEN);
  check(r.ok && row.status === 'needs_input' && row.question === 'Which service date controls?' && row.answer === null,
    'ask_human: needs_input, question set, answer cleared');
  const ev = db.agent_task_events.filter((e) => e.task_id === T_OPEN && e.kind === 'asked');
  check(ev.length === 1 && ev[0].body === 'Which service date controls?', 'an "asked" event carries the question');
  const empty = await call('ask_human', { task_id: T_OPEN, question: '   ' }, agentOpts(AG_A));
  check(!empty.ok, 'an empty question is refused');
  const waiting = await call('my_tasks', {}, agentOpts(AG_A));
  check(waiting.out.tasks.find((t) => t.task_id === T_OPEN)?.status === 'needs_input', 'my_tasks shows it waiting');
  // The person answers (the UI's write: status back to claimed, answer set).
  Object.assign(row, { status: 'claimed', answer: 'The March 9 service.' });
  const answered = await call('my_tasks', {}, agentOpts(AG_A));
  const t = answered.out.tasks.find((x) => x.task_id === T_OPEN);
  check(t?.status === 'claimed' && t.answer === 'The March 9 service.' && /answered/.test(t.next),
    'after the answer: claimed, with the answer, and told to carry on');
}
reset();
{
  const out = await call('post_result', {
    task_id: T_OPEN, result: 'Summary filed.', result_refs: [{ kind: 'document', id: DOC[B] }],
  }, agentOpts(AG_A));
  check(refusedScope(out), 'post_result naming a document in B is refused');
  check(db.agent_tasks.find((t) => t.id === T_OPEN).status === 'claimed', 'and the task is unchanged');
  const sealedRef = await call('post_result', {
    task_id: T_OPEN, result: 'x', result_refs: [{ kind: 'document', id: DOC[A_SEALED] }],
  }, agentOpts(AG_A));
  check(refusedScope(sealedRef), 'a result_ref in the sealed child is refused too');
  const malformed = await call('post_result', {
    task_id: T_OPEN, result: 'x', result_refs: [{ kind: 'folder', id: DOC[A] }],
  }, agentOpts(AG_A));
  check(!malformed.ok, 'a malformed result_ref is refused');
  const ok = await call('post_result', {
    task_id: T_OPEN, result: 'Service was on March 9; memo filed.',
    result_refs: [{ kind: 'document', id: DOC[A_CHILD], label: 'Service memo' }],
  }, agentOpts(AG_A));
  const row = db.agent_tasks.find((t) => t.id === T_OPEN);
  check(ok.ok && row.status === 'done' && row.result.startsWith('Service was') && row.completed_at,
    'post_result: done, result stored, completed_at set');
  check(row.result_refs.length === 1 && row.result_refs[0].id === DOC[A_CHILD], 'result_refs stored (in scope)');
  const ev = db.agent_task_events.filter((e) => e.task_id === T_OPEN && e.kind === 'result');
  check(ev.length === 1 && ev[0].actor_token_id === AG_A, 'a "result" event, by this agent');
  const twice = await call('post_result', { task_id: T_OPEN, result: 'again' }, agentOpts(AG_A));
  check(!twice.ok && /done/.test(twice.err.message), 'a finished task takes no second result');
  const claimDone = await call('claim_task', { task_id: T_OPEN }, agentOpts(AG_A));
  check(!claimDone.ok, 'and cannot be claimed again');
}
reset();
{
  const r = await call('post_result', { task_id: T_FAIL, result: 'The exhibit is not in the matter.', status: 'failed' }, agentOpts(AG_A));
  const row = db.agent_tasks.find((t) => t.id === T_FAIL);
  check(r.ok && row.status === 'failed', 'post_result status:"failed" marks the task failed');
  check(db.agent_task_events.some((e) => e.task_id === T_FAIL && e.kind === 'failed'), 'with a "failed" event');
  const badStatus = await call('post_result', { task_id: T_FAIL, result: 'x', status: 'cancelled' }, agentOpts(AG_A));
  check(!badStatus.ok, 'an agent cannot set any other status');
}
reset();
{
  db.agent_tasks.find((t) => t.id === T_OTHER).status = 'cancelled';
  const r = await call('my_tasks', { status: 'all' }, agentOpts(AG_OTHER));
  const t = (r.out?.tasks ?? []).find((x) => x.task_id === T_OTHER);
  check(t?.status === 'cancelled' && /Stop/.test(t.next), 'a cancelled task tells its agent to stop');
  const post = await call('post_result', { task_id: T_OTHER, result: 'x' }, agentOpts(AG_OTHER));
  check(!post.ok, 'and takes no result');
}

// ===========================================================================
section('AUTH — token kind, path A, and /api/ext');
// ===========================================================================
{
  const pre = connectorTokenIdentity({ id: AG_A, user_id: USER, name: 'Claude Desktop' });
  check(pre.kind === 'user' && pre.userId === USER && pre.matterScope === null, 'a pre-085 row (no kind column) is a user token');
  const user = connectorTokenIdentity({ id: AG_A, user_id: USER, kind: 'user', matter_scope: [B] });
  check(user.kind === 'user' && user.matterScope === null, 'kind user ignores matter_scope');
  const agent = connectorTokenIdentity({ id: AG_A, user_id: USER, kind: 'agent', matter_scope: [A, 'junk', A], agent_provider: 'grok' });
  check(agent.kind === 'agent' && JSON.stringify(agent.matterScope) === JSON.stringify([A]) && agent.provider === 'grok',
    'an agent row carries its scope (deduplicated, non-ids dropped)');
  const nullScope = connectorTokenIdentity({ id: AG_A, user_id: USER, kind: 'agent', matter_scope: null });
  check(nullScope.kind === 'agent' && nullScope.matterScope.length === 0, 'an agent with no readable scope has an EMPTY one');
  const odd = connectorTokenIdentity({ id: AG_A, user_id: USER, kind: 'service' });
  check(odd.kind === 'agent' && odd.matterScope.length === 0, 'an unknown kind fails closed (agent, nothing granted)');
}
const TOK_USER = 'csp_userTOKENuserTOKENuser0001';
const TOK_AGENT = 'csp_agentTOKENagentTOKENagent02';
const TOK_OLD = 'csp_oldROWoldROWoldROWoldROW003';
const TOK_REVOKED = 'csp_revokedREVOKEDrevokedREV04';
const hash = (t) => createHash('sha256').update(t).digest('hex');
tokenRows.set(hash(TOK_USER), { id: id(700), user_id: USER, kind: 'user', matter_scope: null, revoked_at: null, expires_at: null });
tokenRows.set(hash(TOK_AGENT), { id: AG_A, user_id: USER, kind: 'agent', matter_scope: [A], agent_provider: 'grok', name: 'Grok bot', revoked_at: null, expires_at: null });
tokenRows.set(hash(TOK_OLD), { id: id(701), user_id: USER, revoked_at: null, expires_at: null });
tokenRows.set(hash(TOK_REVOKED), { id: id(702), user_id: USER, kind: 'agent', matter_scope: [A], revoked_at: '2026-09-01', expires_at: null });
const req = (tok) => ({ headers: { authorization: `Bearer ${tok}` } });
const tryAuth = async (fn, tok) => { try { return await fn(req(tok)); } catch (err) { return { err }; } };
{
  authRequests.length = 0;
  const u = await tryAuth(authenticate, TOK_USER);
  check(u.kind === 'user' && u.userId === USER, '/api/mcp: a user token authenticates as the user');
  check(authRequests.find((r) => r.method === 'GET')?.select === '*',
    'path A reads the row with select=* (so a database without 085 still answers)',
    authRequests.find((r) => r.method === 'GET')?.select);
  const a = await tryAuth(authenticate, TOK_AGENT);
  check(a.kind === 'agent' && a.tokenId === AG_A && JSON.stringify(a.matterScope) === JSON.stringify([A]),
    '/api/mcp: an agent token authenticates as an agent, with its scope');
  const o = await tryAuth(authenticate, TOK_OLD);
  check(o.kind === 'user' && o.userId === USER, '/api/mcp: a row with no kind column (pre-085) is a user token');
  const r = await tryAuth(authenticate, TOK_REVOKED);
  check(r.err?.status === 401 && r.err?.code === 'revoked', '/api/mcp: a revoked agent token is refused, as any token is');
  const opts = callToolOptsFor(a, { openaiApiKey: 'k' });
  check(opts.sealConnector === true && opts.agentToken?.id === AG_A && opts.agentToken.userId === USER
    && opts.actor?.ref === `agent:${AG_A}`, 'an agent identity yields agentToken + actor on top of the seal');
}
{
  const u = await tryAuth(authenticateConnectorToken, TOK_USER);
  check(u === USER, '/api/ext: a user token still authenticates (returns the user id)');
  const o = await tryAuth(authenticateConnectorToken, TOK_OLD);
  check(o === USER, '/api/ext: so does a pre-085 row');
  const a = await tryAuth(authenticateConnectorToken, TOK_AGENT);
  check(a.err?.status === 403 && a.err?.code === 'agent_token_not_allowed',
    '/api/ext: an agent token is refused (403 agent_token_not_allowed) — those endpoints know no scope',
    a.err?.code ?? String(a));
}

// ---------------------------------------------------------------------------
globalThis.fetch = realFetch;
console.log(`\n${failures === 0
  ? `AGENT SCOPE HOLDS — ${passes} checks: an agent sees only its grant, never a seal; user tokens unchanged.`
  : `${failures} FAILURE(S) of ${passes + failures}`}\n`);
process.exit(failures === 0 ? 0 : 1);
