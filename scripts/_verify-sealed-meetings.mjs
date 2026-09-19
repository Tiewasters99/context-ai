// A sealed meeting's transcript never leaves the seal.
// (SecureSpace Tier B/C; the gap found while reviewing PR #159.)
//
//   node scripts/_verify-sealed-meetings.mjs
//
// Entirely OFFLINE and secret-free: no .env is read, `fetch` is replaced by a
// witness that answers for Supabase and records every request, and the two
// endpoint handlers are driven directly with a fake req/res. Every key in this
// file is a fake string. CI-ready — exits non-zero on failure.
//
// The finding under test: /api/meeting-chat and /api/meeting-flag both send a
// meeting's VERBATIM transcript to first-party Anthropic. Both read the
// matter's tier and both acted on it only for Tier C — a Tier-B (SEALED)
// meeting merely dropped the `web_search` tool and sent the transcript anyway,
// with no escalation and nothing written to the record. /api/meeting-flag does
// it on a 90-second timer, so the leak ran unprompted for as long as the
// meeting did.
//
//   1. Tier B          → refusal, and ZERO requests to any provider. The only
//                        host contacted is the Supabase stub — the tier lookup
//                        itself.
//   2. Tier C          → unchanged in outcome (refused), now through the same
//                        policy function.
//   3. Tier unreadable → refusal. So is a meeting row that does not resolve:
//                        a seal we cannot read is a seal (a deliberate
//                        tightening — the old code treated it as unbound).
//   4. Tier A          → EXACTLY the request the routes made before this
//                        change: same model, same system blocks, same
//                        transcript wrapper, same tools, same messages.
//   5. No matter bound → unchanged, open.
//   6. The policy      → providerAllowed('B','anthropic') is false, which is
//                        why case 1 refuses. One policy, not a second copy.

// ── env, BEFORE the handlers are imported ────────────────────────────────
// The handlers read these at module scope. Set here so the harness is
// deterministic wherever it runs, and so a real key that happens to be in the
// environment is overwritten rather than used.
const SUPABASE_URL = 'https://stub.supabase.test';
const SUPA_HOST = 'stub.supabase.test';
process.env.VITE_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.VITE_SUPABASE_ANON_KEY = 'anon-stub-not-a-key';
process.env.ANTHROPIC_API_KEY = 'sk-ant-stub-not-a-key';
delete process.env.CLAUDE_MODEL;
delete process.env.CLAUDE_FLAG_MODEL;

const { default: meetingChat } = await import('../api/meeting-chat.mjs');
const { default: meetingFlag } = await import('../api/meeting-flag.mjs');
const { meetingModelDecision, meetingRefusalMessage } = await import('../lib/meeting-seal.mjs');
const { providerAllowed } = await import('../lib/ai-tier-policy.mjs');

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => {
  console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${JSON.stringify(d)?.slice(0, 400)}` : ''}`);
  failures++;
};
const check = (cond, m, d) => (cond ? pass(m) : fail(m, d));

// A transcript long enough for /api/meeting-flag's 200-character floor, and
// recognisable if it ever shows up somewhere it should not.
const TRANSCRIPT = [
  'Reyes: We can commit to the March 14 delivery date if the escrow closes first.',
  'Calder: Our board approved 2.4 million, not 3.1 — that number was never agreed.',
  'Reyes: I have the signed term sheet in front of me and it says three point one.',
  'Calder: Then one of us is reading a different document, and we should stop here.',
].join('\n');

// ── the witness ──────────────────────────────────────────────────────────
// Installed for every case. It answers as Supabase (so the real supabase-js
// client, and therefore the real tier lookup, runs unmodified) and records
// every request either handler makes. A sealed case must show no provider host
// at all.
const realFetch = globalThis.fetch;
let requests = [];
let world = {};

function install(w = {}) {
  world = { tier: 'B', meeting: 'bound', ...w };
  requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    const host = hostOf(url);
    requests.push({ url, host, method: (init.method || 'GET').toUpperCase(), body: init.body });
    if (host === SUPA_HOST) return supabaseAnswer(url);
    if (host === 'api.anthropic.com') return anthropicAnswer(init);
    return jsonRes(500, { error: 'unexpected_host', host });
  };
}
const restore = () => { globalThis.fetch = realFetch; };
const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u); } };
const hosts = () => [...new Set(requests.map((r) => r.host))];
const providerHosts = () => hosts().filter((h) => h !== SUPA_HOST);
const anthropicCalls = () => requests.filter((r) => r.host === 'api.anthropic.com');
const sentBody = (i = 0) => { try { return JSON.parse(anthropicCalls()[i].body); } catch { return null; } };

const jsonRes = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json' },
});

function supabaseAnswer(url) {
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
  // ── 1. /api/meeting-chat on a SEALED matter ───────────────────────────
  console.log('\n/api/meeting-chat — Tier B (SEALED)');
  install({ tier: 'B' });
  let res = await call(meetingChat, chatBody());
  check(res.statusCode === 403, 'refused with 403', { status: res.statusCode, body: res.text });
  check(res.json?.error === 'tier_violation', "the code is 'tier_violation' — the shape /api/llm already returns", res.json);
  check(res.json?.tier === 'B', 'the refusal names the tier', res.json);
  check(readsLikeARefusal(res.json?.message), 'the refusal is a plain-language sentence, not a bare code', res.json?.message);
  check(providerHosts().length === 0, 'egress witness: ZERO provider requests — no model saw the transcript', hosts());
  check(!res.text.includes('Reyes:'), 'no part of the transcript is echoed back in the refusal');
  check(requests.every((r) => !String(r.body ?? '').includes('Reyes:')), 'the transcript appears in NO outbound request body');

  // ── 2. Tier C ─────────────────────────────────────────────────────────
  console.log('\n/api/meeting-chat — Tier C (SILO)');
  install({ tier: 'C' });
  res = await call(meetingChat, chatBody());
  check(res.statusCode === 403, 'refused with 403', { status: res.statusCode });
  check(readsLikeARefusal(res.json?.message), 'plain-language refusal', res.json?.message);
  check(providerHosts().length === 0, 'egress witness: ZERO provider requests', hosts());

  // ── 3. The tier cannot be determined ──────────────────────────────────
  console.log('\n/api/meeting-chat — the seal cannot be read (fail closed)');
  install({ tier: 'error' });
  res = await call(meetingChat, chatBody());
  check(res.statusCode === 403, 'a tier lookup that fails is a refusal, not a pass', { status: res.statusCode });
  check(res.json?.tier === null, 'the refusal admits the tier is unknown', res.json);
  check(providerHosts().length === 0, 'egress witness: ZERO provider requests', hosts());

  install({ meeting: 'error' });
  res = await call(meetingChat, chatBody());
  check(res.statusCode === 403 && res.json?.error === 'meeting_unresolved',
    'a meeting row that errors is a refusal (tightened 2026-09-19)', res.json);
  check(providerHosts().length === 0, 'egress witness: ZERO provider requests', hosts());

  install({ meeting: 'missing' });
  res = await call(meetingChat, chatBody());
  check(res.statusCode === 403 && res.json?.error === 'meeting_unresolved',
    'a meeting the caller cannot see under RLS is a refusal', res.json);
  check(providerHosts().length === 0, 'egress witness: ZERO provider requests', hosts());

  // ── 4. Tier A — byte-for-byte the request made before this change ─────
  console.log('\n/api/meeting-chat — Tier A (unchanged)');
  install({ tier: 'A' });
  res = await call(meetingChat, chatBody());
  const sent = sentBody();
  check(anthropicCalls().length === 1, 'exactly one request to Anthropic', requests.map((r) => r.host));
  check(sent?.model === 'claude-opus-4-7', 'same model as before', sent?.model);
  check(sent?.max_tokens === 8192 && sent?.thinking?.type === 'adaptive', 'same max_tokens and adaptive thinking', { max_tokens: sent?.max_tokens, thinking: sent?.thinking });
  check(Array.isArray(sent?.system) && sent.system.length === 2, 'system is still instructions + transcript', sent?.system?.length);
  check(sent?.system?.[1]?.text?.includes('<meeting_transcript>') && sent.system[1].text.includes('Reyes:'),
    'the transcript still travels in the <meeting_transcript> block', sent?.system?.[1]?.text?.slice(0, 60));
  check(sent?.system?.[1]?.cache_control?.type === 'ephemeral', 'the transcript is still an ephemeral cache breakpoint', sent?.system?.[1]?.cache_control);
  check(sent?.tools?.[0]?.name === 'web_search', 'web_search is still attached on an unsealed meeting', sent?.tools);
  check(sent?.messages?.[0]?.content === 'What should I push back on?', 'the chat history is still forwarded', sent?.messages);
  check(res.text.includes('Push back on the 3.1 figure.'), 'the answer still streams back to the client', res.text);
  check(res.statusCode === 200, 'status 200', res.statusCode);

  // ── 5. A meeting bound to no matter ───────────────────────────────────
  console.log('\n/api/meeting-chat — nothing to seal (unchanged)');
  install({ meeting: 'unbound' });
  res = await call(meetingChat, chatBody());
  check(anthropicCalls().length === 1, 'a meeting in no matter is answered, as before', requests.map((r) => r.host));

  install({ tier: 'B' });
  res = await call(meetingChat, chatBody({ meeting_id: undefined }));
  check(anthropicCalls().length === 1, 'no meeting id: an unbound draft, answered as /api/llm would', requests.map((r) => r.host));

  // ── 6. /api/meeting-flag — the timer, which ran unprompted ────────────
  console.log('\n/api/meeting-flag — Tier B (SEALED)');
  install({ tier: 'B' });
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

  // ── 7. Why it refuses: the policy, not a second copy of it ────────────
  console.log('\nThe policy behind the refusal');
  check(providerAllowed('B', 'anthropic') === false, "providerAllowed('B','anthropic') is false — the one fact both routes now consult");
  check(providerAllowed('C', 'anthropic') === false, "providerAllowed('C','anthropic') is false");
  check(providerAllowed('A', 'anthropic') === true, "providerAllowed('A','anthropic') is true — Tier A untouched");
  check(providerAllowed('B', 'aws-bedrock') === true, 'the sealed route itself stays open, for whoever wires meetings to it');
  const thrower = { from: () => { throw new Error('client exploded'); } };
  const decision = await meetingModelDecision(thrower, 'meeting-1', { provider: 'anthropic' })
    .then((d) => d, (err) => ({ ok: 'threw', err: err.message }));
  check(decision.ok === 'threw' || decision.ok === false, 'a lookup that throws never returns "send it"', decision);
  check(meetingRefusalMessage('B') !== meetingRefusalMessage('C'), 'a Silo matter and a sealed matter are told different, true things');
} finally {
  restore();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
