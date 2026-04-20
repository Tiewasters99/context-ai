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
//   SUPABASE_JWT_SECRET           (used to sign per-request user JWTs)
//   OPENAI_API_KEY                (only used by the search tool)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createClient } from '@supabase/supabase-js';
import { createHash, createHmac } from 'node:crypto';

import { TOOLS, callTool } from '../lib/mcp-core.mjs';


// -----------------------------------------------------------------------------
// Env
// -----------------------------------------------------------------------------
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;


// -----------------------------------------------------------------------------
// Supabase clients
// -----------------------------------------------------------------------------

// Used once per request to resolve the opaque bearer token to a user_id.
// Operates as service_role so it can read connector_tokens.token_hash.
function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Per-request client scoped to the authenticated user. Queries run with
// this client hit Postgres as the user, so RLS policies on matterspaces,
// documents, and passages enforce correct scoping with no app-side logic.
function userScopedClient(user_id) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user_id,
    role: 'authenticated',
    aud: 'authenticated',
    iss: 'supabase',
    iat: now,
    exp: now + 3600, // 1 hour; request is well under a second
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
  if (!/^csp_[A-Za-z0-9_-]{16,}$/.test(token)) {
    throw new AuthError(401, 'malformed_token');
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');
  const admin = adminClient();
  const { data, error } = await admin
    .from('connector_tokens')
    .select('id, user_id, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (error) throw new AuthError(500, `auth_db_error`);
  if (!data) throw new AuthError(401, 'invalid_token');
  if (data.revoked_at) throw new AuthError(401, 'revoked');
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    throw new AuthError(401, 'expired');
  }

  // Fire-and-forget usage tracking; don't delay the request on this.
  admin
    .from('connector_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {})
    .catch(() => {});

  return data.user_id;
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
    'GET, POST, DELETE, OPTIONS'
  );
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  // Config sanity — fail loudly if the deploy env is incomplete.
  const missing = [];
  if (!SUPABASE_URL) missing.push('VITE_SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) missing.push('VITE_SUPABASE_ANON_KEY');
  if (!SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!JWT_SECRET) missing.push('SUPABASE_JWT_SECRET');
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
