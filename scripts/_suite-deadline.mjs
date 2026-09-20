// Deadlines and crash-survivable bookkeeping for the nightly ingestion suite.
//
// Why this exists (2026-09-18). The suite ran at 03:00, hung inside a gate,
// and was still hanging at 05:38 when it was Ctrl-C'd. `logs/ingest-suite.log`
// ends in "^C^C" and `logs/ingest-suite.jsonl` gained no line at all — so the
// night has no record: not a pass, not a fail, nothing. A watchdog that can
// stop answering is worse than no watchdog, because its silence looks like
// the silence of everything being fine.
//
// Three defences, and all three are needed because they fail differently:
//
//   1. withDeadline — a per-gate budget. The gate is abandoned, marked
//      failed-with-timeout, and the run CONTINUES, so one wedged gate costs
//      one gate instead of the night.
//   2. an overall budget, set well under Windows Task Scheduler's
//      ExecutionTimeLimit, so the suite ends itself and writes its record
//      rather than being terminated with the record unwritten.
//   3. writeCheckpoint — the ledger on disk after every gate. Task Scheduler
//      does not kill with a signal; it calls TerminateProcess, and no handler
//      of any kind runs. The only thing that survives that is a file that was
//      already written, so the checkpoint is what makes a 0xC000013A death
//      leave a parseable partial record.
//
// Nothing here talks to a network, a database or the clock beyond
// setTimeout/Date.now, so scripts/_verify-ingest-day-one.mjs drives it offline.

import fs from 'node:fs';
import path from 'node:path';

/** Resolved by withDeadline when the budget ran out. Never a valid result. */
export const TIMED_OUT = Symbol('suite-phase-timed-out');

/**
 * Run `fn` with a budget.
 *
 * Returns { timedOut: false, value, ms } when it finished in time,
 *         { timedOut: true,  ms } when the budget ran out first.
 * Rejects if `fn` rejects before the budget does — a real failure is still a
 * real failure and the caller decides what to do with it.
 *
 * A phase that loses the race keeps running: JavaScript has no way to stop an
 * await part-way, and pretending otherwise is how a "timeout" turns into an
 * unhandled rejection that kills the process a minute later, before the report
 * is written. So the abandoned promise gets a permanent catch handler here,
 * and `onAbandon` is told what it eventually threw.
 */
export async function withDeadline(fn, ms, { onAbandon = () => {} } = {}) {
  const started = Date.now();
  const running = (async () => fn())();
  // Attached immediately and unconditionally: from this moment the promise
  // has a rejection handler, so it can never become an unhandled rejection —
  // whether it settles before the budget (the race below sees it) or long
  // after (nobody is listening, and `abandoned` says to report it).
  let abandoned = false;
  running.catch((err) => { if (abandoned) onAbandon(err); });
  let timer = null;
  try {
    const outcome = await Promise.race([
      running,
      new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), Math.max(1, ms)); }),
    ]);
    if (outcome === TIMED_OUT) {
      abandoned = true;
      return { timedOut: true, ms: Date.now() - started };
    }
    return { timedOut: false, value: outcome, ms: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A countdown that fires once, `totalMs` from now, and can be cancelled.
 * unref'd so a suite that finishes early is not held open by its own alarm.
 */
export function startOverallDeadline(totalMs, onExpire) {
  const at = Date.now() + totalMs;
  const timer = setTimeout(() => { void onExpire(); }, Math.max(1, totalMs));
  timer.unref?.();
  return {
    at,
    remainingMs: () => Math.max(0, at - Date.now()),
    cancel: () => clearTimeout(timer),
  };
}

/**
 * Write the running ledger where a hard kill cannot erase it: a temp file in
 * the same directory, then a rename, so a reader never sees half a JSON
 * document however the process dies mid-write.
 *
 * Returns true when it landed. A checkpoint that cannot be written must never
 * fail the run it is only observing.
 */
export function writeCheckpoint(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Read a checkpoint back, or null when there isn't a readable one. */
export function readCheckpoint(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
