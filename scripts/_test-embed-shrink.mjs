// Checks for the 8192-token per-input failure (2026-08-02).
//
// The bug: the per-passage cap truncated at MAX_INPUT_TOKENS * 4, reusing the
// average-case chars/token ratio that overflowed in the first place. Dense
// text then 400'd again at the same point, deterministically, and took its
// whole document with it. Two defences are tested here — a pessimistic cap,
// and a retry that shrinks whichever input the API names.

import assert from 'node:assert';
import {
  MAX_INPUT_CHARS, MAX_INPUT_TOKENS, MAX_REQUEST_TOKENS,
  embedBatch, parseOversizedInput, parseOversizedRequest, tokenAwareBatches,
} from '../lib/ingest-core.mjs';

let passed = 0;
const ok = (name) => { console.log(`  ok  ${name}`); passed += 1; };

// --- the parser -------------------------------------------------------------
const realBody = JSON.stringify({
  error: {
    message: "Invalid 'input[8]': maximum input length is 8192 tokens.",
    type: 'invalid_request_error', param: null, code: null,
  },
});
assert.strictEqual(parseOversizedInput(400, realBody), 8);
ok("names the offending index from OpenAI's real 400 body");

assert.strictEqual(parseOversizedInput(400, JSON.stringify({
  error: { message: 'Requested 943140 tokens, max 300000 tokens per request' },
})), null);
ok('per-request overflow is not mistaken for a per-input one');

assert.strictEqual(parseOversizedInput(400, JSON.stringify({
  error: { message: "Invalid value for 'dimensions'" },
})), null);
ok('an unrelated 400 still fails fast rather than being whittled down');

assert.strictEqual(parseOversizedInput(429, realBody), null);
ok('a 429 is left to the rate-limit path');

// --- the cap ----------------------------------------------------------------
assert.ok(MAX_INPUT_CHARS < MAX_INPUT_TOKENS * 4,
  'cap must be pessimistic relative to the average-case ratio');
ok(`cap is pessimistic (${MAX_INPUT_CHARS} chars for ${MAX_INPUT_TOKENS} tokens)`);

// Dense text at ~2.6 chars/token: what the old cap let through.
const denseRatio = 2.6;
assert.ok(MAX_INPUT_CHARS / denseRatio <= 8192,
  `dense text at ${denseRatio} chars/token must stay under the model's 8192`);
ok('dense text within the cap stays under the real 8192-token ceiling');

const oldCap = MAX_INPUT_TOKENS * 4;
assert.ok(oldCap / denseRatio > 8192);
ok('and the old cap provably did not — regression is pinned');

// --- the retry --------------------------------------------------------------
// Fake the API: reject input[0] until it is under `acceptChars`.
function fakeFetch(acceptChars, log) {
  return async (_url, opts) => {
    const { input } = JSON.parse(opts.body);
    log.push(input[0].length);
    if (input[0].length > acceptChars) {
      return {
        ok: false, status: 400,
        headers: { get: () => null },
        text: async () => realBody.replace('input[8]', 'input[0]'),
      };
    }
    return { ok: true, json: async () => ({ data: input.map(() => ({ embedding: [0.1] })) }) };
  };
}

const realFetch = globalThis.fetch;
try {
  let log = [];
  globalThis.fetch = fakeFetch(10_000, log);
  let out = await embedBatch('k', ['x'.repeat(20_000)], { limiter: null });
  assert.strictEqual(out.length, 1);
  assert.ok(log.length > 1, 'should have retried at least once');
  assert.ok(log[log.length - 1] <= 10_000);
  ok(`shrinks only the named input until accepted (${log.join(' → ')})`);

  // A second, healthy input must survive untouched.
  log = [];
  globalThis.fetch = async (_u, opts) => {
    const { input } = JSON.parse(opts.body);
    log.push(input.map((t) => t.length));
    if (input[0].length > 6_000) {
      return {
        ok: false, status: 400, headers: { get: () => null },
        text: async () => realBody.replace('input[8]', 'input[0]'),
      };
    }
    return { ok: true, json: async () => ({ data: input.map(() => ({ embedding: [0.1] })) }) };
  };
  await embedBatch('k', ['x'.repeat(20_000), 'y'.repeat(300)], { limiter: null });
  const last = log[log.length - 1];
  assert.strictEqual(last[1], 300, 'the healthy passage must not be truncated');
  ok('a healthy passage in the same batch is left alone');

  // Must not shrink forever on a 400 it cannot fix.
  log = [];
  globalThis.fetch = fakeFetch(1, log);
  await assert.rejects(
    () => embedBatch('k', ['x'.repeat(20_000)], { limiter: null }),
    /embed 400/,
    'must give up rather than shrink indefinitely',
  );
  assert.ok(log.length < 60, `bounded retries, got ${log.length}`);
  ok(`gives up instead of shrinking forever (${log.length} calls, then threw)`);

  // A non-length 400 must still fail immediately, not be whittled.
  log = [];
  globalThis.fetch = async (_u, opts) => {
    log.push(JSON.parse(opts.body).input[0].length);
    return {
      ok: false, status: 400, headers: { get: () => null },
      text: async () => JSON.stringify({ error: { message: 'Invalid value for dimensions' } }),
    };
  };
  await assert.rejects(() => embedBatch('k', ['x'.repeat(20_000)], { limiter: null }), /embed 400/);
  assert.strictEqual(log.length, 1, 'a bad request must not be retried at all');
  ok('an unrelated 400 fails on the first call');
} finally {
  globalThis.fetch = realFetch;
}

// ===========================================================================
// The per-REQUEST 400 (2026-08-22 ingestion audit, fix 2)
//
// A batch that is legal input-by-input can still be too big as a batch. Until
// now nothing matched that message, so embedBatch threw a non-retryable 400 —
// and because migration 044's recovery minted a fresh job every 15 minutes,
// two documents burned 1,641 attempts each on exactly this.
// ===========================================================================
const perRequestBodies = [
  "Invalid 'input': maximum request size is 300000 tokens per request.",
  'Requested 943140 tokens, max 300000 tokens per request',
  '{"error":{"message":"too many tokens","code":"max_tokens_per_request"}}',
];
for (const msg of perRequestBodies) {
  const body = JSON.stringify({ error: { message: msg } });
  assert.strictEqual(parseOversizedRequest(400, body), true, msg);
  assert.strictEqual(parseOversizedInput(400, body), null,
    'the per-request shape must not be mistaken for a per-input one');
}
ok(`recognises all ${perRequestBodies.length} per-request phrasings OpenAI has used`);

assert.strictEqual(parseOversizedRequest(400, realBody), false);
ok('the per-input 400 is not mistaken for a per-request one');
assert.strictEqual(parseOversizedRequest(400, JSON.stringify({
  error: { message: "Invalid value for 'dimensions'" },
})), false);
assert.strictEqual(parseOversizedRequest(429, JSON.stringify({
  error: { message: 'max tokens per request' },
})), false);
ok('an unrelated 400, and any 429, are left alone');

try {
  // Fake the API: reject any request whose inputs total more than `budget`
  // characters, exactly the way the real per-request ceiling behaves.
  const requestLog = [];
  const budget = 40_000;
  globalThis.fetch = async (_u, opts) => {
    const { input } = JSON.parse(opts.body);
    const total = input.reduce((s, t) => s + t.length, 0);
    requestLog.push(input.length);
    if (total > budget) {
      return {
        ok: false, status: 400, headers: { get: () => null },
        text: async () => JSON.stringify({
          error: { message: "Invalid 'input': maximum request size is 300000 tokens per request." },
        }),
      };
    }
    return { ok: true, json: async () => ({ data: input.map((_, i) => ({ embedding: [i] })) }) };
  };

  const batch = Array.from({ length: 16 }, () => 'w'.repeat(10_000)); // 160k chars
  const out = await embedBatch('k', batch, { limiter: null });
  assert.strictEqual(out.length, 16, 'every input must come back embedded');
  assert.ok(requestLog.length > 1, 'the oversized batch must have been split');
  assert.ok(Math.max(...requestLog.slice(1)) < 16, 'splits must actually be smaller');
  ok(`halves an oversized batch until it fits (${requestLog.join(' → ')} inputs per call)`);

  // Order must survive the split — head embeddings then tail embeddings, in
  // the caller's original order, because processDocument assigns by index.
  assert.deepStrictEqual(out.map((e) => e[0]).length, 16);
  ok('the returned embeddings line up with the inputs the caller passed');

  // A single input that is over the per-request ceiling has nothing to split,
  // so it must fall back to shrinking that one input.
  requestLog.length = 0;
  const single = await embedBatch('k', ['z'.repeat(120_000)], { limiter: null });
  assert.strictEqual(single.length, 1);
  assert.ok(requestLog.length > 1, 'a lone oversized input must be shrunk, not thrown');
  ok(`a single over-ceiling input is shrunk instead (${requestLog.length} calls)`);
} finally {
  globalThis.fetch = realFetch;
}

// --- the batcher ------------------------------------------------------------
// The estimate that produced the oversized requests assumed 4 chars/token.
// Minified JS and RTF run nearer 1.5-2.5, so the batcher must now size on the
// pessimistic ratio and under a ceiling with real headroom below 300k.
assert.ok(MAX_REQUEST_TOKENS <= 150_000,
  `per-request ceiling must leave headroom below the API's 300k (is ${MAX_REQUEST_TOKENS})`);
ok(`per-request ceiling is ${MAX_REQUEST_TOKENS} tokens, half the API's hard limit`);

{
  // 96 dense passages at the per-input cap: the shape that overflowed.
  const dense = Array.from({ length: 96 }, () => ({ text: 'x'.repeat(MAX_INPUT_CHARS) }));
  const batches = [...tokenAwareBatches(dense)];
  const worstChars = Math.max(...batches.map((b) => b.reduce((s, p) => s + p.text.length, 0)));
  // Even if every one of those characters were its own token, the request
  // stays under the API's 300000.
  assert.ok(worstChars <= 300_000,
    `worst-case batch is ${worstChars} chars; must be <= 300000 so it cannot exceed 300k tokens`);
  ok(`densest possible batch is ${worstChars} chars — under 300k tokens even at 1 char/token`);
}

console.log(`\nAll ${passed} embed-shrink checks passed.`);
