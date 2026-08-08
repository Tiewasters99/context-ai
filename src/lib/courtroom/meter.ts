// The Courtroom — per-session usage metering (spec §12.2: pricing needs data).
//
// The llm layer's streaming/structured paths do not surface provider token
// counts, so Phase 1 meters with the layer's exported estimateTokens
// (~4 chars/token) and LABELS EVERY NUMBER AS AN ESTIMATE — in the stored
// blob, in the UI, and in the report. When the proxy starts returning real
// usage, swap recordCall's estimator for the reported counts and drop the
// label; the shape stays.
//
// Import note: estimateTokens comes from its defining module (llm/router) by
// relative path rather than the '@/lib/llm' barrel so this file stays
// loadable by the Node eval harness (the barrel drags in the streaming
// modules; router.ts is pure).

import { estimateTokens } from '../llm/router.ts';
import type { StageUsage, UsageRecord } from './types.ts';

/** USD per million tokens (input, output) at list rates — estimates only. */
const LIST_RATES: Record<string, { input: number; output: number }> = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 5, output: 25 },
};

export function newUsage(modelId: string): UsageRecord {
  return {
    model_id: modelId,
    estimated: true,
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    by_stage: {},
    cost_estimate_usd: LIST_RATES[modelId] ? 0 : null,
    note:
      'Token counts are estimates (~4 chars/token via estimateTokens); cost is at list rates ' +
      'with no prompt-cache discount, so the real bill should come in lower.',
  };
}

/**
 * Record one model call. `modelId` is the model that actually served the call
 * (fallback retries bill at the fallback model's rate).
 */
export function recordCall(
  usage: UsageRecord,
  stage: string,
  modelId: string,
  promptText: string,
  completionText: string,
): UsageRecord {
  const input = estimateTokens(promptText);
  const output = estimateTokens(completionText);
  usage.calls += 1;
  usage.input_tokens += input;
  usage.output_tokens += output;
  const s: StageUsage = usage.by_stage[stage] ?? { calls: 0, input_tokens: 0, output_tokens: 0 };
  s.calls += 1;
  s.input_tokens += input;
  s.output_tokens += output;
  usage.by_stage[stage] = s;

  const rate = LIST_RATES[modelId];
  if (rate && usage.cost_estimate_usd !== null) {
    usage.cost_estimate_usd = round2(
      usage.cost_estimate_usd + (input * rate.input + output * rate.output) / 1_000_000,
    );
  }
  return usage;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** "≈ $12.40 (estimated)" — or a token line when the model has no list rate. */
export function formatUsage(usage: UsageRecord | null | undefined): string {
  if (!usage || !usage.calls) return 'no usage metered yet';
  const tokens = `${usage.input_tokens.toLocaleString()} in / ${usage.output_tokens.toLocaleString()} out tokens (estimated)`;
  return usage.cost_estimate_usd !== null
    ? `≈ $${usage.cost_estimate_usd.toFixed(2)} · ${tokens}`
    : tokens;
}
