import type { ProviderAdapter, LLMRequest, ModelConfig } from './types';

/** Anthropic Messages API */
const anthropicAdapter: ProviderAdapter = {
  providerId: 'anthropic',
  buildRequestBody(request: LLMRequest, model: ModelConfig): string {
    return JSON.stringify({
      model: model.apiModelId,
      max_tokens: request.maxTokens ?? 4096,
      stream: request.stream,
      system: request.system,
      messages: request.messages.filter((m) => m.role !== 'system').map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });
  },
  parseStreamEvent(data: string): string | null {
    try {
      const event = JSON.parse(data);
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        return event.delta.text;
      }
    } catch { /* skip */ }
    return null;
  },
  isStreamDone(data: string): boolean {
    try { return JSON.parse(data).type === 'message_stop'; } catch { return false; }
  },
};

/** OpenAI Chat Completions API (also used by xAI/Grok) */
const openaiAdapter: ProviderAdapter = {
  providerId: 'openai',
  buildRequestBody(request: LLMRequest, model: ModelConfig): string {
    const messages = request.messages.map((m) => ({ role: m.role, content: m.content }));
    if (request.system) {
      messages.unshift({ role: 'system', content: request.system });
    }
    return JSON.stringify({
      model: model.apiModelId,
      max_tokens: request.maxTokens ?? 4096,
      stream: request.stream,
      temperature: request.temperature ?? 0.7,
      messages,
    });
  },
  parseStreamEvent(data: string): string | null {
    if (data === '[DONE]') return null;
    try {
      const event = JSON.parse(data);
      return event.choices?.[0]?.delta?.content ?? null;
    } catch { return null; }
  },
  isStreamDone(data: string): boolean {
    return data === '[DONE]';
  },
};

/** Google Gemini API (generateContent with streaming) */
const googleAdapter: ProviderAdapter = {
  providerId: 'google',
  buildRequestBody(request: LLMRequest, model: ModelConfig): string {
    const parts: { text: string }[] = [];
    const systemParts: { text: string }[] = [];

    if (request.system) {
      systemParts.push({ text: request.system });
    }

    // Gemini uses contents array with parts
    const contents = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    return JSON.stringify({
      contents,
      systemInstruction: systemParts.length > 0 ? { parts: systemParts } : undefined,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.7,
      },
    });
  },
  parseStreamEvent(data: string): string | null {
    try {
      const event = JSON.parse(data);
      return event.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    } catch { return null; }
  },
  isStreamDone(data: string): boolean {
    try {
      const event = JSON.parse(data);
      return event.candidates?.[0]?.finishReason === 'STOP';
    } catch { return false; }
  },
};

/** xAI Grok — uses OpenAI-compatible API */
const xaiAdapter: ProviderAdapter = {
  ...openaiAdapter,
  providerId: 'xai',
};

export const adapters: Record<string, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  google: googleAdapter,
  xai: xaiAdapter,
};
