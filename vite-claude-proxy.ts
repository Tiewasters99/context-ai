import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from 'vite';

// Absolute file: URL to the CLI's free-DB fetchers, resolved from the
// project root (process.cwd() in the Vite config context) so the dynamic
// import works regardless of where Vite stages its bundled config.
const SOURCES_MODULE_URL = pathToFileURL(path.join(process.cwd(), 'cite-check', 'lib', 'sources.mjs')).href;

// Dev shim target for the /api/assistant Vercel function (lib/assistant-core.mjs),
// so the in-app Assistant works under `vite dev` without `vercel dev`.
const ASSISTANT_MODULE_URL = pathToFileURL(path.join(process.cwd(), 'lib', 'assistant-core.mjs')).href;

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

      // Dev shim for the /api/legal-source Vercel function: proxy the free
      // legal-DB fetchers so the browser cite-check engine works under `vite
      // dev` without `vercel dev`. Production uses api/legal-source.mjs.
      server.middlewares.use('/api/legal-source', async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let parsed: { authority_type?: string; citation_bluebook?: string; case_name?: string };
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }
        try {
          const { fetchStatute, fetchCase } = await import(SOURCES_MODULE_URL);
          const cite = {
            citation_bluebook: parsed.citation_bluebook ?? null,
            case_name: parsed.case_name ?? null,
          };
          const t = parsed.authority_type;
          let result;
          if (t === 'statute' || t === 'regulation' || t === 'rule') {
            result = await fetchStatute(cite);
          } else if (t === 'case') {
            result = await fetchCase(cite);
          } else {
            result = await fetchStatute(cite);
            if (!result?.found && cite.case_name) result = await fetchCase(cite);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result ?? { found: false }));
        } catch (err: unknown) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ found: false, error: err instanceof Error ? err.message : 'fetch_failed' }));
        }
      });

      // Dev shim for the /api/assistant Vercel function: runs the in-app
      // Assistant agent loop under `vite dev`. Production uses api/assistant.mjs.
      server.middlewares.use('/api/assistant', async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let parsed: { messages?: { role: 'user' | 'assistant'; content: string }[]; matterId?: string };
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        const auth = req.headers['authorization'];
        if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing_bearer' }));
          return;
        }
        const userToken = auth.slice(7).trim();

        const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
        const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
        const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
        const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
        const missing: string[] = [];
        if (!SUPABASE_URL) missing.push('VITE_SUPABASE_URL');
        if (!SUPABASE_ANON_KEY) missing.push('VITE_SUPABASE_ANON_KEY');
        if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
        if (!OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
        if (missing.length) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'config_error', missing_env: missing }));
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
        });
        const emit = (ev: unknown) => {
          try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* client gone */ }
        };
        try {
          const { createClient } = await import('@supabase/supabase-js');
          const { runAssistantStream } = await import(ASSISTANT_MODULE_URL);
          const sb = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
            global: { headers: { Authorization: `Bearer ${userToken}` } },
            auth: { persistSession: false, autoRefreshToken: false },
          });
          const { usedTools } = await runAssistantStream({
            supabase: sb,
            anthropicKey: ANTHROPIC_API_KEY,
            openaiApiKey: OPENAI_API_KEY,
            messages: parsed.messages || [],
            matterId: parsed.matterId || undefined,
          });
          emit({ type: 'done', usedTools });
        } catch (err: unknown) {
          emit({ type: 'error', message: err instanceof Error ? err.message : 'assistant_failed' });
        } finally {
          res.end();
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
