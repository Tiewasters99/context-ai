// The cover a matter hands down: its own, or else the nearest parent
// matter's. Pages, lists and tables in a matter, and its sub-matters, show
// this when they have no cover of their own (see lib/default-cover.ts for
// the whole rule).
//
// One small read per level (id, parent, cover_url), cached. A matter's cover
// change invalidates MATTER_COVER_KEY so everything below it follows.

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export const MATTER_COVER_KEY = 'matter-cover-chain';

// Deeper than any matter tree in use; a guard against a cycle, not a limit
// anyone should meet.
const MAX_DEPTH = 12;

async function coverFromChain(matterId: string): Promise<string | null> {
  let id: string | null = matterId;
  for (let depth = 0; id && depth < MAX_DEPTH; depth++) {
    const { data, error }: {
      data: { parent_matterspace_id: string | null; cover_url: string | null } | null;
      error: { message: string } | null;
    } = await supabase
      .from('matterspaces')
      .select('parent_matterspace_id, cover_url')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return null;
    if (data.cover_url) return data.cover_url;
    id = data.parent_matterspace_id;
  }
  return null;
}

/** The cover the given matter hands down, or null. `null` in → null out. */
export function useMatterCover(matterId: string | null | undefined): string | null {
  const { data } = useQuery({
    queryKey: [MATTER_COVER_KEY, matterId],
    queryFn: () => coverFromChain(matterId as string),
    enabled: !!matterId,
    staleTime: 60_000,
  });
  return matterId ? data ?? null : null;
}
