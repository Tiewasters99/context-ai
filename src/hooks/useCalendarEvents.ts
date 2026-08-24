// The Contextspaces calendar's data layer.
//
// One calendar, three sources — merged into a single `CalendarEntry`
// shape so the grid never has to know where a row came from:
//
//   'calendar'     calendar_events (migration 053). The calendar's own
//                  store: appointments, meetings, blocks of time, and
//                  events imported from Google. Matter is optional.
//                  Fully editable (imported rows are read-only).
//   'matter_event' matter_events (migration 025). Matter deadlines.
//                  Editable in place — the calendar writes back through
//                  the existing useMatterEvents helpers.
//   'list_due'     a `due` date on an item inside a list content_item.
//                  Read-only here; clicking one opens the list with the
//                  item highlighted. The calendar never copies these —
//                  the list stays the single source of truth.
//
// Degrading gracefully: if migration 053 has not been applied to the
// database yet, the calendar_events query resolves to an empty set with
// `storageEnabled: false` instead of throwing, so the calendar still
// renders deadlines and list dues and simply says that adding entries is
// not switched on yet.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import {
  useMatterEvents,
  type MatterEvent,
  type MatterEventType,
} from '@/hooks/useMatterEvents';

// ── types ────────────────────────────────────────────────────────────

export type CalendarEventType =
  | 'event'
  | 'deadline'
  | 'hearing'
  | 'filing'
  | 'meeting'
  | 'reminder'
  | 'other';

export type CalendarSource = 'contextspaces' | 'google' | 'outlook';

export interface CalendarEventRow {
  id: string;
  owner_id: string;
  matterspace_id: string | null;
  title: string;
  notes: string | null;
  location: string | null;
  start_date: string;        // YYYY-MM-DD
  start_time: string | null; // HH:MM:SS — null = all-day
  end_date: string | null;
  end_time: string | null;
  event_type: CalendarEventType;
  source: CalendarSource;
  external_id: string | null;
  external_link: string | null;
  completed_at: string | null;
}

export type EntryKind = 'calendar' | 'matter_event' | 'list_due';

/** The one shape the calendar UI works in. */
export interface CalendarEntry {
  key: string;               // stable, unique across all three sources
  kind: EntryKind;
  id: string;                // row id, or the list item's id
  title: string;
  startDate: string;         // YYYY-MM-DD, local days
  startTime: string | null;  // HH:MM, null = all-day
  endDate: string | null;
  endTime: string | null;
  eventType: string;
  matterId: string | null;
  notes: string | null;
  location: string | null;
  source: CalendarSource;
  done: boolean;
  editable: boolean;         // false for imported rows and list dues
  link: string | null;       // where clicking the entry navigates
  listId?: string;           // list_due only
}

// ── helpers ──────────────────────────────────────────────────────────

export const todayStr = (): string => {
  const d = new Date();
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
};

/** Missing-table / missing-column errors, so an unapplied migration
 *  degrades into "storage not enabled" instead of a red error card. */
function isMissingRelation(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const code = err.code ?? '';
  if (code === 'PGRST205' || code === 'PGRST204' || code === '42P01' || code === '42703') {
    return true;
  }
  return /schema cache|does not exist|could not find the table/i.test(err.message ?? '');
}

const trimTime = (t: string | null): string | null => (t ? t.slice(0, 5) : null);

// ── calendar_events ──────────────────────────────────────────────────

export interface CalendarEventsResult {
  rows: CalendarEventRow[];
  storageEnabled: boolean;
}

export function useCalendarEventRows(matterId?: string) {
  return useQuery({
    queryKey: ['calendar_events', matterId ?? 'all'],
    queryFn: async (): Promise<CalendarEventsResult> => {
      let q = supabase
        .from('calendar_events')
        .select(
          'id, owner_id, matterspace_id, title, notes, location, start_date, start_time, end_date, end_time, event_type, source, external_id, external_link, completed_at',
        )
        .order('start_date', { ascending: true });
      if (matterId) q = q.eq('matterspace_id', matterId);
      const { data, error } = await q;
      if (error) {
        if (isMissingRelation(error)) return { rows: [], storageEnabled: false };
        throw new Error(`calendar_events: ${error.message}`);
      }
      return { rows: (data ?? []) as CalendarEventRow[], storageEnabled: true };
    },
  });
}

export function useCalendarInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['calendar_events'] });
    qc.invalidateQueries({ queryKey: ['matter_events'] });
    qc.invalidateQueries({ queryKey: ['calendar_list_dues'] });
  };
}

export interface CalendarEventInput {
  title: string;
  start_date: string;
  start_time: string | null;
  end_date: string | null;
  end_time: string | null;
  event_type: CalendarEventType;
  matterspace_id: string | null;
  notes: string | null;
  location: string | null;
}

export async function createCalendarEvent(input: CalendarEventInput): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const { error } = await supabase
    .from('calendar_events')
    .insert({ ...input, owner_id: user.id });
  if (error) {
    if (isMissingRelation(error)) throw new Error(STORAGE_OFF_MESSAGE);
    throw new Error(error.message);
  }
}

export async function updateCalendarEvent(
  id: string,
  patch: Partial<CalendarEventInput> & { completed_at?: string | null },
): Promise<void> {
  const { error } = await supabase
    .from('calendar_events')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteCalendarEvent(id: string): Promise<void> {
  const { error } = await supabase.from('calendar_events').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export const STORAGE_OFF_MESSAGE =
  'Calendar storage is not enabled on this database yet — migration 053 has not been applied. Deadlines and list due dates still show; new calendar entries cannot be saved.';

// ── list item due dates ──────────────────────────────────────────────

interface ListDueRow {
  id: string;
  title: string;
  content: Record<string, unknown> | null;
}

interface ListDue {
  listId: string;
  listTitle: string;
  itemId: string;
  text: string;
  due: string;
  done: boolean;
}

function readDues(rows: ListDueRow[]): ListDue[] {
  const out: ListDue[] = [];
  for (const row of rows) {
    const raw = (row.content ?? {}).items;
    if (!Array.isArray(raw)) continue;
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      if (typeof o.id !== 'string' || typeof o.text !== 'string') continue;
      if (typeof o.due !== 'string' || !o.due) continue;
      out.push({
        listId: row.id,
        listTitle: row.title || 'Untitled List',
        itemId: o.id,
        text: o.text,
        due: o.due,
        done: !!o.done,
      });
    }
  }
  return out;
}

/** Every list item with a due date that the user can see. RLS scopes it. */
export function useListDues(matterId?: string) {
  return useQuery({
    queryKey: ['calendar_list_dues', matterId ?? 'all'],
    queryFn: async (): Promise<ListDue[]> => {
      let q = supabase
        .from('content_items')
        .select('id, title, content')
        .eq('content_type', 'list');
      if (matterId) q = q.eq('space_id', matterId).eq('space_type', 'matterspace');
      const { data, error } = await q;
      if (error) throw new Error(`content_items: ${error.message}`);
      return readDues((data ?? []) as ListDueRow[]);
    },
  });
}

// ── the merged feed ──────────────────────────────────────────────────

export interface CalendarFeed {
  entries: CalendarEntry[];
  isLoading: boolean;
  error: Error | null;
  storageEnabled: boolean;
}

const MATTER_EVENT_KINDS: Record<MatterEventType, string> = {
  deadline: 'deadline',
  hearing: 'hearing',
  filing: 'filing',
  reminder: 'reminder',
  other: 'other',
};

function matterEventToEntry(e: MatterEvent): CalendarEntry {
  return {
    key: `matter_event:${e.id}`,
    kind: 'matter_event',
    id: e.id,
    title: e.title,
    startDate: e.event_date,
    startTime: trimTime(e.event_time),
    endDate: null,
    endTime: null,
    eventType: MATTER_EVENT_KINDS[e.event_type] ?? 'deadline',
    matterId: e.matterspace_id,
    notes: e.notes,
    location: null,
    source: 'contextspaces',
    done: !!e.completed_at,
    editable: true,
    link: `/app/matterspace/${e.matterspace_id}?tab=Calendar`,
  };
}

function calendarRowToEntry(r: CalendarEventRow): CalendarEntry {
  return {
    key: `calendar:${r.id}`,
    kind: 'calendar',
    id: r.id,
    title: r.title,
    startDate: r.start_date,
    startTime: trimTime(r.start_time),
    endDate: r.end_date,
    endTime: trimTime(r.end_time),
    eventType: r.event_type,
    matterId: r.matterspace_id,
    notes: r.notes,
    location: r.location,
    source: r.source,
    done: !!r.completed_at,
    // Imported rows are a mirror of the source calendar; editing them
    // here would be overwritten on the next import.
    editable: r.source === 'contextspaces',
    link: r.external_link,
  };
}

function listDueToEntry(d: ListDue): CalendarEntry {
  return {
    key: `list_due:${d.listId}:${d.itemId}`,
    kind: 'list_due',
    id: d.itemId,
    title: d.text || '(untitled item)',
    startDate: d.due,
    startTime: null,
    endDate: null,
    endTime: null,
    eventType: 'list item',
    matterId: null,
    notes: d.listTitle,
    location: null,
    source: 'contextspaces',
    done: d.done,
    editable: false,
    link: `/app/list/${d.listId}?item=${d.itemId}`,
    listId: d.listId,
  };
}

/** The whole calendar for a scope: no matterId = everything the user can
 *  see; a matterId = just that matter. */
export function useCalendarFeed(matterId?: string): CalendarFeed {
  const cal = useCalendarEventRows(matterId);
  const matterEvents = useMatterEvents(matterId);
  const dues = useListDues(matterId);

  const entries: CalendarEntry[] = [
    ...(cal.data?.rows ?? []).map(calendarRowToEntry),
    ...(matterEvents.data ?? []).map(matterEventToEntry),
    ...(dues.data ?? []).map(listDueToEntry),
  ].sort((a, b) =>
    (a.startDate + (a.startTime ?? '24:00')).localeCompare(
      b.startDate + (b.startTime ?? '24:00'),
    ),
  );

  const err =
    (cal.error as Error | null) ??
    (matterEvents.error as Error | null) ??
    (dues.error as Error | null) ??
    null;

  return {
    entries,
    isLoading: cal.isLoading || matterEvents.isLoading || dues.isLoading,
    error: err,
    storageEnabled: cal.data?.storageEnabled ?? true,
  };
}
