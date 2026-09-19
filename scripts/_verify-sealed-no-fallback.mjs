// A sealed matter REFUSES — it never falls back to a provider outside the
// seal. (SecureSpace Tier B; Eden's decision of 2026-09-19.)
//
//   node scripts/_verify-sealed-no-fallback.mjs
//
// Entirely OFFLINE and secret-free: `fetch` is stubbed and every request it
// sees is recorded, so each case can assert not only what the code decided
// but what it actually contacted. No .env is read, no network is touched,
// no key of any kind is needed — this is a CI harness.
//
// The claim under test, in the words the product uses: a client who seals a
// matter is promised a processing path, not a best effort. If the sealed
// route is missing or broken, the honest answer is "no answer", never a
// quiet substitution.
//
//   1. Tier B, no Bedrock credentials  → refusal, ZERO requests of any kind
//      (this is the finding of the 2026-09-19 audit: choosePen used to serve
//      Fireworks here, silently).
//   2. Tier B, Bedrock credentials     → the aws-bedrock pen, and the only
//      host ever contacted is bedrock-mantle.
//   3. Tier B, sealed pen errors       → refusal, ONE request, still only
//      bedrock-mantle. No second provider is tried.
//   4. Tier B + explicit escalate      → first-party Claude, recorded as an
//      escalation; and refused outright when the record cannot be opened.
//   5. Tier A                          → unchanged (first-party Claude).
//   6. Tier C                          → unchanged (refused, zero requests).
//   7. The /api/llm gate offline       → Tier B admits only aws-bedrock;
//      fireworks, anthropic and moonshot are 403 tier_violation.
import {
  choosePen, runAssistantStream, bedrockCredsFromEnv, AssistantRefusal, PENS,
} from '../lib/assistant-core.mjs';
import { providerAllowed, isEscalation, gateLlmRequest } from '../lib/ai-tier-policy.mjs';

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => {
  console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${JSON.stringify(d)?.slice(0, 400)}` : ''}`);
  failures++;
};

const CREDS = bedrockCredsFromEnv({
  BEDROCK_AWS_ACCESS_KEY_ID: 'AKIDTEST', BEDROCK_AWS_SECRET_ACCESS_KEY: 'testsecret',
});
const PROD = { NODE_ENV: 'production' };
const DEV = { NODE_ENV: 'development' };

// ── the witness ─────────────────────────────────────────────────────────
// Every case runs with this installed. Nothing in a sealed turn may reach a
// host that is not bedrock-mantle; several cases require that nothing is
// contacted at all.
const realFetch = globalThis.fetch;
let requests = [];
function witness(responder) {
  requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    requests.push({ url: u, host: safeHost(u), init });
    return responder(u, init);
  };
}
const restore = () => { globalThis.fetch = realFetch; };
const safeHost = (u) => { try { return new URL(u).host; } catch { return u; } };
const hosts = () => [...new Set(requests.map((r) => r.host))];
const nonBedrock = () => hosts().filter((h) => !h.startsWith('bedrock-mantle.'));

// ── a Supabase client stand-in ──────────────────────────────────────────
// Enough of the supabase-js surface for matterTierWithClient + the ledger.
// `ledgerOk: false` simulates a session row that could not be opened.
function stubSupabase({ tier = 'B', ledgerOk = true } = {}) {
  const inserted = [];
  const table = (name) => {
    const q = {
      _name: name,
      select() { return q; },
      eq() { return q; },
      in() { return q; },
      order() { return q; },
      limit() { return Promise.resolve({ data: [], error: null }); },
      maybeSingle() {
        if (name === 'matterspaces') {
          return Promise.resolve({ data: { id: 'm-1', parent_matterspace_id: null, ai_tier: tier }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      single() { return Promise.resolve({ data: null, error: { message: 'stub' } }); },
      insert(row) {
        inserted.push({ table: name, row });
        const ins = {
          select() { return ins; },
          single() {
            if (name === 'ai_sessions' && ledgerOk) {
              return Promise.resolve({ data: { id: 'sess-1', matterspace_id: 'm-1', tier, status: 'open' }, error: null });
            }
            return Promise.resolve({ data: null, error: { message: 'ledger unavailable (stub)' } });
          },
          then(res) { return Promise.resolve({ data: null, error: null }).then(res); },
        };
        return ins;
      },
      update() { return { eq: () => Promise.resolve({ data: null, error: null }), then: (r) => Promise.resolve({ error: null }).then(r) }; },
    };
    return q;
  };
  return { from: table, rpc: async () => ({ data: [], error: null }), _inserted: inserted };
}

// Run one turn and collect the events, exactly as the HTTP layer would.
async function run(opts) {
  const events = [];
  const result = await runAssistantStream({
    supabase: opts.supabase ?? stubSupabase({ tier: opts.tier ?? 'B' }),
    anthropicKey: 'ak',
    fireworksKey: 'fk',           // present on purpose: it must select nothing
    bedrockCreds: opts.bedrockCreds ?? null,
    openaiApiKey: 'ok',
    messages: [{ role: 'user', content: 'What does the seal cover?' }],
    matterId: 'm-1',
    emit: (ev) => events.push(ev),
    escalate: opts.escalate,
  });
  return { events, result, ev: (t) => events.find((e) => e.type === t) };
}

const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\ndata: [DONE]\n\n';
const ONE_LINE_ANSWER = sse([
  { choices: [{ index: 0, delta: { role: 'assistant', content: 'Sealed and ready.' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 11, completion_tokens: 4 } },
]);

// ── 1. Tier B with no sealed pen → refusal, nothing contacted ───────────
console.log('Tier B, Bedrock credentials ABSENT');
try {
  choosePen({ tier: 'B', anthropicKey: 'ak', fireworksKey: 'fk', env: PROD });
  fail('choosePen served a pen for a sealed matter with no sealed route');
} catch (err) {
  if (err instanceof AssistantRefusal && err.code === 'sealed_pen_unavailable') {
    pass('choosePen refuses (sealed_pen_unavailable) even with anthropic AND fireworks keys present');
  } else fail('wrong refusal', { code: err?.code, message: err?.message });
}
{
  const msg = (() => { try { choosePen({ tier: 'B', anthropicKey: 'ak', env: PROD }); } catch (e) { return e.message; } })();
  if (/Nothing was sent/.test(msg) && !/Developer note/.test(msg)) pass('production refusal is plain language, no developer hint');
  else fail('production refusal copy', msg);
  const devMsg = (() => { try { choosePen({ tier: 'B', anthropicKey: 'ak', env: DEV }); } catch (e) { return e.message; } })();
  if (/Developer note/.test(devMsg) && /BEDROCK_AWS_ACCESS_KEY_ID/.test(devMsg)) {
    pass('outside production the refusal names the missing credentials');
  } else fail('dev refusal copy', devMsg);
}
witness(async (u) => { throw new Error(`a provider was contacted: ${u}`); });
try {
  const { ev } = await run({ tier: 'B' });
  const e = ev('error');
  if (e?.code === 'sealed_pen_unavailable') pass('the turn ends in a refusal event the UI already renders');
  else fail('expected a sealed_pen_unavailable error event', e);
  if (!ev('session')) pass('no session event — no pen was ever announced');
  else fail('a pen was announced for a matter with no sealed route', ev('session'));
  if (requests.length === 0) pass('egress witness: ZERO requests — no provider was contacted at all');
  else fail('requests were made', hosts());
} finally { restore(); }

// ── 2. Tier B with the sealed pen → Bedrock, and only Bedrock ───────────
console.log('\nTier B, Bedrock credentials PRESENT');
{
  const pen = choosePen({ tier: 'B', anthropicKey: 'ak', fireworksKey: 'fk', bedrockCreds: CREDS, env: PROD });
  if (pen.provider === 'aws-bedrock' && pen.escalation === false) pass(`choosePen → aws-bedrock / ${pen.model}`);
  else fail('sealed pen', pen);
}
witness(async () => new Response(ONE_LINE_ANSWER, { status: 200 }));
try {
  const { ev, result } = await run({ tier: 'B', bedrockCreds: CREDS });
  const s = ev('session');
  if (s?.provider === 'aws-bedrock' && s?.tier === 'B' && s?.escalation === false) pass('session event announces the sealed pen');
  else fail('session event', s);
  if (!ev('error') && result.provider === 'aws-bedrock') pass('the turn completes on the sealed pen');
  else fail('turn did not complete', { error: ev('error'), result });
  if (nonBedrock().length === 0 && hosts().length === 1) pass(`egress witness: only ${hosts()[0]} was contacted`);
  else fail('unexpected egress hosts', hosts());
} finally { restore(); }

// ── 3. the sealed pen fails → refusal, not a second provider ────────────
console.log('\nTier B, the sealed pen REJECTS the request (403)');
witness(async () => new Response('{"message":"not available for this account"}', { status: 403 }));
try {
  const { ev } = await run({ tier: 'B', bedrockCreds: CREDS });
  const e = ev('error');
  if (e?.code === 'sealed_pen_error') pass('a provider failure inside the seal becomes a refusal (sealed_pen_error)');
  else fail('expected sealed_pen_error', e);
  if (e && !/Nothing was sent/.test(e.message ?? '')) pass('the copy does not claim "nothing was sent" — the sealed provider WAS reached');
  else fail('refusal overclaims', e?.message);
  if (e && /never handed to a provider outside the seal/.test(e.message ?? '')) pass('the copy says what is actually guaranteed');
  else fail('refusal copy', e?.message);
  if (requests.length === 1) pass('exactly one request — no retry onto another pen');
  else fail('request count', { count: requests.length, hosts: hosts() });
  if (nonBedrock().length === 0) pass('egress witness: no non-Bedrock host after the failure');
  else fail('fell back to another provider', nonBedrock());
} finally { restore(); }

// ── 4. the one way out: an explicit, recorded escalation ────────────────
console.log('\nTier B + escalate:true (the only permitted exit from the seal)');
{
  const pen = choosePen({ tier: 'B', anthropicKey: 'ak', bedrockCreds: CREDS, escalate: true, env: PROD });
  if (pen.provider === 'anthropic' && pen.escalation === true) pass('explicit escalate → first-party Claude, flagged escalation:true');
  else fail('escalation pen', pen);
  const implicit = choosePen({ tier: 'B', anthropicKey: 'ak', bedrockCreds: CREDS, escalate: 'yes', env: PROD });
  if (implicit.provider === 'aws-bedrock') pass('a truthy-but-not-true escalate does NOT leave the seal');
  else fail('escalate must be literally true', implicit);
  const opus = choosePen({ tier: 'B', anthropicKey: 'ak', bedrockCreds: { ...CREDS, model: 'anthropic.claude-opus-5' }, escalate: true, env: PROD });
  if (opus.provider === 'aws-bedrock' && opus.escalation === false) pass('escalate is moot when the sealed pen is already frontier Claude');
  else fail('escalation should stay inside the seal', opus);
}
witness(async (u) => { throw new Error(`a provider was contacted: ${u}`); });
try {
  const { ev } = await run({ tier: 'B', bedrockCreds: CREDS, escalate: true, supabase: stubSupabase({ tier: 'B', ledgerOk: false }) });
  const e = ev('error');
  if (e?.code === 'escalation_unrecorded') pass('an escalation that cannot be recorded is refused, not performed');
  else fail('expected escalation_unrecorded', e);
  if (requests.length === 0) pass('egress witness: ZERO requests — the unrecordable escalation never left');
  else fail('the escalation went ahead', hosts());
} finally { restore(); }

// ── 5/6. the other tiers are untouched ──────────────────────────────────
console.log('\nTier A and Tier C unchanged');
{
  const a = choosePen({ tier: 'A', anthropicKey: 'ak', fireworksKey: 'fk', bedrockCreds: CREDS, env: PROD });
  if (a.provider === 'anthropic' && a.model === PENS.anthropic.model && a.escalation === false) {
    pass('Tier A → first-party Claude; Bedrock creds do not hijack it');
  } else fail('tier A pen', a);
  const none = choosePen({ tier: null, anthropicKey: 'ak', env: PROD });
  if (none.provider === 'anthropic') pass('no matter bound → Tier A rules, unchanged');
  else fail('unbound pen', none);
}
witness(async (u) => { throw new Error(`a provider was contacted: ${u}`); });
try {
  const { ev } = await run({ tier: 'C', bedrockCreds: CREDS, supabase: stubSupabase({ tier: 'C' }) });
  const e = ev('error');
  if (e?.code === 'silo_not_connected') pass('Tier C refused before any pen (silo_not_connected)');
  else fail('tier C', e);
  if (requests.length === 0) pass('egress witness: ZERO requests on a Silo matter');
  else fail('a Silo matter contacted something', hosts());
} finally { restore(); }

// ── 7. the policy table and the /api/llm gate, offline ──────────────────
console.log('\nTier policy + the /api/llm gate');
for (const p of ['fireworks', 'anthropic', 'openai', 'google', 'xai', 'moonshot']) {
  if (providerAllowed('B', p) === false) pass(`providerAllowed('B','${p}') is false`);
  else fail(`'${p}' is still in the Tier B set`);
}
if (providerAllowed('B', 'aws-bedrock')) pass("providerAllowed('B','aws-bedrock') is true — the one sealed route");
else fail('the sealed route is not allowed');
if (providerAllowed('B', 'anthropic', { escalation: true })) pass('anthropic on B passes ONLY when the caller proves a recorded escalation');
else fail('recorded escalation should be within policy');
if (providerAllowed('B', 'fireworks', { escalation: true }) === false) pass('an escalation does not open the door to any other provider');
else fail('escalation opened fireworks');
if (isEscalation('B', 'anthropic') && !isEscalation('A', 'anthropic')) pass('isEscalation still flags first-party Claude on a sealed matter');
else fail('isEscalation');
for (const p of ['anthropic', 'openai', 'aws-bedrock', 'fireworks']) {
  if (providerAllowed('C', p) === false) continue;
  fail(`Tier C admitted ${p}`);
}
pass('Tier C admits nothing (unchanged)');
if (providerAllowed('A', 'openai') && providerAllowed('A', 'anthropic') && providerAllowed('A', 'fireworks')) {
  pass('Tier A set unchanged');
} else fail('tier A set changed');

// The gate as /api/llm calls it, with Supabase answered by the witness.
const SB = 'https://stub.supabase.co';
const gateFetch = (tier) => async (url) => {
  const u = String(url);
  if (u.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: 'user-1' }), { status: 200 });
  if (u.includes('/rest/v1/matterspaces')) {
    return new Response(JSON.stringify([{ id: 'm-1', parent_matterspace_id: null, ai_tier: tier }]), { status: 200 });
  }
  throw new Error(`gate contacted an unexpected host: ${u}`);
};
const gate = (tier, provider) => gateLlmRequest({
  supabaseUrl: SB, anonKey: 'anon', serviceKey: 'srk',
  bearer: 'Bearer token', provider, matterId: 'm-1',
});
for (const [tier, provider, want] of [
  ['B', 'aws-bedrock', 'ok'],
  ['B', 'fireworks', 403],
  ['B', 'anthropic', 403],
  ['B', 'moonshot', 403],
  ['B', 'openai', 403],
  ['C', 'anthropic', 403],
  ['A', 'openai', 'ok'],
  ['A', 'anthropic', 'ok'],
]) {
  witness(gateFetch(tier));
  try {
    const g = await gate(tier, provider);
    if (want === 'ok') {
      if (g.ok === true) pass(`gate: tier ${tier} + ${provider} → allowed`);
      else fail(`tier ${tier} + ${provider} should pass the gate`, g);
    } else if (g.ok === false && g.status === 403 && g.error === 'tier_violation') {
      pass(`gate: tier ${tier} + ${provider} → 403 tier_violation`);
    } else fail(`tier ${tier} + ${provider} should be refused`, g);
    if (nonBedrock().some((h) => h !== 'stub.supabase.co')) fail('the gate contacted a provider', hosts());
  } catch (err) {
    fail(`gate threw for ${tier}/${provider}`, { message: err?.message });
  } finally { restore(); }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures ? 1 : 0);
