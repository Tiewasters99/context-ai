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
// A second factor, when there is one (migration 099, review MEDIUM-5). Without
// it a thief holding an aal1 session could press this, sign the real owner's
// other devices out, and keep their own. So an account with a verified factor
// must have stepped this session up to aal2 first: otherwise the answer is
// 403 `step_up_required`, NOTHING is revoked and nobody is signed out, and the
// page asks for the factor (StepUpPrompt, from S1) and presses again. The
// database asks the same question itself (099 §6), so the RPC cannot be
// called around this endpoint at aal1 either.

import { createClient } from '@supabase/supabase-js';
import {
  json, corsPreflight, bearerFrom, authUser, jwtClaims, userRpcClient, SUPABASE_URL, SERVICE_KEY,
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

  const hasFactor = Array.isArray(user.factors) && user.factors.some((f) => f?.status === 'verified');
  if (hasFactor && jwtClaims(bearer).aal !== 'aal2') {
    return json(res, 403, { error: 'step_up_required' });
  }

  const { data, error } = await userRpcClient(bearer, { fetchImpl })
    .rpc('disconnect_all', { p_scope: 'account', p_matter: null });
  if (error) {
    if (NOT_DEPLOYED.has(String(error.code))) return json(res, 503, { error: 'not_available' });
    // The database's own aal2 check (099) — the factor was enrolled between
    // Supabase Auth's answer above and the press, say.
    if (/step_up_required/.test(String(error.message ?? ''))) return json(res, 403, { error: 'step_up_required' });
    return json(res, 502, { error: 'disconnect_failed', message: error.message ?? null });
  }
  const counts = data && typeof data === 'object' ? data : {};

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

  return json(res, 200, { counts, others_signed_out: othersSignedOut });
}
