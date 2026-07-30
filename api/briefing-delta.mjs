// GET /api/briefing/delta?since=<ISO timestamp>   (rewrites to this file)
//
// Phase 4 stub for the future Briefing Engine: everything that happened
// since a timestamp — matter_state_events (the ledger log) unioned with
// activity_feed — grouped by matter. The heavy lifting is the
// get_briefing_delta RPC (migration 042); this function only
// authenticates, calls it, and groups.
//
// Auth: a Supabase access token as `Authorization: Bearer <jwt>`. The
// token rides through to PostgREST, so the RPC runs SECURITY INVOKER as
// that user and RLS scopes the delta to matters they can see. No
// service-role key is used here on purpose.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY =
  process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'GET only' });
    return;
  }
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) {
    res.status(401).json({ error: 'Authorization: Bearer <supabase access token> required' });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    res.status(500).json({ error: 'Supabase env not configured' });
    return;
  }

  // Default window: the last 24 hours (a morning brief's natural span).
  const sinceRaw = req.query?.since;
  const since = sinceRaw
    ? new Date(String(sinceRaw))
    : new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (Number.isNaN(since.getTime())) {
    res.status(400).json({ error: `Unparseable since: ${sinceRaw}` });
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.rpc('get_briefing_delta', {
    p_since: since.toISOString(),
  });
  if (error) {
    const missing = /get_briefing_delta/.test(error.message);
    res.status(missing ? 501 : 500).json({
      error: missing
        ? 'get_briefing_delta not found — apply migration 042'
        : error.message,
    });
    return;
  }

  // Group by matter: { matter_id: [{source, event_type, occurred_at, detail}] }
  const matters = {};
  for (const row of data ?? []) {
    (matters[row.matter_id] ??= []).push({
      source: row.source,
      event_type: row.event_type,
      occurred_at: row.occurred_at,
      detail: row.detail,
    });
  }

  res.status(200).json({
    since: since.toISOString(),
    event_count: (data ?? []).length,
    matter_count: Object.keys(matters).length,
    matters,
  });
}
