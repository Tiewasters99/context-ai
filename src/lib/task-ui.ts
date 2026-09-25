// Small shared pieces of the task surfaces (the Agents page, a matter's Tasks
// tab, the Delegate card): query keys, dates, and a task's recipient key.
// Kept out of the component files so React fast refresh stays whole.

import type { AgentTask } from './agentTasks';
import { recipientKey, taskRecipientRef } from './task-recipients';

export const MATTER_TASKS_KEY = (matterId: string) => ['agent_tasks', 'matter', matterId] as const;
export const ALL_TASKS_KEY = ['agent_tasks', 'all'] as const;

export function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function day(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The key a task's recipient columns give ('token:<id>' / 'grant:<id>'). */
export function taskKey(t: Pick<AgentTask, 'assigned_token_id' | 'assigned_grant_id'>): string | null {
  const ref = taskRecipientRef(t);
  return ref ? recipientKey(ref) : null;
}
