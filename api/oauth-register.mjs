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

// Rate limit (2026-09-19, migration 063): this is the ONLY unauthenticated
// endpoint in the product, and every call mints a client_id that is valid
// until MCP_OAUTH_SECRET rotates. Anyone on the internet can POST it in a
// loop. So unlike every other handler — which allows the request when the
// meter cannot answer, because refusing a lawyer's work to protect a budget is
// the worse failure — this one FAILS CLOSED: if the limiter exists and cannot
// answer, the registration is refused.
//
// One carve-out, stated plainly: if the RPC is not deployed at all (migration
// 063 not yet pasted), refusing every registration would break connector
// sign-up with no security gained, so the per-instance limiter below holds the
// line until the migration lands. It is one serverless isolate's memory and
// therefore weak — it is a bridge, not the design.

import { signJwt, getOauthSecret } from '../lib/oauth-jwt.mjs';
import { consumeIpUsage, clientIp } from '../lib/usage-meter.mjs';

const MAX_REDIRECT_URIS = 10;
const ALLOWED_GRANT_TYPES = new Set(['authorization_code', 'refresh_token']);
// Registration metadata is a handful of URIs; anything larger is not a client.
const MAX_BODY_BYTES = 64 * 1024;

// The bridge limiter: per isolate, per IP, per hour.
const FALLBACK_MAX_PER_HOUR = 20;
const fallbackHits = new Map();
function fallbackAllows(ip) {
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = `${hour}:${ip}`;
  // The map only ever holds the current hour's keys.
  if (fallbackHits.size > 5000) fallbackHits.clear();
  for (const k of fallbackHits.keys()) {
    if (!k.startsWith(`${hour}:`)) fallbackHits.delete(k);
  }
  const n = (fallbackHits.get(key) || 0) + 1;
  fallbackHits.set(key, n);
  return n <= FALLBACK_MAX_PER_HOUR;
}

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

  const ip = clientIp(req);
  const limit = await consumeIpUsage({
    supabaseUrl: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    ip,
    kind: 'oauth_register',
  });
  if (limit.undeployed) {
    if (!fallbackAllows(ip)) {
      res.setHeader('retry-after', '3600');
      return json(res, 429, {
        error: 'too_many_requests',
        error_description: 'Too many registration requests from this address. Try again later.',
      });
    }
  } else if (!limit.allowed) {
    res.setHeader('retry-after', String(limit.retryAfterSeconds || 3600));
    return json(res, 429, {
      error: 'too_many_requests',
      error_description: limit.message || 'Too many registration requests from this address. Try again later.',
    });
  }

  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
  const bodyLimit = limit.maxRequestBytes || MAX_BODY_BYTES;
  if (Buffer.byteLength(rawBody, 'utf8') > bodyLimit) {
    return json(res, 413, { error: 'invalid_client_metadata', error_description: 'registration request too large' });
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
