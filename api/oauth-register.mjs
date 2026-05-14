// OAuth Dynamic Client Registration (RFC 7591).
//
// claude.ai's Custom Connector flow POSTs here before the user reaches
// /authorize. We don't keep a clients table — instead we encode the
// registered redirect_uris + client metadata into the client_id itself
// as a signed JWT (typ:"client"). Later, /authorize and /token verify
// that JWT and check that the redirect_uri the caller sent matches one
// of the registered URIs.
//
// Trade-off: client_ids never expire on our side (until the signing
// secret rotates). That's acceptable — the only way to "deauthorize"
// a client is to revoke the access tokens it holds (refresh tokens'
// signatures invalidate when the secret rotates).

import { signJwt, getOauthSecret } from '../lib/oauth-jwt.mjs';

const MAX_REDIRECT_URIS = 10;
const ALLOWED_GRANT_TYPES = new Set(['authorization_code', 'refresh_token']);

export default async function handler(req, res) {
  // CORS
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }

  let secret;
  try { secret = getOauthSecret(); }
  catch (e) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'config_error', detail: e.message }));
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirectUris.length === 0) return json(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris required' });
  if (redirectUris.length > MAX_REDIRECT_URIS) return json(res, 400, { error: 'invalid_redirect_uri', error_description: `too many redirect_uris (max ${MAX_REDIRECT_URIS})` });
  for (const uri of redirectUris) {
    if (typeof uri !== 'string') return json(res, 400, { error: 'invalid_redirect_uri' });
    // Permissive — allow http for localhost (Claude Desktop) and https everywhere else.
    if (!/^(https:\/\/|http:\/\/localhost[:\/]|http:\/\/127\.0\.0\.1[:\/])/.test(uri)) {
      return json(res, 400, { error: 'invalid_redirect_uri', error_description: `non-https redirect_uri: ${uri}` });
    }
  }

  const grantTypes = Array.isArray(body.grant_types) && body.grant_types.length
    ? body.grant_types.filter((g) => ALLOWED_GRANT_TYPES.has(g))
    : ['authorization_code', 'refresh_token'];
  if (grantTypes.length === 0) return json(res, 400, { error: 'invalid_client_metadata', error_description: 'no supported grant_types' });

  const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : 'unknown';
  const tokenAuthMethod = 'none'; // public client — PKCE-only

  // The client_id IS the registration record, signed. No DB write.
  const client_id = signJwt(
    {
      typ: 'client',
      redirect_uris: redirectUris,
      client_name: clientName,
      grant_types: grantTypes,
      token_endpoint_auth_method: tokenAuthMethod,
    },
    secret,
    // Effectively forever for registration purposes — 10 years. Rotation
    // of MCP_OAUTH_SECRET invalidates all clients, which is the intended
    // kill-switch.
    60 * 60 * 24 * 365 * 10,
  );

  return json(res, 201, {
    client_id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    token_endpoint_auth_method: tokenAuthMethod,
    client_name: clientName,
    // No client_secret — we're public PKCE-only.
  });
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
