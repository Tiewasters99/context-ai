// The in-app assistant on a turn NOT served by the sealed pen is outside the
// seal, exactly as a connector is.
//
//   node scripts/_verify-seal-outside-pen.mjs
//
// Offline: Supabase is a stub that records what each query asked for.
//
// Found 2026-10-11 in the sealed Patel walkthrough: the Orchestrator panel on
// a sealed matter's Discovery page was not bound to the matter, ran on
// first-party Claude (Tier A), and its "search everywhere" covered every
// matter RLS shows — sealed ones included — because only connectors set
// `sealConnector`. assistant-core now passes `sealOutsidePen: !sealedRun`.
//
//   1. callTool with sealOutsidePen: search with no matter never names the
//      sealed matter (or its sub-matter) to search_passages.
//   2. callTool with sealOutsidePen: a sealed matter by name is refused, in
//      the assistant's words (not "external connectors").
//   3. without the flag (a sealed-pen turn) the sealed matter is searched —
//      which is also exactly what an unbound Tier-A turn did before the fix.
// The wiring in runAssistantStream (sealOutsidePen: !sealedRun) is not
// exercised here: a Tier-A turn needs the Anthropic SDK on the wire.
import { callTool, SealedMatterError } from '../lib/mcp-core.mjs';

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => {
  console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${JSON.stringify(d)?.slice(0, 400)}` : ''}`);
  failures++;
};

const OPEN = '11111111-1111-4111-8111-111111111111';
const SEALED = '22222222-2222-4222-8222-222222222222';
const SEALED_CHILD = '33333333-3333-4333-8333-333333333333';
const MATTERS = [
  { id: OPEN, name: 'Open matter', ai_tier: 'A', parent_matterspace_id: null },
  { id: SEALED, name: 'Sealed matter', ai_tier: 'B', parent_matterspace_id: null },
  { id: SEALED_CHILD, name: 'Sealed child', ai_tier: null, parent_matterspace_id: SEALED },
];

// A permissive supabase-js stand-in: every chain resolves, matterspaces
// answer from MATTERS (honouring .in('ai_tier', …) and .eq('id', …)), and
// RPCs are recorded.
function stub() {
  const rpcs = [];
  const from = (table) => {
    const filters = [];
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
      is() { return q; }, neq() { return q; }, not() { return q; }, or() { return q; }, ilike() { return q; },
      gte() { return q; }, lte() { return q; }, contains() { return q; },
      eq(col, v) { filters.push((r) => r[col] === v); return q; },
      in(col, vs) { filters.push((r) => vs.includes(r[col])); return q; },
      insert() { return { select: () => ({ single: async () => ({ data: null, error: null }) }), then: (r) => Promise.resolve({ error: null }).then(r) }; },
      update() { return q; },
      rows() { return table === 'matterspaces' ? MATTERS.filter((r) => filters.every((f) => f(r))) : []; },
      async maybeSingle() { return { data: q.rows()[0] ?? null, error: null }; },
      async single() { const d = q.rows()[0]; return d ? { data: d, error: null } : { data: null, error: { message: 'none' } }; },
      then(res, rej) { return Promise.resolve({ data: q.rows(), error: null }).then(res, rej); },
    };
    return q;
  };
  const rpc = async (name, params = {}) => {
    rpcs.push({ name, params });
    if (name === 'matterspace_descendants') {
      const root = params.p_root;
      return { data: [{ id: root }, ...MATTERS.filter((m) => m.parent_matterspace_id === root).map((m) => ({ id: m.id }))], error: null };
    }
    return { data: [], error: null };
  };
  return { from, rpc, rpcs };
}

const searched = (sb) => sb.rpcs.filter((r) => r.name === 'search_passages').flatMap((r) => r.params.p_matterspace_ids ?? []);

console.log('callTool, turn outside the seal (sealOutsidePen: true)');
{
  const sb = stub();
  try {
    await callTool(sb, 'search', { q: 'Iyer' }, { sealOutsidePen: true });
    const ids = searched(sb);
    if (ids.includes(OPEN) && !ids.includes(SEALED) && !ids.includes(SEALED_CHILD)) {
      pass('search everywhere covers the open matter and neither the sealed matter nor its sub-matter');
    } else fail('search scope', ids);
  } catch (err) { fail('search threw', err.message); }

  try {
    await callTool(stub(), 'list_matter_contents', { matter: SEALED }, { sealOutsidePen: true });
    fail('a sealed matter named by an outside-the-seal turn was not refused');
  } catch (err) {
    if (err instanceof SealedMatterError || err?.code === 'sealed_matter') pass('a sealed matter named directly is refused (sealed_matter)');
    else fail('wrong refusal', err.message);
    if (/runs outside the seal/.test(err.message) && !/external connectors/.test(err.message)) {
      pass('in the assistant\'s words, not the connector\'s');
    } else fail('refusal wording', err.message);
  }
}

console.log('\ncallTool, turn served by the sealed pen (no flag)');
{
  const sb = stub();
  try {
    await callTool(sb, 'search', { q: 'Iyer', matter: SEALED }, {});
    const ids = searched(sb);
    if (ids.includes(SEALED)) pass('the sealed matter is searched inside the seal, as before');
    else fail('sealed-pen search scope', ids);
  } catch (err) { fail('sealed-pen search threw', err.message); }
  const before = stub();
  await callTool(before, 'search', { q: 'Iyer' }, {});
  if (searched(before).includes(SEALED)) {
    pass('(the bug) with no flag, search everywhere includes the sealed matter — what an unbound Tier-A turn got');
  } else fail('expected the unflagged all-matters search to include the sealed matter', searched(before));
}

console.log('\ncallTool, connectors unchanged');
try {
  await callTool(stub(), 'list_matter_contents', { matter: SEALED }, { sealConnector: true });
  fail('connector reached a sealed matter');
} catch (err) {
  if (/external connectors/.test(err.message)) pass('a connector is still refused in the connector\'s words');
  else fail('connector refusal wording', err.message);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures ? 1 : 0);
