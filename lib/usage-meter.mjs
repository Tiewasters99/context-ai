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
// Failure policy — availability over strictness
// ---------------------------------------------------------------------------
// A refusal is a 200 from PostgREST carrying {allowed:false}. ANYTHING else —
// the function missing because migration 063 has not been pasted yet (404 /
// PGRST202), a timeout, a 5xx, a network error — allows the request and logs
// loudly. That is what lets this ship before the migration is applied, and it
// is the right trade for a product where refusing a lawyer's work to protect a
// budget is the worse failure. The one exception is the unauthenticated
// /api/oauth-register, which calls consumeIpUsage() and fails CLOSED; see
// there for the one case it still lets through and why.

const TIMEOUT_MS = 3000;
const LOG = '[usage-meter]';

/** Normalised "the meter could not answer, so we are letting this through". */
function degraded(note, extra = {}) {
  console.error(`${LOG} FAIL-OPEN — request allowed without metering: ${note}`);
  return {
    allowed: true,
    degraded: true,
    status: 200,
    reason: 'meter_unavailable',
    message: null,
    eventId: null,
    maxOutputTokens: null,
    maxRequestBytes: null,
    retryAfterSeconds: null,
    ...extra,
  };
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

async function callRpc(fn, { supabaseUrl, apikey, bearer, args, fetchImpl, timeoutMs = TIMEOUT_MS }) {
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
function looksUndeployed(status, payload, text) {
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
}) {
  if (!supabaseUrl || !(anonKey || serviceKey)) {
    return degraded('supabase env missing (VITE_SUPABASE_URL / anon key)');
  }
  const asService = !bearer && Boolean(serviceKey);
  if (!bearer && !asService) return degraded('no bearer and no service key');

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
      return degraded(`usage_consume not deployed yet (status ${status}) — paste migration 063`);
    }
    if (status !== 200 || !payload || typeof payload !== 'object') {
      return degraded(`usage_consume returned ${status}: ${(text || '').slice(0, 200)}`);
    }
    const decision = decisionFrom(payload);
    if (!decision.allowed) {
      console.warn(`${LOG} refused kind=${kind} reason=${decision.reason} tier=${payload.tier}`);
    }
    return decision;
  } catch (err) {
    return degraded(`usage_consume threw: ${err?.message || err}`);
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
