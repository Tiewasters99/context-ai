import type { ProviderConfig } from './types';

export const providers: ProviderConfig[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    models: [
      // Fable 5 has no sampling params and always-on thinking; our adapter
      // already sends neither, so it works through the same code path.
      { id: 'claude-fable-5', apiModelId: 'claude-fable-5', name: 'Claude Fable 5', description: 'Anthropic\'s most capable model — deepest reasoning and long-horizon work', contextWindow: 1000000, tier: 'pro' },
      { id: 'claude-opus-4-8', apiModelId: 'claude-opus-4-8', name: 'Claude Opus 4.8', description: 'Most capable Opus — complex reasoning, long documents, structured analysis', contextWindow: 200000, tier: 'pro' },
      { id: 'claude-opus-4-7', apiModelId: 'claude-opus-4-7', name: 'Claude Opus 4.7', description: 'Complex reasoning, long documents, structured analysis', contextWindow: 200000, tier: 'pro' },
      { id: 'claude-opus', apiModelId: 'claude-opus-4-6-20250415', name: 'Claude Opus 4.6', description: 'Most capable — complex reasoning, long documents', contextWindow: 200000, tier: 'pro' },
      { id: 'claude-sonnet', apiModelId: 'claude-sonnet-4-6-20250514', name: 'Claude Sonnet 4.6', description: 'Fast and capable — great for most tasks', contextWindow: 200000, tier: 'free' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-5.6-sol', apiModelId: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', description: 'OpenAI\'s deepest reasoning tier', contextWindow: 400000, tier: 'byok' },
      { id: 'gpt-5.6-terra', apiModelId: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', description: 'Balanced capability, speed, and cost', contextWindow: 400000, tier: 'byok' },
      { id: 'gpt-5.6-luna', apiModelId: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', description: 'Fastest and lowest-cost of the GPT-5.6 family', contextWindow: 400000, tier: 'byok' },
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
    id: 'moonshot',
    name: 'Moonshot AI',
    models: [
      // ⚠ Confidentiality: these route to api.moonshot.ai (Singapore entity;
      // API data may be used for training, no zero-retention tier). Fine for
      // public/non-client material. Before any client-matter text flows here,
      // switch to a US zero-data-retention host of the same open weights
      // (Fireworks/Together/Baseten/DeepInfra) — same OpenAI-compatible shape.
      { id: 'kimi-k3', apiModelId: 'kimi-k3', name: 'Kimi K3', description: 'Moonshot\'s flagship open-weight writer — 1M context', contextWindow: 1000000, tier: 'pro', pricePerM: { input: 3, output: 15 } },
      { id: 'kimi-k2.6', apiModelId: 'kimi-k2.6', name: 'Kimi K2.6', description: 'Value tier — strong writing at a fraction of the cost', contextWindow: 256000, tier: 'pro', pricePerM: { input: 0.95, output: 4 } },
    ],
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    models: [
      // The confidentiality tier for open weights: US-hosted, zero data
      // retention by default. Same Kimi K3 weights as Moonshot's own API —
      // this is the route client-matter text takes.
      { id: 'kimi-k3-us', apiModelId: 'accounts/fireworks/models/kimi-k3', name: 'Kimi K3 (US-hosted)', description: 'The same open weights on Fireworks — US-hosted, zero data retention', contextWindow: 1000000, tier: 'pro', pricePerM: { input: 3, output: 15 } },
      { id: 'kimi-k2.6-us', apiModelId: 'accounts/fireworks/models/kimi-k2p6', name: 'Kimi K2.6 (US-hosted)', description: 'The value pen — same US zero-retention host, output ~4× cheaper than K3', contextWindow: 256000, tier: 'pro', pricePerM: { input: 0.95, output: 4 } },
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
