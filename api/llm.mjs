// POST /api/llm
//
// Production counterpart of the dev-only proxy in vite-claude-proxy.ts.
// Multi-provider passthrough so the browser never holds API keys.
//
// Request body: { provider, model, body, apiKey? }
//   - provider: 'anthropic' | 'openai' | 'google' | 'xai'
//   - model:    the provider's API model id (informational; the upstream
//               URL only needs it for Google)
//   - body:     a JSON string — the verbatim provider request body
//   - apiKey:   optional BYOK key; falls back to the server env var
//
// If `body` requests streaming the upstream stream is piped through; if it
// requests a single JSON object that object is returned as-is.
//
// SecureSpace gate (2026-08-21): every request requires a Supabase JWT,
// and a request bound to a matter (body.matterId) is checked against the
// matter's ai_tier server-side — the tier is read from the database,
// never trusted from the client. Fails closed on missing auth config.
//
// Spend cap (2026-09-19, migration 063): a JWT said WHO, and nothing said HOW
// MUCH. This is the widest hole in the product's cost surface — a verbatim
// passthrough to six providers, on our keys, with a caller-supplied body and
// maxDuration 300 — so it now carries three things it did not have:
//   1. a per-user monthly budget and rate window (lib/usage-meter.mjs);
//   2. a server-side ceiling on max_tokens, per tier, injected where the body
//      omits it (absent means "the model's maximum" on most routes);
//   3. a request-body size limit.
// Nothing else about the request or the response changes shape. If the meter
// is unreachable or migration 063 is not pasted yet, the request goes through
// and the fail-open is logged — see lib/usage-meter.mjs.
//
// Sealed route × spend cap, reconciled (2026-09-19). The seal (PR #163) and
// the cap (PR #161) both land in this handler, so the order below is a
// decision, not an accident:
//
//   gate → SEAL DECISION → provider key → size → estimate → meter → clamp → send
//
//   1. The SEAL DECISION comes first, before any cap. Two reasons. It is the
//      only thing that knows which model will actually answer, and the
//      pre-charge estimate has to be priced on that model — a sealed turn is
//      served by the Bedrock pen (Kimi K2.5, $0.6/$2.5 per Mtok) and pricing
//      it as the Opus the browser named ($5/$25) overcharged the user's
//      wallet by roughly 8×. And the meter's own failure mode is to ALLOW: if
//      the cap ran first and failed open, a sealed matter would sail past it
//      into the forward below. A request the meter waved through must still
//      be sealed, so the seal is never downstream of a check that can fail
//      open.
//   2. Nothing between the seal decision and the send can widen the route.
//      Every check after it either returns, or falls through to a forward
//      whose destination the seal already fixed — `fetch(route.url(...))` is
//      unreachable whenever `sealed` is set. So a refused, untranslatable,
//      over-budget or rate-limited request makes ZERO provider calls on
//      either route.
//   3. The provider key is still resolved before the meter, exactly as it was
//      on main, so a server missing ANTHROPIC_API_KEY is not charged for a
//      call it cannot make. The sealed route needs no such key — it signs
//      with our own AWS credentials — so that check is skipped on the sealed
//      arm rather than moved for everyone.
//   4. The tier's max_tokens ceiling applies to BOTH routes. The unsealed
//      forward carries the clamped body; the sealed route builds its own
//      body after the clamp has run, so it is handed the same ceiling and
//      clamps the allowance it builds for itself.

import { gateLlmRequest } from '../lib/ai-tier-policy.mjs';
import { sealedRouteFor } from '../lib/llm-sealed-route.mjs';
import { consumeUsage, recordActualUsage, sendUsageRefusal, clampMaxTokens } from '../lib/usage-meter.mjs';
import { estimateLlmCents, centsForTokens } from '../lib/usage-prices.mjs';

// The ceiling that applies even when the meter cannot answer. Vercel's own
// request limit is well under this; it exists so "the meter is down" can never
// mean "post me a gigabyte".
const HARD_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
// The output allowance the PRE-call estimate assumes at most. A body asking
// for a million output tokens should not be able to price itself out of the
// month before the clamp below has cut it down.
const ESTIMATE_OUTPUT_CAP = 32768;

const PROVIDER_ROUTES = {
  anthropic: {
    url: () => 'https://api.anthropic.com/v1/messages',
    headers: (key) => ({ 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    envKey: 'ANTHROPIC_API_KEY',
  },
  openai: {
    url: () => 'https://api.openai.com/v1/chat/completions',
    headers: (key) => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` }),
    envKey: 'OPENAI_API_KEY',
  },
  google: {
    url: (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    headers: (key) => ({ 'content-type': 'application/json', 'x-goog-api-key': key }),
    envKey: 'GOOGLE_API_KEY',
  },
  xai: {
    url: () => 'https://api.x.ai/v1/chat/completions',
    headers: (key) => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` }),
    envKey: 'XAI_API_KEY',
  },
  moonshot: {
    url: () => 'https://api.moonshot.ai/v1/chat/completions',
    headers: (key) => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` }),
    envKey: 'MOONSHOT_API_KEY',
  },
  fireworks: {
    url: () => 'https://api.fireworks.ai/inference/v1/chat/completions',
    headers: (key) => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` }),
    envKey: 'FIREWORKS_API_KEY',
  },
};

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const parsed = typeof req.body === 'string' ? safeJsonParse(req.body) : req.body;
  if (!parsed || typeof parsed !== 'object') return json(res, 400, { error: 'invalid_body' });
  const { provider, model, body, apiKey, matterId } = parsed;

  const route = PROVIDER_ROUTES[provider];
  if (!route) return json(res, 400, { error: `unknown_provider: ${provider}` });

  const gate = await gateLlmRequest({
    supabaseUrl: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
    anonKey: process.env.VITE_SUPABASE_ANON_KEY,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    bearer: req.headers.authorization,
    provider,
    matterId,
  });

  // SecureSpace sealed route (2026-09-19). A Tier-B matter admits exactly one
  // provider — 'aws-bedrock' — and the browser cannot be trusted to pick it:
  // only the server can read the matter's tier. So when the gate refuses a
  // sealed matter's default pen, the sealed route is substituted here and the
  // wire shape is translated in both directions (lib/llm-sealed-route.mjs).
  // It returns null for every other outcome, so Tier A and Tier C reach the
  // original forward below byte-identically. The substitution can only ever
  // narrow: an untranslatable request or an unprovisioned sealed pen is
  // REFUSED, never sent to the provider the client named.
  //
  // This sits ahead of the spend cap on purpose — see reason 1 in the header.
  const sealed = sealedRouteFor({ gate, provider, model, body });
  if (sealed?.refusal) return json(res, sealed.refusal.status, sealed.refusal.body);
  if (!sealed && !gate.ok) return json(res, gate.status, { error: gate.error, tier: gate.tier, provider: gate.provider });

  // The provider key is the unsealed forward's, and it is resolved before the
  // meter so a misconfigured server is not charged for a call it cannot make.
  // The sealed route holds no provider key: it signs with our AWS credentials,
  // and their absence was already answered above with sealed_pen_unavailable.
  const key = sealed ? null : (apiKey || process.env[route.envKey]);
  if (!sealed && !key) return json(res, 400, { error: `no_api_key for ${provider}; set ${route.envKey} or supply your own key` });
  if (typeof body !== 'string') return json(res, 400, { error: 'body must be a JSON string' });

  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > HARD_MAX_REQUEST_BYTES) {
    return json(res, 413, {
      error: 'request_too_large',
      message: `That request is ${Math.round(bodyBytes / 1048576)} MB. Send less text at a time.`,
    });
  }

  // WHO ACTUALLY SERVES THIS TURN — and therefore whose price it is charged
  // at. On the sealed route the browser's `provider`/`model` are a request,
  // not a fact: the answer comes from the Bedrock pen. Billing the client's
  // names here is what made a sealed Bucketizer classify cost ~8× its true
  // price (the pen's rate is mirrored in lib/usage-prices.mjs from
  // PENS[*].pricePerM, and scripts/_test-usage-meter.mjs fails on drift).
  const billedProvider = sealed ? sealed.provider : provider;
  const billedModel = sealed ? sealed.pen.model : model;

  // BYOK: the caller supplied their own provider key, so this is not our
  // money. Still metered for the RATE window — a passthrough is still our
  // bandwidth and our function-seconds — but charged nothing.
  //
  // A SEALED turn is never BYOK. The client's key is not used by the sealed
  // route — the tokens are spent on our AWS account — so a key in the body
  // must not buy a free sealed turn.
  const byok = Boolean(apiKey) && !sealed;
  const requestedOut = outputAllowanceOf(body, provider);
  // The sealed route rebuilds the request with its own allowance (the
  // caller's, plus thinking headroom on a forced tool), so the estimate is
  // priced on what will actually be asked for rather than on what the browser
  // wrote and the sealed route then discarded.
  const plannedOut = sealed ? sealed.maxOutputTokens : requestedOut;
  const estimateOutput = Math.min(plannedOut ?? 4096, ESTIMATE_OUTPUT_CAP);
  const estimateCents = byok ? 0 : estimateLlmCents({
    provider: billedProvider,
    model: billedModel,
    bodyText: body,
    maxOutputTokens: estimateOutput,
  });

  const meter = await consumeUsage({
    supabaseUrl: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
    anonKey: process.env.VITE_SUPABASE_ANON_KEY,
    bearer: (req.headers.authorization || '').replace(/^bearer\s+/i, '').trim(),
    kind: 'llm',
    estimateCents,
  });
  if (!meter.allowed) return sendUsageRefusal(res, meter);

  if (meter.maxRequestBytes && bodyBytes > meter.maxRequestBytes) {
    return json(res, 413, {
      error: 'request_too_large',
      message: `That request is larger than your plan allows (${Math.round(meter.maxRequestBytes / 1024)} KB). Send less text at a time.`,
    });
  }

  // The output clamp. Per tier, from the same table as the budget. The
  // unsealed forward carries the clamped body; the sealed route is handed the
  // ceiling itself, because it composes its own body from the translated
  // request after this point and would otherwise escape the plan.
  const clamp = clampMaxTokens(body, provider, meter.maxOutputTokens);
  const sendBody = clamp.body;
  // What the answer is actually allowed to be, on whichever route runs.
  const appliedOutput = sealed
    ? (meter.maxOutputTokens ? Math.min(sealed.maxOutputTokens, meter.maxOutputTokens) : sealed.maxOutputTokens)
    : clamp.applied;

  let upstream;
  if (sealed) {
    upstream = await sealed.send({ maxOutputTokens: meter.maxOutputTokens });
    res.setHeader('access-control-expose-headers', 'x-contextspaces-pen');
    const penLabel = upstream.headers.get('x-contextspaces-pen');
    if (penLabel) res.setHeader('x-contextspaces-pen', penLabel);
  } else {
    try {
      upstream = await fetch(route.url(model), { method: 'POST', headers: route.headers(key), body: sendBody });
    } catch (err) {
      return json(res, 502, { error: `proxy_error: ${err.message || 'fetch failed'}` });
    }
  }

  const passthroughType = upstream.headers.get('content-type') || 'application/json';
  res.statusCode = upstream.status;
  res.setHeader('content-type', passthroughType);
  res.setHeader('cache-control', 'no-cache');

  // A single-object answer is buffered so the provider's own token counts can
  // correct the pre-call estimate — same bytes, same headers, same status out.
  // A STREAM is left alone: teeing and re-parsing six providers' SSE dialects
  // to bill them is a new class of bug in the one path that must never stall,
  // so a streamed turn keeps its conservative estimate. Noted in the PR.
  //
  // The sealed route answers in the client's own wire shape, so `provider` is
  // still the right key for reading the token counts back out — but the rate
  // they are priced at is the pen's.
  const streaming = /event-stream/i.test(passthroughType) || isStreamRequest(body, provider);
  if (!streaming) {
    const text = await upstream.text();
    res.end(text);
    if (!byok && upstream.ok && meter.eventId) {
      const usage = usageFromResponse(text, provider);
      if (usage) {
        await recordActualUsage({
          supabaseUrl: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
          serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          eventId: meter.eventId,
          cents: centsForTokens(billedModel, billedProvider, usage),
          model: billedModel,
          meta: { provider: billedProvider, route: 'llm', tokens: usage, ...sealedMeta(sealed, provider, model) },
        });
      }
    }
    return;
  }

  if (upstream.body) {
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
    await settleClampedStream();
    return;
  }
  const text = await upstream.text();
  res.end(text);
  await settleClampedStream();
  return;

  // A streamed turn reports no token counts we are willing to parse, so its
  // estimate stands — but if the allowance the request was finally given came
  // in under the one it was priced on, the estimate was for an answer the
  // model was never allowed to write. Correct it to what was actually sent.
  // One extra RPC, only when the ceiling bit — on either route.
  async function settleClampedStream() {
    if (byok || !meter.eventId) return;
    if (appliedOutput == null || appliedOutput >= estimateOutput) return;
    await recordActualUsage({
      supabaseUrl: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
      serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      eventId: meter.eventId,
      cents: estimateLlmCents({ provider: billedProvider, model: billedModel, bodyText: body, maxOutputTokens: appliedOutput }),
      model: billedModel,
      meta: { provider: billedProvider, route: 'llm', streamed: true, clamped_to: appliedOutput, ...sealedMeta(sealed, provider, model) },
    });
  }
}

/**
 * What the ledger records about a substitution. On a sealed turn the model in
 * `usage_events` is the pen that answered, so the model the browser asked for
 * is kept alongside it — otherwise the row would silently lose the fact that
 * a substitution happened at all.
 */
function sealedMeta(sealed, clientProvider, clientModel) {
  return sealed ? { sealed: true, client_provider: clientProvider, client_model: clientModel ?? null } : {};
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** The output allowance the caller asked for, whatever this provider calls it. */
function outputAllowanceOf(bodyText, provider) {
  const b = safeJsonParse(bodyText);
  if (!b || typeof b !== 'object') return null;
  const n = provider === 'google'
    ? b.generationConfig?.maxOutputTokens
    : (b.max_tokens ?? b.max_completion_tokens);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Google's route is streamGenerateContent&alt=sse; everyone else says so. */
function isStreamRequest(bodyText, provider) {
  if (provider === 'google') return true;
  const b = safeJsonParse(bodyText);
  return b?.stream === true;
}

/** Real token counts out of a non-streamed provider response, or null. */
function usageFromResponse(text, provider) {
  const j = safeJsonParse(text);
  if (!j || typeof j !== 'object') return null;
  if (provider === 'anthropic' && j.usage) {
    return { input: (j.usage.input_tokens || 0) + (j.usage.cache_creation_input_tokens || 0), output: j.usage.output_tokens || 0 };
  }
  if (j.usage && (j.usage.prompt_tokens != null || j.usage.completion_tokens != null)) {
    return { input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0 };
  }
  if (j.usageMetadata) {
    return { input: j.usageMetadata.promptTokenCount || 0, output: j.usageMetadata.candidatesTokenCount || 0 };
  }
  return null;
}
