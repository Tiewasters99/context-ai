// When a paid merch order goes to the printer — MERCH_SEND_TO_PRODUCTION:
//
//   '1'       now: the Grapheon webhook sends it to production the moment
//             it is placed. No cancellation.
//   'window'  after a cancellation window: the order waits on hold at
//             Printify and api/merch-release (a Vercel cron) sends it once
//             MERCH_CANCEL_WINDOW_MIN minutes (default 60) have passed.
//             Until then the buyer can cancel it from Your orders, for a
//             full refund (api/merch action `cancel`).
//   unset     hold: it waits in the shop until a hand sends it — the test
//             loop the spec describes. Cancel still works.
//
// Shared by api/grapheon-webhook.mjs, api/merch.mjs and api/merch-release.mjs
// so the three agree on what the setting means.

export function productionMode(env = process.env) {
  const v = String(env.MERCH_SEND_TO_PRODUCTION ?? '').trim().toLowerCase();
  if (v === '1') return 'now';
  if (v === 'window') return 'window';
  return 'hold';
}

/** Minutes a placed order waits before the sweep sends it to production. */
export function cancelWindowMin(env = process.env) {
  const n = Number(env.MERCH_CANCEL_WINDOW_MIN);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 60;
}

/**
 * When a held order leaves the buyer's hands: placed_at + the window in
 * window mode; null when it waits for a hand (hold) or never waited (now).
 */
export function cancelUntil(row, env = process.env) {
  if (!row || row.status !== 'placed' || !row.placed_at || productionMode(env) !== 'window') return null;
  const t = Date.parse(row.placed_at);
  return Number.isFinite(t) ? new Date(t + cancelWindowMin(env) * 60_000).toISOString() : null;
}
