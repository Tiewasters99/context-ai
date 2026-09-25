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
import { agentRowRefusal, checkAccessGrant, readAgentTokenRow, touchAgentToken } from '../lib/oauth-grants.mjs';
import { connectorTokenIdentity } from '../lib/connector-token-auth.mjs';
import { runMeteredToolCall } from '../lib/connector-meter.mjs';
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

// Returns the caller's identity:
//   { userId, kind: 'user' | 'agent', tokenId?, matterScope?, provider?, name? }
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
      // same grant and agent checks. Only a truly old token with neither
      // gid nor agt keeps the old unchecked path.
      if (payload.gid || payload.agt) return oauthIdentity(payload, 'bare');
      console.log('[mcp auth] oauth ok: sub=%s', payload.sub);
      return { userId: payload.sub, kind: 'user' };
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
    return { userId: payload.sub, kind: 'user' };
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


// -----------------------------------------------------------------------------
// callTool options, per caller
// -----------------------------------------------------------------------------
// A user token (and every OAuth connection) gets exactly the options it
// always got. An agent token (migration 085) adds two things:
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
  if (identity?.kind !== 'agent') return opts;
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

const AGENT_INSTRUCTIONS =
  ' THIS IS AN AGENT CONNECTION. It sees only the matters it has been granted ' +
  '(and their sub-matters) — never a sealed SecureSpace matter. Work comes from ' +
  'the task board: call my_tasks to see what is assigned to you, claim_task to ' +
  'take one, then do the work with the normal tools (search, grep, get_outline, ' +
  'get_passage, get_media, file_document …) inside that task\'s matter. If you are ' +
  'blocked, call ask_human with one clear question and poll my_tasks until the ' +
  'answer appears. Finish with post_result (status "failed" if you could not do it).';

// An agent given "All my matters (except SecureSpaces)" (migration 088).
const AGENT_ALL_INSTRUCTIONS = AGENT_INSTRUCTIONS.replace(
  'It sees only the matters it has been granted (and their sub-matters)',
  'It sees every matter its owner can open, including ones created later',
);


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
    const identity = await authenticate(req);
    const sb = userScopedClient(identity.userId);
    const agentNote = identity.kind !== 'agent' ? ''
      : identity.scopeAll === true ? AGENT_ALL_INSTRUCTIONS : AGENT_INSTRUCTIONS;

    const server = new Server(
      // title + icons + websiteUrl are what connector hosts (Grok, Claude,
      // ChatGPT) can show in their app lists instead of a blank tile. `name`
      // stays as it was: clients may key saved connections on it.
      {
        name: 'contextspaces-retrieval',
        title: 'Contextspaces',
        version: '0.6.0',
        websiteUrl: 'https://www.contextspaces.ai',
        icons: [
          { src: 'https://www.contextspaces.ai/contextspaces-mark.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
          { src: 'https://www.contextspaces.ai/icon-192.png', mimeType: 'image/png', sizes: ['192x192'] },
          { src: 'https://www.contextspaces.ai/icon-512.png', mimeType: 'image/png', sizes: ['512x512'] },
        ],
      },
      {
        capabilities: { tools: {} },
        instructions:
          'Contextspaces stores both searchable text (passages with page:line ' +
          'citations) and the original files behind every document. Media ' +
          'originals — video, audio, images, as-filed PDFs — are accessible: ' +
          'call get_media with a document UUID to receive a short-lived ' +
          'streaming URL (supports HTTP Range). When a user asks you to watch ' +
          'or analyze a video stored in Contextspaces, use get_media and fetch ' +
          'the URL yourself before asking for a local file path. If your ' +
          'environment blocks the fetch (sandboxed agents may get 403 ' +
          'host_not_allowed from an egress proxy), the URL is still valid: ' +
          'give it to the user as a clickable download link and accept a ' +
          'manual upload as fallback — do not retry repeatedly and do not ' +
          'report the media as unavailable. To combine stored PDFs into one ' +
          'document (exhibits into a filing), call assemble_documents — it ' +
          'merges server-side, files the result into the matter, and returns ' +
          'a download link, so no fetch from your side is needed. ' +
          'You can also ORGANIZE the ' +
          'workspace: create_matter creates matters, sub-matters, and folders ' +
          '(all the same container), move_document relocates stored ' +
          'documents, and copy_document duplicates them — so "make an ' +
          'Engagement Letters folder in Admin and put the drafts in it" is ' +
          'create_matter followed by move_document, no manual steps needed. ' +
          'For scratch work there is the SANDBOX (the AI Workbench\'s ' +
          'workspace): send_to_sandbox copies documents into per-matter ' +
          'mini-boxes so originals stay filed, and assemble_documents merges ' +
          'stored PDFs into one filed PDF with a download link — the right ' +
          'flow for "combine these exhibits into a single PDF for filing". ' +
          'DOCUMENT TASKS: edit_pdf reorders/deletes/rotates pages into a ' +
          'new copy; create_deck builds a filed .pptx (you author the ' +
          'slides — bullets, tables, native charts, notes); create_chart ' +
          'renders an SVG chart from data you extracted. search works ' +
          'matter-scoped or, with matter omitted, across every matter at once.' +
          agentNote,
      }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args = {} } = request.params;
      // Metered (migration 086, lib/connector-meter.mjs): the rate ceiling on
      // every call, a charge through usage_consume on the costed ones, and a
      // plain-sentence refusal. The result and error shapes are unchanged —
      // runMeteredToolCall returns exactly what this handler used to.
      return runMeteredToolCall({
        identity,
        name,
        args,
        sb,
        invoke: () => callTool(sb, name, args, callToolOptsFor(identity, {
          openaiApiKey: OPENAI_API_KEY,
          googleApiKey: process.env.GOOGLE_API_KEY,
        })),
      });
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
