// Reads the activity_feed view (migration 024) — the unified internal
// activity stream. Used by the per-matter Updates tab (matterId set) and
// the Dashboard cross-matter feed (matterId undefined). React Query dedupes
// by key, so calling this hook from several components with the same args
// issues a single network request.

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export interface ActivityEvent {
  matter_id: string;
  event_type: string;
  actor_id: string | null;
  occurred_at: string;
  ref_id: string;
  title: string;
  actor_name: string | null;
}

type RawEvent = Omit<ActivityEvent, 'actor_name'>;

export function useActivityFeed(matterId: string | undefined, limit = 60) {
  return useQuery({
    queryKey: ['activity_feed', matterId ?? 'all', limit],
    queryFn: async (): Promise<ActivityEvent[]> => {
      let q = supabase
        .from('activity_feed')
        .select('matter_id, event_type, actor_id, occurred_at, ref_id, title')
        .order('occurred_at', { ascending: false })
        .limit(limit);
      if (matterId) q = q.eq('matter_id', matterId);
      const { data, error } = await q;
      if (error) throw error;
      const events = (data ?? []) as RawEvent[];

      // Resolve actor display names in one batched query. If profiles RLS
      // hides other users, those simply fall back to a null name and the
      // UI shows "Someone" — the feed still works.
      const actorIds = [
        ...new Set(events.map((e) => e.actor_id).filter((x): x is string => !!x)),
      ];
      const names = new Map<string, string>();
      if (actorIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, display_name, email')
          .in('id', actorIds);
        for (const p of profiles ?? []) {
          const name = (p.display_name ?? '').trim() || p.email || null;
          if (name) names.set(p.id, name);
        }
      }

      return events.map((e) => ({
        ...e,
        actor_name: e.actor_id ? names.get(e.actor_id) ?? null : null,
      }));
    },
  });
}
