// /api/account-lockdown — Settings → Connections → "Disconnect everything".
//
//   POST            disconnect every assistant, agent and app on this account,
//                   pause AI on every matter it runs, and sign every OTHER
//                   browser out. Returns the counts.
//
// docs/specs/SECURITY-BUILD-2026-09-26.md §S2. Two halves, in this order:
//
//   1. public.disconnect_all('account') — migration 095 — called AS THE
//      PERSON, with their own bearer, so auth.uid() is the byline and the
//      account chain the Record rows land on. One transaction: it revokes
//      everything and writes the Record, or it does nothing and says why.
//   2. Only if (1) committed: Supabase Auth signs out every other session of
//      this user (supabase-js auth.admin.signOut(jwt, 'others'), which is
//      POST /auth/v1/logout?scope=others with the presser's OWN access token).
//      Their refresh tokens die, so those devices cannot renew; an access
//      token one of them already holds lasts until it expires (an hour by
//      default). The presser keeps this session — they are the one who has to
//      be able to reconnect things afterwards.
//
// Fails closed. If (1) fails, (2) never runs: a sign-out with nothing revoked
// would look like the button worked when it had not. If (2) fails after (1)
// committed, the answer is 200 with the counts and `others_signed_out: false`,
// because everything in (1) did happen and the page must say what did not.
//
// The bearer is checked the way api/account-sessions.mjs checks it: Supabase
// Auth is asked who it belongs to before anything else happens.
//
// A second factor, when there is one (migration 099; round 2 of its review).
// The two halves are judged differently, on purpose:
//
//   * The REVOKE half is never gated on a second factor. Revoking is the safe
//     direction, and a gate there is a way to break the switch: on an account
//     with no factor, a thief can enrol one at aal1 (Supabase Auth allows it
//     when none exists), and the owner's own press would then answer "step
//     up" with a factor the owner does not have (NEW-2).
//   * The SIGN-OUT-OTHERS half is what a thief would want: sign the owner out
//     and keep their own session. So when the account has a verified factor
//     and this session is aal1, other sessions are signed out only if EVERY
//     verified factor was added after this session began — a factor enrolled
//     after I signed in is not mine to prove. Otherwise the press still
//     happens and the answer says `sign_out: 'step_up_required'`; the page
//     asks for the factor and calls again with {sign_out_only: true}, which
//     signs the others out and revokes nothing further.
//
// The lock no longer depends on the sign-out at all (099 round 2): a session
// that survives it — logout failed, or a refresh landed between the commit
// and the logout — is refused by the database, because it began before the
// press and is not the presser's.

import { createClient } from '@supabase/supabase-js';
import {
  json, corsPreflight, bearerFrom, authUser, jwtClaims, readJsonBody, serviceRpc, userRpcClient,
  SUPABASE_URL, SERVICE_KEY,
} from '../lib/account-security.mjs';

/** PostgREST's "that function is not in the schema" — 095 not pasted yet. */
const NOT_DEPLOYED = new Set(['PGRST202', '42883']);

export default async function handler(req, res, deps = {}) {
  const fetchImpl = deps.fetchImpl || null;
  if (corsPreflight(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const bearer = bearerFrom(req);
  if (!bearer) return json(res, 401, { error: 'missing_bearer' });
  const user = await authUser(bearer, { fetchImpl });
  if (!user) return json(res, 401, { error: 'invalid_session' });

  const body = await readJsonBody(req);
  const signOutOnly = body?.sign_out_only === true;

  let counts = null;
  if (!signOutOnly) {
    const { data, error } = await userRpcClient(bearer, { fetchImpl })
      .rpc('disconnect_all', { p_scope: 'account', p_matter: null });
    if (error) {
      if (NOT_DEPLOYED.has(String(error.code))) return json(res, 503, { error: 'not_available' });
      return json(res, 502, { error: 'disconnect_failed', message: error.message ?? null });
    }
    counts = data && typeof data === 'object' ? data : {};
  }

  if (!(await maySignOutOthers(user, bearer, { fetchImpl }))) {
    if (signOutOnly) return json(res, 403, { error: 'step_up_required' });
    return json(res, 200, { counts, others_signed_out: false, sign_out: 'step_up_required' });
  }

  let othersSignedOut = false;
  try {
    const url = SUPABASE_URL();
    const key = SERVICE_KEY();
    if (url && key) {
      const admin = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
        ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
      });
      const { error: outErr } = await admin.auth.admin.signOut(bearer, 'others');
      othersSignedOut = !outErr;
      if (outErr) console.warn('[account-lockdown] other sessions not signed out:', outErr.message);
    } else {
      console.warn('[account-lockdown] service role not configured; other sessions not signed out');
    }
  } catch (err) {
    console.warn('[account-lockdown] other sessions not signed out:', err?.message || err);
  }

  if (signOutOnly) return json(res, 200, { others_signed_out: othersSignedOut });
  return json(res, 200, { counts, others_signed_out: othersSignedOut });
}

/**
 * May this session sign the account's other sessions out? Yes with no
 * verified factor, yes at aal2, and yes at aal1 when every verified factor
 * was added after this session began. Anything it cannot read is a no — the
 * revoke has already happened; only the sign-out waits for the factor.
 */
async function maySignOutOthers(user, bearer, { fetchImpl = null } = {}) {
  const factors = (Array.isArray(user.factors) ? user.factors : []).filter((f) => f?.status === 'verified');
  if (factors.length === 0) return true;
  const claims = jwtClaims(bearer);
  if (claims.aal === 'aal2') return true;
  const r = await serviceRpc('account_sessions', { p_user: user.id }, { fetchImpl });
  const mine = r.ok && Array.isArray(r.data) ? r.data.find((x) => x?.id === claims.session_id) : null;
  const began = mine?.created_at ? Date.parse(mine.created_at) : NaN;
  if (!Number.isFinite(began)) return false;
  return factors.every((f) => Number.isFinite(Date.parse(f.created_at)) && Date.parse(f.created_at) > began);
}
