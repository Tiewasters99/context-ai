// The browser's side of a run that does not need the browser.
//
// Everything here is a thin call to /api/bucketizer-run. The surface starts a
// run, then reads the RUN ROW for progress — never its own counters — which is
// the whole point: close the tab, open it on another machine tomorrow, and the
// progress line says the same thing because it is reading the same row.
//
// `startServerRun` is allowed to say "not here". Between merging this and
// deploying the Fly worker the endpoint answers 503 with a sentence, and the
// surface falls back to the browser loop it has always had. A refusal to start
// on the server is never a refusal to classify.

import { llmAuthHeader } from '@/lib/llm/auth';

export { SERVER_RUN_MIN_DOCUMENTS } from '../../../lib/bucketizer-run-queue.mjs';

export type ServerRunStatus =
  | 'queued' | 'running' | 'paused' | 'held' | 'done' | 'cancelled' | 'failed';

export interface ServerRun {
  id: string;
  matterspace_id: string;
  kind: 'classify' | 'evidence';
  requested_by: string | null;
  model_id: string | null;
  status: ServerRunStatus;
  estimate_cents: number;
  documents_total: number;
  documents_done: number;
  documents_skipped: number;
  documents_failed: number;
  windows_called: number;
  windows_resumed: number;
  proposed: number;
  /** The SERVER's own sentence for why it stopped. Never a code. */
  pause_reason: string | null;
  retry_after_seconds: number | null;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface ServerRunDocument {
  document_id: string;
  title: string | null;
  status: 'queued' | 'running' | 'done' | 'skipped' | 'failed' | 'held' | 'cancelled';
  note: string | null;
  proposed: number;
}

export interface ServerRunState {
  run: ServerRun | null;
  documents: ServerRunDocument[];
  /** The run says it is going, but nothing is queued or claimed for it. */
  stalled: boolean;
}

/** A refusal that still knows what the server said, so a person can read it. */
export class ServerRunError extends Error {
  status: number;
  code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ServerRunError';
    this.status = status;
    this.code = code;
  }

  /**
   * The server has not been switched on for background runs yet (or is not
   * configured for them). The surface answers this by running in the tab
   * instead — which is not a degradation, it is what it did yesterday.
   */
  get shouldFallBackToBrowser(): boolean {
    return this.code === 'server_runs_not_enabled' || this.code === 'config_error';
  }
}

async function call<T>(payload: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api/bucketizer-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await llmAuthHeader()) },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new ServerRunError('The server could not be reached.', 0, 'network');
  }
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  const body = (parsed && typeof parsed === 'object' ? parsed : {}) as {
    error?: unknown; message?: unknown;
  };
  if (!res.ok) {
    throw new ServerRunError(
      typeof body.message === 'string' ? body.message
        : typeof body.error === 'string' ? body.error
          : `The server answered ${res.status}.`,
      res.status,
      typeof body.error === 'string' ? body.error : null,
    );
  }
  return parsed as T;
}

export async function startServerRun(input: {
  matterId: string;
  documentIds: string[];
  modelId: string;
  estimateCents: number;
}): Promise<ServerRun> {
  const out = await call<{ run: ServerRun }>({ action: 'start', ...input });
  return out.run;
}

/** The current run on this matter, or null. The read a reload makes. */
export async function fetchServerRun(matterId: string): Promise<ServerRunState> {
  const out = await call<ServerRunState>({ action: 'status', matterId });
  return { run: out.run ?? null, documents: out.documents ?? [], stalled: Boolean(out.stalled) };
}

export async function cancelServerRun(matterId: string, runId: string): Promise<ServerRun | null> {
  const out = await call<{ run: ServerRun | null }>({ action: 'cancel', matterId, runId });
  return out.run ?? null;
}

export async function resumeServerRun(matterId: string, runId: string): Promise<ServerRun | null> {
  const out = await call<{ run: ServerRun | null }>({ action: 'resume', matterId, runId });
  return out.run ?? null;
}

/** Should this run go to the server? One rule, used by the surface only. */
export function shouldRunOnServer(documentCount: number, threshold: number): boolean {
  return documentCount >= threshold;
}

/**
 * The closing report, in plain language.
 *
 * Documents done, documents skipped WITH THEIR REASONS, documents failed. A
 * run that reports "412 documents" and nothing else is a run whose gaps the
 * attorney will find at trial.
 */
export function describeServerRun(state: ServerRunState): string[] {
  const { run } = state;
  if (!run) return [];
  const lines: string[] = [];
  lines.push(
    `${run.documents_done} of ${run.documents_total} document${run.documents_total === 1 ? '' : 's'} classified`
    + `, ${run.proposed} proposal${run.proposed === 1 ? '' : 's'} written.`,
  );
  if (run.documents_skipped) lines.push(`${run.documents_skipped} skipped — see the reasons below.`);
  if (run.documents_failed) lines.push(`${run.documents_failed} could not be read.`);
  if (run.windows_resumed) {
    lines.push(`${run.windows_resumed} part${run.windows_resumed === 1 ? '' : 's'} were already done and were not paid for again.`);
  }
  if (run.pause_reason) lines.push(run.pause_reason);
  if (run.last_error) lines.push(run.last_error);
  return lines;
}
