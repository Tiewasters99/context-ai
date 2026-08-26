// Shared query for the signed-in user's serverspaces (with their
// matterspaces joined in, plus member counts). Used by both the sidebar
// and the dashboard so a mutation in one view invalidates the cache and
// both views refetch automatically.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export interface ServerspaceMatter {
  id: string;
  name: string;
  short_code: string | null;
  parent_matterspace_id: string | null;
  // SecureSpace tier (migration 051): 'A' open, 'B' sealed, 'C' silo. This is
  // the matter's OWN tier; the seal inherits downward, so a matter is
  // effectively sealed when any ancestor is B/C — compute that in memory from
  // the tree rather than per-matter queries.
  ai_tier: 'A' | 'B' | 'C';
}

export interface Serverspace {
  id: string;
  name: string;
  member_count: number;
  matterspaces: ServerspaceMatter[];
}

const SERVERSPACES_KEY = ['serverspaces'] as const;

async function fetchServerspaces(): Promise<Serverspace[]> {
  const { data, error } = await supabase
    .from('serverspaces')
    .select('id, name, matterspaces (id, name, short_code, parent_matterspace_id, ai_tier)')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`serverspaces: ${error.message}`);
  if (!data) return [];

  // Best-effort member count per serverspace. If RLS hides the members
  // count for a given row, we silently fall back to 0 rather than failing
  // the whole query.
  return Promise.all(
    data.map(async (s) => {
      const { count } = await supabase
        .from('serverspace_members')
        .select('user_id', { count: 'exact', head: true })
        .eq('serverspace_id', s.id);
      return {
        id: s.id,
        name: s.name,
        member_count: count ?? 0,
        matterspaces: (s.matterspaces ?? []) as ServerspaceMatter[],
      };
    }),
  );
}

export function useServerspaces() {
  return useQuery({
    queryKey: SERVERSPACES_KEY,
    queryFn: fetchServerspaces,
    staleTime: 30_000,
  });
}

// Return a function that any component can call after a mutation to mark
// the serverspaces cache stale. All useServerspaces() consumers refetch
// on the next render.
export function useServerspacesRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: SERVERSPACES_KEY });
}
