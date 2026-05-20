// The matter Calendar tab — a list of deadlines and events for one
// matter. v1 is a chronological list (not a month grid): upcoming
// soonest-first, past/completed below. Add, edit, complete, delete.

import { useState } from 'react';
import { Plus, Calendar as CalIcon, Trash2, Pencil, Check } from 'lucide-react';
import {
  useMatterEvents,
  useMatterEventsInvalidate,
  createMatterEvent,
  updateMatterEvent,
  deleteMatterEvent,
  type MatterEvent,
  type MatterEventType,
} from '@/hooks/useMatterEvents';

const TYPE_OPTIONS: { value: MatterEventType; label: string }[] = [
  { value: 'deadline', label: 'Deadline' },
  { value: 'hearing', label: 'Hearing' },
  { value: 'filing', label: 'Filing' },
  { value: 'reminder', label: 'Reminder' },
  { value: 'other', label: 'Other' },
];

const todayStr = () => new Date().toISOString().slice(0, 10);

function formatDate(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatTime(t: string | null): string {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

const inputClass =
  'w-full px-3 py-2 rounded-lg border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.04)] text-[13px] text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-[#e8b84a] focus:border-transparent';

export default function MatterCalendar({ matterId }: { matterId: string }) {
  const { data: events = [], isLoading, error } = useMatterEvents(matterId);
  const invalidate = useMatterEventsInvalidate();

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(todayStr());
  const [time, setTime] = useState('');
  const [type, setType] = useState<MatterEventType>('deadline');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const resetForm = () => {
    setEditingId(null);
    setTitle('');
    setDate(todayStr());
    setTime('');
    setType('deadline');
    setNotes('');
    setFormError(null);
  };
  const openAdd = () => {
    resetForm();
    setFormOpen(true);
  };
  const openEdit = (e: MatterEvent) => {
    setEditingId(e.id);
    setTitle(e.title);
    setDate(e.event_date);
    setTime(e.event_time ? e.event_time.slice(0, 5) : '');
    setType(e.event_type);
    setNotes(e.notes ?? '');
    setFormError(null);
    setFormOpen(true);
  };
  const closeForm = () => {
    setFormOpen(false);
    resetForm();
  };

  const save = async () => {
    const t = title.trim();
    if (!t) {
      setFormError('Title is required.');
      return;
    }
    if (!date) {
      setFormError('Date is required.');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (editingId) {
        await updateMatterEvent(editingId, {
          title: t,
          event_date: date,
          event_time: time || null,
          event_type: type,
          notes: notes.trim() || null,
        });
      } else {
        await createMatterEvent({
          matterspace_id: matterId,
          title: t,
          event_date: date,
          event_time: time || null,
          event_type: type,
          notes: notes.trim() || null,
        });
      }
      invalidate();
      closeForm();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const toggleComplete = async (e: MatterEvent) => {
    await updateMatterEvent(e.id, {
      completed_at: e.completed_at ? null : new Date().toISOString(),
    });
    invalidate();
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this event?')) return;
    await deleteMatterEvent(id);
    invalidate();
  };

  const today = todayStr();
  const sortKey = (e: MatterEvent) => e.event_date + (e.event_time ?? '24:00');
  const upcoming = events
    .filter((e) => !e.completed_at && e.event_date >= today)
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const past = events
    .filter((e) => e.completed_at || e.event_date < today)
    .sort((a, b) => b.event_date.localeCompare(a.event_date));

  return (
    <div className="flex flex-col gap-5">
      {/* Add / form */}
      {!formOpen && (
        <div className="flex justify-end">
          <button
            onClick={openAdd}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[rgba(255,255,255,0.14)] text-[12px] text-white/80 hover:bg-[#1c1c26] hover:text-white transition-colors"
          >
            <Plus size={12} strokeWidth={2} />
            New event
          </button>
        </div>
      )}
      {formOpen && (
        <div className="rounded-lg border border-[rgba(255,255,255,0.14)] bg-[rgba(20,20,32,0.6)] p-4 flex flex-col gap-3">
          <input
            autoFocus
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Event title — e.g. Motion to compel due"
            className={inputClass}
          />
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-[11px] text-white/50">
              Date
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-white/50">
              Time (optional)
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-white/50">
              Type
              <select
                value={type}
                onChange={(e) => setType(e.target.value as MatterEventType)}
                className={inputClass}
              >
                {TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes (optional)"
            rows={2}
            className={`${inputClass} resize-none`}
          />
          {formError && (
            <p className="text-[12px] text-red-300">{formError}</p>
          )}
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="px-4 py-2 rounded-lg bg-[#f0c850] hover:bg-[#f5d565] text-[#0e0e12] text-[12px] font-bold transition-colors disabled:opacity-40"
            >
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add event'}
            </button>
            <button
              onClick={closeForm}
              disabled={saving}
              className="px-4 py-2 rounded-lg border border-[rgba(255,255,255,0.12)] text-[12px] text-white/70 hover:text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading && (
        <p className="text-center text-[12px] text-white/40 py-8">Loading…</p>
      )}
      {error && (
        <p className="text-center text-[12px] text-red-300 py-8">
          {error instanceof Error ? error.message : 'Failed to load events'}
        </p>
      )}

      {!isLoading && !error && events.length === 0 && !formOpen && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <CalIcon size={26} className="text-white/20 mb-3" strokeWidth={1.5} />
          <p className="text-[13px] text-white/50">
            No events yet. Add deadlines, hearings, and filing dates as they come up.
          </p>
        </div>
      )}

      {upcoming.length > 0 && (
        <EventGroup
          label="Upcoming"
          events={upcoming}
          onToggle={toggleComplete}
          onEdit={openEdit}
          onDelete={remove}
        />
      )}
      {past.length > 0 && (
        <EventGroup
          label="Past & completed"
          events={past}
          onToggle={toggleComplete}
          onEdit={openEdit}
          onDelete={remove}
          muted
        />
      )}
    </div>
  );
}

function EventGroup({
  label,
  events,
  onToggle,
  onEdit,
  onDelete,
  muted,
}: {
  label: string;
  events: MatterEvent[];
  onToggle: (e: MatterEvent) => void;
  onEdit: (e: MatterEvent) => void;
  onDelete: (id: string) => void;
  muted?: boolean;
}) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-[#8a8693] mb-2 px-1">
        {label}
      </div>
      <div className="rounded-lg border border-[rgba(255,255,255,0.14)] overflow-hidden divide-y divide-[rgba(255,255,255,0.06)]">
        {events.map((e) => {
          const done = !!e.completed_at;
          return (
            <div
              key={e.id}
              className={`group flex items-start gap-3 px-4 py-2.5 ${
                muted ? 'opacity-70' : ''
              }`}
            >
              <button
                onClick={() => onToggle(e)}
                title={done ? 'Mark not done' : 'Mark done'}
                className={`mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center shrink-0 transition-colors ${
                  done
                    ? 'bg-[#4ade80]/20 border-[#4ade80]/50 text-[#4ade80]'
                    : 'border-[rgba(255,255,255,0.3)] hover:border-[#e8b84a]'
                }`}
              >
                {done && <Check size={10} strokeWidth={3} />}
              </button>
              <div className="w-[88px] shrink-0 text-[12px] text-white/60 leading-snug pt-px">
                {formatDate(e.event_date)}
                {e.event_time && (
                  <div className="text-[11px] text-white/40">
                    {formatTime(e.event_time)}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div
                  className={`text-[13px] leading-snug ${
                    done
                      ? 'text-white/45 line-through'
                      : 'text-[#f5f1e8]'
                  }`}
                >
                  {e.title}
                </div>
                {e.notes && (
                  <div className="text-[11px] text-white/40 mt-0.5 whitespace-pre-wrap">
                    {e.notes}
                  </div>
                )}
              </div>
              <span className="text-[10px] uppercase tracking-wide text-[#d4a054]/70 shrink-0 pt-0.5">
                {e.event_type}
              </span>
              <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => onEdit(e)}
                  title="Edit"
                  className="p-1 rounded text-white/40 hover:text-[#e8b84a] hover:bg-[rgba(255,255,255,0.05)]"
                >
                  <Pencil size={12} strokeWidth={2} />
                </button>
                <button
                  onClick={() => onDelete(e.id)}
                  title="Delete"
                  className="p-1 rounded text-white/40 hover:text-red-300 hover:bg-red-300/10"
                >
                  <Trash2 size={12} strokeWidth={2} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
