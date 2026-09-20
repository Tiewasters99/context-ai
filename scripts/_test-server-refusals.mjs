// Unit tests for the browser half of a refused request: parseRefusalBody /
// parseServerRefusal in src/lib/llm/refusals.ts. Nothing here touches a
// network, a database or a provider — every body below is a literal copy of
// the shape a server actually sends.
//
//   node --import ./scripts/_node-src-loader.mjs --test scripts/_test-server-refusals.mjs
//
// The loader teaches plain node the vite '@/' alias; Node 22.18+ strips the
// .ts types. The server half of the same contract is
// scripts/_test-usage-meter.mjs (lib/usage-meter.mjs) and
// scripts/_verify-usage-budget.mjs (migration 063 in PGlite).
//
// Sources for the canned bodies:
//   402 / 429  supabase/migrations/063_usage_budgets.sql (usage_consume) and
//              lib/usage-meter.mjs (sendUsageRefusal), i.e. PR #161.
//   403 / 502 / 503  api/llm.mjs + lib/llm-sealed-route.mjs, i.e. PRs #159/#163.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRefusalBody,
  parseServerRefusal,
  llmErrorText,
  withoutUpsell,
  ServerRefusalError,
  isFinalRefusal,
  waitOutRateWindow,
} from '../src/lib/llm/refusals.ts';

// ---------------------------------------------------------------------------
// The exact bodies. sendUsageRefusal writes {error: reason, message,
// retry_after_seconds}; the RPC's own message is what lands in `message`.
// ---------------------------------------------------------------------------

const BUDGET_402 = {
  error: 'over_monthly_budget',
  message:
    "You have reached this month's included AI usage. It resets at the start of " +
    'next month — or upgrade your plan to continue now.',
  retry_after_seconds: null,
};

const KIND_BUDGET_402 = {
  error: 'over_kind_budget',
  message:
    "You have reached this month's included usage for this feature. It resets at " +
    'the start of next month.',
  retry_after_seconds: null,
};

const RATE_429 = {
  error: 'over_rate_limit',
  message: 'Too many requests in a row. Give it a moment and try again.',
  retry_after_seconds: 60,
};

const METER_ERROR_429 = {
  error: 'meter_error',
  message: 'Registration is temporarily unavailable. Try again shortly.',
  retry_after_seconds: 60,
};

// api/llm.mjs's gate refusal. The server sends no `message` on this one, which
// is the whole reason refusals.ts carries copy at all.
const TIER_VIOLATION_B = { error: 'tier_violation', tier: 'B', provider: 'anthropic' };
const TIER_VIOLATION_C = { error: 'tier_violation', tier: 'C' };
const TIER_VIOLATION_A = { error: 'tier_violation', tier: 'A', provider: 'moonshot' };

const SEALED_UNAVAILABLE_503 = {
  error: 'sealed_pen_unavailable',
  message:
    'This matter is sealed and the sealed pen is not available on this server. Nothing was sent.',
};

const SEALED_ERROR_502 = { error: 'sealed_pen_error' };
const UNTRANSLATABLE_403 = { error: 'sealed_route_untranslatable' };

// A provider's own error object, forwarded verbatim by the passthrough.
const PROVIDER_500 = { error: { type: 'overloaded_error', message: 'Overloaded' } };

// ---------------------------------------------------------------------------

test('402 — the wallet', async (t) => {
  await t.test('classified as budget from the status', () => {
    assert.equal(parseRefusalBody(402, BUDGET_402).kind, 'budget');
  });

  await t.test('says what was reached and that it resets monthly', () => {
    const { message } = parseRefusalBody(402, BUDGET_402);
    assert.match(message, /included AI usage/);
    assert.match(message, /resets at the start of next month\.$/);
  });

  await t.test('carries no upsell — there is no plan to buy yet', () => {
    const { message } = parseRefusalBody(402, BUDGET_402);
    assert.doesNotMatch(message, /upgrade/i);
    assert.doesNotMatch(message, /plan/i);
  });

  await t.test('names no plan and no price', () => {
    const { message } = parseRefusalBody(402, BUDGET_402);
    assert.doesNotMatch(message, /\$|free|pro\b|max\b|workshop/i);
  });

  await t.test('the per-kind cap has no upsell to strip and survives whole', () => {
    const { kind, message } = parseRefusalBody(402, KIND_BUDGET_402);
    assert.equal(kind, 'budget');
    assert.equal(message, KIND_BUDGET_402.message);
  });

  await t.test("#163's harness reason (budget_exhausted) reads the same", () => {
    const r = parseRefusalBody(402, { error: 'budget_exhausted', message: BUDGET_402.message });
    assert.equal(r.kind, 'budget');
    assert.doesNotMatch(r.message, /upgrade/i);
  });

  await t.test('a 402 with no body at all still gets a sentence', () => {
    const { kind, message } = parseRefusalBody(402, null);
    assert.equal(kind, 'budget');
    assert.match(message, /resets at the start of next month/);
    assert.doesNotMatch(message, /402/);
  });

  await t.test('the trimmed sentence is usage-meter.mjs\'s own fallback', () => {
    // lib/usage-meter.mjs, sendUsageRefusal: the message it writes when the
    // RPC sent none. Trimming must land on exactly this, or the product has
    // two voices for one refusal.
    assert.equal(
      parseRefusalBody(402, null).message,
      "You've reached this month's included AI usage. It resets at the start of next month.",
    );
  });

  await t.test('withoutUpsell leaves an unrelated sentence alone', () => {
    assert.equal(withoutUpsell('Nothing was sent.'), 'Nothing was sent.');
  });
});

test('429 — the rate window', async (t) => {
  await t.test('classified as rate, with the seconds', () => {
    const r = parseRefusalBody(429, RATE_429);
    assert.equal(r.kind, 'rate');
    assert.equal(r.retryAfterSeconds, 60);
  });

  await t.test('the sentence carries the number the server sent', () => {
    assert.equal(
      parseRefusalBody(429, RATE_429).message,
      'Too many requests just now — try again in 60 seconds.',
    );
  });

  await t.test('one second is singular', () => {
    assert.match(
      parseRefusalBody(429, { ...RATE_429, retry_after_seconds: 1 }).message,
      /try again in 1 second\./,
    );
  });

  await t.test('a fractional window is rounded up, never down to zero', () => {
    const r = parseRefusalBody(429, { ...RATE_429, retry_after_seconds: 0.4 });
    assert.equal(r.retryAfterSeconds, 1);
  });

  await t.test('the retry-after HEADER is read when the body has none', () => {
    const r = parseRefusalBody(429, { error: 'over_rate_limit' }, '30');
    assert.equal(r.retryAfterSeconds, 30);
    assert.match(r.message, /try again in 30 seconds\./);
  });

  await t.test("with no seconds anywhere, the server's own sentence is kept", () => {
    const r = parseRefusalBody(429, { error: 'over_rate_limit', message: RATE_429.message });
    assert.equal(r.message, RATE_429.message);
    assert.equal(r.retryAfterSeconds, undefined);
  });

  await t.test('the IP limiter\'s meter_error is a rate refusal too', () => {
    assert.equal(parseRefusalBody(429, METER_ERROR_429).kind, 'rate');
  });

  await t.test('a 429 with an empty body still reads as a rate limit', () => {
    const r = parseRefusalBody(429, null);
    assert.equal(r.kind, 'rate');
    assert.match(r.message, /Too many requests/);
  });
});

test('403 / 502 / 503 — the seal', async (t) => {
  await t.test('tier B: nothing was sent, and it says so', () => {
    const r = parseRefusalBody(403, TIER_VIOLATION_B);
    assert.equal(r.kind, 'sealed');
    assert.match(r.message, /anthropic is outside the seal/);
    assert.match(r.message, /Nothing was sent/);
    assert.doesNotMatch(r.message, /tier_violation/);
  });

  await t.test('tier C is the Silo wording, not the Tier-B one', () => {
    const r = parseRefusalBody(403, TIER_VIOLATION_C);
    assert.equal(r.kind, 'sealed');
    assert.match(r.message, /Silo/);
  });

  await t.test('tier A still refuses one provider, in its own words', () => {
    const r = parseRefusalBody(403, TIER_VIOLATION_A);
    assert.equal(r.kind, 'sealed');
    assert.match(r.message, /moonshot is not permitted on a matter/);
  });

  await t.test("the server's own sentence is used verbatim when it sends one", () => {
    const r = parseRefusalBody(503, SEALED_UNAVAILABLE_503);
    assert.equal(r.kind, 'sealed');
    assert.equal(r.message, SEALED_UNAVAILABLE_503.message);
  });

  await t.test('502 sealed_pen_error: no other model was asked', () => {
    const r = parseRefusalBody(502, SEALED_ERROR_502);
    assert.equal(r.kind, 'sealed');
    assert.match(r.message, /No other model was asked/);
  });

  await t.test('403 sealed_route_untranslatable: nothing was sent', () => {
    const r = parseRefusalBody(403, UNTRANSLATABLE_403);
    assert.equal(r.kind, 'sealed');
    assert.match(r.message, /Nothing was sent/);
  });

  await t.test('503 exchange_unrecorded: the Record could not be written, so nothing was sent', () => {
    // The one refusal whose whole point is the second half of the sentence.
    // /api/llm writes the matter's Record BEFORE the provider is contacted, so
    // unlike the Assistant's refusal of the same name, this one can truthfully
    // say nothing was sent — and a lawyer reading it needs to know that.
    const r = parseRefusalBody(503, { error: 'exchange_unrecorded', tier: 'B' });
    assert.equal(r.kind, 'sealed');
    assert.match(r.message, /nothing was sent/i);
    assert.match(r.message, /no model was asked/i);
    assert.doesNotMatch(r.message, /claude/i);
  });

  await t.test('and the server’s own sentence still wins where it sends one', () => {
    const r = parseRefusalBody(503, { error: 'exchange_unrecorded', tier: 'B', message: 'Its own words.' });
    assert.equal(r.message, 'Its own words.');
  });

  await t.test('a sealed code is never mistaken for the wallet, whatever the status', () => {
    // A 402 that somehow carried a sealed code must still read as the seal:
    // "you are out of money" and "your client file was not sent" are not the
    // same news.
    assert.equal(parseRefusalBody(402, { error: 'sealed_pen_error' }).kind, 'sealed');
  });
});

test('5xx and everything else', async (t) => {
  await t.test("a provider's own error object is surfaced, not swallowed", () => {
    const r = parseRefusalBody(500, PROVIDER_500);
    assert.equal(r.kind, 'other');
    assert.equal(r.message, 'Overloaded');
  });

  await t.test('a 500 with no body is a sentence, not "API error (500)"', () => {
    const r = parseRefusalBody(500, null);
    assert.equal(r.kind, 'other');
    assert.match(r.message, /The server refused this step \(500\)\./);
  });

  await t.test('a non-JSON body (an HTML error page) does not throw', () => {
    const r = parseRefusalBody(502, '<html>502 Bad Gateway</html>');
    assert.equal(r.kind, 'other');
    assert.equal(typeof r.message, 'string');
  });

  await t.test('401 auth_required keeps its copy', () => {
    assert.match(parseRefusalBody(401, { error: 'auth_required' }).message, /sign in again/);
  });

  await t.test('an unknown code is shown rather than invented over', () => {
    assert.equal(parseRefusalBody(400, { error: 'request_too_large' }).message, 'request_too_large');
  });

  await t.test('413 request_too_large keeps the server sentence', () => {
    const body = {
      error: 'request_too_large',
      message: 'That request is larger than your plan allows (1024 KB). Send less text at a time.',
    };
    assert.equal(parseRefusalBody(413, body).message, body.message);
  });
});

test('parseServerRefusal reads a Response once and never throws', async (t) => {
  const responseOf = (status, body, headers = {}) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

  await t.test('402 through the async wrapper', async () => {
    const r = await parseServerRefusal(responseOf(402, BUDGET_402));
    assert.equal(r.kind, 'budget');
    assert.doesNotMatch(r.message, /upgrade/i);
  });

  await t.test('the retry-after header reaches the sentence', async () => {
    const r = await parseServerRefusal(
      responseOf(429, { error: 'over_rate_limit' }, { 'retry-after': '45' }),
    );
    assert.equal(r.retryAfterSeconds, 45);
    assert.match(r.message, /try again in 45 seconds\./);
  });

  await t.test('an empty body is survivable', async () => {
    const r = await parseServerRefusal(new Response(null, { status: 429 }));
    assert.equal(r.kind, 'rate');
  });

  await t.test('a body that is not JSON is survivable', async () => {
    const r = await parseServerRefusal(responseOf(500, 'upstream timeout'));
    assert.equal(r.kind, 'other');
  });

  await t.test('status survives the round trip, for logs', async () => {
    const r = await parseServerRefusal(responseOf(503, SEALED_UNAVAILABLE_503));
    assert.equal(r.status, 503);
    assert.equal(r.code, 'sealed_pen_unavailable');
  });
});

test('llmErrorText stays the thin caller generate/converse/structured use', async (t) => {
  await t.test('it is exactly the parsed message', () => {
    assert.equal(llmErrorText(403, TIER_VIOLATION_B), parseRefusalBody(403, TIER_VIOLATION_B).message);
  });

  await t.test('the 402 that used to read "API error (402)" now reads as English', () => {
    const text = llmErrorText(402, BUDGET_402);
    assert.doesNotMatch(text, /API error/);
    assert.match(text, /included AI usage/);
  });

  await t.test('it forwards the retry-after header', () => {
    assert.match(llmErrorText(429, { error: 'over_rate_limit' }, '12'), /try again in 12 seconds\./);
  });
});

test('ServerRefusalError — what stops a retry and what does not', async (t) => {
  await t.test('it is an ordinary Error whose message is the sentence', () => {
    const err = new ServerRefusalError(parseRefusalBody(402, BUDGET_402));
    assert.ok(err instanceof Error);
    assert.equal(err.message, parseRefusalBody(402, BUDGET_402).message);
    assert.equal(err.name, 'ServerRefusalError');
  });

  await t.test('the wallet is final — swapping pens will not help', () => {
    assert.equal(isFinalRefusal(new ServerRefusalError(parseRefusalBody(402, BUDGET_402))), true);
  });

  await t.test('the rate window is final for this attempt', () => {
    assert.equal(isFinalRefusal(new ServerRefusalError(parseRefusalBody(429, RATE_429))), true);
  });

  await t.test('a sealed matter is final — no other model may be asked', () => {
    assert.equal(isFinalRefusal(new ServerRefusalError(parseRefusalBody(403, TIER_VIOLATION_B))), true);
  });

  await t.test('a provider 5xx is NOT final — the fallback pen still runs', () => {
    assert.equal(isFinalRefusal(new ServerRefusalError(parseRefusalBody(500, PROVIDER_500))), false);
  });

  await t.test('a plain Error is not a refusal', () => {
    assert.equal(isFinalRefusal(new Error('Network error calling the model proxy.')), false);
    assert.equal(isFinalRefusal(undefined), false);
  });

  await t.test('the kind survives, so a caller can branch on it', () => {
    const err = new ServerRefusalError(parseRefusalBody(429, RATE_429));
    assert.equal(err.refusal.kind, 'rate');
    assert.equal(err.refusal.retryAfterSeconds, 60);
  });
});

test('waitOutRateWindow — the one refusal time alone fixes', async (t) => {
  const refusalOf = (status, body, header) =>
    new ServerRefusalError(parseRefusalBody(status, body, header));

  await t.test('a short window is waited out, and the caller retries', async () => {
    const started = Date.now();
    const waited = await waitOutRateWindow(refusalOf(429, { ...RATE_429, retry_after_seconds: 0.05 }));
    assert.equal(waited, true);
    assert.ok(Date.now() - started >= 40, 'it actually waited');
  });

  await t.test('a spent wallet is never waited out — time does not refill it', async () => {
    assert.equal(await waitOutRateWindow(refusalOf(402, BUDGET_402)), false);
  });

  await t.test('a sealed matter is never waited out', async () => {
    assert.equal(await waitOutRateWindow(refusalOf(403, TIER_VIOLATION_B)), false);
  });

  await t.test('a provider 5xx is not this function\'s business', async () => {
    assert.equal(await waitOutRateWindow(refusalOf(500, PROVIDER_500)), false);
  });

  await t.test('a window longer than two minutes is not sat out', async () => {
    assert.equal(
      await waitOutRateWindow(refusalOf(429, { ...RATE_429, retry_after_seconds: 3600 })),
      false,
    );
  });

  await t.test('a 429 that named no seconds is not sat out blind', async () => {
    assert.equal(await waitOutRateWindow(refusalOf(429, { error: 'over_rate_limit' })), false);
  });

  await t.test('an already-aborted run does not wait at all', async () => {
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    assert.equal(
      await waitOutRateWindow(refusalOf(429, { ...RATE_429, retry_after_seconds: 5 }), ac.signal),
      false,
    );
    assert.ok(Date.now() - started < 200, 'it returned immediately');
  });

  await t.test('a run aborted DURING the wait does not retry', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const waited = await waitOutRateWindow(
      refusalOf(429, { ...RATE_429, retry_after_seconds: 0.1 }),
      ac.signal,
    );
    assert.equal(waited, false);
  });

  await t.test('a plain Error is not a rate window', async () => {
    assert.equal(await waitOutRateWindow(new Error('boom')), false);
  });
});

test('no refusal ever shows a machine code or raw JSON to a person', async () => {
  const cases = [
    [402, BUDGET_402], [402, KIND_BUDGET_402], [402, null],
    [429, RATE_429], [429, METER_ERROR_429], [429, null],
    [403, TIER_VIOLATION_A], [403, TIER_VIOLATION_B], [403, TIER_VIOLATION_C],
    [403, UNTRANSLATABLE_403], [502, SEALED_ERROR_502], [503, SEALED_UNAVAILABLE_503],
  ];
  for (const [status, body] of cases) {
    const { message } = parseRefusalBody(status, body);
    assert.doesNotMatch(message, /[{}[\]]/, `JSON punctuation in: ${message}`);
    assert.doesNotMatch(message, /_[a-z]/, `machine code in: ${message}`);
    assert.ok(/[.!]$/.test(message.trim()), `not a sentence: ${message}`);
  }
});
