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
// NOTE: like the dev proxy, this endpoint is currently unauthenticated —
// it proxies the server's API keys. If abuse becomes a concern, gate it on
// a forwarded Supabase JWT (the cite-check engine already has the session
// and can send it; src/lib/llm/generate.ts would need the same change).

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
};

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const parsed = typeof req.body === 'string' ? safeJsonParse(req.body) : req.body;
  if (!parsed || typeof parsed !== 'object') return json(res, 400, { error: 'invalid_body' });
  const { provider, model, body, apiKey } = parsed;

  const route = PROVIDER_ROUTES[provider];
  if (!route) return json(res, 400, { error: `unknown_provider: ${provider}` });
  const key = apiKey || process.env[route.envKey];
  if (!key) return json(res, 400, { error: `no_api_key for ${provider}; set ${route.envKey} or supply your own key` });
  if (typeof body !== 'string') return json(res, 400, { error: 'body must be a JSON string' });

  let upstream;
  try {
    upstream = await fetch(route.url(model), { method: 'POST', headers: route.headers(key), body });
  } catch (err) {
    return json(res, 502, { error: `proxy_error: ${err.message || 'fetch failed'}` });
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
