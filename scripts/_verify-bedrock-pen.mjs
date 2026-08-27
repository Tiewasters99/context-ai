// Verification of the Bedrock sealed pen (SecureSpace Tier B) —
//   node scripts/_verify-bedrock-pen.mjs
//
// OFFLINE (always runs, no network):
//   1. bedrockCredsFromEnv — PASTE and missing values mean "unprovisioned".
//   2. choosePen matrix — the Bedrock pen wins Tier B, escalation becomes
//      moot, the fallbacks still work, and neither C nor A is affected.
//   3. The bedrockTurn driver against a stubbed global fetch: wire shape
//      (host, path, SigV4 service, anthropic-version, body), SSE
//      accumulation (text, tool_use input, thinking + signature), verbatim
//      raw replay on the second round, and a hostname witness — nothing but
//      bedrock-mantle is ever contacted.
//
// LIVE (only when the BEDROCK_ keys in ../.env are real, not PASTE):
//   4. Reads the model's effective data_retention_mode through the pen's
//      own key. FAILS unless it is 'none' — a half-done setup cannot pass.
//   5. One one-line real invoke (fixed fictional prompt), only after the
//      retention mode is proven.
import fs from 'node:fs/promises';
import {
  choosePen, bedrockCredsFromEnv, bedrockTurn, PENS, AssistantRefusal,
} from '../lib/assistant-core.mjs';
import { signRequest } from '../lib/aws-sigv4.mjs';

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => {
  console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${JSON.stringify(d)?.slice(0, 400)}` : ''}`);
  failures++;
};

// ── 1. creds from env ───────────────────────────────────────────────────
console.log('creds resolution');
if (bedrockCredsFromEnv({}) === null) pass('no vars → null (pen unprovisioned)');
else fail('empty env should resolve to null');
if (bedrockCredsFromEnv({ BEDROCK_AWS_ACCESS_KEY_ID: 'PASTE', BEDROCK_AWS_SECRET_ACCESS_KEY: 'PASTE' }) === null) {
  pass('PASTE placeholders → null (never signed with the literal string)');
} else fail('PASTE should count as absent');
const fakeEnv = { BEDROCK_AWS_ACCESS_KEY_ID: 'AKIDTEST', BEDROCK_AWS_SECRET_ACCESS_KEY: 'testsecret' };
const fakeCreds = bedrockCredsFromEnv(fakeEnv);
if (fakeCreds && fakeCreds.region === 'us-east-1' && fakeCreds.sessionToken === null) {
  pass('real-looking keys → creds, region defaults to us-east-1');
} else fail('creds shape', fakeCreds);

// ── 2. choosePen matrix ─────────────────────────────────────────────────
console.log('\nchoosePen');
const KEYS = { anthropicKey: 'ak', fireworksKey: 'fk' };
let pen = choosePen({ tier: 'B', ...KEYS, bedrockCreds: fakeCreds });
if (pen.provider === 'aws-bedrock' && pen.escalation === false && pen.creds === fakeCreds) {
  pass('B + Bedrock creds → aws-bedrock pen, no escalation');
} else fail('B should prefer Bedrock', pen);
pen = choosePen({ tier: 'B', ...KEYS, bedrockCreds: fakeCreds, escalate: true });
if (pen.provider === 'aws-bedrock' && pen.escalation === false) {
  pass('B + escalate + Bedrock → still Bedrock (frontier already inside the seal, nothing to record)');
} else fail('escalate must not leave the seal when Bedrock exists', pen);
pen = choosePen({ tier: 'B', ...KEYS });
if (pen.provider === 'fireworks' && pen.escalation === false) pass('B without Bedrock → Kimi fallback unchanged');
else fail('B fallback', pen);
pen = choosePen({ tier: 'B', ...KEYS, escalate: true });
if (pen.provider === 'anthropic' && pen.escalation === true) pass('B without Bedrock + escalate → recorded escalation unchanged');
else fail('B escalation fallback', pen);
try {
  choosePen({ tier: 'B', anthropicKey: 'ak' });
  fail('B with no sealed pen must refuse');
} catch (err) {
  if (err instanceof AssistantRefusal && err.code === 'sealed_pen_unavailable') pass('B with no sealed pen → refusal (never silent escalation)');
  else fail('wrong refusal', { code: err.code, message: err.message });
}
try {
  choosePen({ tier: 'C', ...KEYS, bedrockCreds: fakeCreds });
  fail('C must refuse even with Bedrock creds');
} catch (err) {
  if (err instanceof AssistantRefusal && err.code === 'silo_not_connected') pass('C refused — Bedrock creds do not unseal a Silo');
  else fail('wrong C refusal', { code: err.code });
}
pen = choosePen({ tier: 'A', ...KEYS, bedrockCreds: fakeCreds });
if (pen.provider === 'anthropic') pass('A stays on first-party Claude — Bedrock creds do not hijack Tier A');
else fail('A pen', pen);

// ── 3. the driver, offline ──────────────────────────────────────────────
console.log('\nbedrockTurn (stubbed fetch)');
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\n';
const ROUND1 = sse([
  { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing the question' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc123' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Sealed and ' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ready.' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_01', name: 'search' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"seal"}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 34 } },
  { type: 'message_stop' },
]);
const ROUND2 = sse([
  { type: 'message_start', message: { usage: { input_tokens: 40, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
]);

const realFetch = globalThis.fetch;
const requests = [];
const responses = [ROUND1, ROUND2];
globalThis.fetch = async (url, init = {}) => {
  requests.push({ url: String(url), init });
  return new Response(responses.shift() ?? '', { status: 200 });
};

const TOOLS = [{ name: 'search', description: 'Search the matter.', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }];
const testPen = { ...PENS.bedrock, creds: fakeCreds, escalation: false };
try {
  let streamed = '';
  const convo = [{ role: 'user', text: 'What does the seal cover?' }];
  const turn = await bedrockTurn({
    pen: testPen, system: 'You are the sealed pen.', tools: TOOLS, convo,
    onText: (t) => { streamed += t; },
  });

  const req = requests[0];
  const u = new URL(req.url);
  if (u.host === 'bedrock-mantle.us-east-1.api.aws' && u.pathname === '/anthropic/v1/messages') {
    pass('request goes to bedrock-mantle.us-east-1.api.aws /anthropic/v1/messages');
  } else fail('wrong endpoint', req.url);
  const auth = req.init.headers?.authorization ?? '';
  if (auth.startsWith('AWS4-HMAC-SHA256 Credential=AKIDTEST/') && auth.includes('/us-east-1/bedrock-mantle/aws4_request')) {
    pass('SigV4-signed, service bedrock-mantle, our key');
  } else fail('authorization header', auth.slice(0, 80));
  if (req.init.headers?.['anthropic-version'] === '2023-06-01') pass('anthropic-version header present');
  else fail('anthropic-version header', req.init.headers);
  const body = JSON.parse(req.init.body);
  if (body.model === 'anthropic.claude-opus-5' && body.stream === true && body.thinking?.type === 'adaptive'
    && body.tools?.[0]?.input_schema && typeof body.system === 'string' && body.messages?.[0]?.role === 'user') {
    pass('body: Bedrock model id, stream, adaptive thinking, tools, system');
  } else fail('request body', { model: body.model, stream: body.stream, thinking: body.thinking });

  if (streamed === 'Sealed and ready.') pass('text streamed through onText in order');
  else fail('streamed text', streamed);
  const [textBlock, toolBlock] = turn.blocks;
  if (turn.blocks.length === 2 && textBlock?.type === 'text' && toolBlock?.type === 'tool_use'
    && toolBlock.id === 'toolu_01' && toolBlock.name === 'search' && toolBlock.input?.query === 'seal') {
    pass('neutral blocks: text + tool_use with parsed input');
  } else fail('blocks', turn.blocks);
  if (turn.stop === 'tool_use' && turn.usage.input === 12 && turn.usage.output === 34) pass('stop reason and usage accumulated');
  else fail('stop/usage', { stop: turn.stop, usage: turn.usage });
  const thinking = turn.raw?.content?.[0];
  if (turn.raw?.provider === 'aws-bedrock' && thinking?.type === 'thinking'
    && thinking.thinking === 'weighing the question' && thinking.signature === 'sig-abc123') {
    pass('raw keeps the thinking block and its signature for replay');
  } else fail('raw content', turn.raw);

  // Second round: the raw content must be replayed VERBATIM, and the tool
  // result must ride back as a tool_result block.
  convo.push({ role: 'assistant', blocks: turn.blocks, raw: turn.raw });
  convo.push({ role: 'tool_results', results: [{ tool_use_id: 'toolu_01', content: '{"rows":[]}' }] });
  const turn2 = await bedrockTurn({
    pen: testPen, system: 'You are the sealed pen.', tools: TOOLS, convo, onText: () => {},
  });
  const body2 = JSON.parse(requests[1].init.body);
  if (body2.messages.length === 3
    && JSON.stringify(body2.messages[1].content) === JSON.stringify(turn.raw.content)) {
    pass('round 2 replays the raw content (thinking + signature) verbatim');
  } else fail('raw replay', body2.messages[1]);
  const tr = body2.messages[2]?.content?.[0];
  if (tr?.type === 'tool_result' && tr.tool_use_id === 'toolu_01') pass('tool result rides back as tool_result');
  else fail('tool_result shape', body2.messages[2]);
  if (turn2.stop === 'end') pass('end_turn maps to stop: end');
  else fail('round 2 stop', turn2.stop);

  const hosts = [...new Set(requests.map((r) => new URL(r.url).host))];
  if (hosts.length === 1 && hosts[0] === 'bedrock-mantle.us-east-1.api.aws') {
    pass(`egress witness: only ${hosts[0]} was ever contacted`);
  } else fail('unexpected egress hosts', hosts);
} catch (err) {
  fail('driver threw offline', { message: err?.message });
} finally {
  globalThis.fetch = realFetch;
}

// ── 4–5. live, only with real keys ──────────────────────────────────────
let env = {};
try {
  const txt = await fs.readFile(new URL('../.env', import.meta.url), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — offline only */ }
const liveCreds = bedrockCredsFromEnv(env);
if (!liveCreds) {
  console.log('\nlive section SKIPPED — BEDROCK_ keys in .env are placeholders.');
  console.log('Provision per docs/BEDROCK_CLAUDE_PEN_SETUP.md, then re-run.');
} else {
  console.log('\nlive: retention mode (the seal claim, read with the pen\'s own key)');
  const modelUrl = `https://bedrock-mantle.${liveCreds.region}.api.aws/v1/models/${PENS.bedrock.model}`;
  let retentionOk = false;
  try {
    const headers = signRequest({
      method: 'GET', url: modelUrl, headers: { accept: 'application/json' }, body: '',
      region: liveCreds.region, service: 'bedrock-mantle',
      accessKeyId: liveCreds.accessKeyId, secretAccessKey: liveCreds.secretAccessKey,
      sessionToken: liveCreds.sessionToken,
    });
    const res = await fetch(modelUrl, { headers });
    const info = await res.json().catch(() => null);
    if (!res.ok) {
      fail(`GetModel returned ${res.status} — does the key's policy include bedrock-mantle:GetModel?`, info);
    } else {
      const dr = info?.data_retention;
      console.log(`        model ${info?.id}: status=${info?.status} mode=${dr?.mode} (source: ${dr?.source}) allowed=${JSON.stringify(dr?.allowed_modes)}`);
      if (dr?.mode === 'none') { retentionOk = true; pass('effective data_retention_mode is none — the seal claim is TRUE'); }
      else fail(`data_retention_mode is '${dr?.mode}', not 'none' — run step 2 of docs/BEDROCK_CLAUDE_PEN_SETUP.md before trusting the seal`);
      if (Array.isArray(dr?.allowed_modes) && !dr.allowed_modes.includes('none')) {
        fail('this model does not allow mode none for this account — wrong model or account');
      }
    }
  } catch (err) {
    fail('GetModel failed', { message: err?.message });
  }

  if (retentionOk) {
    console.log('\nlive: one one-line invoke');
    try {
      let text = '';
      const turn = await bedrockTurn({
        pen: { ...PENS.bedrock, creds: liveCreds, escalation: false },
        system: 'You are a connectivity check. Obey exactly.',
        tools: [],
        convo: [{ role: 'user', text: 'Reply with exactly the single word: sealed' }],
        onText: (t) => { text += t; },
      });
      if (text.trim() && turn.usage.input > 0 && turn.usage.output > 0) {
        pass(`live answer: "${text.trim().slice(0, 40)}" (${turn.usage.input}/${turn.usage.output} tok)`);
      } else fail('live invoke returned no text/usage', { text, usage: turn.usage });
    } catch (err) {
      fail('live invoke failed', { message: err?.message });
    }
  } else {
    console.log('\nlive invoke SKIPPED — nothing is sent until the retention mode is proven.');
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures ? 1 : 0);
