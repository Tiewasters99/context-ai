// The connect and callback routes, once, for every cloud drive.
//
// api/microsoft-connect.mjs, api/dropbox-connect.mjs and their two callbacks
// are four-line files that name their adapter and hand over to the two
// handlers below. Writing the OAuth dance twice is how one copy quietly loses
// a check the other has — and the check most likely to be lost is the one that
// matters (state, the PKCE verifier, the kind that the state claims).
//
// Shape mirrors api/google-connect.mjs and api/google-callback.mjs: a POST
// from the signed-in browser returns { url }; the provider redirects back to
// the callback, which stores an encrypted refresh token with the service role
// and sends the browser to /app/connections.

import { createClient } from '@supabase/supabase-js';

import { encrypt, decrypt } from '../connections-crypto.mjs';
import { signJwt, verifyJwt } from '../oauth-jwt.mjs';
import {
  APP_CONNECTIONS,
  applyCors,
  challengeFor,
  clearVerifierCookie,
  json,
  newVerifier,
  notConfigured,
  readCookie,
  redirect,
  redirectUriFor,
  safeEqual,
  setVerifierCookie,
  verifierCookieName,
} from './index.mjs';

const SUPABASE_URL = () => process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const ANON_KEY = () => process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

// The state is a signed, ten-minute JWT carrying the user id and which
// integration this is — the same mechanism api/google-connect.mjs uses, with
// one addition: the callback checks that the kind in the state is the kind of
// the route it arrived at, so a state minted for one drive cannot be replayed
// at the other's callback.
const STATE_TTL = 600;

/** POST /api/<svc>-connect → { url } · GET → { configured } · DELETE → disconnect */
export function makeConnectHandler(drive) {
  return async function handler(req, res) {
    applyCors(res);
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

    // The probe. A boolean about this deployment — whether the application has
    // been registered — so the Connections card can say "Not available yet"
    // instead of rendering a button that 503s when pressed. It reveals no
    // secret and needs no session.
    if (req.method === 'GET') {
      res.setHeader('cache-control', 'no-store');
      return json(res, 200, {
        service: drive.service,
        label: drive.label,
        configured: drive.isConfigured(),
        missing_env: drive.isConfigured() ? [] : drive.missingEnv(),
      });
    }

    if (req.method !== 'POST' && req.method !== 'DELETE') {
      return json(res, 405, { error: 'method_not_allowed' });
    }

    if (!drive.isConfigured()) return notConfigured(res, drive);
    if (!process.env.MCP_OAUTH_SECRET) return json(res, 500, { error: 'state_secret_missing' });
    if (!SUPABASE_URL() || !ANON_KEY()) return json(res, 500, { error: 'supabase_env_missing' });

    const auth = await authenticate(req);
    if (!auth.ok) return json(res, 401, { error: auth.error });

    if (req.method === 'DELETE') return disconnect(res, drive, auth.userId);

    const verifier = newVerifier();
    const state = signJwt(
      { sub: auth.userId, kind: drive.kind, svc: drive.service },
      process.env.MCP_OAUTH_SECRET,
      STATE_TTL,
    );
    setVerifierCookie(res, drive, verifier);
    res.setHeader('cache-control', 'no-store');
    return json(res, 200, {
      url: drive.authorizeUrl({
        state,
        codeChallenge: challengeFor(verifier),
        redirectUri: redirectUriFor(drive),
      }),
    });
  };
}

/** GET /api/<svc>-callback — the provider sends the browser here. */
export function makeCallbackHandler(drive) {
  return async function handler(req, res) {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      return res.end('method not allowed');
    }

    const back = (params) => {
      // The verifier has done its job (or the flow failed) — either way it
      // does not outlive this request.
      clearVerifierCookie(res, drive);
      return redirect(res, `${APP_CONNECTIONS}?${new URLSearchParams(params).toString()}`);
    };

    if (!drive.isConfigured()) return back({ error: 'not_configured' });

    const q = req.query || {};
    if (q.error) return back({ error: String(q.error) });
    if (!q.code || !q.state) return back({ error: 'missing_code' });

    // 1. The state: our signature, not expired, and minted for THIS drive.
    const payload = verifyJwt(String(q.state), process.env.MCP_OAUTH_SECRET || '');
    if (!payload || !payload.sub) return back({ error: 'bad_state' });
    if (payload.svc !== drive.service) return back({ error: 'bad_state' });

    // 2. The PKCE verifier, from the cookie this browser was given when it
    //    started the flow. No cookie, no exchange: a code that arrives in
    //    someone else's browser is not redeemed here.
    const verifier = readCookie(req, verifierCookieName(drive.service));
    if (!verifier) return back({ error: 'pkce_missing' });

    const exchanged = await drive.exchangeCode({
      code: String(q.code),
      codeVerifier: verifier,
      redirectUri: redirectUriFor(drive),
    });
    if (!exchanged.ok) return back({ error: exchanged.error || 'token_exchange_failed' });

    if (!SUPABASE_URL() || !SERVICE_KEY()) return back({ error: 'supabase_env_missing' });
    if (!process.env.CONNECTIONS_ENC_KEY) return back({ error: 'enc_key_missing' });

    const admin = createClient(SUPABASE_URL(), SERVICE_KEY(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: upErr } = await admin.from('connections').upsert(
      {
        user_id: payload.sub,
        kind: drive.kind,
        status: 'connected',
        connected_email: exchanged.account ?? null,
        scopes: exchanged.scopes ?? drive.scopeString(),
        encrypted_refresh_token: encrypt(exchanged.refreshToken),
        last_verified_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,kind' },
    );
    if (upErr) {
      // Migration 075 not pasted yet is the one failure worth naming: the row
      // is refused by the kind check constraint, and "save failed" would send
      // Eden looking for an OAuth problem that isn't there.
      const code = /connections_kind_check/i.test(upErr.message ?? '') ? 'migration_075_missing' : 'save_failed';
      return back({ error: code });
    }

    return back({ connected: drive.service });
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function authenticate(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (!authHeader || !String(authHeader).toLowerCase().startsWith('bearer ')) {
    return { ok: false, error: 'missing_bearer' };
  }
  const token = String(authHeader).slice(7).trim();
  const sb = createClient(SUPABASE_URL(), ANON_KEY(), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.auth.getUser();
  if (error || !data?.user) return { ok: false, error: 'invalid_session' };
  return { ok: true, userId: data.user.id };
}

/**
 * Disconnect: revoke at the provider where the provider offers it, THEN
 * delete our row. That order matters — a delete that happens first leaves a
 * live grant with nothing left to revoke it with.
 *
 * Dropbox publishes /2/auth/token/revoke, and revoking an access token also
 * disables the refresh token behind it. Microsoft publishes no equivalent for
 * one application's delegated tokens, so the honest answer there is: our copy
 * is gone, and here is where the grant itself is removed.
 */
async function disconnect(res, drive, userId) {
  if (!SERVICE_KEY()) return json(res, 500, { error: 'supabase_env_missing' });
  const admin = createClient(SUPABASE_URL(), SERVICE_KEY(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: conn } = await admin
    .from('connections')
    .select('id, encrypted_refresh_token')
    .eq('user_id', userId)
    .eq('kind', drive.kind)
    .maybeSingle();

  let revokedAtProvider = false;
  let manageUrl = null;
  if (conn?.encrypted_refresh_token && process.env.CONNECTIONS_ENC_KEY) {
    try {
      const refreshed = await drive.refresh({ refreshToken: decrypt(conn.encrypted_refresh_token) });
      const out = await drive.revoke({ accessToken: refreshed.ok ? refreshed.accessToken : null });
      revokedAtProvider = Boolean(out?.revokedAtProvider);
      manageUrl = out?.manageUrl ?? null;
    } catch {
      // A provider that will not answer must not strand the row. The local
      // delete still happens, and the response says the revoke did not.
    }
  }

  const { error: delErr } = await admin
    .from('connections')
    .delete()
    .eq('user_id', userId)
    .eq('kind', drive.kind);
  if (delErr) return json(res, 500, { error: `disconnect_failed: ${delErr.message}` });

  return json(res, 200, {
    ok: true,
    service: drive.service,
    revoked_at_provider: revokedAtProvider,
    ...(manageUrl ? { manage_url: manageUrl } : {}),
  });
}
