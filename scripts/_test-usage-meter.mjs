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
} from '../lib/usage-meter.mjs';
import {
  PRICES_PER_MTOK,
  ratePerMtok,
  centsForTokens,
  estimateLlmCents,
  estimateTtsCents,
  estimateOcrCents,
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
