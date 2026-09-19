// POST /api/llm
//
// Production counterpart of the dev-only proxy in vite-claude-proxy.ts.
// Multi-provider passthrough so the browser never holds API keys.
//
// Request body: { provider, model, body, apiKey? }
//   - provider: 'anthropic' | 'openai' | 'google' | 'xai'
//   - model:    the provider's API model id (informational; the upstream
//               URL only needs it for Google)
//   - body:     a JSON string — the verbatim provider request body
//   - apiKey:   optional BYOK key; falls back to the server env var
//
// If `body` requests streaming the upstream stream is piped through; if it
// requests a single JSON object that object is returned as-is.
//
// SecureSpace gate (2026-08-21): every request requires a Supabase JWT,
// and a request bound to a matter (body.matterId) is checked against the
// matter's ai_tier server-side — the tier is read from the database,
// never trusted from the client. Fails closed on missing auth config.
//
// Spend cap (2026-09-19, migration 063): a JWT said WHO, and nothing said HOW
// MUCH. This is the widest hole in the product's cost surface — a verbatim
// passthrough to six providers, on our keys, with a caller-supplied body and
// maxDuration 300 — so it now carries three things it did not have:
//   1. a per-user monthly budget and rate window (lib/usage-meter.mjs);
//   2. a server-side ceiling on max_tokens, per tier, injected where the body
//      omits it (absent means "the model's maximum" on most routes);
//   3. a request-body size limit.
// Nothing else about the request or the response changes shape. If the meter
// is unreachable or migration 063 is not pasted yet, the request goes through
// and the fail-open is logged — see lib/usage-meter.mjs.

import { gateLlmRequest } from '../lib/ai-tier-policy.mjs';
import { consumeUsage, recordActualUsage, sendUsageRefusal, clampMaxTokens } from '../lib/usage-meter.mjs';
import { estimateLlmCents, centsForTokens } from '../lib/usage-prices.mjs';

// The ceiling that applies even when the meter cannot answer. Vercel's own
// request limit is well under this; it exists so "the meter is down" can never
// mean "post me a gigabyte".
const HARD_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
// The output allowance the PRE-call estimate assumes at most. A body asking
// for a million output tokens should not be able to price itself out of the
// month before the clamp below has cut it down.
const ESTIMATE_OUTPUT_CAP = 32768;

const PROVIDER_ROUTES = {
  anthropic: {
    url: () => 'https://api.anthropic.com/v1/messages',
    headers: (key) => ({ 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    envKey: 'ANTHROPIC_API_KEY',
  },
  openai: {
    url: () => 'https://api.openai.com/v1/chat/completions',
    headers: (key) => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` }),
    envKey: 'OPENAI_API_KEY',
  },
  google: {
    url: (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    headers: (key) => ({ 'content-type': 'application/json', 'x-goog-api-key': key }),
    envKey: 'GOOGLE_API_KEY',
  },
  xai: {
    url: () => 'https://api.x.ai/v1/chat/completions',
    headers: (key) => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` }),
    envKey: 'XAI_API_KEY',
  },
  moonshot: {
    url: () => 'https://api.moonshot.ai/v1/chat/completions',
    headers: (key) => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` }),
    envKey: 'MOONSHOT_API_KEY',
  },
  fireworks: {
    url: () => 'https://api.fireworks.ai/inference/v1/chat/completions',
    headers: (key) => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` }),
    envKey: 'FIREWORKS_API_KEY',
  },
};

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const parsed = typeof req.body === 'string' ? safeJsonParse(req.body) : req.body;
  if (!parsed || typeof parsed !== 'object') return json(res, 400, { error: 'invalid_body' });
  const { provider, model, body, apiKey, matterId } = parsed;

  const route = PROVIDER_ROUTES[provider];
  if (!route) return json(res, 400, { error: `unknown_provider: ${provider}` });

  const gate = await gateLlmRequest({
    supabaseUrl: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
    anonKey: process.env.VITE_SUPABASE_ANON_KEY,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    bearer: req.headers.authorization,
    provider,
    matterId,
  });
  if (!gate.ok) return json(res, gate.status, { error: gate.error, tier: gate.tier, provider: gate.provider });
  const key = apiKey || process.env[route.envKey];
  if (!key) return json(res, 400, { error: `no_api_key for ${provider}; set ${route.envKey} or supply your own key` });
  if (typeof body !== 'string') return json(res, 400, { error: 'body must be a JSON string' });

  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > HARD_MAX_REQUEST_BYTES) {
    return json(res, 413, {
      error: 'request_too_large',
      message: `That request is ${Math.round(bodyBytes / 1048576)} MB. Send less text at a time.`,
    });
  }

  // BYOK: the caller supplied their own provider key, so this is not our
  // money. Still metered for the RATE window — a passthrough is still our
  // bandwidth and our function-seconds — but charged nothing.
  const byok = Boolean(apiKey);
  const requestedOut = outputAllowanceOf(body, provider);
  const estimateCents = byok ? 0 : estimateLlmCents({
    provider,
    model,
    bodyText: body,
    maxOutputTokens: Math.min(requestedOut ?? 4096, ESTIMATE_OUTPUT_CAP),
  });

  const meter = await consumeUsage({
    supabaseUrl: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
    anonKey: process.env.VITE_SUPABASE_ANON_KEY,
    bearer: (req.headers.authorization || '').replace(/^bearer\s+/i, '').trim(),
    kind: 'llm',
    estimateCents,
  });
  if (!meter.allowed) return sendUsageRefusal(res, meter);

  if (meter.maxRequestBytes && bodyBytes > meter.maxRequestBytes) {
    return json(res, 413, {
      error: 'request_too_large',
      message: `That request is larger than your plan allows (${Math.round(meter.maxRequestBytes / 1024)} KB). Send less text at a time.`,
    });
  }

  // The output clamp. Per tier, from the same table as the budget.
  const { body: sendBody } = clampMaxTokens(body, provider, meter.maxOutputTokens);

  let upstream;
  try {
    upstream = await fetch(route.url(model), { method: 'POST', headers: route.headers(key), body: sendBody });
  } catch (err) {
    return json(res, 502, { error: `proxy_error: ${err.message || 'fetch failed'}` });
  }

  const passthroughType = upstream.headers.get('content-type') || 'application/json';
  res.statusCode = upstream.status;
  res.setHeader('content-type', passthroughType);
  res.setHeader('cache-control', 'no-cache');

  // A single-object answer is buffered so the provider's own token counts can
  // correct the pre-call estimate — same bytes, same headers, same status out.
  // A STREAM is left alone: teeing and re-parsing six providers' SSE dialects
  // to bill them is a new class of bug in the one path that must never stall,
  // so a streamed turn keeps its conservative estimate. Noted in the PR.
  const streaming = /event-stream/i.test(passthroughType) || isStreamRequest(body, provider);
  if (!streaming) {
    const text = await upstream.text();
    res.end(text);
    if (!byok && upstream.ok && meter.eventId) {
      const usage = usageFromResponse(text, provider);
      if (usage) {
        await recordActualUsage({
          supabaseUrl: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
          serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          eventId: meter.eventId,
          cents: centsForTokens(model, provider, usage),
          model,
          meta: { provider, route: 'llm', tokens: usage },
        });
      }
    }
    return;
  }

  if (upstream.body) {
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    return res.end();
  }
  const text = await upstream.text();
  return res.end(text);
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** The output allowance the caller asked for, whatever this provider calls it. */
function outputAllowanceOf(bodyText, provider) {
  const b = safeJsonParse(bodyText);
  if (!b || typeof b !== 'object') return null;
  const n = provider === 'google'
    ? b.generationConfig?.maxOutputTokens
    : (b.max_tokens ?? b.max_completion_tokens);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Google's route is streamGenerateContent&alt=sse; everyone else says so. */
function isStreamRequest(bodyText, provider) {
  if (provider === 'google') return true;
  const b = safeJsonParse(bodyText);
  return b?.stream === true;
}

/** Real token counts out of a non-streamed provider response, or null. */
function usageFromResponse(text, provider) {
  const j = safeJsonParse(text);
  if (!j || typeof j !== 'object') return null;
  if (provider === 'anthropic' && j.usage) {
    return { input: (j.usage.input_tokens || 0) + (j.usage.cache_creation_input_tokens || 0), output: j.usage.output_tokens || 0 };
  }
  if (j.usage && (j.usage.prompt_tokens != null || j.usage.completion_tokens != null)) {
    return { input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0 };
  }
  if (j.usageMetadata) {
    return { input: j.usageMetadata.promptTokenCount || 0, output: j.usageMetadata.candidatesTokenCount || 0 };
  }
  return null;
}
