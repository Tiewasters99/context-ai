// The hosted MCP connector's meter (2026-09-25, migration 086).
//
// What was wrong
// ---------------------------------------------------------------------------
// api/mcp.mjs ran every tool call with no meter and no cap. The in-app paths
// (/api/llm, /api/ingest, the Assistant …) are metered and capped through
// migration 063/067's usage_consume; the connector was not. Since 085 an
// agent token can call it unattended on a schedule, so a loop could search,
// file documents and queue OCR without bound.
//
// What this does — one door, the SAME meter
// ---------------------------------------------------------------------------
// runMeteredToolCall() wraps the one callTool() in api/mcp.mjs:
//
//   1. THE RATE CEILING, every call. connector_rate_consume (086 §3) counts
//      the call against the agent token's hourly window (agents only), then
//      the account's. The numbers are usage_budgets rows (kind 'connector' and
//      'connector_agent', 086 §2) — the same table the spend caps live in, so
//      Eden changes them with one UPDATE and nothing redeploys. Workshop is
//      never refused.
//   2. THE MONEY, only where a call has a provider cost. file_document and
//      ingest_document embed text and may OCR a scanned image; they are
//      charged through usage_consume with kind 'ingest', exactly as
//      /api/ingest charges an upload (lib/usage-prices.mjs
//      estimateIngestCents), on the same wallet, the same credits and the
//      same ingest window. There is no second billing system.
//      After the call the estimate is reconciled (usage_record_actual): to 0
//      when nothing ran, up to the OCR route's reported cost when one ran.
//      Every other tool is free: reads cost a database query, and the PDF /
//      deck / chart tools are local CPU. search's query embedding is about
//      $0.0000004, far below the meter's one-cent unit, and the in-app search
//      does not charge it either — so it is rate-limited, not charged.
//   3. ATTRIBUTION. A charged event's meta gets {via:'connector', tool,
//      actor}: `agent:<token id>` for an agent (the same ref the Record uses),
//      `token:<token id>` for a user connector token, `oauth:<grant id>` for
//      a full-assistant OAuth connection (089; plain `oauth` for a token
//      that names no grant). That is what lets Connections › Agents show per-agent spend
//      later. The tool NAME is recorded; its arguments never are — no query
//      text, no filename, no document text reaches a meter row.
//   4. REFUSALS ARE SENTENCES. The agent reads the tool result, so a refusal
//      is one plain sentence saying what limit was reached and when it resets
//      (HH:MM UTC) — never JSON, never a stack — returned as an MCP error
//      result so the tool call is visibly refused.
//
// Outages
// ---------------------------------------------------------------------------
//   * connector_rate_consume missing (086 not pasted yet): no rate ceiling;
//     costed calls are still charged through usage_consume. This is the state
//     between merge and paste.
//   * connector_rate_consume erroring (5xx, timeout, network): a READ is
//     admitted — nobody is locked out of their own documents — and every
//     other call goes through lib/usage-meter.mjs's outage ceiling
//     (DEGRADED_CEILING), which never refuses workshop.
//   * usage_consume erroring on a costed call: lib/usage-meter.mjs's outage
//     ceiling, the same as every in-app path.

import {
  callRpc, looksUndeployed, consumeUsage, recordActualUsage, admitDuringOutage, formatUtcTime,
} from './usage-meter.mjs';
import { estimateIngestCents, EMBED_USD_PER_MTOK } from './usage-prices.mjs';
import { OCRABLE_IMAGE_EXTENSIONS } from './ingest-formats.mjs';

const LOG = '[connector-meter]';

/**
 * Every tool, by what it costs us. A tool not listed here (a new one) is
 * treated as WORK: counted, never charged, and limited during an outage —
 * never silently unmetered.
 */
export const READ_TOOLS = new Set([
  'list_matters', 'list_matter_contents', 'search', 'get_passage', 'get_outline',
  'grep', 'get_media', 'get_matter_state', 'check_ingest_status', 'my_tasks',
]);
export const COSTED_TOOLS = new Set(['file_document', 'ingest_document']);

/**
 * Not counted against the rate ceiling at all (Eden, 2026-09-25: "exempt
 * my_tasks"). An agent is TOLD to poll my_tasks, and a 30-second poll alone is
 * 120 calls an hour — half of free's agent ceiling spent on asking "anything
 * for me?". It is one indexed read of the caller's own task rows, so the cost
 * of an unlimited poll is a database query, not a provider bill. Everything
 * the agent does once it has a task is still counted.
 */
export const RATE_EXEMPT_TOOLS = new Set(['my_tasks']);

/** The meter `kind` a costed connector call is charged under — the app's own. */
export const CONNECTOR_CHARGE_KIND = 'ingest';

export function toolClass(name) {
  if (READ_TOOLS.has(name)) return 'read';
  if (COSTED_TOOLS.has(name)) return 'costed';
  return 'work';
}

/** Who made the call, as a meter row records it. Never content. */
export function actorRef(identity) {
  if (identity?.kind === 'agent' && identity.tokenId) return `agent:${identity.tokenId}`;
  if (identity?.tokenId) return `token:${identity.tokenId}`;
  // 089: a full-assistant OAuth sign-in is named by its grant.
  if (identity?.grantId) return `oauth:${identity.grantId}`;
  return 'oauth';
}

function decodedBytes(content, encoding) {
  if (typeof content !== 'string') return 0;
  if (encoding === 'base64') {
    const clean = content.replace(/\s+/g, '');
    const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
  }
  return Buffer.byteLength(content, 'utf8');
}

function extOf(filename) {
  const s = String(filename || '');
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i).toLowerCase() : '';
}

/**
 * The pre-call estimate for a costed tool, in cents, computed the way
 * /api/ingest computes it. `sb` (the caller's own RLS-scoped client) is used
 * only to read a stored document's size for ingest_document.
 */
export async function estimateConnectorCents(name, args = {}, { sb = null } = {}) {
  if (name === 'file_document') {
    const bytes = decodedBytes(args.content, args.encoding === 'base64' ? 'base64' : 'utf8');
    return {
      cents: estimateIngestCents({ bytes, ocrableImage: OCRABLE_IMAGE_EXTENSIONS.includes(extOf(args.filename)) }),
      bytes,
      ocrableImage: OCRABLE_IMAGE_EXTENSIONS.includes(extOf(args.filename)),
    };
  }
  if (name === 'ingest_document') {
    let bytes = 0;
    let ocrableImage = false;
    if (sb && typeof args.document_id === 'string') {
      try {
        const { data } = await sb.from('documents')
          .select('file_size_bytes, source_filename').eq('id', args.document_id).maybeSingle();
        bytes = Number(data?.file_size_bytes) || 0;
        ocrableImage = OCRABLE_IMAGE_EXTENSIONS.includes(extOf(data?.source_filename));
      } catch { /* the size is unknown; the handler reports a bad id itself */ }
    }
    return { cents: estimateIngestCents({ bytes, ocrableImage }), bytes, ocrableImage };
  }
  return { cents: 0, bytes: 0, ocrableImage: false };
}

const centsUp = (usd) => Math.max(0, Math.ceil(usd * 100));

/** What the call really cost, once it has run. */
export function actualConnectorCents(name, est, { result = null, error = null } = {}) {
  if (error) return 0;                        // refused or invalid: nothing ran
  if (name === 'ingest_document' && result?.status === 'ready') return 0;   // "nothing to do"
  if (name === 'file_document') {
    const raw = result?.ocr_route?.estimated_usd;
    const ocrUsd = raw == null ? NaN : Number(raw);
    if (Number.isFinite(ocrUsd) && ocrUsd >= 0) {
      const embedUsd = (Math.ceil((est.bytes || 0) / 3) / 1e6) * EMBED_USD_PER_MTOK;
      return centsUp(embedUsd + ocrUsd);
    }
  }
  return est.cents;
}

// ---------------------------------------------------------------------------
// The sentences
// ---------------------------------------------------------------------------

function resetClause(resetAtSec, retryAfterSeconds, nowMs) {
  const ms = resetAtSec ? resetAtSec * 1000
    : retryAfterSeconds ? nowMs + retryAfterSeconds * 1000
      : null;
  return ms ? `The limit resets at ${formatUtcTime(ms)}.` : 'Try again in a little while.';
}

export function rateRefusalSentence(rate, identity, nowMs = Date.now()) {
  const max = rate?.window_max_requests;
  const per = Number(rate?.window_seconds) === 3600 ? 'per hour'
    : rate?.window_seconds ? `per ${Math.round(rate.window_seconds / 60)} minutes` : 'per hour';
  const when = resetClause(rate?.reset_at, rate?.retry_after_seconds, nowMs);
  if (rate?.reason === 'over_agent_rate') {
    const who = identity?.name ? `This agent connection ("${identity.name}")` : 'This agent connection';
    return `${who} has reached its limit of ${max} Contextspaces calls ${per}. ${when} `
      + 'Nothing was done for this call. The account owner can raise the limit.';
  }
  return `This Contextspaces account has reached its limit of ${max} connector calls ${per}, `
    + `counting every connected assistant and agent together. ${when} `
    + 'Nothing was done for this call. Work inside Contextspaces itself is not affected.';
}

export function meterRefusalSentence(decision, nowMs = Date.now()) {
  const base = decision?.message
    || "You've reached this month's included AI usage. It resets at the start of next month.";
  const when = decision?.status === 429 && decision?.retryAfterSeconds && !/resets at/.test(base)
    ? ` Try again after ${formatUtcTime(nowMs + decision.retryAfterSeconds * 1000)}.`
    : '';
  return `${base}${when} Nothing was done for this call.`;
}

const refusal = (text) => ({ content: [{ type: 'text', text }], isError: true });

// ---------------------------------------------------------------------------
// The door
// ---------------------------------------------------------------------------

/**
 * Meter one connector tool call and run it.
 *
 * @param {object} p
 * @param {object} p.identity   api/mcp.mjs authenticate()'s result
 * @param {string} p.name       the tool
 * @param {object} p.args       its arguments (read for sizes only; never stored)
 * @param {object} p.sb         the caller's RLS-scoped client
 * @param {() => Promise<any>} p.invoke  runs the tool (callTool)
 * @returns the MCP CallTool result: {content:[{type:'text',text}], isError?}
 */
export async function runMeteredToolCall({
  identity, name, args = {}, sb = null, invoke,
  env = process.env, fetchImpl = null, nowMs = undefined,
}) {
  const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = env.VITE_SUPABASE_ANON_KEY;
  const userId = identity?.userId || null;
  const agentToken = identity?.kind === 'agent' ? identity.tokenId || null : null;
  const cls = toolClass(name);
  const now = () => nowMs ?? Date.now();

  // ---- 1. the rate ceiling ------------------------------------------------
  let tier = null;
  if (supabaseUrl && serviceKey && userId && !RATE_EXEMPT_TOOLS.has(name)) {
    let rate = null;
    let failure = null;
    try {
      const { status, payload, text } = await callRpc('connector_rate_consume', {
        supabaseUrl, apikey: serviceKey, bearer: serviceKey, fetchImpl,
        args: { p_user: userId, p_agent_token: agentToken },
      });
      if (looksUndeployed(status, payload, text)) {
        console.warn(`${LOG} connector_rate_consume not deployed — paste migration 086; no rate ceiling yet`);
      } else if (status !== 200 || !payload || typeof payload !== 'object') {
        failure = `connector_rate_consume returned ${status}`;
      } else {
        rate = payload;
      }
    } catch (err) {
      failure = `connector_rate_consume threw: ${err?.message || err}`;
    }

    if (rate) {
      tier = typeof rate.tier === 'string' ? rate.tier : null;
      if (rate.allowed === false) {
        console.warn(`${LOG} refused tool=${name} reason=${rate.reason} actor=${actorRef(identity)}`);
        return refusal(rateRefusalSentence(rate, identity, now()));
      }
    } else if (failure && cls !== 'read') {
      const d = await admitDuringOutage(failure, {
        userId, kind: 'connector', estimateCents: 0, costed: true, env, nowMs,
        supabaseUrl, serviceKey, fetchImpl,
      });
      if (!d.allowed) return refusal(meterRefusalSentence(d, now()));
    } else if (failure) {
      console.error(`${LOG} ${failure} — read admitted`);
    }
  }

  // ---- 2. the money, for a costed call -------------------------------------
  let charge = null;
  if (cls === 'costed' && userId) {
    const est = await estimateConnectorCents(name, args, { sb });
    const meter = await consumeUsage({
      supabaseUrl, anonKey, serviceKey, userId,
      kind: CONNECTOR_CHARGE_KIND, estimateCents: est.cents,
      knownTier: tier, env, nowMs, fetchImpl,
    });
    if (!meter.allowed) {
      console.warn(`${LOG} charge refused tool=${name} reason=${meter.reason} actor=${actorRef(identity)}`);
      return refusal(meterRefusalSentence(meter, now()));
    }
    charge = { est, eventId: meter.eventId };
  }

  // ---- 3. the call, then the reconciliation --------------------------------
  const settle = async (outcome) => {
    if (!charge?.eventId) return;
    await recordActualUsage({
      supabaseUrl, serviceKey, fetchImpl,
      eventId: charge.eventId,
      cents: actualConnectorCents(name, charge.est, outcome),
      // Metadata only. The allow-list is these three keys; nothing from args.
      meta: { via: 'connector', tool: name, actor: actorRef(identity) },
    });
  };

  try {
    const result = await invoke();
    await settle({ result });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    await settle({ error: err });
    return {
      content: [{ type: 'text', text: `ERROR: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}
