// The queue half of a server-side Bucketizer run: the job type, the priority,
// the threshold, and the two writes the API makes against migration 079.
//
// WHY IT IS A SEPARATE MODULE FROM lib/bucketizer-run.mjs
// ---------------------------------------------------------------------------
// `lib/bucketizer-run.mjs` is the RUNNER, and it imports the Anthropic request
// builder, which imports the Anthropic SDK. /api/bucketizer-run.mjs needs none
// of that — it enqueues, reads and halts — and a Vercel function should not
// carry an SDK it never calls. So the small, shared, dependency-free half lives
// here and both sides import it.

/** The job type the worker answers. One job per document of a run. */
export const BUCKETIZER_JOB_TYPE = 'bucketizer_classify_document';

/**
 * BULK, spelled out rather than imported.
 *
 * `JOB_PRIORITY.BULK` lives in lib/ingest-core.mjs, and importing that module
 * into a Vercel function would drag the whole ingestion pipeline — pdfjs, the
 * ffmpeg shims, the OCR routes — into a bundle that needs none of it.
 * `scripts/_verify-bucketizer-server-run.mjs` asserts this equals
 * JOB_PRIORITY.BULK, so the two cannot drift apart silently.
 *
 * At -10 a 500-document run queues behind every interactive upload in every
 * matter, which is exactly what migration 057 built the priority for.
 */
export const BUCKETIZER_JOB_PRIORITY = -10;

/**
 * At or above this many documents, a run goes to the SERVER by default.
 *
 * Below it, the browser path is better and stays: it is immediate, it shows
 * every window as it lands, and it costs the shared queue nothing. A single
 * interactive classify must never wait behind somebody's production.
 *
 * Five is where "I am watching this" stops being true. Four documents is under
 * a minute; the fifth is where a person starts doing something else, and the
 * something else is usually closing the laptop.
 */
export const SERVER_RUN_MIN_DOCUMENTS = 5;

/** A run that is not finished, cancelled or failed. */
export const ACTIVE_RUN_STATUSES = Object.freeze(['queued', 'running', 'paused', 'held']);

/**
 * Enqueue one job per document, at BULK priority.
 *
 * Chunked, because a 500-row insert is one request and 500 requests is a
 * minute of a lawyer waiting at a button.
 */
export async function enqueueRunJobs(supabase, { runId, matterId, documentIds }) {
  let enqueued = 0;
  for (let i = 0; i < documentIds.length; i += 200) {
    const chunk = documentIds.slice(i, i + 200);
    const { error } = await supabase.from('processing_jobs').insert(
      chunk.map((documentId) => ({
        matterspace_id: matterId,
        job_type: BUCKETIZER_JOB_TYPE,
        priority: BUCKETIZER_JOB_PRIORITY,
        payload: { run_id: runId, document_id: documentId },
      })),
    );
    if (error) throw new Error(`could not queue the run: ${error.message}`);
    enqueued += chunk.length;
  }
  return enqueued;
}

/** Stop a run, with the sentence a person reads. Migration 079. */
export async function haltRun(supabase, runId, status, reason, retryAfter = null, error = null) {
  const { error: e } = await supabase.rpc('bucketizer_run_halt', {
    p_run: runId, p_status: status, p_reason: reason,
    p_retry_after: retryAfter, p_error: error,
  });
  if (e) throw new Error(`run halt: ${e.message}`);
}
