// POST /api/google-connect
//
// Starts the Google OAuth flow for connecting a user's Gmail. The
// authenticated browser fetches this with its Supabase Bearer token;
// the route returns { url } — the Google authorization URL — and the
// frontend redirects to it.
//
// A signed, short-lived `state` carries the user id so the callback
// (api/google-callback.mjs) can attribute the connection, and serves
// as CSRF protection.
//
// Env required on Vercel: GOOGLE_OAUTH_CLIENT_ID, MCP_OAUTH_SECRET,
// VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

import { createClient } from '@supabase/supabase-js';
import { signJwt } from '../lib/oauth-jwt.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;

const REDIRECT_URI = 'https://www.contextspaces.ai/api/google-callback';
const SCOPE = 'openid email https://www.googleapis.com/auth/gmail.readonly';

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'method_not_allowed' });
  }

  if (!GOOGLE_CLIENT_ID) {
    return json(res, 500, { error: 'google_oauth_not_configured' });
  }
  if (!process.env.MCP_OAUTH_SECRET) {
    return json(res, 500, { error: 'state_secret_missing' });
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(res, 500, { error: 'supabase_env_missing' });
  }

  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return json(res, 401, { error: 'missing_bearer' });
  }
  const userToken = authHeader.slice(7).trim();
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) {
    return json(res, 401, { error: 'invalid_session' });
  }

  // Signed, 10-minute state carrying the user id.
  const state = signJwt(
    { sub: userData.user.id, kind: 'gmail' },
    process.env.MCP_OAUTH_SECRET,
    600,
  );

  const url =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
    }).toString();

  res.setHeader('cache-control', 'no-store');
  return json(res, 200, { url });
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}
