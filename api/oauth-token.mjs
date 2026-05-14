// OAuth token endpoint — exchanges an authorization code for tokens, or a
// refresh_token for a fresh access_token.
//
// Public PKCE client: no client_secret. Validation = JWT signature on the
// code + PKCE verifier match. The code's payload binds the redirect_uri and
// client_id; the client must supply the same values that were used at
// /authorize.

import { signJwt, verifyJwt, pkceS256, safeEqual, getOauthSecret } from '../lib/oauth-jwt.mjs';

const ACCESS_TTL_SEC = 60 * 60;        // 1 hour
const REFRESH_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  let secret;
  try { secret = getOauthSecret(); }
  catch (e) { return json(res, 500, { error: 'config_error', detail: e.message }); }

  // Body may arrive as JSON or as application/x-www-form-urlencoded.
  let body = {};
  if (typeof req.body === 'string') {
    const t = (req.headers['content-type'] || '').toString();
    if (t.includes('application/json')) body = safeJson(req.body);
    else body = Object.fromEntries(new URLSearchParams(req.body));
  } else if (req.body && typeof req.body === 'object') {
    body = req.body;
  }

  const grant = body.grant_type;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = (req.headers['x-forwarded-proto'] || 'https').toString();
  const resource = `${proto}://${host}/api/mcp`;

  if (grant === 'authorization_code') {
    const { code, code_verifier, redirect_uri, client_id } = body;
    if (!code || !code_verifier || !redirect_uri || !client_id) {
      return json(res, 400, { error: 'invalid_request', error_description: 'code, code_verifier, redirect_uri, client_id required' });
    }
    const codePayload = verifyJwt(code, secret);
    if (!codePayload || codePayload.typ !== 'code') return json(res, 400, { error: 'invalid_grant', error_description: 'bad or expired code' });
    if (codePayload.redirect_uri !== redirect_uri) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    if (codePayload.client_id !== client_id) return json(res, 400, { error: 'invalid_grant', error_description: 'client_id mismatch' });
    // PKCE: verifier hashed with S256 must equal the stored code_challenge.
    const computed = pkceS256(code_verifier);
    if (!safeEqual(computed, codePayload.code_challenge)) {
      return json(res, 400, { error: 'invalid_grant', error_description: 'pkce mismatch' });
    }

    return issueTokens(res, secret, codePayload.sub, client_id, codePayload.scope || 'mcp', resource);
  }

  if (grant === 'refresh_token') {
    const { refresh_token, client_id } = body;
    if (!refresh_token || !client_id) {
      return json(res, 400, { error: 'invalid_request', error_description: 'refresh_token and client_id required' });
    }
    const rPayload = verifyJwt(refresh_token, secret);
    if (!rPayload || rPayload.typ !== 'refresh') return json(res, 400, { error: 'invalid_grant', error_description: 'bad or expired refresh_token' });
    if (rPayload.client_id !== client_id) return json(res, 400, { error: 'invalid_grant', error_description: 'client_id mismatch' });

    return issueTokens(res, secret, rPayload.sub, client_id, rPayload.scope || 'mcp', resource);
  }

  return json(res, 400, { error: 'unsupported_grant_type' });
}

function issueTokens(res, secret, user_id, client_id, scope, resource) {
  const access_token = signJwt(
    { typ: 'access', sub: user_id, aud: resource, scope },
    secret,
    ACCESS_TTL_SEC,
  );
  const refresh_token = signJwt(
    { typ: 'refresh', sub: user_id, client_id, scope },
    secret,
    REFRESH_TTL_SEC,
  );
  return json(res, 200, {
    access_token,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SEC,
    refresh_token,
    scope,
  });
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  return res.end(JSON.stringify(obj));
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
