// One model call made by the SERVER on a user's behalf — with every guard
// /api/llm applies, in the same order, in process.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// A Bucketizer classification run has to survive a closed laptop, which means
// the Fly worker has to call a model. There were two wrong ways to do that and
// they are worth naming, because both are easy and both are wrong:
//
//   1. POST to /api/llm from the worker with the service key in the
//      Authorization header, pretending to be the user. The gate would verify
//      a token that is not the user's, the meter would charge whoever that
//      service identity is, and the matter's Record would carry a byline that
//      is a lie. It also turns one in-process function call into an HTTP round
//      trip through Vercel, with Vercel's timeout on it.
//   2. Call Anthropic directly, the way scripts/bucketize.mjs does. That is the
//      status quo and it is exactly what the ship-readiness audit is about:
//      the Fleming run bypassed the seal, the pause, the spend cap, the
//      per-tier clamp and the Record, all at once, because it held a
//      service-role key and an API key and asked nobody.
//
// So: the same FUNCTIONS, composed in the same order, called in process, with
// the REAL user id — read off the `bucketizer_runs` row, which was written by
// /api/bucketizer-run.mjs under that user's own token and checked against that
// user's own RLS.
//
//   gate → SEAL → provider key → size → estimate → meter → clamp
//        → RECORD(requested) → send → RECORD(received)
//
// Every reason for that order is written down at the top of api/llm.mjs and
// none of it is restated here: the seal first, because it is the only thing
// that knows which model will answer and therefore what the estimate should be
// priced at, and because the meter's own failure mode is to ALLOW; the record
// before the send, because on a sealed matter "no record, no answer" has to be
// true; the clamp before both, so the allowance the record names is the one
// that was actually granted.
//
// WHAT IS DIFFERENT FROM api/llm.mjs, AND WHY
// ---------------------------------------------------------------------------
//   * WHO the user is. /api/llm verifies a JWT; there is none here, because
//     the laptop is shut. `gateMatterForUser` is the matter half of the very
//     same gate, extracted from `gateLlmRequest` rather than rewritten.
//   * WHOSE wallet. `consumeUsage` already had a service-role arm taking an
//     explicit `userId` — usage_consume's `coalesce(auth.uid(), p_user)`,
//     migration 063 — so the REQUESTING user's month is charged, per window.
//   * WHOSE byline. Migration 064's `_ledger_append_checked` admits a caller
//     with no JWT only for `actor_kind = 'system'`, so a worker-written row is
//     a system act with the requesting user's id as its `actor_ref`. That is
//     the truth of what happened — the server did this, for that person — and
//     it is a different byline shape from the browser's rows, deliberately.
//   * NO STREAMING. A structured tool call is a single JSON object. A request
//     that asks for a stream is refused here rather than half-supported.
//
// This module makes no decisions of its own about what a refusal MEANS. It
// throws `LlmCallError` with the server's status and the server's sentence,
// and the runner decides whether that pauses a run, holds it, or fails one
// window.

import { gateMatterForUser } from './ai-tier-policy.mjs';
import { sealedRouteFor } from './llm-sealed-route.mjs';
import {
  consumeUsage, recordActualUsage, clampMaxTokens, USAGE_REFUSAL_DEFAULT_MESSAGE,
} from './usage-meter.mjs';
import { estimateLlmCents, centsForTokens } from './usage-prices.mjs';
import {
  newCallId, normalizeFeature, recordLlmReceived, recordLlmRequested,
  llmExchangeUnrecordedMessage,
} from './llm-record.mjs';
import { LlmCallError } from './llm-call-error.mjs';

/** Mirrors api/llm.mjs. The sealed route holds no provider key of its own. */
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
    url: (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
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

/** api/llm.mjs's own ceilings, for the same reasons. */
const HARD_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const ESTIMATE_OUTPUT_CAP = 32768;

/**
 * Make one model call as `userId`, on `matterId`.
 *
 * @param {object} o
 * @param {string} o.supabaseUrl
 * @param {string} o.serviceKey        the worker's service role — the meter's
 *                                     service arm and the tier/pause lookups.
 * @param {string} o.userId            the REQUESTING user. Their wallet, their
 *                                     name on the Record.
 * @param {string} o.matterId
 * @param {string} o.provider          the provider the feature asked for.
 * @param {string} o.model             its api model id.
 * @param {string} o.body              the verbatim provider request body, JSON.
 * @param {string} o.feature           an `LLM_FEATURES` label.
 * @param {string[]|null} [o.documentIds]
 * @param {object|null} [o.ledger]     a client with `.rpc(fn, args)` →
 *                                     `{data, error}` (the worker's supabase-js
 *                                     service client). Null records nothing.
 * @param {object} [o.env]             process.env, injectable for harnesses.
 * @param {Function} [o.fetchImpl]     injectable for harnesses.
 * @returns {Promise<{json: unknown, tokens: {input:number,output:number}|null, sealed: boolean, tier: string|null, model: string, provider: string}>}
 * @throws {LlmCallError} on every refusal, with the server's own sentence.
 */
export async function serverLlmCall({
  supabaseUrl, serviceKey, userId, matterId,
  provider, model, body, feature, documentIds = null,
  ledger = null, env = process.env, fetchImpl = null,
}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const route = PROVIDER_ROUTES[provider];
  if (!route) throw new LlmCallError(`Unknown provider: ${provider}`, 400, 'unknown_provider');
  if (typeof body !== 'string') throw new LlmCallError('body must be a JSON string', 400, 'invalid_body');
  // A structured tool call is one JSON object. Nothing on this path streams,
  // and half-supporting it is how a run silently stops recording token counts.
  if (safeJsonParse(body)?.stream === true) {
    throw new LlmCallError('A server-side run does not stream.', 400, 'invalid_body');
  }

  const label = normalizeFeature(feature);
  const callId = newCallId();
  // The worker has no JWT, so migration 064 admits it only as a SYSTEM act.
  // The requesting user's id is the actor_ref: the server did this, for them.
  const actor = { kind: 'system', ref: userId ?? 'unknown', label: 'Bucketizer server run' };

  // ── 1. the gate: tier → pause → the tier's allowlist ─────────────────────
  const gate = await gateMatterForUser({ supabaseUrl, serviceKey, provider, matterId, userId });

  // ── 2. the SEAL, before any cap ──────────────────────────────────────────
  const sealed = sealedRouteFor({ gate, provider, model, body, env });
  if (sealed?.refusal) {
    await recordRefused(sealed.refusal.body?.error ?? 'sealed_refused', sealed.refusal.status);
    throw new LlmCallError(
      sealed.refusal.body?.message ?? 'This matter is sealed and no sealed route is available.',
      sealed.refusal.status,
      sealed.refusal.body?.error ?? null,
    );
  }
  if (!sealed && !gate.ok) {
    await recordRefused(gate.error ?? 'refused', gate.status);
    throw new LlmCallError(
      gate.message ?? refusalSentence(gate),
      gate.status,
      gate.error ?? null,
    );
  }

  // ── 3. the provider key, before the meter ────────────────────────────────
  const key = sealed ? null : env[route.envKey];
  if (!sealed && !key) {
    await recordRefused('no_api_key', 400);
    throw new LlmCallError(
      `This server has no ${route.envKey}, so nothing was sent.`, 400, 'no_api_key',
    );
  }

  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > HARD_MAX_REQUEST_BYTES) {
    await recordRefused('request_too_large', 413);
    throw new LlmCallError(
      `That request is ${Math.round(bodyBytes / 1048576)} MB. Send less text at a time.`,
      413, 'request_too_large',
    );
  }

  // ── 4. who actually serves this turn, and therefore whose price ──────────
  const billedProvider = sealed ? sealed.provider : provider;
  const billedModel = sealed ? sealed.pen.model : model;
  const requestedOut = outputAllowanceOf(body, provider);
  const plannedOut = sealed ? sealed.maxOutputTokens : requestedOut;
  const estimateOutput = Math.min(plannedOut ?? 4096, ESTIMATE_OUTPUT_CAP);
  const estimateCents = estimateLlmCents({
    provider: billedProvider, model: billedModel, bodyText: body, maxOutputTokens: estimateOutput,
  });

  // ── 5. the meter, on the REQUESTING user's month ─────────────────────────
  const meter = await consumeUsage({
    supabaseUrl, serviceKey, userId, kind: 'llm', estimateCents, fetchImpl,
  });
  if (!meter.allowed) {
    await recordRefused(meter.reason || 'usage_capped', meter.status);
    throw new LlmCallError(
      meter.message || USAGE_REFUSAL_DEFAULT_MESSAGE,
      meter.status === 402 ? 402 : 429,
      meter.reason || 'usage_limit',
      meter.retryAfterSeconds ?? null,
    );
  }
  if (meter.maxRequestBytes && bodyBytes > meter.maxRequestBytes) {
    await recordRefused('request_too_large', 413);
    throw new LlmCallError(
      `That request is larger than your plan allows (${Math.round(meter.maxRequestBytes / 1024)} KB). `
      + 'Send less text at a time.',
      413, 'request_too_large',
    );
  }

  // ── 6. the per-tier output clamp, on both routes ─────────────────────────
  const clamp = clampMaxTokens(body, provider, meter.maxOutputTokens);
  const sendBody = clamp.body;
  const appliedOutput = sealed
    ? (meter.maxOutputTokens ? Math.min(sealed.maxOutputTokens, meter.maxOutputTokens) : sealed.maxOutputTokens)
    : clamp.applied;

  // ── 7. the Record, row 1 — before any provider is contacted ──────────────
  const startedAt = Date.now();
  const sealedMatter = gate.tier === 'B';
  if (ledger && matterId) {
    try {
      await recordLlmRequested(ledger, {
        matterId, actor, feature: label, callId,
        tier: gate.tier ?? null,
        provider: billedProvider, model: billedModel,
        clientProvider: provider, clientModel: model,
        sealed: Boolean(sealed),
        streaming: false,
        maxOutputTokens: appliedOutput,
        byok: false,
        documentIds,
        strict: sealedMatter,
      });
    } catch {
      // Sealed only. Nothing has been sent; put the pre-charge back first.
      await settle(0, { refused: 'exchange_unrecorded', unsent: true });
      throw new LlmCallError(llmExchangeUnrecordedMessage(), 503, 'exchange_unrecorded');
    }
  }

  // ── 8. send ──────────────────────────────────────────────────────────────
  let upstream;
  try {
    upstream = sealed
      ? await sealed.send({ maxOutputTokens: meter.maxOutputTokens })
      : await doFetch(route.url(model), { method: 'POST', headers: route.headers(key), body: sendBody });
  } catch (err) {
    await settleRecord({ outcome: 'provider_error', status: 502 });
    throw new LlmCallError(`The model could not be reached (${err?.message || 'network error'}).`, 502, 'proxy_error');
  }

  const text = await upstream.text();
  const usage = upstream.ok ? usageFromResponse(text, provider) : null;

  if (upstream.ok && usage) {
    await settle(centsForTokens(billedModel, billedProvider, usage), {
      route: 'bucketizer-run', tokens: usage, ...(sealed ? { sealed: true, client_provider: provider, client_model: model ?? null } : {}),
    });
  } else if (upstream.ok && appliedOutput != null && appliedOutput < estimateOutput) {
    // No counts reported, but the allowance the request was finally given came
    // in under the one it was priced on. Correct it to what was actually sent.
    await settle(estimateLlmCents({
      provider: billedProvider, model: billedModel, bodyText: body, maxOutputTokens: appliedOutput,
    }), { route: 'bucketizer-run', clamped_to: appliedOutput });
  }

  // ── 9. the Record, row 2 ─────────────────────────────────────────────────
  await settleRecord({
    outcome: upstream.ok ? 'ok' : 'provider_error',
    status: upstream.status,
    tokens: usage,
  });

  if (!upstream.ok) {
    // The provider's own STATUS, never its body: a 4xx routinely echoes part
    // of the request back, and this sentence reaches a lawyer's screen.
    throw new LlmCallError(
      `The model answered ${upstream.status}.`, upstream.status, 'provider_error',
    );
  }

  const json = safeJsonParse(text);
  if (json == null) throw new LlmCallError('Model returned a non-JSON response.', 502, 'bad_response');

  return {
    json,
    tokens: usage,
    sealed: Boolean(sealed),
    tier: gate.tier ?? null,
    provider: billedProvider,
    model: billedModel,
  };

  // ── helpers, closing over the bindings above ─────────────────────────────

  /** One row for a call that was refused: the feature asked, nothing was sent. */
  async function recordRefused(code, status) {
    if (!ledger || !matterId) return;
    // Not recorded, and not a gap: a matter the caller cannot see refuses the
    // write anyway, and there is nothing truthful to say about it.
    if (!gate?.ok && (gate?.error === 'auth_not_configured' || gate?.error === 'matter_not_found')) return;
    const pen = sealed?.pen
      ? { provider: sealed.provider, model: sealed.pen.model, sealed: true }
      : (gate?.tier === 'B' ? { provider: null, model: null, sealed: true } : { provider, model, sealed: false });
    await recordLlmRequested(ledger, {
      matterId, actor, feature: label, callId,
      tier: gate?.tier ?? null,
      provider: pen.provider, model: pen.model,
      clientProvider: provider, clientModel: model,
      sealed: pen.sealed, streaming: false, byok: false,
      documentIds, refused: code, status,
    }).catch(() => {});
  }

  /** Row 2. Always best-effort: the undeletable row is already written. */
  async function settleRecord({ outcome, status, tokens = null }) {
    if (!ledger || !matterId) return;
    await recordLlmReceived(ledger, {
      matterId, actor, feature: label, callId,
      tier: gate.tier ?? null,
      provider: billedProvider, model: billedModel,
      clientProvider: provider, clientModel: model,
      sealed: Boolean(sealed), streaming: false,
      outcome, status, tokens, ms: Date.now() - startedAt, byok: false,
    }).catch(() => {});
  }

  /** Correct the meter's pre-charge. Never throws. */
  async function settle(cents, meta) {
    if (!meter?.eventId) return;
    await recordActualUsage({
      supabaseUrl, serviceKey, eventId: meter.eventId, cents,
      model: billedModel, meta: { provider: billedProvider, ...meta }, fetchImpl,
    });
  }
}

/**
 * A sentence for a gate refusal that did not carry one. The pause and the
 * sealed route always do; a tier violation and a missing matter do not, and a
 * run that stopped deserves better than a code on the screen.
 */
function refusalSentence(gate) {
  if (gate?.error === 'tier_violation') {
    return `This matter is sealed (SecureSpace Tier ${gate.tier}) and ${gate.provider} may not be reached from it. Nothing was sent.`;
  }
  if (gate?.error === 'matter_not_found') return 'That matter could not be read, so nothing was sent.';
  if (gate?.error === 'auth_not_configured') return 'This server is not configured to check the matter, so nothing was sent.';
  return 'The request was refused, so nothing was sent.';
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

/**
 * Real token counts out of a provider response, or null.
 *
 * The same three branches api/llm.mjs has. They are private there, so this is
 * a second copy rather than an import — noted in the pull request. The sealed
 * route answers in the CLIENT's wire shape, so `provider` is still the right
 * key for reading the counts back out; the rate they are priced at is the
 * pen's, which is `billedModel` above.
 */
function usageFromResponse(text, provider) {
  const j = safeJsonParse(text);
  if (!j || typeof j !== 'object') return null;
  if (provider === 'anthropic' && j.usage) {
    return {
      input: (j.usage.input_tokens || 0) + (j.usage.cache_creation_input_tokens || 0),
      output: j.usage.output_tokens || 0,
    };
  }
  if (j.usage && (j.usage.prompt_tokens != null || j.usage.completion_tokens != null)) {
    return { input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0 };
  }
  if (j.usageMetadata) {
    return { input: j.usageMetadata.promptTokenCount || 0, output: j.usageMetadata.candidatesTokenCount || 0 };
  }
  return null;
}
