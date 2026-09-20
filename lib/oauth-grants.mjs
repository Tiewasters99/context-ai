// Per-connection OAuth grants, as the API handlers see them (migration 065:
// oauth_grants + oauth_grant_upsert / _adopt / _state / _state_by_client /
// _touch).
//
// What this is for
// ---------------------------------------------------------------------------
// Until now an OAuth approval left no record, so "revoke Claude" and "log
// every customer out" were the same button (rotate MCP_OAUTH_SECRET). Now an
// approval mints a grant row, the access and refresh tokens carry that row's
// id as `gid`, and revoking the row cuts off one client.
//
// Deliberately no @supabase/supabase-js import: /api/oauth-token has never
// pulled the client in, and /api/mcp calls checkAccessGrant on the hot path
// before it builds anything. This module speaks PostgREST directly, the same
// way lib/usage-meter.mjs does, and `fetchImpl` is injectable so the offline
// harness can drive every path against a stubbed backend with no network.
//
// The three failure policies, each chosen on purpose
// ---------------------------------------------------------------------------
//   * GRANT REVOKED, or a token naming a grant that no longer exists
//     → FAIL CLOSED. This is the whole point of the feature; a revocation
//       that can be shrugged off is not a revocation.
//   * THE TABLE IS NOT DEPLOYED YET (PGRST202/PGRST205/42883/42P01/404)
//     → FAIL OPEN, logged. This is what lets the code merge before Eden
//       pastes 065. Merging must not disconnect anybody.
//   * ANY OTHER FAILURE — timeout, 5xx, DNS, a torn deploy
//     → FAIL OPEN, logged. An access token is re-presented on every single
//       tool call; turning a 3-second database blip into a 401 would tell
//       claude.ai its token is bad and send the customer round the consent
//       screen again. Availability wins, and the blast radius is one cache
//       window. Stated plainly rather than hidden: a revoked client keeps
//       working for as long as this server cannot reach its own database.
//
// Staleness
// ---------------------------------------------------------------------------
// /api/mcp would otherwise add a database round trip to every tool call. It
// does not: grant state is cached in the serverless instance's memory for
// GRANT_CACHE_TTL_MS (60 s). So a revocation takes effect within about a
// minute per warm instance, not instantly, and the Connections page says a
// minute for that reason. last_used_at is stamped at most once every
// LAST_USED_THROTTLE_MS (5 minutes) per grant per instance, because it means
// "when did this client last touch my matters", not "every call".

import { createHash } from 'node:crypto';

const LOG = '[oauth-grants]';
const TIMEOUT_MS = 3000;

/** How long a grant's state may be believed without re-reading it. */
export const GRANT_CACHE_TTL_MS = 60_000;

/** How often one instance stamps last_used_at for one grant. */
export const LAST_USED_THROTTLE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// The legacy cut-off
// ---------------------------------------------------------------------------
// Every access and refresh token in the field on the day 065 deploys was
// minted without a `gid`. Refusing them would disconnect every customer
// (Eden's own claude.ai and ChatGPT among them) at the exact moment this
// ships — the disease this feature exists to cure. So until the date below,
// a token with no `gid` is still honoured:
//
//   * an access token with no gid is accepted unless the user has SINCE
//     revoked a grant for that same client_id — see checkAccessGrant, which
//     looks the pair up so that a revocation does bite a legacy token as
//     soon as the client has been adopted once;
//   * a refresh token with no gid is ADOPTED: the server mints the grant the
//     approval should have left behind and the reissued pair carries its id.
//     Adoption refuses if a grant for that client was already revoked
//     (migration 065 §4b) — otherwise a pre-revocation refresh token, which
//     has no denylist, could be replayed to walk back in.
//
// The trade-off, plainly: between deploy and a client's first refresh, that
// client cannot be revoked per-connection, because there is no grant to
// revoke. The window is short in practice — access tokens live 12 hours, so
// every live client refreshes within a day and is adopted then — and it is
// bounded absolutely by the constant below.
//
// WHY THIS DATE: refresh tokens live 30 days, so every gid-less token
// legitimately issued before the merge has expired 30 days after it. Written
// 2026-09-20 for a merge expected in days; 2026-11-01 leaves about six weeks
// of slack. IF THE MERGE SLIPS PAST ~2026-10-01, PUSH THIS DATE — otherwise
// the cut-off could land inside the life of a token this server itself
// issued. After it, a gid-less token is refused and the customer reconnects
// from the Connections page; nothing is lost but one trip through consent.
export const LEGACY_NO_GID_CUTOFF_ISO = '2026-11-01T00:00:00.000Z';
const LEGACY_CUTOFF_MS = Date.parse(LEGACY_NO_GID_CUTOFF_ISO);

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
function env() {
  return {
    url: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '',
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  };
}

// PostgREST says PGRST202 when a function is not in its schema cache and
// PGRST205 for a table — which is what a not-yet-pasted migration looks like,
// and also what a just-pasted one looks like until
// `notify pgrst, 'reload schema'` lands. 42883/42P01 are the Postgres codes
// underneath.
function looksUndeployed(status, payload, text) {
  if (status === 404) return true;
  const code = payload?.code || '';
  if (['PGRST202', 'PGRST205', '42883', '42P01'].includes(code)) return true;
  return /could not find the (function|table)|does not exist|schema cache/i.test(text || '');
}

/**
 * One RPC call. Returns {rows, undeployed, error} and never throws.
 */
async function rpc(fn, args, fetchImpl) {
  const { url, key } = env();
  if (!url || !key) {
    return { rows: null, undeployed: false, error: 'supabase env missing (URL / service role key)' };
  }
  const doFetch = fetchImpl || globalThis.fetch;
  try {
    const res = await doFetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: key,
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }

    if (looksUndeployed(res.status, payload, text)) {
      return { rows: null, undeployed: true, error: null };
    }
    if (!res.ok) {
      return { rows: null, undeployed: false, error: `${fn} returned ${res.status}: ${(text || '').slice(0, 160)}` };
    }
    const rows = Array.isArray(payload) ? payload : payload == null ? [] : [payload];
    return { rows, undeployed: false, error: null };
  } catch (err) {
    return { rows: null, undeployed: false, error: `${fn} threw: ${err?.message || err}` };
  }
}

// ---------------------------------------------------------------------------
// Log throttle — a hot path must not print the same line on every tool call.
// ---------------------------------------------------------------------------
const lastLogged = new Map();
function logOnce(key, message) {
  const now = Date.now();
  const prev = lastLogged.get(key) || 0;
  if (now - prev < GRANT_CACHE_TTL_MS) return;
  if (lastLogged.size > 500) lastLogged.clear();
  lastLogged.set(key, now);
  console.warn(`${LOG} ${message}`);
}

// ---------------------------------------------------------------------------
// Cache — per serverless instance, keyed by grant id or by user+client.
// ---------------------------------------------------------------------------
const cache = new Map(); // key -> { state, checkedAt, touchedAt }

/** Test seam: forget everything this instance believes. */
export function _resetGrantCache() {
  cache.clear();
  lastLogged.clear();
}

function cacheGet(key, now) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.checkedAt >= GRANT_CACHE_TTL_MS) return null;
  return hit;
}

function cacheSet(key, state, now) {
  if (cache.size > 5000) cache.clear();
  const prev = cache.get(key);
  cache.set(key, { state, checkedAt: now, touchedAt: prev?.touchedAt || 0 });
}

function clientKey(user_id, client_id) {
  const h = createHash('sha256').update(String(client_id || '')).digest('base64url').slice(0, 24);
  return `c:${user_id}:${h}`;
}

// ---------------------------------------------------------------------------
// State reads
// ---------------------------------------------------------------------------

/**
 * One grant's state by id.
 * @returns {Promise<{found:boolean, revoked:boolean, undeployed:boolean,
 *   error:string|null, owner_id:string|null, client_name:string|null}>}
 */
export async function grantStateById(grant_id, { fetchImpl = null } = {}) {
  const { rows, undeployed, error } = await rpc('oauth_grant_state', { p_grant_id: grant_id }, fetchImpl);
  if (undeployed) return { found: false, revoked: false, undeployed: true, error: null, owner_id: null, client_name: null };
  if (error) return { found: false, revoked: false, undeployed: false, error, owner_id: null, client_name: null };
  const row = rows?.[0];
  if (!row) return { found: false, revoked: false, undeployed: false, error: null, owner_id: null, client_name: null };
  return {
    found: true,
    revoked: row.revoked === true,
    undeployed: false,
    error: null,
    owner_id: row.owner_id || null,
    client_name: row.client_name || null,
  };
}

/**
 * The state of the (user, client) pair — the only question a token minted
 * before 065 can answer, because it carries no grant id.
 */
export async function grantStateByClient(user_id, client_id, { fetchImpl = null } = {}) {
  const { rows, undeployed, error } = await rpc(
    'oauth_grant_state_by_client',
    { p_user_id: user_id, p_client_id: client_id },
    fetchImpl,
  );
  if (undeployed) return { found: false, revoked: false, undeployed: true, error: null, gid: null };
  if (error) return { found: false, revoked: false, undeployed: false, error, gid: null };
  const row = rows?.[0];
  if (!row) return { found: false, revoked: false, undeployed: false, error: null, gid: null };
  return { found: true, revoked: row.revoked === true, undeployed: false, error: null, gid: row.grant_id || null };
}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

/**
 * The consent path: the user has just clicked Approve. Attaches to the live
 * grant for this client if there is one, otherwise mints a new one — even
 * where an older grant was revoked, because the user has said yes again.
 *
 * Never throws and never blocks consent: on any failure the caller carries on
 * with gid === null, which is exactly the pre-065 behaviour.
 *
 * @returns {Promise<{gid:string|null, outcome:string, undeployed:boolean, error:string|null}>}
 */
export async function ensureGrantOnApprove({
  user_id, client_id, client_name = null, scope = 'mcp', notes = null, fetchImpl = null,
}) {
  const { rows, undeployed, error } = await rpc('oauth_grant_upsert', {
    p_user_id: user_id,
    p_client_id: client_id,
    p_client_name: client_name,
    p_scopes: scopeArray(scope),
    p_notes: notes,
  }, fetchImpl);

  if (undeployed) {
    logOnce('upsert:undeployed', 'oauth_grants not deployed yet — approval recorded nowhere; paste migration 065');
    return { gid: null, outcome: 'undeployed', undeployed: true, error: null };
  }
  if (error) {
    console.error(`${LOG} could not record the approval (consent still granted): ${error}`);
    return { gid: null, outcome: 'error', undeployed: false, error };
  }
  const row = rows?.[0];
  return { gid: row?.grant_id || null, outcome: row?.outcome || 'unknown', undeployed: false, error: null };
}

/**
 * The legacy path: a refresh token with no `gid`. Mints the grant the
 * approval should have left behind — unless a grant for this client was
 * already revoked, in which case it refuses (migration 065 §4b).
 */
export async function adoptLegacyGrant({
  user_id, client_id, client_name = null, scope = 'mcp', notes = null, fetchImpl = null,
}) {
  const { rows, undeployed, error } = await rpc('oauth_grant_adopt', {
    p_user_id: user_id,
    p_client_id: client_id,
    p_client_name: client_name,
    p_scopes: scopeArray(scope),
    p_notes: notes,
  }, fetchImpl);

  if (undeployed) {
    logOnce('adopt:undeployed', 'oauth_grants not deployed yet — refreshing a pre-065 token unchanged');
    return { gid: null, outcome: 'undeployed', undeployed: true, error: null };
  }
  if (error) {
    console.error(`${LOG} could not adopt a pre-065 token (refresh allowed): ${error}`);
    return { gid: null, outcome: 'error', undeployed: false, error };
  }
  const row = rows?.[0];
  return { gid: row?.grant_id || null, outcome: row?.outcome || 'unknown', undeployed: false, error: null };
}

function scopeArray(scope) {
  if (Array.isArray(scope)) return scope.filter(Boolean);
  const parts = String(scope || 'mcp').split(/\s+/).filter(Boolean);
  return parts.length ? parts : ['mcp'];
}

// ---------------------------------------------------------------------------
// last_used_at — throttled, fire-and-forget
// ---------------------------------------------------------------------------
export function touchGrant(grant_id, { now = Date.now(), fetchImpl = null } = {}) {
  if (!grant_id) return false;
  const key = `g:${grant_id}`;
  const entry = cache.get(key);
  if (entry && now - (entry.touchedAt || 0) < LAST_USED_THROTTLE_MS) return false;
  if (entry) entry.touchedAt = now;
  else cache.set(key, { state: null, checkedAt: 0, touchedAt: now });

  // Deliberately not awaited: "when did this client last look at my matters"
  // must never be able to slow down or fail a tool call.
  rpc('oauth_grant_touch', { p_grant_id: grant_id }, fetchImpl)
    .then((r) => { if (r.error) logOnce('touch:error', `last_used_at not stamped: ${r.error}`); })
    .catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
// The two decisions
// ---------------------------------------------------------------------------

/**
 * /api/mcp, on every request. Cached for GRANT_CACHE_TTL_MS, so a revocation
 * bites within about a minute per warm instance and the hot path costs
 * nothing in the common case.
 *
 * @param {object} payload  the verified access-token payload (sub, client_id, gid?)
 * @returns {Promise<{ok:boolean, reason:string, gid:string|null, degraded:boolean, legacy:boolean}>}
 */
export async function checkAccessGrant(payload, { now = Date.now(), fetchImpl = null } = {}) {
  const gid = payload?.gid || null;

  if (gid) {
    const key = `g:${gid}`;
    const hit = cacheGet(key, now);
    const state = hit?.state || await grantStateById(gid, { fetchImpl });
    if (!hit) cacheSet(key, state, now);

    if (state.undeployed) {
      logOnce('access:undeployed', 'oauth_grants not deployed yet — access allowed without a grant check; paste migration 065');
      return { ok: true, reason: 'grants_undeployed', gid, degraded: true, legacy: false };
    }
    if (state.error) {
      logOnce('access:error', `grant state unreadable, access allowed: ${state.error}`);
      return { ok: true, reason: 'grants_unavailable', gid, degraded: true, legacy: false };
    }
    if (!state.found) return { ok: false, reason: 'grant_missing', gid, degraded: false, legacy: false };
    if (state.revoked) return { ok: false, reason: 'grant_revoked', gid, degraded: false, legacy: false };

    touchGrant(gid, { now, fetchImpl });
    return { ok: true, reason: 'ok', gid, degraded: false, legacy: false };
  }

  // No gid: a token minted before migration 065.
  if (now >= LEGACY_CUTOFF_MS) {
    return { ok: false, reason: 'legacy_token_after_cutoff', gid: null, degraded: false, legacy: true };
  }
  if (!payload?.sub || !payload?.client_id) {
    // Nothing to look the pair up with. Pre-cut-off this is still the old
    // world's token, and the old world accepted it.
    return { ok: true, reason: 'legacy_unidentifiable', gid: null, degraded: true, legacy: true };
  }

  const key = clientKey(payload.sub, payload.client_id);
  const hit = cacheGet(key, now);
  const state = hit?.state || await grantStateByClient(payload.sub, payload.client_id, { fetchImpl });
  if (!hit) cacheSet(key, state, now);

  if (state.undeployed) {
    logOnce('legacy:undeployed', 'oauth_grants not deployed yet — pre-065 token allowed; paste migration 065');
    return { ok: true, reason: 'grants_undeployed', gid: null, degraded: true, legacy: true };
  }
  if (state.error) {
    logOnce('legacy:error', `grant state unreadable, pre-065 token allowed: ${state.error}`);
    return { ok: true, reason: 'grants_unavailable', gid: null, degraded: true, legacy: true };
  }
  if (state.found && state.revoked) {
    // The client was adopted and then revoked. The old gid-less access token
    // dies with it — this is why the legacy path looks the pair up at all.
    return { ok: false, reason: 'grant_revoked', gid: state.gid, degraded: false, legacy: true };
  }
  if (state.found) {
    touchGrant(state.gid, { now, fetchImpl });
    return { ok: true, reason: 'legacy_attached', gid: state.gid, degraded: false, legacy: true };
  }
  // Never approved through 065 — a token from before the table existed.
  return { ok: true, reason: 'legacy_ungranted', gid: null, degraded: true, legacy: true };
}

/**
 * /api/oauth-token, refresh_token grant. NOT cached: a refresh happens about
 * twice a day per client, and it is the one moment where being right matters
 * more than being fast.
 *
 * @returns {Promise<{ok:boolean, reason:string, gid:string|null, degraded:boolean}>}
 */
export async function checkRefreshGrant({
  gid = null, user_id, client_id, client_name = null, scope = 'mcp',
  now = Date.now(), fetchImpl = null,
}) {
  if (gid) {
    const state = await grantStateById(gid, { fetchImpl });
    if (state.undeployed) {
      logOnce('refresh:undeployed', 'oauth_grants not deployed — refresh allowed, grant id preserved');
      return { ok: true, reason: 'grants_undeployed', gid, degraded: true };
    }
    if (state.error) {
      logOnce('refresh:error', `grant state unreadable, refresh allowed: ${state.error}`);
      return { ok: true, reason: 'grants_unavailable', gid, degraded: true };
    }
    if (!state.found) return { ok: false, reason: 'grant_missing', gid: null, degraded: false };
    if (state.revoked) return { ok: false, reason: 'grant_revoked', gid: null, degraded: false };
    return { ok: true, reason: 'ok', gid, degraded: false };
  }

  // A refresh token minted before 065.
  if (now >= LEGACY_CUTOFF_MS) {
    return { ok: false, reason: 'legacy_token_after_cutoff', gid: null, degraded: false };
  }
  const adopted = await adoptLegacyGrant({ user_id, client_id, client_name, scope, fetchImpl });
  if (adopted.undeployed) return { ok: true, reason: 'grants_undeployed', gid: null, degraded: true };
  if (adopted.error) return { ok: true, reason: 'grants_unavailable', gid: null, degraded: true };
  if (adopted.outcome === 'revoked') return { ok: false, reason: 'grant_revoked', gid: null, degraded: false };
  return { ok: true, reason: adopted.outcome, gid: adopted.gid, degraded: false };
}
