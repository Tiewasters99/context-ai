// Unit tests for the handler-side half of the spend cap: lib/usage-meter.mjs
// and lib/usage-prices.mjs. The RPC is stubbed, so nothing here touches a
// database, a network or a provider.
//
//   node --test scripts/_test-usage-meter.mjs
//
// The database half is scripts/_verify-usage-budget.mjs, which executes
// migration 063 against a real Postgres in PGlite.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  consumeUsage,
  consumeIpUsage,
  recordActualUsage,
  sendUsageRefusal,
  clampMaxTokens,
  clientIp,
  DEGRADED_CEILING,
  resetDegradedCeiling,
} from '../lib/usage-meter.mjs';
import {
  PRICES_PER_MTOK,
  ratePerMtok,
  centsForTokens,
  estimateLlmCents,
  estimateTtsCents,
  estimateOcrCents,
  estimateIngestCents,
} from '../lib/usage-prices.mjs';

const ENV = { supabaseUrl: 'https://db.example.test', anonKey: 'anon-key' };

/** A stub fetch that answers once with the given status/body, recording the call. */
function stubFetch(status, body, calls = []) {
  return async (url, init) => {
    calls.push({ url, init, args: JSON.parse(init.body) });
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    ended: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(payload) { this.ended = payload; return this; },
  };
}

// ---------------------------------------------------------------------------
// The price tables must not drift from the ones already in the repo. These
// imports are why this file is a TEST and not part of the request path.
// ---------------------------------------------------------------------------
test('the mirrored price table still matches lib/ocr-anthropic.mjs', async () => {
  const { ANTHROPIC_PRICES_PER_MTOK } = await import('../lib/ocr-anthropic.mjs');
  for (const [model, rate] of Object.entries(ANTHROPIC_PRICES_PER_MTOK)) {
    assert.deepEqual(PRICES_PER_MTOK[model], rate, `${model} has drifted from ANTHROPIC_PRICES_PER_MTOK`);
  }
});

test('the mirrored price table still matches the pens in lib/assistant-core.mjs', async () => {
  const { PENS } = await import('../lib/assistant-core.mjs');
  for (const pen of Object.values(PENS)) {
    if (!pen.pricePerM) continue;
    assert.deepEqual(
      PRICES_PER_MTOK[pen.model],
      [pen.pricePerM.input, pen.pricePerM.output],
      `${pen.model} has drifted from PENS[*].pricePerM`,
    );
  }
});

// The /api/llm sealed route (PR #163) substitutes the Bedrock pen for the
// model the browser named, and api/llm.mjs meters the turn on the pen. That
// only works while the pen's own id resolves to the pen's own rate here — if
// it ever fell through to the aws-bedrock fallback, a sealed Kimi turn would
// be billed at the Claude-on-Bedrock rate, which is the bug in miniature.
test('a sealed turn prices at the pen that answers, not at the model the browser named', async () => {
  const { PENS } = await import('../lib/assistant-core.mjs');
  for (const pen of [PENS.bedrockOpen, PENS.bedrock]) {
    assert.deepEqual(
      ratePerMtok(pen.model, 'aws-bedrock'),
      [pen.pricePerM.input, pen.pricePerM.output],
      `${pen.model} does not resolve to its own rate — a sealed turn would be mispriced`,
    );
  }
  // The headline: one sealed Bucketizer classify, the same tokens, both ways.
  const usage = { input: 38_000, output: 2_400 };
  const atThePen = centsForTokens(PENS.bedrockOpen.model, 'aws-bedrock', usage);
  const asBrowserNamed = centsForTokens('claude-opus-4-8', 'anthropic', usage);
  assert.equal(atThePen, 3);
  assert.equal(asBrowserNamed, 25);
  assert.ok(atThePen * 4 < asBrowserNamed, 'the sealed rate should be several times cheaper');
  // A BEDROCK_MODEL nobody has listed must not be cheap by accident: the
  // aws-bedrock fallback is the dearest sealed rate we know.
  assert.deepEqual(ratePerMtok('some.unlisted-bedrock-model', 'aws-bedrock'), [5.5, 27.5]);
});

test('an unknown model falls back to the provider rate, never to free', () => {
  assert.deepEqual(ratePerMtok('some-model-nobody-has-heard-of', 'openai'), [5, 20]);
  assert.deepEqual(ratePerMtok(null, 'nonexistent-provider'), [5, 25]);
  // A dated model id still finds its family's rate.
  assert.deepEqual(ratePerMtok('claude-opus-4-8-20260115', 'anthropic'), [5, 25]);
});

test('estimates round UP and are never negative', () => {
  assert.equal(centsForTokens('claude-opus-5', 'anthropic', { input: 1, output: 1 }), 1);
  assert.equal(estimateTtsCents(-100), 0);
  assert.equal(estimateOcrCents(0), 0);
  // The output allowance dominates: charging it up front is what makes the
  // pre-check conservative.
  const small = estimateLlmCents({ provider: 'anthropic', model: 'claude-opus-5', bodyText: 'hi', maxOutputTokens: 100 });
  const large = estimateLlmCents({ provider: 'anthropic', model: 'claude-opus-5', bodyText: 'hi', maxOutputTokens: 8192 });
  assert.ok(large > small);
});

test('ordinary uploads are not priced out of the month', () => {
  // The free wallet is 1,500 cents. An earlier draft guessed a page count from
  // the file size and charged every guessed page at the Anthropic-vision rate,
  // which billed this 900 KB PDF 880 cents — 59% of the month for about a cent
  // of real embedding, while the scanned PDF it was aimed at had already been
  // routed to the worker. This is the regression test for that.
  const pdf = estimateIngestCents({ bytes: 900_000, ocrableImage: false });
  assert.ok(pdf <= 5, `a 900 KB born-digital PDF should cost pennies, got ${pdf}c`);
  const docx = estimateIngestCents({ bytes: 15_000_000, ocrableImage: false });
  assert.ok(docx <= 20, `a 15 MB document should not exceed any plan's month, got ${docx}c`);
  // A scanned page that arrived as an image is one inline OCR call — the only
  // provider call this function makes for a picture — so it costs something
  // where a text file of no size costs nothing.
  assert.equal(estimateIngestCents({ bytes: 0, ocrableImage: false }), 0);
  assert.ok(estimateIngestCents({ bytes: 0, ocrableImage: true }) > 0);
});

// ---------------------------------------------------------------------------
// consumeUsage
// ---------------------------------------------------------------------------
test('an admitted request carries the tier ceilings back to the handler', async () => {
  const calls = [];
  const d = await consumeUsage({
    ...ENV, bearer: 'user-jwt', kind: 'llm', estimateCents: 12,
    fetchImpl: stubFetch(200, {
      allowed: true, reason: 'ok', status: 200, event_id: 'evt-1',
      max_output_tokens: 8192, max_request_bytes: 1048576, remaining_cents: 900,
    }, calls),
  });
  assert.equal(d.allowed, true);
  assert.equal(d.degraded, false);
  assert.equal(d.eventId, 'evt-1');
  assert.equal(d.maxOutputTokens, 8192);
  assert.equal(d.maxRequestBytes, 1048576);
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/usage_consume$/);
});

test('the caller is taken from the JWT: p_user is never sent for a user call', async () => {
  const calls = [];
  await consumeUsage({
    ...ENV, bearer: 'user-jwt', kind: 'tts', estimateCents: 3,
    fetchImpl: stubFetch(200, { allowed: true }, calls),
  });
  assert.equal(calls[0].args.p_user, null);
  assert.equal(calls[0].init.headers.authorization, 'Bearer user-jwt');
  assert.equal(calls[0].init.headers.apikey, 'anon-key');
});

test('a negative estimate is clamped before it ever reaches the database', async () => {
  const calls = [];
  await consumeUsage({
    ...ENV, bearer: 'user-jwt', estimateCents: -9999,
    fetchImpl: stubFetch(200, { allowed: true }, calls),
  });
  assert.equal(calls[0].args.p_cents_estimate, 0);
});

test('over budget is a refusal the handler must honour', async () => {
  const d = await consumeUsage({
    ...ENV, bearer: 'user-jwt',
    fetchImpl: stubFetch(200, {
      allowed: false, reason: 'over_monthly_budget', status: 402,
      message: "You've reached this month's included AI usage.",
    }),
  });
  assert.equal(d.allowed, false);
  assert.equal(d.status, 402);
  assert.equal(d.degraded, false);
});

test('over rate is a 429 with a retry hint', async () => {
  const d = await consumeUsage({
    ...ENV, bearer: 'user-jwt',
    fetchImpl: stubFetch(200, { allowed: false, reason: 'over_rate_limit', status: 429, retry_after_seconds: 60 }),
  });
  assert.equal(d.allowed, false);
  assert.equal(d.status, 429);
  assert.equal(d.retryAfterSeconds, 60);
});

// ---------------------------------------------------------------------------
// Degradation — the property that lets this ship before migration 063 is
// pasted. Each of these must ALLOW the request.
// ---------------------------------------------------------------------------
test('the RPC not existing yet allows the request (migration 063 not pasted)', async () => {
  for (const [status, body] of [
    [404, { code: 'PGRST202', message: 'Could not find the function public.usage_consume' }],
    [400, { code: 'PGRST202' }],
    [404, 'Could not find the function'],
  ]) {
    const d = await consumeUsage({ ...ENV, bearer: 'jwt', fetchImpl: stubFetch(status, body) });
    assert.equal(d.allowed, true, `status ${status} should fail open`);
    assert.equal(d.degraded, true);
  }
});

test('a database error allows the request rather than blocking work', async () => {
  const d = await consumeUsage({ ...ENV, bearer: 'jwt', fetchImpl: stubFetch(500, { message: 'boom' }) });
  assert.equal(d.allowed, true);
  assert.equal(d.degraded, true);
});

test('a timeout or network failure allows the request', async () => {
  const d = await consumeUsage({
    ...ENV, bearer: 'jwt',
    fetchImpl: async () => { const e = new Error('The operation was aborted'); e.name = 'TimeoutError'; throw e; },
  });
  assert.equal(d.allowed, true);
  assert.equal(d.degraded, true);
});

test('missing Supabase env allows the request', async () => {
  const d = await consumeUsage({ supabaseUrl: '', anonKey: '', bearer: 'jwt' });
  assert.equal(d.allowed, true);
  assert.equal(d.degraded, true);
});

test('a garbled 200 allows the request', async () => {
  const d = await consumeUsage({ ...ENV, bearer: 'jwt', fetchImpl: stubFetch(200, 'not json at all') });
  assert.equal(d.allowed, true);
  assert.equal(d.degraded, true);
});

// ---------------------------------------------------------------------------
// The refusal a person reads
// ---------------------------------------------------------------------------
test('a budget refusal is a 402 with plain language the UI can show', () => {
  const res = fakeRes();
  sendUsageRefusal(res, {
    allowed: false, status: 402, reason: 'over_monthly_budget',
    message: "You've reached this month's included AI usage.", retryAfterSeconds: null,
  });
  assert.equal(res.statusCode, 402);
  const body = JSON.parse(res.ended);
  assert.equal(body.error, 'over_monthly_budget');
  assert.match(body.message, /included AI usage/);
  assert.ok(!/quota_exceeded|ERR_/.test(res.ended), 'no machine jargon in the message');
});

test('a rate refusal is a 429 and sets retry-after', () => {
  const res = fakeRes();
  sendUsageRefusal(res, { allowed: false, status: 429, reason: 'over_rate_limit', message: 'Slow down.', retryAfterSeconds: 60 });
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '60');
});

// ---------------------------------------------------------------------------
// The /api/llm max_tokens clamp
// ---------------------------------------------------------------------------
test('anthropic: an oversized max_tokens is clamped to the tier ceiling', () => {
  const out = clampMaxTokens(JSON.stringify({ model: 'x', max_tokens: 64000, messages: [] }), 'anthropic', 8192);
  assert.equal(out.clamped, true);
  assert.equal(JSON.parse(out.body).max_tokens, 8192);
});

test('anthropic: a request already inside the ceiling is untouched', () => {
  const body = JSON.stringify({ max_tokens: 1000 });
  const out = clampMaxTokens(body, 'anthropic', 8192);
  assert.equal(out.clamped, false);
  assert.equal(JSON.parse(out.body).max_tokens, 1000);
});

test('openai-compatible: an ABSENT max_tokens is filled in, because absent means the model maximum', () => {
  const out = clampMaxTokens(JSON.stringify({ model: 'gpt', messages: [] }), 'openai', 4096);
  assert.equal(out.clamped, true);
  assert.equal(JSON.parse(out.body).max_tokens, 4096);
});

test('openai-compatible: max_completion_tokens is clamped where the body uses it', () => {
  const out = clampMaxTokens(JSON.stringify({ max_completion_tokens: 99999 }), 'openai', 4096);
  assert.equal(JSON.parse(out.body).max_completion_tokens, 4096);
});

test('google: the nested generationConfig is clamped, and created when missing', () => {
  const clamp = clampMaxTokens(JSON.stringify({ generationConfig: { maxOutputTokens: 100000, temperature: 0.2 } }), 'google', 8192);
  const cj = JSON.parse(clamp.body);
  assert.equal(cj.generationConfig.maxOutputTokens, 8192);
  assert.equal(cj.generationConfig.temperature, 0.2, 'nothing else about the body changes');

  const inject = clampMaxTokens(JSON.stringify({ contents: [] }), 'google', 8192);
  assert.equal(JSON.parse(inject.body).generationConfig.maxOutputTokens, 8192);
});

test('no ceiling, or an unparseable body, leaves the passthrough exactly as it was', () => {
  const body = JSON.stringify({ max_tokens: 99999 });
  assert.equal(clampMaxTokens(body, 'anthropic', null).body, body);
  assert.equal(clampMaxTokens('<not json>', 'anthropic', 8192).body, '<not json>');
});

// ---------------------------------------------------------------------------
// The unauthenticated limiter — the one that fails CLOSED
// ---------------------------------------------------------------------------
test('the IP limiter refuses when the RPC exists and errors (fail closed)', async () => {
  const d = await consumeIpUsage({
    supabaseUrl: ENV.supabaseUrl, serviceKey: 'svc', ip: '203.0.113.9',
    fetchImpl: stubFetch(500, { message: 'db down' }),
  });
  assert.equal(d.allowed, false);
  assert.equal(d.status, 429);
  assert.equal(d.undeployed, false);
});

test('the IP limiter refuses when the call throws (fail closed)', async () => {
  const d = await consumeIpUsage({
    supabaseUrl: ENV.supabaseUrl, serviceKey: 'svc', ip: '203.0.113.9',
    fetchImpl: async () => { throw new Error('socket hang up'); },
  });
  assert.equal(d.allowed, false);
});

test('the IP limiter reports undeployed so the handler can bridge on its own limiter', async () => {
  const d = await consumeIpUsage({
    supabaseUrl: ENV.supabaseUrl, serviceKey: 'svc', ip: '203.0.113.9',
    fetchImpl: stubFetch(404, { code: 'PGRST202' }),
  });
  assert.equal(d.undeployed, true);
  assert.equal(d.allowed, true);
});

test('the IP limiter passes a refusal straight through', async () => {
  const d = await consumeIpUsage({
    supabaseUrl: ENV.supabaseUrl, serviceKey: 'svc', ip: '203.0.113.9',
    fetchImpl: stubFetch(200, { allowed: false, status: 429, reason: 'over_rate_limit', retry_after_seconds: 3600 }),
  });
  assert.equal(d.allowed, false);
  assert.equal(d.retryAfterSeconds, 3600);
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------
test('reconciliation is a no-op without a service key, and never throws', async () => {
  assert.equal(await recordActualUsage({ supabaseUrl: ENV.supabaseUrl, serviceKey: null, eventId: 'e', cents: 5 }), false);
  assert.equal(await recordActualUsage({
    supabaseUrl: ENV.supabaseUrl, serviceKey: 'svc', eventId: 'e', cents: 5,
    fetchImpl: async () => { throw new Error('down'); },
  }), false);
});

test('reconciliation posts the event id and the corrected cents', async () => {
  const calls = [];
  const ok = await recordActualUsage({
    supabaseUrl: ENV.supabaseUrl, serviceKey: 'svc', eventId: 'evt-9', cents: 4.6,
    model: 'claude-opus-4-8', fetchImpl: stubFetch(200, { ok: true, delta_cents: -30 }, calls),
  });
  assert.equal(ok, true);
  assert.match(calls[0].url, /usage_record_actual$/);
  assert.equal(calls[0].args.p_event_id, 'evt-9');
  assert.equal(calls[0].args.p_cents_actual, 5, 'cents are rounded to an integer');
  assert.equal(calls[0].init.headers.authorization, 'Bearer svc');
});

// ---------------------------------------------------------------------------
test('the client IP is read from Vercel\'s proxy headers', () => {
  assert.equal(clientIp({ headers: { 'x-real-ip': '203.0.113.5' } }), '203.0.113.5');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '203.0.113.6, 10.0.0.1' } }), '203.0.113.6');
  assert.equal(clientIp({ headers: {} }), 'unknown');
});

// ---------------------------------------------------------------------------
// Meter outage: a degraded ceiling, not unlimited (2026-09-25).
// ---------------------------------------------------------------------------
test('meter outage: costed calls are admitted up to the ceiling, then refused with a sentence', async () => {
  resetDegradedCeiling();
  const nowMs = Date.UTC(2026, 8, 25, 14, 23, 0);
  const down = stubFetch(500, { message: 'db down' });
  const call = () => consumeUsage({
    ...ENV, serviceKey: 'svc', userId: 'u-ceiling', kind: 'llm', estimateCents: 1,
    fetchImpl: down, nowMs, env: {},
  });
  for (let i = 0; i < DEGRADED_CEILING.maxRequests; i += 1) {
    const d = await call();
    assert.equal(d.allowed, true, `call ${i + 1} is under the ceiling`);
    assert.equal(d.degraded, true);
  }
  const over = await call();
  assert.equal(over.allowed, false, 'the next costed call is refused — NOT unlimited');
  assert.equal(over.status, 429);
  assert.equal(over.reason, 'meter_unavailable_ceiling');
  assert.match(over.message, /briefly unavailable/);
  assert.match(over.message, /resets at 14:30 UTC/);
  assert.ok(!/[{}]/.test(over.message), 'a sentence, not JSON');
  assert.ok(over.retryAfterSeconds > 0 && over.retryAfterSeconds <= DEGRADED_CEILING.windowSeconds);
  // A different user has their own ceiling.
  const other = await consumeUsage({ ...ENV, serviceKey: 'svc', userId: 'u-other', kind: 'llm', estimateCents: 1, fetchImpl: down, nowMs, env: {} });
  assert.equal(other.allowed, true);
  // The next window starts fresh.
  const later = await consumeUsage({ ...ENV, serviceKey: 'svc', userId: 'u-ceiling', kind: 'llm', estimateCents: 1, fetchImpl: down, nowMs: nowMs + DEGRADED_CEILING.windowSeconds * 1000, env: {} });
  assert.equal(later.allowed, true);
});

test('meter outage: the cents ceiling applies too', async () => {
  resetDegradedCeiling();
  const nowMs = Date.UTC(2026, 8, 25, 9, 0, 0);
  const down = stubFetch(503, 'upstream');
  const a = await consumeUsage({ ...ENV, serviceKey: 'svc', userId: 'u-cents', estimateCents: DEGRADED_CEILING.maxCents, fetchImpl: down, nowMs, env: {} });
  assert.equal(a.allowed, true);
  const b = await consumeUsage({ ...ENV, serviceKey: 'svc', userId: 'u-cents', estimateCents: 1, fetchImpl: down, nowMs, env: {} });
  assert.equal(b.allowed, false);
});

test('meter outage: a free call (reading) is never refused', async () => {
  resetDegradedCeiling();
  const down = async () => { throw new Error('ECONNRESET'); };
  for (let i = 0; i < DEGRADED_CEILING.maxRequests * 3; i += 1) {
    const d = await consumeUsage({ ...ENV, bearer: 'jwt', kind: 'connector', estimateCents: 0, fetchImpl: down });
    assert.equal(d.allowed, true);
  }
});

test('meter outage: workshop is never refused — from knownTier, from METER_UNLIMITED_USER_IDS, or from the profile', async () => {
  resetDegradedCeiling();
  const down = stubFetch(500, { message: 'boom' });
  const n = DEGRADED_CEILING.maxRequests * 2;
  for (let i = 0; i < n; i += 1) {
    const d = await consumeUsage({ ...ENV, serviceKey: 'svc', userId: 'eden', estimateCents: 5, knownTier: 'workshop', fetchImpl: down, env: {} });
    assert.equal(d.allowed, true, 'knownTier workshop');
  }
  for (let i = 0; i < n; i += 1) {
    const d = await consumeUsage({ ...ENV, serviceKey: 'svc', userId: 'eden-2', estimateCents: 5, fetchImpl: down, env: { METER_UNLIMITED_USER_IDS: 'x, eden-2' } });
    assert.equal(d.allowed, true, 'env list');
  }
  // The RPC is down but the profile read answers workshop.
  const split = async (url, init) => ({
    status: String(url).includes('/rest/v1/profiles') ? 200 : 500,
    ok: String(url).includes('/rest/v1/profiles'),
    text: async () => (String(url).includes('/rest/v1/profiles') ? JSON.stringify([{ pricing_tier: 'workshop' }]) : '{"message":"boom"}'),
  });
  for (let i = 0; i < n; i += 1) {
    const d = await consumeUsage({ ...ENV, serviceKey: 'svc', userId: 'eden-3', estimateCents: 5, fetchImpl: split, env: {} });
    assert.equal(d.allowed, true, 'profile read');
  }
  // And an ordinary account on the same path IS limited.
  const pro = async (url) => ({
    status: String(url).includes('/rest/v1/profiles') ? 200 : 500,
    ok: false,
    text: async () => (String(url).includes('/rest/v1/profiles') ? JSON.stringify([{ pricing_tier: 'pro' }]) : 'x'),
  });
  let refused = 0;
  for (let i = 0; i < n; i += 1) {
    const d = await consumeUsage({ ...ENV, serviceKey: 'svc', userId: 'pro-user', estimateCents: 1, fetchImpl: pro, env: {} });
    if (!d.allowed) refused += 1;
  }
  assert.equal(refused, n - DEGRADED_CEILING.maxRequests);
});

test('meter up: an ordinary answer is untouched by the outage ceiling', async () => {
  resetDegradedCeiling();
  for (let i = 0; i < DEGRADED_CEILING.maxRequests * 2; i += 1) {
    const d = await consumeUsage({ ...ENV, bearer: 'jwt', estimateCents: 5, fetchImpl: stubFetch(200, { allowed: true, reason: 'ok', event_id: 'e' }) });
    assert.equal(d.allowed, true);
    assert.equal(d.degraded, false);
  }
});
