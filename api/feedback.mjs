// POST /api/feedback
//
// Feedback tickets: a bug, a complaint, a suggestion. Tickets land in
// feedback_tickets and are periodically swept into a Claude Code triage
// session (shared sweeper with Grapheon). Insert rides the anon key — the
// table's RLS is insert-only for exactly this reason; nothing can be read
// back through this route. When a bearer token is present the ticket is
// attributed to that user.
//
// Request body: { category: 'bug'|'complaint'|'suggestion', message,
//                 page?, email?, context? }
// Response:     { ok: true } or { error } with status code

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

const CATEGORIES = new Set(['bug', 'complaint', 'suggestion']);

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(res, 500, { error: 'config_error' });
  }

  const body = typeof req.body === 'string' ? safeJsonParse(req.body) : req.body;
  const category = String(body?.category || '').toLowerCase();
  const message = String(body?.message || '').trim();
  if (!CATEGORIES.has(category)) {
    return json(res, 400, { error: 'category must be bug, complaint, or suggestion' });
  }
  if (!message || message.length > 4000) {
    return json(res, 400, { error: 'message is required (max 4000 chars)' });
  }

  // Attribute to the signed-in user when a token is supplied; anonymous is fine.
  let userId = null;
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    try {
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data } = await userClient.auth.getUser();
      userId = data?.user?.id ?? null;
    } catch { /* anonymous ticket */ }
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await sb.from('feedback_tickets').insert({
    app: 'contextspaces',
    category,
    message,
    page: typeof body?.page === 'string' ? body.page.slice(0, 300) : null,
    email: typeof body?.email === 'string' ? body.email.slice(0, 200) : null,
    user_id: userId,
    context: {
      ...(body?.context && typeof body.context === 'object' ? body.context : {}),
      userAgent: (req.headers['user-agent'] || '').slice(0, 300) || undefined,
    },
  });
  if (error) return json(res, 500, { error: 'could_not_save' });
  return json(res, 200, { ok: true });
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
