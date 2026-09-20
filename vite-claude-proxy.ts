import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { Plugin } from 'vite';
// The SecureSpace gate — same module the prod handler uses.
import { gateLlmRequest } from './lib/ai-tier-policy.mjs';
// …and the sealed route it substitutes on a Tier-B matter. Mirrored here so a
// sealed matter behaves the same under `vite dev` as it does on Vercel.
import { sealedRouteFor } from './lib/llm-sealed-route.mjs';
// …and the matter's Record. Mirrored for the same reason, and it is the seal's
// reason rather than the meter's: "a sealed exchange either writes an
// undeletable record row or the answer is withheld" is a promise about the
// product, and a dev server that answered a sealed matter without recording it
// would be a place where that promise is false. The SPEND CAP is deliberately
// still not mirrored here — that one is about money, and dev spends none.
import {
  ledgerClientFor, newCallId, normalizeFeature,
  recordLlmReceived, recordLlmRequested, exchangeUnrecordedRefusal,
} from './lib/llm-record.mjs';

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
  moonshot: {
    url: () => 'https://api.moonshot.ai/v1/chat/completions',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    }),
    envKey: 'MOONSHOT_API_KEY',
    streamType: 'sse',
  },
  fireworks: {
    url: () => 'https://api.fireworks.ai/inference/v1/chat/completions',
    headers: (key) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    }),
    envKey: 'FIREWORKS_API_KEY',
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
/** Whether the caller asked the provider to stream, whatever it calls it. */
function asksForStream(bodyText: string, provider: string): boolean {
  if (provider === 'google') return true;   // streamGenerateContent&alt=sse
  try { return JSON.parse(bodyText)?.stream === true; } catch { return false; }
}

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
        let parsed: {
          messages?: { role: 'user' | 'assistant'; content: string }[];
          matterId?: string;
          context?: { route?: string; tab?: string; matterName?: string };
          sessionId?: string;
          escalate?: boolean;
          charterId?: string;
        };
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
          const { runAssistantStream, bedrockCredsFromEnv } = await import(ASSISTANT_MODULE_URL);
          const sb = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
            global: { headers: { Authorization: `Bearer ${userToken}` } },
            auth: { persistSession: false, autoRefreshToken: false },
          });
          const result = await runAssistantStream({
            supabase: sb,
            anthropicKey: ANTHROPIC_API_KEY,
            // The sealed pen (SecureSpace Tier B) is Bedrock alone — our own
            // AWS account, zero retention. Without it a sealed matter is
            // refused. Fireworks: passed and ignored since 2026-09-19.
            fireworksKey: process.env.FIREWORKS_API_KEY,
            bedrockCreds: bedrockCredsFromEnv(),
            openaiApiKey: OPENAI_API_KEY,
            messages: parsed.messages || [],
            matterId: parsed.matterId || undefined,
            context: parsed.context || undefined,
            emit,
            sessionId: typeof parsed.sessionId === 'string' && parsed.sessionId ? parsed.sessionId : undefined,
            escalate: parsed.escalate === true,
            // Agents: only the charter ID crosses the wire; the charter is
            // loaded server-side under the user's own RLS.
            charterId: typeof parsed.charterId === 'string' && parsed.charterId
              ? parsed.charterId.slice(0, 80)
              : undefined,
          });
          emit({ type: 'done', ...result });
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

        let parsed: {
          provider: string; model: string; body: string; apiKey?: string;
          matterId?: string; feature?: string; documentIds?: string[];
        };
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

        // SecureSpace gate: JWT required; matter-bound requests checked
        // against the matter's tier server-side. Same module as prod.
        const gate = await gateLlmRequest({
          supabaseUrl: process.env.VITE_SUPABASE_URL,
          anonKey: process.env.VITE_SUPABASE_ANON_KEY,
          serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          bearer: req.headers['authorization'],
          provider: parsed.provider,
          matterId: parsed.matterId,
        });

        // The matter's Record, same two rows as api/llm.mjs, same order.
        const feature = normalizeFeature(parsed.feature);
        const callId = newCallId();
        const bearerToken = String(req.headers['authorization'] ?? '').replace(/^bearer\s+/i, '').trim();
        const ledger = parsed.matterId && bearerToken
          ? ledgerClientFor({
              supabaseUrl: process.env.VITE_SUPABASE_URL,
              anonKey: process.env.VITE_SUPABASE_ANON_KEY,
              bearer: bearerToken,
            })
          : null;
        const actor = { kind: 'user' as const, ref: ('userId' in gate ? gate.userId : null) ?? null };
        const startedAt = Date.now();
        const recordFields = (penProvider: string | null, penModel: string | null, isSealed: boolean) => ({
          matterId: parsed.matterId,
          actor,
          feature,
          callId,
          tier: gate.tier ?? null,
          provider: penProvider,
          model: penModel,
          clientProvider: parsed.provider,
          clientModel: parsed.model,
          sealed: isSealed,
          streaming: asksForStream(parsed.body, parsed.provider),
          documentIds: parsed.documentIds ?? null,
        });
        const recordRefused = async (code: string, status: number, penProvider: string | null, penModel: string | null, isSealed: boolean) => {
          if (!ledger) return;
          if (!gate.ok && ['auth_required', 'auth_not_configured', 'matter_not_found'].includes(String(gate.error))) return;
          await recordLlmRequested(ledger, { ...recordFields(penProvider, penModel, isSealed), refused: code, status }).catch(() => {});
        };

        // SecureSpace sealed route — the same substitution api/llm.mjs makes:
        // a Tier-B matter is served by the sealed pen or refused, never by the
        // provider the browser named. Returns null on every other outcome, so
        // Tier A and Tier C fall through unchanged.
        const sealed = sealedRouteFor({
          gate,
          provider: parsed.provider,
          model: parsed.model,
          body: parsed.body,
        });
        if (sealed && 'refusal' in sealed) {
          res.writeHead(sealed.refusal.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(sealed.refusal.body));
          await recordRefused(String(sealed.refusal.body?.error ?? 'refused'), sealed.refusal.status, null, null, true);
          return;
        }
        if (!sealed && !gate.ok) {
          res.writeHead(gate.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: gate.error, tier: gate.tier, provider: gate.provider }));
          const onSeal = gate.tier === 'B';
          await recordRefused(String(gate.error), gate.status, onSeal ? null : parsed.provider, onSeal ? null : parsed.model, onSeal);
          return;
        }

        // Row 1 — before any provider is contacted. Strict on a sealed matter,
        // so a dev server keeps "no record, no answer" too.
        const penProvider = sealed ? sealed.provider : parsed.provider;
        const penModel = sealed ? sealed.pen.model : parsed.model;
        if (ledger) {
          try {
            await recordLlmRequested(ledger, {
              ...recordFields(penProvider, penModel, Boolean(sealed)),
              strict: gate.tier === 'B',
            });
          } catch {
            const unrecorded = exchangeUnrecordedRefusal();
            res.writeHead(unrecorded.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(unrecorded.body));
            return;
          }
        }
        const settleRecord = async (outcome: string, status: number) => {
          if (!ledger) return;
          await recordLlmReceived(ledger, {
            ...recordFields(penProvider, penModel, Boolean(sealed)),
            outcome,
            status,
            ms: Date.now() - startedAt,
          }).catch(() => {});
        };

        if (sealed) {
          const sealedRes = await sealed.send();
          res.writeHead(sealedRes.status, {
            'Content-Type': sealedRes.headers.get('content-type') ?? 'application/json',
            'Cache-Control': 'no-cache',
            'X-Contextspaces-Pen': sealedRes.headers.get('x-contextspaces-pen') ?? '',
            'Access-Control-Expose-Headers': 'x-contextspaces-pen',
          });
          if (sealedRes.body) {
            const reader = sealedRes.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(Buffer.from(value));
            }
          }
          res.end();
          await settleRecord(sealedRes.ok ? 'ok' : 'provider_error', sealedRes.status);
          return;
        }

        // BYOK: user key takes priority, then env var
        const apiKey = parsed.apiKey || process.env[route.envKey];
        if (!apiKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `No API key for ${parsed.provider}. Set ${route.envKey} in .env or provide your own key in Vault Settings.` }));
          await recordRefused('no_api_key', 400, penProvider, penModel, false);
          return;
        }

        const url = route.url(parsed.model);
        const headers = route.headers(apiKey);

        // Plain https.request, not fetch: Node's fetch (undici) gives up if
        // response HEADERS take more than 300s, and a thinking model on a
        // non-streaming structured call can hold the line longer than that
        // before it sends anything. The socket timeout below is inactivity-
        // based and generous.
        try {
          const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
            const r = httpsRequest(url, { method: 'POST', headers, timeout: 900_000 }, resolve);
            r.on('timeout', () => r.destroy(new Error('upstream sent nothing for 900s')));
            r.on('error', reject);
            r.end(parsed.body);
          });
          res.writeHead(upstream.statusCode ?? 502, {
            'Content-Type': (upstream.headers['content-type'] as string | undefined) ?? 'application/json',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          upstream.pipe(res);
          // The status decides the outcome, not the fact that the pipe
          // finished: a 429 body pipes through just as cleanly as an answer.
          upstream.on('end', () => {
            const status = upstream.statusCode ?? 200;
            void settleRecord(status < 400 ? 'ok' : 'provider_error', status);
          });
        } catch (err: unknown) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Proxy error: ${err instanceof Error ? err.message : 'Unknown'}` }));
          await settleRecord('provider_error', 502);
        }
      });
    },
  };
}
