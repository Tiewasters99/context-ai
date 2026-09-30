// POST /api/oauth-client-mint — mint a CONFIDENTIAL OAuth client on the server.
//
// Why here and not in scripts/register-oauth-client.mjs: MCP_OAUTH_SECRET is
// a Sensitive variable in Vercel (2026-09-29), so it can be neither revealed
// nor pulled. This function already holds it, so it does the minting, and
// what leaves is only the derived credential — a client_id and its one-time
// client_secret — never the secret they were signed with. Everything about
// the client itself is lib/oauth-clients.mjs, unchanged.
//
// Who may call it: a signed-in Contextspaces user (Supabase access token in
// Authorization, validated by Supabase itself as /api/oauth-approve does)
// whose email is listed in OAUTH_CLIENT_ADMIN_EMAILS (comma-separated). With
// that variable unset the endpoint is switched off and says so. Nothing is
// stored: the client_id IS the registration. The mint is logged with the
// admin's user id, the client name and the redirect hosts — never the secret.
//
// Body: { client_name, redirect_uris: [https://…] }   (1–5 https URIs)
// 200:  { client_id, client_secret, client_name, redirect_uris, minted_at }

import { createClient } from '@supabase/supabase-js';

import { mintConfidentialClient, validRedirectPattern } from '../lib/oauth-clients.mjs';
import { getOauthSecret } from '../lib/oauth-jwt.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const MAX_REDIRECTS = 5;

/** The admin allowlist, lower-cased. Empty = the endpoint is off. */
export function adminEmails(env = process.env) {
  return String(env.OAUTH_CLIENT_ADMIN_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') { res.setHeader('allow', 'POST, OPTIONS'); return json(res, 405, { error: 'method_not_allowed' }); }

  const admins = adminEmails();
  if (!admins.length) {
    return json(res, 503, { error: 'not_enabled', detail: 'OAUTH_CLIENT_ADMIN_EMAILS is not set on this deployment; minting is switched off.' });
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return json(res, 500, { error: 'config_error', detail: 'Supabase env vars unset' });
  let oauthSecret;
  try { oauthSecret = getOauthSecret(); }
  catch (e) { return json(res, 500, { error: 'config_error', detail: e.message }); }

  // 1. Who is asking — Supabase validates the session token, as /api/oauth-approve does.
  const auth = req.headers.authorization || req.headers.Authorization;
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) return json(res, 401, { error: 'login_required' });
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${auth.slice(7).trim()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await sb.auth.getUser();
  const user = userData?.user;
  if (userErr || !user?.id) return json(res, 401, { error: 'login_required', detail: userErr?.message || 'invalid session' });
  const email = String(user.email || '').toLowerCase();
  if (!email || !admins.includes(email)) {
    console.warn('[oauth-client-mint] refused: sub=%s not an admin', user.id);
    return json(res, 403, { error: 'not_an_admin', detail: 'This account may not mint OAuth clients.' });
  }

  // 2. What to mint.
  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const client_name = String(body.client_name || '').trim().slice(0, 200);
  const redirect_uris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.map((u) => String(u || '').trim()).filter(Boolean)
    : [];
  if (!client_name) return json(res, 400, { error: 'invalid_request', detail: 'client_name required' });
  if (!redirect_uris.length || redirect_uris.length > MAX_REDIRECTS) {
    return json(res, 400, { error: 'invalid_request', detail: `1 to ${MAX_REDIRECTS} redirect_uris required` });
  }
  for (const u of redirect_uris) {
    // https, no query or fragment; one whole-segment "*" allowed in the path
    // (never the host) — the GPT builder's callback id changes on every save.
    if (!validRedirectPattern(u)) {
      return json(res, 400, { error: 'invalid_request', detail: `redirect_uri must be an https URL without query or fragment, with at most one wildcard path segment: ${u}` });
    }
  }
  if (new Set(redirect_uris).size !== redirect_uris.length) return json(res, 400, { error: 'invalid_request', detail: 'duplicate redirect_uri' });

  // 3. Mint. The secret is returned once and exists nowhere else.
  const minted = mintConfidentialClient({ client_name, redirect_uris }, oauthSecret);
  console.log('[oauth-client-mint] minted by sub=%s name=%j hosts=%j',
    user.id, client_name, redirect_uris.map((u) => new URL(u).host));
  return json(res, 200, {
    client_id: minted.client_id,
    client_secret: minted.client_secret,
    client_name,
    redirect_uris,
    minted_at: new Date().toISOString(),
  });
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
