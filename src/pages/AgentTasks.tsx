// The Agents page (surface 'agentTasks', route /app/agent-tasks): the front
// door for tasks. Eden (2026-09-25): "I like the tasks idea and the delegate
// function. I just want to get there via a general agents tab first."
//
//   * Three classes of agent (Eden, 2026-10-28): Equazia Agents (the ones we
//     build; a live one opens to its Procedures), Custom Agents (create your
//     own; Coming), and My Connected Agents (outside agents you trust, each
//     limited to the matters you choose: name, provider, last used, open
//     tasks, Edit matters / Revoke). Choosing one filters the tasks to it.
//     Assistants you chat with are not agents and are not listed here; their
//     tasks still show below.
//   * Below, All tasks across every matter: waiting for you, open, recently
//     done. Each line opens to the question and Answer box, the result and
//     the log (the same pieces as a matter's Tasks tab).
//   * New task: one card to choose the recipient, the matter (SecureSpaces
//     cannot be chosen), an optional item from it, a title and instructions.
//
// Delegate… on an item and a matter's Tasks tab are shortcuts into the same
// tasks; both link here. Not the frozen `agents` surface (/app/agents), which
// is the in-app agent-charters workshop.
//
// A docket, not a spectacle: plain rows, newest first.

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Bot, MessageSquare, Plus } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useServerspaces } from '@/hooks/useServerspaces';
import { useTaskRecipients, useTaskRecipientsInvalidate } from '@/hooks/useTaskRecipients';
import {
  AGENTS_MIGRATION_MESSAGE,
  LIVE_STATUSES,
  isAgentsNotReady,
  listTasks,
  type AgentTask,
} from '@/lib/agentTasks';
import {
  listAgentTokens,
  listOauthAgentLinks,
  revokeAgentToken,
  revokeOauthGrant,
  type AgentToken,
} from '@/lib/agentTokens';
import {
  CHAT_ASSISTANT_NOTE,
  recipientLabel,
  recipientsForMatter,
  type TaskRecipient,
} from '@/lib/task-recipients';
import { ALL_TASKS_KEY, taskKey } from '@/lib/task-ui';
import DelegateCard from '@/components/agents/DelegateCard';
import { AddAgentCard, EditMattersCard, ALL_MATTERS_LABEL } from '@/components/agents/AgentsSection';
import { TaskDetail, TaskLine } from '@/components/agents/MatterTasks';
import EquaziaAgents from '@/components/agents/EquaziaAgents';

export const AGENTS_PAGE_INTRO =
  'The agents Equazia builds, the agents you create, and the outside agents you connect, with every task '
  + 'you have handed one. No agent works in a SecureSpace.';

/** The outside agent families a firm can connect (Eden, 2026-10-28). */
const CONNECTABLE_FAMILIES = ['Grok Bots', 'GPT Dots', 'Meta Muse', 'Gemini Spark', 'Instinct (when available)'];

const RECENT_DAYS = 30;
const RECENT_MAX = 25;

function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function RecipientRow({
  r,
  open,
  selected,
  scopeLine,
  onSelect,
  onEdit,
  onRevoke,
  busy,
}: {
  r: TaskRecipient;
  open: number;
  selected: boolean;
  scopeLine: string | null;
  onSelect: () => void;
  onEdit?: () => void;
  onRevoke?: () => void;
  busy: boolean;
}) {
  const used = shortDate(r.lastUsed);
  const Icon = r.kind === 'agent' ? Bot : MessageSquare;
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border px-3 sm:px-4 py-3 transition-colors ${
        selected
          ? 'border-[#e8b84a]/50 bg-[#e8b84a]/[0.05]'
          : 'border-[var(--color-border-strong)] bg-[var(--color-surface)]'
      }`}
    >
      <button onClick={onSelect} className="flex items-start gap-3 flex-1 min-w-0 text-left" aria-pressed={selected}>
        <span className="w-9 h-9 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center shrink-0">
          <Icon size={16} className="text-[var(--color-primary)]" strokeWidth={1.75} />
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2 flex-wrap">
            <span className="text-[14px] font-medium text-[var(--color-text-bright)] break-words">{r.name}</span>
            <span className="text-[11px] px-2 py-0.5 rounded-full border border-[var(--color-border)] text-[var(--color-text-secondary)]">
              {r.provider}
            </span>
          </span>
          <span className="block text-[12.5px] text-[var(--color-text-secondary)] mt-0.5">
            {r.how}
            {scopeLine ? ` · ${scopeLine}` : ''}
          </span>
          <span className="block text-[12px] text-[var(--color-text-muted)] mt-0.5">
            {used ? `Last used ${used}.` : 'Not used yet.'}{' '}
            {open === 0 ? 'No open tasks.' : `${open} open task${open === 1 ? '' : 's'}.`}
            {r.kind !== 'agent' ? ` ${CHAT_ASSISTANT_NOTE}` : ''}
          </span>
        </span>
      </button>
      <span className="flex flex-col items-end gap-1.5 shrink-0">
        {r.kind === 'agent' ? (
          <>
            <button onClick={onEdit} className="text-[12.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-bright)] transition">
              Edit matters
            </button>
            <button
              onClick={onRevoke}
              disabled={busy}
              className="text-[12.5px] text-[var(--color-text-secondary)] hover:text-[#f87171] transition disabled:opacity-50"
            >
              Revoke
            </button>
          </>
        ) : (
          <Link to="/app/connections" className="text-[12.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-bright)] transition">
            Connections
          </Link>
        )}
      </span>
    </div>
  );
}

export default function AgentTasks() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selectedKey = params.get('to');
  const { all, byKey, loading, notReady, error: recipientsError } = useTaskRecipients();
  const invalidateRecipients = useTaskRecipientsInvalidate();
  const { data: serverspaces = [] } = useServerspaces();
  const matters = useMemo(() => serverspaces.flatMap((s) => s.matterspaces ?? []), [serverspaces]);
  const matterName = useMemo(() => new Map(matters.map((m) => [m.id, m.name] as const)), [matters]);

  const [openId, setOpenId] = useState<string | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AgentToken | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ALL_TASKS_KEY,
    queryFn: () => listTasks({ all: true }, { limit: 500 }),
    staleTime: 15_000,
    refetchInterval: 60_000,
    retry: (count, err) => !isAgentsNotReady(err) && count < 2,
  });

  // Only tasks on this account's own connections: the page is "my AI and my
  // work". A co-counsel's tasks stay on the shared matter's Tasks tab.
  const tasks = useMemo(() => (q.data ?? []).filter((t) => byKey.has(taskKey(t) ?? '')), [q.data, byKey]);
  const live = useMemo(() => all.filter((r) => r.live), [all]);
  const selected = selectedKey ? byKey.get(selectedKey) ?? null : null;

  const openCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) {
      if (!LIVE_STATUSES.includes(t.status)) continue;
      const k = taskKey(t);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [tasks]);

  const shown = selectedKey ? tasks.filter((t) => taskKey(t) === selectedKey) : tasks;
  const waiting = shown.filter((t) => t.status === 'needs_input');
  const open = shown.filter((t) => t.status === 'open' || t.status === 'claimed');
  const since = Date.now() - RECENT_DAYS * 86_400_000;
  const finished = shown.filter((t) => !LIVE_STATUSES.includes(t.status));
  const recent = showOlder
    ? finished
    : finished.filter((t) => new Date(t.completed_at ?? t.updated_at ?? t.created_at).getTime() >= since).slice(0, RECENT_MAX);

  const select = (key: string | null) => {
    const next = new URLSearchParams(params);
    if (key && key !== selectedKey) next.set('to', key); else next.delete('to');
    setParams(next, { replace: true });
    setOpenId(null);
  };

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ALL_TASKS_KEY });
    void qc.invalidateQueries({ queryKey: ['agent_tasks', 'matter'] });
  };

  const agentRow = async (id: string): Promise<AgentToken | null> =>
    (await listAgentTokens()).find((a) => a.id === id) ?? null;

  const revoke = async (r: TaskRecipient) => {
    if (!confirm(`Revoke ${r.name}?\n\nIt stops working on its next request. Its tasks and their log stay in each matter.`)) return;
    setBusyId(r.id);
    setActionError(null);
    try {
      await revokeAgentToken(r.id);
      // An agent connected by sign-in: end the sign-in too (as Connections › Agents does).
      if (r.bySignIn) {
        const link = (await listOauthAgentLinks()).get(r.id);
        if (link) await revokeOauthGrant(link.grantId).catch(() => {});
      }
      invalidateRecipients();
      if (selectedKey === r.key) select(null);
    } catch (e) {
      setActionError(isAgentsNotReady(e) ? AGENTS_MIGRATION_MESSAGE : e instanceof Error ? e.message : 'Could not revoke.');
    } finally {
      setBusyId(null);
    }
  };

  const scopeLine = (r: TaskRecipient): string | null => {
    if (r.kind !== 'agent') return 'Sees every matter you can see, except SecureSpaces';
    if (r.scopeAll) return `Sees: ${ALL_MATTERS_LABEL}`;
    const n = (r.matterScope ?? []).length;
    return n === 0 ? 'Sees nothing yet' : `Sees ${n} matter${n === 1 ? '' : 's'} and what is beneath ${n === 1 ? 'it' : 'them'}`;
  };

  const nameOf = (t: AgentTask) => (key: string | null) => {
    const r = byKey.get(key ?? taskKey(t) ?? '');
    if (r) return `${recipientLabel(r)}${r.live ? '' : ' (disconnected)'}`;
    return 'A connected AI';
  };

  const section = (label: string, rows: AgentTask[], empty: string) => (
    <div className="mt-5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
        {label} <span className="font-normal normal-case tracking-normal">({rows.length})</span>
      </h3>
      {rows.length === 0 ? (
        <p className="text-[12.5px] text-[var(--color-text-muted)]">{empty}</p>
      ) : (
        <div className="rounded-lg border border-[rgba(255,255,255,0.1)] divide-y divide-[rgba(255,255,255,0.06)]">
          {rows.map((t) => {
            const isOpen = openId === t.id;
            // Reassign offers what can see this task's matter.
            const can = recipientsForMatter(matters, all, t.matterspace_id);
            return (
              <TaskLine
                key={t.id}
                task={t}
                open={isOpen}
                onToggle={() => setOpenId(isOpen ? null : t.id)}
                who={nameOf(t)(null)}
                matterName={matterName.get(t.matterspace_id) ?? 'a matter'}
              >
                <TaskDetail
                  task={t}
                  recipientName={nameOf(t)}
                  mine
                  ownerName="you"
                  reassignable={[...can.agents, ...can.assistants]}
                  onChanged={refresh}
                />
                <p className="pl-6 pb-3 -mt-2 text-[11.5px]">
                  <Link to={`/app/matterspace/${t.matterspace_id}?tab=Tasks`} className="text-[#e8b84a] hover:underline">
                    Open the matter's Tasks →
                  </Link>
                </p>
              </TaskLine>
            );
          })}
        </div>
      )}
    </div>
  );

  const connectedAgents = live.filter((r) => r.group === 'agents');

  return (
    <div className="min-h-screen text-[var(--color-text)]">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <Link
          to="/app"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-bright)] transition mb-6"
        >
          <ArrowLeft size={14} /> Back
        </Link>

        <header className="mb-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h1
              className="text-4xl font-serif tracking-tight text-[var(--color-text-bright)]"
              style={{ fontFamily: 'Playfair Display Variable, serif' }}
            >
              Agents
            </h1>
            {!notReady && (
              <button
                onClick={() => setNewTask(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[var(--color-primary)] text-[#1a1408] text-[13px] font-semibold transition hover:bg-[var(--color-primary-hover)]"
              >
                <Plus size={14} strokeWidth={2.5} /> New task
              </button>
            )}
          </div>
          <p className="mt-3 text-[var(--color-text-secondary)] max-w-xl leading-relaxed text-[14px]">
            {AGENTS_PAGE_INTRO}
          </p>
        </header>

        {notReady && (
          <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 text-[13px] text-[var(--color-text-secondary)]">
            {AGENTS_MIGRATION_MESSAGE}
          </p>
        )}
        {recipientsError && <p className="mb-3 text-[13px] text-[#f87171]">{recipientsError}</p>}
        {actionError && <p className="mb-3 text-[13px] text-[#f87171]">{actionError}</p>}

        {/* Equazia Agents: the agents we build. A live one opens to its
            Procedures. Not gated on the task board (085): a procedure needs
            only its own tables. */}
        <section aria-labelledby="equazia-agents" className="mb-10">
          <h2 id="equazia-agents" className="text-[15px] font-medium text-[var(--color-text-bright)]">Equazia Agents</h2>
          <p className="mt-1 mb-3 text-[12.5px] text-[var(--color-text-muted)]">
            Built by Equazia and added as they are ready. Each works inside one matter, and you decide and sign off.
          </p>
          <EquaziaAgents />
        </section>

        <section aria-labelledby="custom-agents" className="mb-10">
          <h2 id="custom-agents" className="text-[15px] font-medium text-[var(--color-text-bright)]">Custom Agents</h2>
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3.5 opacity-80">
            <span className="flex-1 text-[13px] text-[var(--color-text-secondary)]">Create your own legal agents.</span>
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] border border-[var(--color-border)] rounded px-1.5 py-px">
              Coming
            </span>
          </div>
        </section>

        {!notReady && (
          <section aria-labelledby="connected-agents">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="connected-agents" className="text-[15px] font-medium text-[var(--color-text-bright)]">My Connected Agents</h2>
              <button onClick={() => setAdding(true)} className="text-[12.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-bright)]">
                Connect an agent
              </button>
            </div>
            <p className="mt-1 text-[12.5px] text-[var(--color-text-muted)] leading-relaxed">
              Outside agents you trust, each limited to the matters you choose: {CONNECTABLE_FAMILIES.join(', ')}.
              A connected agent never reaches a SecureSpace.
            </p>
            {loading && <p className="mt-3 text-[12.5px] text-[var(--color-text-muted)] italic">Reading your connections…</p>}
            {!loading && connectedAgents.length === 0 && (
              <p className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 text-[13px] text-[var(--color-text-secondary)] leading-relaxed">
                No agent is connected yet.
              </p>
            )}
            {connectedAgents.length > 0 && (
              <div className="mt-3 flex flex-col gap-2">
                {connectedAgents.map((r) => (
                  <RecipientRow
                    key={r.key}
                    r={r}
                    open={openCount.get(r.key) ?? 0}
                    selected={r.key === selectedKey}
                    scopeLine={scopeLine(r)}
                    onSelect={() => select(r.key)}
                    onEdit={() => void agentRow(r.id).then((a) => a && setEditing(a))}
                    onRevoke={() => void revoke(r)}
                    busy={busyId === r.id}
                  />
                ))}
              </div>
            )}
            <p className="mt-3 text-[12px] text-[var(--color-text-muted)]">
              Assistants you chat with (Claude, ChatGPT, Gemini, Grok) are not agents: connect them under{' '}
              <Link to="/app/connections" className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-bright)] underline">Connections</Link>.
            </p>
          </section>
        )}

        {!notReady && (
          <section aria-labelledby="all-tasks" className="mt-10">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="all-tasks" className="text-[15px] font-medium text-[var(--color-text-bright)]">
                {selected ? `Tasks for ${selected.name}` : 'All tasks'}
              </h2>
              {selected && (
                <button onClick={() => select(null)} className="text-[12.5px] text-[#e8b84a] hover:underline">
                  Show every connection
                </button>
              )}
            </div>
            <p className="mt-1 text-[12.5px] text-[var(--color-text-muted)]">
              Across every matter. Delegate… on a document, list, page or calendar entry, and each matter's Tasks tab, add to this list.
            </p>
            {q.error && !isAgentsNotReady(q.error) && (
              <p className="mt-3 text-[12.5px] text-[#f87171]">{(q.error as Error).message}</p>
            )}
            {q.isLoading ? (
              <p className="mt-4 text-[12.5px] text-[var(--color-text-muted)] italic">Reading the tasks…</p>
            ) : (
              <>
                {section('Waiting for you', waiting, 'Nothing is waiting on your answer.')}
                {section('Open', open, 'No open tasks.')}
                {section(showOlder ? 'Finished' : 'Recently done', recent, showOlder ? 'Nothing finished yet.' : `Nothing finished in the last ${RECENT_DAYS} days.`)}
                {finished.length > recent.length || showOlder ? (
                  <button onClick={() => setShowOlder(!showOlder)} className="mt-3 text-[12.5px] text-[#e8b84a] hover:underline">
                    {showOlder ? 'Show only recent' : 'Show every finished task'}
                  </button>
                ) : null}
              </>
            )}
          </section>
        )}
      </div>

      {newTask && (
        <DelegateCard
          matterId={null}
          attachment={null}
          defaultTitle=""
          pickMatter
          recipientKey={selectedKey}
          onClose={() => setNewTask(false)}
        />
      )}
      {adding && <AddAgentCard onClose={() => setAdding(false)} onCreated={() => invalidateRecipients()} />}
      {editing && (
        <EditMattersCard agent={editing} onClose={() => setEditing(null)} onSaved={() => invalidateRecipients()} />
      )}
    </div>
  );
}
