// Mediator model registry + provider-agnostic completion call.
//
// House rule (model-agnostic architecture): no provider's API shape leaks
// into feature code. Mediation handlers call `runMediator()` with plain
// system/messages; everything provider-specific (SDK vs REST, message
// shapes, env keys) lives here. Ported from grapheon-ai lib/mediation/models.ts.

import Anthropic from '@anthropic-ai/sdk';

export const MEDIATOR_MODELS = [
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    provider: 'anthropic',
    apiModel: 'claude-opus-4-8',
    blurb: 'The standard Contextspaces mediator — measured, thorough, and precise on the law.',
  },
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    provider: 'anthropic',
    apiModel: 'claude-fable-5',
    blurb: 'Anthropic’s frontier model — for complex, high-stakes disputes.',
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    provider: 'openai',
    apiModel: 'gpt-5.5',
    blurb: 'OpenAI’s flagship mediator option.',
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    provider: 'openai',
    apiModel: 'gpt-5.6-sol',
    blurb: 'OpenAI’s newest model, as it becomes available.',
  },
];

export function getMediatorModel(id) {
  return MEDIATOR_MODELS.find((m) => m.id === id);
}

/** A model is offerable only when its provider's key is configured. */
export function isModelAvailable(model) {
  if (model.provider === 'anthropic') return !!process.env.ANTHROPIC_API_KEY;
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Run one mediator completion. Throws with a user-safe message on failure.
 *
 * `cacheableSystem` is the large STATIC prefix (both parties' full
 * confidential record + framework), identical across every turn of a
 * conversation. Marked for prompt caching so we pay full price once per
 * ~5-min window and ~10% on every follow-up turn. Volatile bits (caucus
 * clock, current offers) belong in `system`, which comes AFTER the cache
 * breakpoint. Omit for one-shot calls.
 */
export async function runMediator({ modelId, system, messages, maxTokens = 4096, cacheableSystem }) {
  const model = getMediatorModel(modelId);
  if (!model) throw new Error(`Unknown mediator model: ${modelId}`);
  if (!isModelAvailable(model)) {
    throw new Error(`${model.label} is not yet enabled on this Contextspaces deployment.`);
  }

  if (model.provider === 'anthropic') {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    // Cacheable prefix first (with the breakpoint), volatile remainder after.
    const systemBlocks = cacheableSystem
      ? [
          { type: 'text', text: cacheableSystem, cache_control: { type: 'ephemeral' } },
          ...(system ? [{ type: 'text', text: system }] : []),
        ]
      : [{ type: 'text', text: system }];
    const res = await client.messages.create({
      model: model.apiModel,
      max_tokens: maxTokens,
      system: systemBlocks,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    return res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }

  // OpenAI-compatible REST (no SDK dependency; shape confined to this file).
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: model.apiModel,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: cacheableSystem ? `${cacheableSystem}\n\n${system}`.trim() : system },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Mediator model error (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Mediator returned an empty reply.');
  return text.trim();
}
