// What to say to a person whose document is still processing.
//
// Pure: no imports, no supabase, no React, no `import.meta.env`. That is the
// point — scripts/_verify-worker-heartbeat.mjs runs it under plain Node (type
// stripping, Node ≥ 22.18) and asserts every branch, which is not possible for
// anything that pulls in the browser client.
//
// The problem it solves (2026-09-19 ship-readiness audit)
// ---------------------------------------------------------------------------
// The Vault polls a document's row every 2 s and shows a spinner until the row
// turns terminal. If the Fly worker is down, that is forever. A spinner with no
// words is not neutral: the reasonable conclusion is that something the person
// did went wrong, so they delete the document and upload it again — which
// queues a second copy behind the first, and doubles the backlog that the
// outage will have to clear.

/** A worker beats every ~60 s (lib/worker-heartbeat.mjs); ten missed beats is an outage. */
export const WORKER_SILENT_SECONDS = 600;

/** Under ten minutes, a slow document is just a slow document. Say nothing. */
export const PROCESSING_PATIENCE_SECONDS = 600;

/** The shape migration 066's `ingest_status_for_me()` returns, in camelCase. */
export interface IngestServiceStatus {
  /** A worker process has written a heartbeat inside the liveness window. */
  workerAlive: boolean;
  /** Age of the most recent beat from any worker; null = none has ever beaten. */
  secondsSinceBeat: number | null;
  /** Jobs queued or running across the whole install (a count, nothing more). */
  queueDepth: number;
  /** Age of the oldest queued job, or null when the queue is empty. */
  oldestQueuedSeconds: number | null;
  /** The caller's own documents that have not reached a terminal state. */
  myProcessing: number;
  /** Age of the caller's oldest non-terminal document. */
  myOldestSeconds: number | null;
}

export interface IngestServiceNotice {
  tone: 'paused' | 'queued';
  text: string;
}

const PAUSED =
  'Processing is paused on our side. Your document is safe and will be processed when '
  + 'service resumes — you do not need to re-upload.';

/**
 * The sentence to show under a document that is still processing — or null,
 * which means "the spinner is telling the truth; leave it alone".
 *
 * Two honest things can be said, and they are not the same thing:
 *
 *   paused — nothing is running. Say that the file is safe and that
 *            re-uploading will not help, because re-uploading is exactly what
 *            the person is about to do.
 *   queued — something IS running and there is a line ahead. Give the depth and
 *            the age. The one number nobody here can honestly produce is
 *            "about 5 minutes remaining", so it is not offered.
 *
 * Null on a null status, which is the state whenever the pipeline's health
 * cannot be known — including every moment before migration 066 is applied. A
 * Vault running against a database without 066 therefore behaves exactly as it
 * does today, with no message and no error about its own health check.
 */
export function ingestServiceNotice(s: IngestServiceStatus | null | undefined): IngestServiceNotice | null {
  if (!s) return null;

  const mine = s.myOldestSeconds;
  if (mine === null || !Number.isFinite(mine) || mine < PROCESSING_PATIENCE_SECONDS) return null;

  const silent = s.secondsSinceBeat;

  // Down: beats were arriving and then stopped.
  if (!s.workerAlive && silent !== null && silent >= WORKER_SILENT_SECONDS) {
    return { tone: 'paused', text: PAUSED };
  }
  // Never beaten at all. From the reader's side this is the same outage — no
  // worker is reporting — but we must not claim to know for how long, so the
  // sentence carries no duration either.
  if (!s.workerAlive && silent === null) {
    return { tone: 'paused', text: PAUSED };
  }

  if (s.workerAlive && s.queueDepth > 1) {
    const waiting = s.oldestQueuedSeconds !== null && s.oldestQueuedSeconds >= 60
      ? `, the oldest waiting ${humanMinutes(s.oldestQueuedSeconds)}`
      : '';
    return {
      tone: 'queued',
      text: `Still working. There are ${s.queueDepth} documents in the queue${waiting}; `
          + `yours has been processing for ${humanMinutes(mine)}. It has not failed.`,
    };
  }

  // A worker is alive and the queue is short, but this document is old: slow,
  // not stuck. Say the age and nothing else.
  return {
    tone: 'queued',
    text: `Still working — this document has been processing for ${humanMinutes(mine)}. It has not failed.`,
  };
}

export function humanMinutes(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 6) / 10;
  return `${h} hour${h === 1 ? '' : 's'}`;
}
