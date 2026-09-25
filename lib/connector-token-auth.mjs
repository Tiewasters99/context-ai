// Shared csp_* connector-token auth for REST endpoints that the Chrome
// extension (and similar non-MCP clients) call. Mirrors path A in
// api/mcp.mjs's authenticate() so the extension uses the same token
// format the user already understands from the Claude Desktop setup.
//
// Returns the authenticated user_id. Throws AuthError on any failure;
// the caller is responsible for serializing the error into a 401.

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

import { signSupabaseUserJwt, userJwtConfigured } from './supabase-user-jwt.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export class AuthError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Token KIND (migration 085)
// ---------------------------------------------------------------------------
// A connector token is either a USER token (every token issued before 085:
// full access, as the user) or an AGENT token (sees only the matters in
// matter_scope and their sub-matters; '{}' = nothing). The row is read with
// `select('*')` by both callers, deliberately: on a database where 085 has not
// been applied the columns do not exist, a select that named them would answer
// 42703 and every existing token would stop working. With `*`, an absent
// `kind` simply means a pre-085 row, which is always a user token — exact,
// not a guess, because no agent row can exist before the column does.
//
// Fails CLOSED on anything unexpected: a kind that is neither absent nor
// 'user' is treated as an agent, and an agent with no readable scope has an
// empty one.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function connectorTokenIdentity(row) {
  const isUser = row?.kind === undefined || row?.kind === null || row?.kind === 'user';
  if (isUser) {
    return { tokenId: row.id, userId: row.user_id, kind: 'user', matterScope: null, provider: null, name: row.name ?? null };
  }
  const scope = Array.isArray(row.matter_scope)
    ? [...new Set(row.matter_scope.filter((id) => typeof id === 'string' && UUID_RE.test(id)))]
    : [];
  return {
    tokenId: row.id,
    userId: row.user_id,
    kind: 'agent',
    matterScope: scope,
    // Migration 088: "All my matters (except SecureSpaces)". Strictly true;
    // anything else (absent before 088, null, a string) is a listed scope.
    scopeAll: row.scope_all === true,
    provider: typeof row.agent_provider === 'string' ? row.agent_provider : null,
    name: row.name ?? null,
  };
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
    .select('*')   // not a column list: see connectorTokenIdentity above
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (error) throw new AuthError(500, 'auth_db_error');
  if (!data) throw new AuthError(401, 'invalid_token');
  if (data.revoked_at) throw new AuthError(401, 'revoked');
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    throw new AuthError(401, 'expired');
  }
  // These endpoints (the Chrome extension's) run as the user with full
  // access and know nothing of an agent's matter scope. An agent token is
  // for /api/mcp only, where the scope is enforced; here it is refused
  // outright rather than silently widened to everything.
  if (connectorTokenIdentity(data).kind === 'agent') {
    throw new AuthError(403, 'agent_token_not_allowed');
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
  if (!userJwtConfigured()) throw new Error('MCP signing key not configured');
  if (!SUPABASE_ANON_KEY) throw new Error('VITE_SUPABASE_ANON_KEY not configured');
  const jwt = signSupabaseUserJwt(userId);
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
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
