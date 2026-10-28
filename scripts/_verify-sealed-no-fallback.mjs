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
//   2. Tier B, Bedrock credentials     → the aws-bedrock pen (Opus 4.6 on
//      bedrock-runtime by default since 2026-10-20), and the only host ever
//      contacted is that one Bedrock endpoint.
//   3. Tier B, sealed pen errors       → refusal, ONE request, still only
//      Bedrock. No second provider is tried.
//   4. Tier B + escalate:true          → ignored (removed 2026-10-28): still
//      the Bedrock pen, and nothing but Bedrock is contacted.
//   5. Tier A                          → unchanged (first-party Claude).
//   6. Tier C                          → unchanged (refused, zero requests).
//   7. The /api/llm gate offline       → Tier B admits only aws-bedrock;
//      fireworks, anthropic and moonshot are 403 tier_violation.
import {
  choosePen, runAssistantStream, bedrockCredsFromEnv, AssistantRefusal, PENS,
} from '../lib/assistant-core.mjs';
import { providerAllowed, isEscalation, gateLlmRequest } from '../lib/ai-tier-policy.mjs';
import { eventStreamBody, isRuntimeInvoke } from './_bedrock-eventstream.mjs';

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => {
  console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${JSON.stringify(d)?.slice(0, 400)}` : ''}`);
  failures++;
};

const CREDS = bedrockCredsFromEnv({
  BEDROCK_AWS_ACCESS_KEY_ID: 'AKIDTEST', BEDROCK_AWS_SECRET_ACCESS_KEY: 'testsecret',
});
// The rounds-budget cases (6b) script the OpenAI-compatible chat shape, so
// they pin the chat-route pen; everything else runs the default pen.
const KIMI_CREDS = { ...CREDS, model: 'moonshotai.kimi-k2.5' };
const PROD = { NODE_ENV: 'production' };
const DEV = { NODE_ENV: 'development' };

// ── the witness ─────────────────────────────────────────────────────────
// Every case runs with this installed. Nothing in a sealed turn may reach a
// host that is not Bedrock (bedrock-runtime or bedrock-mantle, our own
// account); several cases require that nothing is
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
const nonBedrock = () => hosts().filter((h) => !h.startsWith('bedrock-mantle.') && !h.startsWith('bedrock-runtime.'));

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
// The same answer from the default pen: Messages events in event-stream frames.
const RUNTIME_ONE_LINE = () => eventStreamBody([
  { type: 'message_start', message: { usage: { input_tokens: 11, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sealed and ready.' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
  { type: 'message_stop' },
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
witness(async (u) => new Response(isRuntimeInvoke(u) ? RUNTIME_ONE_LINE() : ONE_LINE_ANSWER, { status: 200 }));
try {
  const { ev, result } = await run({ tier: 'B', bedrockCreds: CREDS });
  const s = ev('session');
  if (s?.provider === 'aws-bedrock' && s?.tier === 'B' && s?.escalation === false) pass('session event announces the sealed pen');
  else fail('session event', s);
  if (!ev('error') && result.provider === 'aws-bedrock') pass('the turn completes on the sealed pen');
  else fail('turn did not complete', { error: ev('error'), result });
  if (nonBedrock().length === 0 && hosts().length === 1) pass(`egress witness: only ${hosts()[0]} was contacted`);
  else fail('unexpected egress hosts', hosts());
  if (hosts()[0] === 'bedrock-runtime.us-east-1.amazonaws.com') pass('the default sealed pen is the classic runtime in us-east-1 (Opus 4.6)');
  else fail('default sealed host', hosts());
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

// ── 4. there is no way out: a stray escalate is ignored ─────────────────
// Eden, 2026-10-28: "Remove escalate." A sealed turn never leaves the seal,
// whatever the request body says.
console.log('\nTier B + escalate:true (ignored: there is no exit from the seal)');
{
  for (const model of [CREDS.model, 'anthropic.claude-opus-5']) {
    const pen = choosePen({ tier: 'B', anthropicKey: 'ak', bedrockCreds: { ...CREDS, model }, escalate: true, env: PROD });
    if (pen.provider === 'aws-bedrock' && pen.escalation === false) pass(`escalate:true with ${model} → still the Bedrock pen`);
    else fail('escalate must be ignored', pen);
  }
}
witness(async () => new Response('{"type":"error","error":{"message":"bad request"}}', {
  status: 400, headers: { 'content-type': 'application/json' },
}));
try {
  const { ev } = await run({ tier: 'B', bedrockCreds: CREDS, escalate: true });
  const e = ev('error');
  if (e?.code === 'sealed_pen_error') pass('a failed turn that asked to escalate is a sealed-pen refusal');
  else fail('expected sealed_pen_error', e);
  if (nonBedrock().length === 0) pass('egress witness: only Bedrock was contacted');
  else fail('left the seal', nonBedrock());
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

// ── 6b. a broad question that uses up every search round ────────────────
// The 2026-10-11 Patel walkthrough: "the three most important things Iyer
// said, with cites" ran out of rounds, the last searches' results were never
// read, the user got "(I reached the step limit…)" and no answer — and saw
// the model's "Let me search…" narration. Now: the sealed budget is larger,
// one more round with tool use switched off writes the answer, and the
// narration from search rounds never reaches the user or the record.
console.log('\nTier B, a broad question that spends the whole search budget');
{
  const toolRound = (n) => sse([
    { choices: [{ index: 0, delta: { role: 'assistant', content: `Let me search for Iyer (${n})… ` } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${n}`, type: 'function', function: { name: 'list_matters', arguments: '{}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ]);
  const FINAL = 'Iyer said three things that matter (16:1-11).';
  const finalAnswer = sse([
    { choices: [{ index: 0, delta: { role: 'assistant', content: FINAL } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ]);
  const bodies = [];
  // The model keeps asking for tools until it is told it cannot.
  witness(async (u, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return new Response(body.tool_choice === 'none' ? finalAnswer : toolRound(bodies.length), { status: 200 });
  });
  try {
    const { events, result, ev } = await run({ tier: 'B', bedrockCreds: KIMI_CREDS });
    const shown = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    const finals = bodies.filter((b) => b.tool_choice === 'none');
    if (!ev('error') && !result.withheld) pass('the turn completes — no error, nothing withheld');
    else fail('turn failed', { error: ev('error'), result });
    if (bodies.length === 13 && finals.length === 1 && bodies[12].tool_choice === 'none') {
      pass('12 search rounds, then exactly one final round with tool use switched off');
    } else fail('round count', { requests: bodies.length, finals: finals.length });
    if (finals[0] && /SEARCH BUDGET USED/.test(finals[0].messages[0].content) && Array.isArray(finals[0].tools) && finals[0].tools.length) {
      pass('the final round is told why, and still declares the tools its history refers to');
    } else fail('final round request shape', finals[0] && { system: finals[0].messages[0].content.slice(-200), tools: finals[0].tools?.length });
    if (finals[0] && finals[0].messages.filter((m) => m.role === 'tool').length === 12) {
      pass('the final round sees all 12 rounds of search results');
    } else fail('final round history', finals[0]?.messages.map((m) => m.role));
    if (shown === FINAL) pass('the user sees the answer and only the answer');
    else fail('text shown to the user', shown);
    if (!/Let me search/.test(shown) && !/step limit/.test(shown)) pass('no search narration, no step-limit dead end');
    else fail('narration or step-limit text leaked', shown);
    if (nonBedrock().length === 0) pass('egress witness: only Bedrock across all 13 rounds');
    else fail('unexpected egress hosts', hosts());
  } finally { restore(); }

  // The final round still asks for a tool anyway (or says nothing): the tool
  // is not run, and the user gets a plain sentence instead of silence.
  bodies.length = 0;
  witness(async (u, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return new Response(toolRound(bodies.length), { status: 200 });
  });
  try {
    const { events, ev } = await run({ tier: 'B', bedrockCreds: KIMI_CREDS });
    const shown = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    if (bodies.length === 13) pass('a tool call on the final round is not run — no 14th request');
    else fail('request count when the final round ignores tool_choice', bodies.length);
    if (!ev('error') && /ran out of search steps/.test(shown) && !/Let me search/.test(shown)) {
      pass('the user is told plainly the steps ran out, without the earlier narration');
    } else fail('fallback text', { shown, error: ev('error') });
  } finally { restore(); }

  // Slow rounds: the clock, not the round count, ends the search. Each
  // request advances a fake clock 40 s; past SEARCH_DEADLINE_MS (210 s) the
  // next round must be the final one, well inside the 300 s function limit.
  bodies.length = 0;
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  witness(async (u, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    fakeNow += 40_000;
    return new Response(body.tool_choice === 'none' ? finalAnswer : toolRound(bodies.length), { status: 200 });
  });
  try {
    const { events, ev } = await run({ tier: 'B', bedrockCreds: KIMI_CREDS });
    const shown = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    const last = bodies[bodies.length - 1];
    if (!ev('error') && shown === FINAL && last?.tool_choice === 'none' && bodies.length < 13) {
      pass(`slow rounds: the clock ends the search after ${bodies.length - 1} rounds and the answer is still written`);
    } else fail('deadline', { requests: bodies.length, shown, lastToolChoice: last?.tool_choice });
  } finally { restore(); Date.now = realNow; }

  // The provider rejects the final round outright: a finished search is not
  // turned into a sealed-pen refusal.
  bodies.length = 0;
  witness(async (u, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.tool_choice === 'none') return new Response('{"message":"tool_choice not supported"}', { status: 400 });
    return new Response(toolRound(bodies.length), { status: 200 });
  });
  try {
    const { events, ev } = await run({ tier: 'B', bedrockCreds: KIMI_CREDS });
    const shown = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    if (!ev('error') && /ran out of search steps/.test(shown)) pass('a rejected final round ends in the plain sentence, not a refusal');
    else fail('rejected final round', { shown, error: ev('error') });
  } finally { restore(); }
}

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
