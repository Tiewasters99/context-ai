// SecureSpace — a sealed meeting's chat, answered INSIDE the seal (2026-09-20)
// -----------------------------------------------------------------------------
// Eden's decision, verbatim: "sealed chat should be answered by Kimi with
// whatever agentic harness Kimi can run inside the sealed space."
//
// PR #162 closed a leak: /api/meeting-chat was handing a verbatim transcript to
// first-party Anthropic on a sealed matter. It closed it by refusing. This
// module is the other half — the sealed meeting now gets an answer instead of
// an apology, from the same pen and through the same harness that already serve
// sealed chat in /api/assistant.
//
// WHAT THIS IS NOT: a second assistant. There is exactly one agentic loop in
// this codebase (runAssistantStream, lib/assistant-core.mjs) and this module
// calls it. It does not choose a pen — choosePen does, from the tier. It does
// not write a ledger row — recordAssistant does. It does not know what a
// SigV4 header is. If the sealed pen is missing or fails, the refusal the user
// reads is the SAME sentence sealed chat produces, from the same function,
// because it is the same code path. Nothing here can fall back to another
// provider, for the simple structural reason that this module never holds an
// Anthropic key to fall back to (see `runSealedMeetingTurn`).
//
// What this module actually does, and stops:
//
//   1. sealedMeetingPlan()  — decide whether a refused meeting is one the
//                             sealed pen may answer, re-checking the policy
//                             (providerAllowed) the way lib/llm-sealed-route
//                             does, and failing closed if it ever says no.
//   2. transcriptWindow()   — measure the transcript against the pen's context
//                             and, when it does not fit, keep the most recent
//                             part and SAY SO. Never a silent truncation.
//   3. buildSealedMeetingMessages() — put the transcript into the conversation
//                             as a framing turn, so the question the user
//                             actually asked stays the last user message (it is
//                             what titles the session and what the ledger
//                             records).
//   4. runSealedMeetingTurn() — run the harness and translate its event stream
//                             into the plain-text stream /api/meeting-chat has
//                             always written to the browser.
//
// TOOLS — what "inside the seal" means here
// -----------------------------------------------------------------------------
// The harness's tool set (ALLOWED_TOOLS + the browser-executed actions) is
// offered unchanged, and every one of those tools keeps the meeting's content
// inside Contextspaces: they read the user's own matter through the user's own
// RLS, and the two that touch an outside service are themselves seal-governed
// and fail closed (search embeds nothing on a sealed scope — lib/seal-pipes.mjs
// — and ingest_document parks a sealed document as `held`). The tool that
// leaves, `web_search`, is not in this harness's set at all: it belongs to the
// Tier-A meeting route and is never reached from here. The full table is in the
// PR body.
//
// The one tool this module would narrow away if it could is `relay_feedback`:
// it writes the user's words into `orchestrator_feedback` AND mirrors them into
// the Contextspaces admin matter's `matter_state_events`
// (lib/assistant-core.mjs:638-657). That is a cross-matter write. It never
// leaves Contextspaces and never reaches a model, so it is not a seal
// violation — but a sentence from a sealed meeting landing in another matter's
// chronology is against the matter-isolation contract, and the model is told
// plainly below not to call it. Making that structural rather than instructed
// needs one optional `toolNames` parameter on runAssistantStream, which is
// assistant-core surgery this lane was told not to do. Flagged, not done.

import {
  runAssistantStream,
  bedrockCredsFromEnv,
  bedrockPenFor,
  toAnthropicTools,
  PENS,
} from './assistant-core.mjs';
import { providerAllowed } from './ai-tier-policy.mjs';
import { buildOrchestratorSystem } from './orchestrator-system.mjs';
import { estimateInputTokens } from './usage-prices.mjs';

/** The one provider a Tier-B matter admits (lib/ai-tier-policy.mjs). */
export const SEALED_PROVIDER = 'aws-bedrock';

// ── the pen's context, and where this number comes from ──────────────────────
// FINDING: the pen table (PENS, lib/assistant-core.mjs) declares prices, a
// route and a thinking headroom — but NO context window. Nothing in lib/, api/
// or docs/ states one for the sealed pen. So rather than invent a figure, this
// is the repo's own declared number for the Kimi K2.x family:
// src/lib/llm/providers.ts:46 gives `kimi-k2.6` a 256,000-token window (the
// front end's model table, which is where this product writes model facts
// down). K2.5 is the same family and the same generation.
//
// It is used ONLY to decide whether a transcript must be windowed, and the
// window errs small, so being wrong costs a disclosure sentence rather than a
// failed turn. The right fix is a `contextTokens` field on PENS[*] alongside
// pricePerM — one line in assistant-core, outside this lane. When it lands,
// delete this constant and read the table.
export const SEALED_PEN_CONTEXT_TOKENS = 256_000;

// Both of these mirror module-private constants in lib/assistant-core.mjs
// (MAX_OUTPUT_TOKENS and TOOL_RESULT_CHAR_CAP). They are not exported there, so
// they are restated here with their source named — same convention, and for the
// same reason, as lib/usage-prices.mjs restating the price tables.
const PEN_OUTPUT_TOKENS = 8192;
const TOOL_RESULT_CHARS = 100_000;

const ACK = 'Got it — I have the transcript and I am following the meeting. Ask away.';

const MEETING_BRIEF =
  'MEETING IN PROGRESS. The user is sitting in a live meeting and is asking you questions on '
  + 'the side, from the meeting panel. The running transcript is below.\n\n'
  + 'How to answer here:\n'
  + '- One to three sentences unless they ask for more. They cannot read paragraphs mid-meeting.\n'
  + '- Lead with the answer. No preamble, and never narrate the transcript back at them — they '
  + 'were in the room.\n'
  + '- If they ask what to push back on or what the right move is, give a concrete suggestion '
  + 'grounded in what was actually said.\n'
  + '- If something in the transcript is wrong, misleading or legally risky, say so crisply.\n'
  + '- Never tell them to take it up with someone else. If you cannot do a thing, say what you '
  + 'can do instead.\n\n'
  + 'What you can and cannot do from this panel:\n'
  + '- Your matter tools work normally: search, grep, get_passage, get_outline, '
  + 'list_matter_contents and the docket state. Use them when the answer is in the record rather '
  + 'than in the room. Search inside a sealed matter matches words and phrases rather than '
  + 'meaning, and it will tell you so.\n'
  + '- The meeting panel cannot open documents, navigate, create anything, move anything, or '
  + 'pass feedback to the team: open_document, open_matter, create_sub_matter, move_document and '
  + 'relay_feedback have NO effect from here. Do not call them — answer in words instead, and if '
  + 'they want a document opened, name it and tell them where it is.';

const WINDOW_BRIEF =
  'ONLY PART OF THE TRANSCRIPT IS ATTACHED. The meeting is longer than fits here, so what '
  + 'follows is the most recent part of it. You have not been given the earlier part and must not '
  + 'pretend otherwise: if the question turns on something said earlier, say that it is outside '
  + 'the part you can see, and look for it in the matter record with search or grep if it might '
  + 'have been filed. The user has already been told, in the answer, how much is attached.';

/**
 * Is this refused meeting one the sealed pen may answer?
 *
 * Takes `meetingModelDecision`'s result (lib/meeting-seal.mjs) and returns:
 *   null                 — not a sealed-pen case. Tier C, an unreadable seal,
 *                          an unresolvable meeting and Tier A all keep the
 *                          behaviour they had: the caller refuses, or sends.
 *   { creds, pen }       — the sealed arm. `creds` is null when this server
 *                          holds no sealed pen; the turn then REFUSES through
 *                          choosePen, in the product's own words, and `pen` is
 *                          null so the caller knows not to charge for it.
 *
 * Fails closed the way lib/llm-sealed-route.mjs does: the substitution is only
 * ever made on a Tier-B provider refusal, and only while the policy still
 * admits aws-bedrock on B. If that ever stops being true there is no sealed
 * route to offer and the caller's own refusal is the honest answer.
 */
export function sealedMeetingPlan({ seal, env = process.env }) {
  if (!seal || seal.ok !== false) return null;
  if (seal.code !== 'tier_violation' || seal.tier !== 'B') return null;
  if (!providerAllowed('B', SEALED_PROVIDER)) return null;
  // Read at request time, not at module scope: a server that has its Bedrock
  // keys pasted mid-life should not need a cold start to notice, and the
  // offline harness can move this world between cases.
  const creds = bedrockCredsFromEnv(env);
  return { creds, pen: creds ? bedrockPenFor(creds) : null };
}

/**
 * How much transcript fits, and what is left out.
 *
 * The rule: never silently truncate. Either the whole transcript goes, or the
 * most recent part goes AND the answer opens by saying so.
 *
 * The budget is the pen's context MINUS everything else that has to fit in it,
 * measured rather than guessed where it can be: the Orchestrator system prompt
 * and the tool schemas are built here exactly as the harness builds them, the
 * chat history is in hand, and the loop's own output allowance, thinking
 * headroom and one round of tool results are reserved from the constants that
 * set them.
 *
 * @returns {{text:string, windowed:boolean, keptLines:number, totalLines:number,
 *            budgetTokens:number, transcriptTokens:number}}
 */
export function transcriptWindow(transcript, { matterId = null, messages = [], contextTokens = SEALED_PEN_CONTEXT_TOKENS } = {}) {
  const text = typeof transcript === 'string' ? transcript : '';
  const lines = text.length ? text.split('\n') : [];
  const transcriptTokens = estimateInputTokens(text);

  let fixed = 0;
  try {
    fixed += estimateInputTokens(buildOrchestratorSystem({ matterId, today: '2026-01-01', route: '/app/m/x', tab: 'Meeting' }));
    fixed += estimateInputTokens(JSON.stringify(toAnthropicTools()));
  } catch {
    // If either ever changes shape, fall back to a deliberately generous
    // allowance rather than skipping the reserve and overfilling the window.
    fixed += 20_000;
  }
  // The five prompt-only tools the harness adds on top of mcp-core's
  // (open_document, open_matter, create_sub_matter, move_document,
  // relay_feedback) plus the framing turn's own prose.
  fixed += 2_000;
  fixed += estimateInputTokens(JSON.stringify(messages || []));

  const reserve = fixed
    + PEN_OUTPUT_TOKENS
    + (PENS.bedrockOpen.thinkingHeadroom ?? 0)
    + Math.ceil(TOOL_RESULT_CHARS / 3); // one round of tool output at the loop's own cap

  const budgetTokens = Math.max(1_000, contextTokens - reserve);
  if (transcriptTokens <= budgetTokens) {
    return { text, windowed: false, keptLines: lines.length, totalLines: lines.length, budgetTokens, transcriptTokens };
  }

  // Keep the END of the meeting: in a live room the last thing said is the
  // thing being asked about.
  const kept = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = estimateInputTokens(lines[i] + '\n');
    if (used + cost > budgetTokens) break;
    used += cost;
    kept.push(lines[i]);
  }
  kept.reverse();
  return {
    text: kept.join('\n'),
    windowed: true,
    keptLines: kept.length,
    totalLines: lines.length,
    budgetTokens,
    transcriptTokens,
  };
}

/**
 * What the user is told when only part of the meeting was attached.
 *
 * In LINES, not minutes, because minutes are not available: the browser renders
 * the transcript for the server with renderTranscriptForClaude()
 * (src/lib/meetings/transcript.ts), which drops each line's `start`/`end`, so no
 * timestamp ever reaches this process. Claiming "the last 20 minutes" would be
 * a guess dressed as a measurement. Lines are what is true.
 */
export function windowNotice(win) {
  if (!win?.windowed) return null;
  return (
    `This answer covers only the most recent part of the meeting — the last ${win.keptLines} of `
    + `${win.totalLines} transcript lines. The rest is longer than the sealed pen can hold, so it `
    + 'was not sent and I have not read it. Ask about a specific moment and I can look for it in '
    + 'the matter record.'
  );
}

/**
 * The conversation the harness runs on.
 *
 * The transcript rides a FRAMING TURN at the head of the conversation rather
 * than the system prompt (the harness owns the system prompt, and this module
 * does not edit it). That placement is deliberate twice over: the user's actual
 * question stays the last user message, which is what titles the ai_sessions row
 * and what the ai_messages user row records — so the ledger reads like a chat,
 * not like a transcript dump.
 */
export function buildSealedMeetingMessages({ transcript, messages, windowed = false }) {
  const history = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
  const frame = [
    MEETING_BRIEF,
    windowed ? WINDOW_BRIEF : null,
    `<meeting_transcript>\n${transcript}\n</meeting_transcript>`,
  ].filter(Boolean).join('\n\n');
  return [
    { role: 'user', content: frame },
    { role: 'assistant', content: ACK },
    ...history,
  ];
}

// A refusal that never started streaming gets a real status code. These are the
// ones /api/llm's sealed route already uses for the same conditions, so a
// sealed refusal has one shape across the product.
const REFUSAL_STATUS = {
  sealed_pen_unavailable: 503,
  sealed_pen_error: 502,
  matter_not_found: 404,
  silo_not_connected: 403,
  pen_unavailable: 503,
  escalation_unrecorded: 403,
};

/**
 * Run one sealed meeting turn through the Assistant's own agentic harness.
 *
 * `onStart` is called once, at the moment there is something to stream — the
 * caller uses it to set 200 and the streaming headers. Deliberately NOT on the
 * harness's `session` event: that event fires as soon as the pen is chosen,
 * before the pen has been asked anything, and a pen that then rejects the
 * request (403 on a gated model, bad credentials, a region error) would be
 * reported inside a 200 stream rather than as the 502 the rest of the product
 * uses. Holding the headers until the first byte of real output means every
 * refusal that happens before the answer starts still gets a status code and a
 * JSON body — the shape MeetingView renders as a sentence.
 *
 * NOTE what is NOT passed to the harness: no `anthropicKey`, no `fireworksKey`,
 * no `openaiApiKey`, and no `escalate`. The seal here is structural, not
 * promised: this turn holds no credential for any provider outside the seal, so
 * there is nothing for a bug to fall back to. (It also means search cannot
 * embed from here even if lib/seal-pipes.mjs were to regress — there is no
 * OpenAI key in this call.)
 *
 * @returns {Promise<{streamed:boolean, notice:string|null, window:object,
 *   result:object|null, refusal:{status:number, body:object}|null}>}
 */
export async function runSealedMeetingTurn({
  supabase, creds, transcript, messages, matterId, meetingId, matterName,
  onStart, write, run = runAssistantStream,
}) {
  const win = transcriptWindow(transcript, { matterId, messages });
  const convo = buildSealedMeetingMessages({ transcript: win.text, messages, windowed: win.windowed });

  let streamed = false;      // has anything gone to the browser yet?
  let refusal = null;        // set only while `streamed` is false
  let session = null;        // the harness's session event, for the caller
  let announcedTool = false;
  const notice = windowNotice(win);

  const start = () => {
    if (streamed) return;
    streamed = true;
    onStart?.(session);
    // The disclosure leads the answer, in the user's own reading order.
    if (notice) write(`${notice}\n\n`);
  };

  const emit = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'session') { session = ev; return; }
    if (ev.type === 'text') { start(); write(ev.text); return; }
    if (ev.type === 'tool') {
      // The same convention the Tier-A route uses for its own tool
      // ([searching the web...]), so the panel reads the same way.
      start();
      if (!announcedTool) { write('[searching the matter record...]\n\n'); announcedTool = true; }
      return;
    }
    if (ev.type === 'action' || ev.type === 'confirm') {
      // The meeting panel executes neither. Saying so beats letting the model's
      // "I've opened that for you" stand unchallenged on screen.
      start();
      write(`\n\n[the meeting panel can't do that from here — ${ev.action} works in the main app]\n\n`);
      return;
    }
    if (ev.type === 'error') {
      const message = typeof ev.message === 'string' && ev.message ? ev.message : 'The sealed pen could not answer.';
      if (!streamed) {
        refusal = {
          status: REFUSAL_STATUS[ev.code] ?? 502,
          body: { error: ev.code || 'sealed_meeting_failed', tier: 'B', message },
        };
        return;
      }
      // Mid-answer: the refusal is a sentence, so it reads as one.
      write(`\n\n${message}`);
    }
  };

  const result = await run({
    supabase,
    bedrockCreds: creds,
    messages: convo,
    matterId,
    context: {
      route: meetingId ? `/app/m/${meetingId}` : '/app/m',
      tab: 'Meeting',
      ...(matterName ? { matterName } : {}),
    },
    emit,
  });

  // A turn that neither answered nor refused (the pen returned an empty turn)
  // still owes the user a sentence rather than an empty 200. Same wording
  // runAssistant() uses for the same emptiness.
  if (!streamed && !refusal) {
    start();
    write('I could not produce an answer for that.');
  }

  return { streamed, notice, session, window: win, result: refusal ? null : result, refusal };
}
