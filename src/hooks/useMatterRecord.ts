// Reads one matter's Record — the matter and every sub-matter, in one list.
//
// All of the work is in src/lib/matter-record/fetch.ts, which takes the client
// as an argument so an offline harness can hand it a stub. This hook is only
// the React Query wrapper and the one place the real client is cast to the
// small interface that library asks for.

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { fetchMatterRecord } from '@/lib/matter-record/fetch';
import type { MatterRecordData, MatterRef, RecordClient } from '@/lib/matter-record/types';

const client = supabase as unknown as RecordClient;

export function useMatterRecord(matter: MatterRef | null | undefined, ceiling?: number) {
  return useQuery<MatterRecordData>({
    queryKey: ['matter_record', matter?.id ?? 'none', ceiling ?? 'default'],
    enabled: !!matter?.id,
    // The Record is append-only: nothing already read can change, so a short
    // stale time is enough and a refetch only ever adds to the end.
    staleTime: 30_000,
    queryFn: async () => {
      if (!matter?.id) throw new Error('No matter');
      return fetchMatterRecord(client, matter, ceiling ? { ceiling } : {});
    },
  });
}
