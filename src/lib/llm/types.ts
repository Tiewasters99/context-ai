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

export interface ProviderAdapter {
  providerId: ProviderId;
  /** Build the fetch request body for this provider's API format */
  buildRequestBody(request: LLMRequest, model: ModelConfig): string;
  /** Parse an SSE data line into text content, or null if not a content event */
  parseStreamEvent(data: string): string | null;
  /** Check if this SSE event signals stream completion */
  isStreamDone(data: string): boolean;
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
