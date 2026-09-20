// What the browser may say about a matter's AI, read under the user's own RLS.
//
// Three facts, one hook: the matter's NAME, its EFFECTIVE TIER (the strongest
// tier on its ancestor chain — the seal is inherited), and whether AI is
// PAUSED here or above. Nothing privileged: the same three reads the sidebar,
// the Agents surface and the pause control already make. No service-role path,
// no new endpoint.
//
// Every one of them may come back unknown, and unknown is never an error:
//   * migration 051 absent → `effectiveTier` returns null → the panel says the
//     matter's name and claims nothing about the seal;
//   * migration 070 absent → `readAiPause` reports notDeployed → not paused,
//     exactly as the product behaves today.
//
// The answer is KEYED to the matter it was read for and derived on the way
// out, so walking from a sealed matter to an open one reports "still reading"
// rather than the previous matter's tier for a frame — and so the effect never
// calls setState synchronously.
//
// The tier walk is a query per ancestor, so this runs only when a surface is
// actually about to say something — the panel when it is open, the matter
// header when it renders.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { effectiveTier, type AiTier } from '@/lib/agent-charters';
import { readAiPause, aiPausedSentence } from '@/lib/ai-pause';

export interface MatterAiState {
  /** No answer yet — say nothing rather than guess. */
  loading: boolean;
  name?: string;
  /** null = unknown. Never coerced to 'A'. */
  tier: AiTier | null;
  paused: boolean;
  /** The pause sentence, identical to the server's (src/lib/ai-pause.ts). */
  pausedSentence: string;
}

const IDLE: MatterAiState = { loading: false, tier: null, paused: false, pausedSentence: '' };

export function useMatterAiState(
  matterId: string | undefined,
  opts?: { enabled?: boolean; name?: string },
): MatterAiState {
  const enabled = opts?.enabled !== false;
  const givenName = opts?.name;
  const active = Boolean(matterId) && enabled;
  const [answer, setAnswer] = useState<{ key: string; value: MatterAiState } | null>(null);

  useEffect(() => {
    if (!matterId || !enabled) return;
    let live = true;
    void (async () => {
      const [nameRes, tier, pause] = await Promise.all([
        givenName
          ? Promise.resolve(null)
          : supabase.from('matterspaces').select('name').eq('id', matterId).maybeSingle(),
        effectiveTier(matterId).catch(() => null),
        readAiPause(matterId).catch(() => null),
      ]);
      if (!live) return;
      setAnswer({
        key: matterId,
        value: {
          loading: false,
          name: givenName || ((nameRes?.data as { name?: string } | null)?.name ?? undefined),
          tier,
          paused: Boolean(pause?.paused),
          pausedSentence: pause?.paused ? aiPausedSentence(pause) : '',
        },
      });
    })();
    return () => {
      live = false;
    };
  }, [matterId, enabled, givenName]);

  if (!active) return IDLE;
  if (answer && answer.key === matterId) return answer.value;
  return { ...IDLE, loading: true, name: givenName };
}
