import type { Plugin } from 'vite';

interface ProviderRoute {
  url: (model: string) => string;
  headers: (apiKey: string) => Record<string, string>;
  envKey: string;
  /** Whether this provider uses SSE (data: lines) or NDJSON streaming */
  streamType: 'sse' | 'ndjson';
}

const providerRoutes: Record<string, ProviderRoute> = {
  anthropic: {
    url: () => 'https://api.anthropic.com/v1/messages',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    }),
    envKey: 'ANTHROPIC_API_KEY',
    streamType: 'sse',
  },
  openai: {
    url: () => 'https://api.openai.com/v1/chat/completions',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    }),
    envKey: 'OPENAI_API_KEY',
    streamType: 'sse',
  },
  google: {
    url: (model) =>
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    headers: (key) => ({
      'Content-Type': 'application/json',
      'x-goog-api-key': key,
    }),
    envKey: 'GOOGLE_API_KEY',
    streamType: 'sse',
  },
  xai: {
    url: () => 'https://api.x.ai/v1/chat/completions',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    }),
    envKey: 'XAI_API_KEY',
    streamType: 'sse',
  },
};

/**
 * Multi-provider LLM proxy for Vite dev server.
 *
 * POST /api/llm
 * Body: { provider: "anthropic"|"openai"|"google"|"xai", model: "model-id", body: "JSON string" }
 *
 * Optional: pass apiKey in body for BYOK (user's own key).
 * Falls back to env var if no apiKey provided.
 */
export default function llmProxy(): Plugin {
  return {
    name: 'llm-proxy',
    configureServer(server) {
      // Keep the old /api/claude endpoint for backwards compat
      server.middlewares.use('/api/claude', async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks).toString();

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set in .env' }));
          return;
        }

        try {
          const upstream = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body,
          });

          if (upstream.body) {
            res.writeHead(upstream.status, {
              'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
              'Cache-Control': 'no-cache',
            });
            const reader = upstream.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) { res.end(); break; }
              res.write(value);
            }
          } else {
            const text = await upstream.text();
            res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
            res.end(text);
          }
        } catch (err: unknown) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Proxy error: ${err instanceof Error ? err.message : 'Unknown'}` }));
        }
      });

      // New multi-provider endpoint
      server.middlewares.use('/api/llm', async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);

        let parsed: { provider: string; model: string; body: string; apiKey?: string };
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        const route = providerRoutes[parsed.provider];
        if (!route) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Unknown provider: ${parsed.provider}` }));
          return;
        }

        // BYOK: user key takes priority, then env var
        const apiKey = parsed.apiKey || process.env[route.envKey];
        if (!apiKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `No API key for ${parsed.provider}. Set ${route.envKey} in .env or provide your own key in Vault Settings.` }));
          return;
        }

        const url = route.url(parsed.model);
        const headers = route.headers(apiKey);

        try {
          const upstream = await fetch(url, {
            method: 'POST',
            headers,
            body: parsed.body,
          });

          if (!upstream.ok) {
            const errText = await upstream.text();
            res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
            res.end(errText);
            return;
          }

          if (upstream.body) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });
            const reader = upstream.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) { res.end(); break; }
              res.write(value);
            }
          } else {
            const text = await upstream.text();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(text);
          }
        } catch (err: unknown) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Proxy error: ${err instanceof Error ? err.message : 'Unknown'}` }));
        }
      });
    },
  };
}
