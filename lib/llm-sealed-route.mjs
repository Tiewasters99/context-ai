// The sealed route for /api/llm — how a browser LLM call reaches the sealed
// pen without leaving the seal.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// SecureSpace Tier B admits exactly one provider: 'aws-bedrock' — a model in
// our own AWS account under account data_retention_mode=none
// (lib/ai-tier-policy.mjs). Sealed CHAT already had that route
// (lib/assistant-core.mjs, PR #149). /api/llm — the browser-side passthrough
// behind Bucketizer, cite-check, the Editor and Moot Bench — did not, so
// after PR #159 narrowed Tier B every one of those features refused on a
// sealed matter. They used to "work" there only by sending the matter's text
// to api.anthropic.com or Fireworks, which is the behaviour #159 closed.
//
// This module is the missing route. The browser keeps asking for its
// feature's default pen; the SERVER — the only side that can read the
// matter's tier — substitutes the sealed one and translates the wire shape
// in both directions, so no call site has to learn Bedrock.
//
// WHAT IT PROMISES
// ---------------------------------------------------------------------------
//   * A Tier-B request is served by the sealed pen or REFUSED. It is never
//     forwarded to the provider the client named, and never to a third one.
//   * A request whose shape cannot be faithfully translated is refused, not
//     mangled — see `translateRequest` (image/content-block messages and
//     Gemini's `contents` shape both land here).
//   * The sealed pen's own failure is reported in the product's voice
//     (`sealed_pen_error`), never as a raw AWS status or body.
//   * Exactly one upstream request per call. There is no retry and no second
//     provider to retry onto.
//   * The substituted request stays inside the caller's PLAN as well as
//     inside the seal: /api/llm hands `send()` the tier's max_tokens ceiling
//     (migration 063) and it is applied on top of this module's own, so a
//     sealed turn cannot out-spend the unsealed one it replaced. The caller
//     also reads `pen` and `maxOutputTokens` back off the route so the spend
//     meter can charge the turn at the PEN's price — before the substitution
//     that was priced as the model the browser named, ~8× too high.
//
// WHAT IT REUSES
// ---------------------------------------------------------------------------
// The credentials reader, the pen selection (BEDROCK_MODEL) and BOTH refusal
// messages come from lib/assistant-core.mjs, and the SigV4 signer from
// lib/aws-sigv4.mjs — there is exactly one signer in this codebase and
// exactly one wording for a sealed refusal. `openaiCompatTurn`/`bedrockTurn`
// are deliberately NOT reused: they speak the Assistant's own convo shape and
// pin max_tokens to the chat loop's budget, neither of which fits a
// passthrough. assistant-core.mjs is imported, not edited.
//
// Cost worth knowing: importing assistant-core pulls @anthropic-ai/sdk and
// lib/mcp-core.mjs into the /api/llm bundle. A ~20-line extraction of
// bedrockCredsFromEnv/bedrockPenFor/the two messages into their own module
// would fix that; it is assistant-core surgery this lane was told not to do.

import { providerAllowed } from './ai-tier-policy.mjs';
import {
  bedrockCredsFromEnv,
  bedrockPenFor,
  sealedPenUnavailableMessage,
  sealedPenErrorMessage,
} from './assistant-core.mjs';
import { signRequest } from './aws-sigv4.mjs';
import { applyPenPreamble } from './pen-preambles.mjs';

/** The one provider Tier B admits. */
export const SEALED_PROVIDER = 'aws-bedrock';

/**
 * Extra output budget for a forced-tool (structured) call on the chat route.
 * Kimi's thinking pass spends from max_tokens, so a budget sized for the tool
 * payload alone dies with finish_reason=length before the model ever files.
 * 12,000 is the value live-probed against Moonshot's own API for exactly this
 * case (src/lib/llm/adapters.ts, moonshotAdapter) — the same weights, a
 * different host. NOT verified against bedrock-mantle.
 */
const THINKING_HEADROOM_TOKENS = 12_000;

/**
 * Ceiling on the translated max_tokens. A guard, not a policy: a client that
 * already added its own thinking headroom (the Editor's Kimi route) would
 * otherwise have it added twice. The assistant path runs 12,192 on this pen
 * live; this ceiling itself is UNVERIFIED against bedrock-mantle.
 *
 * The PLAN's ceiling (migration 063, lib/usage-meter.mjs) is a second,
 * independent cap applied on top of this one: /api/llm passes it to `send()`
 * and it is the lower of the two that reaches Bedrock. Kept separate because
 * they answer different questions — this one is "what does the pen tolerate",
 * the plan's is "what has this user paid for".
 */
const SEALED_MAX_OUTPUT_TOKENS = 32_000;

/**
 * Kimi's always-on thinking is incompatible with a NAMED tool_choice
 * ("specified") on Moonshot's own API — live-probed 2026-08-18, see
 * moonshotAdapter. We only ever offer one tool, so 'required' forces the same
 * choice. Whether bedrock-mantle accepts 'required' is UNVERIFIED; if the
 * first sealed classify comes back 400 on tool_choice, this constant is the
 * one line to change.
 */
const FORCED_TOOL_CHOICE = 'required';

/** Which wire shape the client built its body in, by the provider it named. */
function clientShape(provider) {
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'openai' || provider === 'xai' || provider === 'moonshot' || provider === 'fireworks') return 'openai';
  return null; // google's generateContent shape, or anything unknown
}

function refusal(status, body) {
  return { refusal: { status, body } };
}

function untranslatableMessage(provider) {
  return (
    'This matter is sealed (SecureSpace Tier B), and this request cannot be carried to the ' +
    'sealed pen unchanged. Nothing was sent: the request was not handed to ' +
    `${provider || 'another provider'}, and no part of this matter left the room. Try the same ` +
    'step with a text-only prompt and a Claude or OpenAI model, or unseal the matter.'
  );
}

/**
 * Decide what a /api/llm request does once the gate has spoken.
 *
 * Returns:
 *   null                      — not a sealed substitution; the caller proceeds
 *                               exactly as it did before (Tier A and Tier C
 *                               are untouched).
 *   { refusal: {status, body} } — refuse, in plain language.
 *   { pen, maxOutputTokens, send() }
 *                             — the sealed route. `send()` performs exactly
 *                               one signed request and resolves to a web
 *                               Response already translated into the shape
 *                               the caller's client parses, so the existing
 *                               passthrough can pipe it unchanged. It takes
 *                               an optional `{ maxOutputTokens }` ceiling —
 *                               the caller's plan limit — and `pen` +
 *                               `maxOutputTokens` are what the caller needs to
 *                               price the turn BEFORE it is sent, at the rate
 *                               of the model that will actually answer.
 *
 * The gate stays the enforcement point: this is only ever consulted on a
 * refusal it already issued, and the substituted provider is re-checked
 * against the same `providerAllowed` the gate uses.
 *
 * `preamble` (default true) is the pen's own preamble, prepended to whatever
 * system prompt the feature supplied (lib/pen-preambles.mjs). The ONLY caller
 * that passes false is scripts/eval-sealed-pen.mjs, whose whole job is to
 * measure the difference it makes; api/llm.mjs never passes it, and
 * scripts/_verify-sealed-preamble.mjs asserts that by reading the source. It
 * is deliberately a parameter and not an environment variable: a switch that
 * could turn the preamble off in production, from a dashboard, without a
 * deploy, is a way for a sealed matter to quietly lose its instructions.
 */
export function sealedRouteFor({ gate, provider, model, body, env = process.env, preamble = true }) {
  if (!gate || gate.ok) return null;
  // Only ever a Tier-B provider refusal. A 401, a 404, a Tier-C refusal and a
  // Tier-A refusal (the Moonshot sandbox is not permitted on any matter) all
  // pass straight through as they did before.
  if (gate.error !== 'tier_violation' || gate.tier !== 'B') return null;

  // Fail closed. If the policy ever stops admitting aws-bedrock on B there is
  // no sealed route to substitute, and the honest answer is the gate's own.
  if (!providerAllowed('B', SEALED_PROVIDER)) return null;

  // Substitute only for a provider the policy would permit on an UNSEALED
  // matter. Without this, sealing a matter would make it MORE permissive than
  // leaving it open: the Moonshot sandbox (api.moonshot.ai — Singapore entity,
  // API data may be used for training) is refused on every matter-bound call,
  // Tier A included, and a request naming it must keep being refused rather
  // than quietly becoming a sealed-pen request. The seal narrows what a matter
  // can reach; it never widens it.
  if (!providerAllowed('A', provider)) return null;

  // Credentials before shape, so an unprovisioned server gives the same
  // answer here as choosePen gives sealed chat.
  const creds = bedrockCredsFromEnv(env);
  if (!creds) {
    return refusal(503, {
      error: 'sealed_pen_unavailable',
      tier: 'B',
      message: sealedPenUnavailableMessage(env),
    });
  }

  const shape = clientShape(provider);
  const parsed = shape ? safeJsonParse(body) : null;
  const neutral = parsed ? translateRequest(shape, parsed) : null;
  if (!neutral) {
    return refusal(403, {
      error: 'sealed_route_untranslatable',
      tier: 'B',
      provider,
      message: untranslatableMessage(provider),
    });
  }

  const pen = bedrockPenFor(creds);
  // The pen's preamble goes on the NEUTRAL request, at the single point where
  // both wire shapes have already been unified — so it reaches the chat route
  // (as the leading system message) and the Messages route (as `system`)
  // identically, and a third client shape would inherit it for free. The
  // feature's own prompt is byte-identical after the separator; where the
  // feature sent no system prompt at all, the preamble becomes the whole of
  // it, which is the one case where the sealed pen would otherwise be told
  // nothing whatsoever.
  if (preamble !== false) neutral.system = applyPenPreamble(neutral.system, pen.preamble);
  return {
    pen,
    provider: SEALED_PROVIDER,
    /** Which pen-owned instructions this call will carry, for the Record. */
    preambleVersion: (preamble !== false && pen.preamble?.version) || null,
    /**
     * The output allowance this request will ask the sealed pen for, before
     * the caller's own plan ceiling. Exposed so /api/llm can pre-charge the
     * turn against the budget on what is actually about to be requested, at
     * the PEN's price — not at the price of the model the browser named.
     */
    maxOutputTokens: sealedMaxTokens(neutral, penRoute(pen)),
    send: (opts) => sendSealed({ pen, creds, neutral, shape, env, ceiling: opts?.maxOutputTokens ?? null }),
  };
}

/** Which of the two bedrock-mantle routes this pen rides. */
function penRoute(pen) {
  return pen?.route === 'messages' ? 'messages' : 'chat';
}

// ── request translation ─────────────────────────────────────────────────────
// Client shape → a neutral request → the Bedrock route's shape. Two hops
// rather than one so each new client shape costs one parser, not one parser
// per Bedrock route.
//
// A neutral request is:
//   { system, messages: [{role:'user'|'assistant', content: string}],
//     maxTokens, stream, tools?: [{name, description, parameters}],
//     forcedTool?: string }
//
// Anything that does not fit it — a content-block array (images, documents,
// tool results), Gemini's `contents`, a message with non-string content —
// returns null and is refused rather than approximated.

function translateRequest(shape, obj) {
  if (!obj || typeof obj !== 'object') return null;
  return shape === 'anthropic' ? fromAnthropicRequest(obj) : fromOpenAIRequest(obj);
}

function plainMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') return null;
    // A content-block array is how images, PDFs and tool results travel. The
    // sealed pen's chat route takes none of them through this passthrough, and
    // a silent flatten would send a lawyer a confident answer about a document
    // the model never saw.
    if (typeof m.content !== 'string') return null;
    if (m.role !== 'user' && m.role !== 'assistant') return null;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

function fromAnthropicRequest(obj) {
  const messages = plainMessages(obj.messages);
  if (!messages) return null;
  if (obj.system != null && typeof obj.system !== 'string') return null; // system blocks
  let tools = null;
  if (obj.tools != null) {
    if (!Array.isArray(obj.tools)) return null;
    tools = obj.tools.map((t) => ({ name: t?.name, description: t?.description, parameters: t?.input_schema }));
    if (tools.some((t) => !t.name || !t.parameters)) return null;
  }
  const forcedTool =
    obj.tool_choice && obj.tool_choice.type === 'tool' && typeof obj.tool_choice.name === 'string'
      ? obj.tool_choice.name
      : null;
  return {
    system: typeof obj.system === 'string' ? obj.system : '',
    messages,
    maxTokens: numberOr(obj.max_tokens, 4096),
    stream: obj.stream === true,
    tools,
    forcedTool,
  };
}

function fromOpenAIRequest(obj) {
  if (!Array.isArray(obj.messages)) return null;
  const system = obj.messages
    .filter((m) => m?.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : null))
    .join('\n\n');
  if (obj.messages.some((m) => m?.role === 'system' && typeof m.content !== 'string')) return null;
  const messages = plainMessages(obj.messages.filter((m) => m?.role !== 'system'));
  if (!messages) return null;
  let tools = null;
  if (obj.tools != null) {
    if (!Array.isArray(obj.tools)) return null;
    tools = obj.tools.map((t) => ({
      name: t?.function?.name,
      description: t?.function?.description,
      parameters: t?.function?.parameters,
    }));
    if (tools.some((t) => !t.name || !t.parameters)) return null;
  }
  const tc = obj.tool_choice;
  const forcedTool =
    tc && typeof tc === 'object' && typeof tc.function?.name === 'string'
      ? tc.function.name
      : tc === 'required' || tc === 'any'
        ? (tools?.[0]?.name ?? null)
        : null;
  return {
    system,
    messages,
    maxTokens: numberOr(obj.max_completion_tokens ?? obj.max_tokens, 4096),
    stream: obj.stream === true,
    tools,
    forcedTool,
  };
}

/**
 * Output budget for the sealed request. See the two constants above.
 * `ceiling` is the caller's plan limit (migration 063) and applies last, so
 * the substituted request can never out-spend the plan the unsealed one was
 * held to. A free-tier ceiling below THINKING_HEADROOM_TOKENS will cut into
 * Kimi's thinking pass on a forced-tool call — that is the plan's decision to
 * make, and it surfaces as a sealed_pen_error rather than as a silent
 * overspend.
 */
function sealedMaxTokens(neutral, route, ceiling = null) {
  const headroom = route === 'chat' && neutral.forcedTool ? THINKING_HEADROOM_TOKENS : 0;
  const want = Math.min(neutral.maxTokens + headroom, SEALED_MAX_OUTPUT_TOKENS);
  return ceiling > 0 ? Math.min(want, ceiling) : want;
}

/**
 * The OpenAI-compatible chat route on bedrock-mantle — the sealed pen today
 * (Kimi K2.5). Always streamed upstream: the streaming shape is the one the
 * Assistant exercises live, and a non-streaming client is served by
 * accumulating it here. That also keeps "exactly one request" true for both
 * kinds of caller.
 */
function renderChatBody(neutral, pen, ceiling = null) {
  const messages = [];
  if (neutral.system) messages.push({ role: 'system', content: neutral.system });
  for (const m of neutral.messages) messages.push(m);
  const body = {
    model: pen.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: sealedMaxTokens(neutral, 'chat', ceiling),
  };
  // No temperature, ever: Kimi rejects any value but 1 (adapters.ts).
  if (neutral.tools?.length) {
    body.tools = neutral.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    if (neutral.forcedTool) body.tool_choice = FORCED_TOOL_CHOICE;
  }
  return body;
}

/**
 * The Anthropic Messages route on bedrock-mantle — used when BEDROCK_MODEL is
 * an `anthropic.*` id. Deliberately sends NO `thinking` block (unlike the
 * Assistant's bedrockTurn): extended thinking is incompatible with a named
 * tool_choice, and no caller here asked for it.
 */
function renderMessagesBody(neutral, pen, ceiling = null) {
  const body = {
    model: pen.model,
    max_tokens: sealedMaxTokens(neutral, 'messages', ceiling),
    stream: true,
    messages: neutral.messages,
  };
  if (neutral.system) body.system = neutral.system;
  if (neutral.tools?.length) {
    body.tools = neutral.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    if (neutral.forcedTool) body.tool_choice = { type: 'tool', name: neutral.forcedTool };
  }
  return body;
}

// ── the one request ─────────────────────────────────────────────────────────

async function sendSealed({ pen, creds, neutral, shape, env, ceiling = null }) {
  const route = penRoute(pen);
  const url =
    route === 'messages'
      ? `https://bedrock-mantle.${creds.region}.api.aws/anthropic/v1/messages`
      : `https://bedrock-mantle.${creds.region}.api.aws/v1/chat/completions`;
  const bodyText = JSON.stringify(
    route === 'messages' ? renderMessagesBody(neutral, pen, ceiling) : renderChatBody(neutral, pen, ceiling),
  );
  const headers = signRequest({
    method: 'POST',
    url,
    headers:
      route === 'messages'
        ? { 'content-type': 'application/json', accept: 'text/event-stream', 'anthropic-version': '2023-06-01' }
        : { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: bodyText,
    region: creds.region,
    service: 'bedrock-mantle',
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  });

  let upstream;
  try {
    upstream = await fetch(url, { method: 'POST', headers, body: bodyText });
  } catch (err) {
    return penErrorResponse(`${pen.label}: ${err?.message || 'request failed'}`, env);
  }
  if (!upstream.ok || !upstream.body) {
    // The provider's status and body never reach the browser: a sealed matter
    // gets the product's voice, and the AWS detail is developer-only.
    const detail = await upstream.text().catch(() => '');
    return penErrorResponse(`${pen.label} returned ${upstream.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`, env);
  }

  const events = route === 'messages' ? messagesEvents(upstream.body) : chatEvents(upstream.body);
  return neutral.stream
    ? streamResponse(events, shape, pen)
    : jsonResponse(events, shape, pen, env);
}

function penErrorResponse(detail, env) {
  return jsonBodyResponse(502, {
    error: 'sealed_pen_error',
    tier: 'B',
    message: sealedPenErrorMessage(detail, env),
  });
}

function jsonBodyResponse(status, obj, pen = null) {
  const headers = { 'content-type': 'application/json' };
  if (pen) headers['x-contextspaces-pen'] = pen.label;
  return new Response(JSON.stringify(obj), { status, headers });
}

// ── reading the sealed pen ──────────────────────────────────────────────────
// Each reader yields neutral events:
//   { type: 'text', text }
//   { type: 'end', text, toolCalls: [{id, name, input}], usage: {input, output}, stop }
// A tool call whose arguments do not parse is DROPPED, never guessed: the
// Assistant's own driver keeps `_unparsed_arguments` because a tool loop can
// recover, but Bucketizer would try to render that as a bucket tree. The
// client's existing "did not return structured output" is the honest answer.

async function* chatEvents(body) {
  let text = '';
  let usage = null;
  let finish = null;
  const calls = new Map();
  for await (const data of sseDataLines(body)) {
    if (data === '[DONE]') break;
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }
    if (ev.usage) usage = ev.usage;
    const choice = ev.choices?.[0];
    if (!choice) continue;
    const d = choice.delta || {};
    if (typeof d.content === 'string' && d.content) {
      text += d.content;
      yield { type: 'text', text: d.content };
    }
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
  yield {
    type: 'end',
    text,
    toolCalls: collectCalls([...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)),
    usage: { input: usage?.prompt_tokens ?? 0, output: usage?.completion_tokens ?? 0 },
    stop: finish === 'tool_calls' || calls.size > 0 ? 'tool_use' : 'end',
  };
}

async function* messagesEvents(body) {
  let text = '';
  const usage = { input: 0, output: 0 };
  const blocks = new Map(); // index → {id, name, args}
  let stop = null;
  for await (const data of sseDataLines(body)) {
    if (!data || data === '[DONE]') continue;
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }
    if (ev.type === 'message_start') {
      usage.input = ev.message?.usage?.input_tokens ?? 0;
      usage.output = ev.message?.usage?.output_tokens ?? 0;
    } else if (ev.type === 'content_block_start') {
      const b = ev.content_block || {};
      if (b.type === 'tool_use') blocks.set(ev.index, { id: b.id ?? '', name: b.name ?? '', args: '' });
      else if (b.type === 'text' && b.text) { text += b.text; yield { type: 'text', text: b.text }; }
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
        text += d.text;
        yield { type: 'text', text: d.text };
      } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        const cur = blocks.get(ev.index);
        if (cur) cur.args += d.partial_json;
      }
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
      if (ev.usage?.output_tokens != null) usage.output = ev.usage.output_tokens;
    }
  }
  yield {
    type: 'end',
    text,
    toolCalls: collectCalls([...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)),
    usage,
    stop: stop === 'tool_use' || blocks.size > 0 ? 'tool_use' : 'end',
  };
}

function collectCalls(raw) {
  const out = [];
  for (const c of raw) {
    if (!c.name) continue;
    let input;
    try { input = c.args ? JSON.parse(c.args) : {}; } catch { continue; } // dropped, never guessed
    out.push({ id: c.id || `call_${out.length}`, name: c.name, input });
  }
  return out;
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

// ── writing what the caller already parses ──────────────────────────────────

function streamResponse(events, shape, pen) {
  const enc = new TextEncoder();
  const sse = (obj) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of events) {
          if (ev.type === 'text') {
            controller.enqueue(
              shape === 'anthropic'
                ? sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ev.text } })
                : sse({ object: 'chat.completion.chunk', model: pen.model, choices: [{ index: 0, delta: { content: ev.text } }] }),
            );
          } else if (ev.type === 'end') {
            if (shape === 'anthropic') {
              controller.enqueue(sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: ev.usage.output } }));
              controller.enqueue(sse({ type: 'message_stop' }));
            } else {
              controller.enqueue(sse({ object: 'chat.completion.chunk', model: pen.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
              controller.enqueue(enc.encode('data: [DONE]\n\n'));
            }
          }
        }
      } catch {
        // The sealed pen dropped mid-stream. The caller has partial text and
        // its own onDone; ending the stream is the truthful close — there is
        // no other provider to finish the sentence.
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-contextspaces-pen': pen.label },
  });
}

async function jsonResponse(events, shape, pen, env) {
  let final = null;
  try {
    for await (const ev of events) if (ev.type === 'end') final = ev;
  } catch (err) {
    return penErrorResponse(`${pen.label}: ${err?.message || 'stream failed'}`, env);
  }
  if (!final) return penErrorResponse(`${pen.label}: the sealed pen sent no completion`, env);

  if (shape === 'anthropic') {
    const content = [];
    if (final.text) content.push({ type: 'text', text: final.text });
    for (const c of final.toolCalls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
    return jsonBodyResponse(200, {
      id: `sealed_${Date.now().toString(36)}`,
      type: 'message',
      role: 'assistant',
      // The model that actually answered, not the one the client asked for.
      model: pen.model,
      content,
      stop_reason: final.stop === 'tool_use' ? 'tool_use' : 'end_turn',
      usage: { input_tokens: final.usage.input, output_tokens: final.usage.output },
    }, pen);
  }
  return jsonBodyResponse(200, {
    id: `sealed_${Date.now().toString(36)}`,
    object: 'chat.completion',
    model: pen.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: final.text || null,
        ...(final.toolCalls.length
          ? {
              tool_calls: final.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.input) },
              })),
            }
          : {}),
      },
      finish_reason: final.stop === 'tool_use' ? 'tool_calls' : 'stop',
    }],
    usage: {
      prompt_tokens: final.usage.input,
      completion_tokens: final.usage.output,
      total_tokens: final.usage.input + final.usage.output,
    },
  }, pen);
}

function numberOr(v, d) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;
}

function safeJsonParse(s) {
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch { return null; }
}

// Exported for scripts/_verify-llm-sealed-route.mjs only.
export const __test = { translateRequest, renderChatBody, renderMessagesBody, clientShape, collectCalls };
