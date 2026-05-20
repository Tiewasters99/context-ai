// CRUD for matter_events (migration 025) — the internal calendar.
// useMatterEvents(matterId) drives a matter's Calendar tab; with no
// matterId it returns every event the user can see (RLS-filtered), for
// the Dashboard's "Upcoming deadlines".

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export type MatterEventType =
  | 'deadline'
  | 'hearing'
  | 'filing'
  | 'reminder'
  | 'other';

export interface MatterEvent {
  id: string;
  matterspace_id: string;
  title: string;
  event_date: string;        // YYYY-MM-DD
  event_time: string | null; // HH:MM:SS, or null for all-day
  event_type: MatterEventType;
  notes: string | null;
  completed_at: string | null;
  created_by: string;
  created_at: string;
}

export function useMatterEvents(matterId?: string) {
  return useQuery({
    queryKey: ['matter_events', matterId ?? 'all'],
    queryFn: async (): Promise<MatterEvent[]> => {
      let q = supabase
        .from('matter_events')
        .select('*')
        .order('event_date', { ascending: true });
      if (matterId) q = q.eq('matterspace_id', matterId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as MatterEvent[];
    },
  });
}

// Invalidates every matter_events query (a matter's tab and the
// Dashboard 'all' query) after a mutation.
export function useMatterEventsInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['matter_events'] });
  };
}

export async function createMatterEvent(input: {
  matterspace_id: string;
  title: string;
  event_date: string;
  event_time: string | null;
  event_type: MatterEventType;
  notes: string | null;
}): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const { error } = await supabase
    .from('matter_events')
    .insert({ ...input, created_by: user.id });
  if (error) throw error;
}

export async function updateMatterEvent(
  id: string,
  patch: Partial<
    Pick<
      MatterEvent,
      'title' | 'event_date' | 'event_time' | 'event_type' | 'notes' | 'completed_at'
    >
  >,
): Promise<void> {
  const { error } = await supabase
    .from('matter_events')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteMatterEvent(id: string): Promise<void> {
  const { error } = await supabase.from('matter_events').delete().eq('id', id);
  if (error) throw error;
}
