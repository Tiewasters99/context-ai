// Data for the Agents tab.
//
// Two queries, deliberately separate:
//   useAgentCharters()  — the user's own charters (agent_charters, RLS).
//   useIngestQueue()    — the ONE live reading the "On duty" docket has:
//                         the real state of processing_jobs. Every other
//                         built-in row says "not yet scheduled", because it
//                         is. Nothing on this surface invents activity.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import {
  listCharters, createCharter, updateCharter, deleteCharter, effectiveTier, PEN_BY_TIER,
  CharterStorageMissing, type AgentCharter, type CharterDraft, type PenForTier,
} from '@/lib/agent-charters';

const CHARTERS_KEY = ['agent_charters'] as const;

export function useAgentCharters() {
  const query = useQuery({
    queryKey: CHARTERS_KEY,
    queryFn: listCharters,
    retry: false,
    staleTime: 15_000,
  });
  return {
    ...query,
    charters: query.data ?? [],
    /** Migration 052 has not been applied here. Not an error to show raw. */
    storageMissing: query.error instanceof CharterStorageMissing,
  };
}

export function useCharterMutations() {
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: CHARTERS_KEY }); };

  const create = useMutation<AgentCharter, Error, CharterDraft>({
    mutationFn: createCharter,
    onSuccess: invalidate,
  });
  const update = useMutation<AgentCharter, Error, { id: string; draft: CharterDraft }>({
    mutationFn: ({ id, draft }) => updateCharter(id, draft),
    onSuccess: invalidate,
  });
  const remove = useMutation<void, Error, string>({
    mutationFn: deleteCharter,
    onSuccess: invalidate,
  });
  return { create, update, remove };
}

// ─── The ingestion watcher's live reading ────────────────────────────────

export interface IngestQueueReading {
  /** Jobs not yet finished. */
  waiting: number;
  running: number;
  failed: number;
  /** The most recent job of any status, for "last run" / "last thing it did". */
  last: {
    job_type: string;
    status: string;
    created_at: string;
    finished_at: string | null;
    progress_note: string | null;
    error: string | null;
  } | null;
}

export function useIngestQueue() {
  return useQuery<IngestQueueReading>({
    queryKey: ['agents', 'ingest_queue'],
    retry: false,
    staleTime: 20_000,
    queryFn: async () => {
      const recent = await supabase
        .from('processing_jobs')
        .select('job_type, status, created_at, finished_at, progress_note, error')
        .order('created_at', { ascending: false })
        .limit(50);
      if (recent.error) throw new Error(recent.error.message);
      const rows = recent.data ?? [];
      const counts = { waiting: 0, running: 0, failed: 0 };
      for (const r of rows) {
        if (r.status === 'queued') counts.waiting += 1;
        else if (r.status === 'running') counts.running += 1;
        else if (r.status === 'error') counts.failed += 1;
      }
      return {
        ...counts,
        last: rows.length ? (rows[0] as IngestQueueReading['last']) : null,
      };
    },
  });
}

// ─── Which pen a matter's tier implies ───────────────────────────────────
// Display only, and never a choice: the tier is enforced server-side. A
// matter whose tier cannot be read reports itself as unknown rather than
// claiming Tier A — an unearned "not sealed" is the one wrong answer here.

const UNKNOWN_PEN: PenForTier = {
  tier: 'A',
  label: 'not known',
  detail: 'This deployment has not recorded a SecureSpace tier for the matter (migration 051).',
};

export function useMatterPen(matterId: string | null) {
  return useQuery<PenForTier>({
    queryKey: ['agents', 'pen', matterId],
    enabled: Boolean(matterId),
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const tier = await effectiveTier(matterId as string).catch(() => null);
      return tier ? PEN_BY_TIER[tier] : UNKNOWN_PEN;
    },
  });
}
