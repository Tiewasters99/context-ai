// Shared csp_* connector-token auth for REST endpoints that the Chrome
// extension (and similar non-MCP clients) call. Mirrors path A in
// api/mcp.mjs's authenticate() so the extension uses the same token
// format the user already understands from the Claude Desktop setup.
//
// Returns the authenticated user_id. Throws AuthError on any failure;
// the caller is responsible for serializing the error into a 401.

import { createClient } from '@supabase/supabase-js';
import { createHash, createHmac } from 'node:crypto';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

export class AuthError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export async function authenticateConnectorToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization;
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
    throw new AuthError(401, 'missing_bearer');
  }
  const token = auth.slice(7).trim();
  if (!/^csp_[A-Za-z0-9_-]{16,}$/.test(token)) {
    throw new AuthError(401, 'malformed_token');
  }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new AuthError(500, 'config_error');
  }
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const { data, error } = await admin
    .from('connector_tokens')
    .select('id, user_id, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (error) throw new AuthError(500, 'auth_db_error');
  if (!data) throw new AuthError(401, 'invalid_token');
  if (data.revoked_at) throw new AuthError(401, 'revoked');
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    throw new AuthError(401, 'expired');
  }

  // Fire-and-forget last_used_at update — don't block the request.
  admin
    .from('connector_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {})
    .catch(() => {});

  return data.user_id;
}

// Service-role client for operations that intentionally bypass RLS
// (looking up encrypted connection tokens, etc.). Don't reach for this
// when a user-scoped query would do.
export function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Build a per-request Supabase client that PostgREST sees AS the user.
// Mirrors api/mcp.mjs's pattern: we sign a short-lived Supabase JWT for
// the user_id we already authenticated via the connector token, and
// hand that to a client backed by the anon key. RLS now does the
// matterspace / document filtering naturally — same way the in-app
// browser client (and the MCP server) works.
export function userScopedClient(userId) {
  if (!JWT_SECRET) throw new Error('SUPABASE_JWT_SECRET not configured');
  if (!SUPABASE_ANON_KEY) throw new Error('VITE_SUPABASE_ANON_KEY not configured');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userId,
    role: 'authenticated',
    aud: 'authenticated',
    iss: 'supabase',
    iat: now,
    exp: now + 3600, // 1 hour; one request finishes well inside this
  };
  const jwt = signHS256(JWT_SECRET, payload);
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function signHS256(secret, payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${b64(header)}.${b64(payload)}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function corsHeaders(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
}

export function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}

export function handleAuthError(res, err) {
  if (err instanceof AuthError) {
    return json(res, err.status, { error: err.code });
  }
  return json(res, 500, { error: err.message || 'internal_error' });
}
