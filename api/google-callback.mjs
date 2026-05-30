// GET /api/google-callback
//
// Google redirects the user's browser here after they approve (or deny)
// the Gmail connection. This route:
//   1. verifies the signed `state` to recover the user id;
//   2. exchanges the authorization `code` for tokens;
//   3. encrypts the refresh token and upserts a connections row
//      (via the service role — bypasses RLS);
//   4. redirects the browser back to /app/connections.
//
// Env required on Vercel: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
// MCP_OAUTH_SECRET, CONNECTIONS_ENC_KEY, VITE_SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from '@supabase/supabase-js';
import { verifyJwt } from '../lib/oauth-jwt.mjs';
import { encrypt } from '../lib/connections-crypto.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// .trim() — env vars pasted by hand can carry a stray leading/trailing
// space or newline; that whitespace makes Google reject the credentials
// with "invalid_client" at the token exchange.
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();

const REDIRECT_URI = 'https://www.contextspaces.ai/api/google-callback';
const APP_CONNECTIONS = 'https://www.contextspaces.ai/app/connections';

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

  // Verify state -> user id + integration kind.
  const payload = verifyJwt(String(q.state), process.env.MCP_OAUTH_SECRET || '');
  if (!payload || !payload.sub) {
    return redirect(res, `${APP_CONNECTIONS}?error=bad_state`);
  }
  const userId = payload.sub;
  const kind =
    payload.kind === 'google_calendar' ? 'google_calendar'
    : payload.kind === 'google_drive' ? 'google_drive'
    : 'gmail';

  // Exchange the authorization code for tokens.
  let tokenData;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(q.code),
        client_id: GOOGLE_CLIENT_ID || '',
        client_secret: GOOGLE_CLIENT_SECRET || '',
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }).toString(),
    });
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
    // No refresh token means no durable connection. prompt=consent in the
    // connect step should always yield one; if not, surface it.
    return redirect(res, `${APP_CONNECTIONS}?error=no_refresh_token`);
  }

  // Connected email from the id_token payload — it came straight from
  // Google over TLS, so reading the claim without re-verifying is safe.
  let connectedEmail = null;
  try {
    if (tokenData.id_token) {
      const part = String(tokenData.id_token).split('.')[1];
      const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
      connectedEmail = claims.email || null;
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
      kind,
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

  return redirect(res, `${APP_CONNECTIONS}?connected=${kind}`);
}

function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader('location', url);
  return res.end();
}
