// A sealed meeting's transcript never leaves the seal — and, since 2026-09-20,
// a sealed meeting still gets an ANSWER, from the pen inside the seal.
//
//   node scripts/_verify-sealed-meetings.mjs
//
// Entirely OFFLINE and secret-free: no .env is read, `fetch` is replaced by a
// witness that answers for Supabase and for bedrock-mantle and records every
// request, and the two endpoint handlers are driven directly with a fake
// req/res. Every key in this file is a fake string. CI-ready — exits non-zero
// on failure.
//
// PART ONE (PR #162) — the leak. /api/meeting-chat and /api/meeting-flag both
// sent a meeting's VERBATIM transcript to first-party Anthropic. Both read the
// matter's tier and both acted on it only for Tier C; /api/meeting-flag did it
// on a 90-second timer, so the leak ran unprompted for as long as the meeting.
//
//   1. Tier B          → first-party Anthropic is never contacted.
//   2. Tier C          → refused.
//   3. Tier unreadable → refused. So is a meeting row that does not resolve.
//   4. Tier A          → EXACTLY the request the routes made before: same
//                        model, system blocks, transcript wrapper, tools.
//   5. No matter bound → unchanged, open.
//   6. The policy      → providerAllowed('B','anthropic') is false.
//
// PART TWO (2026-09-20) — Eden's decision: "sealed chat should be answered by
// Kimi with whatever agentic harness Kimi can run inside the sealed space."
// A Tier-B meeting is no longer refused; it is answered by the sealed pen
// through lib/assistant-core.mjs's own agentic loop.
//
//   7.  Sealed + pen present → EXACTLY bedrock-mantle is contacted, SigV4
//                        signed, transcript included, in-seal tools only, no
//                        web_search, and zero requests to any other provider.
//   8.  Sealed + no creds → refusal (503 sealed_pen_unavailable), zero
//                        provider requests, and the refusal is still RECORDED.
//   9.  Sealed + pen 403 → refusal (502 sealed_pen_error), exactly ONE request.
//   10. Over-long transcript → the most recent window, DISCLOSED in the answer.
//   11. The record    → ai_sessions + ai_messages, with model, provider,
//                        tokens and cost: a sealed meeting leaves the same
//                        record as a sealed chat.
//   12. Metering      → priced at the sealed pen, not at Opus; a refusal is
//                        not charged at all.
//   13. meeting-flag  → STILL quiet on a sealed matter, even with the pen
//                        configured. The decision covers the question a person
//                        asks, not a timer.
//   14. Negative control → main's handler, run against these expectations,
//                        fails them.

// ── env, BEFORE the handlers are imported ────────────────────────────────
// The handlers read these at module scope. Set here so the harness is
// deterministic wherever it runs, and so a real key that happens to be in the
// environment is overwritten rather than used.
const SUPABASE_URL = 'https://stub.supabase.test';
const SUPA_HOST = 'stub.supabase.test';
const BEDROCK_HOST = 'bedrock-mantle.us-east-1.api.aws';
process.env.VITE_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.VITE_SUPABASE_ANON_KEY = 'anon-stub-not-a-key';
process.env.ANTHROPIC_API_KEY = 'sk-ant-stub-not-a-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-stub-not-a-key';
delete process.env.CLAUDE_MODEL;
delete process.env.CLAUDE_FLAG_MODEL;
delete process.env.BEDROCK_MODEL;
delete process.env.OPENAI_API_KEY;

const { default: meetingChat } = await import('../api/meeting-chat.mjs');
const { default: meetingFlag } = await import('../api/meeting-flag.mjs');
const { meetingModelDecision, meetingRefusalMessage } = await import('../lib/meeting-seal.mjs');
const { providerAllowed } = await import('../lib/ai-tier-policy.mjs');
const { estimateLlmCents } = await import('../lib/usage-prices.mjs');
const { transcriptWindow, windowNotice, buildSealedMeetingMessages, SEALED_PEN_CONTEXT_TOKENS } =
  await import('../lib/meeting-sealed-chat.mjs');

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => {
  console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${JSON.stringify(d)?.slice(0, 400)}` : ''}`);
  failures++;
};
const check = (cond, m, d) => (cond ? pass(m) : fail(m, d));
const skip = (m) => console.log(`  SKIP  ${m}`);

// A transcript long enough for /api/meeting-flag's 200-character floor, and
// recognisable if it ever shows up somewhere it should not.
const TRANSCRIPT = [
  'Reyes: We can commit to the March 14 delivery date if the escrow closes first.',
  'Calder: Our board approved 2.4 million, not 3.1 — that number was never agreed.',
  'Reyes: I have the signed term sheet in front of me and it says three point one.',
  'Calder: Then one of us is reading a different document, and we should stop here.',
].join('\n');

// A meeting longer than the sealed pen can hold. The first and last lines are
// unique so the harness can prove which part travelled.
const LONG_FIRST = 'Reyes: OPENING-MARKER — this is the first thing anyone said today.';
const LONG_LAST = 'Calder: CLOSING-MARKER — and that is where we should leave it.';
const LONG_TRANSCRIPT = [
  LONG_FIRST,
  ...Array.from({ length: 9_000 }, (_, i) => `Speaker ${i % 3}: Filler line ${i} — routine discussion of the schedule, the budget and the open items.`),
  LONG_LAST,
].join('\n');

// ── the witness ──────────────────────────────────────────────────────────
// Installed for every case. It answers as Supabase (so the real supabase-js
// client, and therefore the real tier walk and the real ledger writes, run
// unmodified) and as bedrock-mantle, and records every request. A sealed case
// must show no host but Supabase and — when a pen is configured — bedrock.
const realFetch = globalThis.fetch;
let requests = [];
let world = {};

function install(w = {}) {
  world = { tier: 'B', meeting: 'bound', bedrock: 'absent', meter: 'allow', ...w };
  requests = [];
  if (world.bedrock === 'absent') {
    delete process.env.BEDROCK_AWS_ACCESS_KEY_ID;
    delete process.env.BEDROCK_AWS_SECRET_ACCESS_KEY;
    delete process.env.BEDROCK_REGION;
  } else {
    process.env.BEDROCK_AWS_ACCESS_KEY_ID = 'AKIA-STUB-NOT-A-KEY';
    process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = 'stub-secret-not-a-key';
    process.env.BEDROCK_REGION = 'us-east-1';
  }
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    const host = hostOf(url);
    requests.push({ url, host, method: (init.method || 'GET').toUpperCase(), body: init.body, headers: init.headers || {} });
    if (host === SUPA_HOST) return supabaseAnswer(url, init);
    if (host === 'api.anthropic.com') return anthropicAnswer(init);
    if (host === BEDROCK_HOST) return bedrockAnswer();
    return jsonRes(500, { error: 'unexpected_host', host });
  };
}
const restore = () => { globalThis.fetch = realFetch; };
const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u); } };
const hosts = () => [...new Set(requests.map((r) => r.host))];
const providerHosts = () => hosts().filter((h) => h !== SUPA_HOST);
const anthropicCalls = () => requests.filter((r) => r.host === 'api.anthropic.com');
const bedrockCalls = () => requests.filter((r) => r.host === BEDROCK_HOST);
const sentBody = (i = 0) => { try { return JSON.parse(anthropicCalls()[i].body); } catch { return null; } };
const bedrockBody = (i = 0) => { try { return JSON.parse(bedrockCalls()[i].body); } catch { return null; } };
const supaCalls = (path, method = 'POST') => requests.filter((r) => r.host === SUPA_HOST && r.url.includes(path) && r.method === method);
const rpcBody = (fn) => { const c = supaCalls(`/rpc/${fn}`); try { return JSON.parse(c[c.length - 1].body); } catch { return null; } };

const jsonRes = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json' },
});

function supabaseAnswer(url, init) {
  if (url.includes('/auth/v1/user')) {
    return jsonRes(200, {
      id: 'user-1', aud: 'authenticated', role: 'authenticated', email: 'stub@example.test',
      app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z',
    });
  }
  // PostgREST answers a GET with an ARRAY; maybeSingle() takes [0] client-side.
  if (url.includes('/rest/v1/meetings')) {
    if (world.meeting === 'error') return jsonRes(500, { message: 'meetings lookup failed (stub)', code: 'XX000' });
    if (world.meeting === 'missing') return jsonRes(200, []);
    if (world.meeting === 'unbound') return jsonRes(200, [{ matterspace_id: null }]);
    return jsonRes(200, [{ matterspace_id: 'matter-1' }]);
  }
  if (url.includes('/rest/v1/matterspaces')) {
    if (world.tier === 'error') return jsonRes(500, { message: 'tier lookup failed (stub)', code: 'XX000' });
    return jsonRes(200, [{ id: 'matter-1', parent_matterspace_id: null, ai_tier: world.tier }]);
  }
  // The ledger (migration 051). .insert().select().single() wants the OBJECT
  // representation PostgREST returns under the object accept header.
  if (url.includes('/rest/v1/ai_sessions')) {
    if ((init.method || 'GET').toUpperCase() === 'POST') {
      return jsonRes(201, { id: 'session-1', matterspace_id: 'matter-1', tier: world.tier, status: 'open' });
    }
    return jsonRes(200, [{ id: 'session-1', matterspace_id: 'matter-1', tier: world.tier, status: 'open' }]);
  }
  if (url.includes('/rest/v1/ai_messages')) {
    if ((init.method || 'GET').toUpperCase() === 'POST') return jsonRes(201, []);
    return jsonRes(200, []);
  }
  // The spend cap (migration 063).
  if (url.includes('/rpc/usage_consume')) {
    if (world.meter === 'refuse') {
      return jsonRes(200, { allowed: false, status: 402, reason: 'budget_exhausted', message: 'That would take this month past its limit.' });
    }
    return jsonRes(200, { allowed: true, event_id: 'usage-event-1', max_output_tokens: null, max_request_bytes: null });
  }
  if (url.includes('/rpc/usage_record_actual')) return jsonRes(200, { ok: true });
  return jsonRes(404, { message: 'no stub route', url });
}

// A minimal, valid Anthropic answer — streaming for /api/meeting-chat, a single
// message for /api/meeting-flag. 200 on purpose: an error would make the SDK
// retry and inflate the request count this harness is measuring.
function anthropicAnswer(init) {
  let streaming = false;
  try { streaming = JSON.parse(init.body)?.stream === true; } catch { /* not ours */ }
  if (!streaming) {
    return jsonRes(200, {
      id: 'msg_stub', type: 'message', role: 'assistant', model: 'claude-opus-4-7',
      content: [{ type: 'text', text: '[{"type":"contradiction","text":"2.4 vs 3.1 million.","anchor":"three point one"}]' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 40, output_tokens: 20 },
    });
  }
  const sse = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_stub', type: 'message', role: 'assistant', model: 'claude-opus-4-7',
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 40, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Push back on the 3.1 figure.' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([ev, data]) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// The sealed pen: bedrock-mantle's OpenAI-compatible chat route, the shape
// lib/assistant-core.mjs's openaiCompatTurn reads.
const SEALED_ANSWER = 'Push back on the 3.1 figure — the term sheet is the document that controls.';
function bedrockAnswer() {
  if (world.bedrock === '403') {
    return new Response(JSON.stringify({ message: 'AccessDeniedException (stub)' }), {
      status: 403, headers: { 'content-type': 'application/json' },
    });
  }
  const sse = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: SEALED_ANSWER } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 30 } },
  ].map((d) => `data: ${JSON.stringify(d)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// ── the HTTP layer, faked ────────────────────────────────────────────────
function fakeRes() {
  const chunks = [];
  return {
    statusCode: 200,
    headers: {},
    ended: false,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    flushHeaders() {},
    write(s) { chunks.push(String(s)); return true; },
    end(s) { if (s !== undefined) chunks.push(String(s)); this.ended = true; return this; },
    get text() { return chunks.join(''); },
    get json() { try { return JSON.parse(chunks.join('')); } catch { return null; } },
  };
}

async function call(handler, body) {
  const res = fakeRes();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer stub-session-jwt' },
    body,
  }, res);
  return res;
}

const chatBody = (extra = {}) => ({
  meeting_id: 'meeting-1',
  transcript: TRANSCRIPT,
  messages: [{ role: 'user', content: 'What should I push back on?' }],
  ...extra,
});
const flagBody = (extra = {}) => ({
  meeting_id: 'meeting-1',
  transcript: TRANSCRIPT,
  alreadyFlagged: [],
  ...extra,
});

// A refusal the product would be willing to show a lawyer mid-meeting: a
// sentence, not a code, and one that states what did not happen.
function readsLikeARefusal(msg) {
  if (typeof msg !== 'string' || msg.length < 80) return false;
  const m = msg.toLowerCase();
  return m.includes('nothing was sent') && (m.includes('sealed') || m.includes('silo') || m.includes('seal could not be read'));
}

try {
  // ── 1. /api/meeting-chat on a SEALED matter, NO sealed pen ────────────
  console.log('\n/api/meeting-chat — Tier B (SEALED), no sealed pen on this server');
  install({ tier: 'B', bedrock: 'absent' });
  let res = await call(meetingChat, chatBody());
  check(res.statusCode === 503, 'refused with 503 — the status /api/llm returns for the same condition', { status: res.statusCode, body: res.text });
  check(res.json?.error === 'sealed_pen_unavailable', "the code is 'sealed_pen_unavailable' — choosePen's own, not a second vocabulary", res.json);
  check(res.json?.tier === 'B', 'the refusal names the tier', res.json);
  check(readsLikeARefusal(res.json?.message), 'the refusal is a plain-language sentence, not a bare code', res.json?.message);
  check(providerHosts().length === 0, 'egress witness: ZERO provider requests — no model saw the transcript', hosts());
  check(!res.text.includes('Reyes:'), 'no part of the transcript is echoed back in the refusal');
  check(requests.every((r) => !String(r.body ?? '').includes('Reyes:')), 'the transcript appears in NO outbound request body');
  check(supaCalls('/rest/v1/ai_sessions').length === 1, 'the refusal is RECORDED — a session row was opened before the pen was chosen', supaCalls('/rest/v1/ai_sessions').length);
  check(supaCalls('/rpc/usage_consume').length === 0, 'a refusal is not charged: the meter was never called', supaCalls('/rpc/usage_consume').length);

  // ── 2. Tier C ─────────────────────────────────────────────────────────
  console.log('\n/api/meeting-chat — Tier C (SILO)');
  install({ tier: 'C', bedrock: 'ok' });
  res = await call(meetingChat, chatBody());
  check(res.statusCode === 403, 'refused with 403 — a Silo has no sealed pen either', { status: res.statusCode });
  check(readsLikeARefusal(res.json?.message), 'plain-language refusal', res.json?.message);
  check(providerHosts().length === 0, 'egress witness: ZERO provider requests — the Bedrock pen is NOT a Silo route', hosts());

  // ── 3. The tier cannot be determined ──────────────────────────────────
  console.log('\n/api/meeting-chat — the seal cannot be read (fail closed)');
  install({ tier: 'error', bedrock: 'ok' });
  res = await call(meetingChat, chatBody());
  check(res.statusCode === 403, 'a tier lookup that fails is a refusal, not a pass', { status: res.statusCode });
  check(res.json?.tier === null, 'the refusal admits the tier is unknown', res.json);
  check(providerHosts().length === 0, 'egress witness: ZERO provider requests — not even to the sealed pen', hosts());

  install({ meeting: 'error', bedrock: 'ok' });
  res = await call(meetingChat, chatBody());
  check(res.statusCode === 403 && res.json?.error === 'meeting_unresolved',
    'a meeting row that errors is a refusal (tightened 2026-09-19)', res.json);
  check(providerHosts().length === 0, 'egress witness: ZERO provider requests', hosts());

  install({ meeting: 'missing', bedrock: 'ok' });
  res = await call(meetingChat, chatBody());
  check(res.statusCode === 403 && res.json?.error === 'meeting_unresolved',
    'a meeting the caller cannot see under RLS is a refusal', res.json);
  check(providerHosts().length === 0, 'egress witness: ZERO provider requests', hosts());

  // ── 4. Tier A — byte-for-byte the request made before this change ─────
  console.log('\n/api/meeting-chat — Tier A (unchanged, pen configured or not)');
  install({ tier: 'A', bedrock: 'ok' });
  res = await call(meetingChat, chatBody());
  const sent = sentBody();
  check(anthropicCalls().length === 1, 'exactly one request to Anthropic', requests.map((r) => r.host));
  check(bedrockCalls().length === 0, 'the sealed pen does not hijack an unsealed meeting', hosts());
  check(sent?.model === 'claude-opus-4-7', 'same model as before', sent?.model);
  check(sent?.max_tokens === 8192 && sent?.thinking?.type === 'adaptive', 'same max_tokens and adaptive thinking', { max_tokens: sent?.max_tokens, thinking: sent?.thinking });
  check(Array.isArray(sent?.system) && sent.system.length === 2, 'system is still instructions + transcript', sent?.system?.length);
  check(sent?.system?.[1]?.text?.includes('<meeting_transcript>') && sent.system[1].text.includes('Reyes:'),
    'the transcript still travels in the <meeting_transcript> block', sent?.system?.[1]?.text?.slice(0, 60));
  check(sent?.system?.[1]?.cache_control?.type === 'ephemeral', 'the transcript is still an ephemeral cache breakpoint', sent?.system?.[1]?.cache_control);
  check(sent?.output_config?.effort === 'high', 'same effort setting', sent?.output_config);
  check(sent?.tools?.[0]?.name === 'web_search' && sent.tools[0].type === 'web_search_20260209' && sent.tools[0].max_uses === 5,
    'web_search is still attached on an unsealed meeting, same tool version and budget', sent?.tools);
  check(sent?.messages?.[0]?.content === 'What should I push back on?', 'the chat history is still forwarded', sent?.messages);
  check(res.text.includes('Push back on the 3.1 figure.'), 'the answer still streams back to the client', res.text);
  check(res.statusCode === 200, 'status 200', res.statusCode);
  const aMeter = rpcBody('usage_consume');
  check(aMeter?.p_kind === 'meeting' && aMeter.p_cents_estimate === estimateLlmCents({
    provider: 'anthropic', model: 'claude-opus-4-7',
    bodyText: TRANSCRIPT + JSON.stringify(chatBody().messages), maxOutputTokens: 8192,
  }), 'Tier A is still priced at Opus, on the same estimate as before', aMeter);

  // ── 5. A meeting bound to no matter ───────────────────────────────────
  console.log('\n/api/meeting-chat — nothing to seal (unchanged)');
  install({ meeting: 'unbound' });
  res = await call(meetingChat, chatBody());
  check(anthropicCalls().length === 1, 'a meeting in no matter is answered, as before', requests.map((r) => r.host));

  install({ tier: 'B', bedrock: 'ok' });
  res = await call(meetingChat, chatBody({ meeting_id: undefined }));
  check(anthropicCalls().length === 1, 'no meeting id: an unbound draft, answered as /api/llm would', requests.map((r) => r.host));

  // ── 6. /api/meeting-flag — the timer, which ran unprompted ────────────
  console.log('\n/api/meeting-flag — Tier B (SEALED)');
  install({ tier: 'B', bedrock: 'absent' });
  res = await call(meetingFlag, flagBody());
  check(res.statusCode === 200 && Array.isArray(res.json?.flags) && res.json.flags.length === 0,
    'answers with the empty flag list the client already handles', res.json);
  check(res.json?.sealed === true, 'and says plainly that it was sealed', res.json);
  check(res.json?.reason === 'tier_violation' && readsLikeARefusal(res.json?.message),
    'the reason and a plain-language sentence travel with it', res.json);
  check(providerHosts().length === 0, 'egress witness: ZERO provider requests — the 90-second leak is closed', hosts());
  check(requests.every((r) => !String(r.body ?? '').includes('Reyes:')), 'the transcript appears in NO outbound request body');

  console.log('\n/api/meeting-flag — Tier C and an unreadable seal');
  install({ tier: 'C' });
  res = await call(meetingFlag, flagBody());
  check(res.json?.sealed === true && providerHosts().length === 0, 'Tier C: no flags, zero provider requests', { body: res.json, hosts: hosts() });

  install({ tier: 'error' });
  res = await call(meetingFlag, flagBody());
  check(res.json?.sealed === true && providerHosts().length === 0, 'unreadable tier: no flags, zero provider requests', { body: res.json, hosts: hosts() });

  install({ meeting: 'missing' });
  res = await call(meetingFlag, flagBody());
  check(res.json?.reason === 'meeting_unresolved' && providerHosts().length === 0,
    'unresolvable meeting: no flags, zero provider requests', { body: res.json, hosts: hosts() });

  console.log('\n/api/meeting-flag — Tier A (unchanged)');
  install({ tier: 'A' });
  res = await call(meetingFlag, flagBody());
  const flagSent = sentBody();
  check(anthropicCalls().length === 1, 'exactly one request to Anthropic', requests.map((r) => r.host));
  check(flagSent?.model === 'claude-opus-4-7' && flagSent?.max_tokens === 1024, 'same model and ceiling as before', { model: flagSent?.model, max_tokens: flagSent?.max_tokens });
  check(flagSent?.system?.[1]?.cache_control?.type === 'ephemeral' && flagSent.system[1].text.includes('Reyes:'),
    'the transcript still rides the cached system block', flagSent?.system?.length);
  check(String(flagSent?.messages?.[0]?.content).endsWith('Return the JSON array now.'), 'the same instruction closes the user turn', flagSent?.messages?.[0]?.content?.slice(-40));
  check(res.json?.flags?.[0]?.type === 'contradiction', 'flags still come back parsed', res.json);
  check(res.json?.sealed === undefined, 'and an unsealed answer is not labelled sealed', res.json);

  // ── 7. Why it refuses first: the policy, not a second copy of it ──────
  console.log('\nThe policy behind the route');
  check(providerAllowed('B', 'anthropic') === false, "providerAllowed('B','anthropic') is false — why the sealed arm is entered at all");
  check(providerAllowed('C', 'anthropic') === false, "providerAllowed('C','anthropic') is false");
  check(providerAllowed('A', 'anthropic') === true, "providerAllowed('A','anthropic') is true — Tier A untouched");
  check(providerAllowed('B', 'aws-bedrock') === true, 'aws-bedrock on B is the one open door, and the sealed meeting now uses it');
  const thrower = { from: () => { throw new Error('client exploded'); } };
  const decision = await meetingModelDecision(thrower, 'meeting-1', { provider: 'anthropic' })
    .then((d) => d, (err) => ({ ok: 'threw', err: err.message }));
  check(decision.ok === 'threw' || decision.ok === false, 'a lookup that throws never returns "send it"', decision);
  check(meetingRefusalMessage('B') !== meetingRefusalMessage('C'), 'a Silo matter and a sealed matter are told different, true things');
  check(meetingRefusalMessage('B').includes('sealed pen answers it inside the seal'),
    'the Tier-B sentence (which the FLAG surface shows) now tells the user chat still works');
  check(meetingRefusalMessage('B', { sealedChat: false }).includes('not available on this server'),
    'and says the opposite when there is no sealed route to offer');

  // ══════════════════════════════════════════════════════════════════════
  // PART TWO — the sealed pen answers the meeting (2026-09-20)
  // ══════════════════════════════════════════════════════════════════════

  console.log('\n/api/meeting-chat — Tier B (SEALED) with the sealed pen configured');
  install({ tier: 'B', bedrock: 'ok' });
  res = await call(meetingChat, chatBody());
  const sealedSent = bedrockBody();
  check(res.statusCode === 200, 'the sealed meeting is ANSWERED, not refused', { status: res.statusCode, body: res.text.slice(0, 200) });
  check(res.text.includes(SEALED_ANSWER), "the sealed pen's answer streams back to the browser", res.text.slice(0, 120));
  check(bedrockCalls().length === 1, 'exactly one request to the sealed pen', requests.map((r) => r.host));
  check(providerHosts().length === 1 && providerHosts()[0] === BEDROCK_HOST,
    'egress witness: bedrock-mantle and NOTHING else — first-party Anthropic was never contacted', hosts());
  check(bedrockCalls()[0].url.endsWith('/v1/chat/completions'), 'the OpenAI-compatible bedrock-mantle route, as the pen table says', bedrockCalls()[0]?.url);
  check(String(bedrockCalls()[0].headers?.authorization || '').startsWith('AWS4-HMAC-SHA256'),
    'SigV4-signed with our own AWS credentials — no bearer token, no provider key', Object.keys(bedrockCalls()[0].headers || {}));
  check(sealedSent?.model === 'moonshotai.kimi-k2.5', 'answered by the sealed pen named in the pen table', sealedSent?.model);
  check(JSON.stringify(sealedSent).includes('Reyes:'), 'the transcript IS included — the meeting is what the question is about');
  check(sealedSent?.messages?.[0]?.role === 'system' && /SECURESPACE/i.test(sealedSent.messages[0].content),
    'the system prompt tells the pen it is the sealed pen on a sealed matter', sealedSent?.messages?.[0]?.content?.slice(-200));
  check(sealedSent?.messages?.[1]?.content?.includes('<meeting_transcript>'),
    'the transcript rides a framing turn, so the real question stays the last user message');
  check(sealedSent?.messages?.[sealedSent.messages.length - 1]?.content === 'What should I push back on?',
    'the last user message is the question the user actually asked', sealedSent?.messages?.[sealedSent.messages.length - 1]);

  const toolNames = (sealedSent?.tools || []).map((t) => t.function?.name);
  check(toolNames.length > 0, 'the pen is offered tools — this is the agentic harness, not a single shot', toolNames);
  check(!toolNames.includes('web_search'), 'NO web_search: the one tool that would leave the seal is not in this harness at all', toolNames);
  check(['search', 'grep', 'get_passage', 'get_outline'].every((n) => toolNames.includes(n)),
    'the in-seal retrieval tools ARE offered: search, grep, get_passage, get_outline', toolNames);
  check(!JSON.stringify(sealedSent).includes('sk-ant-'), 'no Anthropic key is anywhere near this request');

  // The record — item 2's real test: a sealed meeting leaves what a sealed chat leaves.
  console.log('\n/api/meeting-chat — the record a sealed meeting leaves');
  const msgPosts = supaCalls('/rest/v1/ai_messages');
  let assistantRow = null;
  for (const p of msgPosts) { try { const b = JSON.parse(p.body); if (b.role === 'assistant') assistantRow = b; } catch { /* ignore */ } }
  check(supaCalls('/rest/v1/ai_sessions').length === 1, 'an ai_sessions row is opened for the turn', supaCalls('/rest/v1/ai_sessions').length);
  check(msgPosts.length === 2, 'two ai_messages rows: the question and the answer', msgPosts.length);
  check(assistantRow?.model === 'moonshotai.kimi-k2.5' && assistantRow?.provider === 'aws-bedrock',
    'the row names the pen that answered — model AND provider', assistantRow);
  check(assistantRow?.input_tokens === 1200 && assistantRow?.output_tokens === 30,
    'with the token counts the pen reported', { in: assistantRow?.input_tokens, out: assistantRow?.output_tokens });
  check(typeof assistantRow?.estimated_cost === 'number' && assistantRow.estimated_cost > 0,
    "and the pen's own price — the ledger line, not just a log", assistantRow?.estimated_cost);
  check(assistantRow?.within_policy === true, 'within_policy: the sealed pen is what the tier permits', assistantRow?.within_policy);
  check(!String(assistantRow?.content?.text || '').includes('Reyes:'), 'the recorded answer is an answer, not a transcript dump');

  // Metering — item 6.
  console.log('\n/api/meeting-chat — the sealed turn is metered at the sealed pen');
  const sealedMeter = rpcBody('usage_consume');
  const penCents = estimateLlmCents({
    provider: 'aws-bedrock', model: 'moonshotai.kimi-k2.5',
    bodyText: TRANSCRIPT + JSON.stringify(chatBody().messages), maxOutputTokens: 4096,
  });
  const opusCents = estimateLlmCents({
    provider: 'anthropic', model: 'claude-opus-4-7',
    bodyText: TRANSCRIPT + JSON.stringify(chatBody().messages), maxOutputTokens: 8192,
  });
  check(sealedMeter?.p_kind === 'meeting', "still metered as a 'meeting'", sealedMeter?.p_kind);
  check(sealedMeter?.p_cents_estimate === penCents, "pre-charge: the SEALED PEN's rate, on the allowance the harness asks for", { got: sealedMeter?.p_cents_estimate, want: penCents });
  check(penCents < opusCents, 'which is less than pricing it as the Opus this route used to name', { pen: penCents, opus: opusCents });
  const actual = rpcBody('usage_record_actual');
  check(actual?.p_model === 'moonshotai.kimi-k2.5', 'reconciled against the model that actually answered', actual);
  check(actual?.p_meta?.sealed === true && actual?.p_meta?.route === 'meeting-chat', 'and the ledger row says it was a sealed meeting turn', actual?.p_meta);

  // Over budget — the pen is never asked.
  install({ tier: 'B', bedrock: 'ok', meter: 'refuse' });
  res = await call(meetingChat, chatBody());
  check(res.statusCode === 402, 'over budget: refused with the wallet\'s own status', { status: res.statusCode, body: res.text.slice(0, 120) });
  check(bedrockCalls().length === 0, 'egress witness: ZERO requests — the sealed pen was not asked either', hosts());

  // ── 9. The sealed pen rejects the request ─────────────────────────────
  console.log('\n/api/meeting-chat — the sealed pen REJECTS the request (403)');
  install({ tier: 'B', bedrock: '403' });
  res = await call(meetingChat, chatBody());
  check(res.statusCode === 502 && res.json?.error === 'sealed_pen_error',
    "a provider failure inside the seal is a refusal in the product's voice", { status: res.statusCode, body: res.json });
  check(typeof res.json?.message === 'string' && res.json.message.includes('No other model was asked'),
    'the copy promises what is actually true: no OTHER provider was asked', res.json?.message);
  check(!String(res.json?.message).includes('Nothing was sent'),
    'and does NOT claim nothing was sent — the sealed provider WAS reached', res.json?.message);
  check(bedrockCalls().length === 1, 'exactly one request — no retry, and no second pen', requests.map((r) => r.host));
  check(anthropicCalls().length === 0, 'egress witness: no fallback to Anthropic after the failure', hosts());

  // ── 10. An over-long transcript ───────────────────────────────────────
  console.log('\n/api/meeting-chat — a transcript longer than the sealed pen can hold');
  install({ tier: 'B', bedrock: 'ok' });
  res = await call(meetingChat, chatBody({ transcript: LONG_TRANSCRIPT }));
  const longSent = JSON.stringify(bedrockBody());
  check(res.statusCode === 200, 'the long meeting is still answered', res.statusCode);
  check(res.text.startsWith('This answer covers only the most recent part of the meeting'),
    'the answer OPENS by disclosing the window — never a silent truncation', res.text.slice(0, 120));
  check(/\d+ of \d+ transcript lines/.test(res.text), 'and says how much, in lines', res.text.slice(0, 200));
  check(!/\bminutes\b/.test(res.text.slice(0, 300)),
    'in lines rather than minutes, because no timestamp reaches the server (renderTranscriptForClaude drops start/end)');
  check(longSent.includes('CLOSING-MARKER'), 'the most recent part of the meeting DID travel');
  check(!longSent.includes('OPENING-MARKER'), 'the part that did not fit was NOT sent');
  check(longSent.includes('ONLY PART OF THE TRANSCRIPT IS ATTACHED'),
    'and the pen is told so too, so it cannot pretend to have read the rest');

  // The window itself, measured directly.
  console.log('\nThe window — measured against the pen, not invented');
  const wFits = transcriptWindow(TRANSCRIPT, { messages: [] });
  check(wFits.windowed === false && wFits.text === TRANSCRIPT, 'a short transcript is passed whole, untouched');
  check(windowNotice(wFits) === null, 'and nothing is disclosed, because nothing was left out');
  const wLong = transcriptWindow(LONG_TRANSCRIPT, { messages: [] });
  check(wLong.windowed === true && wLong.keptLines < wLong.totalLines, 'a long one is windowed', { kept: wLong.keptLines, total: wLong.totalLines });
  check(wLong.text.endsWith(LONG_LAST), 'the window keeps the END of the meeting — what the room is talking about now');
  check(wLong.budgetTokens < SEALED_PEN_CONTEXT_TOKENS,
    "the budget is the pen's context MINUS the system prompt, the tools, the history, the answer and one round of tool output",
    { budget: wLong.budgetTokens, context: SEALED_PEN_CONTEXT_TOKENS });
  check(windowNotice(wLong).includes('not sent and I have not read it'), 'the disclosure says plainly what was not read', windowNotice(wLong));
  const framed = buildSealedMeetingMessages({ transcript: 'x', messages: [{ role: 'user', content: 'q' }], windowed: false });
  check(framed[0].role === 'user' && framed[framed.length - 1].content === 'q',
    'the framing turn leads and the question stays last — the ledger reads like a chat');
  check(framed[0].content.includes('relay_feedback') && framed[0].content.includes('NO effect from here'),
    'the pen is told which tools do nothing from a meeting panel (relay_feedback writes across matters)');

  // ── 13. The flag timer is NOT covered by the decision ─────────────────
  console.log('\n/api/meeting-flag — still quiet on a sealed matter, pen or no pen');
  install({ tier: 'B', bedrock: 'ok' });
  res = await call(meetingFlag, flagBody());
  check(res.statusCode === 200 && res.json?.sealed === true && res.json?.flags?.length === 0,
    'a configured sealed pen does NOT switch on unprompted flagging', res.json);
  check(providerHosts().length === 0,
    'egress witness: ZERO requests — nothing is sent to any model on a timer nobody asked for', hosts());

  // ── 14. Negative control — main's handler against these expectations ──
  console.log('\nNegative control — main\'s /api/meeting-chat against the new expectations');
  const { execSync } = await import('node:child_process');
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const baselinePath = fileURLToPath(new URL('../api/.baseline-meeting-chat.mjs', import.meta.url));
  let baselineSrc = null;
  for (const ref of ['origin/main', 'main', 'HEAD~1']) {
    try {
      baselineSrc = execSync(`git show ${ref}:api/meeting-chat.mjs`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      console.log(`  (baseline: ${ref})`);
      break;
    } catch { /* try the next ref */ }
  }
  if (!baselineSrc) {
    skip('no baseline ref available (shallow clone) — negative control not run');
  } else {
    try {
      // Written INSIDE api/ so its ../lib imports resolve the way the real
      // handler's do. Deleted again below, pass or fail.
      writeFileSync(baselinePath, baselineSrc);
      const { default: baseline } = await import(`${new URL('../api/.baseline-meeting-chat.mjs', import.meta.url).href}?t=${Date.now()}`);
      install({ tier: 'B', bedrock: 'ok' });
      const before = await call(baseline, chatBody());
      check(before.statusCode !== 200, 'main REFUSES a sealed meeting (it has no sealed arm) — the behaviour this PR changes', before.statusCode);
      check(bedrockCalls().length === 0, 'main never contacts the sealed pen', hosts());
      check(!before.text.includes(SEALED_ANSWER), 'and therefore returns no answer to the question');
      const wouldFail = before.statusCode !== 200 && bedrockCalls().length === 0;
      check(wouldFail, 'negative control HOLDS: run against main, every Part Two expectation above fails');
      // And the case that must NOT have changed:
      install({ tier: 'A', bedrock: 'ok' });
      const beforeA = await call(baseline, chatBody());
      install({ tier: 'A', bedrock: 'ok' });
      const afterA = await call(meetingChat, chatBody());
      check(beforeA.text === afterA.text && beforeA.statusCode === afterA.statusCode,
        'Tier A: this PR and main produce the identical response', { before: beforeA.statusCode, after: afterA.statusCode });
    } finally {
      try { unlinkSync(baselinePath); } catch { /* already gone */ }
    }
  }
} finally {
  restore();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
