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

import { gateLlmRequest } from '../lib/ai-tier-policy.mjs';
import { sealedRouteFor } from '../lib/llm-sealed-route.mjs';

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

  // SecureSpace sealed route (2026-09-19). A Tier-B matter admits exactly one
  // provider — 'aws-bedrock' — and the browser cannot be trusted to pick it:
  // only the server can read the matter's tier. So when the gate refuses a
  // sealed matter's default pen, the sealed route is substituted here and the
  // wire shape is translated in both directions (lib/llm-sealed-route.mjs).
  // It returns null for every other outcome, so Tier A and Tier C reach the
  // original forward below byte-identically. The substitution can only ever
  // narrow: an untranslatable request or an unprovisioned sealed pen is
  // REFUSED, never sent to the provider the client named.
  const sealed = sealedRouteFor({ gate, provider, model, body });
  if (sealed?.refusal) return json(res, sealed.refusal.status, sealed.refusal.body);
  if (!sealed && !gate.ok) return json(res, gate.status, { error: gate.error, tier: gate.tier, provider: gate.provider });
  if (typeof body !== 'string') return json(res, 400, { error: 'body must be a JSON string' });

  let upstream;
  if (sealed) {
    upstream = await sealed.send();
    res.setHeader('access-control-expose-headers', 'x-contextspaces-pen');
    const penLabel = upstream.headers.get('x-contextspaces-pen');
    if (penLabel) res.setHeader('x-contextspaces-pen', penLabel);
  } else {
    const key = apiKey || process.env[route.envKey];
    if (!key) return json(res, 400, { error: `no_api_key for ${provider}; set ${route.envKey} or supply your own key` });
    try {
      upstream = await fetch(route.url(model), { method: 'POST', headers: route.headers(key), body });
    } catch (err) {
      return json(res, 502, { error: `proxy_error: ${err.message || 'fetch failed'}` });
    }
  }

  const passthroughType = upstream.headers.get('content-type') || 'application/json';
  res.statusCode = upstream.status;
  res.setHeader('content-type', passthroughType);
  res.setHeader('cache-control', 'no-cache');

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
