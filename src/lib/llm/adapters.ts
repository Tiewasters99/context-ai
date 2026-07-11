import type { ProviderAdapter, LLMRequest, ModelConfig, StructuredRequest } from './types';

function structuredNotSupported(provider: string): never {
  throw new Error(`Structured output is not yet implemented for ${provider}. Use an Anthropic or OpenAI model for this feature.`);
}

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
  buildStructuredRequestBody(request: StructuredRequest, model: ModelConfig): string {
    return JSON.stringify({
      model: model.apiModelId,
      max_tokens: request.maxTokens ?? 8192,
      stream: false,
      system: request.system,
      tools: [{
        name: request.toolName,
        description: request.toolDescription,
        input_schema: request.inputSchema,
      }],
      tool_choice: { type: 'tool', name: request.toolName },
      messages: [{ role: 'user', content: request.userContent }],
    });
  },
  parseStructuredResponse(responseJson: unknown): unknown | null {
    const content = (responseJson as { content?: Array<{ type: string; input?: unknown }> })?.content;
    if (!Array.isArray(content)) return null;
    const toolUse = content.find((c) => c.type === 'tool_use');
    return toolUse?.input ?? null;
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
    // GPT-5.x (and o-series) chat completions reject `max_tokens` and any
    // non-default temperature — they take `max_completion_tokens` and no
    // sampling params. Older chat models keep the legacy fields. This check
    // stays in the adapter so feature code never cares.
    const modern = /^(gpt-5|o\d)/.test(model.apiModelId);
    return JSON.stringify({
      model: model.apiModelId,
      ...(modern
        ? { max_completion_tokens: request.maxTokens ?? 4096 }
        : { max_tokens: request.maxTokens ?? 4096, temperature: request.temperature ?? 0.7 }),
      stream: request.stream,
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
  buildStructuredRequestBody(request: StructuredRequest, model: ModelConfig): string {
    const messages: Array<{ role: string; content: string }> = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    messages.push({ role: 'user', content: request.userContent });
    const modern = /^(gpt-5|o\d)/.test(model.apiModelId);
    return JSON.stringify({
      model: model.apiModelId,
      ...(modern
        ? { max_completion_tokens: request.maxTokens ?? 8192 }
        : { max_tokens: request.maxTokens ?? 8192, temperature: 0 }),
      stream: false,
      messages,
      tools: [{
        type: 'function',
        function: {
          name: request.toolName,
          description: request.toolDescription,
          parameters: request.inputSchema,
        },
      }],
      tool_choice: { type: 'function', function: { name: request.toolName } },
    });
  },
  parseStructuredResponse(responseJson: unknown): unknown | null {
    const call = (responseJson as {
      choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
    })?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (typeof call !== 'string') return null;
    try { return JSON.parse(call); } catch { return null; }
  },
};

/** Google Gemini API (generateContent with streaming) */
const googleAdapter: ProviderAdapter = {
  providerId: 'google',
  buildRequestBody(request: LLMRequest, _model: ModelConfig): string {
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
  // Gemini supports function calling; wiring it through the streaming proxy
  // and response shape is left for when a Gemini-backed feature needs it.
  buildStructuredRequestBody(): string { return structuredNotSupported('Google Gemini'); },
  parseStructuredResponse(): unknown | null { return structuredNotSupported('Google Gemini'); },
};

/** xAI Grok — uses OpenAI-compatible API (including function calling) */
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
