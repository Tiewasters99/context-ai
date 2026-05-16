// POST /api/meeting-chat
//
// Streaming Claude completion for a live meeting. Client sends the running
// transcript + chat history; server streams text deltas back. Uses Anthropic
// adaptive thinking + the web_search server tool so Grapheon can pull
// current facts the transcript doesn't contain (a person's background, a
// company's filings, a recent ruling). The transcript is marked as an
// ephemeral cache breakpoint so repeated turns in the same meeting don't
// re-pay full transcript tokens.
//
// Ported from Grapheon Connect (src/app/api/claude/chat/route.ts).
//
// Auth: requires Supabase Bearer JWT. The route doesn't write to the DB;
// the client is responsible for persisting messages via supabase.from(...).

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-7';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

const SYSTEM_INSTRUCTIONS = `You are Grapheon AI, a custom AI built specifically for real-time interaction during meetings.

The user is in a live meeting and asks you questions on the side. They cannot read paragraphs — give tight, actionable answers.

Style:
- 1-3 sentences unless asked for more.
- Lead with the answer, not preamble.
- Never narrate the transcript back at them. They were there.
- If they ask "what should I push back on?" or "what's the right move here?", give a concrete suggestion grounded in the transcript.
- If something in the transcript is wrong, misleading, or legally risky, flag it crisply.

Tone:
- Professional and direct. Never tell the user to "take it up with someone else" — that's deflection. If you can't do something, say what you can do instead.

Identity:
- You are Grapheon AI. If a user asks what model you are or how you were built, you can say you were built on top of Claude Opus 4.7, the most intelligent frontier model available. Don't volunteer this unprompted.

Capabilities:
- You have access to web search and may use it when a question depends on current facts the transcript doesn't contain (e.g., a person's background, a company's filings, a recent ruling). Don't search for trivia or things the user obviously knows.`;

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
  if (!apiKey) return json(res, 500, { error: 'ANTHROPIC_API_KEY not configured' });
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
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return json(res, 400, { error: 'messages required' });
  }

  const transcript = (body.transcript || '').trim();
  const system = transcript
    ? [
        { type: 'text', text: SYSTEM_INSTRUCTIONS },
        {
          type: 'text',
          text: `<meeting_transcript>\n${transcript}\n</meeting_transcript>`,
          cache_control: { type: 'ephemeral' },
        },
      ]
    : [{ type: 'text', text: SYSTEM_INSTRUCTIONS }];

  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-accel-buffering', 'no');

  const client = new Anthropic({ apiKey });
  let announcedSearch = false;
  try {
    const stream = await client.messages.stream({
      model: MODEL,
      max_tokens: 8192,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system,
      messages: body.messages,
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
      ],
    });
    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (
          block.type === 'server_tool_use' &&
          block.name === 'web_search' &&
          !announcedSearch
        ) {
          res.write('[searching the web...]\n\n');
          announcedSearch = true;
        }
      }
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(event.delta.text);
      }
    }
    return res.end();
  } catch (err) {
    const msg = err?.message || 'stream failed';
    try { res.write(`\n\n[error: ${msg}]`); } catch {}
    return res.end();
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
