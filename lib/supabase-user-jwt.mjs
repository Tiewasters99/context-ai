// Signs short-lived Supabase user JWTs for RLS-scoped, server-side access.
//
// Background: the MCP server and the connector-token REST endpoints need to
// query Supabase *as* a specific user so Postgres RLS enforces matter
// isolation. We do that by minting a short-lived Supabase access token for
// the user_id we've already authenticated, and handing it to a Supabase
// client as the Authorization bearer.
//
// We sign with ES256 using our own EC P-256 key, whose public half is
// registered with Supabase as a JWT signing key (so Supabase verifies our
// tokens via its JWKS). This replaces the previous HS256 self-signing with
// the project's shared "legacy JWT secret" — that secret can be forged by
// anyone who holds it, so we moved to an asymmetric key we control and can
// rotate independently.
//
// Env:
//   MCP_SIGNING_KEY_JWK_B64   base64 of the EC P-256 private key in JWK JSON
//   MCP_SIGNING_KEY_ID        the kid Supabase assigned the imported key

import { createPrivateKey, sign as cryptoSign } from 'node:crypto';

const KID = process.env.MCP_SIGNING_KEY_ID;
const JWK_B64 = process.env.MCP_SIGNING_KEY_JWK_B64;

let cachedKey = null;
function signingKey() {
  if (cachedKey) return cachedKey;
  if (!JWK_B64) throw new Error('MCP_SIGNING_KEY_JWK_B64 not configured');
  if (!KID) throw new Error('MCP_SIGNING_KEY_ID not configured');
  const jwk = JSON.parse(Buffer.from(JWK_B64, 'base64').toString('utf8'));
  cachedKey = createPrivateKey({ key: jwk, format: 'jwk' });
  return cachedKey;
}

// True when the env is wired for ES256 signing — lets callers fail loudly
// with a clear message instead of throwing deep inside a request.
export function userJwtConfigured() {
  return Boolean(JWK_B64 && KID);
}

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function signSupabaseUserJwt(user_id) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user_id,
    role: 'authenticated',
    aud: 'authenticated',
    iss: 'supabase',
    iat: now,
    exp: now + 3600, // 1 hour; a single request finishes well inside this
  };
  const header = { alg: 'ES256', typ: 'JWT', kid: KID };
  const data = `${b64url(header)}.${b64url(payload)}`;
  // ieee-p1363 gives the raw r||s signature JWT/JOSE expects (not DER).
  const sig = cryptoSign('sha256', Buffer.from(data), {
    key: signingKey(),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${data}.${sig}`;
}
