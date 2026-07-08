// Shared OAuth token helpers — single source of truth for signing and
// verifying the four token kinds we hand out in the OAuth flow:
//
//   client    — stateless dynamic-client-registration credential. Payload
//               carries the registered redirect_uris + client name, signed
//               with our server secret so we don't need a clients table.
//   code      — authorization code returned to the OAuth client after user
//               consent. Carries user_id, the PKCE S256 code_challenge, the
//               redirect_uri the client used, and the resource. Short TTL.
//   access    — bearer token the OAuth client presents to /api/mcp.
//               Carries user_id (sub) and the resource (aud).
//   refresh   — long-lived; trades for a new access token.
//
// All four are HS256 JWTs signed with MCP_OAUTH_SECRET. No DB rows are
// kept for any of them — verification is purely signature + exp + typ.
// (One-time-use enforcement on codes would need a small denylist; we
// rely on PKCE binding + the 60-second TTL for now.)

import { createHmac, createHash, randomBytes } from 'node:crypto';

const ALG = 'HS256';

function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

// Sign a JWT with the given payload + TTL (seconds). Returns the compact
// serialization "header.payload.signature".
//
// `jwtType` becomes the JOSE header `typ` value. RFC 9068 reserves
// `at+jwt` specifically for OAuth 2.0 JWT-profile access tokens, and
// strict OAuth clients (including claude.ai's connector library) reject
// access tokens that don't carry that header. Callers should pass
// 'at+jwt' for access tokens and leave the default 'JWT' for everything
// else (auth codes, refresh tokens, client registrations).
export function signJwt(payload, secret, expiresInSec, jwtType = 'JWT') {
  if (!secret) throw new Error('signJwt: secret is required');
  const now = Math.floor(Date.now() / 1000);
  const full = {
    iat: now,
    exp: now + expiresInSec,
    jti: randomBytes(8).toString('base64url'),
    ...payload,
  };
  const data = `${b64({ alg: ALG, typ: jwtType })}.${b64(full)}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

// Verify a JWT; returns the payload on success, null on any failure
// (bad shape, bad signature, expired). Caller should check `typ`.
export function verifyJwt(token, secret) {
  if (typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  // Constant-time compare via Buffer length + ===; tokens that mismatch
  // length fail length check first so the === branch never sees attacker
  // strings of varying length.
  if (s.length !== expected.length || s !== expected) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); }
  catch { return null; }
  if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// PKCE: verifier → S256 challenge (base64url(sha256(verifier))).
export function pkceS256(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

// Constant-time string compare for short secrets / challenges.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Helper used by every endpoint that needs the secret — single source of
// the env-var read so a missing/wrong name fails the same way everywhere.
//
// ⚠️ MCP_OAUTH_SECRET is LOAD-BEARING for every connected AI client.
// Access AND refresh tokens are stateless JWTs signed with this secret —
// rotating it instantly and silently invalidates every connector token
// (claude.ai, ChatGPT, Gemini, Grok, mobile included). Clients then sit
// dead until each is manually re-authenticated; there is no server-side
// signal that this happened. Rotate ONLY on suspected compromise, and treat
// "reconnect every client" as part of the rotation checklist. (Same failure
// class that silently killed the FileSaver agent after the 06-14 rotation.)
export function getOauthSecret() {
  const s = process.env.MCP_OAUTH_SECRET;
  if (!s || s.length < 32) {
    throw new Error('MCP_OAUTH_SECRET is missing or too short (need ≥32 chars)');
  }
  return s;
}
