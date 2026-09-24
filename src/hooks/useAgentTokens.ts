// The signed-in user's live agent tokens, and which of them can see a given
// matter. One cached read shared by every Delegate card and Tasks tab.

import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerspaces } from '@/hooks/useServerspaces';
import { listAgentTokens, type AgentToken } from '@/lib/agentTokens';
import { isAgentsNotReady } from '@/lib/agentTasks';
import { isEffectivelySealed, scopeCoversMatter } from '@/lib/agent-scope';

export const AGENT_TOKENS_KEY = ['agent_tokens'] as const;

export function useAgentTokens() {
  return useQuery({
    queryKey: AGENT_TOKENS_KEY,
    queryFn: listAgentTokens,
    staleTime: 30_000,
    retry: (count, err) => !isAgentsNotReady(err) && count < 2,
  });
}

export function useAgentTokensInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: AGENT_TOKENS_KEY });
}

export interface MatterAgents {
  /** Every live agent (for labels in a task list). */
  all: AgentToken[];
  /** Agents whose scope covers this matter, seal considered. */
  eligible: AgentToken[];
  /** The matter is sealed: no agent can ever see it. */
  sealed: boolean;
  loading: boolean;
  /** Migration 085 has not been applied. */
  notReady: boolean;
  error: string | null;
}

export function useAgentsForMatter(matterId: string | null | undefined): MatterAgents {
  const q = useAgentTokens();
  const { data: serverspaces = [], isLoading: mattersLoading } = useServerspaces();
  return useMemo(() => {
    const matters = serverspaces.flatMap((s) => s.matterspaces ?? []);
    const all = q.data ?? [];
    const sealed = !!matterId && isEffectivelySealed(matters, matterId);
    const eligible = matterId ? all.filter((a) => scopeCoversMatter(matters, a.matter_scope, matterId)) : [];
    const notReady = !!q.error && isAgentsNotReady(q.error);
    return {
      all,
      eligible,
      sealed,
      loading: q.isLoading || mattersLoading,
      notReady,
      error: q.error && !notReady ? (q.error as Error).message : null,
    };
  }, [q.data, q.error, q.isLoading, serverspaces, mattersLoading, matterId]);
}
