// Grapheon Discovery — bounded concurrency that keeps the production's order.
//
// Stamping and packaging used to handle one document at a time: download,
// stamp or render, upload, next. On the live worker that was 0.68 s a page to
// stamp and 1.37 s a page to package (2026-10-13), most of it waiting on
// storage round trips, so a 9,000-page production could not finish inside the
// job watchdog. These two helpers let several documents be in flight at once
// without changing anything a reader of the production can see: Bates order,
// the load file's row order and the ZIP's entry order are exactly what one at
// a time produced, because results are RELEASED in input order however they
// finish.

/** Concurrency for stamping and packaging: DISCOVERY_CONCURRENCY, default 6, 1–32. */
export function discoveryConcurrency(env = process.env) {
  const n = Number.parseInt(env.DISCOVERY_CONCURRENCY ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 32) : 6;
}

/**
 * Run `work(item, i)` over `items` with at most `concurrency` in flight, and
 * hand each result to `release(result, item, i)` strictly in input order, one
 * release at a time (each awaited before the next).
 *
 * Memory is bounded: no new work starts while `window` results are finished
 * but still waiting for an earlier one to release, so a slow document holds up
 * at most `window` buffered results, not the whole production.
 *
 * The first failure (in work or release) stops new work from starting; work
 * already in flight is allowed to settle, then the failure is thrown. Nothing
 * after the failed index is released.
 *
 * @template T, R
 * @param {T[]} items
 * @param {{ concurrency?: number, window?: number }} opts
 * @param {(item: T, i: number) => Promise<R>} work
 * @param {(result: R, item: T, i: number) => Promise<void>|void} release
 */
export async function runOrdered(items, { concurrency = 6, window } = {}, work, release) {
  const limit = Math.max(1, concurrency | 0);
  const maxBuffered = Math.max(limit, (window ?? limit * 2) | 0);
  const done = new Map();          // index -> result, finished but not released
  let next = 0;                    // next index to start
  let releaseAt = 0;               // next index to release
  let running = 0;
  let failure = null;
  let releasing = false;

  return new Promise((resolve, reject) => {
    const finish = () => {
      if (running > 0 || releasing) return;
      if (failure) reject(failure.err);
      else if (releaseAt >= items.length) resolve();
    };

    const drainReleases = async () => {
      if (releasing) return;
      releasing = true;
      try {
        while (!failure && done.has(releaseAt)) {
          const r = done.get(releaseAt);
          done.delete(releaseAt);
          await release(r, items[releaseAt], releaseAt);
          releaseAt += 1;
        }
      } catch (err) {
        failure ??= { err };
      } finally {
        releasing = false;
      }
      pump();
      finish();
    };

    const pump = () => {
      while (!failure && running < limit && next < items.length && done.size + running < maxBuffered) {
        const i = next++;
        running += 1;
        Promise.resolve()
          .then(() => work(items[i], i))
          .then((r) => { done.set(i, r); }, (err) => { failure ??= { err, i }; })
          .finally(() => {
            running -= 1;
            void drainReleases();
          });
      }
      finish();
    };

    if (items.length === 0) { resolve(); return; }
    pump();
  });
}

/**
 * Concurrent map, results in input order. For side-effecting work whose order
 * of completion does not matter (each document stamps its own pre-allocated
 * numbers), but whose results are read in order afterwards.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, i: number) => Promise<R>} work
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, concurrency, work) {
  const out = new Array(items.length);
  await runOrdered(items, { concurrency, window: Math.max(concurrency, items.length) }, work, (r, _item, i) => { out[i] = r; });
  return out;
}
