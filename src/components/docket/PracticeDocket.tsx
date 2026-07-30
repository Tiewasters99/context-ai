// The Practice Docket — every working thread as one quiet, linear sheet.
// Level 0: one row per thread (thread · where it stands · next step ·
// due · waiting on), deadline-first. Level 1: expand a row to its docket
// sheet — inline state editing plus a dated chronology merged from the
// ledger, the activity feed, and the calendar, PACER-style. Typed notes
// are the signal (gold, first-class); system events are the record.
// Deliberately refuses Notion-ness: one fixed schema, no configuration.

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight, CalendarClock, ChevronDown, ChevronRight, Pencil, Plus, Zap,
} from 'lucide-react';
import { runInAssistant } from '@/lib/assistant-bus';
import {
  useDocket, useSetMatterState, useDocketSheet, addDocketNote,
  STATUS_COLORS, type DocketRow, type DocketStatus,
} from '@/hooks/useDocket';
import { createMatterEvent, useMatterEventsInvalidate } from '@/hooks/useMatterEvents';

const STATUSES: DocketStatus[] = ['active', 'urgent', 'waiting', 'dormant', 'archived'];

const todayStr = () => new Date().toISOString().slice(0, 10);

function formatDue(dateStr: string): { label: string; overdue: boolean } {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return { label, overdue: dateStr < todayStr() };
}

function formatEntryDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function PracticeDocket() {
  const { docket, undocketed, isLoading, error } = useDocket();
  const [openId, setOpenId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  if (isLoading) {
    return <p className="text-[12px] text-white/40">Loading the docket…</p>;
  }
  if (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return (
      <p className="text-[12px] text-white/50">
        {/get_matter_map/.test(msg)
          ? 'The docket needs migration 042/043 — run it in the Supabase SQL editor.'
          : `The docket could not load: ${msg}`}
      </p>
    );
  }

  return (
    // select-text overrides the draggable dashboard card's select-none:
    // docket text must be highlightable — a selection becomes a command.
    <div ref={rootRef} className="select-text">
      <SelectionRunChip container={rootRef} />
      {docket.length === 0 ? (
        <p className="text-[13px] text-white/40 leading-relaxed">
          The docket is empty. Threads appear when a matter is given a state —
          add one below, or let an agent file it via <code className="text-[12px]">set_matter_state</code>.
        </p>
      ) : (
        <div className="rounded-lg border border-[rgba(255,255,255,0.14)] bg-[rgba(10,10,16,0.72)] backdrop-blur-[20px] overflow-hidden">
          {/* Header row — desktop only */}
          <div className="hidden md:grid grid-cols-[minmax(0,1.05fr)_minmax(0,1.5fr)_minmax(0,1.1fr)_64px_84px] gap-3 px-4 py-2 border-b border-[rgba(255,255,255,0.08)] text-[10px] font-semibold uppercase tracking-wider text-[#8a8693]">
          <span>Thread</span>
            <span>Where it stands</span>
            <span>Next step</span>
            <span>Due</span>
            <span>Waiting on</span>
          </div>
          {docket.map((row) => (
            <DocketRowView
              key={row.id}
              row={row}
              open={openId === row.id}
              onToggle={() => setOpenId(openId === row.id ? null : row.id)}
            />
          ))}
        </div>
      )}
      <AddThread undocketed={undocketed} />
    </div>
  );
}

function DocketRowView({ row, open, onToggle }: { row: DocketRow; open: boolean; onToggle: () => void }) {
  const due = row.next_deadline ? formatDue(row.next_deadline) : null;
  const dot = (
    <span
      className="w-1.5 h-1.5 rounded-full shrink-0"
      style={{ backgroundColor: STATUS_COLORS[row.status] }}
      title={row.status}
    />
  );
  const chevron = open
    ? <ChevronDown size={13} strokeWidth={2.5} className="text-[#e8b84a]/80 shrink-0" />
    : <ChevronRight size={13} strokeWidth={2.5} className="text-white/30 shrink-0" />;

  // The row is a div, not a <button>: buttons suppress text selection, and
  // highlighted docket text is a command. The click guard below keeps a
  // text-selection drag from toggling the row.
  const guardedToggle = () => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    onToggle();
  };

  return (
    <div
      className="border-t first:border-t-0 border-[rgba(255,255,255,0.06)]"
      data-matter-id={row.id}
      data-matter-name={row.name}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={guardedToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        className={`w-full text-left px-4 py-2.5 cursor-pointer hover:bg-[rgba(255,255,255,0.04)] transition-colors ${open ? 'bg-[rgba(255,255,255,0.03)]' : ''}`}
      >
        {/* Desktop: 5 columns */}
        <div className="hidden md:grid grid-cols-[minmax(0,1.05fr)_minmax(0,1.5fr)_minmax(0,1.1fr)_64px_84px] gap-3 items-baseline">
          <span className="flex items-center gap-2 min-w-0">
            {chevron}{dot}
            <span className="text-[13px] font-medium text-[#f5f1e8] truncate">{row.name}</span>
          </span>
          <span className={`text-[12.5px] truncate ${row.headline ? 'text-white/75' : 'text-white/30 italic'}`}>
            {row.headline ?? 'no headline'}
          </span>
          <span className="text-[12.5px] text-white/65 truncate">
            {row.next_action ?? '—'}
            {row.next_action_owner && (
              <span className="text-[#d4a054]/90"> · {row.next_action_owner}</span>
            )}
          </span>
          <span className="text-[12px]">
            {row.overdue_count > 0 ? (
              <span className="text-[#f87171] font-medium">{row.overdue_count} over</span>
            ) : due ? (
              <span className={due.overdue ? 'text-[#f87171]' : 'text-white/70'}>{due.label}</span>
            ) : (
              <span className="text-white/25">—</span>
            )}
          </span>
          <span className="text-[12px] text-white/50 truncate">{row.waiting_on ?? '—'}</span>
        </div>
        {/* Phone: two lines */}
        <div className="md:hidden">
          <div className="flex items-center gap-2 min-w-0">
            {chevron}{dot}
            <span className="text-[13px] font-medium text-[#f5f1e8] truncate flex-1">{row.name}</span>
            {row.overdue_count > 0 ? (
              <span className="text-[11px] text-[#f87171] font-medium shrink-0">{row.overdue_count} overdue</span>
            ) : due ? (
              <span className="text-[11px] text-white/60 shrink-0">{due.label}</span>
            ) : null}
          </div>
          <p className={`mt-0.5 ml-[26px] text-[12px] truncate ${row.headline ? 'text-white/60' : 'text-white/25 italic'}`}>
            {row.headline ?? 'no headline'}
          </p>
        </div>
      </div>
      {open && <DocketSheet row={row} />}
    </div>
  );
}

// ── Level 1: the thread's docket sheet ───────────────────────────────────
function DocketSheet({ row }: { row: DocketRow }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: entries = [], isLoading } = useDocketSheet(row.id);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submitNote = async () => {
    const text = note.trim();
    if (!text || noteBusy) return;
    setNoteBusy(true);
    setErr(null);
    try {
      await addDocketNote(row.id, text);
      setNote('');
      qc.invalidateQueries({ queryKey: ['docket_sheet', row.id] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setNoteBusy(false);
    }
  };

  return (
    <div className="px-4 pb-4 pt-1 md:pl-[42px] border-t border-[rgba(255,255,255,0.04)]">
      {/* Full state + actions */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-[12.5px] leading-relaxed">
          {row.headline && <p className="text-[#f5f1e8]">{row.headline}</p>}
          {row.next_action && (
            <p className="text-white/65">
              Next: {row.next_action}
              {row.next_action_owner && <span className="text-[#d4a054]/90"> — {row.next_action_owner}</span>}
              <button
                onClick={() => runInAssistant({ prompt: row.next_action!, matterId: row.id, matterName: row.name })}
                title="Run this step with the Orchestrator"
                className="inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 rounded text-[10.5px] font-medium text-[#e8b84a] bg-[rgba(212,160,84,0.12)] hover:bg-[rgba(212,160,84,0.22)] transition-colors align-middle"
              >
                <Zap size={10} strokeWidth={2.5} /> Run
              </button>
            </p>
          )}
          {row.waiting_on && <p className="text-white/50">Waiting on {row.waiting_on}</p>}
          {row.next_deadline && (
            <p className="flex items-center gap-1.5 text-white/65">
              <CalendarClock size={12} className="text-[#d4a054]" strokeWidth={1.75} />
              {formatDue(row.next_deadline).label}
              {row.next_deadline_label && ` — ${row.next_deadline_label}`}
            </p>
          )}
          <p className="text-[11px] text-white/35 mt-1">
            {row.serverspace_name} · {row.doc_count} doc{row.doc_count === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => setEditing((v) => !v)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11.5px] transition-colors ${
              editing ? 'text-[#e8b84a] bg-[rgba(212,160,84,0.12)]' : 'text-white/60 hover:text-white hover:bg-[rgba(255,255,255,0.06)]'
            }`}
          >
            <Pencil size={11} strokeWidth={1.75} /> Edit
          </button>
          <button
            onClick={() => navigate(`/app/matterspace/${row.id}`)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11.5px] font-medium text-[#e8b84a] bg-[rgba(212,160,84,0.12)] hover:bg-[rgba(212,160,84,0.2)] transition-colors"
          >
            Enter <ArrowUpRight size={11} strokeWidth={2} />
          </button>
        </div>
      </div>

      {editing && <StateEditor row={row} onDone={() => setEditing(false)} />}

      {/* Add a docket entry — the signal layer */}
      <div className="flex gap-2 mt-3">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submitNote(); }}
          placeholder="Add a docket entry…"
          className="flex-1 px-2.5 py-1.5 rounded-md bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.1)] text-[12.5px] text-[#f5f1e8] placeholder:text-white/25 focus:outline-none focus:border-[rgba(232,184,74,0.5)] transition-colors"
        />
        <button
          onClick={submitNote}
          disabled={!note.trim() || noteBusy}
          className="px-3 py-1.5 rounded-md text-[12px] font-medium text-[#e8b84a] bg-[rgba(212,160,84,0.12)] hover:bg-[rgba(212,160,84,0.2)] disabled:opacity-35 transition-colors"
        >
          File
        </button>
      </div>
      {err && <p className="text-[11.5px] text-[#f87171] mt-1.5">{err}</p>}

      {/* Chronology — notes gold (signal), system entries muted (record) */}
      <div className="mt-3 max-h-64 overflow-y-auto pr-1">
        {isLoading && <p className="text-[11.5px] text-white/35">Loading chronology…</p>}
        {!isLoading && entries.length === 0 && (
          <p className="text-[11.5px] text-white/35">No entries yet.</p>
        )}
        {entries.map((e, i) => (
          <div key={i} className="flex gap-2.5 py-1 items-baseline">
            <span className="w-[46px] shrink-0 text-[11px] text-white/40 tabular-nums">
              {formatEntryDate(e.occurred_at)}
            </span>
            <span
              className={`w-1 h-1 rounded-full shrink-0 relative top-[-2px] ${
                e.kind === 'note' ? 'bg-[#e8b84a]' : 'bg-white/25'
              }`}
            />
            {e.link ? (
              <button
                onClick={() => navigate(e.link!)}
                className={`text-[12px] leading-snug min-w-0 text-left hover:text-[#e8b84a] underline-offset-2 hover:underline transition-colors ${
                  e.kind === 'note' ? 'text-[#f5f1e8]' : 'text-white/55'
                }`}
              >
                {e.text}
              </button>
            ) : (
              <span className={`text-[12px] leading-snug min-w-0 ${
                e.kind === 'note' ? 'text-[#f5f1e8]' : 'text-white/55'
              }`}>
                {e.text}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function StateEditor({ row, onDone }: { row: DocketRow; onDone: () => void }) {
  const setState = useSetMatterState();
  const invalidateEvents = useMatterEventsInvalidate();
  const qc = useQueryClient();
  const [status, setStatus] = useState<DocketStatus>(row.status);
  const [headline, setHeadline] = useState(row.headline ?? '');
  const [nextAction, setNextAction] = useState(row.next_action ?? '');
  const [owner, setOwner] = useState(row.next_action_owner ?? '');
  const [waiting, setWaiting] = useState(row.waiting_on ?? '');
  const [dlDate, setDlDate] = useState('');
  const [dlLabel, setDlLabel] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setErr(null);
    const diff = (val: string, orig: string | null | undefined) =>
      val === (orig ?? '') ? undefined : val;
    try {
      await setState.mutateAsync({
        matterId: row.id,
        patch: {
          status: status === row.status ? undefined : status,
          headline: diff(headline.trim(), row.headline),
          next_action: diff(nextAction.trim(), row.next_action),
          next_action_owner: diff(owner.trim(), row.next_action_owner),
          waiting_on: diff(waiting.trim(), row.waiting_on),
        },
      });
      if (dlDate) {
        await createMatterEvent({
          matterspace_id: row.id,
          title: dlLabel.trim() || 'Deadline',
          event_date: dlDate,
          event_time: null,
          event_type: 'deadline',
          notes: null,
        });
        invalidateEvents();
      }
      qc.invalidateQueries({ queryKey: ['docket_sheet', row.id] });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const field = 'w-full px-2.5 py-1.5 rounded-md bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.12)] text-[12.5px] text-[#f5f1e8] placeholder:text-white/25 focus:outline-none focus:border-[rgba(232,184,74,0.5)] transition-colors';
  const label = 'block text-[10px] font-medium text-[#8a8693] uppercase tracking-wider mb-1';

  return (
    <div className="mt-3 p-3 rounded-lg border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.02)] space-y-3">
      <div>
        <span className={label}>Status</span>
        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-2 py-0.5 rounded-full text-[11.5px] border transition-colors ${
                status === s
                  ? 'border-[rgba(232,184,74,0.6)] text-[#e8b84a] bg-[rgba(212,160,84,0.1)]'
                  : 'border-[rgba(255,255,255,0.12)] text-white/50 hover:text-white'
              }`}
            >
              <span className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle" style={{ backgroundColor: STATUS_COLORS[s] }} />
              {s}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className={label}>Where it stands</span>
        <input className={field} value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="One line — where things stand" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[1fr_110px_110px] gap-2">
        <div>
          <span className={label}>Next step</span>
          <input className={field} value={nextAction} onChange={(e) => setNextAction(e.target.value)} />
        </div>
        <div>
          <span className={label}>Owner</span>
          <input className={field} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Eden / Fable" />
        </div>
        <div>
          <span className={label}>Waiting on</span>
          <input className={field} value={waiting} onChange={(e) => setWaiting(e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-[125px_1fr] gap-2">
        <div>
          <span className={label}>New deadline</span>
          <input type="date" className={field} value={dlDate} onChange={(e) => setDlDate(e.target.value)} />
        </div>
        <div>
          <span className={label}>What's due</span>
          <input className={field} value={dlLabel} onChange={(e) => setDlLabel(e.target.value)} placeholder="Optional — filed to the calendar" />
        </div>
      </div>
      {err && <p className="text-[11.5px] text-[#f87171]">{err}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onDone} className="px-3 py-1 rounded-md text-[12px] text-white/55 hover:text-white transition-colors">
          Cancel
        </button>
        <button
          onClick={save}
          disabled={setState.isPending}
          className="px-3.5 py-1 rounded-md text-[12px] font-semibold text-[#0a0a10] bg-[#d4a054] hover:bg-[#e8b84a] disabled:opacity-50 transition-colors"
        >
          {setState.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ── Highlight-to-command: select any docket text and a Run chip floats
//    above the selection; clicking hands the selection to the Orchestrator
//    as a command, scoped to the matter the text belongs to. The docket's
//    entries are dynamic — an instruction like "find screenplay" executes,
//    it doesn't just sit there as a reminder. ──────────────────────────────
function SelectionRunChip({ container }: { container: React.RefObject<HTMLDivElement | null> }) {
  const [chip, setChip] = useState<{
    x: number; y: number; text: string; matterId?: string; matterName?: string;
  } | null>(null);

  useEffect(() => {
    let timer = 0;
    const update = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const sel = window.getSelection();
        const root = container.current;
        if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !root) { setChip(null); return; }
        const text = sel.toString().trim();
        if (!text || text.length > 600) { setChip(null); return; }
        const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
        if (!anchor || !root.contains(anchor)) { setChip(null); return; }
        const holder = anchor.closest('[data-matter-id]');
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        setChip({
          x: Math.min(Math.max(rect.left + rect.width / 2, 56), window.innerWidth - 56),
          y: Math.max(rect.top - 36, 8),
          text,
          matterId: holder?.getAttribute('data-matter-id') ?? undefined,
          matterName: holder?.getAttribute('data-matter-name') ?? undefined,
        });
      }, 140);
    };
    document.addEventListener('selectionchange', update);
    return () => {
      document.removeEventListener('selectionchange', update);
      window.clearTimeout(timer);
    };
  }, [container]);

  if (!chip) return null;
  return (
    <button
      style={{ position: 'fixed', left: chip.x, top: chip.y, transform: 'translateX(-50%)', zIndex: 60 }}
      // preventDefault on mousedown so clicking the chip doesn't collapse
      // the selection before the click handler reads it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        runInAssistant({ prompt: chip.text, matterId: chip.matterId, matterName: chip.matterName });
        window.getSelection()?.removeAllRanges();
        setChip(null);
      }}
      className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11.5px] font-semibold text-[#0a0a10] bg-[#e8b84a] shadow-lg shadow-black/50 hover:bg-[#f5d565] transition-colors"
    >
      <Zap size={11} strokeWidth={2.5} /> Run
    </button>
  );
}

// ── Put an existing matter on the docket ─────────────────────────────────
function AddThread({ undocketed }: { undocketed: DocketRow[] }) {
  const setState = useSetMatterState();
  const [picking, setPicking] = useState(false);
  const [choice, setChoice] = useState('');

  if (undocketed.length === 0) return null;

  if (!picking) {
    return (
      <button
        onClick={() => setPicking(true)}
        className="flex items-center gap-1.5 mt-2 px-1 text-[12px] text-white/45 hover:text-[#e8b84a] transition-colors"
      >
        <Plus size={12} strokeWidth={2} /> Add a thread
      </button>
    );
  }

  const bySpace = new Map<string, DocketRow[]>();
  for (const r of undocketed) {
    (bySpace.get(r.serverspace_name) ?? bySpace.set(r.serverspace_name, []).get(r.serverspace_name)!).push(r);
  }

  return (
    <div className="flex gap-2 mt-2 items-center">
      <select
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
        className="flex-1 px-2 py-1.5 rounded-md bg-[rgba(20,20,30,0.9)] border border-[rgba(255,255,255,0.12)] text-[12.5px] text-[#f5f1e8] focus:outline-none focus:border-[rgba(232,184,74,0.5)]"
      >
        <option value="">Choose a matter…</option>
        {[...bySpace.entries()].map(([space, rows]) => (
          <optgroup key={space} label={space}>
            {rows.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <button
        onClick={async () => {
          if (!choice) return;
          await setState.mutateAsync({ matterId: choice, patch: { status: 'active' } });
          setChoice('');
          setPicking(false);
        }}
        disabled={!choice || setState.isPending}
        className="px-3 py-1.5 rounded-md text-[12px] font-medium text-[#e8b84a] bg-[rgba(212,160,84,0.12)] hover:bg-[rgba(212,160,84,0.2)] disabled:opacity-35 transition-colors"
      >
        {setState.isPending ? 'Adding…' : 'Add'}
      </button>
      <button onClick={() => setPicking(false)} className="px-2 py-1.5 text-[12px] text-white/45 hover:text-white transition-colors">
        Cancel
      </button>
    </div>
  );
}
