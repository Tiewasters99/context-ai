// The per-user spend cap and rate limit, as the API handlers see it
// (migration 063: usage_budgets / usage_consume / usage_record_actual).
//
// Shape of the thing
// ---------------------------------------------------------------------------
// One round trip to Postgres before the provider is called. The database owns
// the counters because Vercel has no shared memory: lib/rate-limit.mjs is a
// per-process token bucket, which on serverless means one bucket per request —
// no limit at all. `usage_consume` checks the tier's monthly budget AND the
// rate window and records the event in a single transaction, so two requests
// that arrive together cannot both be admitted past the last cent.
//
// Deliberately no @supabase/supabase-js import: this module is the first thing
// /api/tts and /api/deepgram-token do, and it speaks PostgREST directly the
// same way lib/ai-tier-policy.mjs verifies a user. `fetchImpl` is injectable so
// the handler guard can be tested against a stubbed RPC with no network.
//
// Failure policy — a degraded ceiling, not unlimited (2026-09-25)
// ---------------------------------------------------------------------------
// A refusal is a 200 from PostgREST carrying {allowed:false}. ANYTHING else —
// the function missing (404 / PGRST202), a timeout, a 5xx, a network error, a
// garbled body, missing env — means the meter could not answer. Until
// 2026-09-25 that let the request through with NO limit at all, which made a
// meter outage the one moment an account could spend without bound.
//
// Now it admits the request against a conservative TEMPORARY ceiling instead:
//
//   * A call that costs nothing (estimateCents 0) is always admitted. That is
//     what keeps a person reading their own documents during an outage.
//   * A costed call is admitted while this user has made fewer than
//     DEGRADED_CEILING.maxRequests costed calls of this kind, and fewer than
//     DEGRADED_CEILING.maxCents estimated cents, in the current
//     DEGRADED_CEILING.windowSeconds window. Past that it is refused with a
//     429 and a sentence that says why and when it clears.
//   * `workshop` (Eden's own account) is never refused. The meter cannot read
//     the plan when it is down, so the plan is found, in order, from: the
//     caller's `knownTier` (a handler that already read it from the database),
//     METER_UNLIMITED_USER_IDS (comma-separated user ids, set on the
//     deployment — the one source that needs no database at all), and a single
//     best-effort read of profiles.pricing_tier, cached per user for the
//     window. If none answers, the ceiling applies: an unknown account is
//     treated as an ordinary one.
//
// Stated plainly: the counters are per serverless instance. Vercel may run
// several, so the true outage ceiling is DEGRADED_CEILING times the number of
// warm instances — bounded, where before it was unlimited. That is the most a
// process can promise while the shared counters are the thing that is down.
//
// The unauthenticated /api/oauth-register calls consumeIpUsage() and fails
// CLOSED; see there for the one case it still lets through and why.

const TIMEOUT_MS = 3000;
const LOG = '[usage-meter]';

/**
 * THE outage ceiling. One place, deliberately in code rather than in
 * usage_budgets: it applies precisely when the database cannot be read.
 * Sized so a person working normally does not notice a short outage (20
 * costed calls or 50 cents in 10 minutes, per kind), and a runaway loop is
 * stopped within minutes.
 */
export const DEGRADED_CEILING = Object.freeze({
  windowSeconds: 600,
  maxRequests: 20,
  maxCents: 50,
});

const degradedCounters = new Map();   // `${who}|${kind}|${windowStart}` -> {requests, cents}
const tierCache = new Map();          // who -> {tier, until}

/** Test seam: forget every outage counter and cached plan. */
export function resetDegradedCeiling() {
  degradedCounters.clear();
  tierCache.clear();
}

/** "14:30 UTC" for an epoch-ms instant. The sentence an agent or a person reads. */
export function formatUtcTime(ms) {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

/** The unverified `sub` of a JWT — used only as a counter key, never for access. */
function jwtSub(bearer) {
  try {
    const part = String(bearer || '').split('.')[1];
    if (!part) return null;
    const sub = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))?.sub;
    return typeof sub === 'string' && sub ? sub : null;
  } catch { return null; }
}

function unlimitedByEnv(userId, env = process.env) {
  if (!userId) return false;
  const list = String(env?.METER_UNLIMITED_USER_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(userId);
}

async function readTierBestEffort({ supabaseUrl, apikey, bearer, userId, fetchImpl }) {
  if (!supabaseUrl || !apikey || !bearer || !userId) return null;
  try {
    const doFetch = fetchImpl || globalThis.fetch;
    const res = await doFetch(
      `${supabaseUrl.replace(/\/$/, '')}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=pricing_tier&limit=1`,
      {
        method: 'GET',
        headers: { apikey, authorization: `Bearer ${bearer}`, accept: 'application/json' },
        signal: AbortSignal.timeout(1500),
      },
    );
    if (res.status !== 200) return null;
    const rows = JSON.parse(await res.text());
    const tier = Array.isArray(rows) ? rows[0]?.pricing_tier : null;
    return typeof tier === 'string' && tier ? tier : null;
  } catch { return null; }
}

/**
 * The outage ceiling for a caller whose OWN meter could not answer — the
 * connector's rate ceiling (lib/connector-meter.mjs) uses it when
 * connector_rate_consume errors. Same counters, same sentence.
 * ctx: {userId, kind, estimateCents, costed, knownTier, env, nowMs,
 *       supabaseUrl, serviceKey, fetchImpl}
 */
export function admitDuringOutage(note, ctx = {}) {
  return degraded(note, ctx);
}

/**
 * The meter could not answer: admit against the outage ceiling. Never throws.
 * `ctx` carries what consumeUsage knew about the call.
 */
async function degraded(note, ctx = {}) {
  const base = {
    degraded: true,
    reason: 'meter_unavailable',
    message: null,
    eventId: null,
    maxOutputTokens: null,
    maxRequestBytes: null,
    retryAfterSeconds: null,
  };
  const cents = Math.max(0, Math.round(Number(ctx.estimateCents) || 0));
  const kind = ctx.kind || 'llm';
  const nowMs = ctx.nowMs ?? Date.now();

  // `costed: true` counts a call that carries no cents estimate but is still
  // work (the connector's writes); a read never sets it.
  if (cents === 0 && ctx.costed !== true) {
    console.error(`${LOG} meter unavailable — free call admitted: ${note}`);
    return { ...base, allowed: true, status: 200, ceiling: 'free_call' };
  }

  const userId = ctx.userId || jwtSub(ctx.bearer);
  const who = userId || (ctx.bearer ? `bearer:${String(ctx.bearer).slice(-16)}` : 'unknown');

  // Workshop is never refused.
  let tier = ctx.knownTier || null;
  if (!tier && unlimitedByEnv(userId, ctx.env)) tier = 'workshop';
  let tried = false;
  if (!tier) {
    const cached = tierCache.get(who);
    if (cached && cached.until > nowMs) { tier = cached.tier; tried = true; }
  }
  if (!tier && !tried && ctx.readTier !== false) {
    tier = await readTierBestEffort({
      supabaseUrl: ctx.supabaseUrl,
      apikey: ctx.serviceKey || ctx.anonKey,
      bearer: ctx.serviceKey || ctx.bearer,
      userId,
      fetchImpl: ctx.fetchImpl,
    });
    // A failed read is remembered for a minute, so a real outage does not
    // add a 1.5 s wait to every costed call.
    tierCache.set(who, { tier, until: nowMs + (tier ? DEGRADED_CEILING.windowSeconds : 60) * 1000 });
  }
  if (tier === 'workshop') {
    console.error(`${LOG} meter unavailable — workshop admitted without a ceiling: ${note}`);
    return { ...base, allowed: true, status: 200, ceiling: 'workshop' };
  }

  const winMs = DEGRADED_CEILING.windowSeconds * 1000;
  const start = Math.floor(nowMs / winMs) * winMs;
  const key = `${who}|${kind}|${start}`;
  for (const k of degradedCounters.keys()) {
    if (Number(k.slice(k.lastIndexOf('|') + 1)) < start) degradedCounters.delete(k);
  }
  const c = degradedCounters.get(key) || { requests: 0, cents: 0 };
  const resetMs = start + winMs;
  if (c.requests + 1 > DEGRADED_CEILING.maxRequests || c.cents + cents > DEGRADED_CEILING.maxCents) {
    console.error(`${LOG} meter unavailable — outage ceiling reached for ${kind}: ${note}`);
    return {
      ...base,
      allowed: false,
      status: 429,
      reason: 'meter_unavailable_ceiling',
      message:
        'Usage metering is briefly unavailable, so AI work is limited to '
        + `${DEGRADED_CEILING.maxRequests} requests every ${Math.round(DEGRADED_CEILING.windowSeconds / 60)} minutes `
        + `until it is back. This limit resets at ${formatUtcTime(resetMs)}. Reading your documents is not affected.`,
      retryAfterSeconds: Math.max(1, Math.ceil((resetMs - nowMs) / 1000)),
      ceiling: 'reached',
    };
  }
  degradedCounters.set(key, { requests: c.requests + 1, cents: c.cents + cents });
  console.error(`${LOG} meter unavailable — admitted under the outage ceiling (${c.requests + 1}/${DEGRADED_CEILING.maxRequests}): ${note}`);
  return { ...base, allowed: true, status: 200, ceiling: 'under' };
}

function decisionFrom(payload) {
  const allowed = payload?.allowed !== false;
  return {
    allowed,
    degraded: payload?.reason === 'unconfigured',
    status: Number(payload?.status) || (allowed ? 200 : 429),
    reason: payload?.reason || (allowed ? 'ok' : 'refused'),
    message: payload?.message || null,
    eventId: payload?.event_id || null,
    maxOutputTokens: payload?.max_output_tokens ?? null,
    maxRequestBytes: payload?.max_request_bytes ?? null,
    retryAfterSeconds: payload?.retry_after_seconds ?? null,
    raw: payload || null,
  };
}

export async function callRpc(fn, { supabaseUrl, apikey, bearer, args, fetchImpl, timeoutMs = TIMEOUT_MS }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey,
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => '');
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { status: res.status, ok: res.ok, payload, text };
}

// PostgREST says PGRST202 when the function is not in its schema cache — which
// is exactly what a not-yet-pasted migration looks like, and also what a
// just-pasted one looks like until `notify pgrst, 'reload schema'` lands.
export function looksUndeployed(status, payload, text) {
  if (status === 404) return true;
  const code = payload?.code || '';
  if (code === 'PGRST202' || code === '42883') return true;
  return /could not find the function|does not exist/i.test(text || '');
}

/**
 * Check and charge, for a signed-in user.
 *
 * `bearer` is the user's own Supabase access token — the RPC reads auth.uid()
 * from it and ignores p_user, so a caller cannot spend someone else's budget.
 * Pass `serviceKey` INSTEAD only for a server-side path with no user token, in
 * which case `userId` is required.
 *
 * @returns {Promise<{allowed:boolean, degraded:boolean, status:number,
 *   reason:string, message:string|null, eventId:string|null,
 *   maxOutputTokens:number|null, maxRequestBytes:number|null,
 *   retryAfterSeconds:number|null}>}
 */
export async function consumeUsage({
  supabaseUrl,
  anonKey,
  bearer = null,
  serviceKey = null,
  userId = null,
  kind = 'llm',
  estimateCents = 0,
  windowKey = null,
  fetchImpl = null,
  timeoutMs = TIMEOUT_MS,
  knownTier = null,
  env = process.env,
  nowMs = undefined,
}) {
  // What the outage path needs to know about this call (see degraded()).
  const ctx = {
    supabaseUrl, anonKey, bearer, serviceKey, userId, kind, estimateCents,
    fetchImpl, knownTier, env, nowMs,
  };
  if (!supabaseUrl || !(anonKey || serviceKey)) {
    return degraded('supabase env missing (VITE_SUPABASE_URL / anon key)', { ...ctx, readTier: false });
  }
  const asService = !bearer && Boolean(serviceKey);
  if (!bearer && !asService) return degraded('no bearer and no service key', { ...ctx, readTier: false });

  try {
    const { status, payload, text } = await callRpc('usage_consume', {
      supabaseUrl,
      apikey: asService ? serviceKey : anonKey,
      bearer: asService ? serviceKey : bearer,
      fetchImpl,
      timeoutMs,
      args: {
        p_user: asService ? userId : null,
        p_kind: kind,
        p_cents_estimate: Math.max(0, Math.round(Number(estimateCents) || 0)),
        p_window_key: windowKey,
      },
    });

    if (looksUndeployed(status, payload, text)) {
      return degraded(`usage_consume not deployed yet (status ${status}) — paste migration 063`, ctx);
    }
    if (status !== 200 || !payload || typeof payload !== 'object') {
      return degraded(`usage_consume returned ${status}: ${(text || '').slice(0, 200)}`, ctx);
    }
    const decision = decisionFrom(payload);
    if (!decision.allowed) {
      console.warn(`${LOG} refused kind=${kind} reason=${decision.reason} tier=${payload.tier}`);
    }
    return decision;
  } catch (err) {
    return degraded(`usage_consume threw: ${err?.message || err}`, ctx);
  }
}

/**
 * Correct the pre-call estimate once the provider has reported real token
 * counts. service_role only — granted to a user this would be a self-refund
 * button — so it is a no-op wherever SUPABASE_SERVICE_ROLE_KEY is absent, and
 * the conservative estimate stands. Never throws: reconciliation must not be
 * able to fail a request that already succeeded.
 */
export async function recordActualUsage({
  supabaseUrl,
  serviceKey,
  eventId,
  cents,
  model = null,
  meta = {},
  fetchImpl = null,
  timeoutMs = TIMEOUT_MS,
}) {
  if (!supabaseUrl || !serviceKey || !eventId) return false;
  try {
    const { status, payload } = await callRpc('usage_record_actual', {
      supabaseUrl,
      apikey: serviceKey,
      bearer: serviceKey,
      fetchImpl,
      timeoutMs,
      args: {
        p_event_id: eventId,
        p_cents_actual: Math.max(0, Math.round(Number(cents) || 0)),
        p_model: model,
        p_meta: meta,
      },
    });
    if (status !== 200) {
      console.error(`${LOG} usage_record_actual returned ${status} for event ${eventId}`);
      return false;
    }
    return payload?.ok === true;
  } catch (err) {
    console.error(`${LOG} usage_record_actual threw: ${err?.message || err}`);
    return false;
  }
}

/**
 * The limiter for the ONE unauthenticated endpoint, /api/oauth-register.
 *
 * Fails CLOSED, with one carve-out: if the RPC is not deployed yet the caller
 * is told so (`undeployed: true`) and falls back to a per-instance limiter,
 * because hard-refusing every dynamic client registration between merge and
 * migration would break connector sign-up for no security gain. Once the
 * function EXISTS, any error refuses — which is the fail-closed the audit
 * asked for.
 */
export async function consumeIpUsage({
  supabaseUrl,
  serviceKey,
  ip,
  kind = 'oauth_register',
  windowKey = null,
  fetchImpl = null,
  timeoutMs = TIMEOUT_MS,
}) {
  if (!supabaseUrl || !serviceKey) {
    console.error(`${LOG} no service key for the IP limiter — falling back to the per-instance limiter`);
    return { allowed: true, undeployed: true, status: 200, reason: 'meter_unavailable' };
  }
  try {
    const { status, payload, text } = await callRpc('usage_consume_ip', {
      supabaseUrl,
      apikey: serviceKey,
      bearer: serviceKey,
      fetchImpl,
      timeoutMs,
      args: { p_ip: String(ip || 'unknown'), p_kind: kind, p_window_key: windowKey },
    });
    if (looksUndeployed(status, payload, text)) {
      console.error(`${LOG} usage_consume_ip not deployed yet — paste migration 063`);
      return { allowed: true, undeployed: true, status: 200, reason: 'meter_unavailable' };
    }
    if (status !== 200 || !payload || typeof payload !== 'object') {
      console.error(`${LOG} FAIL-CLOSED — IP limiter returned ${status}: ${(text || '').slice(0, 200)}`);
      return {
        allowed: false, undeployed: false, status: 429, reason: 'meter_error',
        message: 'Registration is temporarily unavailable. Try again shortly.',
        retryAfterSeconds: 60,
      };
    }
    const d = decisionFrom(payload);
    return { ...d, undeployed: false };
  } catch (err) {
    console.error(`${LOG} FAIL-CLOSED — IP limiter threw: ${err?.message || err}`);
    return {
      allowed: false, undeployed: false, status: 429, reason: 'meter_error',
      message: 'Registration is temporarily unavailable. Try again shortly.',
      retryAfterSeconds: 60,
    };
  }
}

/**
 * What a refusal says when the meter gave no sentence of its own.
 *
 * Exported because a run that pauses on the Fly worker has no `res` to write
 * to and still has to tell the person the SAME thing (lib/llm-server-call.mjs
 * writes it onto the `bucketizer_runs` row). Two copies of this sentence would
 * be two sentences the moment one of them was improved.
 */
export const USAGE_REFUSAL_DEFAULT_MESSAGE =
  "You've reached this month's included AI usage. It resets at the start of next month.";

/**
 * Write the refusal. Plain language, because this reaches a person who is
 * mid-sentence in their work and deserves to know what happened and when it
 * clears — never "quota_exceeded".
 */
export function sendUsageRefusal(res, decision) {
  const status = decision.status === 402 ? 402 : 429;
  if (decision.retryAfterSeconds) res.setHeader('retry-after', String(decision.retryAfterSeconds));
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify({
    error: decision.reason || 'usage_limit',
    message: decision.message || USAGE_REFUSAL_DEFAULT_MESSAGE,
    retry_after_seconds: decision.retryAfterSeconds ?? null,
  }));
}

/** The caller's IP behind Vercel's proxy. */
export function clientIp(req) {
  const h = req?.headers || {};
  const xff = h['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : (typeof xff === 'string' ? xff.split(',')[0] : '');
  return String(h['x-real-ip'] || first || req?.socket?.remoteAddress || 'unknown').trim() || 'unknown';
}

/**
 * The server-side ceiling on /api/llm's caller-supplied output allowance.
 *
 * The body is a verbatim provider request, so the field's name depends on the
 * provider. Where the field is ABSENT the ceiling is injected, because absent
 * means "the model's maximum" on the OpenAI-compatible and Google routes —
 * i.e. the most expensive possible answer. Anthropic requires max_tokens, so
 * there is nothing to inject there.
 *
 * Returns { body, clamped, requested, applied }. `body` is the JSON string to
 * forward; everything else about the request is untouched.
 */
export function clampMaxTokens(bodyText, provider, ceiling) {
  if (!ceiling || typeof bodyText !== 'string') {
    return { body: bodyText, clamped: false, requested: null, applied: null };
  }
  let obj;
  try { obj = JSON.parse(bodyText); } catch { return { body: bodyText, clamped: false, requested: null, applied: null }; }
  if (!obj || typeof obj !== 'object') {
    return { body: bodyText, clamped: false, requested: null, applied: null };
  }

  let requested = null;
  let applied = null;
  let clamped = false;

  const clampField = (holder, field) => {
    const cur = holder[field];
    if (typeof cur === 'number' && Number.isFinite(cur)) {
      requested = cur;
      if (cur > ceiling) { holder[field] = ceiling; clamped = true; }
      applied = holder[field];
      return true;
    }
    return false;
  };

  if (provider === 'google') {
    const gc = (obj.generationConfig && typeof obj.generationConfig === 'object')
      ? obj.generationConfig
      : (obj.generationConfig = {});
    if (!clampField(gc, 'maxOutputTokens')) {
      gc.maxOutputTokens = ceiling;
      applied = ceiling;
      clamped = true;
    }
  } else if (provider === 'anthropic') {
    // Required by the API; if it is missing the upstream will say so.
    clampField(obj, 'max_tokens');
  } else {
    // OpenAI-compatible: openai, xai, moonshot, fireworks.
    const field = typeof obj.max_completion_tokens === 'number' ? 'max_completion_tokens' : 'max_tokens';
    if (!clampField(obj, field)) {
      obj.max_tokens = ceiling;
      applied = ceiling;
      clamped = true;
    }
  }

  return { body: JSON.stringify(obj), clamped, requested, applied };
}
