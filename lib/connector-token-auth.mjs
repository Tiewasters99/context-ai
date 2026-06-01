// Shared csp_* connector-token auth for REST endpoints that the Chrome
// extension (and similar non-MCP clients) call. Mirrors path A in
// api/mcp.mjs's authenticate() so the extension uses the same token
// format the user already understands from the Claude Desktop setup.
//
// Returns the authenticated user_id. Throws AuthError on any failure;
// the caller is responsible for serializing the error into a 401.

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

// Build a Supabase client scoped to a specific user via service role.
// REST endpoints need this to query connections / documents on behalf
// of the user without going through RLS (which would require a user JWT).
// Since we've already authenticated the bearer token, calls are gated
// at the application level by the user_id we filter on.
export function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
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
