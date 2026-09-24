// The matter's Tasks tab (spec B7): what has been handed to agents in this
// matter, where each task stands, the agent's question when it is waiting on
// you, its result, and the log of everything either side did.
//
// A docket, not a spectacle: one line per task, newest first; open a line to
// see the rest. Before migration 085 the tab says so in one sentence.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAgentsForMatter } from '@/hooks/useAgentTokens';
import { agentLabel, type AgentToken } from '@/lib/agentTokens';
import {
  AGENTS_MIGRATION_MESSAGE,
  LIVE_STATUSES,
  TASK_STATUS_LABEL,
  answerQuestion,
  cancelTask,
  isAgentsNotReady,
  listEvents,
  listTasks,
  reassignTask,
  refHref,
  type AgentTask,
  type AgentTaskEvent,
  type AgentTaskStatus,
  type TaskRef,
} from '@/lib/agentTasks';
import DelegateCard, { MATTER_TASKS_KEY } from './DelegateCard';

const CHIP: Record<AgentTaskStatus, string> = {
  open: 'border-white/20 text-white/70',
  claimed: 'border-[#8b9dc3]/50 text-[#aebbd8]',
  needs_input: 'border-[#e8b84a]/60 text-[#e8b84a]',
  done: 'border-[#4ade80]/40 text-[#86e0a8]',
  failed: 'border-[#f87171]/50 text-[#f8a1a1]',
  cancelled: 'border-white/10 text-white/40',
};

const EVENT_VERB: Record<string, string> = {
  created: 'created the task',
  claimed: 'claimed it',
  asked: 'asked',
  answered: 'answered',
  result: 'posted the result',
  failed: 'reported that it could not finish',
  cancelled: 'cancelled it',
  reassigned: 'reassigned it',
  note: 'noted',
};

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function day(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function StatusChip({ status }: { status: AgentTaskStatus }) {
  return (
    <span className={`text-[10.5px] px-1.5 py-0.5 rounded border whitespace-nowrap ${CHIP[status] ?? CHIP.open}`}>
      {TASK_STATUS_LABEL[status] ?? status}
    </span>
  );
}

function RefLinks({ refs, matterId }: { refs: TaskRef[]; matterId: string }) {
  // A list, page or table opens at its own route, so ask which it is.
  const itemIds = refs.filter((r) => r.kind === 'content_item').map((r) => r.id);
  const { data: types } = useQuery({
    queryKey: ['agent_task_ref_types', ...itemIds],
    enabled: itemIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from('content_items').select('id, content_type').in('id', itemIds);
      return new Map(((data ?? []) as { id: string; content_type: string }[]).map((r) => [r.id, r.content_type]));
    },
    staleTime: 60_000,
  });
  if (refs.length === 0) return null;
  return (
    <ul className="space-y-0.5">
      {refs.map((r) => (
        <li key={`${r.kind}:${r.id}`} className="text-[12.5px]">
          <Link to={refHref(r, matterId, types?.get(r.id))} className="text-[#e8b84a] hover:underline">
            {r.label || (r.kind === 'document' ? 'Document' : r.kind === 'calendar_event' ? 'Calendar entry' : 'Item')}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function TaskDetail({
  task,
  agentName,
  reassignable,
  onChanged,
}: {
  task: AgentTask;
  agentName: (tokenId: string | null) => string;
  reassignable: AgentToken[];
  onChanged: () => void;
}) {
  const [events, setEvents] = useState<AgentTaskEvent[] | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reassignTo, setReassignTo] = useState('');

  useEffect(() => {
    let cancelled = false;
    listEvents(task.id)
      .then((rows) => { if (!cancelled) setEvents(rows); })
      .catch((e) => { if (!cancelled) setEventsError(e instanceof Error ? e.message : 'Could not read the log.'); });
    return () => { cancelled = true; };
  }, [task.id, task.updated_at]);

  const live = LIVE_STATUSES.includes(task.status);
  const others = reassignable.filter((a) => a.id !== task.assigned_token_id);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(isAgentsNotReady(e) ? AGENTS_MIGRATION_MESSAGE : e instanceof Error ? e.message : 'That did not go through.');
      onChanged(); // re-read: the task may have moved on under us
    } finally {
      setBusy(false);
    }
  };

  const label = 'text-[10px] uppercase tracking-wider text-white/40 mb-1';

  return (
    <div className="pl-6 pr-2 pb-4 pt-1 space-y-3">
      {task.status === 'needs_input' && task.question && (
        <div className="rounded-md border border-[#e8b84a]/40 bg-[#e8b84a]/[0.06] px-3 py-2.5">
          <p className="text-[11px] uppercase tracking-wider text-[#e8b84a] mb-1">The agent asks</p>
          <p className="text-[13px] text-white/90 whitespace-pre-wrap leading-relaxed">{task.question}</p>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={3}
            placeholder="Your answer"
            className="mt-2 w-full px-2.5 py-1.5 rounded-md border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)] text-[12.5px] text-white placeholder-white/35 focus:outline-none focus:ring-1 focus:ring-[#e8b84a]"
          />
          <button
            onClick={() => void run(async () => { await answerQuestion(task.id, answer); setAnswer(''); })}
            disabled={busy || !answer.trim()}
            className="mt-1.5 px-3 py-1 rounded-md bg-[#f0c850] hover:bg-[#f5d565] text-[#0e0e12] text-[11.5px] font-bold disabled:opacity-40"
          >
            {busy ? 'Sending…' : 'Answer'}
          </button>
        </div>
      )}

      {task.instructions && (
        <div>
          <p className={label}>Instructions</p>
          <p className="text-[12.5px] text-white/75 whitespace-pre-wrap leading-relaxed">{task.instructions}</p>
        </div>
      )}

      {task.attachments.length > 0 && (
        <div>
          <p className={label}>Attached</p>
          <RefLinks refs={task.attachments} matterId={task.matterspace_id} />
        </div>
      )}

      {task.answer && task.status !== 'needs_input' && task.question && (
        <div>
          <p className={label}>Last question and answer</p>
          <p className="text-[12.5px] text-white/60 whitespace-pre-wrap">Q: {task.question}</p>
          <p className="text-[12.5px] text-white/75 whitespace-pre-wrap">A: {task.answer}</p>
        </div>
      )}

      {(task.result || task.result_refs.length > 0) && (
        <div>
          <p className={label}>{task.status === 'failed' ? 'What the agent reported' : 'Result'}</p>
          {task.result && (
            <p className="text-[12.5px] text-white/85 whitespace-pre-wrap leading-relaxed">{task.result}</p>
          )}
          <div className="mt-1"><RefLinks refs={task.result_refs} matterId={task.matterspace_id} /></div>
        </div>
      )}

      {live && (
        <div className="flex flex-wrap items-center gap-2">
          {others.length > 0 && (
            <>
              <select
                value={reassignTo}
                onChange={(e) => setReassignTo(e.target.value)}
                className="px-2 py-1 rounded-md border border-[rgba(255,255,255,0.12)] bg-[rgba(20,20,30,0.8)] text-[11.5px] text-white/80"
              >
                <option value="">Reassign to…</option>
                {others.map((a) => <option key={a.id} value={a.id}>{agentLabel(a)}</option>)}
              </select>
              <button
                onClick={() => void run(async () => {
                  const a = others.find((x) => x.id === reassignTo);
                  if (!a) return;
                  await reassignTask(task.id, a.id, agentLabel(a));
                  setReassignTo('');
                })}
                disabled={busy || !reassignTo}
                className="px-2.5 py-1 rounded-md border border-[rgba(255,255,255,0.14)] text-[11.5px] text-white/70 hover:text-white disabled:opacity-40"
              >
                Reassign
              </button>
            </>
          )}
          <button
            onClick={() => {
              if (!confirm(`Cancel "${task.title}"? The agent will no longer see it. The log stays.`)) return;
              void run(() => cancelTask(task.id));
            }}
            disabled={busy}
            className="ml-auto px-2.5 py-1 rounded-md text-[11.5px] text-white/50 hover:text-red-300 hover:bg-red-300/10 disabled:opacity-40"
          >
            Cancel task
          </button>
        </div>
      )}
      {error && <p className="text-[12px] text-red-300">{error}</p>}

      <div>
        <p className={label}>Log</p>
        {eventsError ? (
          <p className="text-[12px] text-red-300">{eventsError}</p>
        ) : events === null ? (
          <p className="text-[12px] text-white/35 italic">Reading the log…</p>
        ) : events.length === 0 ? (
          <p className="text-[12px] text-white/40">Nothing logged.</p>
        ) : (
          <ol className="space-y-1 border-l border-white/10 pl-3">
            {events.map((ev) => (
              <li key={ev.id} className="text-[12px] text-white/65 leading-relaxed">
                <span className="text-white/40">{when(ev.at)}</span>{' · '}
                <span className="text-white/80">
                  {ev.actor_kind === 'agent' ? agentName(ev.actor_token_id) : 'You'}
                </span>{' '}
                {EVENT_VERB[ev.kind] ?? ev.kind}
                {ev.body && ev.kind !== 'created' ? (
                  <span className="block text-white/55 whitespace-pre-wrap">{ev.body}</span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

export default function MatterTasks({ matterId }: { matterId: string }) {
  const qc = useQueryClient();
  const { all: agents, eligible } = useAgentsForMatter(matterId);
  const [showAll, setShowAll] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newTask, setNewTask] = useState(false);

  const q = useQuery({
    queryKey: MATTER_TASKS_KEY(matterId),
    queryFn: () => listTasks({ matterId }),
    staleTime: 15_000,
    // An agent works on its own clock; look again while the tab is open.
    refetchInterval: 60_000,
    retry: (count, err) => !isAgentsNotReady(err) && count < 2,
  });

  const byToken = useMemo(() => new Map(agents.map((a) => [a.id, a] as const)), [agents]);
  const agentName = (tokenId: string | null) => {
    const a = tokenId ? byToken.get(tokenId) : undefined;
    return a ? agentLabel(a) : 'A revoked agent';
  };

  const tasks = q.data ?? [];
  const shown = showAll ? tasks : tasks.filter((t) => LIVE_STATUSES.includes(t.status));
  const waiting = tasks.filter((t) => t.status === 'needs_input').length;
  const refresh = () => void qc.invalidateQueries({ queryKey: MATTER_TASKS_KEY(matterId) });

  if (q.error && isAgentsNotReady(q.error)) {
    return <p className="text-[13px] text-white/60 py-4">{AGENTS_MIGRATION_MESSAGE}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[14px] font-semibold text-[#f5f1e8] tracking-tight mr-auto">
          Tasks for agents
          {waiting > 0 && (
            <span className="ml-2 text-[12px] font-normal text-[#e8b84a]">
              {waiting} waiting on your answer
            </span>
          )}
        </h2>
        <div className="flex rounded-md border border-[rgba(255,255,255,0.12)] overflow-hidden">
          {[false, true].map((all) => (
            <button
              key={String(all)}
              onClick={() => setShowAll(all)}
              className={`px-2.5 py-1 text-[11px] transition-colors ${
                showAll === all ? 'bg-[rgba(255,255,255,0.1)] text-white' : 'text-white/50 hover:text-white'
              }`}
            >
              {all ? 'All' : 'Open'}
            </button>
          ))}
        </div>
        <button
          onClick={() => setNewTask(true)}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#f0c850] hover:bg-[#f5d565] text-[#0e0e12] text-[11px] font-bold transition-colors"
        >
          <Plus size={12} strokeWidth={2.5} />
          New task
        </button>
      </div>

      {q.error && <p className="text-[12px] text-red-300">{(q.error as Error).message}</p>}
      {q.isLoading && <p className="text-[12px] text-white/35 py-6 text-center">Reading the tasks…</p>}

      {!q.isLoading && !q.error && shown.length === 0 && (
        <p className="text-[12.5px] text-white/50 py-2 leading-relaxed">
          {tasks.length === 0
            ? 'Nothing has been delegated in this matter. Use Delegate… on a document, list, page or calendar entry, or New task above.'
            : 'No open tasks. Choose All to see finished and cancelled ones.'}
        </p>
      )}

      {shown.length > 0 && (
        <div className="rounded-lg border border-[rgba(255,255,255,0.1)] divide-y divide-[rgba(255,255,255,0.06)]">
          {shown.map((t) => {
            const open = openId === t.id;
            return (
              <div key={t.id}>
                <button
                  onClick={() => setOpenId(open ? null : t.id)}
                  className="w-full flex items-start gap-2 px-2 py-2 text-left hover:bg-white/[0.02]"
                >
                  {open
                    ? <ChevronDown size={14} className="mt-0.5 text-white/40 shrink-0" />
                    : <ChevronRight size={14} className="mt-0.5 text-white/40 shrink-0" />}
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] text-white/90">{t.title}</span>
                      <StatusChip status={t.status} />
                    </span>
                    <span className="block text-[11.5px] text-white/45 mt-0.5">
                      {agentName(t.assigned_token_id)} · delegated {day(t.created_at)}
                      {t.due_at ? ` · due ${day(t.due_at)}` : ''}
                    </span>
                  </span>
                </button>
                {open && (
                  <TaskDetail
                    task={t}
                    agentName={agentName}
                    reassignable={eligible}
                    onChanged={refresh}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {newTask && (
        <DelegateCard
          matterId={matterId}
          attachment={null}
          defaultTitle=""
          onClose={() => setNewTask(false)}
        />
      )}
    </div>
  );
}
