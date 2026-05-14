// Called by the OAuthAuthorize React page after the user clicks Approve.
//
// Inputs (POST body):
//   client_id, redirect_uri, code_challenge, code_challenge_method ('S256'),
//   state, resource, scope
// Plus Authorization: Bearer <supabase access_token> — proves the caller is
// the logged-in Contextspaces user. We verify it with SUPABASE_JWT_SECRET
// to extract the user_id (sub).
//
// Output: { redirect } — the full URL to redirect the user-agent to, with
// ?code=...&state=... appended. The browser then navigates there, which
// hands control back to the OAuth client (claude.ai).

import { signJwt, verifyJwt, getOauthSecret } from '../lib/oauth-jwt.mjs';

const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  if (!SUPABASE_JWT_SECRET) return json(res, 500, { error: 'config_error', detail: 'SUPABASE_JWT_SECRET unset' });

  let oauthSecret;
  try { oauthSecret = getOauthSecret(); }
  catch (e) { return json(res, 500, { error: 'config_error', detail: e.message }); }

  // 1. Caller is the logged-in user (Supabase JWT in Authorization).
  const auth = req.headers.authorization || req.headers.Authorization;
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
    return json(res, 401, { error: 'login_required', detail: 'missing bearer' });
  }
  const sbToken = auth.slice(7).trim();
  const sbPayload = verifyJwt(sbToken, SUPABASE_JWT_SECRET);
  if (!sbPayload || !sbPayload.sub) {
    return json(res, 401, { error: 'login_required', detail: 'invalid supabase token' });
  }
  const user_id = sbPayload.sub;

  // 2. Validate the OAuth params.
  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const { client_id, redirect_uri, code_challenge, code_challenge_method, state, resource, scope } = body;
  if (!client_id || !redirect_uri || !code_challenge) {
    return json(res, 400, { error: 'invalid_request', detail: 'client_id, redirect_uri, code_challenge required' });
  }
  if (code_challenge_method && code_challenge_method !== 'S256') {
    return json(res, 400, { error: 'invalid_request', detail: 'only S256 supported' });
  }
  // 3. Validate the client_id JWT signature + that redirect_uri matches registration.
  const client = verifyJwt(client_id, oauthSecret);
  if (!client || client.typ !== 'client' || !Array.isArray(client.redirect_uris)) {
    return json(res, 400, { error: 'invalid_client' });
  }
  if (!client.redirect_uris.includes(redirect_uri)) {
    return json(res, 400, { error: 'invalid_redirect_uri', detail: 'redirect_uri not in registration' });
  }

  // 4. Mint the authorization code. 60-second TTL.
  const code = signJwt(
    {
      typ: 'code',
      sub: user_id,
      client_id,           // bound to the same client
      redirect_uri,
      code_challenge,
      resource: resource || null,
      scope: scope || 'mcp',
    },
    oauthSecret,
    60,
  );

  // 5. Build the redirect URL.
  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);

  return json(res, 200, { redirect: url.toString() });
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
