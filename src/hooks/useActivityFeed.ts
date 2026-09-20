// Reads the activity_feed view (migration 024) — the unified internal
// activity stream. Used by the per-matter Updates tab (matterId set) and
// the Dashboard cross-matter feed (matterId undefined). React Query dedupes
// by key, so calling this hook from several components with the same args
// issues a single network request.
//
// A matter's Updates are the matter's AND its sub-matters'. Until 2026-09-20
// this filtered on `.eq('matter_id', matterId)`, so opening a parent matter
// showed nothing that happened inside it — the same bug migration 012 fixed
// for search. `matterspace_descendants` expands the tree (SECURITY INVOKER,
// so it only ever returns matters the caller can already see), and the read
// is paged, because PostgREST answers at most 1,000 rows however large a
// limit is asked for.

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { matterDescendantIds, readAllPages } from '@/lib/matter-record/fetch';
import type { RecordClient, SelectBuilder } from '@/lib/matter-record/types';

const client = supabase as unknown as RecordClient;

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

const COLUMNS = 'matter_id, event_type, actor_id, occurred_at, ref_id, title';

export function useActivityFeed(matterId: string | undefined, limit = 60) {
  return useQuery({
    queryKey: ['activity_feed', matterId ?? 'all', limit],
    queryFn: async (): Promise<ActivityEvent[]> => {
      // Order on (occurred_at, ref_id) so paging is a total order and no row
      // can appear on two pages while another appears on none.
      const build = (): SelectBuilder<RawEvent> => {
        const query = client
          .from('activity_feed')
          .select<RawEvent>(COLUMNS)
          .order('occurred_at', { ascending: false })
          .order('ref_id', { ascending: false });
        return query;
      };

      let events: RawEvent[] = [];
      if (matterId) {
        const ids = await matterDescendantIds(client, matterId);
        const { rows, error } = await readAllPages<RawEvent>(
          () => build().in('matter_id', ids),
          limit,
        );
        if (error) throw new Error(error.message ?? 'Failed to load activity');
        events = rows;
      } else {
        const { rows, error } = await readAllPages<RawEvent>(build, limit);
        if (error) throw new Error(error.message ?? 'Failed to load activity');
        events = rows;
      }

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
