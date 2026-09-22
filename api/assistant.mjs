// POST /api/assistant
//
// In-app Assistant endpoint (Milestone 1). Runs a server-side Claude tool-use
// loop over the existing Contextspaces search tools and returns an answer with
// page citations, scoped to the user's current matter.
//
// Auth: the browser is already logged in via Supabase Auth; it forwards its
// session access token as Authorization: Bearer. All Supabase queries run
// through a client carrying that JWT, so RLS enforces matter access — the
// assistant can only read what the signed-in user can read.
//
// Request body:
//   { messages: {role:'user'|'assistant', content:string}[], matterId?: string,
//     context?: { route?: string, tab?: string, matterName?: string },
//     sessionId?: string, escalate?: boolean, charterId?: string }
//
// Response:
//   { text: string, usedTools: string[] }     on success
//   { error: string }                          on failure (with status code)
//
// Note: Vercel serverless timeout is 30s (vercel.json). A multi-round tool
// loop on Opus usually finishes well under that; streaming (M1.1) removes the
// ceiling entirely.

import { createClient } from '@supabase/supabase-js';

import { runAssistantStream, bedrockCredsFromEnv, PENS } from '../lib/assistant-core.mjs';
import { consumeUsage, recordActualUsage, sendUsageRefusal } from '../lib/usage-meter.mjs';
import { requireEntitlement, sendEntitlementRefusal } from '../lib/entitlements.mjs';
import { estimateLlmCents, centsForTokens } from '../lib/usage-prices.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// The sealed pen (SecureSpace Tier B) is Bedrock and only Bedrock: a model in
// our own AWS account under zero retention (docs/BEDROCK_CLAUDE_PEN_SETUP.md).
// Optional at boot — without it a sealed matter is refused in plain language,
// never served by another provider. Fireworks: passed and ignored since 09-19.
const BEDROCK_CREDS = bedrockCredsFromEnv();
const FIREWORKS_API_KEY = process.env.FIREWORKS_API_KEY;


export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'method_not_allowed' });
  }

  // Env sanity
  const missing = [];
  if (!SUPABASE_URL) missing.push('VITE_SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) missing.push('VITE_SUPABASE_ANON_KEY');
  if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (missing.length) {
    return json(res, 500, { error: 'config_error', missing_env: missing });
  }

  // Auth: forward the user's Supabase session JWT so RLS applies.
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return json(res, 401, { error: 'missing_bearer' });
  }
  const userToken = authHeader.slice(7).trim();
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const body = typeof req.body === 'string' ? safeJsonParse(req.body) : req.body;
  const messages = body?.messages;
  const matterId = body?.matterId || undefined;
  const context = sanitizeContext(body?.context);
  // SecureSpace: continue a recorded session; ask for the frontier pen on a
  // sealed matter (recorded as an escalation — the server decides, the
  // client only asks).
  const sessionId = typeof body?.sessionId === 'string' && body.sessionId ? body.sessionId : undefined;
  const escalate = body?.escalate === true;
  // Agents: run under a charter. Only the ID travels — the charter's prose
  // and its toolset are loaded server-side (lib/agent-charter.mjs) through
  // the same user-scoped client, so RLS decides whether this user may run
  // it and the browser cannot supply the instructions.
  const charterId = typeof body?.charterId === 'string' && body.charterId ? body.charterId.slice(0, 80) : undefined;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json(res, 400, { error: 'messages (non-empty array) required' });
  }

  // Agents is a frozen surface (lib/surfaces.mjs). This endpoint serves TWO
  // things — the core Assistant, which every plan gets, and a turn run under a
  // charter, which is the Agents surface itself — so the gate is keyed on the
  // charter and not on the endpoint. That can only narrow: omitting charterId
  // buys the plain Assistant, never an agent. The real lock is migration 083,
  // which refuses a non-entitled account the charter row in the first place;
  // this is the second door, for a charter written before the fence went up or
  // shared into a matter. The getUser round trip is paid only on this path, so
  // the core Assistant is exactly as fast as it was.
  if (charterId) {
    const { data: who } = await sb.auth.getUser();
    const gate = await requireEntitlement(who?.user?.id ?? null, 'agents', { bearer: userToken });
    if (!gate.ok) return sendEntitlementRefusal(res, gate);
  }

  // The spend cap (migration 063). Checked HERE, before a single SSE byte
  // goes out: once the stream has started the only way to say no is an
  // `error` event, and a budget refusal deserves a real status code the UI can
  // route on. The estimate is one round's worth — the loop may take up to six,
  // but this path reconciles against the real token counts below, so the
  // pre-charge only has to be conservative enough to stop a user who is
  // already over.
  const bearer = userToken;
  const meterUrl = SUPABASE_URL;
  const meter = await consumeUsage({
    supabaseUrl: meterUrl,
    anonKey: SUPABASE_ANON_KEY,
    bearer,
    kind: 'assistant',
    estimateCents: estimateLlmCents({
      provider: 'anthropic',
      model: PENS.anthropic.model,
      bodyText: JSON.stringify(messages).slice(0, 400_000),
      maxOutputTokens: 4096,
    }),
  });
  if (!meter.allowed) return sendUsageRefusal(res, meter);

  // Stream the answer as Server-Sent Events. All validation above this point
  // returns a normal JSON status; once we start the stream we can only signal
  // failures as `error` events.
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const emit = (ev) => {
    try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* client disconnected */ }
  };

  try {
    const result = await runAssistantStream({
      supabase: sb,
      anthropicKey: ANTHROPIC_API_KEY,
      fireworksKey: FIREWORKS_API_KEY,
      bedrockCreds: BEDROCK_CREDS,
      openaiApiKey: OPENAI_API_KEY,
      messages,
      matterId,
      context,
      emit,
      sessionId,
      escalate,
      charterId,
    });
    emit({ type: 'done', ...result });
    // Reconcile the estimate against what the turn really cost. The pens'
    // prices are the ledger's own (PENS[*].pricePerM in lib/assistant-core),
    // so the meter and the ai_sessions ledger can never disagree about a
    // number. Best effort: a failure here must not spoil a delivered answer.
    if (meter.eventId && result?.usage) {
      await recordActualUsage({
        supabaseUrl: meterUrl,
        serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        eventId: meter.eventId,
        cents: penCents(result.model, result.provider, result.usage),
        model: result.model || null,
        meta: { route: 'assistant', provider: result.provider || null, tier: result.tier || null, tokens: result.usage },
      });
    }
  } catch (err) {
    emit({ type: 'error', message: err?.message || 'assistant_failed' });
  } finally {
    res.end();
  }
}

/** The pen's own list price where the model is one of ours; the shared table otherwise. */
function penCents(model, provider, usage) {
  const pen = Object.values(PENS).find((p) => p.model === model);
  if (pen?.pricePerM) {
    const usd = ((usage.input || 0) * pen.pricePerM.input + (usage.output || 0) * pen.pricePerM.output) / 1e6;
    return Math.max(0, Math.ceil(usd * 100));
  }
  return centsForTokens(model, provider, usage);
}


function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Situational context from the browser — keep only short strings so nothing
// oversized or oddly-typed reaches the system prompt.
function sanitizeContext(c) {
  if (!c || typeof c !== 'object') return undefined;
  const pick = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const num = (v) => (Number.isInteger(v) && v > 0 ? v : undefined);
  const out = {
    route: pick(c.route),
    tab: pick(c.tab),
    matterName: pick(c.matterName),
    // The reader's companion context: the document open in front of the
    // user, the page, and that page's text — bounded, since it is prompt,
    // not record.
    documentId: pick(c.documentId, 64),
    documentTitle: pick(c.documentTitle),
    page: num(c.page),
    pageCount: num(c.pageCount),
    pages: Array.isArray(c.pages)
      ? c.pages
        .slice(0, 2)
        .map((p) => (p && typeof p === 'object'
          ? { page: num(p.page), share: typeof p.share === 'number' ? Math.max(0, Math.min(1, p.share)) : undefined, text: pick(p.text, 3000) }
          : null))
        .filter((p) => p && p.page)
      : undefined,
    indexed: typeof c.indexed === 'boolean' ? c.indexed : undefined,
    sourceDocumentId: pick(c.sourceDocumentId, 64),
    unindexedReason: c.unindexedReason === 'generated' || c.unindexedReason === 'not-ingested' ? c.unindexedReason : undefined,
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}
