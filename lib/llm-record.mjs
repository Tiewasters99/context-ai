// Every model call a FEATURE makes, in the matter's Record.
//
// THE HOLE THIS CLOSES
// ---------------------------------------------------------------------------
// The Record (public.events, migration 064) knew about two things: the in-app
// Assistant's completions (`completion.received`, lib/assistant-core.mjs) and
// connector tool calls (`tool.invoked`, lib/mcp-core.mjs). It knew nothing
// about /api/llm — the browser passthrough behind Bucketizer, Cite-Check, the
// Editor's passes, DeckComposer, the AI Workbench and Moot Bench. Those calls
// were gated (lib/ai-tier-policy.mjs), sealed where the matter is sealed
// (lib/llm-sealed-route.mjs) and metered (lib/usage-meter.mjs), and recorded
// nowhere. On 2026-09-19 a real sealed Bucketizer classification ran in
// production — 21,578 in, 6,342 out, served by the sealed pen — and the
// matter's Record did not know it had happened.
//
// For a product whose pitch is that a lawyer can show a court how AI was used
// on a matter, that is a hole. This module is the fix.
//
// TWO ROWS, NOT ONE, AND WHY
// ---------------------------------------------------------------------------
// The sealed rule is: no record, no answer. The in-app Assistant honours it by
// BUFFERING a sealed answer and discarding it if the write fails. /api/llm
// cannot: it streams, and once the first byte has left the function there is
// nothing to discard. The ledger is append-only, so the answer is to write
// twice rather than to buffer:
//
//   1. `completion.requested` — BEFORE any provider is contacted. It names the
//      feature, the matter, the pen that is about to answer (after sealed
//      substitution), the tier, the route and the allowance. On a SEALED
//      matter this write is strict: if it fails, the call is refused and ZERO
//      provider requests are made. On an unsealed matter it is best-effort and
//      can never be the reason a call fails.
//   2. `completion.received` — after the answer has been delivered. Tokens,
//      cost, duration, outcome. Always best-effort, on both routes, because by
//      then the undeletable row already exists: the seal's promise was kept by
//      row 1.
//
// The two are tied by `call_id`, so the Record tab and the export can pair
// them into one line. A lone `received` (the ordinary state between merging
// this and pasting 073) is a complete call. A lone `requested` with no
// refusal is a call that never came back, and the export says exactly that.
//
// METADATA ONLY, AND THE CLIENT DOES NOT GET TO WRITE PROSE
// ---------------------------------------------------------------------------
// Nothing here ever sees the system prompt, the messages, the answer, a
// passage or a document's text — it is handed none of them. Beyond that,
// three values in a payload originate with the BROWSER and would otherwise
// reach a row nobody can delete: the feature label, the model name and the
// document ids. All three are shaped here, server-side:
//
//   * `feature` is checked against an ALLOW-LIST. Anything else, including
//     something a caller invented, becomes 'unspecified'. A request is never
//     refused for it — a bad label must not break a lawyer's classify run.
//   * `model` / `client_model` must look like a model id. Anything else is
//     reduced to its shape.
//   * `document_ids` survive only if every element is a uuid (ledger.uuidList).
//
// And an upstream provider's own error body NEVER enters a payload, even
// truncated: a 4xx from a provider routinely echoes part of the request. What
// is recorded is the outcome class and the HTTP status, which is what a reader
// of the Record actually needs.

import { record, recordStrict, uuidList } from './ledger.mjs';
import { ratePerMtok } from './usage-prices.mjs';
import { SEALED_PEN_PREAMBLE_VERSION } from './pen-preambles.mjs';

// ---------------------------------------------------------------------------
// The feature allow-list
// ---------------------------------------------------------------------------
// One label per distinct model call a feature makes, because "Bucketizer" is
// not a useful answer to "what did the AI do on this matter" — classifying a
// document, proposing a bucket tree and pulling evidence are three different
// acts with three different risk postures, and counsel's AI Use Record lists
// them separately.
//
// Kept in step with src/lib/llm/features.ts, which is generated from THIS
// array — the harness asserts the two are identical, so they cannot drift.
export const LLM_FEATURES = Object.freeze([
  'bucketizer.tree',
  'bucketizer.classify',
  'bucketizer.evidence',
  'citecheck.extract',
  'citecheck.check',
  'editor.light',
  'editor.plan',
  'editor.section',
  'editor.critic',
  'deck',
  'workbench',
  'moot.generate',
  'moot.converse',
]);

/** What a call that did not say, or said something else, is recorded as. */
export const UNSPECIFIED_FEATURE = 'unspecified';

const FEATURE_SET = new Set(LLM_FEATURES);

/**
 * The label this call is recorded under. Never throws, never refuses: an
 * unrecognised label is a mislabelled call, not a reason to stop a lawyer's
 * work, and 'unspecified' is a truthful thing for the Record to say.
 */
export function normalizeFeature(value) {
  return typeof value === 'string' && FEATURE_SET.has(value) ? value : UNSPECIFIED_FEATURE;
}

// A model id, as every provider in PROVIDER_ROUTES spells one. Anything else
// under this key is a client writing free text into an undeletable row.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

function modelName(value) {
  if (typeof value !== 'string' || !value) return null;
  return MODEL_RE.test(value) ? value : { present: true, length: value.length };
}

/** A call id: not a secret, just something both rows share. */
export function newCallId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// The user-scoped client
// ---------------------------------------------------------------------------
// lib/ledger.mjs takes the CALLER's Supabase client, never the service role,
// because the row's byline is auth.uid() stamped inside the database. This is
// the smallest thing that satisfies it: one `rpc()` method speaking PostgREST
// directly, the same way lib/usage-meter.mjs and lib/ai-tier-policy.mjs
// already do. No @supabase/supabase-js import — /api/llm's bundle is already
// heavy, and a stubbed fetch is all a harness needs to drive this.
//
// The timeout is the meter's, for the meter's reason: on an unsealed matter a
// slow ledger must not add latency to a lawyer's call. On a sealed matter a
// timeout IS a real error and refuses the turn — that is the contract, not a
// bug in it.
const LEDGER_TIMEOUT_MS = 3000;

export function ledgerClientFor({
  supabaseUrl, anonKey, bearer, fetchImpl = null, timeoutMs = LEDGER_TIMEOUT_MS,
}) {
  if (!supabaseUrl || !anonKey || !bearer) return null;
  const base = String(supabaseUrl).replace(/\/$/, '');
  return {
    async rpc(fn, args) {
      const doFetch = fetchImpl || globalThis.fetch;
      let res;
      let text = '';
      try {
        res = await doFetch(`${base}/rest/v1/rpc/${fn}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            apikey: anonKey,
            authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify(args ?? {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
      } catch (err) {
        return {
          data: null,
          error: {
            code: err?.name === 'TimeoutError' ? 'ledger_timeout' : 'ledger_unreachable',
            message: err?.message || String(err),
          },
        };
      }
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
      if (!res.ok) {
        const e = payload && typeof payload === 'object' ? payload : {};
        return {
          data: null,
          error: {
            // PostgREST answers 404 for a function that is not in its schema
            // cache and names it PGRST202 in the body. A bare 404 means the
            // same thing and is classified the same way, so "the migration is
            // not pasted yet" never becomes "the write failed".
            code: e.code ?? (res.status === 404 ? 'PGRST202' : `http_${res.status}`),
            message: e.message ?? String(text).slice(0, 200),
            details: e.details ?? null,
            hint: e.hint ?? null,
          },
        };
      }
      return { data: payload, error: null };
    },
  };
}

// ---------------------------------------------------------------------------
// The refusal, when a SEALED matter's call could not be written down
// ---------------------------------------------------------------------------
// lib/assistant-core.mjs has `exchangeUnrecordedMessage()` for the chat route,
// and its wording is deliberately different: there the pen WAS asked and DID
// answer, and the answer was thrown away. Here nothing was sent at all,
// because the row is written before the provider is contacted. Saying "nothing
// was sent" when it is true is the whole value of the two-row shape, so it
// gets its own sentence rather than borrowing one that would be false.
export function llmExchangeUnrecordedMessage() {
  return (
    'This matter is sealed (SecureSpace Tier B), and every model call on it is written into the ' +
    'matter’s Record before the model is asked — that record is part of what the seal is for. ' +
    'This one could not be written, so nothing was sent: no model was asked, inside the seal or ' +
    'outside it, and no part of this matter left the room. Try again in a moment; if it keeps ' +
    'failing, the matter’s Record needs attention.'
  );
}

/** The body /api/llm answers with when the sealed record could not be written. */
export function exchangeUnrecordedRefusal() {
  return {
    status: 503,
    body: { error: 'exchange_unrecorded', tier: 'B', message: llmExchangeUnrecordedMessage() },
  };
}

// ---------------------------------------------------------------------------
// The two writes
// ---------------------------------------------------------------------------

/** What both rows say about who answered and by which route. */
function whoAnswered({
  feature, callId, tier, provider, model, clientProvider, clientModel, sealed, streaming,
}) {
  const payload = {
    feature,
    call_id: callId,
    tier: tier ?? null,
    provider: provider ?? null,
    model: modelName(model),
    route: sealed ? 'sealed' : 'first-party',
    streaming: streaming === true,
  };
  // The model the browser ASKED for, kept only when the server answered with a
  // different one. On an unsealed call the two are the same and saying so
  // twice adds nothing; on a sealed call the difference IS the substitution,
  // and a Record that lost it would not show that the seal did anything.
  if (sealed) {
    payload.client_provider = clientProvider ?? null;
    payload.client_model = modelName(clientModel);
    // Which pen-owned instructions were in force (lib/pen-preambles.mjs). A
    // version string, never the prose — the Record stays metadata-only, and an
    // AI Use Record resolves the string to the exact text in the repo.
    //
    // Read from the module rather than passed in: `sealed` is true here only
    // because lib/llm-sealed-route.mjs served the call, and that route always
    // applies the preamble. Its one opt-out is a function parameter that only
    // scripts/eval-sealed-pen.mjs passes — api/llm.mjs never does, and
    // scripts/_verify-sealed-preamble.mjs asserts it by reading the source. So
    // this field stays true without api/llm.mjs having to carry it, and the
    // ORDER inside that handler stays exactly as it was settled.
    payload.pen_preamble = SEALED_PEN_PREAMBLE_VERSION;
  }
  return payload;
}

/**
 * Row 1 — written BEFORE any provider is contacted.
 *
 * @param {object|null} client   the user-scoped client, or null (nothing is written)
 * @param {object} o
 * @param {boolean} o.strict     sealed matter: throw LedgerWriteError on a REAL
 *                               failure (never on "not deployed").
 * @param {string|null} o.refused  a terminal refusal code. When set, no provider
 *                               was contacted and no second row will follow.
 * @returns {Promise<{ok:boolean, notDeployed?:boolean, error?:object}>}
 */
export async function recordLlmRequested(client, {
  matterId, actor, feature, callId, tier, provider, model,
  clientProvider = null, clientModel = null, sealed = false, streaming = false,
  maxOutputTokens = null, byok = false, documentIds = null,
  refused = null, status = null, strict = false,
} = {}) {
  if (!client || !matterId) return { ok: false, error: { message: 'not recorded: no matter' } };
  const payload = {
    ...whoAnswered({ feature, callId, tier, provider, model, clientProvider, clientModel, sealed, streaming }),
    byok: byok === true,
    refused: refused ?? null,
  };
  // A refused call never reached the pen, so no instructions were ever in
  // force for it. Saying which ones would have been would put a sentence in an
  // undeletable row that is not true of what happened.
  if (payload.refused) delete payload.pen_preamble;
  // Absent rather than null, for the same reason as the token counts below:
  // `redact()`'s secret pattern matches "token", so a null here would be
  // stored as '[redacted]'.
  const allowance = numberOrNull(maxOutputTokens);
  if (allowance !== null) payload.max_output_tokens = allowance;
  if (status !== null) payload.status = numberOrNull(status);
  const ids = uuidList(documentIds);
  if (ids !== null) payload.document_ids = ids;
  const write = strict ? recordStrict : record;
  return write(client, { kind: 'completion.requested', matterId, actor, payload });
}

/**
 * Row 2 — written after the answer has been delivered. ALWAYS best-effort,
 * sealed or not: the seal's promise was kept by row 1, and a matter's Record
 * is not worth withholding an answer that has already been sent.
 *
 * `outcome` is a class, never a provider's words:
 *   'ok'             the provider answered
 *   'provider_error' it answered with a non-2xx, or the request failed
 *   'stream_error'   the stream stopped part-way through
 */
export async function recordLlmReceived(client, {
  matterId, actor, feature, callId, tier, provider, model,
  clientProvider = null, clientModel = null, sealed = false, streaming = false,
  outcome = 'ok', status = null, tokens = null, ms = null, byok = false,
} = {}) {
  if (!client || !matterId) return { ok: false, error: { message: 'not recorded: no matter' } };
  const input = numberOrNull(tokens?.input);
  const output = numberOrNull(tokens?.output);
  const payload = {
    ...whoAnswered({ feature, callId, tier, provider, model, clientProvider, clientModel, sealed, streaming }),
    outcome,
    ok: outcome === 'ok',
    status: numberOrNull(status),
    ms: numberOrNull(ms),
  };
  // A streamed turn reports no token counts this handler is willing to parse —
  // teeing six providers' SSE dialects to bill them is a class of bug the one
  // path that must never stall does not need. Where there are none, the keys
  // are ABSENT rather than null: `redact()`'s secret pattern matches "token",
  // and a null under `input_tokens` would be written as '[redacted]', which
  // reads as "there was a number and we hid it" rather than "none was
  // reported". The export prints "not reported" for the absence.
  if (input !== null) payload.input_tokens = input;
  if (output !== null) payload.output_tokens = output;
  const cost = byok ? 0 : usdForTokens(model, provider, input, output);
  if (cost !== null) payload.estimated_cost = cost;
  return record(client, { kind: 'completion.received', matterId, actor, payload });
}

function numberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The turn's cost in US dollars, at the rate of the model that ACTUALLY
 * answered — the same table lib/usage-meter.mjs charges from, and the same
 * unit `completion.received` already carries from lib/assistant-core.mjs
 * (USD, not cents). Null when the provider reported no counts.
 */
function usdForTokens(model, provider, input, output) {
  if (input === null && output === null) return null;
  const [inRate, outRate] = ratePerMtok(model, provider);
  const usd = ((input ?? 0) * inRate + (output ?? 0) * outRate) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}
