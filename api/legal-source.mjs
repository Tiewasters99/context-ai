// POST /api/legal-source
//
// CORS proxy for the free legal-database fetchers (Cornell LII, eCFR, NY
// Senate, CourtListener). The cite-check run loop executes in the browser,
// but browsers can't fetch those sites cross-origin — so the client posts
// a citation here and we do the fetch server-side, returning the same
// shape cite-check/lib/sources.mjs produces:
//   { found: true, full_text, source_url, source_label } | { found: false }
//
// Auth: forwards the user's Supabase session JWT and verifies it, so this
// isn't an open proxy. No DB writes — we only confirm the caller is a
// logged-in user.
//
// Request body:
//   { authority_type: 'statute'|'case'|..., citation_bluebook?: string, case_name?: string }

import { createClient } from '@supabase/supabase-js';

import { fetchStatute, fetchCase } from '../cite-check/lib/sources.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(res, 500, { error: 'config_error', missing_env: ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'].filter((k) => !process.env[k] && !process.env[k.replace('VITE_', '')]) });
  }

  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return json(res, 401, { error: 'missing_bearer' });
  }
  const userToken = authHeader.slice(7).trim();
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return json(res, 401, { error: 'invalid_session' });

  const body = typeof req.body === 'string' ? safeJsonParse(req.body) : req.body;
  const authorityType = body?.authority_type;
  const cite = {
    citation_bluebook: body?.citation_bluebook || null,
    case_name: body?.case_name || null,
  };
  if (!cite.citation_bluebook && !cite.case_name) {
    return json(res, 400, { error: 'citation_bluebook or case_name required' });
  }

  try {
    let result;
    if (authorityType === 'statute' || authorityType === 'regulation' || authorityType === 'rule') {
      result = await fetchStatute(cite);
    } else if (authorityType === 'case') {
      result = await fetchCase(cite);
    } else {
      // Unknown type: try statute pattern first (cheap regex), then case.
      result = await fetchStatute(cite);
      if (!result?.found && cite.case_name) result = await fetchCase(cite);
    }
    return json(res, 200, result || { found: false });
  } catch (err) {
    return json(res, 200, { found: false, error: err.message || 'fetch_failed' });
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
