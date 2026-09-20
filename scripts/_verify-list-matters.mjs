// `list_matters` must fit in the context window it exists to orient.
//
// What this is
// ---------------------------------------------------------------------------
// Measured in production on 2026-09-20 through a real claude.ai connector:
// 296 matters came back as 112,790 characters of pretty-printed JSON. The
// client refused to load it and spilled it to a file; the in-app assistant
// cuts it off at TOOL_RESULT_CHAR_CAP (100,000). The tool's own description
// tells every model to "call this first", so the first thing a new user's
// assistant does is fail, or spend ~30k tokens before it has read a word of
// the matter it was asked about.
//
// This harness drives the REAL handler (lib/mcp-core.mjs) against a synthetic
// workspace shaped like Eden's — 296 matters in 7 serverspaces, two levels
// deep, with the paragraph-length descriptions that make today's answer
// heavy — and asserts:
//
//   A. the default answer is a compact tree, a fraction of today's size, and
//      the synthetic workspace really does reproduce today's size (otherwise
//      the comparison is against a strawman);
//   B. every visible matter appears exactly ONCE in that tree, with its id,
//      its short_code, its per-matter document count and its place in the
//      tree — a small map is only worth having if nothing fell out of it;
//   C. the optional arguments narrow it (serverspace / parent / query /
//      include_descriptions), and malformed arguments fall back to the
//      default instead of throwing;
//   D. `format: 'full'` is byte-identical to what main returned, so no
//      existing consumer changes behaviour;
//   E. the seal and the pause still hide a matter AND everything under it in
//      the new shape — from both ends of the #181 leak class — and a hidden
//      matter's id never even reaches a `documents` query, because pruning
//      happens before counting. Part E ends with a NEGATIVE CONTROL: the same
//      workspace on the in-app path, where the sealed subtree MUST appear.
//   F. the account-chain row (migration 072) still gets its count, and still
//      names no matter.
//
// The database is a stub: an in-memory fixture answering the handful of
// supabase-js calls these paths make. No network, no .env, no client data.
//
//   node scripts/_verify-list-matters.mjs
//
// Exit 0 = the map fits, and nothing is missing from it that should be there.

import { callTool, handleListMatters, TOOLS } from '../lib/mcp-core.mjs';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

// Nothing here should reach the network; if a path tries, say so loudly.
globalThis.fetch = async (input) => {
  throw new Error(`unexpected outbound call to ${typeof input === 'string' ? input : input?.url}`);
};

// ---------------------------------------------------------------------------
// The fixture: a workspace shaped like the production one.
// ---------------------------------------------------------------------------
const MATTERS = 296;
const uuid = (n) => {
  const h = n.toString(16).padStart(12, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4000-8000-${h}`;
};

const SPACE_NAMES = [
  'Litigation', 'Appeals', 'Corporate', 'Administration',
  'Client Development', 'Personal', 'Archive',
];
const FIRST = ['Quainton', 'Vashti', 'Ormsby', 'Fleming', 'Caldecott', 'Marchetti', 'Danforth', 'Peloso'];
const SECOND = ['Holdings LLC', 'Industries Inc.', 'Municipal Authority', 'Partners LP', 'Trust', 'Group'];
const LEAF = [
  'Pleadings', 'Depositions', 'Expert Reports', 'Discovery Responses',
  'Correspondence', 'Trial Prep', 'Exhibits', 'Motions in Limine',
];
const DESCRIPTION =
  'Commercial dispute arising out of the 2024 supply agreement; the client is the defendant on ' +
  'the contract counts and the plaintiff on the counterclaim for unpaid invoices and interest.';
const SHORT_DESCRIPTION = 'Filed 2025; discovery closes in the spring.';
// Production's descriptions are uneven — some matters carry a paragraph, some
// a line, some nothing. Mirror that rather than a uniform worst case.
const describe = (n) => (n % 3 === 0 ? null : n % 3 === 1 ? SHORT_DESCRIPTION : DESCRIPTION);

const serverspaces = SPACE_NAMES.map((name, i) => ({ id: uuid(900 + i), name }));

const matterspaces = [];
const docCount = new Map();
{
  let n = 0;
  let root = null;
  let kids = 0;
  while (matterspaces.length < MATTERS) {
    n += 1;
    const id = uuid(n);
    const space = serverspaces[n % serverspaces.length];
    const isRoot = root === null || kids >= 3;
    if (isRoot) {
      const name = `${FIRST[n % FIRST.length]} v. ${SECOND[n % SECOND.length]} (${2020 + (n % 6)})`;
      matterspaces.push({
        id, name,
        short_code: `${FIRST[n % FIRST.length].toLowerCase()}-${n}`,
        description: describe(n),
        serverspace_id: space.id,
        parent_matterspace_id: null,
        ai_tier: 'A', ai_paused: false,
        created_at: new Date(Date.UTC(2026, 0, 1) - n * 3600_000).toISOString(),
      });
      root = id;
      kids = 0;
    } else {
      matterspaces.push({
        id, name: `${LEAF[n % LEAF.length]} — Volume ${1 + (n % 4)}`,
        short_code: `${LEAF[n % LEAF.length].toLowerCase().replace(/ /g, '-')}-${n}`,
        description: describe(n),
        serverspace_id: space.id,
        parent_matterspace_id: root,
        ai_tier: 'A', ai_paused: false,
        created_at: new Date(Date.UTC(2026, 0, 1) - n * 3600_000).toISOString(),
      });
      kids += 1;
    }
    docCount.set(id, (n * 37) % 640);
  }
}

// One sealed sub-matter inside an open parent, one paused root with an open
// child under it, and a matter with no short_code at all.
const SEALED_CHILD = matterspaces[5].id;      // a sub-matter; its parent is open
const SEALED_PARENT = matterspaces[5].parent_matterspace_id;
matterspaces[5].ai_tier = 'B';
const PAUSED_ROOT = matterspaces.find((m) => !m.parent_matterspace_id && m.id !== SEALED_PARENT).id;
matterspaces.find((m) => m.id === PAUSED_ROOT).ai_paused = true;
const UNDER_PAUSED = matterspaces.find((m) => m.parent_matterspace_id === PAUSED_ROOT)?.id ?? null;
const NO_CODE = matterspaces[200].id;
matterspaces[200].short_code = null;

const db = { matterspaces, serverspaces };

// ---------------------------------------------------------------------------
// The stub client, plus two witnesses: which matters were asked for a
// document count, and what was written to the ledger.
// ---------------------------------------------------------------------------
let counted = [];
let ledgerRows = [];
const reset = () => { counted = []; ledgerRows = []; };

function makeClient() {
  return {
    from(table) {
      const state = { table, filters: [], count: false, head: false, order: null };
      const rowsOf = () => {
        if (table === 'documents') return [];
        const rows = db[table];
        if (!rows) throw new Error(`stub: no table ${table}`);
        return rows;
      };
      const run = () => {
        if (state.table === 'documents') {
          const eq = state.filters.find(([c]) => c === 'matterspace_id');
          if (!eq) throw new Error('stub: documents read with no matterspace_id');
          counted.push(eq[1]);
          return { data: null, count: docCount.get(eq[1]) ?? 0, error: null };
        }
        let rows = rowsOf();
        for (const [col, val, kind] of state.filters) {
          if (kind === 'eq') rows = rows.filter((r) => r[col] === val);
          else if (kind === 'in') rows = rows.filter((r) => val.includes(r[col]));
          else throw new Error(`stub: no filter kind ${kind}`);
        }
        if (state.order) {
          const [col, asc] = state.order;
          rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
        }
        return { data: rows, count: state.count ? rows.length : null, error: null };
      };
      const builder = {
        select(_cols, opts = {}) {
          state.count = Boolean(opts.count);
          state.head = Boolean(opts.head);
          return builder;
        },
        eq(col, val) { state.filters.push([col, val, 'eq']); return builder; },
        in(col, vals) { state.filters.push([col, vals, 'in']); return builder; },
        order(col, opts = {}) { state.order = [col, opts.ascending !== false]; return builder; },
        limit() { return builder; },
        single() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.data?.[0] ? null : { message: 'not found' } }); },
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
          for (const m of db.matterspaces) if (m.parent_matterspace_id === id) queue.push(m.id);
        }
        return { data: out, error: null };
      }
      if (name === 'ledger_append' || name === 'ledger_append_account') {
        ledgerRows.push({ fn: name, ...params });
        return { data: { id: 'row', seq: ledgerRows.length }, error: null };
      }
      if (name === 'matter_ai_pause') return { data: null, error: null };
      throw new Error(`stub: no rpc ${name}`);
    },
  };
}
const supabase = makeClient();

const CONNECTOR = { sealConnector: true };
const IN_APP = {};
const size = (v) => JSON.stringify(v).length;

// ---------------------------------------------------------------------------
// A. The size the production connector met, and the size it meets now.
// ---------------------------------------------------------------------------
console.log('\n--- A. the map fits ---------------------------------------------');
reset();
const full = await handleListMatters(supabase, { format: 'full' });
const fullPretty = JSON.stringify(full, null, 2).length;
check(full.length === MATTERS, `the fixture holds ${MATTERS} matters`, `n=${full.length}`);
check(fullPretty >= 112_790,
  'and answers at least as heavily as production did (112,790 chars for 296 matters) — ' +
  'so the comparison below is not against a strawman',
  `${fullPretty.toLocaleString()} chars pretty-printed`);

reset();
const tree = await handleListMatters(supabase, {});
const treeChars = size(tree);
const treeLines = tree.tree.split('\n').length;
console.log(`\n  today (pretty JSON):  ${fullPretty.toLocaleString()} chars, ${JSON.stringify(full, null, 2).split('\n').length.toLocaleString()} lines`);
console.log(`  new default (tree):   ${treeChars.toLocaleString()} chars, ${treeLines.toLocaleString()} lines`);
console.log(`  reduction:            ${(fullPretty / treeChars).toFixed(1)}x  (~${Math.round(treeChars / 4).toLocaleString()} tokens)\n`);
check(treeChars < 30_000, 'the default answer is under 30,000 characters (~7.5k tokens)',
  `${treeChars.toLocaleString()} chars`);
check(treeChars < fullPretty / 3, 'at least a 3x cut on today\'s answer');
check(treeChars < 100_000, 'and it is no longer truncated by the in-app TOOL_RESULT_CHAR_CAP');
console.log('  first six lines of the tree:');
for (const l of tree.tree.split('\n').slice(0, 6)) console.log(`    ${l}`);

// ---------------------------------------------------------------------------
// B. Nothing fell out of the map.
// ---------------------------------------------------------------------------
console.log('\n--- B. every matter is on it, exactly once ----------------------');
const lines = tree.tree.split('\n').filter((l) => l.startsWith(' '));
check(lines.length === MATTERS, `one line per matter (${MATTERS})`, `n=${lines.length}`);
{
  let missing = 0;
  let wrongCount = 0;
  let missingCode = 0;
  for (const m of matterspaces) {
    const hits = lines.filter((l) => l.includes(m.id));
    if (hits.length !== 1) { missing += 1; continue; }
    const parts = hits[0].trim().split(' | ');
    if (parts[0] !== m.name) missing += 1;
    if (parts[1] !== (m.short_code ?? '-')) missingCode += 1;
    if (parts[2] !== String(docCount.get(m.id))) wrongCount += 1;
  }
  check(missing === 0, 'every matter appears exactly once, with its id and its name', `${missing} bad`);
  check(missingCode === 0, 'and its short_code (or "-" where it has none)', `${missingCode} bad`);
  check(wrongCount === 0, 'and its own document count', `${wrongCount} bad`);
}
{
  // Counts are per matter, never rolled up: a parent's number is its own.
  const parent = matterspaces.find((m) => !m.parent_matterspace_id);
  const line = lines.find((l) => l.includes(parent.id));
  check(line.trim().split(' | ')[2] === String(docCount.get(parent.id)),
    'a parent\'s count is its own documents, not its children\'s');
  const kid = matterspaces.find((m) => m.parent_matterspace_id === parent.id);
  const kidLine = lines.find((l) => l.includes(kid.id));
  check(kidLine.startsWith('    ') && !kidLine.startsWith('      '),
    'a sub-matter is indented one level under its parent');
  check(lines.indexOf(kidLine) > lines.indexOf(line), 'and printed after it');
}
{
  const line = lines.find((l) => l.includes(NO_CODE));
  check(line.trim().split(' | ')[1] === '-' && line.includes(NO_CODE),
    'a matter with no short_code is still addressable — its id is right there');
}
check(!tree.tree.includes(DESCRIPTION.slice(0, 40)), 'no descriptions in the default map');
check(tree.tree.includes('Litigation\n'), 'serverspaces head their branch');
check(tree.matter_count === MATTERS && tree.result_count === MATTERS,
  'the object states how many matters it is showing');
check(tree.legend.includes('name | short_code | documents | id'),
  'and how to read a line');
check(!tree.truncated, 'nothing was dropped for size at this scale');

// ---------------------------------------------------------------------------
// C. The optional arguments.
// ---------------------------------------------------------------------------
console.log('\n--- C. narrowing it ---------------------------------------------');
reset();
const litigation = await handleListMatters(supabase, { serverspace: 'Litigation' });
const inSpace = matterspaces.filter((m) => m.serverspace_id === serverspaces[0].id).length;
check(litigation.matter_count === inSpace,
  `serverspace:"Litigation" lists only that serverspace (${inSpace})`,
  `n=${litigation.matter_count}`);
check(counted.length === inSpace, 'and only counts the documents of matters it will show',
  `${counted.length} count queries`);

const bySpaceId = await handleListMatters(supabase, { serverspace: serverspaces[1].id });
check(bySpaceId.matter_count > 0 && bySpaceId.tree.startsWith('Appeals'),
  'a serverspace id works as well as its name');

let spaceErr = null;
try { await handleListMatters(supabase, { serverspace: 'Nowhere' }); } catch (e) { spaceErr = e; }
check(/no serverspace matching/i.test(spaceErr?.message ?? ''),
  'an unknown serverspace says so, and names the real ones',
  spaceErr?.message?.slice(0, 80));

const root = matterspaces.find((m) => !m.parent_matterspace_id && m.id !== PAUSED_ROOT);
const branch = await handleListMatters(supabase, { parent: root.short_code });
const wantBranch = 1 + matterspaces.filter((m) => m.parent_matterspace_id === root.id).length;
check(branch.matter_count === wantBranch, 'parent:"<short_code>" lists that matter and its sub-matters',
  `n=${branch.matter_count} want=${wantBranch}`);
check(branch.tree.includes(root.id), 'the branch root is on it');
const branchById = await handleListMatters(supabase, { parent: root.id });
check(branchById.matter_count === wantBranch, 'a parent UUID works too');

const TERM = 'Exhibits';
const q = await handleListMatters(supabase, { query: TERM.toLowerCase() });
const qHits = matterspaces.filter((m) => new RegExp(TERM, 'i').test(`${m.name} ${m.short_code ?? ''}`));
check(qHits.length > 0 && q.matter_count >= qHits.length,
  `query:"${TERM.toLowerCase()}" keeps the ${qHits.length} matches, case-insensitively`,
  `n=${q.matter_count}`);
check(qHits.every((m) => q.tree.includes(m.id)), 'every match is on it');
check(q.matter_count < MATTERS / 2, 'and it is much smaller than the whole map');
check(q.scope?.query === TERM.toLowerCase(), 'the answer says what it was narrowed to');
check(matterspaces.filter((m) => qHits.some((h) => h.id === m.parent_matterspace_id))
  .every((kid) => q.tree.includes(kid.id)),
  'a match brings what is under it');
const qNone = await handleListMatters(supabase, { query: 'zzzz-no-such-matter' });
check(qNone.matter_count === 0 && qNone.tree.includes('no matters'),
  'a query that matches nothing says so plainly');

const withDesc = await handleListMatters(supabase, { parent: root.short_code, include_descriptions: true });
check(withDesc.tree.includes(' :: '), 'include_descriptions adds a description to each line');
check(withDesc.tree.includes(DESCRIPTION.slice(0, 60)), 'and it is the real description');
check(withDesc.tree.includes('…'), 'trimmed to a sentence or two, with the cut marked');

console.log('\n--- C2. malformed arguments fall back, they do not throw ---------');
for (const [label, bad] of [
  ['null', null],
  ['a string', 'everything'],
  ['an array', ['litigation']],
  ['serverspace: 7', { serverspace: 7 }],
  ['parent: {}', { parent: {} }],
  ['query: []', { query: [] }],
  ['include_descriptions: "yes"', { include_descriptions: 'yes' }],
  ['format: "xml"', { format: 'xml' }],
  ['an unknown argument', { depth: 3, verbose: true }],
  ['blank strings', { serverspace: '   ', parent: '', query: '' }],
]) {
  let out = null;
  let err = null;
  try { out = await handleListMatters(supabase, bad); } catch (e) { err = e; }
  check(!err && out?.format === 'tree' && out.matter_count === MATTERS,
    `${label} → the default map`, err ? err.message : `n=${out?.matter_count}`);
}
{
  const withDescStr = await handleListMatters(supabase, { include_descriptions: 'yes' });
  check(!withDescStr.tree.includes(' :: '), 'include_descriptions only answers to a real boolean');
}

// ---------------------------------------------------------------------------
// D. format:'full' is what main returned, byte for byte.
// ---------------------------------------------------------------------------
console.log('\n--- D. the escape hatch is unchanged ----------------------------');
// main@d391c66's handleListMatters, transcribed. If this ever stops matching,
// a consumer that reads fields has been broken.
async function mainListMatters(sb) {
  const { data: matters } = await sb
    .from('matterspaces')
    .select('id, name, short_code, description, serverspace_id, parent_matterspace_id, created_at')
    .order('created_at', { ascending: false });
  const { data: spaces } = await sb.from('serverspaces').select('id, name');
  const spaceById = new Map((spaces ?? []).map((s) => [s.id, s]));
  const out = [];
  for (const m of matters) {
    const { count } = await sb.from('documents').select('id', { count: 'exact', head: true }).eq('matterspace_id', m.id);
    out.push({
      id: m.id, short_code: m.short_code, name: m.name, description: m.description,
      serverspace: spaceById.get(m.serverspace_id) ?? { id: m.serverspace_id },
      parent_matterspace_id: m.parent_matterspace_id,
      document_count: count || 0,
    });
  }
  return out;
}
const reference = await mainListMatters(supabase);
const hatch = await handleListMatters(supabase, { format: 'full' });
check(JSON.stringify(hatch) === JSON.stringify(reference),
  'format:"full" is byte-identical to main\'s output for the same rows',
  `${size(hatch)} vs ${size(reference)} chars`);
check(hatch[0].serverspace && typeof hatch[0].serverspace === 'object',
  'including the nested serverspace object every old consumer expects');

// ---------------------------------------------------------------------------
// E. The seal and the pause, in the new shape.
// ---------------------------------------------------------------------------
console.log('\n--- E. sealed and paused subtrees are not on the map -------------');
reset();
const asConnector = await callTool(supabase, 'list_matters', {}, CONNECTOR);
const kidsOf = (id) => matterspaces.filter((m) => m.parent_matterspace_id === id).map((m) => m.id);
const PAUSED_SUBTREE = [PAUSED_ROOT, ...kidsOf(PAUSED_ROOT)];
const hiddenIds = [SEALED_CHILD, ...kidsOf(SEALED_CHILD), ...PAUSED_SUBTREE];
check(!asConnector.tree.includes(SEALED_CHILD), 'the sealed sub-matter is absent');
check(!asConnector.tree.includes(PAUSED_ROOT), 'the paused matter is absent');
check(UNDER_PAUSED && !asConnector.tree.includes(UNDER_PAUSED),
  'and so is the open sub-matter UNDER the paused one (nothing under a hidden parent)');
check(asConnector.tree.includes(SEALED_PARENT),
  'while the sealed child\'s OPEN parent is still shown (a hidden child does not hide its parent)');
check(asConnector.matter_count === MATTERS - hiddenIds.length,
  'the count is the visible matters only',
  `n=${asConnector.matter_count} want=${MATTERS - hiddenIds.length}`);
check(!hiddenIds.some((id) => counted.includes(id)),
  'no hidden matter was even asked how many documents it holds — pruning happens before counting',
  counted.filter((id) => hiddenIds.includes(id)).join(', ') || 'none');
{
  const parentLine = asConnector.tree.split('\n').find((l) => l.includes(SEALED_PARENT));
  check(parentLine.trim().split(' | ')[2] === String(docCount.get(SEALED_PARENT)),
    'and the visible parent\'s count is still its own — it does not reveal the sealed child\'s documents');
}

// The same seal, asked of the escape hatch.
reset();
const fullConnector = await callTool(supabase, 'list_matters', { format: 'full' }, CONNECTOR);
check(!fullConnector.some((m) => hiddenIds.includes(m.id)),
  'format:"full" hides the same subtrees');

// A descendants walk that came back short: only the PARENT id is excluded.
// The chain walk in the handler must still hide everything under it.
reset();
const shortWalk = await handleListMatters(supabase, {}, { excludeMatterIds: new Set([SEALED_PARENT]) });
const underParent = matterspaces.filter((m) => m.parent_matterspace_id === SEALED_PARENT);
check(!shortWalk.tree.includes(SEALED_PARENT), 'excluding a parent hides the parent');
check(underParent.length > 0 && underParent.every((m) => !shortWalk.tree.includes(m.id)),
  'and every child under it, even when only the parent id was excluded',
  `${underParent.length} children`);

// A branch listing keyed to a sealed matter is refused, as any tool is.
let sealErr = null;
try {
  await callTool(supabase, 'list_matters', { parent: matterspaces[5].short_code }, CONNECTOR);
} catch (e) { sealErr = e; }
check(sealErr?.code === 'sealed_matter', 'parent:<a sealed matter> is refused outright',
  sealErr?.code ?? 'no error');

let pauseErr = null;
try {
  const paused = matterspaces.find((m) => m.id === PAUSED_ROOT);
  await callTool(supabase, 'list_matters', { parent: paused.short_code }, IN_APP);
} catch (e) { pauseErr = e; }
check(pauseErr?.code === 'ai_paused', 'parent:<a paused matter> is refused on every path',
  pauseErr?.code ?? 'no error');

console.log('\n--- E2. NEGATIVE CONTROL: the in-app path still sees the seal ----');
reset();
const inApp = await callTool(supabase, 'list_matters', {}, IN_APP);
check(inApp.tree.includes(SEALED_CHILD),
  'the in-app assistant DOES see the sealed sub-matter — the seal is about egress');
check(inApp.matter_count === MATTERS - PAUSED_SUBTREE.length,
  'it sees every matter but the paused one and everything under it',
  `n=${inApp.matter_count} want=${MATTERS - PAUSED_SUBTREE.length}`);
check(!inApp.tree.includes(PAUSED_ROOT),
  'the PAUSE, unlike the seal, hides the matter from the in-app path too');
check(counted.includes(SEALED_CHILD),
  'and the sealed child was counted here, which proves part E was not vacuous');

// ---------------------------------------------------------------------------
// F. The Record (migrations 064 / 072).
// ---------------------------------------------------------------------------
console.log('\n--- F. the ledger still gets what it needs ----------------------');
reset();
await callTool(supabase, 'list_matters', {}, CONNECTOR);
const accountRows = ledgerRows.filter((r) => r.fn === 'ledger_append_account');
const matterRows = ledgerRows.filter((r) => r.fn === 'ledger_append');
check(accountRows.length === 1, 'one account-chain row for an arg-less list_matters',
  `n=${accountRows.length}`);
check(matterRows.length === 0, 'and no row in any matter\'s Record — it enumerates, it does not read',
  `n=${matterRows.length}`);
{
  const p = accountRows[0]?.p_payload ?? {};
  check(p.scope === 'account' && p.tool === 'list_matters', 'it is the account-scoped tool.invoked row');
  check(p.result_count === MATTERS - hiddenIds.length,
    'carrying the count of what came back', `result_count=${p.result_count}`);
  check(p.matters_touched === 0, 'and touching no matter');
  const text = JSON.stringify(p);
  check(!matterspaces.some((m) => m.short_code && text.includes(m.short_code)) &&
        !matterspaces.some((m) => text.includes(m.id)),
    'counts only: no matter id and no matter name anywhere in the payload');
}
reset();
await callTool(supabase, 'list_matters', { parent: root.short_code }, CONNECTOR);
check(ledgerRows.filter((r) => r.fn === 'ledger_append').length === 1,
  'a branch listing is recorded in that matter\'s own Record instead');
check(ledgerRows.filter((r) => r.fn === 'ledger_append')[0]?.p_matter === root.id,
  'on the matter it named');

// ---------------------------------------------------------------------------
// G. The tool definition still tells the truth.
// ---------------------------------------------------------------------------
console.log('\n--- G. the description matches the server -----------------------');
const def = TOOLS.find((t) => t.name === 'list_matters');
check(/call this first/i.test(def.description), 'it still says to call this first');
check(/tree/i.test(def.description), 'it says the answer is a tree');
const props = Object.keys(def.inputSchema.properties);
check(['serverspace', 'parent', 'query', 'include_descriptions', 'format'].every((k) => props.includes(k)),
  'every argument the handler reads is declared', props.join(', '));
check(def.inputSchema.required === undefined,
  'and none of them is required — a cached tool list keeps working');
for (const k of props) {
  check(new RegExp(`\`?${k}\`?`).test(def.description) || k === 'format',
    `the description explains ${k}`);
}

// ---------------------------------------------------------------------------
// H. A workspace far bigger than any today: the map stops, and says so.
// ---------------------------------------------------------------------------
console.log('\n--- H. a workspace that still will not fit ----------------------');
{
  const before = matterspaces.length;
  for (let i = 0; i < 1400; i += 1) {
    const id = uuid(10_000 + i);
    matterspaces.push({
      id, name: `Overflow Matter Number ${i} (fiction)`, short_code: `overflow-${i}`,
      description: null, serverspace_id: serverspaces[i % serverspaces.length].id,
      parent_matterspace_id: null, ai_tier: 'A', ai_paused: false,
      created_at: new Date(Date.UTC(2020, 0, 1) + i * 3600_000).toISOString(),
    });
    docCount.set(id, i);
  }
  const huge = await handleListMatters(supabase, {});
  check(huge.truncated === true, `at ${matterspaces.length} matters the tree is cut off`);
  check(size(huge) < 90_000, 'at a size a client can still receive', `${size(huge).toLocaleString()} chars`);
  check(huge.not_shown === huge.matter_count - huge.result_count && huge.not_shown > 0,
    'it says how many matters it did not print', `${huge.not_shown} not shown`);
  check(/narrow it with serverspace, parent or query/i.test(huge.hint ?? ''),
    'and what to do about it');
  check(huge.matter_count === matterspaces.length, 'while still stating the true total');
  matterspaces.length = before;
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
