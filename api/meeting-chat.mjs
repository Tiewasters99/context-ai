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
//
// TWO ROUTES, ONE ENDPOINT (2026-09-20)
// -----------------------------------------------------------------------------
// Everything above describes the UNSEALED (Tier A) meeting, which is unchanged
// down to the byte. A SEALED (Tier B) meeting takes the other arm:
//
//   Tier A  → first-party Claude, web_search attached, transcript in a cached
//             system block. Exactly as before.
//   Tier B  → the sealed pen (Kimi K2.5 in our own AWS account) through the
//             Assistant's own agentic harness, with the matter's own tools and
//             no web search — lib/meeting-sealed-chat.mjs. Eden's decision of
//             2026-09-20: "sealed chat should be answered by Kimi with whatever
//             agentic harness Kimi can run inside the sealed space."
//   Tier C, an unreadable seal, an unresolvable meeting → refused, as PR #162
//             left them.
//
// The order is the one /api/llm settled on in PR #163: seal decision FIRST,
// then the spend cap, so the turn is priced at the pen that will actually
// answer it and a meter that fails open can never widen the route. And the
// sealed arm is entered only from a refusal this file has already received —
// it never widens the seal, only decides who serves what was refused.

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

import { sealedMeetingPlan, runSealedMeetingTurn } from '../lib/meeting-sealed-chat.mjs';
import { meetingRefusalMessage } from '../lib/meeting-seal.mjs';
import { consumeUsage, recordActualUsage, sendUsageRefusal } from '../lib/usage-meter.mjs';
import { estimateLlmCents, centsForTokens } from '../lib/usage-prices.mjs';

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

  // The unsealed arm's key. Missing is fatal only for THAT arm — a sealed
  // meeting is served by our AWS credentials and holds no Anthropic key at
  // all, so the check moved below the seal decision rather than gating the
  // whole endpoint on a key the sealed turn must never use.
  const apiKey = process.env.ANTHROPIC_API_KEY;
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

  // The SecureSpace seal. The transcript below is the meeting itself, verbatim,
  // and it is about to be handed to first-party Anthropic. Whether that may
  // happen at all is decided by the tier policy, through the SAME function the
  // /api/llm gate calls (providerAllowed, lib/ai-tier-policy.mjs) — one policy,
  // not a second one written out here.
  //
  // What this replaces: the route used to read the tier and act on it only for
  // Tier C. A Tier-B (SEALED) meeting set a flag that dropped `web_search` and
  // then sent the whole transcript to api.anthropic.com regardless — no
  // escalation, no record. Since Tier B admits nothing but the sealed Bedrock
  // route (2026-09-19), a Tier-B answer from THIS provider is refused here and
  // api.anthropic.com is never contacted: the refusal is returned before any
  // provider client exists. Since 2026-09-20 that refusal is not where the
  // turn ends — it is where the sealed arm below begins.
  //
  // lib/meeting-seal.mjs holds the lookup, shared with /api/meeting-flag, and
  // fails closed — an unreadable tier or a meeting row that does not resolve is
  // a refusal, not a pass. A meeting bound to no matter stays open, which is
  // the rule /api/llm applies to an unbound draft.
  const { meetingModelDecision } = await import('../lib/meeting-seal.mjs');
  const seal = await meetingModelDecision(sb, body.meeting_id, { provider: 'anthropic' });

  const transcript = (body.transcript || '').trim();

  if (!seal.ok) {
    // THE SEALED ARM. A Tier-B meeting is not the end of the road any more: it
    // is answered by the pen that lives inside the seal, through the same
    // agentic harness /api/assistant runs, and it leaves the same record
    // (ai_sessions / ai_messages, with model, provider, tokens and cost).
    // Everything else — Tier C, an unreadable seal, an unresolvable meeting —
    // keeps PR #162's refusal exactly.
    const plan = sealedMeetingPlan({ seal });
    if (!plan) {
      // No sealed route to offer (Tier C, or a policy that has stopped
      // admitting aws-bedrock on B). Refuse, and do not promise a pen.
      // A PAUSED matter (migration 070) answers with its own sentence — who paused
      // it and since when — never with the generic sealed refusal.
      const message = seal.paused ? seal.message
        : seal.tier === 'B' ? meetingRefusalMessage('B', { sealedChat: false }) : seal.message;
      return json(res, seal.status, { error: seal.code, tier: seal.tier, message });
    }

    // Priced at the pen that answers, never at the model this route used to
    // name — the ~8× overcharge PR #163 removed from /api/llm, removed here for
    // the same reason. A server with NO sealed pen is not metered at all: that
    // turn is a refusal, and a refusal is free.
    let meter = null;
    if (plan.pen) {
      meter = await consumeUsage({
        supabaseUrl: SUPABASE_URL,
        anonKey: SUPABASE_ANON_KEY,
        bearer: userToken,
        kind: 'meeting',
        estimateCents: estimateLlmCents({
          provider: 'aws-bedrock',
          model: plan.pen.model,
          bodyText: transcript + JSON.stringify(body.messages || []),
          maxOutputTokens: 4096,
        }),
      });
      if (!meter.allowed) return sendUsageRefusal(res, meter);
    }

    const turn = await runSealedMeetingTurn({
      supabase: sb,
      creds: plan.creds,
      transcript,
      messages: body.messages,
      matterId: seal.matterId,
      meetingId: body.meeting_id,
      // Headers are set only once the turn commits to an answer, so a refusal
      // that happens first still gets a status code and a JSON body — the
      // shape MeetingView renders as a plain sentence.
      onStart: () => {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-accel-buffering', 'no');
      },
      write: (s) => { try { res.write(s); } catch { /* client disconnected */ } },
    });
    if (turn.refusal) return json(res, turn.refusal.status, turn.refusal.body);
    res.end();
    // Reconcile against the tokens the pen actually reported, the way
    // /api/assistant does. Best effort: a metering hiccup must not spoil an
    // answer already delivered.
    if (meter?.eventId && turn.result?.usage) {
      await recordActualUsage({
        supabaseUrl: SUPABASE_URL,
        serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        eventId: meter.eventId,
        cents: centsForTokens(turn.result.model, turn.result.provider, turn.result.usage),
        model: turn.result.model || null,
        meta: {
          route: 'meeting-chat',
          provider: turn.result.provider || null,
          tier: turn.result.tier || null,
          sealed: true,
          tokens: turn.result.usage,
          ...(turn.window?.windowed ? { transcript_windowed: { kept: turn.window.keptLines, total: turn.window.totalLines } } : {}),
        },
      });
    }
    return;
  }

  if (!apiKey) return json(res, 500, { error: 'ANTHROPIC_API_KEY not configured' });
  // Kept for the day a zero-retention arrangement puts a first-party provider
  // back into Tier B's set (the Anthropic org ZDR request of 2026-09-18): the
  // model call would be admitted again, but web_search still must not run — its
  // queries are drawn from the transcript and they leave for the open web.
  const sealedMeeting = seal.sealed;

  // Spend cap (migration 063), before the stream starts — this route sends a
  // whole meeting transcript to Opus on every turn, with an 8,192-token
  // answer and web search attached, which is among the most expensive single
  // calls in the product. Checked here so a refusal is a status code rather
  // than a half-written answer.
  const meter = await consumeUsage({
    supabaseUrl: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    bearer: userToken,
    kind: 'meeting',
    estimateCents: estimateLlmCents({
      provider: 'anthropic',
      model: MODEL,
      bodyText: transcript + JSON.stringify(body.messages || []),
      maxOutputTokens: 8192,
    }),
  });
  if (!meter.allowed) return sendUsageRefusal(res, meter);

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
      // No web search inside a sealed matter: the queries it would issue are
      // drawn from the transcript, and they leave for the open internet.
      tools: sealedMeeting
        ? []
        : [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
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
