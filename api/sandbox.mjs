// POST /api/sandbox
//
// Session-authed bridge between the web app (AI Workbench Sandbox panel)
// and the shared MCP tool handlers in lib/mcp-core.mjs. The bearer token is
// the user's own Supabase access token (supabase.auth.getSession() on the
// client), so every operation runs user-scoped and RLS enforces matter
// isolation — same authority model as api/move-document.mjs.
//
// Request body: { action: string, args: object }
//   action ∈ send_to_sandbox | copy_document | assemble_documents
//          | file_document | create_matter | move_document
// Response: the handler's JSON result, or { error } with a status code.

import { createClient } from '@supabase/supabase-js';
import { callTool, timeoutFetch, resolveMatter } from '../lib/mcp-core.mjs';
import { jwtClaims } from '../lib/account-security.mjs';
import { guardSandboxCrossing } from '../lib/seal-crossing.mjs';
import { consumeUsage, sendUsageRefusal } from '../lib/usage-meter.mjs';
import { EMBED_USD_PER_MTOK } from '../lib/usage-prices.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// The actions that can carry a document out of its matter (S4a): a move, a
// copy, and send_to_sandbox (a copy into a Tier A Sandbox box). The rest
// either stay in one matter (assemble_documents files into the matter the
// sources live in), take their content from the caller (file_document,
// create_deck, create_chart), or read a sealed matter's stored PDFs, which
// the bucket refuses a user's JWT since 096 (edit_pdf's inserts).
const CROSSING_ACTIONS = new Set(['move_document', 'copy_document', 'send_to_sandbox']);

// The workspace-organization / document-task surface, plus hybrid content
// search (which needs the server-held embedding key the client can't have).
const ALLOWED_ACTIONS = new Set([
  'send_to_sandbox',
  'copy_document',
  'assemble_documents',
  'file_document',
  'create_matter',
  'move_document',
  'edit_pdf',
  'create_deck',
  'create_chart',
  'search',
]);

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(res, 500, { error: 'config_error' });
  }

  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return json(res, 401, { error: 'missing_bearer' });
  }
  const userToken = authHeader.slice(7).trim();
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: `Bearer ${userToken}` },
      fetch: timeoutFetch(15000, 'supabase query'),
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const body = typeof req.body === 'string' ? safeJsonParse(req.body) : req.body;
  const action = body?.action;
  const args = body?.args ?? {};
  if (!action || !ALLOWED_ACTIONS.has(action)) {
    return json(res, 400, { error: `action must be one of: ${[...ALLOWED_ACTIONS].join(', ')}` });
  }

  // A sealed document leaves its matter only as lib/seal-crossing.mjs allows:
  // step-up at both ends, never to anything less sealed, and written to the
  // source matter's Record before it runs. Asked before the meter, so a
  // refusal costs nothing. A TEXT-ONLY document has no stored file for 096's
  // bucket rule to refuse, which is why this cannot be left to storage.
  if (CROSSING_ACTIONS.has(action)) {
    if (jwtClaims(userToken).cs_via === 'connector') return json(res, 403, { error: 'browser_sessions_only' });
    const { data: userData, error: userErr } = await sb.auth.getUser();
    if (userErr || !userData?.user) return json(res, 401, { error: 'invalid_session' });
    const guard = await guardSandboxCrossing({
      action, args, userClient: sb, userId: userData.user.id,
      supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY,
      resolveDestination: (key) => resolveMatter(sb, key),
    });
    if (guard.refusal) return json(res, guard.refusal.status, guard.refusal.body);
  }

  // Spend cap (migration 063). Most actions here are database and PDF work on
  // our own compute; `search` embeds the query on the server-held OpenAI key,
  // and assemble/deck/chart are maxDuration 120 of function time. So the cost
  // that matters is the RATE, and the cents are a token gesture — one embedded
  // query — rather than a pretence at measuring a document assembly.
  const meter = await consumeUsage({
    supabaseUrl: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    bearer: userToken,
    kind: 'sandbox',
    estimateCents: action === 'search' ? Math.ceil((1000 / 1e6) * EMBED_USD_PER_MTOK * 100) : 0,
  });
  if (!meter.allowed) return sendUsageRefusal(res, meter);

  try {
    const result = await callTool(sb, action, args, {
      openaiApiKey: process.env.OPENAI_API_KEY,
      googleApiKey: process.env.GOOGLE_API_KEY,
    });
    return json(res, 200, result);
  } catch (err) {
    const msg = err?.message || String(err);
    const status = /not permitted|not found|no access|not accessible/i.test(msg) ? 403 : 500;
    return json(res, status, { error: msg });
  }
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }
