// The agents task board, human side (spec B5).
//
// A task is work Eden hands to an outside agent (a Grok Bot, a ChatGPT GPT,
// any MCP client holding an agent token). The agent polls for it over MCP;
// nothing here calls the agent. These helpers are the browser's half: create,
// list, answer, cancel, reassign, and read the log. RLS on agent_tasks and
// agent_task_events (migration 085) decides what a user may touch, so every
// call goes straight through supabase-js as the signed-in user.
//
// Two house rules shape every write:
//   * Every human write also appends an agent_task_events row. That log is
//     the matter's record of what was asked of an agent and what it did.
//   * No `.select()` after an insert or update. INSERT … RETURNING re-runs the
//     SELECT policy and is the shape that has bitten this project's RLS
//     before, so a new task's id is minted here and inserted explicitly.
//
// Until migration 085 is applied the tables do not exist. Every helper turns
// that one failure into AgentsNotReadyError, whose message is the sentence
// the interface shows. Nothing else is swallowed.

import { supabase } from '@/lib/supabase';

import { AGENTS_MIGRATION_MESSAGE, isMissingSchema } from '@/lib/agents-schema';

export { AGENTS_MIGRATION_MESSAGE, isMissingSchema };

export class AgentsNotReadyError extends Error {
  constructor() {
    super(AGENTS_MIGRATION_MESSAGE);
    this.name = 'AgentsNotReadyError';
  }
}

/** Throw the right error for a PostgREST failure. */
export function raise(err: { code?: string; message?: string }, fallback: string): never {
  if (isMissingSchema(err)) throw new AgentsNotReadyError();
  throw new Error(err.message || fallback);
}

export function isAgentsNotReady(e: unknown): boolean {
  return e instanceof AgentsNotReadyError
    || (e instanceof Error && e.message === AGENTS_MIGRATION_MESSAGE);
}

// ── types (migration 085, exactly) ───────────────────────────────────

export type AgentTaskStatus = 'open' | 'claimed' | 'needs_input' | 'done' | 'failed' | 'cancelled';

export const TASK_STATUS_LABEL: Record<AgentTaskStatus, string> = {
  open: 'Open',
  claimed: 'Claimed',
  needs_input: 'Needs your answer',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Still in the agent's hands (or waiting on the human). */
export const LIVE_STATUSES: AgentTaskStatus[] = ['open', 'claimed', 'needs_input'];

export type AttachmentKind = 'document' | 'content_item' | 'calendar_event';

export interface TaskRef {
  kind: AttachmentKind;
  id: string;
  label?: string;
}

export interface AgentTask {
  id: string;
  matterspace_id: string;
  created_by: string;
  assigned_token_id: string;
  title: string;
  instructions: string;
  attachments: TaskRef[];
  due_at: string | null;
  status: AgentTaskStatus;
  question: string | null;
  answer: string | null;
  result: string | null;
  result_refs: TaskRef[];
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type TaskEventKind =
  | 'created' | 'claimed' | 'asked' | 'answered' | 'result'
  | 'failed' | 'cancelled' | 'reassigned' | 'note';

export interface AgentTaskEvent {
  id: string;
  task_id: string;
  at: string;
  actor_kind: 'human' | 'agent';
  actor_user: string | null;
  actor_token_id: string | null;
  kind: TaskEventKind;
  body: string | null;
}

const TASK_COLUMNS =
  'id, matterspace_id, created_by, assigned_token_id, title, instructions, attachments, due_at, '
  + 'status, question, answer, result, result_refs, claimed_at, completed_at, created_at, updated_at';

const EVENT_COLUMNS = 'id, task_id, at, actor_kind, actor_user, actor_token_id, kind, body';

async function currentUserId(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) throw new Error('You must be signed in.');
  return uid;
}

function normalizeTask(row: Record<string, unknown>): AgentTask {
  const t = row as unknown as AgentTask;
  return {
    ...t,
    attachments: Array.isArray(t.attachments) ? t.attachments : [],
    result_refs: Array.isArray(t.result_refs) ? t.result_refs : [],
  };
}

async function logHumanEvent(
  taskId: string,
  userId: string,
  kind: TaskEventKind,
  body: string | null,
): Promise<void> {
  const { error } = await supabase.from('agent_task_events').insert({
    task_id: taskId,
    actor_kind: 'human',
    actor_user: userId,
    actor_token_id: null,
    kind,
    body,
  });
  if (error) {
    if (isMissingSchema(error)) throw new AgentsNotReadyError();
    throw new Error(`The change was saved, but its entry in the task log was not: ${error.message}`);
  }
}

// ── reads ────────────────────────────────────────────────────────────

export type TaskFilter = { matterId: string } | { tokenId: string };

/** Newest first. `statuses` narrows; omitted means every status. */
export async function listTasks(
  filter: TaskFilter,
  opts: { statuses?: AgentTaskStatus[]; limit?: number } = {},
): Promise<AgentTask[]> {
  let q = supabase.from('agent_tasks').select(TASK_COLUMNS);
  q = 'matterId' in filter
    ? q.eq('matterspace_id', filter.matterId)
    : q.eq('assigned_token_id', filter.tokenId);
  if (opts.statuses?.length) q = q.in('status', opts.statuses);
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 200);
  if (error) raise(error, 'Could not read the tasks.');
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(normalizeTask);
}

/** Open, claimed and waiting tasks per agent token, for the Connections list. */
export async function countLiveTasksByToken(tokenIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (tokenIds.length === 0) return out;
  const { data, error } = await supabase
    .from('agent_tasks')
    .select('assigned_token_id')
    .in('assigned_token_id', tokenIds)
    .in('status', LIVE_STATUSES)
    .limit(5000);
  if (error) raise(error, 'Could not count the tasks.');
  for (const r of (data ?? []) as { assigned_token_id: string }[]) {
    out.set(r.assigned_token_id, (out.get(r.assigned_token_id) ?? 0) + 1);
  }
  return out;
}

/** The task's log, oldest first. */
export async function listEvents(taskId: string): Promise<AgentTaskEvent[]> {
  const { data, error } = await supabase
    .from('agent_task_events')
    .select(EVENT_COLUMNS)
    .eq('task_id', taskId)
    .order('at', { ascending: true })
    .limit(500);
  if (error) raise(error, 'Could not read the task log.');
  return (data ?? []) as AgentTaskEvent[];
}

// ── writes (each one logged) ─────────────────────────────────────────

// An update that matched no row: the agent moved the task on (answered,
// finished, or it was already cancelled) between the read and the click.
// Nothing changed, so nothing is logged.
const STALE_MESSAGE =
  'This task changed since the page was loaded, so nothing was saved. Reopen it to see where it stands.';

export interface NewTask {
  matterId: string;
  tokenId: string;
  title: string;
  instructions?: string;
  attachments?: TaskRef[];
  /** ISO timestamp, or null for no due date. */
  dueAt?: string | null;
}

/** Creates the task and its 'created' log entry. Returns the new id. */
export async function createTask(input: NewTask): Promise<string> {
  const title = input.title.trim();
  if (!title) throw new Error('A task needs a title.');
  const userId = await currentUserId();
  const id = crypto.randomUUID();
  const { error } = await supabase.from('agent_tasks').insert({
    id,
    matterspace_id: input.matterId,
    created_by: userId,
    assigned_token_id: input.tokenId,
    title,
    instructions: (input.instructions ?? '').trim(),
    attachments: input.attachments ?? [],
    due_at: input.dueAt ?? null,
  });
  if (error) raise(error, 'Could not create the task.');
  await logHumanEvent(id, userId, 'created', title);
  return id;
}

/** Answers the agent's question; the task goes back to the agent (claimed). */
export async function answerQuestion(taskId: string, answer: string): Promise<void> {
  const text = answer.trim();
  if (!text) throw new Error('Write an answer first.');
  const userId = await currentUserId();
  const { error, count } = await supabase
    .from('agent_tasks')
    .update({ answer: text, status: 'claimed', updated_at: new Date().toISOString() }, { count: 'exact' })
    .eq('id', taskId)
    .eq('status', 'needs_input');
  if (error) raise(error, 'Could not save the answer.');
  if (count === 0) throw new Error(STALE_MESSAGE);
  await logHumanEvent(taskId, userId, 'answered', text);
}

/** Cancels a task that is not finished. There is no delete: the log stays. */
export async function cancelTask(taskId: string, reason?: string): Promise<void> {
  const userId = await currentUserId();
  const now = new Date().toISOString();
  const { error, count } = await supabase
    .from('agent_tasks')
    .update({ status: 'cancelled', completed_at: now, updated_at: now }, { count: 'exact' })
    .eq('id', taskId)
    .in('status', LIVE_STATUSES);
  if (error) raise(error, 'Could not cancel the task.');
  if (count === 0) throw new Error(STALE_MESSAGE);
  await logHumanEvent(taskId, userId, 'cancelled', reason?.trim() || null);
}

/**
 * Hands an unfinished task to a different agent. It goes back to 'open' so
 * the new agent claims it afresh; any question the old agent asked is kept
 * in the log but cleared from the task.
 */
export async function reassignTask(
  taskId: string,
  tokenId: string,
  agentLabel?: string,
): Promise<void> {
  const userId = await currentUserId();
  const { error, count } = await supabase
    .from('agent_tasks')
    .update({
      assigned_token_id: tokenId,
      status: 'open',
      claimed_at: null,
      question: null,
      answer: null,
      updated_at: new Date().toISOString(),
    }, { count: 'exact' })
    .eq('id', taskId)
    .in('status', LIVE_STATUSES);
  if (error) raise(error, 'Could not reassign the task.');
  if (count === 0) throw new Error(STALE_MESSAGE);
  await logHumanEvent(taskId, userId, 'reassigned', agentLabel ? `Reassigned to ${agentLabel}.` : null);
}

// ── links ────────────────────────────────────────────────────────────

/** Where a task's attachment or result opens in the app. */
export function refHref(ref: TaskRef, matterId: string, contentType?: string | null): string {
  if (ref.kind === 'document') return `/app/document/${ref.id}`;
  if (ref.kind === 'calendar_event') return `/app/matterspace/${matterId}?tab=Calendar`;
  if (contentType === 'list') return `/app/list/${ref.id}`;
  if (contentType === 'table') return `/app/table/${ref.id}`;
  return `/app/page/${ref.id}`;
}
