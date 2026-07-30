// Data for the Knowledge Map: one RPC returns every matter the user can
// see (RLS-filtered end to end) with the raw ingredients for the three
// encodings — doc counts, last activity, next/overdue deadlines, and the
// matter_state ledger fields. The map must always render live state, so
// it refetches on every mount rather than trusting a warm cache.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import type { MapMatterRow, MatterStatus } from '@/lib/map-model';

const MATTER_MAP_KEY = ['matter_map'] as const;

export function useMatterMap() {
  return useQuery({
    queryKey: MATTER_MAP_KEY,
    queryFn: async (): Promise<MapMatterRow[]> => {
      const { data, error } = await supabase.rpc('get_matter_map');
      if (error) throw new Error(error.message);
      return (data ?? []) as MapMatterRow[];
    },
    refetchOnMount: 'always',
    staleTime: 10_000,
  });
}

export interface MatterStatePatch {
  status?: MatterStatus;
  headline?: string;      // '' clears the field
  next_action?: string;   // '' clears the field
  next_action_owner?: string;
}

// All state edits go through the set_matter_state RPC so every change is
// guaranteed to leave a matter_state_events ledger row (the Briefing
// Engine diffs against those). Never write matter_state directly.
export function useSetMatterState() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ matterId, patch }: { matterId: string; patch: MatterStatePatch }) => {
      const { data, error } = await supabase.rpc('set_matter_state', {
        p_matter: matterId,
        p_status: patch.status ?? null,
        p_headline: patch.headline ?? null,
        p_next_action: patch.next_action ?? null,
        p_next_action_owner: patch.next_action_owner ?? null,
        p_updated_by: 'human',
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MATTER_MAP_KEY });
    },
  });
}

export function useMatterMapInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: MATTER_MAP_KEY });
}
