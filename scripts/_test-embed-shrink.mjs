// Checks for the 8192-token per-input failure (2026-08-02).
//
// The bug: the per-passage cap truncated at MAX_INPUT_TOKENS * 4, reusing the
// average-case chars/token ratio that overflowed in the first place. Dense
// text then 400'd again at the same point, deterministically, and took its
// whole document with it. Two defences are tested here — a pessimistic cap,
// and a retry that shrinks whichever input the API names.

import assert from 'node:assert';
import {
  MAX_INPUT_CHARS, MAX_INPUT_TOKENS, embedBatch, parseOversizedInput,
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

console.log(`\nAll ${passed} embed-shrink checks passed.`);
