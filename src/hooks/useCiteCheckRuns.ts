// React Query wrappers around cite_check_runs. One cache key per matter
// for the run list; one per run id for the full record (which carries the
// per-cite report and the rendered TOA). Mirrors the shape of
// useContentItems — list hook + detail hook + invalidator.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import type { FlagCounts, ReportEntry } from '@/lib/cite-check';

export type RunStatus = 'running' | 'complete' | 'interrupted' | 'error';

export interface CiteCheckRunSummary {
  id: string;
  source_label: string;
  document_id: string | null;
  status: RunStatus;
  error_message: string | null;
  citations_total: number;
  counts: FlagCounts | Record<string, never>;
  created_at: string;
  completed_at: string | null;
}

export interface CiteCheckRunFull extends CiteCheckRunSummary {
  matterspace_id: string;
  report: ReportEntry[];
  toa_markdown: string | null;
  report_markdown: string | null;
}

const listKey = (matterId: string) => ['cite_check_runs', matterId] as const;
const runKey = (runId: string) => ['cite_check_run', runId] as const;

export function useCiteCheckRuns(matterId: string | null | undefined) {
  return useQuery({
    queryKey: matterId ? listKey(matterId) : ['cite_check_runs', 'noop'],
    enabled: !!matterId,
    queryFn: async (): Promise<CiteCheckRunSummary[]> => {
      if (!matterId) return [];
      const { data, error } = await supabase
        .from('cite_check_runs')
        .select('id, source_label, document_id, status, error_message, citations_total, counts, created_at, completed_at')
        .eq('matterspace_id', matterId)
        .order('created_at', { ascending: false });
      if (error) throw new Error(`cite_check_runs: ${error.message}`);
      return (data ?? []) as CiteCheckRunSummary[];
    },
    staleTime: 10_000,
  });
}

export function useCiteCheckRun(runId: string | null | undefined) {
  return useQuery({
    queryKey: runId ? runKey(runId) : ['cite_check_run', 'noop'],
    enabled: !!runId,
    queryFn: async (): Promise<CiteCheckRunFull | null> => {
      if (!runId) return null;
      const { data, error } = await supabase
        .from('cite_check_runs')
        .select('*')
        .eq('id', runId)
        .maybeSingle();
      if (error) throw new Error(`cite_check_run: ${error.message}`);
      if (!data) return null;
      return { ...data, report: (data.report ?? []) as ReportEntry[] } as CiteCheckRunFull;
    },
  });
}

export function useCiteCheckRunsInvalidate() {
  const qc = useQueryClient();
  return {
    invalidateList(matterId: string) {
      qc.invalidateQueries({ queryKey: listKey(matterId) });
    },
    invalidateRun(runId: string) {
      qc.invalidateQueries({ queryKey: runKey(runId) });
    },
  };
}
