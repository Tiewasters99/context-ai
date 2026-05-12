/** Common interface for all LLM providers */

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  stream: boolean;
}

export interface LLMStreamCallbacks {
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

export interface ProviderConfig {
  id: ProviderId;
  name: string;
  models: ModelConfig[];
}

export interface ModelConfig {
  id: string;
  apiModelId: string;
  name: string;
  description: string;
  contextWindow: number; // tokens
  tier: 'free' | 'pro' | 'byok';
}

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'xai';

/**
 * A request for structured output: the model must return data matching the
 * given JSON schema rather than free text. Each provider expresses this with
 * its own primitive (Anthropic tool use, OpenAI function calling, Gemini
 * function calling) — the adapter translates. Feature code that needs
 * structured output uses this; it never names a provider.
 */
export interface StructuredRequest {
  system?: string;
  /** The single user message — usually the document text to analyze. */
  userContent: string;
  /** Name of the "tool"/"function" the model fills in. */
  toolName: string;
  toolDescription: string;
  /** JSON Schema for the tool input — the shape of the data you want back. */
  inputSchema: Record<string, unknown>;
  maxTokens?: number;
}

export interface ProviderAdapter {
  providerId: ProviderId;
  /** Build the fetch request body for this provider's API format */
  buildRequestBody(request: LLMRequest, model: ModelConfig): string;
  /** Parse an SSE data line into text content, or null if not a content event */
  parseStreamEvent(data: string): string | null;
  /** Check if this SSE event signals stream completion */
  isStreamDone(data: string): boolean;
  /**
   * Build a non-streaming request body that forces structured output.
   * Throws if the provider doesn't support it yet.
   */
  buildStructuredRequestBody(request: StructuredRequest, model: ModelConfig): string;
  /**
   * Pull the structured tool/function input object out of the provider's
   * non-streaming JSON response. Returns null if the model didn't emit one.
   */
  parseStructuredResponse(responseJson: unknown): unknown | null;
}

/** Routing decision for a given document + model combination */
export interface RoutingDecision {
  strategy: 'whole' | 'chunked';
  model: ModelConfig;
  provider: ProviderId;
  estimatedTokens: number;
  contextWindow: number;
  message?: string; // recommendation text for the user
}
