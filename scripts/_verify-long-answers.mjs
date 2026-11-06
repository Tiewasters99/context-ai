// A long answer is CONTINUED, not cut off (2026-11-06).
//
//   node scripts/_verify-long-answers.mjs
//
// Offline and secret-free: `fetch` is stubbed. Until 2026-11-06 one reply was
// capped at 8,192 tokens and a reply that reached the cap was treated as
// finished — a running case list on a sealed matter stopped mid-stream with
// no word of why. Now:
//
//   1. The Claude pens ask for MAX_OUTPUT_TOKENS (32,000) per reply.
//   2. A reply that stops at the cap is continued in the same turn: the next
//      request carries the text so far and a "continue exactly where it
//      stopped" message, and the user sees one unbroken answer.
//   3. Past MAX_CONTINUATIONS the answer ends with a plain sentence saying
//      how to get the rest — never silently.
//   4. The OpenAI-compatible route's `length` finish is the same stop.
import {
  runAssistantStream, bedrockCredsFromEnv, MAX_OUTPUT_TOKENS, MAX_CONTINUATIONS,
} from '../lib/assistant-core.mjs';
import { eventStreamBody, isRuntimeInvoke } from './_bedrock-eventstream.mjs';

let failures = 0;
const check = (ok, m, d) => {
  if (ok) console.log(`  PASS  ${m}`);
  else { console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${JSON.stringify(d)?.slice(0, 400)}` : ''}`); failures++; }
};

const CREDS = bedrockCredsFromEnv({ BEDROCK_AWS_ACCESS_KEY_ID: 'AKIDTEST', BEDROCK_AWS_SECRET_ACCESS_KEY: 'testsecret' });
const KIMI_CREDS = { ...CREDS, model: 'moonshotai.kimi-k2.5' };

function stubSupabase() {
  const table = (name) => {
    const q = {
      select() { return q; }, eq() { return q; }, in() { return q; }, order() { return q; },
      limit() { return Promise.resolve({ data: [], error: null }); },
      maybeSingle() {
        if (name === 'matterspaces') return Promise.resolve({ data: { id: 'm-1', parent_matterspace_id: null, ai_tier: 'B' }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      single() { return Promise.resolve({ data: null, error: { message: 'stub' } }); },
      insert() {
        const ins = {
          select() { return ins; },
          single() {
            return Promise.resolve(name === 'ai_sessions'
              ? { data: { id: 'sess-1', matterspace_id: 'm-1', tier: 'B', status: 'open' }, error: null }
              : { data: null, error: null });
          },
          then(res) { return Promise.resolve({ data: null, error: null }).then(res); },
        };
        return ins;
      },
      update() { return { eq: () => Promise.resolve({ data: null, error: null }), then: (r) => Promise.resolve({ error: null }).then(r) }; },
    };
    return q;
  };
  return { from: table, rpc: async () => ({ data: [], error: null }) };
}

const realFetch = globalThis.fetch;
let bodies = [];
function serve(replies) {
  bodies = [];
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    bodies.push(JSON.parse(String(init.body)));
    const r = replies[Math.min(n++, replies.length - 1)];
    return new Response(r(String(url)), { status: 200 });
  };
}

// One Messages reply, in event-stream frames: `text`, then `stop`.
const runtimeReply = (text, stop) => () => eventStreamBody([
  { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
]);
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\ndata: [DONE]\n\n';
const chatReply = (text, finish) => () => sse([
  { choices: [{ index: 0, delta: { role: 'assistant', content: text } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
]);

async function run(bedrockCreds) {
  const events = [];
  await runAssistantStream({
    supabase: stubSupabase(), anthropicKey: 'ak', bedrockCreds, openaiApiKey: 'ok',
    messages: [{ role: 'user', content: 'List every case in the matter.' }],
    matterId: 'm-1', emit: (ev) => events.push(ev),
  });
  return {
    events,
    text: events.filter((e) => e.type === 'text').map((e) => e.text).join(''),
    error: events.find((e) => e.type === 'error'),
  };
}
const lastUserText = (b) => {
  const m = [...(b.messages ?? [])].reverse().find((x) => x.role === 'user');
  return typeof m?.content === 'string' ? m.content : '';
};

try {
  console.log('1. One reply is asked for 32,000 tokens on the sealed Claude pen');
  serve([runtimeReply('Done.', 'end_turn')]);
  {
    await run(CREDS);
    check(MAX_OUTPUT_TOKENS === 32_000, 'MAX_OUTPUT_TOKENS is 32,000');
    check(bodies[0]?.max_tokens === MAX_OUTPUT_TOKENS, 'the request carries max_tokens 32,000', bodies[0]?.max_tokens);
  }

  console.log('\n2. A reply cut at the cap is continued in the same turn');
  serve([runtimeReply('1. Smith v. Jones; 2. Doe v. Ro', 'max_tokens'), runtimeReply('e; 3. Patel v. Kahn.', 'end_turn')]);
  {
    const { text, error } = await run(CREDS);
    check(!error, 'no error', error);
    check(bodies.length === 2, 'two requests: the reply and its continuation', bodies.length);
    check(text === '1. Smith v. Jones; 2. Doe v. Roe; 3. Patel v. Kahn.', 'the user sees one unbroken answer', text);
    check(/Continue exactly where it stopped/.test(lastUserText(bodies[1])), 'the continuation asks for the rest, exactly where it stopped', lastUserText(bodies[1]));
    const prior = bodies[1].messages.at(-2);
    check(prior?.role === 'assistant' && JSON.stringify(prior.content).includes('Doe v. Ro'),
      'and carries the text so far as the assistant turn before it', prior);
  }

  console.log(`\n3. Past ${MAX_CONTINUATIONS} continuations, the answer says how to get the rest`);
  serve([runtimeReply('more… ', 'max_tokens')]);
  {
    const { text, error } = await run(CREDS);
    check(!error, 'no error', error);
    check(bodies.length === MAX_CONTINUATIONS + 1, `${MAX_CONTINUATIONS + 1} requests, then it stops`, bodies.length);
    check(/longer than one message can hold\. Say "continue"/.test(text), 'ends with the plain "say continue" sentence', text.slice(-160));
    check(!/ran out of search steps/.test(text), 'not the out-of-search-steps note');
  }

  console.log('\n4. The OpenAI-compatible route: finish_reason "length" is the same stop');
  serve([chatReply('Alpha, be', 'length'), chatReply('ta, gamma.', 'stop')]);
  {
    const { text, error } = await run(KIMI_CREDS);
    check(!error, 'no error', error);
    check(bodies.length === 2, 'two requests', bodies.length);
    check(text === 'Alpha, beta, gamma.', 'one unbroken answer', text);
  }

  console.log('\n5. A short answer is unaffected');
  serve([runtimeReply('Short answer.', 'end_turn')]);
  {
    const { text } = await run(CREDS);
    check(text === 'Short answer.' && bodies.length === 1, 'a normal answer is one request, unchanged', { text, n: bodies.length });
  }
} finally {
  globalThis.fetch = realFetch;
}

void isRuntimeInvoke;
console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
