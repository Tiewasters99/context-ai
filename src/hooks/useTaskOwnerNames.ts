// Owner names for tasks on someone else's connection. A task's creator owns
// its recipient: 085/089 only let a user create a task for, or reassign it
// to, a connection of their own. Names come from profiles, the way the
// activity feed reads them.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import type { AgentTask } from '@/lib/agentTasks';
import type { TaskRecipient } from '@/lib/task-recipients';
import { taskKey } from '@/lib/task-ui';

export function useTaskOwnerNames(tasks: AgentTask[], ownKeys: Map<string, TaskRecipient>) {
  const otherOwners = useMemo(
    () => [...new Set(tasks.filter((t) => !ownKeys.has(taskKey(t) ?? '')).map((t) => t.created_by))].sort(),
    [tasks, ownKeys],
  );
  const { data: ownerNames } = useQuery({
    queryKey: ['agent_task_owner_names', ...otherOwners],
    enabled: otherOwners.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from('profiles').select('id, display_name, email').in('id', otherOwners);
      const names = new Map<string, string>();
      for (const p of (data ?? []) as { id: string; display_name: string | null; email: string | null }[]) {
        const n = (p.display_name ?? '').trim() || p.email || '';
        if (n) names.set(p.id, n);
      }
      return names;
    },
    staleTime: 300_000,
  });
  return (userId: string) => ownerNames?.get(userId) ?? 'another member of this matter';
}
