// Every AI connected to this account that can be handed a task (migration
// 089): agents, full-access tokens and full-assistant OAuth sign-ins. One
// cached read shared by the Agents page, every Delegate card and every
// matter's Tasks tab.

import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useServerspaces } from '@/hooks/useServerspaces';
import { useAgentTokens, AGENT_TOKENS_KEY } from '@/hooks/useAgentTokens';
import { readUserTokens } from '@/lib/agents-schema';
import { isAgentsNotReady } from '@/lib/agentTasks';
import {
  buildRecipients,
  recipientsForMatter,
  type GrantRow,
  type TaskRecipient,
  type UserTokenRow,
} from '@/lib/task-recipients';

export const ASSISTANT_CONNECTIONS_KEY = ['task_recipients', 'assistants'] as const;

/**
 * Full-access tokens and OAuth sign-ins. Each read stands alone: a failure
 * (065 not applied, say) leaves that kind out rather than taking the page down.
 */
async function readAssistantConnections(): Promise<{ userTokens: UserTokenRow[]; grants: GrantRow[] }> {
  const tokens = await readUserTokens<UserTokenRow>(
    (cols) => supabase.from('connector_tokens').select(cols).order('created_at', { ascending: false }),
    'id, name, created_at, last_used_at, expires_at, revoked_at',
  );
  // '*': agent_token_id (087) must not be named on a database without it.
  const { data: grants, error: gErr } = await supabase
    .from('oauth_grants')
    .select('*')
    .order('created_at', { ascending: false });
  return {
    userTokens: tokens.error ? [] : (tokens.data ?? []),
    grants: gErr ? [] : ((grants ?? []) as GrantRow[]),
  };
}

export interface Recipients {
  /** Every connection, revoked ones included (so an old task can name its recipient). */
  all: TaskRecipient[];
  byKey: Map<string, TaskRecipient>;
  loading: boolean;
  /** Migration 085 has not been applied: there is no task board yet. */
  notReady: boolean;
  error: string | null;
}

export function useTaskRecipients(): Recipients {
  const agentsQ = useAgentTokens();
  const assistantsQ = useQuery({
    queryKey: ASSISTANT_CONNECTIONS_KEY,
    queryFn: readAssistantConnections,
    staleTime: 30_000,
  });
  return useMemo(() => {
    const notReady = !!agentsQ.error && isAgentsNotReady(agentsQ.error);
    const all = buildRecipients({
      agents: agentsQ.data ?? [],
      userTokens: assistantsQ.data?.userTokens ?? [],
      grants: assistantsQ.data?.grants ?? [],
    });
    return {
      all,
      byKey: new Map(all.map((r) => [r.key, r] as const)),
      loading: agentsQ.isLoading || assistantsQ.isLoading,
      notReady,
      error: agentsQ.error && !notReady ? (agentsQ.error as Error).message : null,
    };
  }, [agentsQ.data, agentsQ.error, agentsQ.isLoading, assistantsQ.data, assistantsQ.isLoading]);
}

export function useTaskRecipientsInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: AGENT_TOKENS_KEY });
    void qc.invalidateQueries({ queryKey: ASSISTANT_CONNECTIONS_KEY });
  };
}

export interface MatterRecipients extends Recipients {
  /** Live agents whose scope covers this matter. */
  agents: TaskRecipient[];
  /** Live chat assistants (they see every matter their user sees, except SecureSpaces). */
  assistants: TaskRecipient[];
  /** The matter is sealed: no connected AI can see it. */
  sealed: boolean;
}

export function useRecipientsForMatter(matterId: string | null | undefined): MatterRecipients {
  const base = useTaskRecipients();
  const { data: serverspaces = [], isLoading: mattersLoading } = useServerspaces();
  return useMemo(() => {
    const matters = serverspaces.flatMap((s) => s.matterspaces ?? []);
    const forMatter = recipientsForMatter(matters, base.all, matterId);
    return { ...base, ...forMatter, loading: base.loading || mattersLoading };
  }, [base, serverspaces, mattersLoading, matterId]);
}
