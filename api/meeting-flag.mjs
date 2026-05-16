// POST /api/meeting-flag
//
// Scans the running meeting transcript for things the user MUST know about
// — contradictions, factual errors, commitments, opportunities, risks —
// and returns a JSON array. The client calls this on an interval (default
// every 90s) while the meeting is live, passing the items it has already
// flagged so we don't repeat ourselves. Be conservative: most scans should
// return [].
//
// Ported from Grapheon Connect (src/app/api/claude/flag/route.ts).
//
// Auth: requires Supabase Bearer JWT.

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const MODEL = process.env.CLAUDE_FLAG_MODEL || 'claude-opus-4-7';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

const SYSTEM = `You are a vigilant observer for a real-time meeting copilot. Scan the transcript for items the user MUST know about — and only those. Be conservative. Most scans should return zero flags.

Flag types:
- "contradiction": something just said contradicts something said earlier in this meeting
- "factual_error": a stated fact appears incorrect or unverifiable
- "commitment": someone has committed to something material (date, dollar amount, action item)
- "opportunity": a moment to push back, capitalize, or follow up that the user might miss
- "risk": something legally, financially, or strategically risky for the user's side

Output ONLY a JSON array (no prose, no code fences). Each flag:
{ "type": "<one of the above>", "text": "<one sentence, <200 chars, specific>", "anchor": "<short quoted excerpt from the transcript>" }

Empty array if nothing significant. Do not flag pleasantries, small talk, or already-flagged items.`;

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(res, 200, { flags: [] });
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

  const body = typeof req.body === 'string' ? safeJsonParse(req.body) : req.body;
  const transcript = (body?.transcript || '').trim();
  if (transcript.length < 200) return json(res, 200, { flags: [] });

  const alreadyText = (body?.alreadyFlagged || []).slice(-20).join('\n- ');
  const userText = `<meeting_transcript>
${transcript}
</meeting_transcript>

${alreadyText ? `Already flagged (do not repeat):\n- ${alreadyText}\n\n` : ''}Return the JSON array now.`;

  const client = new Anthropic({ apiKey });
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [
        { type: 'text', text: SYSTEM },
        {
          type: 'text',
          text: `<meeting_transcript>\n${transcript}\n</meeting_transcript>`,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userText }],
    });
    const block = response.content.find((b) => b.type === 'text');
    const text = block && 'text' in block ? block.text : '[]';
    return json(res, 200, { flags: parseFlags(text) });
  } catch (err) {
    return json(res, 200, { flags: [], error: err?.message || 'flag failed' });
  }
}

function parseFlags(raw) {
  const trimmed = (raw || '').trim();
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start < 0 || end < 0) return [];
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f) => {
      if (!f || typeof f !== 'object') return false;
      return (
        typeof f.type === 'string' &&
        typeof f.text === 'string' &&
        f.text.length > 0 &&
        f.text.length < 400
      );
    });
  } catch {
    return [];
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
