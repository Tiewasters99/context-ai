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
// The exception: AGENT connections (migration 087)
// ---------------------------------------------------------------------------
// A grant with agent_token_id set is an agent connection: the client sees
// only that agent's matters. Failing open there would serve a scoped agent
// as the full user, so a token minted for an agent carries `agt` (next to
// `gid`) and every check on such a token is uncached and FAILS CLOSED.
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
// WHY THIS DATE (moved 2026-09-26, migration 099). It was 2026-11-01: six
// weeks for every gid-less refresh token to be adopted or to expire. The
// review of "Disconnect everything" (PR #246, HIGH-2) showed what that window
// cost: a client with no grant row is a client the press cannot see, so it
// cannot be revoked, and its next refresh adopted it back into a live grant.
// So the cut-off is now the day S2b was written. Every token this server has
// minted since 065's code deployed carries a gid, with one exception: a
// full-assistant consent whose grant write failed (a database outage at that
// moment) still mints a gid-less code, and that connection now fails at its
// first use instead of living on unrevocable. What is refused from today is
// otherwise only a token minted before 065, and its owner reconnects through
// the consent screen once. The alternative — keep 2026-11-01 and rely on the
// lock alone (099 refuses gid-less tokens for any account that has pressed
// the button) — is this one line, and is Eden's decision (see the PR).
export const LEGACY_NO_GID_CUTOFF_ISO = '2026-09-26T00:00:00.000Z';
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
  linkFnMissingAt = 0;
  lockFnMissingAt = 0;
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
 *
 * Since migration 087 the state also says whether the grant is an AGENT
 * connection (`agent_token_id`). It is read through oauth_grant_link_state;
 * on a database where 087 is not applied that function does not exist, and
 * the read falls back to 065's oauth_grant_state — correctly, because no
 * grant can be agent-linked before the column exists. The fallback is
 * remembered for LINK_FN_RETRY_MS so a pre-087 database costs one extra
 * round trip per few minutes, not one per read.
 *
 * Since migration 099 it also says whether the grant's OWNER is locked ("Disconnect
 * everything" pressed and not yet deliberately reconnected), read through
 * oauth_grant_lock_state; before 099 that function is missing and the read
 * falls back to 087's, with owner_locked false — which is exact, because no
 * account can be locked before the lock table exists.
 *
 * @returns {Promise<{found:boolean, revoked:boolean, undeployed:boolean,
 *   error:string|null, owner_id:string|null, client_name:string|null,
 *   agent_token_id:string|null, link_known:boolean, owner_locked:boolean}>}
 */
const LINK_FN_RETRY_MS = 5 * 60_000;
let linkFnMissingAt = 0;
let lockFnMissingAt = 0;

export async function grantStateById(grant_id, { fetchImpl = null, now = Date.now() } = {}) {
  const empty = { found: false, revoked: false, undeployed: false, error: null, owner_id: null,
    client_name: null, agent_token_id: null, link_known: false, owner_locked: false };

  let res = null;
  let linkKnown = false;
  if (!lockFnMissingAt || now - lockFnMissingAt >= LINK_FN_RETRY_MS) {
    res = await rpc('oauth_grant_lock_state', { p_grant_id: grant_id }, fetchImpl);
    if (res.undeployed) { lockFnMissingAt = now; res = null; }
    else { lockFnMissingAt = 0; linkKnown = true; }
  }
  if (!res && (!linkFnMissingAt || now - linkFnMissingAt >= LINK_FN_RETRY_MS)) {
    res = await rpc('oauth_grant_link_state', { p_grant_id: grant_id }, fetchImpl);
    if (res.undeployed) { linkFnMissingAt = now; res = null; }
    else { linkFnMissingAt = 0; linkKnown = true; }
  }
  if (!res) res = await rpc('oauth_grant_state', { p_grant_id: grant_id }, fetchImpl);

  const { rows, undeployed, error } = res;
  if (undeployed) return { ...empty, undeployed: true };
  if (error) return { ...empty, error };
  const row = rows?.[0];
  // linkKnown: the answer came from 087's function, so a null agent_token_id
  // is a fact. Without it (a 065-only database) it is also a fact, because no
  // agent link can exist there — but the caller may want to know which.
  if (!row) return { ...empty, link_known: linkKnown };
  return {
    found: true,
    revoked: row.revoked === true,
    undeployed: false,
    error: null,
    owner_id: row.owner_id || null,
    client_name: row.client_name || null,
    agent_token_id: row.agent_token_id || null,
    link_known: linkKnown,
    owner_locked: row.owner_locked === true,
  };
}

/**
 * Whether an account is locked (migration 099) — for the paths that have no
 * grant to read: a token minted before 065. Never cached.
 *
 * @returns {Promise<{locked:boolean, undeployed:boolean, error:string|null}>}
 */
export async function accountLockState(user_id, { fetchImpl = null } = {}) {
  if (!user_id) return { locked: false, undeployed: false, error: 'no user' };
  const { rows, undeployed, error } = await rpc(
    'account_connections_lock_state', { p_user_id: user_id }, fetchImpl);
  if (undeployed) return { locked: false, undeployed: true, error: null };
  if (error) return { locked: false, undeployed: false, error };
  return { locked: rows?.[0]?.locked === true, undeployed: false, error: null };
}

/** The database's refusal of a credential write under a lock (099 §4). */
export function isLockRefusal(error) {
  return /connections_locked/.test(String(error || ''));
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
    // 099: the account is locked and nobody's post-lock sign-in is behind
    // this write. Not an outage — a refusal, which the caller must honour.
    if (isLockRefusal(error)) return { gid: null, outcome: 'locked', undeployed: false, error };
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
    if (isLockRefusal(error)) return { gid: null, outcome: 'locked', undeployed: false, error };
    console.error(`${LOG} could not adopt a pre-065 token (refresh allowed): ${error}`);
    return { gid: null, outcome: 'error', undeployed: false, error };
  }
  const row = rows?.[0];
  return { gid: row?.grant_id || null, outcome: row?.outcome || 'unknown', undeployed: false, error: null };
}

/**
 * The consent path since migration 087: the user clicked Allow on the
 * consent screen, choosing either "full assistant" (agent = null) or
 * "agent" ({ name, provider, matterScope, scopeAll?, tokenHash }).
 *
 * Full assistant: on a database without 087 this falls back to
 * ensureGrantOnApprove, i.e. exactly the 065 behaviour, and like it never
 * blocks consent.
 *
 * Agent: FAILS CLOSED. If the agent grant cannot be recorded — 087 not
 * applied, or any error — it returns ok:false and the caller must refuse to
 * mint a code. Issuing a full-access code because the agent write failed
 * would hand the user's whole account to a client they chose to confine.
 *
 * `session` (migration 099) is the approving browser sign-in's own claims —
 * { sub, iat, session_id } — read from the Supabase token that
 * api/oauth-approve.mjs has just had Supabase Auth verify. It goes to the
 * database with the write (oauth_grant_approve_session), which refuses a
 * sign-in issued before the account pressed "Disconnect everything" and names
 * that sign-in on the account.unlocked row. On a database without 099 the
 * write falls back to 088's oauth_grant_approve, unchanged.
 *
 * A refusal because the account is locked is `ok:false, outcome:'locked'` in
 * BOTH modes: a full-assistant consent that was refused must not continue
 * as a gid-less code, which is what "never blocks consent" would otherwise do.
 *
 * @returns {Promise<{ok:boolean, gid:string|null, agentTokenId:string|null,
 *   outcome:string, undeployed:boolean, error:string|null}>}
 */
export async function approveGrant({
  user_id, client_id, client_name = null, scope = 'mcp', notes = null, agent = null, fetchImpl = null,
  session = null,
}) {
  const args = {
    p_user_id: user_id,
    p_client_id: client_id,
    p_client_name: client_name,
    p_scopes: scopeArray(scope),
    p_notes: notes,
  };
  if (agent) {
    args.p_agent_name = agent.name ?? null;
    args.p_agent_provider = agent.provider ?? null;
    args.p_matter_scope = Array.isArray(agent.matterScope) ? agent.matterScope : [];
    args.p_token_hash = agent.tokenHash ?? null;
    // 088: sent ONLY when true. A database with 087 but not 088 has the
    // 9-argument function; naming p_scope_all there would make every agent
    // consent miss it. Omitted, a listed-matters consent works on both, and
    // an "All my matters" consent on an 087-only database is refused as
    // not deployed (fails closed — never a full-access code).
    if (agent.scopeAll === true) args.p_scope_all = true;
  }
  let res = null;
  if (session && typeof session.sub === 'string' && session.sub) {
    res = await rpc('oauth_grant_approve_session', {
      p_session: { sub: session.sub, iat: session.iat ?? null, session_id: session.session_id ?? null },
      ...args,
    }, fetchImpl);
    if (res.undeployed) res = null;   // no 099 yet: 088's function, as before
  }
  if (!res) res = await rpc('oauth_grant_approve', args, fetchImpl);
  const { rows, undeployed, error } = res;
  if (error && isLockRefusal(error)) {
    logOnce('approve:locked', 'consent refused: the account is locked and this sign-in predates the lock');
    return { ok: false, gid: null, agentTokenId: null, outcome: 'locked', undeployed: false, error };
  }

  if (undeployed) {
    if (agent) {
      logOnce('approve:agent-undeployed', 'oauth_grant_approve not deployed — connecting as an agent refused; paste migration 087 (and 088 for "All my matters")');
      return { ok: false, gid: null, agentTokenId: null, outcome: 'undeployed', undeployed: true, error: null };
    }
    const legacy = await ensureGrantOnApprove({ user_id, client_id, client_name, scope, notes, fetchImpl });
    if (legacy.outcome === 'locked') {
      return { ok: false, gid: null, agentTokenId: null, outcome: 'locked', undeployed: false, error: legacy.error };
    }
    return { ok: true, gid: legacy.gid, agentTokenId: null, outcome: legacy.outcome, undeployed: legacy.undeployed, error: legacy.error };
  }
  if (error) {
    if (agent) {
      console.error(`${LOG} could not record the agent connection (consent refused): ${error}`);
      return { ok: false, gid: null, agentTokenId: null, outcome: 'error', undeployed: false, error };
    }
    console.error(`${LOG} could not record the approval (consent still granted): ${error}`);
    return { ok: true, gid: null, agentTokenId: null, outcome: 'error', undeployed: false, error };
  }
  const row = rows?.[0];
  const gid = row?.grant_id || null;
  const agentTokenId = row?.agent_token_id || null;
  if (agent && (!gid || !agentTokenId)) {
    return { ok: false, gid: null, agentTokenId: null, outcome: 'error', undeployed: false, error: 'no agent grant came back' };
  }
  return { ok: true, gid, agentTokenId: agent ? agentTokenId : null, outcome: row?.outcome || 'unknown', undeployed: false, error: null };
}

/**
 * The connector_tokens row behind an agent-linked grant, read fresh (never
 * cached: Edit matters and Revoke in Connections › Agents must bite on the
 * next request). `select=*` for the same reason path A uses it.
 *
 * @returns {Promise<{row:object|null, error:string|null}>}
 */
export async function readAgentTokenRow(token_id, { fetchImpl = null } = {}) {
  const { url, key } = env();
  if (!url || !key) return { row: null, error: 'supabase env missing (URL / service role key)' };
  if (!token_id || !/^[0-9a-f-]{36}$/i.test(String(token_id))) return { row: null, error: 'bad token id' };
  const doFetch = fetchImpl || globalThis.fetch;
  try {
    const res = await doFetch(
      `${url.replace(/\/$/, '')}/rest/v1/connector_tokens?id=eq.${encodeURIComponent(token_id)}&select=*`,
      {
        headers: { apikey: key, authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) return { row: null, error: `connector_tokens returned ${res.status}` };
    const rows = await res.json();
    return { row: Array.isArray(rows) ? rows[0] ?? null : null, error: null };
  } catch (err) {
    return { row: null, error: `connector_tokens threw: ${err?.message || err}` };
  }
}

/** Stamp the agent's last_used_at, fire-and-forget (path A does the same). */
export function touchAgentToken(token_id, { fetchImpl = null } = {}) {
  const { url, key } = env();
  if (!url || !key || !token_id) return;
  const doFetch = fetchImpl || globalThis.fetch;
  Promise.resolve()
    .then(() => doFetch(
      `${url.replace(/\/$/, '')}/rest/v1/connector_tokens?id=eq.${encodeURIComponent(token_id)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', apikey: key, authorization: `Bearer ${key}`, prefer: 'return=minimal' },
        body: JSON.stringify({ last_used_at: new Date().toISOString() }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    ))
    .catch(() => {});
}

/**
 * Whether an agent row may act for `user_id` right now. Fails closed.
 * @returns {string|null} null = usable, otherwise the refusal reason
 */
export function agentRowRefusal(row, user_id, now = Date.now()) {
  if (!row) return 'agent_missing';
  if (row.kind !== 'agent') return 'agent_not_agent';
  if (row.user_id !== user_id) return 'agent_wrong_owner';
  if (row.revoked_at) return 'agent_revoked';
  if (row.expires_at && new Date(row.expires_at).getTime() <= now) return 'agent_expired';
  return null;
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
 * Under a lock (migration 099), for a full-access grant:
 *   * a cache entry whose state says the owner is locked is never trusted:
 *     every request while the account is locked reads the grant fresh;
 *   * a read that FAILS while the last-known state said "owner locked" is a
 *     refusal, not the fail-open below. Elsewhere the fail-open is unchanged.
 * What this does not close, said plainly: an entry cached BEFORE the press
 * does not know about the lock, so for up to GRANT_CACHE_TTL_MS after a press
 * a warm instance can still serve a grant the press revoked (095 documented
 * the same minute). Closing it outright costs a database read per tool call.
 *
 * @param {object} payload  the verified access-token payload (sub, client_id, gid?)
 * @returns {Promise<{ok:boolean, reason:string, gid:string|null, degraded:boolean, legacy:boolean}>}
 */
export async function checkAccessGrant(payload, { now = Date.now(), fetchImpl = null } = {}) {
  const gid = payload?.gid || null;
  // Migration 087: `agt` = this token was minted for an AGENT connection.
  // Such a token is checked fresh (no cache, so revoking the grant bites on
  // the next request) and FAILS CLOSED on everything the rest of this
  // function would wave through: an agent must never be served as the user.
  const agt = payload?.agt || null;

  if (agt) {
    if (!gid) return { ok: false, reason: 'agent_without_grant', gid: null, degraded: false, legacy: false, agentTokenId: null };
    const state = await grantStateById(gid, { fetchImpl, now });
    cacheSet(`g:${gid}`, state, now);
    if (state.undeployed || state.error) {
      logOnce('access:agent-unverifiable', `agent grant state unreadable, access REFUSED: ${state.error || 'undeployed'}`);
      return { ok: false, reason: 'agent_grant_unverifiable', gid, degraded: true, legacy: false, agentTokenId: null };
    }
    if (!state.found) return { ok: false, reason: 'grant_missing', gid, degraded: false, legacy: false, agentTokenId: null };
    if (state.revoked) return { ok: false, reason: 'grant_revoked', gid, degraded: false, legacy: false, agentTokenId: null };
    if (state.agent_token_id !== agt) {
      // The link was cut (the agent row was deleted: ON DELETE SET NULL) or
      // points elsewhere. Never fall back to the user.
      return { ok: false, reason: 'agent_link_mismatch', gid, degraded: false, legacy: false, agentTokenId: null };
    }
    touchGrant(gid, { now, fetchImpl });
    return { ok: true, reason: 'ok', gid, degraded: false, legacy: false, agentTokenId: agt };
  }

  if (gid) {
    const key = `g:${gid}`;
    const lastKnown = cache.get(key)?.state || null;   // even when expired
    const hit = cacheGet(key, now);
    const trustHit = Boolean(hit?.state) && hit.state.owner_locked !== true;
    let state = trustHit ? hit.state : await grantStateById(gid, { fetchImpl, now });
    if (!trustHit) {
      // A failed read keeps what we last knew about the lock, so a second
      // failure in a row cannot turn "locked" into "fail open".
      if (state.error && lastKnown?.owner_locked === true) state = { ...state, owner_locked: true };
      cacheSet(key, state, now);
    }

    // A token minted without `agt` against a grant that IS agent-linked (a
    // pre-087-code token adopted onto an agent grant, say): the grant decides,
    // and the grant says agent. Narrowing, never widening.
    if (state.found && !state.revoked && state.agent_token_id) {
      touchGrant(gid, { now, fetchImpl });
      return { ok: true, reason: 'ok', gid, degraded: false, legacy: false, agentTokenId: state.agent_token_id };
    }

    if (state.undeployed) {
      logOnce('access:undeployed', 'oauth_grants not deployed yet — access allowed without a grant check; paste migration 065');
      return { ok: true, reason: 'grants_undeployed', gid, degraded: true, legacy: false };
    }
    if (state.error) {
      if (state.owner_locked === true) {
        logOnce('access:error-locked', `grant state unreadable while the owner is locked, access REFUSED: ${state.error}`);
        return { ok: false, reason: 'grant_unverifiable_locked', gid, degraded: true, legacy: false };
      }
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

  // 099: an account that has pressed "Disconnect everything" and not yet
  // reconnected refuses every token that carries no grant — the press could
  // not see those, so it could not have revoked them. A lock that cannot be
  // READ is not a lock: that keeps this path's existing fail-open, logged.
  const lock = await accountLockState(payload.sub, { fetchImpl });
  if (lock.locked) return { ok: false, reason: 'account_locked', gid: null, degraded: false, legacy: true };
  if (lock.error) logOnce('legacy:lock-error', `account lock unreadable for a pre-065 token: ${lock.error}`);

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
    // 087: the live grant this old token attaches to may be an agent
    // connection. If so the token is served as that agent, never the user.
    let agentTokenId = null;
    if (state.gid) {
      const lkey = `g:${state.gid}`;
      const lhit = cacheGet(lkey, now);
      const link = lhit?.state || await grantStateById(state.gid, { fetchImpl, now });
      if (!lhit) cacheSet(lkey, link, now);
      if (link.error) {
        return { ok: false, reason: 'agent_grant_unverifiable', gid: state.gid, degraded: true, legacy: true, agentTokenId: null };
      }
      agentTokenId = link.agent_token_id || null;
    }
    touchGrant(state.gid, { now, fetchImpl });
    return { ok: true, reason: 'legacy_attached', gid: state.gid, degraded: false, legacy: true, agentTokenId };
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
  gid = null, agt = null, user_id, client_id, client_name = null, scope = 'mcp',
  now = Date.now(), fetchImpl = null,
}) {
  // agentTokenId on the result is what the reissued tokens must carry as
  // `agt` (migration 087). A refresh never drops it: the link is on the
  // grant, and a token that had `agt` keeps it even when the state cannot be
  // read, because /api/mcp fails closed for every `agt` token it cannot
  // verify. Degraded refreshes therefore stay safe without being refused.
  if (agt && !gid) return { ok: false, reason: 'agent_without_grant', gid: null, degraded: false, agentTokenId: null };

  if (gid) {
    const state = await grantStateById(gid, { fetchImpl, now });
    if (state.undeployed) {
      logOnce('refresh:undeployed', 'oauth_grants not deployed — refresh allowed, grant id preserved');
      return { ok: true, reason: 'grants_undeployed', gid, degraded: true, agentTokenId: agt };
    }
    if (state.error) {
      logOnce('refresh:error', `grant state unreadable, refresh allowed: ${state.error}`);
      return { ok: true, reason: 'grants_unavailable', gid, degraded: true, agentTokenId: agt };
    }
    if (!state.found) return { ok: false, reason: 'grant_missing', gid: null, degraded: false, agentTokenId: null };
    if (state.revoked) return { ok: false, reason: 'grant_revoked', gid: null, degraded: false, agentTokenId: null };
    if (agt && state.agent_token_id !== agt) {
      return { ok: false, reason: 'agent_link_mismatch', gid: null, degraded: false, agentTokenId: null };
    }
    const agentTokenId = state.agent_token_id || null;
    if (agentTokenId) {
      // Revoking the agent in Connections › Agents ends the sign-in too: the
      // client is told at its next refresh, not only refused per call.
      const { row, error } = await readAgentTokenRow(agentTokenId, { fetchImpl });
      if (!error) {
        const why = agentRowRefusal(row, user_id, now);
        if (why) return { ok: false, reason: why, gid: null, degraded: false, agentTokenId: null };
      }
    }
    return { ok: true, reason: 'ok', gid, degraded: false, agentTokenId };
  }

  // A refresh token minted before 065.
  if (now >= LEGACY_CUTOFF_MS) {
    return { ok: false, reason: 'legacy_token_after_cutoff', gid: null, degraded: false, agentTokenId: null };
  }
  // 099: no adoption for a locked account. The database refuses too, for
  // any account that has EVER pressed the button (099 §8b), so an unreadable
  // lock here falls through to adoption, which then refuses or fails as before.
  const lock = await accountLockState(user_id, { fetchImpl });
  if (lock.locked) return { ok: false, reason: 'account_locked', gid: null, degraded: false, agentTokenId: null };
  const adopted = await adoptLegacyGrant({ user_id, client_id, client_name, scope, fetchImpl });
  if (adopted.outcome === 'locked') return { ok: false, reason: 'account_locked', gid: null, degraded: false, agentTokenId: null };
  if (adopted.undeployed) return { ok: true, reason: 'grants_undeployed', gid: null, degraded: true, agentTokenId: null };
  if (adopted.error) return { ok: true, reason: 'grants_unavailable', gid: null, degraded: true, agentTokenId: null };
  if (adopted.outcome === 'revoked') return { ok: false, reason: 'grant_revoked', gid: null, degraded: false, agentTokenId: null };
  // Adoption attaches to the live grant, which since 087 may be an agent
  // connection; if so the reissued tokens carry its `agt`.
  let agentTokenId = null;
  if (adopted.gid) {
    const link = await grantStateById(adopted.gid, { fetchImpl, now });
    agentTokenId = link.agent_token_id || null;
  }
  return { ok: true, reason: adopted.outcome, gid: adopted.gid, degraded: false, agentTokenId };
}
