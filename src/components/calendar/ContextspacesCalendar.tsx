// The Contextspaces calendar — one component, used everywhere a calendar
// opens: the matter Calendar tab, the standalone /app/calendar page, and
// the overlay a list opens from its header.
//
// Register (per the house rule that work surfaces are a docket, not a
// spectacle): a plain month grid, a plain week strip, and a plain agenda
// sheet. Entries are single lines with a coloured rule down the left, not
// blocks. Nothing animates. The editor is an inline panel, not a modal
// pinned to the middle of the screen.
//
// Everything it draws comes from useCalendarFeed — calendar entries,
// matter deadlines, and list-item due dates in one merged list.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarDays, ChevronLeft, ChevronRight, Download, ExternalLink,
  ListChecks, Plus, Trash2, X,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useServerspaces } from '@/hooks/useServerspaces';
import {
  createCalendarEvent, deleteCalendarEvent, updateCalendarEvent,
  useCalendarFeed, useCalendarInvalidate, todayStr,
  STORAGE_OFF_MESSAGE,
  type CalendarEntry, type CalendarEventType,
} from '@/hooks/useCalendarEvents';
import { deleteMatterEvent, updateMatterEvent, type MatterEventType } from '@/hooks/useMatterEvents';

// ── date helpers: local days, kept as YYYY-MM-DD strings throughout ───

const pad = (n: number) => String(n).padStart(2, '0');
const toKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (s: string, n: number) => {
  const d = fromKey(s);
  d.setDate(d.getDate() + n);
  return toKey(d);
};
const addMonths = (s: string, n: number) => {
  const d = fromKey(s);
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  return toKey(d);
};
const startOfWeek = (s: string) => addDays(s, -fromKey(s).getDay());

const monthTitle = (s: string) =>
  fromKey(s).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const dayTitle = (s: string) =>
  fromKey(s).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const shortDay = (s: string) =>
  fromKey(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

function formatTime(t: string | null): string {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Every local day an entry occupies, so multi-day entries appear on each. */
function entryDays(e: CalendarEntry): string[] {
  const out = [e.startDate];
  if (!e.endDate || e.endDate <= e.startDate) return out;
  let cur = e.startDate;
  for (let i = 0; i < 60; i++) {
    cur = addDays(cur, 1);
    if (cur > e.endDate) break;
    out.push(cur);
  }
  return out;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const TYPE_OPTIONS: { value: CalendarEventType; label: string }[] = [
  { value: 'event', label: 'Event' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'deadline', label: 'Deadline' },
  { value: 'hearing', label: 'Hearing' },
  { value: 'filing', label: 'Filing' },
  { value: 'reminder', label: 'Reminder' },
  { value: 'other', label: 'Other' },
];

/** The left rule on every entry line, by what the entry is. */
function ruleColor(e: CalendarEntry, today: string): string {
  if (e.done) return '#3f3f46';
  if (e.kind === 'list_due') return e.startDate < today ? '#f87171' : '#8b9dc3';
  if (e.source === 'google') return '#7aa2c8';
  switch (e.eventType) {
    case 'deadline':
    case 'filing':
      return e.startDate < today ? '#f87171' : '#e8b84a';
    case 'hearing':
      return '#d4a054';
    case 'reminder':
      return '#9c8fbc';
    default:
      return '#6f8f7a';
  }
}

const field =
  'w-full px-2.5 py-1.5 rounded-md border border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)] text-[12px] text-white placeholder-white/35 focus:outline-none focus:ring-1 focus:ring-[#e8b84a] focus:border-transparent';
const label = 'text-[10px] uppercase tracking-wider text-white/40 mb-1';

// ── props ────────────────────────────────────────────────────────────

export interface ContextspacesCalendarProps {
  /** Scope every query to one matter (the matter Calendar tab). */
  matterId?: string;
  /** Pre-select this matter on new entries. Defaults to `matterId`. */
  defaultMatterId?: string;
  /** Emphasise entries that came from this list (the list overlay). */
  highlightListId?: string;
  /** Start on this view. */
  initialView?: View;
}

type View = 'month' | 'week' | 'agenda';

interface Draft {
  id: string | null;
  kind: 'calendar' | 'matter_event';
  title: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  allDay: boolean;
  eventType: CalendarEventType;
  matterId: string;
  location: string;
  notes: string;
}

const blankDraft = (date: string, matterId: string): Draft => ({
  id: null,
  kind: 'calendar',
  title: '',
  startDate: date,
  startTime: '',
  endDate: '',
  endTime: '',
  allDay: true,
  eventType: 'event',
  matterId,
  location: '',
  notes: '',
});

// ── the component ────────────────────────────────────────────────────

export default function ContextspacesCalendar({
  matterId,
  defaultMatterId,
  highlightListId,
  initialView = 'month',
}: ContextspacesCalendarProps) {
  const navigate = useNavigate();
  const today = todayStr();
  const { entries, isLoading, error, storageEnabled } = useCalendarFeed(matterId);
  const invalidate = useCalendarInvalidate();
  const { data: serverspaces = [] } = useServerspaces();

  const [view, setView] = useState<View>(initialView);
  const [anchor, setAnchor] = useState(today);      // any day inside the shown period
  const [selected, setSelected] = useState(today);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [importState, setImportState] = useState<
    { status: 'idle' | 'running' | 'done' | 'error'; message: string }
  >({ status: 'idle', message: '' });

  useEffect(() => { setSelected(today); }, [today]);

  // Flat matter list for the picker.
  const matters = useMemo(() => {
    const out: { id: string; label: string }[] = [];
    for (const s of serverspaces) {
      for (const m of s.matterspaces ?? []) {
        out.push({ id: m.id, label: `${s.name} · ${m.name}` });
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [serverspaces]);
  const matterName = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of serverspaces) {
      for (const m of s.matterspaces ?? []) map.set(m.id, m.name);
    }
    return map;
  }, [serverspaces]);

  // date -> entries on that date
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    for (const e of entries) {
      for (const day of entryDays(e)) {
        const arr = map.get(day);
        if (arr) arr.push(e);
        else map.set(day, [e]);
      }
    }
    return map;
  }, [entries]);

  const monthGrid = useMemo(() => {
    const first = anchor.slice(0, 8) + '01';
    let cur = startOfWeek(first);
    const weeks: string[][] = [];
    for (let w = 0; w < 6; w++) {
      const week: string[] = [];
      for (let d = 0; d < 7; d++) { week.push(cur); cur = addDays(cur, 1); }
      weeks.push(week);
    }
    return weeks;
  }, [anchor]);

  const weekDays = useMemo(() => {
    const start = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [anchor]);

  // ── mutations ──────────────────────────────────────────────────────

  const openNew = (date: string) => {
    setFormError(null);
    setDraft(blankDraft(date, defaultMatterId ?? matterId ?? ''));
  };

  const openEdit = (e: CalendarEntry) => {
    if (!e.editable) return;
    setFormError(null);
    setDraft({
      id: e.id,
      kind: e.kind === 'matter_event' ? 'matter_event' : 'calendar',
      title: e.title,
      startDate: e.startDate,
      startTime: e.startTime ?? '',
      endDate: e.endDate ?? '',
      endTime: e.endTime ?? '',
      allDay: !e.startTime,
      eventType: (e.eventType as CalendarEventType) ?? 'event',
      matterId: e.matterId ?? '',
      location: e.location ?? '',
      notes: e.notes ?? '',
    });
  };

  const save = async () => {
    if (!draft) return;
    const title = draft.title.trim();
    if (!title) { setFormError('A title is required.'); return; }
    if (!draft.startDate) { setFormError('A date is required.'); return; }
    if (draft.endDate && draft.endDate < draft.startDate) {
      setFormError('The end date falls before the start date.');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (draft.kind === 'matter_event' && draft.id) {
        // A matter deadline, edited in place in matter_events (025).
        await updateMatterEvent(draft.id, {
          title,
          event_date: draft.startDate,
          event_time: draft.allDay ? null : (draft.startTime || null),
          event_type: (['deadline', 'hearing', 'filing', 'reminder'].includes(draft.eventType)
            ? draft.eventType
            : 'other') as MatterEventType,
          notes: draft.notes.trim() || null,
        });
      } else {
        const payload = {
          title,
          start_date: draft.startDate,
          start_time: draft.allDay ? null : (draft.startTime || null),
          end_date: draft.endDate || null,
          end_time: draft.allDay ? null : (draft.endTime || null),
          event_type: draft.eventType,
          matterspace_id: draft.matterId || null,
          notes: draft.notes.trim() || null,
          location: draft.location.trim() || null,
        };
        if (draft.id) await updateCalendarEvent(draft.id, payload);
        else await createCalendarEvent(payload);
      }
      invalidate();
      setDraft(null);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not save this entry.');
    } finally {
      setSaving(false);
    }
  };

  const removeDraft = async () => {
    if (!draft?.id) return;
    if (!confirm('Delete this entry?')) return;
    setSaving(true);
    try {
      if (draft.kind === 'matter_event') await deleteMatterEvent(draft.id);
      else await deleteCalendarEvent(draft.id);
      invalidate();
      setDraft(null);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not delete this entry.');
    } finally {
      setSaving(false);
    }
  };

  const importGoogle = async () => {
    setImportState({ status: 'running', message: 'Reading your Google Calendar…' });
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const timeZone =
        Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const resp = await fetch('/api/calendar-import', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ provider: 'google', timeZone, days: 180 }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const map: Record<string, string> = {
          calendar_not_connected:
            'No Google Calendar is connected yet. Connect one on the Connections page, then import again.',
          calendar_needs_reconnect:
            'Google needs you to reconnect the calendar. Open Connections and reconnect Google Calendar.',
          calendar_storage_not_enabled: STORAGE_OFF_MESSAGE,
          outlook_not_enabled:
            'Outlook import is not switched on yet.',
        };
        throw new Error(map[body.error] || body.detail || body.error || 'Import failed.');
      }
      invalidate();
      setImportState({
        status: 'done',
        message: `Imported ${body.imported} event${body.imported === 1 ? '' : 's'} from ${body.calendarEmail ?? 'Google Calendar'} (through ${body.to}).`,
      });
    } catch (e) {
      setImportState({
        status: 'error',
        message: e instanceof Error ? e.message : 'Import failed.',
      });
    }
  };

  const openEntry = (e: CalendarEntry) => {
    if (e.kind === 'list_due' && e.link) { navigate(e.link); return; }
    if (e.editable) { openEdit(e); return; }
    if (e.link) window.open(e.link, '_blank', 'noopener');
  };

  // ── header ─────────────────────────────────────────────────────────

  const step = (n: number) =>
    setAnchor(view === 'month' ? addMonths(anchor, n) : addDays(anchor, n * 7));

  const periodTitle =
    view === 'month' ? monthTitle(anchor)
    : view === 'week' ? `${shortDay(weekDays[0])} – ${shortDay(weekDays[6])}`
    : 'Agenda';

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => step(-1)}
            disabled={view === 'agenda'}
            className="p-1.5 rounded-md text-white/50 hover:text-white hover:bg-[rgba(255,255,255,0.06)] disabled:opacity-25 transition-colors"
            title="Previous"
          >
            <ChevronLeft size={15} />
          </button>
          <button
            onClick={() => { setAnchor(today); setSelected(today); }}
            className="px-2.5 py-1 rounded-md text-[11px] text-white/70 hover:text-white hover:bg-[rgba(255,255,255,0.06)] transition-colors"
          >
            Today
          </button>
          <button
            onClick={() => step(1)}
            disabled={view === 'agenda'}
            className="p-1.5 rounded-md text-white/50 hover:text-white hover:bg-[rgba(255,255,255,0.06)] disabled:opacity-25 transition-colors"
            title="Next"
          >
            <ChevronRight size={15} />
          </button>
        </div>

        <h2 className="text-[14px] font-semibold text-[#f5f1e8] tracking-tight mr-auto">
          {periodTitle}
        </h2>

        <div className="flex rounded-md border border-[rgba(255,255,255,0.12)] overflow-hidden">
          {(['month', 'week', 'agenda'] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-2.5 py-1 text-[11px] capitalize transition-colors ${
                view === v
                  ? 'bg-[rgba(255,255,255,0.1)] text-white'
                  : 'text-white/50 hover:text-white'
              }`}
            >
              {v}
            </button>
          ))}
        </div>

        <button
          onClick={importGoogle}
          disabled={importState.status === 'running'}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[rgba(255,255,255,0.14)] text-[11px] text-white/70 hover:text-white hover:bg-[rgba(255,255,255,0.06)] disabled:opacity-40 transition-colors"
          title="Read upcoming events from the connected Google Calendar"
        >
          <Download size={12} />
          {importState.status === 'running' ? 'Importing…' : 'Import from Google'}
        </button>

        <button
          onClick={() => openNew(selected)}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#f0c850] hover:bg-[#f5d565] text-[#0e0e12] text-[11px] font-bold transition-colors"
        >
          <Plus size={12} strokeWidth={2.5} />
          New entry
        </button>
      </div>

      {/* Notices */}
      {!storageEnabled && (
        <p className="text-[11px] text-[#e8b84a] border border-[rgba(232,184,74,0.3)] bg-[rgba(232,184,74,0.06)] rounded-md px-3 py-2">
          {STORAGE_OFF_MESSAGE}
        </p>
      )}
      {importState.status !== 'idle' && importState.status !== 'running' && (
        <p
          className={`flex items-start gap-2 text-[11px] rounded-md px-3 py-2 border ${
            importState.status === 'error'
              ? 'text-red-300 border-red-400/30 bg-red-400/5'
              : 'text-white/60 border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.03)]'
          }`}
        >
          <span className="flex-1">{importState.message}</span>
          <button onClick={() => setImportState({ status: 'idle', message: '' })} className="shrink-0 opacity-60 hover:opacity-100">
            <X size={11} />
          </button>
        </p>
      )}
      {error && (
        <p className="text-[11px] text-red-300 border border-red-400/30 bg-red-400/5 rounded-md px-3 py-2">
          {error.message}
        </p>
      )}

      {/* Editor */}
      {draft && (
        <div className="rounded-lg border border-[rgba(255,255,255,0.16)] bg-[rgba(16,16,26,0.75)] p-3 flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-white/45">
              {draft.id
                ? draft.kind === 'matter_event' ? 'Edit matter deadline' : 'Edit entry'
                : 'New entry'}
            </span>
            <button onClick={() => setDraft(null)} className="p-1 text-white/40 hover:text-white">
              <X size={13} />
            </button>
          </div>

          <input
            autoFocus
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="What is it — e.g. Opposition to motion to compel due"
            className={field}
          />

          <div className="flex flex-wrap gap-2.5">
            <div>
              <div className={label}>Starts</div>
              <div className="flex gap-1.5">
                <input
                  type="date"
                  value={draft.startDate}
                  onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
                  className={field}
                />
                {!draft.allDay && (
                  <input
                    type="time"
                    value={draft.startTime}
                    onChange={(e) => setDraft({ ...draft, startTime: e.target.value })}
                    className={field}
                  />
                )}
              </div>
            </div>
            {draft.kind === 'calendar' && (
              <div>
                <div className={label}>Ends (optional)</div>
                <div className="flex gap-1.5">
                  <input
                    type="date"
                    value={draft.endDate}
                    onChange={(e) => setDraft({ ...draft, endDate: e.target.value })}
                    className={field}
                  />
                  {!draft.allDay && (
                    <input
                      type="time"
                      value={draft.endTime}
                      onChange={(e) => setDraft({ ...draft, endTime: e.target.value })}
                      className={field}
                    />
                  )}
                </div>
              </div>
            )}
            <label className="flex items-end gap-1.5 pb-1.5 text-[11px] text-white/60 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.allDay}
                onChange={(e) => setDraft({ ...draft, allDay: e.target.checked })}
                className="accent-[#e8b84a]"
              />
              All day
            </label>
          </div>

          <div className="flex flex-wrap gap-2.5">
            <div className="min-w-[130px]">
              <div className={label}>Type</div>
              <select
                value={draft.eventType}
                onChange={(e) => setDraft({ ...draft, eventType: e.target.value as CalendarEventType })}
                className={field}
              >
                {TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            {draft.kind === 'calendar' && !matterId && (
              <div className="min-w-[220px] flex-1">
                <div className={label}>Matter (optional)</div>
                <select
                  value={draft.matterId}
                  onChange={(e) => setDraft({ ...draft, matterId: e.target.value })}
                  className={field}
                >
                  <option value="">No matter</option>
                  {matters.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </div>
            )}
            {draft.kind === 'calendar' && (
              <div className="min-w-[160px] flex-1">
                <div className={label}>Where (optional)</div>
                <input
                  value={draft.location}
                  onChange={(e) => setDraft({ ...draft, location: e.target.value })}
                  placeholder="Courtroom 21B · Zoom · …"
                  className={field}
                />
              </div>
            )}
          </div>

          <div>
            <div className={label}>Note (optional)</div>
            <textarea
              rows={2}
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              className={`${field} resize-none`}
            />
          </div>

          {formError && <p className="text-[11px] text-red-300">{formError}</p>}

          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="px-3.5 py-1.5 rounded-md bg-[#f0c850] hover:bg-[#f5d565] text-[#0e0e12] text-[11px] font-bold disabled:opacity-40 transition-colors"
            >
              {saving ? 'Saving…' : draft.id ? 'Save changes' : 'Add to calendar'}
            </button>
            <button
              onClick={() => setDraft(null)}
              disabled={saving}
              className="px-3 py-1.5 rounded-md border border-[rgba(255,255,255,0.12)] text-[11px] text-white/60 hover:text-white transition-colors"
            >
              Cancel
            </button>
            {draft.id && (
              <button
                onClick={removeDraft}
                disabled={saving}
                className="ml-auto flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] text-white/45 hover:text-red-300 hover:bg-red-300/10 transition-colors"
              >
                <Trash2 size={12} /> Delete
              </button>
            )}
          </div>
        </div>
      )}

      {isLoading && (
        <p className="text-[12px] text-white/35 py-6 text-center">Loading the calendar…</p>
      )}

      {/* ── Month ── */}
      {!isLoading && view === 'month' && (
        <div className="rounded-lg border border-[rgba(255,255,255,0.12)] overflow-hidden">
          <div className="grid grid-cols-7 border-b border-[rgba(255,255,255,0.1)]">
            {WEEKDAYS.map((d) => (
              <div key={d} className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-white/35 text-center">
                {d}
              </div>
            ))}
          </div>
          {monthGrid.map((week, wi) => (
            <div key={wi} className="grid grid-cols-7 border-b last:border-b-0 border-[rgba(255,255,255,0.06)]">
              {week.map((day) => {
                const inMonth = day.slice(0, 7) === anchor.slice(0, 7);
                const dayEntries = byDay.get(day) ?? [];
                return (
                  <button
                    key={day}
                    onClick={() => { setSelected(day); }}
                    onDoubleClick={() => openNew(day)}
                    className={`min-h-[86px] text-left border-r last:border-r-0 border-[rgba(255,255,255,0.06)] p-1.5 align-top transition-colors ${
                      selected === day ? 'bg-[rgba(232,184,74,0.07)]' : 'hover:bg-[rgba(255,255,255,0.03)]'
                    }`}
                    title="Click to select · double-click to add an entry"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span
                        className={`text-[11px] tabular-nums ${
                          day === today
                            ? 'text-[#0e0e12] bg-[#f0c850] rounded px-1 font-bold'
                            : inMonth ? 'text-white/70' : 'text-white/25'
                        }`}
                      >
                        {Number(day.slice(8))}
                      </span>
                      {dayEntries.length > 3 && (
                        <span className="text-[9px] text-white/35">{dayEntries.length}</span>
                      )}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {dayEntries.slice(0, 3).map((e) => (
                        <EntryLine
                          key={e.key}
                          entry={e}
                          today={today}
                          dense
                          highlight={!!highlightListId && e.listId === highlightListId}
                          onOpen={() => openEntry(e)}
                        />
                      ))}
                      {dayEntries.length > 3 && (
                        <span className="text-[9px] text-white/35 pl-1">
                          +{dayEntries.length - 3} more
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* Selected day, under the month grid — the docket line for one day. */}
      {!isLoading && view === 'month' && (
        <DaySheet
          date={selected}
          entries={byDay.get(selected) ?? []}
          today={today}
          matterName={matterName}
          highlightListId={highlightListId}
          onOpen={openEntry}
          onAdd={() => openNew(selected)}
        />
      )}

      {/* ── Week ── */}
      {!isLoading && view === 'week' && (
        <div className="grid grid-cols-1 sm:grid-cols-7 rounded-lg border border-[rgba(255,255,255,0.12)] overflow-hidden">
          {weekDays.map((day) => {
            const dayEntries = byDay.get(day) ?? [];
            return (
              <div
                key={day}
                className={`border-r last:border-r-0 border-b sm:border-b-0 border-[rgba(255,255,255,0.06)] p-2 min-h-[160px] ${
                  day === today ? 'bg-[rgba(232,184,74,0.05)]' : ''
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-white/40">
                    {WEEKDAYS[fromKey(day).getDay()]} {Number(day.slice(8))}
                  </span>
                  <button
                    onClick={() => openNew(day)}
                    className="p-0.5 rounded text-white/25 hover:text-[#e8b84a]"
                    title="Add an entry on this day"
                  >
                    <Plus size={11} />
                  </button>
                </div>
                <div className="flex flex-col gap-1">
                  {dayEntries.length === 0 && (
                    <span className="text-[10px] text-white/20">—</span>
                  )}
                  {dayEntries.map((e) => (
                    <EntryLine
                      key={e.key}
                      entry={e}
                      today={today}
                      highlight={!!highlightListId && e.listId === highlightListId}
                      onOpen={() => openEntry(e)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Agenda ── */}
      {!isLoading && view === 'agenda' && (
        <Agenda
          entries={entries}
          today={today}
          matterName={matterName}
          highlightListId={highlightListId}
          onOpen={openEntry}
        />
      )}
    </div>
  );
}

// ── entry line ───────────────────────────────────────────────────────

function EntryLine({
  entry, today, dense, highlight, onOpen,
}: {
  entry: CalendarEntry;
  today: string;
  dense?: boolean;
  highlight?: boolean;
  onOpen: () => void;
}) {
  const color = ruleColor(entry, today);
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(ev) => { ev.stopPropagation(); onOpen(); }}
      onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.stopPropagation(); onOpen(); } }}
      className={`flex items-center gap-1 pl-1.5 pr-1 rounded-sm border-l-2 truncate cursor-pointer hover:bg-[rgba(255,255,255,0.07)] transition-colors ${
        dense ? 'text-[10px] py-px' : 'text-[11px] py-0.5'
      } ${entry.done ? 'text-white/30 line-through' : 'text-white/80'} ${
        highlight ? 'bg-[rgba(232,184,74,0.14)]' : ''
      }`}
      style={{ borderLeftColor: color }}
      title={`${entry.title}${entry.startTime ? ' · ' + formatTime(entry.startTime) : ''}`}
    >
      {entry.kind === 'list_due' && <ListChecks size={9} className="shrink-0 opacity-60" />}
      {entry.startTime && (
        <span className="shrink-0 tabular-nums opacity-60">{formatTime(entry.startTime)}</span>
      )}
      <span className="truncate">{entry.title}</span>
    </span>
  );
}

// ── one day's sheet ──────────────────────────────────────────────────

function DaySheet({
  date, entries, today, matterName, highlightListId, onOpen, onAdd,
}: {
  date: string;
  entries: CalendarEntry[];
  today: string;
  matterName: Map<string, string>;
  highlightListId?: string;
  onOpen: (e: CalendarEntry) => void;
  onAdd: () => void;
}) {
  return (
    <div className="rounded-lg border border-[rgba(255,255,255,0.12)] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[rgba(255,255,255,0.08)]">
        <span className="text-[12px] text-[#f5f1e8]">{dayTitle(date)}</span>
        <button
          onClick={onAdd}
          className="flex items-center gap-1 text-[11px] text-white/45 hover:text-[#e8b84a] transition-colors"
        >
          <Plus size={11} /> Add
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="px-3 py-4 text-[11px] text-white/30">Nothing on this day.</p>
      ) : (
        <div className="divide-y divide-[rgba(255,255,255,0.05)]">
          {entries.map((e) => (
            <EntryRow
              key={e.key}
              entry={e}
              today={today}
              matterName={matterName}
              highlight={!!highlightListId && e.listId === highlightListId}
              onOpen={() => onOpen(e)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── agenda ───────────────────────────────────────────────────────────

function Agenda({
  entries, today, matterName, highlightListId, onOpen,
}: {
  entries: CalendarEntry[];
  today: string;
  matterName: Map<string, string>;
  highlightListId?: string;
  onOpen: (e: CalendarEntry) => void;
}) {
  const [showPast, setShowPast] = useState(false);
  const upcoming = entries.filter((e) => e.startDate >= today);
  const past = entries.filter((e) => e.startDate < today).reverse();
  const shown = showPast ? past : upcoming;

  const groups: { date: string; items: CalendarEntry[] }[] = [];
  for (const e of shown) {
    const last = groups[groups.length - 1];
    if (last && last.date === e.startDate) last.items.push(e);
    else groups.push({ date: e.startDate, items: [e] });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex rounded-md border border-[rgba(255,255,255,0.12)] overflow-hidden self-start">
        <button
          onClick={() => setShowPast(false)}
          className={`px-2.5 py-1 text-[11px] ${!showPast ? 'bg-[rgba(255,255,255,0.1)] text-white' : 'text-white/50 hover:text-white'}`}
        >
          Upcoming
        </button>
        <button
          onClick={() => setShowPast(true)}
          className={`px-2.5 py-1 text-[11px] ${showPast ? 'bg-[rgba(255,255,255,0.1)] text-white' : 'text-white/50 hover:text-white'}`}
        >
          Past
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="flex flex-col items-center py-10 text-center">
          <CalendarDays size={22} className="text-white/15 mb-2" strokeWidth={1.5} />
          <p className="text-[12px] text-white/40">
            {showPast ? 'Nothing behind you.' : 'Nothing ahead. Add an entry, or import from Google.'}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-[rgba(255,255,255,0.12)] overflow-hidden">
          {groups.map((g) => (
            <div key={g.date}>
              <div className="px-3 py-1.5 bg-[rgba(255,255,255,0.03)] border-y border-[rgba(255,255,255,0.06)] text-[10px] uppercase tracking-wider text-white/45">
                {dayTitle(g.date)}
                {g.date === today && <span className="ml-2 text-[#e8b84a]">today</span>}
              </div>
              <div className="divide-y divide-[rgba(255,255,255,0.05)]">
                {g.items.map((e) => (
                  <EntryRow
                    key={e.key}
                    entry={e}
                    today={today}
                    matterName={matterName}
                    highlight={!!highlightListId && e.listId === highlightListId}
                    onOpen={() => onOpen(e)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── one docket line ──────────────────────────────────────────────────

function EntryRow({
  entry, today, matterName, highlight, onOpen,
}: {
  entry: CalendarEntry;
  today: string;
  matterName: Map<string, string>;
  highlight?: boolean;
  onOpen: () => void;
}) {
  const matter = entry.matterId ? matterName.get(entry.matterId) : null;
  const origin =
    entry.kind === 'list_due' ? (entry.notes ?? 'List')
    : entry.source === 'google' ? 'Google Calendar'
    : entry.kind === 'matter_event' ? 'Matter deadline'
    : null;

  return (
    <button
      onClick={onOpen}
      className={`flex items-start gap-3 w-full px-3 py-2 text-left hover:bg-[rgba(255,255,255,0.04)] transition-colors ${
        highlight ? 'bg-[rgba(232,184,74,0.1)]' : ''
      }`}
    >
      <span
        className="mt-1 w-[3px] self-stretch rounded-full shrink-0"
        style={{ backgroundColor: ruleColor(entry, today) }}
      />
      <span className="w-[62px] shrink-0 text-[11px] tabular-nums text-white/50 pt-px">
        {entry.startTime ? formatTime(entry.startTime) : 'All day'}
      </span>
      <span className="flex-1 min-w-0">
        <span className={`block text-[12.5px] leading-snug ${entry.done ? 'text-white/35 line-through' : 'text-[#f5f1e8]'}`}>
          {entry.title}
        </span>
        {(entry.location || (entry.notes && entry.kind !== 'list_due')) && (
          <span className="block text-[11px] text-white/35 truncate">
            {[entry.location, entry.kind !== 'list_due' ? entry.notes : null]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
      </span>
      {matter && (
        <span className="text-[10px] text-white/35 shrink-0 max-w-[130px] truncate pt-0.5">
          {matter}
        </span>
      )}
      {origin && (
        <span className="text-[10px] uppercase tracking-wide text-[#d4a054]/60 shrink-0 pt-0.5">
          {origin}
        </span>
      )}
      {!entry.editable && entry.link && entry.kind !== 'list_due' && (
        <ExternalLink size={11} className="text-white/25 shrink-0 mt-0.5" />
      )}
    </button>
  );
}
