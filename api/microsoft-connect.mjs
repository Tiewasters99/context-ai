// POST /api/microsoft-connect
//
// Starts the Microsoft (Entra ID) OAuth flow for connecting a user's
// Microsoft 365 account — granting Contextspaces read access to their
// OneDrive and SharePoint. The authenticated browser fetches this with
// its Supabase Bearer token; the route returns { url } — the Microsoft
// authorization URL — and the frontend redirects to it.
//
// A signed, short-lived `state` carries the user id so the callback
// (api/microsoft-callback.mjs) can attribute the connection, and serves
// as CSRF protection.
//
// One OAuth scope set covers both OneDrive (Files.Read.All) and
// SharePoint (Sites.Read.All), so the resulting connection row uses a
// single kind ('microsoft_365') rather than splitting per service the
// way Google does (gmail / google_calendar).
//
// Env required on Vercel: MICROSOFT_OAUTH_CLIENT_ID, MCP_OAUTH_SECRET,
// VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

import { createClient } from '@supabase/supabase-js';
import { signJwt } from '../lib/oauth-jwt.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
// .trim() — env vars pasted by hand can carry a stray leading/trailing
// space or newline; that whitespace makes Microsoft reject the credentials.
const MS_CLIENT_ID = (process.env.MICROSOFT_OAUTH_CLIENT_ID || '').trim();

const REDIRECT_URI = 'https://www.contextspaces.ai/api/microsoft-callback';

// `common` accepts any Entra tenant (work / school / personal). Lawyer
// users sign in with a work account in their firm's tenant; the
// multitenant Entra app is registered in Quainton Law but trusted by
// any tenant whose admin grants consent. Use `organizations` here if
// we ever decide to refuse personal Microsoft accounts.
const TENANT = 'common';

// offline_access — refresh tokens (mandatory).
// openid email profile — id_token with the user's email.
// Files.Read.All — OneDrive read.
// Sites.Read.All — SharePoint read.
const SCOPE = [
  'offline_access',
  'openid',
  'email',
  'profile',
  'https://graph.microsoft.com/Files.Read.All',
  'https://graph.microsoft.com/Sites.Read.All',
].join(' ');

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

  if (!MS_CLIENT_ID) {
    return json(res, 500, { error: 'microsoft_oauth_not_configured' });
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
    { sub: userData.user.id, kind: 'microsoft_365' },
    process.env.MCP_OAUTH_SECRET,
    600,
  );

  const url =
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?` +
    new URLSearchParams({
      client_id: MS_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      response_mode: 'query',
      scope: SCOPE,
      // Force the consent screen so the user actually sees what
      // they're granting and a refresh token is reliably returned.
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
