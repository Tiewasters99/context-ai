import type { LLMStreamCallbacks } from './types';
import type { LlmRecordFields } from './features';
import { findModel } from './providers';
import { adapters } from './adapters';
import { routeRequest, selectRelevantChunks, estimateTokens } from './router';
import { llmAuthHeader } from './auth';
import { llmErrorText } from './refusals';

export interface GenerateOptions extends LlmRecordFields {
  modelId: string;
  instruction: string;
  contextFiles: { name: string; content: string }[];
  callbacks: LLMStreamCallbacks;
  signal?: AbortSignal;
  /**
   * Bind this call to a matter so /api/llm can enforce that matter's tier.
   * Pass it whenever `contextFiles` came out of a matter — which, for every
   * caller of this function today, is always. Omitted, the request reaches
   * the gate with nothing to check and is treated as unbound content: the
   * right answer for a dashboard draft, the wrong one for a client file.
   */
  matterId?: string;
}

export interface GenerateResult {
  strategy: 'whole' | 'chunked';
  estimatedTokens: number;
  message?: string;
}

const SYSTEM_PROMPT = 'You are an AI assistant inside The Vault, a secure document workspace. The user may provide context documents and an instruction. Follow the instruction precisely, using the provided documents as reference. Produce professional, well-formatted output.';

export async function generate(options: GenerateOptions): Promise<GenerateResult | undefined> {
  const { modelId, instruction, contextFiles, callbacks, signal, matterId, feature, documentIds } = options;

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
      headers: { 'Content-Type': 'application/json', ...(await llmAuthHeader()) },
      // `feature` and `documentIds` ride in the ENVELOPE, beside provider and
      // matterId — never inside `body`, which is forwarded to the provider
      // verbatim. What leaves the server is unchanged by recording.
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
    callbacks.onError('Network error — is the dev server running?');
    return;
  }

  if (!res.ok) {
    let errBody: unknown = null;
    try { errBody = await res.json(); } catch { /* no body, or not JSON */ }
    // `retry-after` is the other half of a 429: the server puts the seconds
    // in a header as well as the body, and the sentence needs the number.
    callbacks.onError(llmErrorText(res.status, errBody, res.headers.get('retry-after')));
    return;
  }

  // Which pen actually answered. On a sealed matter the server substitutes
  // the sealed pen for the model this call named (lib/llm-sealed-route.mjs),
  // and the caller is entitled to know that rather than be told its own
  // request was honoured.
  const penLabel = res.headers.get('x-contextspaces-pen');

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
    message: penLabel
      ? `${routing.message ?? ''} Answered by the sealed pen: ${penLabel}.`.trim()
      : routing.message,
  };
}
