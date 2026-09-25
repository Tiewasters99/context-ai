// Delegate… / New task: hand work to any connected AI (spec B7; migration 089).
//
// One card for every way in:
//   * Delegate… on a document, list, page or calendar entry — the matter and
//     the attachment are fixed by the item;
//   * New task on a matter's Tasks tab — the matter is fixed, nothing attached;
//   * New task on the Agents page — choose the matter (sealed ones cannot be
//     chosen), optionally an item from it, and the recipient (preselected
//     when the page has one selected).
//
// Recipients, grouped: "Agents" (live agents whose matters cover this one)
// and "Assistants you chat with" (full-access tokens and full-assistant
// sign-ins; they see every matter their user sees, except SecureSpaces). A
// sealed matter has no recipient at all: the seal hides it from every
// connector. Every task lives on the Agents page; the card says so.

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Send } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useRecipientsForMatter } from '@/hooks/useTaskRecipients';
import {
  AGENTS_MIGRATION_MESSAGE, INSTRUCTIONS_MAX, TITLE_MAX, createTask, isAgentsNotReady, type TaskRef,
} from '@/lib/agentTasks';
import {
  AGENTS_PAGE_PATH, CHAT_ASSISTANT_NOTE, GROUP_LABEL, OPEN_IN_AGENTS, recipientLabel, refOf,
} from '@/lib/task-recipients';
import { ALL_TASKS_KEY, MATTER_TASKS_KEY } from '@/lib/task-ui';
import AgentCard, { cardField, cardLegend } from './AgentCard';
import MatterSelect from './MatterSelect';

export const NO_RECIPIENT_COPY =
  'No connected AI can see this matter — connect one, or grant an agent, under Connections.';
export const SEALED_NO_AGENT_COPY =
  'This matter is in a SecureSpace. No connected AI can see it, and no grant changes that.';
export const TASKS_LIVE_IN_AGENTS = 'Every task, in every matter, is on the Agents page.';

/** A due date picked as a day means the end of that day, local time. */
function dueIso(day: string): string | null {
  if (!day) return null;
  const d = new Date(`${day}T23:59:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The items in a matter that can go with a task (documents, lists/pages, calendar entries). */
function useMatterItems(matterId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['agent_task_items', matterId],
    enabled: enabled && !!matterId,
    staleTime: 30_000,
    queryFn: async (): Promise<{ key: string; ref: TaskRef; group: string }[]> => {
      const [docs, items, events] = await Promise.all([
        supabase.from('documents').select('id, title').eq('matterspace_id', matterId)
          .order('title', { ascending: true }).limit(300),
        supabase.from('content_items').select('id, title, content_type').eq('space_id', matterId)
          .eq('space_type', 'matterspace').order('title', { ascending: true }).limit(200),
        supabase.from('calendar_events').select('id, title, start_date').eq('matterspace_id', matterId)
          .order('start_date', { ascending: false }).limit(100),
      ]);
      const out: { key: string; ref: TaskRef; group: string }[] = [];
      for (const d of (docs.data ?? []) as { id: string; title: string | null }[]) {
        out.push({ key: `document:${d.id}`, group: 'Documents', ref: { kind: 'document', id: d.id, label: d.title || 'Untitled document' } });
      }
      for (const c of (items.data ?? []) as { id: string; title: string | null; content_type: string | null }[]) {
        out.push({ key: `content_item:${c.id}`, group: 'Lists and pages', ref: { kind: 'content_item', id: c.id, label: c.title || 'Untitled' } });
      }
      for (const e of (events.data ?? []) as { id: string; title: string | null; start_date: string | null }[]) {
        const label = `${e.title || 'Calendar entry'}${e.start_date ? ` (${e.start_date})` : ''}`;
        out.push({ key: `calendar_event:${e.id}`, group: 'Calendar', ref: { kind: 'calendar_event', id: e.id, label } });
      }
      return out;
    },
  });
}

export default function DelegateCard({
  matterId: fixedMatterId,
  attachment,
  defaultTitle,
  onClose,
  pickMatter = false,
  recipientKey: preselect = null,
}: {
  /** The item's matter. With pickMatter, only the starting choice (may be null). */
  matterId: string | null;
  /** The item being delegated; null for a task with nothing attached. */
  attachment: TaskRef | null;
  defaultTitle: string;
  onClose: () => void;
  /** The Agents page: choose the matter and, optionally, an item from it. */
  pickMatter?: boolean;
  /** Preselect this recipient ('token:<id>' / 'grant:<id>') when it can see the matter. */
  recipientKey?: string | null;
}) {
  const qc = useQueryClient();
  const [matterId, setMatterId] = useState(fixedMatterId ?? '');
  const { agents, assistants, sealed, loading, notReady, error: loadError, byKey } = useRecipientsForMatter(matterId || null);
  const [title, setTitle] = useState(defaultTitle.slice(0, TITLE_MAX));
  const [instructions, setInstructions] = useState('');
  const [picked, setPicked] = useState<string>(preselect ?? '');
  const [itemKey, setItemKey] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ name: string; chat: boolean } | null>(null);

  const eligible = useMemo(() => [...agents, ...assistants], [agents, assistants]);
  const chosen = eligible.find((r) => r.key === picked) ?? eligible[0] ?? null;
  const preselectBlocked = !!preselect && !!matterId && !eligible.some((r) => r.key === preselect);
  const items = useMatterItems(matterId, pickMatter);
  const pickedItem = items.data?.find((i) => i.key === itemKey)?.ref ?? null;
  const theAttachment = pickMatter ? pickedItem : attachment;

  const canSend = !notReady && !!matterId && !sealed && !!chosen && !!title.trim() && !busy;

  const send = async () => {
    if (!canSend || !chosen) return;
    setBusy(true);
    setError(null);
    try {
      await createTask({
        matterId,
        recipient: refOf(chosen),
        chatAssistant: chosen.kind !== 'agent',
        title,
        instructions,
        attachments: theAttachment ? [theAttachment] : [],
        dueAt: dueIso(due),
      });
      void qc.invalidateQueries({ queryKey: MATTER_TASKS_KEY(matterId) });
      void qc.invalidateQueries({ queryKey: ALL_TASKS_KEY });
      setSent({ name: recipientLabel(chosen), chat: chosen.kind !== 'agent' });
    } catch (e) {
      setError(isAgentsNotReady(e) ? AGENTS_MIGRATION_MESSAGE : e instanceof Error ? e.message : 'Could not delegate.');
    } finally {
      setBusy(false);
    }
  };

  const agentsHref = chosen ? `${AGENTS_PAGE_PATH}?to=${encodeURIComponent(chosen.key)}` : AGENTS_PAGE_PATH;

  if (sent) {
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
          {sent.chat
            ? `The task is on ${sent.name}'s list. ${sent.name} picks it up when you ask it to check its Contextspaces tasks.`
            : `The task is on ${sent.name}'s board. It is picked up the next time the agent checks for work.`}
          {' '}Its questions and its result appear on the Agents page and on the matter's Tasks tab.
        </p>
        <Link to={agentsHref} onClick={onClose} className="inline-block text-[12px] text-[#e8b84a] hover:underline">
          {OPEN_IN_AGENTS}
        </Link>
      </AgentCard>
    );
  }

  const option = (r: (typeof eligible)[number]) => (
    <option key={r.key} value={r.key}>{recipientLabel(r)}</option>
  );

  let recipientBlock;
  if (!matterId) {
    recipientBlock = <p className="text-[12.5px] text-white/50">Choose a matter first.</p>;
  } else if (loading) {
    recipientBlock = <p className="text-[12px] text-white/40 italic">Reading your connected AI…</p>;
  } else if (sealed) {
    recipientBlock = <p className="text-[13px] text-white/70">{SEALED_NO_AGENT_COPY}</p>;
  } else if (eligible.length === 0) {
    recipientBlock = (
      <p className="text-[13px] text-white/70 leading-relaxed">
        No connected AI can see this matter — connect one, or grant an agent, under{' '}
        <Link to="/app/connections" onClick={onClose} className="text-[#e8b84a] hover:underline">
          Connections
        </Link>
        .
      </p>
    );
  } else {
    recipientBlock = (
      <>
        <select value={chosen?.key ?? ''} onChange={(e) => setPicked(e.target.value)} className={cardField} aria-label="Hand it to">
          {agents.length > 0 && <optgroup label={GROUP_LABEL.agents}>{agents.map(option)}</optgroup>}
          {assistants.length > 0 && <optgroup label={GROUP_LABEL.assistants}>{assistants.map(option)}</optgroup>}
        </select>
        {chosen && chosen.kind !== 'agent' && (
          <p className="text-[11.5px] text-white/45 mt-1">{CHAT_ASSISTANT_NOTE}</p>
        )}
        {preselectBlocked && (
          <p className="text-[11.5px] text-white/45 mt-1">
            {byKey.get(preselect ?? '')?.name ?? 'That connection'} cannot see this matter, so it is not offered.
          </p>
        )}
      </>
    );
  }

  const body = notReady ? (
    <p className="text-[13px] text-white/70">{AGENTS_MIGRATION_MESSAGE}</p>
  ) : loadError ? (
    <p className="text-[13px] text-red-300">{loadError}</p>
  ) : (
    <>
      {pickMatter && (
        <div className="flex flex-wrap gap-3">
          <div className="flex-1 min-w-[200px]">
            <p className={cardLegend}>Matter</p>
            <MatterSelect value={matterId} onChange={(id) => { setMatterId(id); setItemKey(''); }} />
          </div>
          <div className="flex-1 min-w-[200px]">
            <p className={cardLegend}>Attach (optional)</p>
            <select
              value={itemKey}
              onChange={(e) => setItemKey(e.target.value)}
              disabled={!matterId || sealed}
              className={cardField}
              aria-label="Attach an item"
            >
              <option value="">{items.isLoading ? 'Reading the matter…' : 'Nothing attached'}</option>
              {['Documents', 'Lists and pages', 'Calendar'].map((g) => {
                const inGroup = (items.data ?? []).filter((i) => i.group === g);
                return inGroup.length === 0 ? null : (
                  <optgroup key={g} label={g}>
                    {inGroup.map((i) => <option key={i.key} value={i.key}>{i.ref.label}</option>)}
                  </optgroup>
                );
              })}
            </select>
          </div>
        </div>
      )}
      <div>
        <p className={cardLegend}>Hand it to</p>
        {recipientBlock}
      </div>
      <div>
        <p className={cardLegend}>Task</p>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={TITLE_MAX}
          placeholder="A short title"
          className={cardField}
          autoFocus={!pickMatter}
        />
      </div>
      <div>
        <p className={cardLegend}>Instructions</p>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={6}
          maxLength={INSTRUCTIONS_MAX}
          placeholder="What you want done, what to produce, and where to file it."
          className={`${cardField} leading-relaxed resize-y`}
        />
        {instructions.length > INSTRUCTIONS_MAX * 0.9 && (
          <p className="text-[11px] text-white/40 mt-1">
            {instructions.length.toLocaleString()} of {INSTRUCTIONS_MAX.toLocaleString()} characters
          </p>
        )}
      </div>
      <div>
        <p className={cardLegend}>Due (optional)</p>
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={cardField} />
      </div>
      {!pickMatter && attachment && (
        <p className="text-[11.5px] text-white/45">Attached: {attachment.label || 'this item'}</p>
      )}
      <p className="text-[11px] text-white/35 leading-relaxed">
        Only your own connections that can see this matter are listed. {TASKS_LIVE_IN_AGENTS}{' '}
        <Link to={AGENTS_PAGE_PATH} onClick={onClose} className="text-[#e8b84a] hover:underline">{OPEN_IN_AGENTS}</Link>
      </p>
    </>
  );

  return (
    <AgentCard
      storageKey="cs.agents.delegate"
      title={pickMatter ? 'New task' : 'Delegate…'}
      subtitle="Hand this to a connected AI. It works inside the matter and posts its result back."
      onClose={onClose}
      footer={
        <>
          {error && <p className="flex-1 text-[12px] text-red-300">{error}</p>}
          <button
            onClick={onClose}
            disabled={busy}
            className="ml-auto px-3 py-1.5 rounded-md border border-[rgba(255,255,255,0.12)] text-[12px] text-white/60 hover:text-white"
          >
            Cancel
          </button>
          {!notReady && (
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
