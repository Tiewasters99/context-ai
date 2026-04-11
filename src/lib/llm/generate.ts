import type { LLMStreamCallbacks, ProviderId } from './types';
import { findModel } from './providers';
import { adapters } from './adapters';
import { routeRequest, selectRelevantChunks, estimateTokens } from './router';

export interface GenerateOptions {
  modelId: string;
  instruction: string;
  contextFiles: { name: string; content: string }[];
  callbacks: LLMStreamCallbacks;
  signal?: AbortSignal;
}

export interface GenerateResult {
  strategy: 'whole' | 'chunked';
  estimatedTokens: number;
  message?: string;
}

const SYSTEM_PROMPT = 'You are an AI assistant inside The Vault, a secure document workspace. The user may provide context documents and an instruction. Follow the instruction precisely, using the provided documents as reference. Produce professional, well-formatted output.';

export async function generate(options: GenerateOptions): Promise<GenerateResult | undefined> {
  const { modelId, instruction, contextFiles, callbacks, signal } = options;

  const found = findModel(modelId);
  if (!found) {
    callbacks.onError(`Unknown model: ${modelId}`);
    return;
  }
  const { provider, model } = found;
  const adapter = adapters[provider.id];

  // Build context text
  let contextText = '';
  if (contextFiles.length > 0) {
    contextText = contextFiles
      .map((f) => `--- ${f.name} ---\n${f.content}`)
      .join('\n\n');
  }

  // Route: whole document or chunked?
  const routing = routeRequest(contextText, instruction, model, provider.id);

  let finalContext = contextText;
  if (routing.strategy === 'chunked' && contextText) {
    // Reserve tokens for instruction + system prompt + response
    const reservedTokens = estimateTokens(instruction) + estimateTokens(SYSTEM_PROMPT) + 4096;
    const availableForContext = model.contextWindow - reservedTokens;
    finalContext = selectRelevantChunks(contextText, instruction, availableForContext);
  }

  // Build user message
  let userMessage = '';
  if (finalContext) {
    userMessage += 'Here are the context documents:\n\n' + finalContext + '\n\n---\n\n';
  }
  userMessage += instruction;

  const requestBody = adapter.buildRequestBody(
    {
      messages: [{ role: 'user', content: userMessage }],
      system: SYSTEM_PROMPT,
      maxTokens: 4096,
      stream: true,
    },
    model,
  );

  // Call the proxy
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
  } catch (err) {
    if (signal?.aborted) return;
    callbacks.onError('Network error — is the dev server running?');
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

  // Parse SSE stream
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

  return {
    strategy: routing.strategy,
    estimatedTokens: routing.estimatedTokens,
    message: routing.message,
  };
}
