// POST /api/deepgram-token
//
// Mints a credential the browser uses to open a Deepgram streaming WebSocket
// for live meeting transcription. Ported from Grapheon Connect — see
// docs/CONNECT_INTEGRATION.md.
//
// Two paths:
//   1. If DEEPGRAM_API_KEY has Member+ scope, mint a short-lived JWT via
//      /v1/auth/grant. Preferred — the long-lived key never reaches the
//      browser.
//   2. Fallback: return the API key itself. Used via the WebSocket
//      subprotocol "token" auth. Less ideal — rotate to a Member key
//      to enable short-lived tokens.
//
// Auth: requires a Supabase Bearer JWT in the Authorization header. Without
// it the endpoint refuses (it spends Deepgram credit, so it shouldn't be
// open to anonymous callers).

import { createClient } from '@supabase/supabase-js';

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

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return json(res, 500, { error: 'DEEPGRAM_API_KEY not configured' });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(res, 500, { error: 'supabase_env_missing' });
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

  const grantRes = await fetch('https://api.deepgram.com/v1/auth/grant', {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  res.setHeader('cache-control', 'no-store');

  if (grantRes.ok) {
    const data = await grantRes.json();
    return json(res, 200, { credential: data.access_token, scheme: 'bearer' });
  }

  return json(res, 200, { credential: apiKey, scheme: 'token' });
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}
