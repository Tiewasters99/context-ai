// Contextspaces hosted MCP endpoint.
//
// Deployed as a Vercel Serverless Function. External MCP clients (Claude
// Desktop, Claude for Chrome, and — once Phase 2 adds OAuth — claude.ai
// Custom Connectors) connect here via Streamable HTTP.
//
// Auth: Bearer token in the Authorization header. The token is a
// customer-generated opaque string (csp_*) issued by Contextspaces. The
// handler looks it up in public.connector_tokens (migration 003), derives
// the owning user_id, and then constructs a user-scoped Supabase client
// by signing a short-lived Supabase JWT. All retrieval queries run
// through that client, so Postgres RLS (migration 002) enforces matter
// isolation across customers — customer A cannot see customer B's
// matters at the database level.
//
// Env required on Vercel:
//   VITE_SUPABASE_URL             (same project as the web app)
//   VITE_SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY     (only used to look up connector_tokens)
//   MCP_SIGNING_KEY_JWK_B64       (EC P-256 key, base64 JWK; signs user JWTs)
//   MCP_SIGNING_KEY_ID            (kid of that key, registered with Supabase)
//   OPENAI_API_KEY                (only used by the search tool)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

import { TOOLS, callTool, timeoutFetch } from '../lib/mcp-core.mjs';
import { verifyJwt } from '../lib/oauth-jwt.mjs';
import { signSupabaseUserJwt, userJwtConfigured } from '../lib/supabase-user-jwt.mjs';

// Hard timeout on every Supabase call so a stalled query fails fast (with a
// retryable error) instead of hanging the request until the MCP client's
// own multi-minute timeout fires.
const sbFetch = timeoutFetch(15000, 'supabase query');


// -----------------------------------------------------------------------------
// Env
// -----------------------------------------------------------------------------
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;


// -----------------------------------------------------------------------------
// Supabase clients
// -----------------------------------------------------------------------------

// Used once per request to resolve the opaque bearer token to a user_id.
// Operates as service_role so it can read connector_tokens.token_hash.
function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: sbFetch },
  });
}

// Per-request client scoped to the authenticated user. Queries run with
// this client hit Postgres as the user, so RLS policies on matterspaces,
// documents, and passages enforce correct scoping with no app-side logic.
function userScopedClient(user_id) {
  const jwt = signSupabaseUserJwt(user_id);
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` }, fetch: sbFetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}


// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------
class AuthError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function authenticate(req) {
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
      .select('id, user_id, expires_at, revoked_at')
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
    return data.user_id;
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
      console.log('[mcp auth] opaque ok: sub=%s', payload.sub);
      return payload.sub;
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
      console.log('[mcp auth] oauth ok: sub=%s', payload.sub);
      return payload.sub;
    }
    console.warn('[mcp auth] oauth reject:',
      payload ? { typ: payload.typ, hasSub: !!payload.sub, exp: payload.exp } : 'verify failed (sig/exp)');
    throw new AuthError(401, 'invalid_token');
  }

  console.warn('[mcp auth] malformed token shape: prefix=%s dots=%d len=%d',
    token.slice(0, 6), token.split('.').length - 1, token.length);
  throw new AuthError(401, 'malformed_token');
}


// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------
export default async function handler(req, res) {
  // Permissive CORS — Claude Desktop and MCP clients call from varied origins.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader(
    'access-control-allow-headers',
    'content-type, authorization, mcp-session-id, mcp-protocol-version'
  );
  res.setHeader(
    'access-control-allow-methods',
    'POST, DELETE, OPTIONS'
  );
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  // MCP Streamable HTTP: a GET opens the optional long-lived "standalone
  // SSE" push stream, which a serverless function cannot hold open — clients
  // that open one watch it die, retry, and then poison the whole connection
  // (Antigravity/Gemini, 2026-07-22). Per spec, refuse with 405 so clients
  // fall back to POST-only operation.
  if (req.method === 'GET') {
    res.statusCode = 405;
    res.setHeader('allow', 'POST, DELETE, OPTIONS');
    return res.end();
  }

  // Config sanity — fail loudly if the deploy env is incomplete.
  const missing = [];
  if (!SUPABASE_URL) missing.push('VITE_SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) missing.push('VITE_SUPABASE_ANON_KEY');
  if (!SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!userJwtConfigured()) missing.push('MCP_SIGNING_KEY_JWK_B64 + MCP_SIGNING_KEY_ID');
  if (missing.length) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    return res.end(
      JSON.stringify({ error: 'config_error', missing_env: missing })
    );
  }

  try {
    const user_id = await authenticate(req);
    const sb = userScopedClient(user_id);

    const server = new Server(
      { name: 'contextspaces-retrieval', version: '0.2.0' },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;
      try {
        const result = await callTool(sb, name, args, {
          openaiApiKey: OPENAI_API_KEY,
          googleApiKey: process.env.GOOGLE_API_KEY, // enables file_document OCR of scanned PDFs
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `ERROR: ${err.message || String(err)}` },
          ],
          isError: true,
        };
      }
    });

    // Stateless: one transport per request. For Phase 1 this is simpler
    // than session management. Re-evaluate if long-running resumable
    // streams become necessary.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (err instanceof AuthError) {
      res.statusCode = err.status;
      // RFC 9728 / MCP spec: on 401, advertise where the protected-resource
      // metadata lives so OAuth-capable clients (claude.ai's custom connector
      // UI) can discover the flow without out-of-band configuration.
      if (err.status === 401) {
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const proto = (req.headers['x-forwarded-proto'] || 'https').toString();
        res.setHeader(
          'www-authenticate',
          `Bearer realm="mcp", error="${err.code}", resource_metadata="${proto}://${host}/.well-known/oauth-protected-resource"`,
        );
      }
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ error: err.code }));
    }
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    return res.end(
      JSON.stringify({ error: err.message || 'internal_error' })
    );
  }
}
