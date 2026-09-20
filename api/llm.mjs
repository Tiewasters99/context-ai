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
//
// The matter's RECORD (2026-09-20, migration 064 + 073). This handler was
// gated, sealed and metered, and it wrote NOTHING into the matter's Record —
// so a sealed Bucketizer classification could run in production and the
// matter's Record would not know it had happened. For a product whose pitch
// is that a lawyer can show a court how AI was used on a matter, that is a
// hole. A matter-bound call now writes two rows (lib/llm-record.mjs):
//
//   … → meter → clamp → RECORD(requested) → send → RECORD(received)
//
//   5. The `requested` row sits AFTER the seal decision, so it names the pen
//      that will actually answer rather than the one the browser asked for,
//      and AFTER the clamp, so it names the allowance that was actually
//      granted. It sits BEFORE the send, which is the whole point: on a
//      SEALED matter that write is strict, so "no record, no answer" is kept
//      without buffering a stream — if it fails, the call is refused with
//      ZERO provider requests. On an unsealed matter it is best-effort and
//      can never be the reason a call fails.
//   6. Every refusal this handler can issue once a matter and a signed-in
//      caller are known — a tier violation, a paused matter (070), an
//      untranslatable sealed request, an unprovisioned sealed pen, a spent
//      wallet or a full rate window (402/429) — leaves a truthful `refused`
//      row. The refusal is sent FIRST and the row written after, so recording
//      adds no latency to a "no".
//   7. The `received` row is always best-effort, sealed or not: by then the
//      undeletable row already exists and the answer has already gone out.
//
// Nothing about what LEAVES this handler changes. The feature label rides in
// the request envelope beside `provider`/`model`/`matterId`; the bytes
// forwarded upstream are `body`, verbatim, exactly as before.

import { gateLlmRequest } from '../lib/ai-tier-policy.mjs';
import { sealedRouteFor } from '../lib/llm-sealed-route.mjs';
import { consumeUsage, recordActualUsage, sendUsageRefusal, clampMaxTokens } from '../lib/usage-meter.mjs';
import { estimateLlmCents, centsForTokens } from '../lib/usage-prices.mjs';
import {
  ledgerClientFor, newCallId, normalizeFeature,
  recordLlmReceived, recordLlmRequested, exchangeUnrecordedRefusal,
} from '../lib/llm-record.mjs';

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

  // WHICH FEATURE MADE THIS CALL. A request-envelope field, never part of
  // `body`: the bytes forwarded to the provider are `body` verbatim, so adding
  // this changes nothing about what leaves. Validated against an allow-list
  // server-side (lib/llm-record.mjs) — a caller must not be able to write
  // arbitrary text into a row nobody can ever delete — and anything else is
  // recorded as 'unspecified' rather than refused: a mislabelled call is not a
  // reason to stop a lawyer's work.
  const feature = normalizeFeature(parsed.feature);
  const callId = newCallId();
  // Ids only, and only when the client supplies them. uuidList() in
  // lib/ledger.mjs drops the list to its size unless EVERY element is a uuid.
  const documentIds = Array.isArray(parsed.documentIds) ? parsed.documentIds : null;

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  const bearerToken = (req.headers.authorization || '').replace(/^bearer\s+/i, '').trim();

  const route = PROVIDER_ROUTES[provider];
  if (!route) return json(res, 400, { error: `unknown_provider: ${provider}` });

  const gate = await gateLlmRequest({
    supabaseUrl,
    anonKey,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    bearer: req.headers.authorization,
    provider,
    matterId,
  });

  // The Record's client is the CALLER's, never the service role: the row's
  // byline is auth.uid(), stamped inside the database, so a client cannot
  // forge who it was. Null when there is no matter (a dashboard draft, the
  // Student Hub) or no token — in which case nothing is recorded and nothing
  // about the call changes.
  const ledger = matterId && bearerToken
    ? ledgerClientFor({ supabaseUrl, anonKey, bearer: bearerToken })
    : null;
  const actor = { kind: 'user', ref: gate.userId ?? null };

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
  if (sealed?.refusal) return refuse(sealed.refusal.status, sealed.refusal.body);
  if (!sealed && !gate.ok) return refuse(gate.status, { error: gate.error, tier: gate.tier, provider: gate.provider });

  // The provider key is the unsealed forward's, and it is resolved before the
  // meter so a misconfigured server is not charged for a call it cannot make.
  // The sealed route holds no provider key: it signs with our AWS credentials,
  // and their absence was already answered above with sealed_pen_unavailable.
  const key = sealed ? null : (apiKey || process.env[route.envKey]);
  if (!sealed && !key) return refuse(400, { error: `no_api_key for ${provider}; set ${route.envKey} or supply your own key` }, 'no_api_key');
  if (typeof body !== 'string') return refuse(400, { error: 'body must be a JSON string' }, 'invalid_body');

  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > HARD_MAX_REQUEST_BYTES) {
    return refuse(413, {
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
  // A spent wallet or a full rate window is a refusal like any other, and the
  // Record says so: "Bucketizer asked to classify a document and was refused —
  // this month's usage is spent" is a true and useful line in the account of
  // what was done to this matter.
  if (!meter.allowed) {
    sendUsageRefusal(res, meter);
    return recordRefusedRow(meter.reason || 'usage_capped', meter.status);
  }

  if (meter.maxRequestBytes && bodyBytes > meter.maxRequestBytes) {
    return refuse(413, {
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

  // ── THE RECORD, ROW 1 — before any provider is contacted ─────────────────
  //
  // This is the line that makes "no record, no answer" true of a STREAMING
  // route. The in-app Assistant can buffer an answer and discard it; this
  // handler cannot, so the row that has to exist is written first. It names
  // the pen the seal decision picked, the tier, the allowance the clamp
  // granted, and the feature that asked — everything a reader of the Record
  // needs, and nothing the provider will send back.
  //
  // SEALED: strict. A real write failure refuses the call, with zero provider
  // requests and the pre-charge settled back to nothing. "Not deployed" —
  // including a database whose events_kind_check predates 073 — is NOT a
  // failure, so merging this before pasting the migration changes nothing.
  //
  // UNSEALED: best-effort. record() warns and returns {ok:false}; the call
  // goes on. The Record is never the reason an unsealed call fails.
  const startedAt = Date.now();
  const sealedMatter = gate.tier === 'B';
  if (ledger) {
    try {
      await recordLlmRequested(ledger, {
        matterId,
        actor,
        feature,
        callId,
        tier: gate.tier ?? null,
        provider: billedProvider,
        model: billedModel,
        clientProvider: provider,
        clientModel: model,
        sealed: Boolean(sealed),
        streaming: isStreamRequest(body, provider),
        maxOutputTokens: appliedOutput,
        byok,
        documentIds,
        strict: sealedMatter,
      });
    } catch {
      // Sealed only — recordLlmRequested throws nowhere else. Nothing has been
      // sent, and the wallet is put back before the refusal goes out.
      await settleUnsentCharge();
      const unrecorded = exchangeUnrecordedRefusal();
      return json(res, unrecorded.status, unrecorded.body);
    }
  }

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
      // The request WAS made, so this is not a refusal: row 1 already says the
      // provider was about to be asked, and row 2 says it could not be reached.
      json(res, 502, { error: `proxy_error: ${err.message || 'fetch failed'}` });
      return settleRecord({ outcome: 'provider_error', status: 502 });
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
    const usage = upstream.ok ? usageFromResponse(text, provider) : null;
    if (!byok && upstream.ok && meter.eventId) {
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
    // Row 2. The provider's own status, never its body: a 4xx routinely
    // echoes part of the request back, and this row is undeletable.
    await settleRecord({
      outcome: upstream.ok ? 'ok' : 'provider_error',
      status: upstream.status,
      tokens: usage,
    });
    return;
  }

  if (upstream.body) {
    // A stream that stops part-way still leaves row 2 — the shape a `finally`
    // would give, written out so the ordering with settleClampedStream is
    // visible. Row 1 already exists, so nothing here can withhold an answer
    // that has already gone out.
    let outcome = 'ok';
    try {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch {
      outcome = 'stream_error';
    }
    res.end();
    await settleClampedStream();
    await settleRecord({ outcome, status: upstream.status });
    return;
  }
  const text = await upstream.text();
  res.end(text);
  await settleClampedStream();
  await settleRecord({ outcome: upstream.ok ? 'ok' : 'provider_error', status: upstream.status });
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

  // ── the matter's Record ──────────────────────────────────────────────────
  // Hoisted like settleClampedStream above, and called only after the
  // bindings they read have been initialised.

  /**
   * Send a refusal, THEN record it. In that order deliberately: the Record
   * must not add latency to a "no", and on Vercel the function stays alive
   * until this handler's promise settles — the same property
   * settleClampedStream already relies on.
   */
  function refuse(status, bodyObj, codeOverride) {
    json(res, status, bodyObj);
    const code = codeOverride
      ?? (typeof bodyObj?.error === 'string' ? bodyObj.error : 'refused');
    return recordRefusedRow(code, status);
  }

  /**
   * One row for a call that was refused: the feature asked, and nothing was
   * sent. There is no second row, because there is nothing to pair it with.
   */
  async function recordRefusedRow(code, status) {
    if (!ledger) return;
    // Not recorded, and not a gap in the Record: `ledger_append` asks the
    // CALLER's own RLS whether the matter is visible, so a matter the caller
    // cannot see (404) refuses the write every time, and an unauthenticated
    // request has no byline to write under at all.
    if (!gate.ok && (gate.error === 'auth_required'
      || gate.error === 'auth_not_configured'
      || gate.error === 'matter_not_found')) return;
    const pen = penNames();
    await recordLlmRequested(ledger, {
      matterId,
      actor,
      feature,
      callId,
      tier: gate.tier ?? null,
      provider: pen.provider,
      model: pen.model,
      clientProvider: provider,
      clientModel: model,
      sealed: pen.sealed,
      streaming: isStreamRequest(body, provider),
      byok: Boolean(apiKey) && !sealed?.pen,
      documentIds,
      refused: code,
      status,
    }).catch(() => {});
  }

  /**
   * Who would have answered, for a row written before anyone did.
   *
   * On a Tier-B matter whose sealed route never resolved — the pen is not
   * provisioned, or the request could not be carried to it unchanged — the
   * honest answer is that the route was the seal and no model was chosen.
   * Naming the model the browser asked for as the one that would have served
   * it says the opposite of what happened; it is kept as `client_model`.
   */
  function penNames() {
    if (sealed?.pen) return { provider: sealed.provider, model: sealed.pen.model, sealed: true };
    if (gate.tier === 'B') return { provider: null, model: null, sealed: true };
    return { provider, model, sealed: false };
  }

  /** Row 2. Always best-effort: the undeletable row is already written. */
  async function settleRecord({ outcome, status, tokens = null }) {
    if (!ledger) return;
    await recordLlmReceived(ledger, {
      matterId,
      actor,
      feature,
      callId,
      tier: gate.tier ?? null,
      provider: billedProvider,
      model: billedModel,
      clientProvider: provider,
      clientModel: model,
      sealed: Boolean(sealed),
      streaming: isStreamRequest(body, provider),
      outcome,
      status,
      tokens,
      ms: Date.now() - startedAt,
      byok,
    }).catch(() => {});
  }

  /**
   * The meter pre-charges an estimate before the provider is called. A sealed
   * call refused because its record could not be written never reaches a
   * provider, so that charge is for work that did not happen — settled back to
   * nothing here rather than left standing.
   */
  async function settleUnsentCharge() {
    if (byok || !meter.eventId) return;
    await recordActualUsage({
      supabaseUrl: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
      serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      eventId: meter.eventId,
      cents: 0,
      model: billedModel,
      meta: { provider: billedProvider, route: 'llm', refused: 'exchange_unrecorded', unsent: true },
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
