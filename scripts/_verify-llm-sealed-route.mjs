// The sealed route for /api/llm — a browser LLM call on a sealed matter
// reaches the sealed pen, or it is refused. It is never forwarded to the
// provider the browser named.
//
//   node scripts/_verify-llm-sealed-route.mjs
//
// Entirely OFFLINE and secret-free: `fetch` is stubbed and every request it
// sees is recorded, so each case asserts not only what the code decided but
// what it actually contacted. No .env is read, no network is touched, no AWS
// or model call is made. CI-ready — exits non-zero on failure.
//
// This drives the REAL handler (api/llm.mjs default export) with a fake
// req/res, so the gate, the substitution and the passthrough are all under
// test together rather than the adapter in isolation.
//
//   1. Tier B + Bedrock credentials  → exactly ONE upstream request, to
//      bedrock-mantle, SigV4-signed, with the body translated.
//   2. Tier B, credentials ABSENT    → 503 sealed_pen_unavailable, and ZERO
//      requests to any provider.
//   3. Tier B naming anthropic / openai / fireworks / google → api.anthropic.com,
//      api.openai.com, api.fireworks.ai and generativelanguage.googleapis.com
//      are NEVER contacted.
//   4. Tier B, untranslatable request (image blocks, Gemini shape) → refused,
//      zero requests. Nothing is approximated.
//   5. Tier B, the sealed pen fails  → 502 sealed_pen_error in the product's
//      voice, one request, no AWS detail in production copy.
//   6. Response translation          → a canned Bedrock reply round-trips into
//      exactly the shape src/lib/llm/generate.ts and structured.ts parse.
//   7. Tier A                        → byte-identical forward, unchanged.
//   8. Tier C                        → refused, zero requests, unchanged.

import handler from '../api/llm.mjs';
import { sealedRouteFor, SEALED_PROVIDER } from '../lib/llm-sealed-route.mjs';

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => {
  console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${JSON.stringify(d)?.slice(0, 500)}` : ''}`);
  failures++;
};
const eq = (m, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? pass(m) : fail(m, { got, want }));

// ── the environment this harness pretends to be ─────────────────────────
const SB = 'https://stub.supabase.co';
process.env.VITE_SUPABASE_URL = SB;
process.env.VITE_SUPABASE_ANON_KEY = 'anon';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
process.env.ANTHROPIC_API_KEY = 'sk-ant-stub';
process.env.OPENAI_API_KEY = 'sk-openai-stub';
process.env.NODE_ENV = 'production'; // production copy: no developer hints
delete process.env.BEDROCK_AWS_SESSION_TOKEN;

const withBedrock = () => {
  process.env.BEDROCK_AWS_ACCESS_KEY_ID = 'AKIDTEST';
  process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = 'testsecret';
  process.env.BEDROCK_REGION = 'us-east-1';
  delete process.env.BEDROCK_MODEL;
};
const withoutBedrock = () => {
  delete process.env.BEDROCK_AWS_ACCESS_KEY_ID;
  delete process.env.BEDROCK_AWS_SECRET_ACCESS_KEY;
  delete process.env.BEDROCK_REGION;
  delete process.env.BEDROCK_MODEL;
};

// ── the witness ─────────────────────────────────────────────────────────
let requests = [];
const safeHost = (u) => { try { return new URL(u).host; } catch { return u; } };
const providerRequests = () => requests.filter((r) => r.host !== 'stub.supabase.co');
const providerHosts = () => [...new Set(providerRequests().map((r) => r.host))];
const nonBedrock = () => providerHosts().filter((h) => !h.startsWith('bedrock-mantle.'));

function witness(tier, upstream) {
  requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    requests.push({ url: u, host: safeHost(u), init });
    if (u.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: 'user-1' }), { status: 200 });
    if (u.includes('/rest/v1/matterspaces')) {
      return new Response(JSON.stringify([{ id: 'm-1', parent_matterspace_id: null, ai_tier: tier }]), { status: 200 });
    }
    if (upstream) return upstream(u, init);
    throw new Error(`unexpected host: ${u}`);
  };
}

// ── a fake Vercel req/res ───────────────────────────────────────────────
function fakeRes() {
  const chunks = [];
  const headers = {};
  return {
    statusCode: 200,
    headers,
    setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
    write(b) { chunks.push(Buffer.from(b)); return true; },
    end(b) { if (b) chunks.push(Buffer.from(b)); return this; },
    text() { return Buffer.concat(chunks).toString(); },
    json() { try { return JSON.parse(this.text()); } catch { return null; } },
  };
}

async function call({ tier, provider, model, body, upstream, matterId = 'm-1' }) {
  witness(tier, upstream);
  const res = fakeRes();
  await handler(
    { method: 'POST', headers: { authorization: 'Bearer tok' }, body: { provider, model, body, matterId } },
    res,
  );
  return res;
}

// ── canned Bedrock replies ──────────────────────────────────────────────
const sse = (objs) => objs.map((o) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`).join('');
const sseResponse = (text) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });

const CANNED_TEXT = sse([
  { choices: [{ index: 0, delta: { role: 'assistant', content: 'The lease ' } }] },
  { choices: [{ index: 0, delta: { content: 'is responsive.' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 8 } },
  '[DONE]',
]);

const CANNED_TOOL = sse([
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'file_bucket', arguments: '{"node_id":' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"n-7","confidence":0.9}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 500, completion_tokens: 40 } },
  '[DONE]',
]);

const bedrockOk = (payload) => (u) => {
  if (u.startsWith('https://bedrock-mantle.')) return sseResponse(payload);
  throw new Error(`unexpected host: ${u}`);
};

// ── what the CLIENT parses, mirrored from src/lib/llm/adapters.ts ───────
// anthropicAdapter.parseStreamEvent / isStreamDone (adapters.ts:22-33) and
// parseStructuredResponse / parseUsage (adapters.ts:49-59). Copied rather
// than imported because those are TypeScript; if they change, this harness
// is the thing that should break.
const anthropicStreamText = (raw) => raw
  .split('\n')
  .filter((l) => l.startsWith('data: '))
  .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
  .filter((e) => e && e.type === 'content_block_delta' && e.delta?.type === 'text_delta')
  .map((e) => e.delta.text)
  .join('');
const anthropicStreamDone = (raw) => raw.split('\n').some((l) => {
  if (!l.startsWith('data: ')) return false;
  try { return JSON.parse(l.slice(6)).type === 'message_stop'; } catch { return false; }
});
const anthropicToolInput = (j) => (Array.isArray(j?.content) ? j.content.find((c) => c.type === 'tool_use')?.input ?? null : null);
const anthropicUsage = (j) => (typeof j?.usage?.input_tokens === 'number'
  ? { inputTokens: j.usage.input_tokens, outputTokens: j.usage.output_tokens ?? 0 }
  : null);
// openaiAdapter.parseStructuredResponse / parseUsage (adapters.ts:117-128).
const openaiToolInput = (j) => {
  const a = j?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (typeof a !== 'string') return null;
  try { return JSON.parse(a); } catch { return null; }
};

// ── bodies the client builds today ──────────────────────────────────────
// anthropicAdapter.buildRequestBody (generate.ts → adapters.ts:10-21).
const ANTHROPIC_STREAM_BODY = JSON.stringify({
  model: 'claude-opus-4-8',
  max_tokens: 4096,
  stream: true,
  system: 'You are an AI assistant inside The Vault…',
  messages: [{ role: 'user', content: 'Summarise the lease.' }],
});
// anthropicAdapter.buildStructuredRequestBody (adapters.ts:34-48) — Bucketizer
// classify (src/lib/bucketizer/index.ts:299, maxTokens 4_000).
const SCHEMA = { type: 'object', properties: { node_id: { type: 'string' }, confidence: { type: 'number' } }, required: ['node_id'] };
const ANTHROPIC_TOOL_BODY = JSON.stringify({
  model: 'claude-opus-4-8',
  max_tokens: 4000,
  stream: false,
  system: 'Classify the document.',
  tools: [{ name: 'file_bucket', description: 'File the document.', input_schema: SCHEMA }],
  tool_choice: { type: 'tool', name: 'file_bucket' },
  messages: [{ role: 'user', content: 'Document text…' }],
});
// fireworksAdapter.buildStructuredRequestBody (adapters.ts:220-229) — the
// Editor's default pen (DEFAULT_EDITOR_MODEL = 'kimi-k3-us').
const OPENAI_TOOL_BODY = JSON.stringify({
  model: 'accounts/fireworks/models/kimi-k3',
  max_tokens: 20_000,
  stream: false,
  messages: [{ role: 'system', content: 'Edit the section.' }, { role: 'user', content: 'Draft text…' }],
  tools: [{ type: 'function', function: { name: 'file_bucket', description: 'File.', parameters: SCHEMA } }],
  tool_choice: { type: 'function', function: { name: 'file_bucket' } },
});

console.log('\nTier B, Bedrock credentials PRESENT — the sealed route');
{
  withBedrock();
  const res = await call({ tier: 'B', provider: 'anthropic', model: 'claude-opus-4-8', body: ANTHROPIC_STREAM_BODY, upstream: bedrockOk(CANNED_TEXT) });
  const up = providerRequests();
  if (up.length === 1) pass('exactly ONE upstream request'); else fail('expected exactly one upstream request', up.map((r) => r.url));
  eq('the host is the sealed Bedrock endpoint', up[0]?.host, 'bedrock-mantle.us-east-1.api.aws');
  eq('the path is the OpenAI-compatible chat route', new URL(up[0].url).pathname, '/v1/chat/completions');
  const auth = up[0].init.headers?.authorization ?? up[0].init.headers?.Authorization ?? '';
  if (auth.startsWith('AWS4-HMAC-SHA256 ') && auth.includes('/bedrock-mantle/aws4_request')) {
    pass('SigV4 Authorization header present, service bedrock-mantle');
  } else fail('missing or wrong SigV4 Authorization header', auth.slice(0, 80));
  if (up[0].init.headers?.['x-amz-date']) pass('x-amz-date signed'); else fail('no x-amz-date header');

  const sent = JSON.parse(up[0].init.body);
  eq('body: model is the sealed pen, not the model the browser asked for', sent.model, 'moonshotai.kimi-k2.5');
  eq('body: streamed upstream with usage', [sent.stream, sent.stream_options?.include_usage], [true, true]);
  eq('body: the Anthropic `system` became a system message', sent.messages[0], { role: 'system', content: 'You are an AI assistant inside The Vault…' });
  eq('body: the user turn survived verbatim', sent.messages[1], { role: 'user', content: 'Summarise the lease.' });
  if (!('temperature' in sent)) pass('body: no temperature — Kimi rejects any value but 1'); else fail('temperature was sent', sent.temperature);
  eq('body: max_tokens carried over (no tool, no headroom)', sent.max_tokens, 4096);

  const out = res.text();
  eq('status 200', res.statusCode, 200);
  eq('content-type is an SSE stream', res.headers['content-type'], 'text/event-stream');
  eq('the pen that answered is named in a header', res.headers['x-contextspaces-pen'], 'Kimi K2.5 (Bedrock, our AWS account, zero retention)');
  eq('response: generate.ts reassembles the full answer', anthropicStreamText(out), 'The lease is responsive.');
  if (anthropicStreamDone(out)) pass('response: the stream ends with message_stop, which generate.ts recognises'); else fail('no message_stop event', out.slice(-200));
  if (nonBedrock().length === 0) pass('egress witness: bedrock-mantle and nothing else'); else fail('a non-Bedrock host was contacted', nonBedrock());
}

console.log('\nTier B — a structured (tool-use) call, which is what Bucketizer and cite-check run');
{
  withBedrock();
  const res = await call({ tier: 'B', provider: 'anthropic', model: 'claude-opus-4-8', body: ANTHROPIC_TOOL_BODY, upstream: bedrockOk(CANNED_TOOL) });
  const sent = JSON.parse(providerRequests()[0].init.body);
  eq('body: the Anthropic tool became an OpenAI function', sent.tools?.[0], { type: 'function', function: { name: 'file_bucket', description: 'File the document.', parameters: SCHEMA } });
  eq("body: tool_choice is 'required' — a NAMED choice fights Kimi's thinking", sent.tool_choice, 'required');
  eq('body: thinking headroom added for the forced tool (4000 + 12000)', sent.max_tokens, 16_000);
  eq('body: still streamed upstream even though the caller wants one JSON object', sent.stream, true);

  const json = res.json();
  eq('status 200', res.statusCode, 200);
  eq('content-type is JSON, as structured.ts expects', res.headers['content-type'], 'application/json');
  eq('response: structured.ts gets the tool input back', anthropicToolInput(json), { node_id: 'n-7', confidence: 0.9 });
  eq('response: usage round-trips for the cost meter', anthropicUsage(json), { inputTokens: 500, outputTokens: 40 });
  eq('response: `model` names the pen that actually answered', json.model, 'moonshotai.kimi-k2.5');
  eq('response: stop_reason translated', json.stop_reason, 'tool_use');
  if (nonBedrock().length === 0) pass('egress witness: bedrock-mantle and nothing else'); else fail('a non-Bedrock host was contacted', nonBedrock());
}

console.log('\nTier B — an OpenAI-shaped caller (the Editor on its Kimi route)');
{
  withBedrock();
  const res = await call({ tier: 'B', provider: 'fireworks', model: 'accounts/fireworks/models/kimi-k3', body: OPENAI_TOOL_BODY, upstream: bedrockOk(CANNED_TOOL) });
  const sent = JSON.parse(providerRequests()[0].init.body);
  eq('body: the system message survived', sent.messages[0], { role: 'system', content: 'Edit the section.' });
  eq('body: max_tokens clamped, so a caller that already added headroom does not add it twice', sent.max_tokens, 32_000);
  const json = res.json();
  eq('response: the OpenAI shape the Editor parses', openaiToolInput(json), { node_id: 'n-7', confidence: 0.9 });
  eq('response: finish_reason translated', json.choices[0].finish_reason, 'tool_calls');
  eq('response: usage in OpenAI field names', json.usage, { prompt_tokens: 500, completion_tokens: 40, total_tokens: 540 });
  if (nonBedrock().length === 0) pass('egress witness: api.fireworks.ai was NOT contacted'); else fail('a non-Bedrock host was contacted', nonBedrock());
}

console.log('\nTier B — an OpenAI-shaped STREAMING caller (the Workbench on GPT-4o)');
{
  withBedrock();
  const res = await call({
    tier: 'B', provider: 'openai', model: 'gpt-4o',
    body: JSON.stringify({ model: 'gpt-4o', max_tokens: 4096, temperature: 0.7, stream: true, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] }),
    upstream: bedrockOk(CANNED_TEXT),
  });
  // openaiAdapter.parseStreamEvent / isStreamDone (adapters.ts:84-93).
  const text = res.text().split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6).trim())
    .filter((d) => d !== '[DONE]')
    .map((d) => { try { return JSON.parse(d).choices?.[0]?.delta?.content ?? ''; } catch { return ''; } })
    .join('');
  eq('response: generate.ts reassembles the answer through the OpenAI adapter', text, 'The lease is responsive.');
  if (res.text().includes('data: [DONE]')) pass('response: the stream ends with [DONE], which the OpenAI adapter recognises'); else fail('no [DONE] terminator', res.text().slice(-120));
  if (nonBedrock().length === 0) pass('egress witness: api.openai.com was NOT contacted'); else fail('a non-Bedrock host was contacted', nonBedrock());
}

console.log('\nTier B — the Bedrock Messages route (BEDROCK_MODEL=anthropic.*)');
{
  withBedrock();
  process.env.BEDROCK_MODEL = 'anthropic.claude-opus-5';
  const CANNED_MSG = sse([
    { type: 'message_start', message: { usage: { input_tokens: 11, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'file_bucket' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"node_id":"n-7"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } },
  ]);
  const res = await call({ tier: 'B', provider: 'anthropic', model: 'claude-opus-4-8', body: ANTHROPIC_TOOL_BODY, upstream: bedrockOk(CANNED_MSG) });
  const up = providerRequests()[0];
  eq('the path is the Bedrock Messages route', new URL(up.url).pathname, '/anthropic/v1/messages');
  const sent = JSON.parse(up.init.body);
  eq('body: model is the env-selected sealed pen', sent.model, 'anthropic.claude-opus-5');
  eq('body: the tool kept its Anthropic shape', sent.tools?.[0]?.input_schema, SCHEMA);
  eq('body: the named tool_choice is preserved on this route', sent.tool_choice, { type: 'tool', name: 'file_bucket' });
  if (!('thinking' in sent)) pass('body: no `thinking` block — extended thinking fights a named tool_choice'); else fail('thinking was sent', sent.thinking);
  eq('response: the tool input round-trips', anthropicToolInput(res.json()), { node_id: 'n-7' });
  delete process.env.BEDROCK_MODEL;
}

console.log('\nTier B, Bedrock credentials ABSENT');
{
  withoutBedrock();
  const res = await call({ tier: 'B', provider: 'anthropic', model: 'claude-opus-4-8', body: ANTHROPIC_STREAM_BODY });
  eq('503, not a silent substitution', res.statusCode, 503);
  eq('code is sealed_pen_unavailable', res.json()?.error, 'sealed_pen_unavailable');
  const msg = res.json()?.message ?? '';
  if (/sealed/i.test(msg) && /Nothing was sent/i.test(msg)) pass('the refusal is a sentence, not a code'); else fail('refusal copy missing', msg.slice(0, 160));
  if (!/BEDROCK_AWS/.test(msg)) pass('production copy carries no developer hint'); else fail('developer hint leaked into production copy', msg);
  if (providerRequests().length === 0) pass('egress witness: ZERO provider requests'); else fail('a provider was contacted', providerHosts());
}

console.log('\nTier B naming a non-sealed provider — never forwarded');
{
  withBedrock();
  for (const [provider, model, body, forbidden] of [
    ['anthropic', 'claude-opus-4-8', ANTHROPIC_STREAM_BODY, 'api.anthropic.com'],
    ['openai', 'gpt-4o', JSON.stringify({ model: 'gpt-4o', max_tokens: 4096, stream: true, messages: [{ role: 'user', content: 'hi' }] }), 'api.openai.com'],
    ['fireworks', 'accounts/fireworks/models/kimi-k3', OPENAI_TOOL_BODY, 'api.fireworks.ai'],
    ['xai', 'grok-3', JSON.stringify({ model: 'grok-3', max_tokens: 4096, stream: true, messages: [{ role: 'user', content: 'hi' }] }), 'api.x.ai'],
  ]) {
    await call({ tier: 'B', provider, model, body, upstream: bedrockOk(CANNED_TEXT) });
    if (!providerHosts().includes(forbidden)) pass(`tier B + ${provider} → ${forbidden} never contacted`);
    else fail(`${forbidden} was contacted on a sealed matter`, providerHosts());
  }
  // The Moonshot sandbox is refused on EVERY matter-bound call, Tier A
  // included. Sealing a matter must not make it more permissive than leaving
  // it open, so it keeps the gate's own refusal rather than being substituted.
  const m = await call({
    tier: 'B', provider: 'moonshot', model: 'kimi-k3',
    body: JSON.stringify({ model: 'kimi-k3', max_tokens: 4096, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  eq('tier B + moonshot → still 403 tier_violation, NOT substituted', [m.statusCode, m.json()?.error], [403, 'tier_violation']);
  if (providerRequests().length === 0) pass('tier B + moonshot → egress witness: ZERO requests'); else fail('something was contacted', providerHosts());

  // Gemini's generateContent shape has no faithful translation; it is refused,
  // not approximated.
  const g = await call({
    tier: 'B', provider: 'google', model: 'gemini-2.5-pro-preview-06-05',
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 4096 } }),
  });
  eq('tier B + google → 403 sealed_route_untranslatable', [g.statusCode, g.json()?.error], [403, 'sealed_route_untranslatable']);
  if (!providerHosts().includes('generativelanguage.googleapis.com')) pass('tier B + google → generativelanguage.googleapis.com never contacted');
  else fail('Gemini was contacted on a sealed matter', providerHosts());
  if (providerRequests().length === 0) pass('egress witness: the untranslatable request contacted nothing at all'); else fail('something was contacted', providerHosts());
}

console.log('\nTier B — an untranslatable request is refused, never approximated');
{
  withBedrock();
  const withImage = JSON.stringify({
    model: 'claude-opus-4-8', max_tokens: 4096, stream: true,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }, { type: 'text', text: 'What is this?' }] }],
  });
  const res = await call({ tier: 'B', provider: 'anthropic', model: 'claude-opus-4-8', body: withImage });
  eq('a content-block (image) message → 403 sealed_route_untranslatable', [res.statusCode, res.json()?.error], [403, 'sealed_route_untranslatable']);
  if (providerRequests().length === 0) pass('egress witness: ZERO requests — the image was not flattened and sent'); else fail('something was contacted', providerHosts());
}

console.log('\nTier B — the sealed pen itself fails');
{
  withBedrock();
  const res = await call({
    tier: 'B', provider: 'anthropic', model: 'claude-opus-4-8', body: ANTHROPIC_STREAM_BODY,
    upstream: () => new Response('{"message":"The security token included in the request is invalid."}', { status: 403 }),
  });
  eq('502 sealed_pen_error', [res.statusCode, res.json()?.error], [502, 'sealed_pen_error']);
  const msg = res.json()?.message ?? '';
  if (/No other\s+model was asked/i.test(msg)) pass('the copy promises what is actually true: no other provider was asked'); else fail('refusal copy missing', msg.slice(0, 200));
  if (!/security token/i.test(msg) && !/403/.test(msg)) pass("AWS's own words stay out of production copy"); else fail('provider detail leaked to the browser', msg);
  if (providerRequests().length === 1) pass('exactly ONE request — no retry onto another pen'); else fail('expected one request', providerRequests().map((r) => r.host));
  if (nonBedrock().length === 0) pass('egress witness: no non-Bedrock host after the failure'); else fail('a non-Bedrock host was contacted', nonBedrock());
}

console.log('\nTier A and Tier C unchanged');
{
  withBedrock(); // credentials present, and they must not hijack an unsealed matter
  const res = await call({
    tier: 'A', provider: 'anthropic', model: 'claude-opus-4-8', body: ANTHROPIC_STREAM_BODY,
    upstream: (u) => {
      if (u === 'https://api.anthropic.com/v1/messages') return sseResponse(sse([{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }, { type: 'message_stop' }]));
      throw new Error(`unexpected host: ${u}`);
    },
  });
  const up = providerRequests();
  eq('tier A → still api.anthropic.com', up[0]?.host, 'api.anthropic.com');
  eq('tier A → the body is forwarded BYTE-IDENTICALLY', up[0]?.init?.body, ANTHROPIC_STREAM_BODY);
  eq('tier A → first-party headers unchanged', up[0]?.init?.headers?.['x-api-key'], 'sk-ant-stub');
  eq('tier A → 200', res.statusCode, 200);
  if (!res.headers['x-contextspaces-pen']) pass('tier A → no sealed-pen header, nothing was substituted'); else fail('tier A was routed through the seal', res.headers);

  const c = await call({ tier: 'C', provider: 'anthropic', model: 'claude-opus-4-8', body: ANTHROPIC_STREAM_BODY });
  eq('tier C → 403 tier_violation, unchanged', [c.statusCode, c.json()?.error], [403, 'tier_violation']);
  if (providerRequests().length === 0) pass('tier C → egress witness: ZERO requests'); else fail('a provider was contacted on Tier C', providerHosts());

  // A matter-bound request with no matter is the unbound case: unchanged too.
  const u = await call({
    tier: 'A', provider: 'anthropic', model: 'claude-opus-4-8', body: ANTHROPIC_STREAM_BODY, matterId: undefined,
    upstream: () => sseResponse(sse([{ type: 'message_stop' }])),
  });
  eq('no matter bound → unchanged forward', [u.statusCode, providerHosts()[0]], [200, 'api.anthropic.com']);
}

console.log('\nThe adapter fails closed on its own');
{
  withBedrock();
  eq('the sealed provider is aws-bedrock', SEALED_PROVIDER, 'aws-bedrock');
  eq('a gate that PASSED is never substituted', sealedRouteFor({ gate: { ok: true, tier: 'B' }, provider: 'aws-bedrock', body: '{}' }), null);
  eq('a 401 is not a sealed substitution', sealedRouteFor({ gate: { ok: false, status: 401, error: 'auth_required' }, provider: 'anthropic', body: ANTHROPIC_STREAM_BODY }), null);
  eq('a Tier-C refusal is not a sealed substitution', sealedRouteFor({ gate: { ok: false, status: 403, error: 'tier_violation', tier: 'C' }, provider: 'anthropic', body: ANTHROPIC_STREAM_BODY }), null);
  eq('a Tier-A refusal (the Moonshot sandbox) is not a sealed substitution', sealedRouteFor({ gate: { ok: false, status: 403, error: 'tier_violation', tier: 'A' }, provider: 'moonshot', body: ANTHROPIC_STREAM_BODY }), null);
  const bad = sealedRouteFor({ gate: { ok: false, status: 403, error: 'tier_violation', tier: 'B' }, provider: 'anthropic', body: 'not json at all' });
  eq('a body that is not JSON is refused, not forwarded', bad?.refusal?.body?.error, 'sealed_route_untranslatable');
}

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
