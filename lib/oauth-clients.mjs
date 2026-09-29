// OAuth clients — the two kinds we know, and the one place their rules live.
//
//   public        — dynamic registration (RFC 7591) by claude.ai / ChatGPT's
//                   connector UI; PKCE S256, no secret. Minted by
//                   /api/oauth-register. Unchanged.
//   confidential  — a client we mint ourselves, for a host that authenticates
//                   with client_id + client_secret and sends no PKCE: a Custom
//                   GPT's Actions (docs/specs/GPT-ACTIONS-2026-09-29.md).
//                   Minted by scripts/register-oauth-client.mjs; the secret is
//                   shown once and only its hash travels in the client_id.
//
// Both are stateless: the client_id IS the registration, a JWT signed with
// MCP_OAUTH_SECRET (typ 'client'). A confidential client's payload adds
// { confidential: true, secret_hash, token_endpoint_auth_method:
// 'client_secret_post' }. Rotating MCP_OAUTH_SECRET retires every client of
// both kinds, as before.

import { createHash, randomBytes } from 'node:crypto';
import { signJwt, safeEqual } from './oauth-jwt.mjs';

const CLIENT_TTL_SEC = 60 * 60 * 24 * 365 * 10;   // as /api/oauth-register

/** sha256 hex of a client secret; the only form of it a client_id carries. */
export function clientSecretHash(secret) {
  return createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

/** A fresh client secret: 32 random bytes, base64url ("csps_" prefix so it is recognisable in a paste). */
export function newClientSecret() {
  return 'csps_' + randomBytes(32).toString('base64url');
}

/**
 * Mint a confidential client. Returns { client_id, client_secret }; the
 * secret is not recoverable afterwards (only its hash is in the id).
 */
export function mintConfidentialClient({ client_name, redirect_uris }, oauthSecret) {
  if (!Array.isArray(redirect_uris) || !redirect_uris.length) throw new Error('redirect_uris required');
  for (const u of redirect_uris) {
    if (typeof u !== 'string' || !/^https:\/\//.test(u)) throw new Error(`redirect_uri must be https: ${u}`);
  }
  const client_secret = newClientSecret();
  const client_id = signJwt(
    {
      typ: 'client',
      confidential: true,
      redirect_uris,
      client_name: String(client_name || 'confidential client').slice(0, 200),
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'client_secret_post',
      secret_hash: clientSecretHash(client_secret),
    },
    oauthSecret,
    CLIENT_TTL_SEC,
  );
  return { client_id, client_secret };
}

/** True when a verified client payload is a confidential client. */
export function isConfidentialClient(client) {
  return !!(client && client.typ === 'client' && client.confidential === true && typeof client.secret_hash === 'string');
}

/**
 * The client secret a token request carries: the POST body's client_secret,
 * or HTTP Basic (client_secret_basic — client_id:client_secret, url-encoded
 * per RFC 6749 §2.3.1). Null when neither is present.
 */
export function presentedClientSecret(body, headers) {
  if (body && typeof body.client_secret === 'string' && body.client_secret) return body.client_secret;
  const auth = headers && (headers.authorization || headers.Authorization);
  if (typeof auth === 'string' && /^basic /i.test(auth)) {
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i > 0) return decodeURIComponent(decoded.slice(i + 1));
    } catch { /* not basic */ }
  }
  return null;
}

/** Whether `presented` is this confidential client's secret (constant-time on the hashes). */
export function clientSecretMatches(client, presented) {
  if (!isConfidentialClient(client) || typeof presented !== 'string' || !presented) return false;
  return safeEqual(clientSecretHash(presented), client.secret_hash);
}
