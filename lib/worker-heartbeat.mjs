// Proof of life for the ingestion worker (migration 066).
//
// Why this is a module and not four lines in the worker
// ---------------------------------------------------------------------------
// The worker's main loop is `for (;;)` at the top level of
// worker/discovery-worker.mjs, so importing that file STARTS a worker. Nothing
// in it can be unit-tested. The one rule this code has to obey — a heartbeat
// failure must never stop the worker — is therefore untestable in place, which
// is the opposite of what a safety property needs. It lives here instead, and
// the worker's hunk is three lines.
//
// The rule, stated precisely
// ---------------------------------------------------------------------------
// `beat()` returns undefined, synchronously, always. It never throws, never
// returns a promise, and is never awaited. Three ways a Supabase call can go
// wrong are each handled:
//
//   1. it throws synchronously (`client.from` is undefined, a bad URL) — the
//      whole body is inside try/catch;
//   2. it returns a rejected promise (network down, 401) — a rejection handler
//      is attached in the same tick, so it can never be an unhandled rejection
//      (which in Node 22 would exit the process, i.e. stop the worker);
//   3. it never settles at all — supabase-js has no request timeout, and the
//      worker's client sets none. An awaited beat that hangs would stall the
//      queue for every tenant, which is the very outage this exists to report.
//      So the in-flight guard expires on its own timer and the next beat is
//      allowed through.
//
// Throttling: beat() is safe to call as often as the caller likes. It writes
// at most once per `minIntervalMs` unless `force` is passed, so the idle loop
// can call it every poll (5 s) and a job completion can call it directly.

/** How often a beat is actually written, absent `force`. */
export const DEFAULT_BEAT_MS = 60_000;

/**
 * How long an in-flight write may block the next one. Past this the guard is
 * released even though the old write may still be out there: a duplicate
 * upsert of the same key is harmless, and a permanently-wedged socket must not
 * make the worker look dead while it is in fact working.
 */
export const DEFAULT_INFLIGHT_TIMEOUT_MS = 15_000;

/**
 * Build the beater.
 *
 * @param {object}   o
 * @param {object}   o.client        supabase-js client (service role).
 * @param {string}   o.workerId      primary key — the worker's own id.
 * @param {string}  [o.machineId]    Fly machine id, for a human reading rows.
 * @param {string}  [o.release]      Fly image ref / release, same purpose.
 * @param {number}  [o.minIntervalMs]
 * @param {number}  [o.inflightTimeoutMs]
 * @param {Function}[o.log]          called with a one-line string on failure.
 * @param {Function}[o.now]          injectable clock (tests).
 * @returns {{ beat: Function, stats: Function }}
 */
export function createHeartbeat({
  client,
  workerId,
  machineId = null,
  release = null,
  minIntervalMs = DEFAULT_BEAT_MS,
  inflightTimeoutMs = DEFAULT_INFLIGHT_TIMEOUT_MS,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  const startedAt = new Date(now()).toISOString();
  let lastAttemptAt = 0;
  let inflight = false;
  let inflightSince = 0;
  let jobsDone = 0;
  let lastJobAt = null;
  let ok = 0;
  let failed = 0;

  function release_() { inflight = false; }

  function beat({ force = false, jobDone = false, queueDepth = null, oldestQueuedAt = null } = {}) {
    try {
      if (jobDone) {
        jobsDone += 1;
        lastJobAt = new Date(now()).toISOString();
      }
      const t = now();
      // A guard that could stick would silence the worker permanently, so it
      // expires by the clock rather than by the promise settling.
      if (inflight && t - inflightSince < inflightTimeoutMs) return;
      if (!force && t - lastAttemptAt < minIntervalMs) return;
      lastAttemptAt = t;
      inflight = true;
      inflightSince = t;

      const row = {
        worker_id: workerId,
        machine_id: machineId,
        worker_release: release,
        started_at: startedAt,
        last_beat_at: new Date(t).toISOString(),
        last_job_at: lastJobAt,
        jobs_done: jobsDone,
        queue_depth: queueDepth,
        oldest_queued_at: oldestQueuedAt,
      };

      // `client.from(...)` itself can throw; it is inside the try.
      const pending = client.from('worker_heartbeats').upsert(row, { onConflict: 'worker_id' });

      // Attach the handlers in this same tick. Promise.resolve() also covers a
      // client that returns a plain object or a non-promise thenable.
      Promise.resolve(pending).then(
        (res) => {
          release_();
          if (res && res.error) {
            failed += 1;
            // The expected shape before Eden pastes 066: PGRST205 / 42P01, the
            // table does not exist. Said once per failure, never retried in a
            // loop — a worker that cannot report its health still works.
            log(`heartbeat: ${res.error.message || res.error}`);
          } else {
            ok += 1;
          }
        },
        (err) => {
          release_();
          failed += 1;
          log(`heartbeat: ${err?.message || err}`);
        },
      );
    } catch (err) {
      release_();
      failed += 1;
      try { log(`heartbeat: ${err?.message || err}`); } catch { /* even the log is optional */ }
    }
    return undefined;
  }

  return {
    beat,
    stats: () => ({ ok, failed, jobsDone, inflight, startedAt }),
  };
}
