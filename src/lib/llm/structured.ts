import type { StructuredRequest, TokenUsage } from './types';
import { findModel } from './providers';
import { adapters } from './adapters';
import { llmAuthHeader } from './auth';
import { parseRefusalBody, ServerRefusalError, waitOutRateWindow } from './refusals';

export interface GenerateStructuredOptions extends StructuredRequest {
  /** Model id from providers.ts (e.g. 'claude-opus-4-8'). */
  modelId: string;
  signal?: AbortSignal;
  /** Optional BYOK key forwarded to the proxy. */
  apiKey?: string;
  /** Called with the provider-reported token usage, when available. */
  onUsage?: (usage: TokenUsage) => void;
  /** Bind this call to a matter: the server enforces the matter's tier. */
  matterId?: string;
}

/**
 * Ask a model for structured output matching `inputSchema` and return the
 * parsed object. Provider-neutral: the adapter for whichever model is
 * selected translates the request to that provider's tool/function-calling
 * format. Goes through the same `/api/llm` proxy as streaming generation,
 * but with `stream: false` — so the response is a single JSON object.
 *
 * Throws on network errors, API errors, unsupported providers, or if the
 * model declined to emit the tool call.
 */
export async function generateStructured<T = unknown>(options: GenerateStructuredOptions): Promise<T> {
  // One retry, and only for a rate window the server told us the length of.
  // Bucketizer, cite-check and the Editor each make dozens of these calls in a
  // row and the free tier's window is twenty a minute, so without this a long
  // run's normal ending is to die a fifth of the way in. Sitting out the
  // window the server named is what it asked for; everything else — a spent
  // wallet, a sealed matter, a provider error — is thrown straight through.
  try {
    return await sendStructured<T>(options);
  } catch (err) {
    if (!(await waitOutRateWindow(err, options.signal))) throw err;
    return sendStructured<T>(options);
  }
}

async function sendStructured<T>(options: GenerateStructuredOptions): Promise<T> {
  const { modelId, signal, apiKey, onUsage, matterId, ...request } = options;

  const found = findModel(modelId);
  if (!found) throw new Error(`Unknown model: ${modelId}`);
  const { provider, model } = found;
  const adapter = adapters[provider.id];

  const body = adapter.buildStructuredRequestBody(request, model);

  let res: Response;
  try {
    res = await fetch('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await llmAuthHeader()) },
      body: JSON.stringify({ provider: provider.id, model: model.apiModelId, body, apiKey, matterId }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error('Network error calling the model proxy.');
  }

  const text = await res.text();
  if (!res.ok) {
    let errBody: unknown = null;
    try { errBody = JSON.parse(text); } catch { /* not JSON */ }
    // A typed throw, not a bare Error: `.message` is still the sentence, and
    // a caller with a fallback pen or a per-item retry can now tell "the
    // provider hiccuped" from "the wallet is empty" and stop.
    throw new ServerRefusalError(parseRefusalBody(res.status, errBody, res.headers.get('retry-after')));
  }

  let responseJson: unknown;
  try {
    responseJson = JSON.parse(text);
  } catch {
    throw new Error('Model returned a non-JSON response.');
  }

  if (onUsage && adapter.parseUsage) {
    const usage = adapter.parseUsage(responseJson);
    if (usage) onUsage(usage);
  }

  const parsed = adapter.parseStructuredResponse(responseJson);
  if (parsed == null) throw new Error('Model did not return structured output.');
  return parsed as T;
}
