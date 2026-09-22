// requireEntitlement — hidden also means LOCKED, and locked is decided here.
//
// The hole this closes
// ---------------------------------------------------------------------------
// `profiles.pricing_tier` decided what the BUNDLE drew. Every /api/* handler
// authenticated the caller and then served them whatever they asked for: a
// frozen room was hidden from the menu and wide open to `curl`, and
// api/mediation.mjs spent the company's Anthropic and OpenAI keys for any
// signed-in account with no cap at all. On the day a stranger can pay for the
// core product, "the tile isn't rendered" is not a control.
//
// So: one call, right after the handler has authenticated its caller.
//
//   const gate = await requireEntitlement(userId, 'connect');
//   if (!gate.ok) return sendEntitlementRefusal(res, gate);
//
// What it is, precisely
// ---------------------------------------------------------------------------
//   * The surface list is lib/surfaces.mjs — THE list, the same one
//     src/lib/plan.ts re-exports to the browser. There is no second table here
//     to drift from it.
//   * The tier is read from the database, NEVER from the request. A body, a
//     header or a JWT claim saying `plan: 'workshop'` is worth nothing: the
//     only thing the caller's token is used for is naming which row to read,
//     and 062 makes that column writable by the service role alone.
//   * `workshop` passes everything. A beta surface passes for exactly the
//     plans src/lib/plan.ts shows it to (today: workshop only) — the answer
//     comes from canOpenSurfaceId(), so the two can never disagree.
//   * A core surface short-circuits with NO round trip. Every plan may open
//     it, so there is nothing to ask the database, and the core product pays
//     no latency for this file existing.
//
// Failure policy — and why it differs from lib/usage-meter.mjs
// ---------------------------------------------------------------------------
// The meter fails OPEN: refusing a lawyer's work to protect a budget is the
// worse failure, and a request let through costs cents. An entitlement that
// failed open would hand a stranger the room itself, which is not recoverable
// by a refund. So this fails CLOSED for frozen and beta surfaces.
//
// Except that "closed" would also shut Eden out of his own workshop, and when
// the read fails we cannot know whose account it was. So an unreadable tier is
// not a refusal at all — it is an outage:
//
//   read succeeded, tier not entitled   403  "This room is not part of your plan."
//   no profiles row (a fresh signup)    403  — an absent row reads as `free`,
//                                            which is what AuthContext does
//   read failed twice (5xx, timeout,    503  "Contextspaces could not check your
//   network, malformed)                      plan just now. Try again in a moment."
//
// 503 is a promise that trying again may work, and it never tells a paying
// account it has been demoted. One retry first, because the commonest failure
// here is a single cold connection.
//
// No @supabase/supabase-js import on purpose: this is the first thing several
// handlers do, and it speaks PostgREST directly the way lib/usage-meter.mjs
// and lib/ai-tier-policy.mjs already do. `fetchImpl` is injectable so the
// handler tests can drive it with no network.

import { SURFACES, canOpenSurfaceId, normalizePlan } from './surfaces.mjs';

const TIMEOUT_MS = 3000;
const LOG = '[entitlements]';

/** The sentence a person reads when their plan does not include the room. */
export const NOT_IN_PLAN = 'This room is not part of your plan.';

/** The sentence when the plan itself could not be read. Not a refusal — an outage. */
export const PLAN_UNREADABLE =
  'Contextspaces could not check your plan just now. Try again in a moment.';

/** Read `profiles.pricing_tier` once. Returns {found, plan} or {error}. */
async function readTierOnce({ supabaseUrl, apikey, bearer, userId, fetchImpl, timeoutMs }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const url =
    `${supabaseUrl.replace(/\/$/, '')}/rest/v1/profiles`
    + `?id=eq.${encodeURIComponent(userId)}&select=pricing_tier&limit=1`;
  let res;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: { apikey, authorization: `Bearer ${bearer}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { error: `profiles read threw: ${err?.message || err}` };
  }
  const text = await res.text().catch(() => '');
  if (res.status !== 200) return { error: `profiles read returned ${res.status}: ${text.slice(0, 200)}` };
  let rows = null;
  try { rows = text ? JSON.parse(text) : null; } catch { rows = null; }
  if (!Array.isArray(rows)) return { error: `profiles read was not a list: ${text.slice(0, 200)}` };
  // An empty list is an ANSWER, not a failure: no row yet on a fresh signup,
  // which AuthContext already settles as `free`. It must not reach the 503
  // branch, or a brand-new account would be told to try again forever.
  if (rows.length === 0) return { found: false, plan: 'free' };
  return { found: true, plan: normalizePlan(rows[0]?.pricing_tier) };
}

/**
 * May this user open this surface?
 *
 * @param {string|null} userId  the id the handler has already authenticated
 * @param {string} surfaceId    a key of SURFACES (lib/surfaces.mjs)
 * @returns {Promise<{ok:true, plan:string|null, surface:string, reason:string}
 *   | {ok:false, status:number, error:string, message:string, surface:string,
 *      plan:string|null}>}
 */
export async function requireEntitlement(userId, surfaceId, opts = {}) {
  const surface = SURFACES[surfaceId];
  if (!surface) {
    // A typo in a call site must not quietly become an open door. It is a
    // server bug, and it says so.
    console.error(`${LOG} unknown surface '${surfaceId}' — refusing`);
    return {
      ok: false, status: 500, error: 'unknown_surface', surface: String(surfaceId),
      plan: null, message: PLAN_UNREADABLE,
    };
  }

  // Core: open to every plan. No database round trip, no latency, no failure
  // mode — this is the whole product a new account is handed.
  if (surface.tier === 'core') {
    return { ok: true, plan: null, surface: surfaceId, reason: 'core' };
  }

  if (!userId) {
    return {
      ok: false, status: 401, error: 'invalid_session', surface: surfaceId, plan: null,
      message: 'Sign in to use this feature.',
    };
  }

  const supabaseUrl = opts.supabaseUrl || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = opts.serviceKey === undefined ? process.env.SUPABASE_SERVICE_ROLE_KEY : opts.serviceKey;
  const anonKey = opts.anonKey === undefined ? process.env.VITE_SUPABASE_ANON_KEY : opts.anonKey;
  const bearer = opts.bearer || null;
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;

  // The service role first: it reads the row whatever the policies on
  // `profiles` happen to be today, so a policy drift cannot lock an account
  // out of a room it has paid for. The caller's own token is the fallback —
  // 062's "Users read own profile" serves it, and it is the same read
  // AuthContext makes in the browser.
  const asService = Boolean(supabaseUrl && serviceKey);
  const apikey = asService ? serviceKey : anonKey;
  const token = asService ? serviceKey : bearer;
  if (!supabaseUrl || !apikey || !token) {
    console.error(`${LOG} FAIL-CLOSED — no way to read the plan (missing supabase env or bearer)`);
    return {
      ok: false, status: 503, error: 'plan_unreadable', surface: surfaceId, plan: null,
      message: PLAN_UNREADABLE, retryAfterSeconds: 5,
    };
  }

  const args = { supabaseUrl, apikey, bearer: token, userId, fetchImpl: opts.fetchImpl, timeoutMs };
  let read = await readTierOnce(args);
  if (read.error) {
    // One retry. The commonest failure on a cold serverless instance is a
    // single dropped connection, and a person should not be told to come back
    // later because of it.
    console.error(`${LOG} plan read failed, retrying once: ${read.error}`);
    read = await readTierOnce(args);
  }
  if (read.error) {
    console.error(`${LOG} FAIL-CLOSED (503) — plan unreadable twice: ${read.error}`);
    return {
      ok: false, status: 503, error: 'plan_unreadable', surface: surfaceId, plan: null,
      message: PLAN_UNREADABLE, retryAfterSeconds: 5,
    };
  }

  const plan = read.plan;
  if (canOpenSurfaceId(surfaceId, plan)) {
    return { ok: true, plan, surface: surfaceId, reason: 'entitled' };
  }
  return {
    ok: false, status: 403, error: 'not_in_plan', surface: surfaceId, plan,
    message: NOT_IN_PLAN,
  };
}

/**
 * Write the refusal. Plain language, because this reaches a person — never
 * "forbidden_surface". Mirrors sendUsageRefusal in lib/usage-meter.mjs.
 */
export function sendEntitlementRefusal(res, decision) {
  if (decision.retryAfterSeconds) res.setHeader('retry-after', String(decision.retryAfterSeconds));
  res.statusCode = decision.status || 403;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify({
    error: decision.error || 'not_in_plan',
    message: decision.message || NOT_IN_PLAN,
    surface: decision.surface || null,
  }));
}
