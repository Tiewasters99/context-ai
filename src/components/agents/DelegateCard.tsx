// Delegate… (spec B7): hand the item in front of you to an agent.
//
// The card lists only the agents whose granted matters cover this item's
// matter (a grant covers its sub-matters; a SecureSpace is never covered).
// Creating the task attaches the item, so the agent can open it with the
// ordinary MCP tools once it claims the task.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Send } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAgentsForMatter } from '@/hooks/useAgentTokens';
import { agentLabel, providerLabel } from '@/lib/agentTokens';
import { AGENTS_MIGRATION_MESSAGE, createTask, isAgentsNotReady, type TaskRef } from '@/lib/agentTasks';
import AgentCard, { cardField, cardLegend } from './AgentCard';

export const NO_AGENT_COPY = 'No agent can see this matter — grant one under Connections → Agents.';
export const SEALED_NO_AGENT_COPY =
  'This matter is in a SecureSpace. No outside agent can see it, and no grant changes that.';

export const MATTER_TASKS_KEY = (matterId: string) => ['agent_tasks', 'matter', matterId] as const;

/** A due date picked as a day means the end of that day, local time. */
function dueIso(day: string): string | null {
  if (!day) return null;
  const d = new Date(`${day}T23:59:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export default function DelegateCard({
  matterId,
  attachment,
  defaultTitle,
  onClose,
}: {
  matterId: string;
  /** The item being delegated; null for a task with nothing attached. */
  attachment: TaskRef | null;
  defaultTitle: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { eligible, sealed, loading, notReady, error: loadError } = useAgentsForMatter(matterId);
  const [title, setTitle] = useState(defaultTitle);
  const [instructions, setInstructions] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const chosen = tokenId || eligible[0]?.id || '';
  const canSend = !notReady && !sealed && eligible.length > 0 && !!chosen && !!title.trim() && !busy;

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      await createTask({
        matterId,
        tokenId: chosen,
        title,
        instructions,
        attachments: attachment ? [attachment] : [],
        dueAt: dueIso(due),
      });
      void qc.invalidateQueries({ queryKey: MATTER_TASKS_KEY(matterId) });
      const a = eligible.find((x) => x.id === chosen);
      setSentTo(a ? agentLabel(a) : 'the agent');
    } catch (e) {
      setError(isAgentsNotReady(e) ? AGENTS_MIGRATION_MESSAGE : e instanceof Error ? e.message : 'Could not delegate.');
    } finally {
      setBusy(false);
    }
  };

  const tasksHref = `/app/matterspace/${matterId}?tab=Tasks`;

  if (sentTo) {
    return (
      <AgentCard
        storageKey="cs.agents.delegate"
        title="Delegated"
        onClose={onClose}
        footer={
          <button
            onClick={onClose}
            className="ml-auto px-3.5 py-1.5 rounded-md bg-[#f0c850] hover:bg-[#f5d565] text-[#0e0e12] text-[12px] font-bold"
          >
            Done
          </button>
        }
      >
        <p className="text-[13px] text-white/80 leading-relaxed">
          The task is on {sentTo}'s board. It is picked up the next time the agent checks for
          work. Its questions and its result appear on the matter's Tasks tab.
        </p>
        <Link to={tasksHref} onClick={onClose} className="inline-block text-[12px] text-[#e8b84a] hover:underline">
          Open the matter's Tasks →
        </Link>
      </AgentCard>
    );
  }

  let body;
  if (loading) {
    body = <p className="text-[12px] text-white/40 italic">Reading your agents…</p>;
  } else if (notReady) {
    body = <p className="text-[13px] text-white/70">{AGENTS_MIGRATION_MESSAGE}</p>;
  } else if (loadError) {
    body = <p className="text-[13px] text-red-300">{loadError}</p>;
  } else if (sealed) {
    body = <p className="text-[13px] text-white/70">{SEALED_NO_AGENT_COPY}</p>;
  } else if (eligible.length === 0) {
    body = (
      <p className="text-[13px] text-white/70 leading-relaxed">
        No agent can see this matter — grant one under{' '}
        <Link to="/app/connections#agents" onClick={onClose} className="text-[#e8b84a] hover:underline">
          Connections → Agents
        </Link>
        .
      </p>
    );
  } else {
    body = (
      <>
        <div>
          <p className={cardLegend}>Task</p>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={cardField} autoFocus />
        </div>
        <div>
          <p className={cardLegend}>Instructions</p>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={6}
            placeholder="What you want done, what to produce, and where to file it."
            className={`${cardField} leading-relaxed resize-y`}
          />
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="flex-1 min-w-[200px]">
            <p className={cardLegend}>Agent</p>
            <select value={chosen} onChange={(e) => setTokenId(e.target.value)} className={cardField}>
              {eligible.map((a) => (
                <option key={a.id} value={a.id}>
                  {agentLabel(a)} ({providerLabel(a.agent_provider)})
                </option>
              ))}
            </select>
          </div>
          <div>
            <p className={cardLegend}>Due (optional)</p>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={cardField} />
          </div>
        </div>
        {attachment && (
          <p className="text-[11.5px] text-white/45">
            Attached: {attachment.label || 'this item'}
          </p>
        )}
        <p className="text-[11px] text-white/35 leading-relaxed">
          Only agents that can see this matter are listed.
        </p>
      </>
    );
  }

  return (
    <AgentCard
      storageKey="cs.agents.delegate"
      title="Delegate…"
      subtitle="Hand this to an agent. It works inside this matter and posts its result back here."
      onClose={onClose}
      footer={
        <>
          {error && <p className="flex-1 text-[12px] text-red-300">{error}</p>}
          <button
            onClick={onClose}
            disabled={busy}
            className="ml-auto px-3 py-1.5 rounded-md border border-[rgba(255,255,255,0.12)] text-[12px] text-white/60 hover:text-white"
          >
            {canSend || busy ? 'Cancel' : 'Close'}
          </button>
          {!notReady && !sealed && eligible.length > 0 && (
            <button
              onClick={() => void send()}
              disabled={!canSend}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-[#f0c850] hover:bg-[#f5d565] text-[#0e0e12] text-[12px] font-bold disabled:opacity-40"
            >
              <Send size={12} />
              {busy ? 'Delegating…' : 'Delegate'}
            </button>
          )}
        </>
      }
    >
      {body}
    </AgentCard>
  );
}
