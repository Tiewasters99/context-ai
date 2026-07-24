// POST /api/tts  { text }
//
// The professor's voice: server-generated speech returned as ordinary
// audio (audio/mpeg), because iOS Safari's built-in speechSynthesis
// swallows programmatic utterances no matter how it's coaxed. A plain
// <audio> element plays this like any other media.
//
// Auth: requires a Supabase Bearer JWT (it spends TTS credit). Text is
// capped at one professor turn.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const MAX_CHARS = 4000;

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return json(res, 500, { error: 'OPENAI_API_KEY not configured' });
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

  const text = String(req.body?.text ?? '').slice(0, MAX_CHARS).trim();
  if (!text) return json(res, 400, { error: 'empty_text' });

  const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      voice: 'onyx',
      speed: 0.95,
      input: text,
    }),
  });

  if (!ttsRes.ok) {
    const detail = await ttsRes.text().catch(() => '');
    return json(res, 502, { error: 'tts_failed', detail: detail.slice(0, 300) });
  }

  const audio = Buffer.from(await ttsRes.arrayBuffer());
  res.statusCode = 200;
  res.setHeader('content-type', 'audio/mpeg');
  res.setHeader('cache-control', 'no-store');
  return res.end(audio);
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}
