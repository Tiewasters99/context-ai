// In-app Assistant — Milestone 1 / 1.1 ("Answer & Cite", streaming).
//
// A server-side agentic loop that wires Claude to the EXISTING Contextspaces
// search tools (lib/mcp-core.mjs). The model searches the user's current
// matter and answers with page citations. Read-only: no write/ingest tools
// are exposed.
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

export const SYSTEM_PROMPT = `You are the Contextspaces in-app assistant, embedded in a legal-and-research workspace. You help the user find and understand the contents of the documents in their matter (case / engagement).

How you work:
- When a question depends on what the documents say, SEARCH before answering — use the search and grep tools, then get_passage to read the full text of a promising result before quoting it. Do not answer case-specific questions from prior knowledge; the answer must come from the documents.
- Cite the printed page for every factual claim you draw from a document. The tools return ready-made citation strings (e.g. "Peloso Trial Tr. Day 3, p. 42:11-24") and raw page coordinates — use them. A claim from the record without a page cite is not acceptable.
- If the documents do not contain the answer, say so plainly. Never fabricate a quote, a page number, or a citation.
- Be concise and direct. Answer the question asked; lead with the answer, then the supporting cites.

Matter isolation is a hard rule: only ever search within the matter the user is currently working in. Never search or combine results across different matters.`;

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

function buildSystem(matterId) {
  if (matterId) {
    return `${SYSTEM_PROMPT}

The user is currently working inside the matter with ID "${matterId}". Scope every search to this matter: pass it as the \`matter\` argument. Do not look at any other matter.`;
  }
  return `${SYSTEM_PROMPT}

The user is not inside a specific matter right now. Before searching, call list_matters and ask the user which matter they mean. Do not guess, and do not search across matters.`;
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
 * @returns {Promise<{usedTools:string[]}>}
 */
export async function runAssistantStream({ supabase, anthropicKey, openaiApiKey, messages, matterId, emit }) {
  const usedTools = [];
  try {
    const client = new Anthropic({ apiKey: anthropicKey });
    const tools = toAnthropicTools();
    const system = buildSystem(matterId);

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
        emit({ type: 'tool', name: tu.name });
        let args = tu.input && typeof tu.input === 'object' ? tu.input : {};
        if (!ALLOWED_TOOLS.has(tu.name)) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: `Error: tool "${tu.name}" is not available.`, is_error: true });
          continue;
        }
        if (matterId && MATTER_SCOPED_TOOLS.has(tu.name) && !args.matter) {
          args = { ...args, matter: matterId };
        }
        try {
          const out = await callTool(supabase, tu.name, args, { openaiApiKey });
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
