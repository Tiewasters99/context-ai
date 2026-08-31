import type { StructuredRequest, TokenUsage } from './types';
import { findModel } from './providers';
import { adapters } from './adapters';
import { llmAuthHeader } from './auth';

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
    let detail = `Model API error (${res.status})`;
    try {
      const errBody = JSON.parse(text);
      detail = errBody.error?.message || (typeof errBody.error === 'string' ? errBody.error : detail);
    } catch { /* keep default */ }
    throw new Error(detail);
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
