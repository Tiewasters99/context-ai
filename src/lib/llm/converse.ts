import type { LLMMessage, LLMStreamCallbacks } from './types';
import type { LlmRecordFields } from './features';
import { findModel } from './providers';
import { adapters } from './adapters';
import { llmAuthHeader } from './auth';
import { llmErrorText } from './refusals';

// Multi-turn streaming conversation through the provider-agnostic adapter
// layer. generate() is single-shot (one instruction + context); this is the
// counterpart for back-and-forth features (Moot Bench prep, future chat
// surfaces). Feature code passes role/content messages and never names a
// provider — the adapter builds the wire format and parses the stream.

export interface ConverseOptions extends LlmRecordFields {
  modelId: string;
  system: string;
  messages: LLMMessage[];
  maxTokens?: number;
  callbacks: LLMStreamCallbacks;
  signal?: AbortSignal;
  /** Bind this call to a matter; /api/llm enforces that matter's tier. See generate(). */
  matterId?: string;
}

export async function converse(options: ConverseOptions): Promise<void> {
  const { modelId, system, messages, maxTokens = 4096, callbacks, signal, matterId, feature, documentIds } = options;

  const found = findModel(modelId);
  if (!found) {
    callbacks.onError(`Unknown model: ${modelId}`);
    return;
  }
  const { provider, model } = found;
  const adapter = adapters[provider.id];

  const requestBody = adapter.buildRequestBody(
    { messages, system, maxTokens, stream: true },
    model,
  );

  let res: Response;
  try {
    res = await fetch('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await llmAuthHeader()) },
      // Envelope fields only — `body` is what reaches the provider, verbatim.
      body: JSON.stringify({
        provider: provider.id,
        model: model.apiModelId,
        body: requestBody,
        matterId,
        feature,
        documentIds,
      }),
      signal,
    });
  } catch {
    if (signal?.aborted) return;
    callbacks.onError('Network error — the model could not be reached.');
    return;
  }

  if (!res.ok) {
    let errBody: unknown = null;
    try { errBody = await res.json(); } catch { /* no body, or not JSON */ }
    callbacks.onError(llmErrorText(res.status, errBody, res.headers.get('retry-after')));
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) { callbacks.onError('No response body'); return; }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data) continue;
      if (adapter.isStreamDone(data)) continue;
      const text = adapter.parseStreamEvent(data);
      if (text) callbacks.onChunk(text);
    }
  }

  callbacks.onDone();
}
