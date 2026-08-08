// The Courtroom — live engine ports: every model call routes through the
// provider-agnostic llm layer (src/lib/llm). NO provider API shapes here —
// hard architecture rule of this codebase.
//
// Fable is the panel (spec §7); a failed or refused juror turn retries once
// on Opus 4.8, because a juror turn must never silently vanish (trial facts
// can brush safety classifiers). Every call — including the fallback — is
// metered onto the trial's UsageRecord at the serving model's list rate.

import { converse, generateStructured } from '@/lib/llm';
import { recordCall } from './meter.ts';
import type { EnginePorts, SpeechCall, StructuredCall, UsageRecord } from './types.ts';

export const DEFAULT_JUROR_MODEL = 'claude-fable-5';
export const ECONOMY_JUROR_MODEL = 'claude-opus-4-8';
export const FALLBACK_MODEL = 'claude-opus-4-8';

export interface LivePortsOptions {
  modelId: string;
  usage: UsageRecord;
  signal?: AbortSignal;
  onProgress?: EnginePorts['onProgress'];
  saveReaction?: EnginePorts['saveReaction'];
  saveBallot?: EnginePorts['saveBallot'];
  saveTurn?: EnginePorts['saveTurn'];
  /** Called after each metered call so the UI can persist usage as it grows. */
  onUsage?: (usage: UsageRecord) => void;
}

/** converse() speaks through callbacks; fold it into a promise of the text. */
function converseOnce(
  modelId: string,
  system: string,
  content: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    void converse({
      modelId,
      system,
      messages: [{ role: 'user', content }],
      maxTokens,
      signal,
      callbacks: {
        onChunk: (t) => { text += t; },
        onDone: () => resolve(text),
        onError: (e) => reject(new Error(e)),
      },
    });
  });
}

export function makeLivePorts(opts: LivePortsOptions): EnginePorts {
  const { modelId, usage, signal } = opts;

  const meter = (stage: string, servedBy: string, prompt: string, completion: string) => {
    recordCall(usage, stage, servedBy, prompt, completion);
    opts.onUsage?.(usage);
  };

  const structured = async <T>(call: StructuredCall): Promise<T> => {
    const attempt = async (m: string): Promise<T> => {
      const result = await generateStructured<T>({
        modelId: m,
        system: call.system,
        userContent: call.prompt,
        toolName: call.toolName,
        toolDescription: call.toolDescription,
        inputSchema: call.schema,
        maxTokens: call.maxTokens ?? 2048,
        signal,
      });
      meter(call.stage, m, call.system + call.prompt, JSON.stringify(result));
      return result;
    };
    try {
      return await attempt(modelId);
    } catch (err) {
      if (signal?.aborted || modelId === FALLBACK_MODEL) throw err;
      // Refusal/failure fallback: one retry on Opus 4.8 (spec §7).
      return attempt(FALLBACK_MODEL);
    }
  };

  const speech = async (call: SpeechCall): Promise<string> => {
    const attempt = async (m: string): Promise<string> => {
      const text = await converseOnce(m, call.system, call.prompt, call.maxTokens ?? 700, signal);
      if (!text.trim()) throw new Error('empty speech turn');
      meter(call.stage, m, call.system + call.prompt, text);
      return text;
    };
    try {
      return await attempt(modelId);
    } catch (err) {
      if (signal?.aborted || modelId === FALLBACK_MODEL) throw err;
      return attempt(FALLBACK_MODEL);
    }
  };

  return {
    structured,
    speech,
    onProgress: opts.onProgress,
    saveReaction: opts.saveReaction,
    saveBallot: opts.saveBallot,
    saveTurn: opts.saveTurn,
  };
}
