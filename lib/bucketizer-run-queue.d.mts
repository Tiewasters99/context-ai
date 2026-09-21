// Hand-written declarations for bucketizer-run-queue.mjs (the SPA's tsconfig
// has allowJs off; the API and the worker consume the .mjs directly).

export declare const BUCKETIZER_JOB_TYPE: string;
export declare const BUCKETIZER_JOB_PRIORITY: number;
export declare const SERVER_RUN_MIN_DOCUMENTS: number;
export declare const ACTIVE_RUN_STATUSES: readonly string[];

export declare function enqueueRunJobs(
  supabase: unknown,
  input: { runId: string; matterId: string; documentIds: string[] },
): Promise<number>;

export declare function haltRun(
  supabase: unknown,
  runId: string,
  status: string,
  reason: string | null,
  retryAfter?: number | null,
  error?: string | null,
): Promise<void>;
