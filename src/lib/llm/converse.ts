import type { LLMMessage, LLMStreamCallbacks } from './types';
import { findModel } from './providers';
import { adapters } from './adapters';

// Multi-turn streaming conversation through the provider-agnostic adapter
// layer. generate() is single-shot (one instruction + context); this is the
// counterpart for back-and-forth features (Moot Bench prep, future chat
// surfaces). Feature code passes role/content messages and never names a
// provider — the adapter builds the wire format and parses the stream.

export interface ConverseOptions {
  modelId: string;
  system: string;
  messages: LLMMessage[];
  maxTokens?: number;
  callbacks: LLMStreamCallbacks;
  signal?: AbortSignal;
}

export async function converse(options: ConverseOptions): Promise<void> {
  const { modelId, system, messages, maxTokens = 4096, callbacks, signal } = options;

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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: provider.id,
        model: model.apiModelId,
        body: requestBody,
      }),
      signal,
    });
  } catch {
    if (signal?.aborted) return;
    callbacks.onError('Network error — the model could not be reached.');
    return;
  }

  if (!res.ok) {
    let detail = `API error (${res.status})`;
    try {
      const errBody = await res.json();
      if (errBody.error?.message) detail = errBody.error.message;
      else if (typeof errBody.error === 'string') detail = errBody.error;
    } catch { /* use default */ }
    callbacks.onError(detail);
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
