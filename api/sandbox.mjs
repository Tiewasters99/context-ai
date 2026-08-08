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
import { callTool, timeoutFetch } from '../lib/mcp-core.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

// Only the workspace-organization / document-task surface — retrieval stays
// on its existing client-side paths.
const ALLOWED_ACTIONS = new Set([
  'send_to_sandbox',
  'copy_document',
  'assemble_documents',
  'file_document',
  'create_matter',
  'move_document',
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
