// The bearer check every Contextspaces API shares.
//
// Moved out of api/mcp.mjs (2026-09-29, docs/specs/GPT-ACTIONS-2026-09-29.md
// §2) so the MCP endpoint and the GPT Actions facade (api/gpt/[op].mjs)
// resolve a bearer token, build the user-scoped Supabase client and shape the
// callTool options in ONE place and cannot drift. Nothing here changed in the
// move: the three token paths, the grant check (065), the agent link (087),
// the pause (099) and the task recipient (089) are exactly what api/mcp.mjs
// ran before.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// (connector_tokens lookups only), MCP_SIGNING_KEY_JWK_B64 + MCP_SIGNING_KEY_ID
// (the user JWT), MCP_OAUTH_SECRET (OAuth access tokens).

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

import { timeoutFetch } from './mcp-core.mjs';
import { agentRowRefusal, checkAccessGrant, readAgentTokenRow, touchAgentToken } from './oauth-grants.mjs';
import { connectorTokenIdentity } from './connector-token-auth.mjs';
import { verifyJwt } from './oauth-jwt.mjs';
import { signSupabaseUserJwt } from './supabase-user-jwt.mjs';

// Hard timeout on every Supabase call so a stalled query fails fast (with a
// retryable error) instead of hanging the request until the MCP client's
// own multi-minute timeout fires.
const sbFetch = timeoutFetch(15000, 'supabase query');

export const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
export const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;


// -----------------------------------------------------------------------------
// Supabase clients
// -----------------------------------------------------------------------------

// Used once per request to resolve the opaque bearer token to a user_id.
// Operates as service_role so it can read connector_tokens.token_hash.
export function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: sbFetch },
  });
}

// Per-request client scoped to the authenticated user. Queries run with
// this client hit Postgres as the user, so RLS policies on matterspaces,
// documents, and passages enforce correct scoping with no app-side logic.
export function userScopedClient(user_id) {
  const jwt = signSupabaseUserJwt(user_id);
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` }, fetch: sbFetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}


// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------
export class AuthError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// Returns the caller's identity:
//   { userId, kind: 'user' | 'agent', tokenId?, grantId?, matterScope?, provider?, name? }
// grantId (089) is set for a full-assistant OAuth sign-in: its oauth_grants row.
// Path A can answer kind 'agent' (migration 085). Paths B and C answer
// 'user' for a person's own full-access OAuth connection, and — since
// migration 087 — 'agent' for an OAuth connection made "as an agent" on the
// consent screen, with the SAME identity shape path A returns for that
// agent's connector_tokens row (see oauthIdentity below).
export async function authenticate(req) {
  const auth = req.headers.authorization || req.headers.Authorization;
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
    throw new AuthError(401, 'missing_bearer');
  }
  const token = auth.slice(7).trim();

  // Path A — the legacy connector token format (csp_* opaque, looked up
  // in connector_tokens). Cheap shape check so we can branch without a
  // database round-trip for clearly non-csp tokens.
  if (/^csp_[A-Za-z0-9_-]{16,}$/.test(token)) {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const admin = adminClient();
    const { data, error } = await admin
      .from('connector_tokens')
      // '*', not a column list: before migration 085 the kind/matter_scope
      // columns do not exist, and naming them would 42703 every token.
      .select('*')
      .eq('token_hash', tokenHash)
      .maybeSingle();
    if (error) throw new AuthError(500, 'auth_db_error');
    if (!data) throw new AuthError(401, 'invalid_token');
    if (data.revoked_at) throw new AuthError(401, 'revoked');
    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      throw new AuthError(401, 'expired');
    }
    admin
      .from('connector_tokens')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', data.id)
      .then(() => {}).catch(() => {});
    return connectorTokenIdentity(data);
  }

  // Path B — opaque-wrapped OAuth access token. Format: "cspa_" + base64url
  // of the compact JWT serialization. We unwrap to recover the JWT, then
  // verify with MCP_OAUTH_SECRET. Wrapping exists so OAuth clients that
  // try to introspect/verify JWT-shaped tokens client-side (claude.ai's
  // connector library does this) see an opaque string and pass it through
  // untouched.
  if (token.startsWith('cspa_')) {
    if (!process.env.MCP_OAUTH_SECRET) {
      console.warn('[mcp auth] opaque token presented but MCP_OAUTH_SECRET not set');
      throw new AuthError(401, 'invalid_token');
    }
    let inner;
    try {
      inner = Buffer.from(token.slice(5), 'base64url').toString('utf8');
    } catch {
      console.warn('[mcp auth] opaque token: base64url decode failed');
      throw new AuthError(401, 'invalid_token');
    }
    const payload = verifyJwt(inner, process.env.MCP_OAUTH_SECRET);
    if (payload && payload.typ === 'access' && payload.sub) {
      // Grant check (065) and agent link (087): see oauthIdentity below.
      return oauthIdentity(payload, 'opaque');
    }
    console.warn('[mcp auth] opaque reject:',
      payload ? { typ: payload.typ, hasSub: !!payload.sub, exp: payload.exp } : 'verify failed (sig/exp)');
    throw new AuthError(401, 'invalid_token');
  }

  // Path C — bare JWT access token. Kept for backwards compatibility with
  // any token issued before the opaque wrapper was introduced; new tokens
  // always arrive in the cspa_ envelope above.
  if (token.split('.').length === 3) {
    if (!process.env.MCP_OAUTH_SECRET) {
      console.warn('[mcp auth] JWT-shaped token presented but MCP_OAUTH_SECRET not set');
      throw new AuthError(401, 'invalid_token');
    }
    const payload = verifyJwt(token, process.env.MCP_OAUTH_SECRET);
    if (payload && payload.typ === 'access' && payload.sub) {
      // A bare JWT that names a grant is simply a cspa_ token with its
      // envelope taken off (anyone holding one can do that), so it gets the
      // same grant and agent checks. Since 099 so does a truly old one with
      // neither gid nor agt: it used to be served unchecked, which meant it
      // honoured neither the legacy cut-off nor "Disconnect everything".
      // checkAccessGrant's legacy branch now decides it, exactly as it does
      // a gid-less cspa_ token.
      return oauthIdentity(payload, 'bare');
    }
    console.warn('[mcp auth] oauth reject:',
      payload ? { typ: payload.typ, hasSub: !!payload.sub, exp: payload.exp } : 'verify failed (sig/exp)');
    throw new AuthError(401, 'invalid_token');
  }

  console.warn('[mcp auth] malformed token shape: prefix=%s dots=%d len=%d',
    token.slice(0, 6), token.split('.').length - 1, token.length);
  throw new AuthError(401, 'malformed_token');
}


// An OAuth access token's identity. Per-connection grants (migration 065):
// the token names the oauth_grants row it belongs to; if the user has
// revoked that row, this client is done — without touching any other client
// or any other customer. Cached ≤60s per instance for a full-access grant;
// fails CLOSED on revoked/missing, OPEN-with-log when the table is not
// deployed yet. A token with no `gid` predates 065; see lib/oauth-grants.mjs.
//
// Agent connections (migration 087): when the grant is linked to an agent
// (connector_tokens kind='agent'), the connection IS that agent. Its row is
// read fresh on every request, as path A reads a csp_ token's — so Edit
// matters and Revoke in Connections › Agents bite on the next request — and
// the identity is connectorTokenIdentity(row), the very shape path A returns.
// Scope enforcement, the task tools, metering per agent token and the ledger
// ref 'agent:<id>' therefore apply unchanged. Every failure here refuses; an
// agent is never served as the user.
async function oauthIdentity(payload, via) {
  const grant = await checkAccessGrant(payload);
  if (!grant.ok) {
    console.warn('[mcp auth] grant refused: sub=%s reason=%s', payload.sub, grant.reason);
    // RFC 6750 has no code for "the user revoked this"; invalid_token is
    // what an OAuth client keys its re-authorization on.
    throw new AuthError(401, 'invalid_token');
  }
  const agentTokenId = grant.agentTokenId || null;
  if (!agentTokenId) {
    console.log('[mcp auth] %s ok: sub=%s grant=%s', via, payload.sub, grant.reason);
    // 089: the grant id is this full assistant's task-board identity (and its
    // meter attribution, oauth:<grant id>). Absent on a token with no gid.
    const grantId = typeof grant.gid === 'string' && grant.gid ? grant.gid : null;
    return grantId ? { userId: payload.sub, kind: 'user', grantId } : { userId: payload.sub, kind: 'user' };
  }
  const { row, error } = await readAgentTokenRow(agentTokenId);
  if (error) {
    console.warn('[mcp auth] agent row unreadable, refused: sub=%s', payload.sub);
    throw new AuthError(401, 'invalid_token');
  }
  const why = agentRowRefusal(row, payload.sub);
  if (why) {
    console.warn('[mcp auth] oauth agent refused: sub=%s reason=%s', payload.sub, why);
    throw new AuthError(401, 'invalid_token');
  }
  touchAgentToken(row.id);
  console.log('[mcp auth] %s ok as agent: sub=%s agent=%s', via, payload.sub, row.id);
  return connectorTokenIdentity(row);
}

/** The spec's name for authenticate(): a bearer → the caller's identity. */
export const resolveBearer = authenticate;


// -----------------------------------------------------------------------------
// callTool options, per caller
// -----------------------------------------------------------------------------
// A user token (and every OAuth connection) gets the options it always got,
// plus — since 089 — `taskRecipient`, the token or grant a task can be
// assigned to, so the task-board tools answer to it. An agent token
// (migration 085) adds two things:
//   agentToken — { id, userId, matterScope }: lib/mcp-core.mjs confines every
//                tool to those matters and their sub-matters (never a sealed
//                one), and the task-board tools answer to it;
//   actor      — so every call it makes is recorded in the matter's Record as
//                this agent (connector_client_id = 'agent:<token id>').
export function callToolOptsFor(identity, keys = {}) {
  const opts = {
    openaiApiKey: keys.openaiApiKey,
    googleApiKey: keys.googleApiKey, // enables file_document OCR of scanned PDFs
    // The SecureSpace seal: this is an EXTERNAL connector — sealed
    // matters (tier B/C, inherited down the tree) are invisible here.
    sealConnector: true,
  };
  if (identity?.kind !== 'agent') {
    // 089: any connection can be handed a task. A full-access token (path A)
    // is its token; a full-assistant OAuth sign-in is its grant. Neither (a
    // pre-065 token) → no task identity, and the task tools say "no tasks".
    if (typeof identity?.tokenId === 'string' && identity.tokenId) {
      opts.taskRecipient = { kind: 'token', id: identity.tokenId, userId: identity.userId ?? null };
    } else if (typeof identity?.grantId === 'string' && identity.grantId) {
      opts.taskRecipient = { kind: 'grant', id: identity.grantId, userId: identity.userId ?? null };
    }
    return opts;
  }
  return {
    ...opts,
    agentToken: {
      id: identity.tokenId,
      userId: identity.userId,
      matterScope: Array.isArray(identity.matterScope) ? identity.matterScope : [],
      // 088: every matter the user can open, except SecureSpaces.
      scopeAll: identity.scopeAll === true,
    },
    actor: {
      kind: 'connector',
      ref: `agent:${identity.tokenId}`,
      user_id: identity.userId,
      label: identity.name || `agent (${identity.provider || 'other'})`,
    },
  };
}
