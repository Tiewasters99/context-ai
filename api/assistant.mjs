// POST /api/assistant
//
// In-app Assistant endpoint (Milestone 1). Runs a server-side Claude tool-use
// loop over the existing Contextspaces search tools and returns an answer with
// page citations, scoped to the user's current matter.
//
// Auth: the browser is already logged in via Supabase Auth; it forwards its
// session access token as Authorization: Bearer. All Supabase queries run
// through a client carrying that JWT, so RLS enforces matter access — the
// assistant can only read what the signed-in user can read.
//
// Request body:
//   { messages: {role:'user'|'assistant', content:string}[], matterId?: string }
//
// Response:
//   { text: string, usedTools: string[] }     on success
//   { error: string }                          on failure (with status code)
//
// Note: Vercel serverless timeout is 30s (vercel.json). A multi-round tool
// loop on Opus usually finishes well under that; streaming (M1.1) removes the
// ceiling entirely.

import { createClient } from '@supabase/supabase-js';

import { runAssistantStream } from '../lib/assistant-core.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;


export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'method_not_allowed' });
  }

  // Env sanity
  const missing = [];
  if (!SUPABASE_URL) missing.push('VITE_SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) missing.push('VITE_SUPABASE_ANON_KEY');
  if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (missing.length) {
    return json(res, 500, { error: 'config_error', missing_env: missing });
  }

  // Auth: forward the user's Supabase session JWT so RLS applies.
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return json(res, 401, { error: 'missing_bearer' });
  }
  const userToken = authHeader.slice(7).trim();
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const body = typeof req.body === 'string' ? safeJsonParse(req.body) : req.body;
  const messages = body?.messages;
  const matterId = body?.matterId || undefined;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json(res, 400, { error: 'messages (non-empty array) required' });
  }

  // Stream the answer as Server-Sent Events. All validation above this point
  // returns a normal JSON status; once we start the stream we can only signal
  // failures as `error` events.
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const emit = (ev) => {
    try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* client disconnected */ }
  };

  try {
    const { usedTools } = await runAssistantStream({
      supabase: sb,
      anthropicKey: ANTHROPIC_API_KEY,
      openaiApiKey: OPENAI_API_KEY,
      messages,
      matterId,
    });
    emit({ type: 'done', usedTools });
  } catch (err) {
    emit({ type: 'error', message: err?.message || 'assistant_failed' });
  } finally {
    res.end();
  }
}


function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
