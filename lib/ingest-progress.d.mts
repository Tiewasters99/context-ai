// Types for lib/ingest-progress.mjs — the browser bundle imports that module
// directly (src/components/vault/IngestProgress.tsx) so the bar on a Vault row
// and the harness read the worker's note with one function.

export const INGEST_WHY: string;
export const INGEST_WHY_SHORT: string;

export interface ProgressNoteCount {
  done?: number;
  total?: number;
  pageCount?: number;
  passages?: number;
}

export function parseProgressNote(note: unknown): ProgressNoteCount | null;

export interface IngestProgressInput {
  /** documents.processing_status. */
  stage?: string | null;
  /** processing_jobs.progress — the worker's integer, a floor only. */
  progress?: number | null;
  /** processing_jobs.progress_note — the worker's sentence. */
  note?: string | null;
  /** documents.page_count, once known. */
  pageCount?: number | null;
  /** processing_jobs.attempts; above 1 the row is a retry. */
  attempts?: number | null;
}

export interface IngestProgressReading {
  /** 0–100; 100 only at ready. */
  pct: number;
  /** The words beside the bar. */
  label: string;
  /** The worker's own sentence, for hover; null when it has said nothing. */
  detail: string | null;
  /** The page fraction when the note counts one. */
  pages: { done: number; total: number } | null;
  /** Nothing counts yet: the bar pulses rather than claims a number. */
  indeterminate: boolean;
  /** A worker attempt failed and this is a later one. */
  retrying: boolean;
}

export function readIngestProgress(input?: IngestProgressInput): IngestProgressReading;
