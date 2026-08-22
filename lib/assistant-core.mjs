// In-app Assistant — Milestone 1 / 1.1 ("Answer & Cite", streaming).
//
// A server-side agentic loop that wires a model to the EXISTING Contextspaces
// search tools (lib/mcp-core.mjs). The model searches the user's current
// matter and answers with page citations. Near-read-only: the only writes it
// can perform directly are enqueueing ingestion work (ingest_document) and
// relaying feedback — both idempotent and RLS-scoped.
//
// The system prompt is the Orchestrator (lib/orchestrator-system.mjs) — it
// takes per-turn situational context (route, tab, matter name) from the
// browser via the `context` option.
//
// SecureSpace (2026-08-22): the PEN is chosen by the matter's effective
// tier (lib/ai-tier-policy.mjs), never by the client —
//   A (frontier) → Claude Opus 4.8 (today's behavior);
//   B (sealed)   → Kimi K3 on Fireworks, US-hosted, zero data retention.
//                  Claude only as an EXPLICIT, recorded escalation
//                  (`escalate: true`) — never a silent failover: a sealed
//                  matter's text must not drift to a frontier host because
//                  a key was missing or a call failed;
//   C (silo)     → refused until the Silo appliance is connected.
// Every matter-bound exchange is recorded to ai_sessions / ai_messages
// (migration 051) through the USER-scoped client — the row is both the
// record and the ledger line (model, provider, tokens, cost, policy).
//
// Provider isolation: the two provider drivers live at the bottom of this
// file and speak one neutral turn shape; the loop above them never names a
// provider. Swapping or adding pens means editing the drivers, not the
// endpoint or the UI.
//
// Streaming: runAssistantStream({..., emit}) drives the loop and pushes events
// to `emit` as they happen — text deltas of the answer, plus a marker each time
// a tool runs. The HTTP layer turns those into SSE. runAssistant(...) is a
// thin non-streaming wrapper that collects the same events into a string.
//
// Callers pass a USER-SCOPED Supabase client so Postgres RLS enforces matter
// access — the assistant can only read what the signed-in user can:
//   - api/assistant.mjs            (Vercel serverless, production)
//   - vite-claude-proxy.ts shim    (local `vite dev`)

import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, callTool } from './mcp-core.mjs';
import { buildOrchestratorSystem } from './orchestrator-system.mjs';
import { matterTierWithClient, providerAllowed, isSealedTier } from './ai-tier-policy.mjs';

const MAX_ITERATIONS = 6;          // bound on tool-call rounds (cost)
const MAX_OUTPUT_TOKENS = 8192;    // streaming, so we can give the answer room
const TOOL_RESULT_CHAR_CAP = 100_000;

// The pens. One per provider; the tier picks among them. Prices are list
// USD per million tokens, used only for the ledger's estimated_cost.
export const PENS = {
  anthropic: {
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    pricePerM: { input: 5, output: 25 },
  },
  fireworks: {
    provider: 'fireworks',
    model: 'accounts/fireworks/models/kimi-k3',
    label: 'Kimi K3 (US-hosted, zero data retention)',
    pricePerM: { input: 3, output: 15 },
    // Kimi's thinking spends from max_tokens: without headroom the call dies
    // with finish_reason=length before the answer starts (Editor lesson).
    thinkingHeadroom: 12_000,
  },
};

/**
 * A refusal the loop reports to the user as an `error` event (and records
 * in the ledger). Not a crash — the policy said no.
 */
export class AssistantRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Which pen serves this turn. The tier is the matter's EFFECTIVE tier
 * (ancestors included); `null` means no matter is bound (Tier A rules).
 * Throws AssistantRefusal when policy or configuration says no.
 */
export function choosePen({ tier, anthropicKey, fireworksKey, escalate = false }) {
  const t = tier ?? 'A';
  if (t === 'C') {
    throw new AssistantRefusal(
      'silo_not_connected',
      'This matter is a Silo (SecureSpace Tier C): nothing may leave the building, and the ' +
      'Silo appliance is not connected yet. No model was called.',
    );
  }
  if (t === 'B') {
    if (escalate) {
      if (!anthropicKey) throw new AssistantRefusal('pen_unavailable', 'The escalation pen (Claude) is not configured on this server.');
      return { ...PENS.anthropic, apiKey: anthropicKey, escalation: true };
    }
    if (!fireworksKey) {
      throw new AssistantRefusal(
        'sealed_pen_unavailable',
        'This matter is sealed (SecureSpace Tier B) and the sealed pen — Kimi K3 on a US ' +
        'zero-retention host — is not configured on this server. No frontier model was ' +
        'used; nothing left the room.',
      );
    }
    return { ...PENS.fireworks, apiKey: fireworksKey, escalation: false };
  }
  if (!anthropicKey) throw new AssistantRefusal('pen_unavailable', 'The assistant\'s model is not configured on this server.');
  return { ...PENS.anthropic, apiKey: anthropicKey, escalation: false };
}

// Tools the assistant may use. Mostly read-only; the two ingestion tools are
// the deliberate exceptions — ingest_document only ENQUEUES work for the
// background worker (idempotent, deduped, no content mutation), and
// check_ingest_status reads queue/document state. `file_document` (raw
// content upload) stays excluded: uploads come through the Vault UI.
const ALLOWED_TOOLS = new Set([
  'list_matters',
  'list_matter_contents',
  'search',
  'get_passage',
  'get_outline',
  'grep',
  'ingest_document',
  'check_ingest_status',
  // Matter State Ledger (042/043): reading state is how the assistant
  // orients on a thread; set_matter_state is a sanctioned write — it runs
  // under the user's RLS and every change lands as an append-only
  // matter_state_events row, which is exactly the audit trail the docket
  // wants. Docket commands ("mark this done", "update the headline")
  // depend on it.
  'get_matter_state',
  'set_matter_state',
]);

// Tools that take a `matter` argument — when we know the active matter we
// inject it so the model can't accidentally omit or change the scope.
const MATTER_SCOPED_TOOLS = new Set([
  'search', 'grep', 'list_matter_contents', 'get_outline',
  'check_ingest_status', 'get_matter_state', 'set_matter_state',
]);

// Client-executed UI actions (Milestone 2). These don't run on the server —
// the loop forwards them to the browser as `action` events and feeds back a
// synthetic "opened" result so the model can continue and confirm.
const CLIENT_ACTIONS = new Set(['open_document', 'open_matter']);

const CLIENT_ACTION_TOOLS = [
  {
    name: 'open_document',
    description:
      'Open a document in the reader for the user, optionally at a specific page. ' +
      'Call this ONLY when the user asks to see, open, view, pull up, or be taken to ' +
      'a document ("show me", "open that", "take me to the deposition"). Use the ' +
      'document_id and the cited page from a prior search / get_passage result. Do NOT ' +
      'call it on a plain factual question — just answer those.',
    input_schema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'Document UUID, from a search/get_passage result.' },
        page: { type: 'integer', description: 'Optional 1-based printed page to open to (e.g. the cited page).' },
      },
      required: ['document_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_matter',
    description:
      "Navigate the user to a matter's page. Call this ONLY when the user asks to go to, " +
      'open, or be taken to a matter. Use the matter UUID from a list_matters result.',
    input_schema: {
      type: 'object',
      properties: {
        matter_id: { type: 'string', description: 'Matter UUID, from a list_matters result.' },
      },
      required: ['matter_id'],
      additionalProperties: false,
    },
  },
];

// Confirm-required actions (Milestone 2.1) — WRITES. The loop NEVER executes
// these; it forwards a `confirm` event and the browser performs the change only
// after the user confirms in a dialog, under their own session (RLS applies).
const CONFIRM_ACTIONS = new Set(['create_sub_matter', 'move_document']);

const CONFIRM_ACTION_TOOLS = [
  {
    name: 'create_sub_matter',
    description:
      'Propose a new sub-matter inside the matter the user is currently in. This does NOT ' +
      'create anything directly — it opens a confirmation dialog the user must complete. ' +
      'Call it ONLY when the user asks to create or add a sub-matter and they are inside a ' +
      'matter. After calling it, tell them you have set it up for their review — never say ' +
      'it has been created.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Proposed sub-matter name (e.g. "Trial Prep").' },
        description: { type: 'string', description: 'Optional one-line description.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'move_document',
    description:
      'Propose moving a document into a different matter or sub-matter. This does NOT move ' +
      'anything directly — it asks the user to confirm first. Call it ONLY when the user asks ' +
      'to move, file, or relocate a document. Use the document_id from a search / ' +
      'list_matter_contents result and the destination matter UUID from list_matters. After ' +
      'calling it, say you have proposed the move for their confirmation — never say it has ' +
      'been moved.',
    input_schema: {
      type: 'object',
      properties: {
        document_id: { type: 'string', description: 'UUID of the document to move.' },
        target_matter_id: { type: 'string', description: 'Destination matter UUID (from list_matters).' },
      },
      required: ['document_id', 'target_matter_id'],
      additionalProperties: false,
    },
  },
];

// Feedback relay (early-adopter loop). A server-executed tool: the loop inserts
// one row into `orchestrator_feedback` through the USER-scoped Supabase client,
// so RLS attributes it to the signed-in user (user_id defaults to auth.uid()).
// The model supplies only the wording and a category; the situational context
// (route, tab, matter) is stamped server-side from what we already know.
const FEEDBACK_TOOL = {
  name: 'relay_feedback',
  description:
    'Pass a piece of product feedback about Contextspaces back to the team. Call this ONLY ' +
    'when the user has voiced a suggestion, a frustration, a point of confusion, or praise ' +
    'about the app ITSELF (not a question about their documents) AND has agreed to have it ' +
    'passed along. Capture their point in their own words. Do NOT call it for ordinary ' +
    'questions, for document content, or for passing remarks. After calling it, tell them it ' +
    'has been passed to the team — never promise whether or when it will ship.',
  input_schema: {
    type: 'object',
    properties: {
      body: { type: 'string', description: "The feedback, in the user's own words (one to a few sentences)." },
      category: {
        type: 'string',
        enum: ['idea', 'bug', 'confusion', 'praise', 'other'],
        description: 'Best-fit category for the feedback.',
      },
    },
    required: ['body'],
    additionalProperties: false,
  },
};

const FEEDBACK_CATEGORIES = new Set(['idea', 'bug', 'confusion', 'praise', 'other']);

// Map the allowed mcp-core tools to the neutral tool shape. The only
// difference is the schema field name: mcp-core uses `inputSchema`, the
// drivers expect `input_schema` (the Messages API name, which the OpenAI-
// compatible driver translates to `parameters`).
export function toAnthropicTools() {
  return TOOLS
    .filter((t) => ALLOWED_TOOLS.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
}

/**
 * Run the assistant for one user turn, streaming events to `emit`.
 * Never throws — failures are reported via an `{type:'error'}` event.
 *
 * Events emitted:
 *   { type: 'session', sessionId, tier, provider, model, escalation }
 *                              — first, once the pen is chosen (sessionId is
 *                                null for matter-less chats, which are not
 *                                recorded)
 *   { type: 'text',  text }   — a delta of the answer, in order
 *   { type: 'tool',  name }   — a tool is about to run (status only)
 *   { type: 'action' | 'confirm', ... } — browser-executed steps (see above)
 *   { type: 'error', message, code? }
 *
 * `context` (optional): { route, tab, matterName } — where the user is in the
 * app, rendered into the system prompt's CURRENT CONTEXT block.
 * `sessionId` (optional): continue an existing ai_sessions row; otherwise a
 * new session is opened for the matter. `escalate` (optional, Tier B only):
 * use the frontier pen for this turn — recorded as an escalation.
 *
 * @returns {Promise<{usedTools:string[], sessionId:string|null, provider?:string, model?:string, tier?:string, usage?:{input:number,output:number}}>}
 */
export async function runAssistantStream({
  supabase, anthropicKey, fireworksKey, openaiApiKey,
  messages, matterId, context, emit, sessionId, escalate,
}) {
  const usedTools = [];
  const ledger = { session: null, seq: 0 };
  let pen = null;
  let tier = null;
  const usage = { input: 0, output: 0 };
  let answer = '';
  let rounds = 0;

  try {
    // Seed the conversation from chat history (text only).
    const convo = (messages || [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => (m.role === 'user'
        ? { role: 'user', text: m.content }
        : { role: 'assistant', blocks: [{ type: 'text', text: m.content }] }));
    // The first message must be `user` — drop any leading assistant turns
    // (e.g. the panel's welcome message).
    while (convo.length && convo[0].role === 'assistant') convo.shift();
    if (convo.length === 0) throw new Error('no messages');
    const lastUser = [...convo].reverse().find((m) => m.role === 'user');

    // ── The tier decides the pen; the ledger opens before any model is called.
    if (matterId) {
      tier = await matterTierWithClient(supabase, matterId);
      if (!tier) throw new AssistantRefusal('matter_not_found', "I can't find that matter, or you don't have access to it.");
      ledger.session = await ensureSession(supabase, { sessionId, matterId, tier, title: lastUser?.text });
      if (ledger.session) {
        ledger.seq = await nextSeq(supabase, ledger.session.id);
        await appendMessage(supabase, {
          session_id: ledger.session.id, seq: ledger.seq++, role: 'user',
          content: { text: lastUser?.text ?? '' },
        });
      }
    }
    pen = choosePen({ tier, anthropicKey, fireworksKey, escalate: escalate === true });
    emit({
      type: 'session',
      sessionId: ledger.session?.id ?? null,
      tier: tier ?? 'A',
      provider: pen.provider,
      model: pen.model,
      escalation: pen.escalation,
    });

    const tools = [...toAnthropicTools(), ...CLIENT_ACTION_TOOLS, ...CONFIRM_ACTION_TOOLS, FEEDBACK_TOOL];
    const today = new Date().toISOString().slice(0, 10);
    let system = buildOrchestratorSystem({ matterId, today, ...(context || {}) });
    if (isSealedTier(tier)) {
      system +=
        '\n\nSECURESPACE: this matter is SEALED (Tier ' + tier + '). You are its sealed pen — ' +
        (pen.escalation
          ? 'this turn runs on the frontier pen as a recorded escalation the user requested. '
          : `${pen.label}. `) +
        'Every exchange here is recorded as privileged attorney work product. If asked, ' +
        'say plainly which pen you are and that the matter is sealed; never suggest taking ' +
        'its contents to an outside AI tool.';
    }

    const driver = pen.provider === 'anthropic' ? anthropicTurn : openaiCompatTurn;
    const onText = (delta) => { answer += delta; emit({ type: 'text', text: delta }); };

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      rounds++;
      const turn = await driver({ pen, system, tools, convo, onText });
      usage.input += turn.usage.input;
      usage.output += turn.usage.output;

      const toolUses = turn.blocks.filter((b) => b.type === 'tool_use');

      // No tool calls → the answer has finished streaming.
      if (turn.stop !== 'tool_use' || toolUses.length === 0) break;

      // Preserve the full assistant turn (raw provider content for faithful replay).
      convo.push({ role: 'assistant', blocks: turn.blocks, raw: turn.raw });

      const results = [];
      for (const tu of toolUses) {
        usedTools.push(tu.name);
        const args = tu.input && typeof tu.input === 'object' ? tu.input : {};

        // Client-executed UI action: forward to the browser, don't run a
        // server tool. The synthetic result lets the model confirm.
        if (CLIENT_ACTIONS.has(tu.name)) {
          emit({ type: 'action', action: tu.name, input: args });
          results.push({ tool_use_id: tu.id, content: JSON.stringify({ status: 'opened' }) });
          continue;
        }

        // Confirm-required write: forward for the user to confirm in a dialog;
        // the browser performs it only on their OK. Never executed here.
        if (CONFIRM_ACTIONS.has(tu.name)) {
          emit({ type: 'confirm', action: tu.name, input: args });
          results.push({ tool_use_id: tu.id, content: JSON.stringify({ status: 'awaiting_confirmation' }) });
          continue;
        }

        // Feedback relay: insert one row server-side through the user-scoped
        // client. The model gives the wording; we stamp the context we know.
        if (tu.name === 'relay_feedback') {
          emit({ type: 'tool', name: tu.name });
          const body = typeof args.body === 'string' ? args.body.trim() : '';
          if (!body) {
            results.push({ tool_use_id: tu.id, content: 'Error: feedback body was empty.', is_error: true });
            continue;
          }
          const row = {
            body: body.slice(0, 5000),
            category: FEEDBACK_CATEGORIES.has(args.category) ? args.category : 'other',
            route: context?.route ?? null,
            tab: context?.tab ?? null,
            matterspace_id: matterId ?? null,
            matter_name: context?.matterName ?? null,
          };
          const { error } = await supabase.from('orchestrator_feedback').insert(row);
          // Mirror onto the Practice Docket: the feedback ALSO lands as a
          // first-class note in the Contextspaces admin thread's chronology
          // — the surface that actually gets reviewed. Without this mirror
          // the table above is a mailbox nobody opens. Best-effort: a user
          // without access to the admin matter still files the row above.
          if (!error) {
            try {
              const { data: admin } = await supabase
                .from('matterspaces')
                .select('id')
                .eq('short_code', 'contextspaces')
                .maybeSingle();
              if (admin) {
                await supabase.from('matter_state_events').insert({
                  matterspace_id: admin.id,
                  event_type: 'note',
                  payload: {
                    text: `[feedback · ${row.category}] ${row.body}`,
                    source: 'orchestrator_feedback',
                    route: row.route,
                    from_matter: row.matter_name,
                  },
                });
              }
            } catch { /* mirror is best-effort by design */ }
          }
          results.push({
            tool_use_id: tu.id,
            content: error ? `Error saving feedback: ${error.message}` : JSON.stringify({ status: 'received' }),
            is_error: Boolean(error),
          });
          continue;
        }

        emit({ type: 'tool', name: tu.name });
        if (!ALLOWED_TOOLS.has(tu.name)) {
          results.push({ tool_use_id: tu.id, content: `Error: tool "${tu.name}" is not available.`, is_error: true });
          continue;
        }
        const scoped = matterId && MATTER_SCOPED_TOOLS.has(tu.name) && !args.matter
          ? { ...args, matter: matterId }
          : args;
        try {
          const out = await callTool(supabase, tu.name, scoped, { openaiApiKey });
          results.push({
            tool_use_id: tu.id,
            content: JSON.stringify(out).slice(0, TOOL_RESULT_CHAR_CAP),
          });
        } catch (err) {
          results.push({ tool_use_id: tu.id, content: `Error: ${err.message}`, is_error: true });
        }
      }
      convo.push({ role: 'tool_results', results });

      if (i === MAX_ITERATIONS - 1) {
        onText('\n\n(I reached the step limit — try narrowing the question to a specific point.)');
      }
    }

    await recordAssistant(supabase, ledger, { pen, tier, answer, usedTools, rounds, usage });
    return {
      usedTools, sessionId: ledger.session?.id ?? null,
      provider: pen.provider, model: pen.model, tier: tier ?? 'A', usage,
    };
  } catch (err) {
    const code = err instanceof AssistantRefusal ? err.code : undefined;
    emit({ type: 'error', message: err?.message || 'assistant_failed', ...(code ? { code } : {}) });
    await recordAssistant(supabase, ledger, {
      pen, tier, answer, usedTools, rounds, usage,
      error: { code: code ?? 'assistant_failed', message: err?.message || 'assistant_failed' },
    });
    return { usedTools, sessionId: ledger.session?.id ?? null, provider: pen?.provider, model: pen?.model, tier: tier ?? 'A', usage };
  }
}

/**
 * Non-streaming convenience wrapper: collects the streamed answer into a
 * single string. Throws only when an error occurs before any answer text.
 * @returns {Promise<{text:string, usedTools:string[]}>}
 */
export async function runAssistant(opts) {
  let text = '';
  let errMsg = null;
  const { usedTools } = await runAssistantStream({
    ...opts,
    emit: (ev) => {
      if (ev.type === 'text') text += ev.text;
      else if (ev.type === 'error') errMsg = ev.message;
    },
  });
  if (errMsg && !text.trim()) throw new Error(errMsg);
  return { text: text.trim() || 'I could not produce an answer for that.', usedTools };
}


// -----------------------------------------------------------------------------
// The ledger — ai_sessions / ai_messages (migration 051), user-scoped
// -----------------------------------------------------------------------------
// Best-effort by design: a ledger hiccup must never swallow the answer (the
// failure is logged server-side). RLS: the session's owner is auth.uid(); a
// session is only ever continued by its owner in its own matter.

async function ensureSession(supabase, { sessionId, matterId, tier, title }) {
  try {
    if (sessionId) {
      const { data } = await supabase
        .from('ai_sessions')
        .select('id, matterspace_id, tier, status')
        .eq('id', sessionId)
        .maybeSingle();
      if (data && data.matterspace_id === matterId && data.status === 'open') {
        supabase.from('ai_sessions').update({ updated_at: new Date().toISOString() }).eq('id', data.id)
          .then(() => {}, () => {});
        return data;
      }
    }
    const { data, error } = await supabase
      .from('ai_sessions')
      .insert({
        matterspace_id: matterId,
        tier,
        title: (typeof title === 'string' && title.trim() ? title.trim() : 'New session').slice(0, 120),
      })
      .select('id, matterspace_id, tier, status')
      .single();
    if (error) { console.warn('[assistant ledger] open session failed:', error.message); return null; }
    return data;
  } catch (err) {
    console.warn('[assistant ledger] open session failed:', err?.message || err);
    return null;
  }
}

async function nextSeq(supabase, sessionId) {
  try {
    const { data } = await supabase
      .from('ai_messages')
      .select('seq')
      .eq('session_id', sessionId)
      .order('seq', { ascending: false })
      .limit(1);
    return data?.length ? (data[0].seq ?? -1) + 1 : 0;
  } catch {
    return 0;
  }
}

async function appendMessage(supabase, row) {
  try {
    const { error } = await supabase.from('ai_messages').insert(row);
    if (error) console.warn('[assistant ledger] append failed:', error.message);
  } catch (err) {
    console.warn('[assistant ledger] append failed:', err?.message || err);
  }
}

function estimateCost(pen, usage) {
  if (!pen?.pricePerM) return null;
  const usd = (usage.input * pen.pricePerM.input + usage.output * pen.pricePerM.output) / 1e6;
  return Math.round(usd * 10_000) / 10_000;
}

async function recordAssistant(supabase, ledger, { pen, tier, answer, usedTools, rounds, usage, error }) {
  if (!ledger.session) return;
  const content = {
    text: answer,
    used_tools: usedTools,
    rounds,
    ...(pen?.escalation ? { escalation: true } : {}),
    ...(error ? { error } : {}),
  };
  await appendMessage(supabase, {
    session_id: ledger.session.id,
    seq: ledger.seq++,
    role: 'assistant',
    content,
    model: pen?.model ?? null,
    provider: pen?.provider ?? null,
    input_tokens: usage.input || null,
    output_tokens: usage.output || null,
    estimated_cost: pen ? estimateCost(pen, usage) : null,
    // Within policy = the pen the tier permits. A refusal (no pen) is, by
    // construction, within policy: nothing was sent anywhere.
    within_policy: pen ? providerAllowed(tier ?? 'A', pen.provider) : true,
  });
}


// -----------------------------------------------------------------------------
// Drivers — the only provider-specific code in the assistant
// -----------------------------------------------------------------------------
// Both take { pen, system, tools, convo, onText } and return
//   { blocks: [{type:'text',text} | {type:'tool_use',id,name,input}],
//     stop: 'tool_use' | 'end', usage: {input, output}, raw }
// `convo` is the neutral history: {role:'user', text} | {role:'assistant',
// blocks, raw?} | {role:'tool_results', results:[{tool_use_id, content,
// is_error?}]}. `raw` is the provider's own assistant payload, replayed
// verbatim on the same provider (keeps Claude's thinking blocks / Kimi's
// reasoning intact across tool rounds).

/** Anthropic Messages API, via the official SDK. */
async function anthropicTurn({ pen, system, tools, convo, onText }) {
  const client = new Anthropic({ apiKey: pen.apiKey });
  const messages = [];
  for (const m of convo) {
    if (m.role === 'user') {
      messages.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: m.raw?.provider === 'anthropic' ? m.raw.content : toAnthropicContent(m.blocks),
      });
    } else if (m.role === 'tool_results') {
      messages.push({
        role: 'user',
        content: m.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.tool_use_id,
          content: r.content,
          ...(r.is_error ? { is_error: true } : {}),
        })),
      });
    }
  }
  const stream = client.messages.stream({
    model: pen.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    thinking: { type: 'adaptive' },
    system,
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    messages,
  });
  // Forward answer text as it streams. (Thinking deltas are not surfaced.)
  stream.on('text', onText);
  const msg = await stream.finalMessage();
  const blocks = [];
  for (const b of msg.content) {
    if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
  }
  return {
    blocks,
    stop: msg.stop_reason === 'tool_use' ? 'tool_use' : 'end',
    usage: { input: msg.usage?.input_tokens ?? 0, output: msg.usage?.output_tokens ?? 0 },
    raw: { provider: 'anthropic', content: msg.content },
  };
}

function toAnthropicContent(blocks) {
  const out = blocks.map((b) => (b.type === 'text'
    ? { type: 'text', text: b.text }
    : { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} }));
  // Anthropic rejects empty text blocks; an assistant turn must carry something.
  const kept = out.filter((b) => b.type !== 'text' || (b.text && b.text.trim()));
  return kept.length ? kept : [{ type: 'text', text: '(no content)' }];
}

const OPENAI_COMPAT_URLS = {
  fireworks: 'https://api.fireworks.ai/inference/v1/chat/completions',
};

/** OpenAI-compatible chat completions with tools, streamed (Fireworks / Kimi). */
async function openaiCompatTurn({ pen, system, tools, convo, onText }) {
  const url = OPENAI_COMPAT_URLS[pen.provider];
  if (!url) throw new Error(`no chat-completions route for provider ${pen.provider}`);

  const messages = [{ role: 'system', content: system }];
  for (const m of convo) {
    if (m.role === 'user') {
      messages.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant') {
      const text = m.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = m.blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      const am = { role: 'assistant', content: text || (calls.length ? null : '(no content)') };
      if (calls.length) am.tool_calls = calls;
      // Kimi's thinking models expect their own reasoning echoed back across
      // tool rounds; harmless for providers that ignore it.
      if (m.raw?.provider === pen.provider && m.raw.reasoning_content) am.reasoning_content = m.raw.reasoning_content;
      messages.push(am);
    } else if (m.role === 'tool_results') {
      for (const r of m.results) messages.push({ role: 'tool', tool_call_id: r.tool_use_id, content: r.content });
    }
  }

  const body = {
    model: pen.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: MAX_OUTPUT_TOKENS + (pen.thinkingHeadroom ?? 0),
    tools: tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    })),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${pen.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`${pen.label} returned ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  let text = '';
  let reasoning = '';
  let finish = null;
  let usage = null;
  const calls = new Map(); // index → { id, name, args }
  for await (const data of sseDataLines(res.body)) {
    if (data === '[DONE]') break;
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }
    if (ev.usage) usage = ev.usage;
    const choice = ev.choices?.[0];
    if (!choice) continue;
    const d = choice.delta || {};
    if (typeof d.content === 'string' && d.content) { text += d.content; onText(d.content); }
    if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? 0;
        const cur = calls.get(idx) || { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name && !cur.name) cur.name = tc.function.name;
        if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments;
        calls.set(idx, cur);
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }

  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  let n = 0;
  for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    let input = {};
    try { input = c.args ? JSON.parse(c.args) : {}; } catch { input = { _unparsed_arguments: c.args }; }
    blocks.push({ type: 'tool_use', id: c.id || `call_${Date.now().toString(36)}_${n}`, name: c.name, input });
    n++;
  }
  return {
    blocks,
    stop: finish === 'tool_calls' || calls.size > 0 ? 'tool_use' : 'end',
    usage: { input: usage?.prompt_tokens ?? 0, output: usage?.completion_tokens ?? 0 },
    raw: { provider: pen.provider, reasoning_content: reasoning || undefined },
  };
}

/** Yield the payload of each `data:` line of an SSE body (web ReadableStream). */
async function* sseDataLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  if (buf.startsWith('data:')) yield buf.slice(5).trim();
}
