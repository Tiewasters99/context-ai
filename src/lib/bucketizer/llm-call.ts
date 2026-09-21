// A structured model call that keeps the HTTP status.
//
// WHY THIS EXISTS, AND WHEN IT SHOULD STOP EXISTING
// ---------------------------------------------------------------------------
// `generateStructured()` (src/lib/llm/structured.ts) renders a failed call to
// a plain `Error` carrying only the human sentence from `llmErrorText`. For a
// single call that is right: the person reads the sentence and retries.
//
// A bulk run cannot work from a sentence. The usage meter (migration 063)
// answers an exhausted budget with 402 and a rate limit with 429 + a
// `retry-after` — and those two mean "PAUSE, the work so far is fine, come
// back", while every other failure means "this document did not classify,
// carry on". A run that cannot tell them apart either abandons eighty finished
// documents on a rate limit, or hammers a spent wallet four hundred more
// times. Both were live behaviours before this change.
//
// `src/lib/llm/*` belongs to another lane in this cycle, so rather than
// changing `generateStructured`'s error type under it, this module makes the
// same call through the same adapters, the same `/api/llm`, the same auth
// header and the same refusal copy — and throws an error that still has the
// status on it. It duplicates about twenty lines of `structured.ts` and no
// provider knowledge whatsoever: the adapter still owns the wire format
// (feedback: model-agnostic-architecture).
//
// FOLD THIS BACK when `generateStructured` grows a status-carrying error.
// This file should then become a thin re-export, and the bulk runner should
// not notice.

import { findModel } from '@/lib/llm/providers';
import { adapters } from '@/lib/llm/adapters';
import { llmAuthHeader } from '@/lib/llm/auth';
import { llmErrorText } from '@/lib/llm/refusals';
import type { StructuredRequest, TokenUsage } from '@/lib/llm/types';
import type { LlmRecordFields } from '@/lib/llm/features';
import { LlmCallError } from './llm-error';

export { LlmCallError } from './llm-error';

/**
 * `LlmRecordFields` is what the matter's Record is told about this call — the
 * act it performs and the documents it is working on. It is carried by the
 * same options object as the prompt, and separated from it below, exactly as
 * `generateStructured` does: `/api/llm` writes these two into the Record and
 * forwards `body` to the provider, so they must never be part of `body`.
 */
export interface StructuredCallOptions extends StructuredRequest, LlmRecordFields {
  modelId: string;
  matterId?: string;
  signal?: AbortSignal;
  onUsage?: (usage: TokenUsage) => void;
}

export interface StructuredCallOutcome {
  /** The raw tool input, unvalidated — the caller owns the contract check. */
  raw: unknown;
  /** Bytes of the request body actually sent, for the spend record. */
  requestBytes: number;
}

/**
 * One forced-tool call. Returns the model's raw tool input without judging
 * its shape: validation and repair are the window runner's business, because
 * only it knows which refs were on offer.
 */
export async function callStructured(options: StructuredCallOptions): Promise<StructuredCallOutcome> {
  // `feature` and `documentIds` are pulled OUT of `request` here deliberately:
  // what is left is the StructuredRequest the adapter turns into the provider
  // body, so neither can reach a provider even by accident.
  const { modelId, matterId, signal, onUsage, feature, documentIds, ...request } = options;

  const found = findModel(modelId);
  if (!found) throw new Error(`Unknown model: ${modelId}`);
  const { provider, model } = found;
  const adapter = adapters[provider.id];
  if (!adapter) throw new Error(`No adapter for provider: ${provider.id}`);

  const body = adapter.buildStructuredRequestBody(request, model);

  let res: Response;
  try {
    res = await fetch('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await llmAuthHeader()) },
      body: JSON.stringify({ provider: provider.id, model: model.apiModelId, body, matterId, feature, documentIds }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error('Network error calling the model proxy.');
  }

  const text = await res.text();
  if (!res.ok) {
    let parsedBody: unknown = null;
    try { parsedBody = JSON.parse(text); } catch { /* not JSON */ }
    const b = (parsedBody && typeof parsedBody === 'object' ? parsedBody : {}) as {
      error?: unknown; retry_after_seconds?: unknown;
    };
    // `retry-after` is the header the meter sets; the body repeats it. Either
    // will do, and neither is required.
    const headerRetry = Number(res.headers?.get?.('retry-after'));
    const bodyRetry = Number(b.retry_after_seconds);
    const retryAfterSeconds = Number.isFinite(bodyRetry) && bodyRetry > 0
      ? bodyRetry
      : (Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry : null);

    throw new LlmCallError(
      llmErrorText(res.status, parsedBody),
      res.status,
      typeof b.error === 'string' ? b.error : null,
      retryAfterSeconds,
    );
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

  const raw = adapter.parseStructuredResponse(responseJson);
  if (raw == null) throw new Error('Model did not return structured output.');
  return { raw, requestBytes: byteLength(body) };
}

/** UTF-8 length without Node's Buffer — this runs in a browser. */
export function byteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
  // Never taken in a browser or in Node 22; a conservative over-estimate.
  return text.length * 2;
}
