// OAuth token endpoint — exchanges an authorization code for tokens, or a
// refresh_token for a fresh access_token.
//
// Public PKCE client: no client_secret. Validation = JWT signature on the
// code + PKCE verifier match. The code's payload binds the redirect_uri and
// client_id; the client must supply the same values that were used at
// /authorize.

import { signJwt, verifyJwt, pkceS256, safeEqual, getOauthSecret } from '../lib/oauth-jwt.mjs';

// Access tokens live 12 hours: long enough that a full trial-prep day never
// mid-session refreshes (each refresh is a chance for a mobile client to
// fumble and strand the connector), short enough that a stolen token ages out
// same-day. Refresh stays 30 days. Revocation story is unchanged either way —
// these are stateless JWTs, so revocation = rotate MCP_OAUTH_SECRET (which
// logs every client out; see lib/oauth-jwt.mjs).
const ACCESS_TTL_SEC = 60 * 60 * 12;       // 12 hours
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
  // Issuer = the origin of this deployment. Must match `issuer` in the
  // authorization-server metadata document; OAuth 2.1 clients (claude.ai's
  // Custom Connector among them) cross-check `iss` against AS metadata
  // before trusting the access token.
  const issuer = `${proto}://${host}`;

  // Coarse diagnostic — surfaces every token-exchange attempt in the function
  // log with the shape of what the client sent. Doesn't log secret material
  // (only the presence + length of fields).
  console.log('[oauth-token] grant=%s contentType=%s keys=%j',
    grant, req.headers['content-type'], Object.keys(body || {}));

  if (grant === 'authorization_code') {
    const { code, code_verifier, redirect_uri, client_id } = body;
    if (!code || !code_verifier || !redirect_uri || !client_id) {
      console.warn('[oauth-token] missing field(s):',
        { hasCode: !!code, hasVerifier: !!code_verifier, hasRedirect: !!redirect_uri, hasClient: !!client_id });
      return json(res, 400, { error: 'invalid_request', error_description: 'code, code_verifier, redirect_uri, client_id required' });
    }
    const codePayload = verifyJwt(code, secret);
    if (!codePayload || codePayload.typ !== 'code') {
      console.warn('[oauth-token] bad/expired code (payload=%j)', codePayload && { typ: codePayload.typ, exp: codePayload.exp });
      return json(res, 400, { error: 'invalid_grant', error_description: 'bad or expired code' });
    }
    if (codePayload.redirect_uri !== redirect_uri) {
      console.warn('[oauth-token] redirect_uri mismatch: code=%j supplied=%j', codePayload.redirect_uri, redirect_uri);
      return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    }
    if (codePayload.client_id !== client_id) {
      console.warn('[oauth-token] client_id mismatch: codeLen=%d suppliedLen=%d codePrefix=%s suppliedPrefix=%s',
        codePayload.client_id?.length, client_id?.length,
        (codePayload.client_id || '').slice(0, 24), (client_id || '').slice(0, 24));
      return json(res, 400, { error: 'invalid_grant', error_description: 'client_id mismatch' });
    }
    // PKCE: verifier hashed with S256 must equal the stored code_challenge.
    const computed = pkceS256(code_verifier);
    if (!safeEqual(computed, codePayload.code_challenge)) {
      console.warn('[oauth-token] pkce mismatch: computedLen=%d storedLen=%d',
        computed.length, codePayload.code_challenge?.length);
      return json(res, 400, { error: 'invalid_grant', error_description: 'pkce mismatch' });
    }

    console.log('[oauth-token] success: sub=%s', codePayload.sub);
    return issueTokens(res, secret, codePayload.sub, client_id, codePayload.scope || 'mcp', resource, issuer);
  }

  if (grant === 'refresh_token') {
    const { refresh_token, client_id } = body;
    if (!refresh_token || !client_id) {
      console.warn('[oauth-token] refresh missing field(s)');
      return json(res, 400, { error: 'invalid_request', error_description: 'refresh_token and client_id required' });
    }
    const rPayload = verifyJwt(refresh_token, secret);
    if (!rPayload || rPayload.typ !== 'refresh') {
      console.warn('[oauth-token] bad/expired refresh');
      return json(res, 400, { error: 'invalid_grant', error_description: 'bad or expired refresh_token' });
    }
    if (rPayload.client_id !== client_id) {
      console.warn('[oauth-token] refresh client_id mismatch');
      return json(res, 400, { error: 'invalid_grant', error_description: 'client_id mismatch' });
    }

    console.log('[oauth-token] refresh success: sub=%s', rPayload.sub);
    return issueTokens(res, secret, rPayload.sub, client_id, rPayload.scope || 'mcp', resource, issuer);
  }

  console.warn('[oauth-token] unsupported grant_type=%s', grant);
  return json(res, 400, { error: 'unsupported_grant_type' });
}

// Build-time marker so we can confirm in production logs which version
// of this file is actually serving traffic. Bump this string whenever
// you change token shape so a stale Vercel deploy is obvious at a glance.
const TOKEN_BUILD = '2026-07-08-ttl12h';

function issueTokens(res, secret, user_id, client_id, scope, resource, issuer) {
  // Internally we sign a normal JWT carrying everything we need to
  // verify the request at /api/mcp (iss/sub/aud/client_id/scope/exp).
  // The JOSE header still uses at+jwt per RFC 9068 in case any client
  // unwraps far enough to look.
  const inner = signJwt(
    {
      iss: issuer,
      typ: 'access',
      sub: user_id,
      aud: resource,
      client_id,
      scope,
    },
    secret,
    ACCESS_TTL_SEC,
    'at+jwt',
  );

  // Externally we wrap the JWT in a `cspa_` envelope (base64url over
  // the compact JWT serialization). Why: RFC 6749 §1.4 says access
  // tokens are opaque to the OAuth client — the client should just
  // present them, not introspect them. claude.ai's connector library
  // doesn't honor that: if a token has the three-dot JWT shape it tries
  // to decode and verify the signature client-side. Since we sign with
  // HS256 (a shared secret) there is no public key it can fetch, so
  // verification fails and the connector aborts before ever calling
  // /api/mcp. That matches the observed symptom: token endpoint 200,
  // zero subsequent MCP calls. Wrapping kills the three-dot shape, so
  // the client treats the token as opaque and forwards it unchanged;
  // our resource server unwraps and verifies as before.
  const access_token = 'cspa_' + Buffer.from(inner, 'utf8').toString('base64url');

  // Refresh tokens are kept as raw JWTs — they're only ever submitted
  // back to /api/oauth-token, which knows how to verify them, and
  // claude.ai shouldn't be introspecting refresh tokens.
  const refresh_token = signJwt(
    { iss: issuer, typ: 'refresh', sub: user_id, client_id, scope },
    secret,
    REFRESH_TTL_SEC,
  );

  console.log('[oauth-token] issued: build=%s sub=%s atLen=%d', TOKEN_BUILD, user_id, access_token.length);

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
