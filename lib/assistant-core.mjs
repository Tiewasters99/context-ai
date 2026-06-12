// In-app Assistant — Milestone 1 / 1.1 ("Answer & Cite", streaming).
//
// A server-side agentic loop that wires Claude to the EXISTING Contextspaces
// search tools (lib/mcp-core.mjs). The model searches the user's current
// matter and answers with page citations. Read-only: no write/ingest tools
// are exposed.
//
// The system prompt is the Orchestrator (lib/orchestrator-system.mjs) — it
// takes per-turn situational context (route, tab, matter name) from the
// browser via the `context` option.
//
// Provider isolation: the only Anthropic-specific surface lives here, mirroring
// how lib/mcp-core.mjs is separate from api/mcp.mjs. Swapping providers later
// means changing this file, not the endpoint or the UI.
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

const MODEL = 'claude-opus-4-8';
const MAX_ITERATIONS = 6;          // bound on tool-call rounds (cost)
const MAX_OUTPUT_TOKENS = 8192;    // streaming, so we can give the answer room
const TOOL_RESULT_CHAR_CAP = 100_000;

// Read-only tools the assistant may use. `file_document` (write/ingest) is
// intentionally excluded.
const ALLOWED_TOOLS = new Set([
  'list_matters',
  'list_matter_contents',
  'search',
  'get_passage',
  'get_outline',
  'grep',
]);

// Tools that take a `matter` argument — when we know the active matter we
// inject it so the model can't accidentally omit or change the scope.
const MATTER_SCOPED_TOOLS = new Set(['search', 'grep', 'list_matter_contents', 'get_outline']);

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

// Map the allowed mcp-core tools to Anthropic's tool shape. The only
// difference is the schema field name: mcp-core uses `inputSchema`, the
// Messages API expects `input_schema`.
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
 *   { type: 'text',  text }   — a delta of the answer, in order
 *   { type: 'tool',  name }   — a tool is about to run (status only)
 *   { type: 'error', message }
 *
 * `context` (optional): { route, tab, matterName } — where the user is in the
 * app, rendered into the system prompt's CURRENT CONTEXT block.
 *
 * @returns {Promise<{usedTools:string[]}>}
 */
export async function runAssistantStream({ supabase, anthropicKey, openaiApiKey, messages, matterId, context, emit }) {
  const usedTools = [];
  try {
    const client = new Anthropic({ apiKey: anthropicKey });
    const tools = [...toAnthropicTools(), ...CLIENT_ACTION_TOOLS, ...CONFIRM_ACTION_TOOLS];
    const system = buildOrchestratorSystem({ matterId, ...(context || {}) });

    // Seed the conversation from chat history (text only).
    const convo = (messages || [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content }));
    // Anthropic requires the first message to be `user` — drop any leading
    // assistant turns (e.g. the panel's welcome message).
    while (convo.length && convo[0].role === 'assistant') convo.shift();
    if (convo.length === 0) throw new Error('no messages');

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        thinking: { type: 'adaptive' },
        system,
        tools,
        messages: convo,
      });
      // Forward answer text as it streams. (Thinking deltas are not surfaced.)
      stream.on('text', (delta) => emit({ type: 'text', text: delta }));
      const msg = await stream.finalMessage();

      const toolUses = msg.content.filter((b) => b.type === 'tool_use');

      // No tool calls → the answer has finished streaming.
      if (msg.stop_reason !== 'tool_use' || toolUses.length === 0) {
        return { usedTools };
      }

      // Preserve the full assistant turn (thinking + tool_use blocks) for the loop.
      convo.push({ role: 'assistant', content: msg.content });

      const results = [];
      for (const tu of toolUses) {
        usedTools.push(tu.name);
        const args = tu.input && typeof tu.input === 'object' ? tu.input : {};

        // Client-executed UI action: forward to the browser, don't run a
        // server tool. The synthetic result lets the model confirm.
        if (CLIENT_ACTIONS.has(tu.name)) {
          emit({ type: 'action', action: tu.name, input: args });
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ status: 'opened' }) });
          continue;
        }

        // Confirm-required write: forward for the user to confirm in a dialog;
        // the browser performs it only on their OK. Never executed here.
        if (CONFIRM_ACTIONS.has(tu.name)) {
          emit({ type: 'confirm', action: tu.name, input: args });
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ status: 'awaiting_confirmation' }) });
          continue;
        }

        emit({ type: 'tool', name: tu.name });
        if (!ALLOWED_TOOLS.has(tu.name)) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: `Error: tool "${tu.name}" is not available.`, is_error: true });
          continue;
        }
        const scoped = matterId && MATTER_SCOPED_TOOLS.has(tu.name) && !args.matter
          ? { ...args, matter: matterId }
          : args;
        try {
          const out = await callTool(supabase, tu.name, scoped, { openaiApiKey });
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(out).slice(0, TOOL_RESULT_CHAR_CAP),
          });
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: `Error: ${err.message}`, is_error: true });
        }
      }
      convo.push({ role: 'user', content: results });
    }

    emit({ type: 'text', text: '\n\n(I reached the step limit — try narrowing the question to a specific point.)' });
    return { usedTools };
  } catch (err) {
    emit({ type: 'error', message: err?.message || 'assistant_failed' });
    return { usedTools };
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
