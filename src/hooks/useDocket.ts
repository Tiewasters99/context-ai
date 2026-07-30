// Data for the Practice Docket. One RPC (get_matter_map, migration
// 042/043) returns every matter the user can see with its ledger state,
// calendar-derived deadlines, doc counts, and last activity. "On the
// docket" = the matter has an explicit ledger row (state_updated_at not
// null) and isn't archived — agents and the docket UI create those rows
// through the set_matter_state RPC, never by writing matter_state
// directly, so every change leaves an append-only ledger event.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export type DocketStatus = 'active' | 'urgent' | 'waiting' | 'dormant' | 'archived';

export interface DocketRow {
  id: string;
  name: string;
  short_code: string | null;
  parent_matterspace_id: string | null;
  serverspace_id: string;
  serverspace_name: string;
  doc_count: number;
  last_activity_at: string | null;
  next_deadline: string | null;       // YYYY-MM-DD
  next_deadline_label: string | null;
  overdue_count: number;
  status: DocketStatus;
  headline: string | null;
  next_action: string | null;
  next_action_owner: string | null;
  waiting_on?: string | null;         // absent until migration 043 is applied
  state_updated_at: string | null;
}

export const STATUS_COLORS: Record<DocketStatus, string> = {
  active: '#d4a054',
  urgent: '#f87171',
  waiting: '#fbbf24',
  dormant: '#7e7a72',
  archived: '#5a5665',
};

const DOCKET_KEY = ['matter_map'] as const;

// Deadline-first, zero-config ordering: overdue, then urgent-flagged,
// then earliest due date, then most recently active.
export function sortDocket(rows: DocketRow[]): DocketRow[] {
  return [...rows].sort((a, b) => {
    const overdue = Number(b.overdue_count > 0) - Number(a.overdue_count > 0);
    if (overdue) return overdue;
    const urgent = Number(b.status === 'urgent') - Number(a.status === 'urgent');
    if (urgent) return urgent;
    const ad = a.next_deadline ?? '9999';
    const bd = b.next_deadline ?? '9999';
    if (ad !== bd) return ad.localeCompare(bd);
    return (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? '');
  });
}

export function useDocket() {
  const query = useQuery({
    queryKey: DOCKET_KEY,
    queryFn: async (): Promise<DocketRow[]> => {
      const { data, error } = await supabase.rpc('get_matter_map');
      if (error) throw new Error(error.message);
      return (data ?? []) as DocketRow[];
    },
    refetchOnMount: 'always',
    staleTime: 10_000,
  });
  const all = query.data ?? [];
  return {
    ...query,
    docket: sortDocket(all.filter((r) => r.state_updated_at && r.status !== 'archived')),
    // Candidates for the "add thread" picker — visible matters not yet docketed.
    undocketed: all
      .filter((r) => !r.state_updated_at)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export interface DocketPatch {
  status?: DocketStatus;
  headline?: string;           // '' clears
  next_action?: string;        // '' clears
  next_action_owner?: string;  // '' clears
  waiting_on?: string;         // '' clears; requires migration 043
}

export function useSetMatterState() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ matterId, patch }: { matterId: string; patch: DocketPatch }) => {
      // Build args dynamically: only fields actually being set are sent, so
      // the call works against both the 042 and 043 RPC signatures (042
      // predates p_waiting_on).
      const args: Record<string, unknown> = { p_matter: matterId, p_updated_by: 'human' };
      if (patch.status !== undefined) args.p_status = patch.status;
      if (patch.headline !== undefined) args.p_headline = patch.headline;
      if (patch.next_action !== undefined) args.p_next_action = patch.next_action;
      if (patch.next_action_owner !== undefined) args.p_next_action_owner = patch.next_action_owner;
      if (patch.waiting_on !== undefined) args.p_waiting_on = patch.waiting_on;
      const { data, error } = await supabase.rpc('set_matter_state', args);
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: DOCKET_KEY }),
  });
}

// ── The expanded row's chronology: ledger events + activity + calendar,
//    merged newest-first. Fetched lazily, only when a row is opened. ────
export interface DocketEntry {
  kind: 'note' | 'state' | 'activity' | 'calendar';
  occurred_at: string;
  text: string;
  actor_id?: string | null;
}

const ACTIVITY_LABELS: Record<string, string> = {
  document_uploaded: 'Document filed',
  page_created: 'Page created',
  list_created: 'List created',
  table_created: 'Table created',
  comment_posted: 'Comment',
  cite_check_completed: 'Cite-check completed',
  meeting_started: 'Meeting started',
  meeting_ended: 'Meeting ended',
  event_added: 'Calendar entry added',
};

function describeStateEvent(payload: Record<string, unknown>): string {
  const set = (payload?.set ?? {}) as Record<string, string>;
  const parts: string[] = [];
  if (set.status) parts.push(`status → ${set.status}`);
  if (set.headline !== undefined) parts.push(`headline: "${set.headline}"`);
  if (set.next_action !== undefined) parts.push(`next: ${set.next_action}`);
  if (set.waiting_on !== undefined) parts.push(`waiting on: ${set.waiting_on || '—'}`);
  const by = (payload?.updated_by as string) ?? '';
  const suffix = by && by !== 'human' ? ` (${by})` : '';
  return (parts.join(' · ') || 'State updated') + suffix;
}

export function useDocketSheet(matterId: string | null) {
  return useQuery({
    queryKey: ['docket_sheet', matterId],
    enabled: !!matterId,
    queryFn: async (): Promise<DocketEntry[]> => {
      const [ledger, activity, calendar] = await Promise.all([
        supabase
          .from('matter_state_events')
          .select('event_type, payload, actor_id, created_at')
          .eq('matterspace_id', matterId!)
          .order('created_at', { ascending: false })
          .limit(80),
        supabase
          .from('activity_feed')
          .select('event_type, title, occurred_at')
          .eq('matter_id', matterId!)
          .order('occurred_at', { ascending: false })
          .limit(40),
        supabase
          .from('matter_events')
          .select('title, event_date, event_type, completed_at')
          .eq('matterspace_id', matterId!)
          .order('event_date', { ascending: false })
          .limit(20),
      ]);
      const firstErr = ledger.error ?? activity.error ?? calendar.error;
      if (firstErr) throw new Error(firstErr.message);

      const entries: DocketEntry[] = [];
      for (const e of ledger.data ?? []) {
        const payload = (e.payload ?? {}) as Record<string, unknown>;
        entries.push(
          e.event_type === 'note' || e.event_type === 'time_note'
            ? { kind: 'note', occurred_at: e.created_at, text: String(payload.text ?? ''), actor_id: e.actor_id }
            : { kind: 'state', occurred_at: e.created_at, text: describeStateEvent(payload), actor_id: e.actor_id },
        );
      }
      for (const e of activity.data ?? []) {
        // Calendar additions already appear as richer 'calendar' entries below.
        if (e.event_type === 'event_added') continue;
        entries.push({
          kind: 'activity',
          occurred_at: e.occurred_at,
          text: `${ACTIVITY_LABELS[e.event_type] ?? e.event_type} — ${e.title ?? ''}`,
        });
      }
      for (const e of calendar.data ?? []) {
        entries.push({
          kind: 'calendar',
          occurred_at: `${e.event_date}T00:00:00Z`,
          text: `${e.event_type === 'deadline' ? 'Deadline' : e.event_type}: ${e.title}${e.completed_at ? ' ✓' : ''}`,
        });
      }
      return entries.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
    },
  });
}

export async function addDocketNote(matterId: string, text: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('matter_state_events').insert({
    matterspace_id: matterId,
    event_type: 'note',
    payload: { text, source: 'docket' },
    actor_id: user?.id ?? null,
  });
  if (error) throw new Error(error.message);
}
