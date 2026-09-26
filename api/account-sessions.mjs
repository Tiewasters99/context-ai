// /api/account-sessions — Settings → Account → Devices.
//
//   GET                       this account's signed-in devices
//   POST { session_id }       sign that device out
//
// auth.sessions is not readable by a user and not exposed by PostgREST, so
// this endpoint reads it through migration 094's two service-role-only
// functions, always with the user id Supabase Auth itself returned for the
// bearer — never one the browser named. The session the request came from is
// marked `current` and cannot be signed out here (Settings → Sign out does
// that, and does it properly on this device too).
//
// "Sign out that device" deletes the session; its refresh tokens go with it,
// so the device cannot renew. The access token it already holds lasts until
// it expires (the project's JWT expiry — an hour by default). supabase-js's
// auth.admin.signOut(jwt, scope) needs that device's own access token, which
// we never have, so it cannot be used for this.
//
// No location lookup: there is no IP-to-city service in the codebase and this
// slice does not add one. The IP is shown as it is.

import {
  json, corsPreflight, bearerFrom, readJsonBody, authUser, jwtClaims, serviceRpc,
  describeUserAgent,
} from '../lib/account-security.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PostgREST's "that function is not in the schema" — 094 not pasted yet. */
const notDeployed = (r) => r.status === 404 || r.error === 'PGRST202';

export default async function handler(req, res, deps = {}) {
  const fetchImpl = deps.fetchImpl || null;
  if (corsPreflight(req, res, 'GET, POST, OPTIONS')) return;
  if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const bearer = bearerFrom(req);
  if (!bearer) return json(res, 401, { error: 'missing_bearer' });
  const user = await authUser(bearer, { fetchImpl });
  if (!user) return json(res, 401, { error: 'invalid_session' });
  const currentSession = jwtClaims(bearer).session_id ?? null;

  if (req.method === 'GET') {
    const r = await serviceRpc('account_sessions', { p_user: user.id }, { fetchImpl });
    if (!r.ok) {
      if (notDeployed(r)) return json(res, 200, { sessions: [], available: false });
      return json(res, 502, { error: 'sessions_unavailable' });
    }
    const sessions = (Array.isArray(r.data) ? r.data : []).map((s) => ({
      id: s.id,
      device: describeUserAgent(s.user_agent),
      user_agent: s.user_agent ?? null,
      ip: s.ip ?? null,
      created_at: s.created_at ?? null,
      last_active: s.refreshed_at ?? s.created_at ?? null,
      confirmed: s.aal === 'aal2',
      current: Boolean(currentSession) && s.id === currentSession,
    }));
    return json(res, 200, { sessions, available: true });
  }

  const body = await readJsonBody(req);
  const sessionId = typeof body.session_id === 'string' && UUID_RE.test(body.session_id) ? body.session_id : null;
  if (!sessionId) return json(res, 400, { error: 'session_id_required' });
  if (sessionId === currentSession) return json(res, 400, { error: 'current_session' });

  const r = await serviceRpc('account_session_revoke', { p_user: user.id, p_session: sessionId }, { fetchImpl });
  if (!r.ok) {
    if (notDeployed(r)) return json(res, 503, { error: 'not_available' });
    return json(res, 502, { error: 'revoke_failed' });
  }
  return json(res, 200, { signed_out: r.data === true });
}
