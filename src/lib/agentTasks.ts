// The agents task board, human side (spec B5).
//
// A task is work Eden hands to a connected AI: an agent (a Grok Bot, any MCP
// client holding an agent token) or, since migration 089, an assistant he
// chats with (a full-access token, or Claude / ChatGPT / Grok signed in as a
// full assistant). The AI picks it up over MCP; nothing here calls it. These helpers are the browser's half: create,
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

// Limits migration 085 enforces (and ask_human mirrors, for the answer).
export const TITLE_MAX = 500;
export const INSTRUCTIONS_MAX = 20_000;
export const ANSWER_MAX = 4_000;

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
  /** An agent or full-access token (085). Null when the task is for a grant. */
  assigned_token_id: string | null;
  /** 089: a full-assistant OAuth sign-in. Null (or absent before 089) otherwise. */
  assigned_grant_id: string | null;
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
  /** 089: the OAuth assistant that wrote the entry. */
  actor_grant_id: string | null;
  kind: TaskEventKind;
  body: string | null;
}

const TASK_COLUMNS =
  'id, matterspace_id, created_by, assigned_token_id, title, instructions, attachments, due_at, '
  + 'status, question, answer, result, result_refs, claimed_at, completed_at, created_at, updated_at';

const EVENT_COLUMNS = 'id, task_id, at, actor_kind, actor_user, actor_token_id, kind, body';

/**
 * A read that named a column 089 adds and failed because it is not there
 * yet (42703 from Postgres, PGRST204 from PostgREST). Retried without it:
 * before 089 no task can have a grant, so leaving it out is the truth.
 */
function isMissing089Column(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === '42703' || err.code === 'PGRST204'
    || /assigned_grant_id|actor_grant_id/.test(err.message ?? '');
}

type Read = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;

/** Run `build(columns)` with the 089 column, then without it if it is missing. */
async function read089(build: (cols: string) => Read, base: string, extra: string) {
  let r = await build(`${base}, ${extra}`);
  if (r.error && isMissing089Column(r.error)) r = await build(base);
  return r;
}

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
    assigned_token_id: t.assigned_token_id ?? null,
    assigned_grant_id: t.assigned_grant_id ?? null,
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

/**
 * matterId: one matter's tasks (the matter's Tasks tab). tokenId / grantId:
 * one connection's tasks. all: every task this account can read, across
 * every matter (the Agents page), which it narrows to its own connections.
 */
export type TaskFilter = { matterId: string } | { tokenId: string } | { grantId: string } | { all: true };

/** Newest first. `statuses` narrows; omitted means every status. */
export async function listTasks(
  filter: TaskFilter,
  opts: { statuses?: AgentTaskStatus[]; limit?: number } = {},
): Promise<AgentTask[]> {
  const build = (cols: string) => {
    let q = supabase.from('agent_tasks').select(cols);
    if ('matterId' in filter) q = q.eq('matterspace_id', filter.matterId);
    else if ('tokenId' in filter) q = q.eq('assigned_token_id', filter.tokenId);
    else if ('grantId' in filter) q = q.eq('assigned_grant_id', filter.grantId);
    if (opts.statuses?.length) q = q.in('status', opts.statuses);
    return q.order('created_at', { ascending: false }).limit(opts.limit ?? 200);
  };
  const { data, error } = await read089(build, TASK_COLUMNS, 'assigned_grant_id');
  if (error) {
    // Before 089 a grant has no tasks; the filter column is what is missing.
    if ('grantId' in filter && isMissing089Column(error)) return [];
    raise(error, 'Could not read the tasks.');
  }
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
  for (const r of (data ?? []) as { assigned_token_id: string | null }[]) {
    if (!r.assigned_token_id) continue;
    out.set(r.assigned_token_id, (out.get(r.assigned_token_id) ?? 0) + 1);
  }
  return out;
}

/** The task's log, oldest first. */
export async function listEvents(taskId: string): Promise<AgentTaskEvent[]> {
  const build = (cols: string) => supabase
    .from('agent_task_events')
    .select(cols)
    .eq('task_id', taskId)
    .order('at', { ascending: true })
    .limit(500);
  const { data, error } = await read089(build, EVENT_COLUMNS, 'actor_grant_id');
  if (error) raise(error, 'Could not read the task log.');
  return ((data ?? []) as unknown as AgentTaskEvent[]).map((e) => ({ ...e, actor_grant_id: e.actor_grant_id ?? null }));
}

// ── writes (each one logged) ─────────────────────────────────────────

// An update that matched no row: the agent moved the task on (answered,
// finished, or it was already cancelled) between the read and the click.
// Nothing changed, so nothing is logged.
const STALE_MESSAGE =
  'This task changed since the page was loaded, so nothing was saved. Reopen it to see where it stands.';

/** Who a task goes to: a token (agent or full access), or an OAuth grant (089). */
export interface TaskRecipientRef {
  kind: 'token' | 'grant';
  id: string;
}

/** The two recipient columns for a write. The grant column is named only when it matters (it is 089's). */
function recipientColumns(to: TaskRecipientRef, clearGrant: boolean): Record<string, string | null> {
  if (to.kind === 'grant') return { assigned_token_id: null, assigned_grant_id: to.id };
  return clearGrant ? { assigned_token_id: to.id, assigned_grant_id: null } : { assigned_token_id: to.id };
}

export interface NewTask {
  matterId: string;
  recipient: TaskRecipientRef;
  /** A full-access token or OAuth assistant rather than an agent (for the pre-089 message). */
  chatAssistant?: boolean;
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
  if (title.length > TITLE_MAX) throw new Error(`A task title can be at most ${TITLE_MAX} characters.`);
  const instructions = (input.instructions ?? '').trim();
  if (instructions.length > INSTRUCTIONS_MAX) {
    throw new Error(`Instructions can be at most ${INSTRUCTIONS_MAX.toLocaleString()} characters.`);
  }
  const userId = await currentUserId();
  const id = crypto.randomUUID();
  const { error } = await supabase.from('agent_tasks').insert({
    id,
    matterspace_id: input.matterId,
    created_by: userId,
    ...recipientColumns(input.recipient, false),
    title,
    instructions,
    attachments: input.attachments ?? [],
    due_at: input.dueAt ?? null,
  });
  if (error) {
    // Before 089: a grant column that is not there, or 085's policy refusing
    // a task for anything but an agent. Say which update is missing.
    if (input.chatAssistant && (isMissing089Column(error) || error.code === '42501')) {
      throw new Error(ASSISTANT_TASKS_NOT_READY);
    }
    raise(error, 'Could not create the task.');
  }
  await logHumanEvent(id, userId, 'created', title);
  return id;
}

export const ASSISTANT_TASKS_NOT_READY =
  'Handing tasks to an assistant you chat with needs a database update (migration 089). Agents work now.';

/** Answers the agent's question; the task goes back to the agent (claimed). */
export async function answerQuestion(taskId: string, answer: string): Promise<void> {
  const text = answer.trim();
  if (!text) throw new Error('Write an answer first.');
  if (text.length > ANSWER_MAX) throw new Error(`An answer can be at most ${ANSWER_MAX.toLocaleString()} characters.`);
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
 * Hands an unfinished task to a different connection. It goes back to
 * 'open' so the new one claims it afresh; any question the old one asked is
 * kept in the log but cleared from the task. `fromGrant`: the task is on an
 * OAuth grant now, so the grant column must be cleared.
 */
export async function reassignTask(
  taskId: string,
  to: TaskRecipientRef,
  opts: { label?: string; fromGrant?: boolean; chatAssistant?: boolean } = {},
): Promise<void> {
  const agentLabel = opts.label;
  const userId = await currentUserId();
  const { error, count } = await supabase
    .from('agent_tasks')
    .update({
      ...recipientColumns(to, opts.fromGrant === true),
      status: 'open',
      claimed_at: null,
      question: null,
      answer: null,
      updated_at: new Date().toISOString(),
    }, { count: 'exact' })
    .eq('id', taskId)
    .in('status', LIVE_STATUSES);
  if (error) {
    if (opts.chatAssistant && (isMissing089Column(error) || error.code === '42501')) {
      throw new Error(ASSISTANT_TASKS_NOT_READY);
    }
    raise(error, 'Could not reassign the task.');
  }
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
