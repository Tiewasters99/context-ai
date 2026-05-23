// GET /api/microsoft-callback
//
// Microsoft redirects the user's browser here after they approve (or
// deny) the Microsoft 365 connection. This route:
//   1. verifies the signed `state` to recover the user id;
//   2. exchanges the authorization `code` for tokens against the
//      Microsoft Entra token endpoint;
//   3. encrypts the refresh token and upserts a connections row
//      (via the service role — bypasses RLS);
//   4. redirects the browser back to /app/connections.
//
// Env required on Vercel: MICROSOFT_OAUTH_CLIENT_ID,
// MICROSOFT_OAUTH_CLIENT_SECRET, MCP_OAUTH_SECRET, CONNECTIONS_ENC_KEY,
// VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from '@supabase/supabase-js';
import { verifyJwt } from '../lib/oauth-jwt.mjs';
import { encrypt } from '../lib/connections-crypto.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// .trim() — env vars pasted by hand can carry a stray leading/trailing
// space or newline; that whitespace makes Microsoft reject the
// credentials with "invalid_client" at the token exchange.
const MS_CLIENT_ID = (process.env.MICROSOFT_OAUTH_CLIENT_ID || '').trim();
const MS_CLIENT_SECRET = (process.env.MICROSOFT_OAUTH_CLIENT_SECRET || '').trim();

const REDIRECT_URI = 'https://www.contextspaces.ai/api/microsoft-callback';
const APP_CONNECTIONS = 'https://www.contextspaces.ai/app/connections';
const TENANT = 'common';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end('method not allowed');
  }

  const q = req.query || {};
  if (q.error) {
    return redirect(res, `${APP_CONNECTIONS}?error=${encodeURIComponent(String(q.error))}`);
  }
  if (!q.code || !q.state) {
    return redirect(res, `${APP_CONNECTIONS}?error=missing_code`);
  }

  // Verify state -> user id.
  const payload = verifyJwt(String(q.state), process.env.MCP_OAUTH_SECRET || '');
  if (!payload || !payload.sub) {
    return redirect(res, `${APP_CONNECTIONS}?error=bad_state`);
  }
  const userId = payload.sub;

  // Exchange the authorization code for tokens.
  let tokenData;
  try {
    const r = await fetch(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(q.code),
          client_id: MS_CLIENT_ID || '',
          client_secret: MS_CLIENT_SECRET || '',
          redirect_uri: REDIRECT_URI,
          grant_type: 'authorization_code',
        }).toString(),
      },
    );
    tokenData = await r.json();
    if (!r.ok) {
      return redirect(
        res,
        `${APP_CONNECTIONS}?error=${encodeURIComponent(tokenData.error || 'token_exchange_failed')}`,
      );
    }
  } catch {
    return redirect(res, `${APP_CONNECTIONS}?error=token_exchange_failed`);
  }

  const refreshToken = tokenData.refresh_token;
  if (!refreshToken) {
    // offline_access in the scope should always yield one; if not, surface it.
    return redirect(res, `${APP_CONNECTIONS}?error=no_refresh_token`);
  }

  // Connected email from the id_token payload. Microsoft puts the work
  // account UPN in `preferred_username` and the verified email (when
  // present) in `email`. UPN is the more reliable identifier for a
  // work tenant user; fall through to `email` only if it's missing.
  // The id_token came straight from Microsoft over TLS, so reading
  // the claim without re-verifying the signature is safe.
  let connectedEmail = null;
  try {
    if (tokenData.id_token) {
      const part = String(tokenData.id_token).split('.')[1];
      const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
      connectedEmail = claims.preferred_username || claims.email || null;
    }
  } catch {
    /* email is best-effort */
  }

  // Store, encrypted, via the service role (bypasses RLS).
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: upErr } = await admin.from('connections').upsert(
    {
      user_id: userId,
      kind: 'microsoft_365',
      status: 'connected',
      connected_email: connectedEmail,
      scopes: tokenData.scope || null,
      encrypted_refresh_token: encrypt(refreshToken),
      last_verified_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,kind' },
  );
  if (upErr) {
    return redirect(res, `${APP_CONNECTIONS}?error=save_failed`);
  }

  return redirect(res, `${APP_CONNECTIONS}?connected=microsoft_365`);
}

function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader('location', url);
  return res.end();
}
