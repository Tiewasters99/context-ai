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
// SecureSpace (2026-08-22; tightened 2026-09-19): the PEN is chosen by the
// matter's effective tier (lib/ai-tier-policy.mjs), never by the client —
//   A (frontier) → Claude Opus 4.8 (today's behavior);
//   B (sealed)   → a model in OUR OWN AWS account via Bedrock
//                  (bedrock-mantle) under data_retention_mode=none —
//                  contractual zero retention (docs/BEDROCK_CLAUDE_PEN_SETUP.md).
//                  That is the whole allowed set. If the sealed pen is not
//                  configured on this server, or the sealed pen fails, the
//                  turn is REFUSED in plain language. There is no failover
//                  to Fireworks, to first-party Anthropic, or to anything
//                  else: a sealed matter's text must not drift to a
//                  retaining endpoint because a key was missing or a call
//                  failed. The single exception is an EXPLICIT, per-request
//                  `escalate: true` from the caller, which is written to the
//                  record as escalation:true — and which is itself refused
//                  if the record could not be opened;
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
import { signRequest } from './aws-sigv4.mjs';
import { TOOLS, callTool } from './mcp-core.mjs';
import { buildOrchestratorSystem } from './orchestrator-system.mjs';
import { matterTierWithClient, providerAllowed, isSealedTier } from './ai-tier-policy.mjs';
import { record, isNotDeployed } from './ledger.mjs';
import { loadCharter, narrowToolNames, buildCharterAppendix } from './agent-charter.mjs';

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
  bedrock: {
    provider: 'aws-bedrock',
    // Claude in Amazon Bedrock — the bedrock-mantle Messages API, whose
    // model ids carry no version suffix. Opus 5 by Eden's call (2026-08-27):
    // superior analytically for legal reasoning; 4.8 stays the Tier-A
    // writing pen. Served from the REGIONAL endpoint
    // (bedrock-mantle.<region>.api.aws), which pins processing to the one
    // region we name: that residency is part of the seal's claim, and it
    // costs a 10% premium over the global endpoint — priced in below
    // (Opus 5 lists at the same $5/$25 as 4.8).
    model: 'anthropic.claude-opus-5',
    route: 'messages',
    label: 'Claude Opus 5 (Bedrock, our AWS account, zero retention)',
    pricePerM: { input: 5.5, output: 27.5 },
  },
  bedrockOpen: {
    provider: 'aws-bedrock',
    route: 'chat',
    // A non-Anthropic sealed pen on the SAME Bedrock account, through the
    // OpenAI-compatible /v1/chat/completions route on bedrock-mantle. The
    // default since 2026-09-18: AWS gates the Claude 5 generation for this
    // account ("not available for this account", both planes, both Regions)
    // while Kimi K2.5 answers under mode none and drives the tool loop
    // (docs/strategy/004, "Invoke tests 2026-09-18"). BEDROCK_MODEL selects
    // the model; an anthropic.* id rides PENS.bedrock's Messages route.
    model: 'moonshotai.kimi-k2.5',
    label: 'Kimi K2.5 (Bedrock, our AWS account, zero retention)',
    // Bedrock list price for Kimi K2.5 not verified 2026-09-18 — ledger
    // estimate only; correct when the first invoice arrives.
    pricePerM: { input: 0.6, output: 2.5 },
    thinkingHeadroom: 4_000,
  },
  // 2026-09-19: PENS.fireworks (Kimi K3 on Fireworks) is GONE. It was the
  // Tier-B pen on servers without Bedrock keys, and it could not carry the
  // seal — Fireworks' zero retention is real but its US hosting was never
  // established (lib/ai-tier-policy.mjs). A sealed matter with no Bedrock
  // pen is refused now, so there is nothing left for it to serve; it is
  // deleted rather than left wired, so that re-enabling the fallback takes
  // a decision and not a one-line edit. The Editor's own Kimi route
  // (src/lib/llm/providers.ts) is a Tier-A choice and is untouched.
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

// 'PASTE' is this repo's placeholder convention for "variable named, key not
// yet issued" (see lib/embed-routes.mjs). Treated as absent, or a
// half-provisioned pen would sign requests with the literal string PASTE.
const present = (v) => Boolean(v) && v !== 'PASTE';

/**
 * The Bedrock pen's AWS credentials, from the environment — or null while
 * the pen is unprovisioned. These are BEDROCK_-prefixed rather than sharing
 * AWS_ACCESS_KEY_ID on purpose: the SageMaker embedding key is invoke-only
 * on one endpoint and cannot call Bedrock, so reusing it would turn "not
 * configured" into a confusing AccessDenied at chat time.
 */
export function bedrockCredsFromEnv(env = process.env) {
  if (!present(env.BEDROCK_AWS_ACCESS_KEY_ID) || !present(env.BEDROCK_AWS_SECRET_ACCESS_KEY)) return null;
  return {
    accessKeyId: env.BEDROCK_AWS_ACCESS_KEY_ID,
    secretAccessKey: env.BEDROCK_AWS_SECRET_ACCESS_KEY,
    sessionToken: present(env.BEDROCK_AWS_SESSION_TOKEN) ? env.BEDROCK_AWS_SESSION_TOKEN : null,
    region: present(env.BEDROCK_REGION) ? env.BEDROCK_REGION : 'us-east-1',
    model: present(env.BEDROCK_MODEL) ? env.BEDROCK_MODEL : null,
  };
}

/**
 * The Bedrock pen for a model id (BEDROCK_MODEL, else the default): an
 * anthropic.* id rides the Messages route, anything else the OpenAI-
 * compatible chat route. Same account, same retention mode either way.
 */
export function bedrockPenFor(creds) {
  const model = creds?.model || PENS.bedrockOpen.model;
  const base = model.startsWith('anthropic.') ? PENS.bedrock : PENS.bedrockOpen;
  const label = model === base.model ? base.label : `${model} (Bedrock, our AWS account, zero retention)`;
  return { ...base, model, label };
}

/**
 * True outside production. Used ONLY to add a developer hint to a refusal —
 * the refusal itself, and every decision leading to it, is identical in
 * every environment.
 */
function isDevEnv(env) {
  return (env?.NODE_ENV ?? process.env.NODE_ENV) !== 'production';
}

/**
 * What a sealed matter is told when this server holds no sealed pen. The
 * voice is SealedPipeError's (lib/seal-pipes.mjs): name the step, say
 * nothing was sent, say what would unblock it. "Nothing was sent" is
 * literally true here — the refusal happens before any model is contacted.
 */
export function sealedPenUnavailableMessage(env = process.env) {
  const base =
    'This matter is sealed (SecureSpace Tier B), and the sealed pen — a model in our own ' +
    'AWS account under zero data retention — is not available on this server. Nothing was ' +
    'sent: no model outside the seal was asked, and no part of this matter left the room. ' +
    'The question waits until the sealed pen is in place — or unseal the matter to use an ' +
    'ordinary pen.';
  if (!isDevEnv(env)) return base;
  return `${base} (Developer note: BEDROCK_AWS_ACCESS_KEY_ID / BEDROCK_AWS_SECRET_ACCESS_KEY ` +
    'are unset or still PASTE in this environment, so there is no sealed route to use. Sealed ' +
    'chat refuses by design rather than falling back to another provider — see ' +
    'docs/BEDROCK_CLAUDE_PEN_SETUP.md.)';
}

/**
 * What a sealed matter is told when the answer could not be written down.
 *
 * On a sealed matter the record is not paperwork about the work — it is part
 * of what the seal promises. So when it cannot be written, the answer does
 * not get delivered either. The wording has to stay true of what actually
 * happened: the pen WAS asked and it DID answer (unlike
 * sealedPenUnavailableMessage, which may say nothing was sent).
 */
export function exchangeUnrecordedMessage() {
  return (
    'This matter is sealed (SecureSpace Tier B), and every exchange here is recorded as ' +
    'privileged work product — that record is part of what the seal is for. This one could not ' +
    'be recorded, so the answer was discarded rather than shown to you. Nothing left the seal ' +
    "and nothing was kept. Ask again; if it keeps failing, the matter's record needs attention."
  );
}

/**
 * What a sealed matter is told when the sealed pen was reached and could not
 * answer (credentials rejected, model gated for the account, region error,
 * upstream failure). Deliberately does NOT say "nothing was sent" — the turn
 * did go to the sealed provider, which is inside the seal. What it promises
 * is that no OTHER provider was asked. The provider's own words are a
 * developer detail, kept out of production copy.
 */
export function sealedPenErrorMessage(detail, env = process.env) {
  const base =
    'This matter is sealed (SecureSpace Tier B) and the sealed pen could not answer. No other ' +
    'model was asked — a sealed matter is never handed to a provider outside the seal — so the ' +
    'question stands unanswered rather than being sent elsewhere. Try again in a moment; if it ' +
    'keeps failing, the sealed pen needs attention.';
  if (!isDevEnv(env) || !detail) return base;
  return `${base} (Developer note: ${String(detail).slice(0, 300)})`;
}

/**
 * Which pen serves this turn. The tier is the matter's EFFECTIVE tier
 * (ancestors included); `null` means no matter is bound (Tier A rules).
 * Throws AssistantRefusal when policy or configuration says no.
 *
 * `fireworksKey` is accepted and IGNORED since 2026-09-19 — Fireworks is no
 * longer a sealed pen (lib/ai-tier-policy.mjs). The parameter stays because
 * api/assistant.mjs and vite-claude-proxy.ts still pass it; it selects
 * nothing.
 */
export function choosePen({ tier, anthropicKey, fireworksKey, bedrockCreds = null, escalate = false, env = process.env }) {
  const t = tier ?? 'A';
  if (t === 'C') {
    throw new AssistantRefusal(
      'silo_not_connected',
      'This matter is a Silo (SecureSpace Tier C): nothing may leave the building, and the ' +
      'Silo appliance is not connected yet. No model was called.',
    );
  }
  if (t === 'B') {
    // The sealed pen is the ONLY pen a sealed matter has. When it is
    // frontier Claude, `escalate` is moot — the default pen already answers
    // inside the seal, so there is nothing to record. When it is not (Kimi
    // K2.5 today, while AWS gates Claude 5 for this account), an explicit
    // `escalate: true` may still carry the turn to first-party Claude, and
    // that is written to the record as escalation:true by the caller.
    if (bedrockCreds) {
      const pen = bedrockPenFor(bedrockCreds);
      if (pen.route === 'messages' || escalate !== true) return { ...pen, creds: bedrockCreds, escalation: false };
      if (!anthropicKey) throw new AssistantRefusal('pen_unavailable', 'The escalation pen (Claude) is not configured on this server.');
      return { ...PENS.anthropic, apiKey: anthropicKey, escalation: true };
    }
    // No sealed route on this server. A deliberate escalation the user asked
    // for is still honoured — it is explicit, per-turn and recorded. Nothing
    // else is: no silent fallback to Fireworks, to first-party Claude, or to
    // any other provider. Refuse and say so.
    if (escalate === true) {
      if (!anthropicKey) throw new AssistantRefusal('pen_unavailable', 'The escalation pen (Claude) is not configured on this server.');
      return { ...PENS.anthropic, apiKey: anthropicKey, escalation: true };
    }
    throw new AssistantRefusal('sealed_pen_unavailable', sealedPenUnavailableMessage(env));
  }
  if (!anthropicKey) throw new AssistantRefusal('pen_unavailable', 'The assistant\'s model is not configured on this server.');
  return { ...PENS.anthropic, apiKey: anthropicKey, escalation: false };
}

// Tools the assistant may use. Mostly read-only; the two ingestion tools are
// the deliberate exceptions — ingest_document only ENQUEUES work for the
// background worker (idempotent, deduped, no content mutation), and
// check_ingest_status reads queue/document state. `file_document` (raw
// content upload) stays excluded: uploads come through the Vault UI.
// Exported so a charter's toolset can be intersected against it (see
// lib/agent-charter.mjs). This set is the ceiling: a charter narrows it,
// nothing widens it.
export const ALLOWED_TOOLS = new Set([
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
export function toAnthropicTools(names = ALLOWED_TOOLS) {
  const allow = names instanceof Set ? names : new Set(names);
  return TOOLS
    .filter((t) => allow.has(t.name))
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
 * ask to take THIS turn to the frontier pen outside the seal. It must be
 * literally `true`, it is recorded in ai_messages as escalation:true, and it
 * is refused outright if that record cannot be opened. When the sealed pen
 * is itself frontier Claude the flag is moot — the default already answers
 * inside the seal. `bedrockCreds` (optional): bedrockCredsFromEnv()'s result
 * — the sealed pen. Without it a Tier-B turn is REFUSED
 * (`sealed_pen_unavailable`); there is no other pen for a sealed matter.
 * `fireworksKey` (optional): accepted and ignored — Fireworks stopped being
 * a sealed pen on 2026-09-19.
 * `charterId` (optional): run under an agent charter (a uuid from
 * agent_charters, or `builtin:<key>`). The charter is loaded SERVER-SIDE
 * through the user-scoped client, its prose is appended to the system
 * prompt, and its toolset NARROWS this run's tools — a charter can never
 * add one. Its matter, when it has one, governs the scope of the run.
 *
 * @returns {Promise<{usedTools:string[], sessionId:string|null, provider?:string, model?:string, tier?:string, usage?:{input:number,output:number}, charterId?:string|null}>}
 */
export async function runAssistantStream({
  supabase, anthropicKey, fireworksKey, bedrockCreds, openaiApiKey,
  messages, matterId, context, emit: emitRaw, sessionId, escalate, charterId,
}) {
  // ── W1 strict mode. On a SEALED matter the answer is HELD until the
  // record has it: text deltas are buffered instead of streamed, and are
  // released only once recordAssistant reports the exchange written. Status
  // events (session, tool, action, confirm, error) always go out live, so
  // the panel shows the turn running rather than looking dead. Unsealed
  // matters stream exactly as before.
  const heldText = [];
  let holdAnswer = false;
  const emit = (ev) => {
    if (holdAnswer && ev?.type === 'text') { heldText.push(ev); return; }
    emitRaw(ev);
  };
  const releaseAnswer = () => { for (const ev of heldText.splice(0)) emitRaw(ev); };
  const discardAnswer = () => { heldText.length = 0; };

  const usedTools = [];
  const ledger = { session: null, seq: 0, sessionError: null, sessionNotDeployed: false };
  let pen = null;
  let tier = null;
  const usage = { input: 0, output: 0 };
  let answer = '';
  let rounds = 0;
  let charter = null;

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

    // ── A charter, when one was named. Loaded through the user-scoped
    // client: RLS answers "may this user see it?", and a charter that is
    // missing, hidden, or disabled simply leaves the run un-chartered.
    // A charter's own matter wins over the one the browser sent — the
    // charter defines the scope it works in, so the client cannot broaden it.
    if (charterId) {
      charter = await loadCharter(supabase, charterId);
      if (charter && charter.enabled === false) charter = null;
      if (charter?.matterspace_id) matterId = charter.matterspace_id;
    }

    // ── The tier decides the pen; the ledger opens before any model is called.
    if (matterId) {
      tier = await matterTierWithClient(supabase, matterId);
      if (!tier) throw new AssistantRefusal('matter_not_found', "I can't find that matter, or you don't have access to it.");
      holdAnswer = isSealedTier(tier);
      const opened = await ensureSession(supabase, {
        sessionId, matterId, tier,
        title: charter ? `${charter.name} — ${lastUser?.text ?? ''}` : lastUser?.text,
      });
      ledger.session = opened.session;
      ledger.sessionError = opened.error;
      ledger.sessionNotDeployed = opened.notDeployed === true;
      if (ledger.session) {
        ledger.seq = await nextSeq(supabase, ledger.session.id);
        await appendMessage(supabase, {
          session_id: ledger.session.id, seq: ledger.seq++, role: 'user',
          content: { text: lastUser?.text ?? '', ...(charter ? { charter_id: charter.id } : {}) },
        });
      }
    }
    pen = choosePen({ tier, anthropicKey, fireworksKey, bedrockCreds, escalate: escalate === true });
    // An escalation is permitted only because it is written down. If the
    // record could not be opened, the thing that made it permissible does
    // not exist — so the escalation does not happen either. (An ordinary
    // sealed turn is unaffected: it stays inside the seal whether or not the
    // ledger answered.)
    if (pen.escalation && !ledger.session) {
      pen = null;
      throw new AssistantRefusal(
        'escalation_unrecorded',
        'This matter is sealed (SecureSpace Tier B). You asked to take this turn to the ' +
        'frontier pen outside the seal, which is allowed only when it is recorded — and the ' +
        'record could not be opened, so nothing was sent. Try again; if it keeps failing, the ' +
        'session record needs attention.',
      );
    }
    // The same rule for an ORDINARY sealed turn: no session row, no answer.
    // Refused here, before any driver runs, so nothing is sent at all.
    // `sessionNotDeployed` is the deliberate exception — a database that has
    // not had the migrations pasted must behave as it does today, not start
    // refusing (see lib/ledger.mjs, "not deployed is not failed").
    if (isSealedTier(tier) && !ledger.session && !ledger.sessionNotDeployed) {
      pen = null;
      throw new AssistantRefusal('exchange_unrecorded', exchangeUnrecordedMessage());
    }
    emit({
      type: 'session',
      sessionId: ledger.session?.id ?? null,
      tier: tier ?? 'A',
      provider: pen.provider,
      model: pen.model,
      escalation: pen.escalation,
      charterId: charter?.id ?? null,
      charterName: charter?.name ?? null,
      matterId: matterId ?? null,
    });

    // A chartered run is narrowed: the charter's tools ∩ ALLOWED_TOOLS, plus
    // the two navigation actions (the browser executes those; they read
    // nothing). The confirm-gated writes and the feedback relay are general
    // Orchestrator affordances and stay out of an agent's run, so that "what
    // it may touch" is exactly the list the charter shows the user.
    const runTools = charter ? new Set(narrowToolNames(charter.allowed_tools, ALLOWED_TOOLS)) : ALLOWED_TOOLS;
    const tools = charter
      ? [...toAnthropicTools(runTools), ...CLIENT_ACTION_TOOLS]
      : [...toAnthropicTools(), ...CLIENT_ACTION_TOOLS, ...CONFIRM_ACTION_TOOLS, FEEDBACK_TOOL];
    const today = new Date().toISOString().slice(0, 10);
    let system = buildOrchestratorSystem({ matterId, today, ...(context || {}) });
    if (charter) {
      system += '\n\n' + buildCharterAppendix(charter, [...runTools]);
    }
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

    const driver = pen.provider === 'anthropic' ? anthropicTurn
      : pen.provider === 'aws-bedrock' ? (pen.route === 'chat' ? openaiCompatTurn : bedrockTurn)
      : openaiCompatTurn;
    const onText = (delta) => { answer += delta; emit({ type: 'text', text: delta }); };

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      rounds++;
      // A provider failure on a SEALED matter is a refusal, not an invitation
      // to try someone else. There is no retry and no second pen here — the
      // loop reuses the pen it was given — and this wrapper makes that
      // explicit and testable: the user is told the sealed pen could not
      // answer, in the product's own voice, rather than shown the provider's
      // raw error.
      //
      // Not on a recorded escalation, though: that turn is deliberately
      // OUTSIDE the seal, so neither half of the sealed refusal would be
      // true of it. Its failures pass through as Tier A's do. Tier A itself
      // is untouched.
      let turn;
      try {
        turn = await driver({ pen, system, tools, convo, onText });
      } catch (err) {
        if (isSealedTier(tier) && pen.escalation !== true && !(err instanceof AssistantRefusal)) {
          throw new AssistantRefusal('sealed_pen_error', sealedPenErrorMessage(err?.message));
        }
        throw err;
      }
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
        if (!charter && CONFIRM_ACTIONS.has(tu.name)) {
          emit({ type: 'confirm', action: tu.name, input: args });
          results.push({ tool_use_id: tu.id, content: JSON.stringify({ status: 'awaiting_confirmation' }) });
          continue;
        }

        // Feedback relay: insert one row server-side through the user-scoped
        // client. The model gives the wording; we stamp the context we know.
        if (!charter && tu.name === 'relay_feedback') {
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
        // runTools is ALLOWED_TOOLS for an ordinary turn, and the narrowed
        // charter set for a chartered run. Enforced here as well as in the
        // tool definitions, so a model that invents a name gets a refusal.
        if (!runTools.has(tu.name)) {
          results.push({ tool_use_id: tu.id, content: `Error: tool "${tu.name}" is not available.`, is_error: true });
          continue;
        }
        const scoped = matterId && MATTER_SCOPED_TOOLS.has(tu.name) && !args.matter
          ? { ...args, matter: matterId }
          : args;
        try {
          // W1: the actor travels with the call so the matter's Record can
          // say whether a person or an agent charter asked for this.
          const out = await callTool(supabase, tu.name, scoped, {
            openaiApiKey,
            matterId: matterId ?? null,
            actor: {
              kind: charter ? 'charter' : 'user',
              ref: charter ? charter.id : null,
              label: charter?.name ?? null,
              session_id: ledger.session?.id ?? null,
            },
          });
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

    const recorded = await recordAssistant(supabase, ledger, {
      pen, tier, answer, usedTools, rounds, usage, charter, matterId,
    });
    if (holdAnswer && !recorded.ok) {
      // The answer exists and the record does not. On a sealed matter that
      // is not a delivery.
      discardAnswer();
      emitRaw({ type: 'error', code: 'exchange_unrecorded', message: exchangeUnrecordedMessage() });
      return {
        usedTools, sessionId: ledger.session?.id ?? null,
        provider: pen.provider, model: pen.model, tier: tier ?? 'A', usage,
        charterId: charter?.id ?? null, withheld: true,
      };
    }
    releaseAnswer();
    return {
      usedTools, sessionId: ledger.session?.id ?? null,
      provider: pen.provider, model: pen.model, tier: tier ?? 'A', usage,
      charterId: charter?.id ?? null,
    };
  } catch (err) {
    const code = err instanceof AssistantRefusal ? err.code : undefined;
    const recorded = await recordAssistant(supabase, ledger, {
      pen, tier, answer, usedTools, rounds, usage, charter, matterId,
      error: { code: code ?? 'assistant_failed', message: err?.message || 'assistant_failed' },
    });
    // A partial answer on a sealed matter follows the same rule as a whole
    // one: released if it was written down, dropped if it was not.
    if (holdAnswer && recorded.ok) releaseAnswer(); else discardAnswer();
    emitRaw({ type: 'error', message: err?.message || 'assistant_failed', ...(code ? { code } : {}) });
    return {
      usedTools, sessionId: ledger.session?.id ?? null, provider: pen?.provider,
      model: pen?.model, tier: tier ?? 'A', usage, charterId: charter?.id ?? null,
    };
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
// Best-effort on an UNSEALED matter: a ledger hiccup must never swallow the
// answer (the failure is logged server-side). On a SEALED matter the rule is
// inverted — recordAssistant reports whether the exchange was written, and
// runAssistantStream withholds the answer when it was not. What these
// functions no longer do is swallow the failure silently: every one of them
// now returns what happened.
//
// RLS: the session's owner is auth.uid(); a session is only ever continued
// by its owner in its own matter.

/** @returns {Promise<{session:object|null, error:object|null, notDeployed:boolean}>} */
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
        return { session: data, error: null, notDeployed: false };
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
    if (error) {
      console.warn('[assistant ledger] open session failed:', error.message);
      return { session: null, error, notDeployed: isNotDeployed(error) };
    }
    return { session: data, error: null, notDeployed: false };
  } catch (err) {
    console.warn('[assistant ledger] open session failed:', err?.message || err);
    return {
      session: null,
      error: { message: err?.message || String(err), code: err?.code },
      notDeployed: isNotDeployed(err),
    };
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

/** @returns {Promise<{ok:boolean, error?:object, notDeployed?:boolean}>} */
async function appendMessage(supabase, row) {
  try {
    const { error } = await supabase.from('ai_messages').insert(row);
    if (error) {
      console.warn('[assistant ledger] append failed:', error.message);
      return { ok: false, error, notDeployed: isNotDeployed(error) };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[assistant ledger] append failed:', err?.message || err);
    return {
      ok: false,
      error: { message: err?.message || String(err), code: err?.code },
      notDeployed: isNotDeployed(err),
    };
  }
}

function estimateCost(pen, usage) {
  if (!pen?.pricePerM) return null;
  const usd = (usage.input * pen.pricePerM.input + usage.output * pen.pricePerM.output) / 1e6;
  return Math.round(usd * 10_000) / 10_000;
}

/**
 * Write the turn down: the ai_messages row (051, the privileged record) and
 * the `completion.received` event (064, the matter's Record).
 *
 * @returns {Promise<{ok:boolean, reason:string|null}>} — `ok:false` means
 *   this exchange is NOT in the record, and on a sealed matter the caller
 *   withholds the answer. A database that simply has not had the migrations
 *   pasted is reported as ok: not deployed is not failed.
 */
async function recordAssistant(supabase, ledger, {
  pen, tier, answer, usedTools, rounds, usage, error, charter, matterId,
}) {
  const sealed = isSealedTier(tier);
  let ok = true;
  let reason = null;
  const fail = (why) => { if (ok) { ok = false; reason = why; } };

  if (!ledger.session && sealed && !ledger.sessionNotDeployed) {
    fail(`ai_sessions: ${ledger.sessionError?.message ?? 'no session row'}`);
  }

  const withinPolicy = pen
    ? providerAllowed(tier ?? 'A', pen.provider, { escalation: pen.escalation === true })
    : true;

  // The matter's Record. Metadata only — model, provider, tokens, cost,
  // tier, which tools ran, how many rounds. Never the question, never the
  // answer; `answer_chars` is the whole of what the Record says about the
  // text itself.
  if (matterId) {
    const led = await record(supabase, {
      kind: 'completion.received',
      matterId,
      sessionId: ledger.session?.id ?? null,
      actor: {
        kind: charter ? 'charter' : 'user',
        ref: charter ? charter.id : null,
        label: charter?.name ?? null,
        session_id: ledger.session?.id ?? null,
      },
      payload: {
        tier: tier ?? 'A',
        provider: pen?.provider ?? null,
        model: pen?.model ?? null,
        input_tokens: usage.input || 0,
        output_tokens: usage.output || 0,
        estimated_cost: pen ? estimateCost(pen, usage) : null,
        within_policy: withinPolicy,
        escalation: pen?.escalation === true,
        tools_used: usedTools,
        rounds,
        answer_chars: typeof answer === 'string' ? answer.length : 0,
        ...(error ? { error: { code: error.code, message: String(error.message ?? '').slice(0, 200) } } : {}),
      },
    });
    if (!led.ok && !led.notDeployed) fail(`events: ${led.error?.message ?? 'ledger write failed'}`);
  }

  if (!ledger.session) return { ok, reason };
  const content = {
    text: answer,
    used_tools: usedTools,
    rounds,
    // Attribution: which agent produced this run. `charter_id` is the
    // agent_charters uuid, or `builtin:<key>` for an on-duty agent.
    ...(charter ? { charter_id: charter.id, charter_name: charter.name } : {}),
    ...(pen?.escalation ? { escalation: true } : {}),
    ...(error ? { error } : {}),
  };
  const appended = await appendMessage(supabase, {
    session_id: ledger.session.id,
    seq: ledger.seq++,
    role: 'assistant',
    content,
    model: pen?.model ?? null,
    provider: pen?.provider ?? null,
    input_tokens: usage.input || null,
    output_tokens: usage.output || null,
    estimated_cost: pen ? estimateCost(pen, usage) : null,
    // Within policy = the pen the tier permits. A recorded escalation counts:
    // it is outside the SEAL but inside the POLICY, because the user asked
    // for it per-turn and this very row is the record that makes it
    // permissible. A refusal (no pen) is, by construction, within policy:
    // nothing was sent anywhere.
    within_policy: withinPolicy,
  });
  // The audit of 2026-09-19: this failure used to be a console.warn and
  // nothing else, on every tier. It still is on an unsealed matter; on a
  // sealed one it is the reason the answer is withheld.
  if (!appended.ok && !appended.notDeployed) {
    fail(`ai_messages: ${appended.error?.message ?? 'append failed'}`);
  }
  return { ok, reason };
}


// -----------------------------------------------------------------------------
// Drivers — the only provider-specific code in the assistant
// -----------------------------------------------------------------------------
// Each takes { pen, system, tools, convo, onText } and returns
//   { blocks: [{type:'text',text} | {type:'tool_use',id,name,input}],
//     stop: 'tool_use' | 'end', usage: {input, output}, raw }
// `convo` is the neutral history: {role:'user', text} | {role:'assistant',
// blocks, raw?} | {role:'tool_results', results:[{tool_use_id, content,
// is_error?}]}. `raw` is the provider's own assistant payload, replayed
// verbatim on the same provider (keeps Claude's thinking blocks / Kimi's
// reasoning intact across tool rounds).

// The neutral history in Messages-API shape. `provider` gates the verbatim
// raw replay: thinking blocks carry provider-issued signatures, so raw
// content goes back only to the provider that produced it — a turn served
// by a different pen is rebuilt from the neutral blocks instead.
function toMessagesHistory(convo, provider) {
  const messages = [];
  for (const m of convo) {
    if (m.role === 'user') {
      messages.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: m.raw?.provider === provider ? m.raw.content : toAnthropicContent(m.blocks),
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
  return messages;
}

/** Anthropic Messages API, via the official SDK. */
async function anthropicTurn({ pen, system, tools, convo, onText }) {
  const client = new Anthropic({ apiKey: pen.apiKey });
  const messages = toMessagesHistory(convo, 'anthropic');
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

/**
 * Claude in Amazon Bedrock — the bedrock-mantle Messages API. The SEALED
 * pen: same request shape and SSE stream as the first-party API, but served
 * from our own AWS account at bedrock-mantle.<region>.api.aws, signed with
 * SigV4 (service 'bedrock-mantle') by the invoke-only key. Under account
 * data_retention_mode=none, Messages requests are never written to durable
 * storage by AWS and never shared with the model provider — the contractual
 * ZDR the seal claims (docs/BEDROCK_CLAUDE_PEN_SETUP.md sets and proves it).
 *
 * Hand-rolled fetch rather than @anthropic-ai/bedrock-sdk for the same
 * reason lib/aws-sigv4.mjs exists: this is the security-sensitive path, and
 * one signed POST does not justify the AWS credential-chain dependency tree.
 *
 * Exported for scripts/_verify-bedrock-pen.mjs.
 */
export async function bedrockTurn({ pen, system, tools, convo, onText }) {
  const { creds } = pen;
  const url = `https://bedrock-mantle.${creds.region}.api.aws/anthropic/v1/messages`;
  const body = JSON.stringify({
    model: pen.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    thinking: { type: 'adaptive' },
    stream: true,
    system,
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    messages: toMessagesHistory(convo, 'aws-bedrock'),
  });
  const headers = signRequest({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
    },
    body,
    region: creds.region,
    service: 'bedrock-mantle',
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  });
  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`${pen.label} returned ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  // Accumulate the Messages SSE stream into full content blocks. Thinking
  // blocks (and their signatures) are kept in `raw` so later tool rounds can
  // replay them verbatim; the neutral `blocks` carry only text + tool_use,
  // same as the SDK driver above.
  const content = [];
  const partialJson = new Map(); // block index → accumulated input JSON
  let stop = null;
  const usage = { input: 0, output: 0 };
  for await (const data of sseDataLines(res.body)) {
    if (!data || data === '[DONE]') continue;
    let ev;
    try { ev = JSON.parse(data); } catch { continue; }
    if (ev.type === 'message_start') {
      usage.input = ev.message?.usage?.input_tokens ?? 0;
      usage.output = ev.message?.usage?.output_tokens ?? 0;
    } else if (ev.type === 'content_block_start') {
      const b = ev.content_block || {};
      if (b.type === 'tool_use') {
        content[ev.index] = { type: 'tool_use', id: b.id, name: b.name, input: {} };
        partialJson.set(ev.index, '');
      } else if (b.type === 'thinking') {
        content[ev.index] = { type: 'thinking', thinking: b.thinking ?? '', signature: b.signature ?? '' };
      } else if (b.type === 'redacted_thinking') {
        content[ev.index] = { type: 'redacted_thinking', data: b.data ?? '' };
      } else {
        content[ev.index] = { type: 'text', text: b.text ?? '' };
        if (b.text) onText(b.text);
      }
    } else if (ev.type === 'content_block_delta') {
      const cur = content[ev.index];
      const d = ev.delta || {};
      if (!cur) continue;
      if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
        cur.text += d.text;
        onText(d.text);
      } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        partialJson.set(ev.index, (partialJson.get(ev.index) ?? '') + d.partial_json);
      } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
        cur.thinking += d.thinking;
      } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
        cur.signature = (cur.signature ?? '') + d.signature;
      }
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
      if (ev.usage?.output_tokens != null) usage.output = ev.usage.output_tokens;
    } else if (ev.type === 'error') {
      throw new Error(`${pen.label} stream error: ${ev.error?.message ?? 'unknown'}`);
    }
  }
  for (const [idx, s] of partialJson) {
    const cur = content[idx];
    if (!cur) continue;
    try { cur.input = s ? JSON.parse(s) : {}; } catch { cur.input = { _unparsed_arguments: s }; }
  }

  // Drop text blocks that ended empty (same rule as toAnthropicContent):
  // this raw content is replayed verbatim next round, and the API rejects
  // empty text blocks in an assistant turn.
  const dense = content.filter(Boolean).filter((b) => b.type !== 'text' || (b.text && b.text.trim()));
  return {
    blocks: dense.filter((b) => b.type === 'text' || b.type === 'tool_use'),
    stop: stop === 'tool_use' ? 'tool_use' : 'end',
    usage,
    raw: { provider: 'aws-bedrock', content: dense },
  };
}

// Non-Bedrock hosts for the OpenAI-compatible driver. Empty since
// 2026-09-19: the Fireworks entry went with PENS.fireworks, so this driver
// now only ever speaks to bedrock-mantle (SigV4, our own AWS account). A new
// entry here would be a new egress host — add one only with a tier decision
// behind it.
const OPENAI_COMPAT_URLS = {};

/** OpenAI-compatible chat completions with tools, streamed (Kimi on Bedrock). */
export async function openaiCompatTurn({ pen, system, tools, convo, onText }) {
  // On Bedrock the same OpenAI-compatible wire shape rides bedrock-mantle,
  // SigV4-signed with the pen's own key instead of a bearer token.
  const bedrock = pen.provider === 'aws-bedrock';
  const url = bedrock
    ? `https://bedrock-mantle.${pen.creds.region}.api.aws/v1/chat/completions`
    : OPENAI_COMPAT_URLS[pen.provider];
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
  const bodyText = JSON.stringify(body);
  const headers = bedrock
    ? signRequest({
        method: 'POST', url, body: bodyText,
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        region: pen.creds.region, service: 'bedrock-mantle',
        accessKeyId: pen.creds.accessKeyId, secretAccessKey: pen.creds.secretAccessKey,
        sessionToken: pen.creds.sessionToken,
      })
    : { 'content-type': 'application/json', authorization: `Bearer ${pen.apiKey}` };
  const res = await fetch(url, { method: 'POST', headers, body: bodyText });
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
