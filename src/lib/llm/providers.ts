import type { ProviderConfig } from './types';

export const providers: ProviderConfig[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    models: [
      { id: 'claude-opus', apiModelId: 'claude-opus-4-6-20250415', name: 'Claude Opus 4.6', description: 'Most capable — complex reasoning, long documents', contextWindow: 200000, tier: 'pro' },
      { id: 'claude-sonnet', apiModelId: 'claude-sonnet-4-6-20250514', name: 'Claude Sonnet 4.6', description: 'Fast and capable — great for most tasks', contextWindow: 200000, tier: 'free' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-4o', apiModelId: 'gpt-4o', name: 'GPT-4o', description: 'Fast multimodal model', contextWindow: 128000, tier: 'byok' },
      { id: 'gpt-4-turbo', apiModelId: 'gpt-4-turbo', name: 'GPT-4 Turbo', description: 'Strong reasoning with large context', contextWindow: 128000, tier: 'byok' },
      { id: 'o3', apiModelId: 'o3', name: 'o3', description: 'Advanced reasoning model', contextWindow: 200000, tier: 'byok' },
    ],
  },
  {
    id: 'google',
    name: 'Google',
    models: [
      { id: 'gemini-2.5-pro', apiModelId: 'gemini-2.5-pro-preview-06-05', name: 'Gemini 2.5 Pro', description: 'Massive context — 1M tokens, great for large documents', contextWindow: 1000000, tier: 'byok' },
      { id: 'gemini-2.5-flash', apiModelId: 'gemini-2.5-flash-preview-05-20', name: 'Gemini 2.5 Flash', description: 'Fast and efficient with large context', contextWindow: 1000000, tier: 'byok' },
    ],
  },
  {
    id: 'xai',
    name: 'xAI',
    models: [
      { id: 'grok-3', apiModelId: 'grok-3', name: 'Grok 3', description: 'xAI\'s flagship model', contextWindow: 131072, tier: 'byok' },
      { id: 'grok-3-mini', apiModelId: 'grok-3-mini', name: 'Grok 3 Mini', description: 'Fast and lightweight', contextWindow: 131072, tier: 'byok' },
    ],
  },
];

export function findModel(modelId: string) {
  for (const provider of providers) {
    const model = provider.models.find((m) => m.id === modelId);
    if (model) return { provider, model };
  }
  return null;
}

export function allModels() {
  return providers.flatMap((p) => p.models.map((m) => ({ ...m, provider: p })));
}
