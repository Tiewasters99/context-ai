// GET /api/merch-release — the sweep that sends held merch orders to the
// printer once their cancellation window has passed
// (MERCH_SEND_TO_PRODUCTION=window; lib/merch-window.mjs). Vercel runs it on
// the schedule in vercel.json ("crons"), on production deployments only, as
// Vercel crons are.
//
// For every merch_orders row still `placed` whose placed_at is older than
// MERCH_CANCEL_WINDOW_MIN: a conditional claim placed → in_production (the
// same claim a buyer's cancel makes the other way, so exactly one of them
// wins), then Printify's send_to_production. If Printify refuses, the row
// goes back to `placed` with the error and the next sweep tries again.
//
// With CRON_SECRET set, the call must carry it (Vercel sends it as a bearer).
// Without it the door is open, which is harmless: the sweep only does what
// the schedule does anyway, to orders whose window has already passed.
//
// Plain fetch with an injectable fetchImpl, like the webhook, so
// scripts/_test-merch-api.mjs drives this file with no network.

import { json, SUPABASE_URL, SERVICE_KEY } from '../lib/account-security.mjs';
import { printifyConfigured, sendOrderToProduction } from '../lib/printify.mjs';
import { productionMode, cancelWindowMin } from '../lib/merch-window.mjs';

const LOG = '[merch-release]';
const TIMEOUT_MS = 8000;
const BATCH = 50;
const base = () => String(SUPABASE_URL() || '').replace(/\/$/, '');

async function orders(method, query, body, doFetch) {
  try {
    const res = await doFetch(`${base()}/rest/v1/merch_orders?${query}`, {
      method,
      headers: {
        'content-type': 'application/json',
        apikey: SERVICE_KEY(),
        authorization: `Bearer ${SERVICE_KEY()}`,
        prefer: 'return=representation',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, rows: null, error: data?.message ?? `write_${res.status}` };
    return { ok: true, rows: Array.isArray(data) ? data : [data], error: null };
  } catch (err) {
    return { ok: false, rows: null, error: err?.message || 'unreachable' };
  }
}

export default async function handler(req, res, deps = {}) {
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const env = deps.env || process.env;
  const nowMs = deps.nowMs || Date.now();
  const ctx = { fetchImpl: doFetch, env };
  if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  if (env.CRON_SECRET && req.headers?.authorization !== `Bearer ${env.CRON_SECRET}`) return json(res, 401, { error: 'unauthorized' });

  const mode = productionMode(env);
  if (mode !== 'window') return json(res, 200, { mode, released: 0 });
  if (!printifyConfigured(env)) return json(res, 503, { error: 'merch_not_configured' });
  if (!SERVICE_KEY() || !SUPABASE_URL()) return json(res, 500, { error: 'config_error' });

  const cutoff = new Date(nowMs - cancelWindowMin(env) * 60_000).toISOString();
  const due = await orders('GET',
    `status=eq.placed&placed_at=lt.${encodeURIComponent(cutoff)}&order=placed_at.asc&limit=${BATCH}&select=id,printify_order_id,placed_at`,
    null, doFetch);
  if (!due.ok) return json(res, 503, { error: 'storage_unavailable', message: due.error });

  let released = 0;
  let failed = 0;
  for (const row of due.rows) {
    if (!row.printify_order_id) continue;
    // The claim: only a row still `placed` moves. A buyer who cancelled a
    // moment ago has already taken it the other way.
    const claim = await orders('PATCH', `id=eq.${row.id}&status=eq.placed`,
      { status: 'in_production', sent_to_production_at: new Date(nowMs).toISOString(), error: null }, doFetch);
    if (!claim.ok || claim.rows.length === 0) continue;
    try {
      await sendOrderToProduction(row.printify_order_id, ctx);
      released += 1;
    } catch (err) {
      const msg = err?.message || 'Printify refused';
      console.error(`${LOG} ${row.id} not sent to production: ${msg}`);
      await orders('PATCH', `id=eq.${row.id}`, { status: 'placed', sent_to_production_at: null, error: `not sent to production: ${msg}` }, doFetch);
      failed += 1;
    }
  }
  if (released || failed) console.log(`${LOG} released ${released}, failed ${failed}, cutoff ${cutoff}`);
  return json(res, 200, { mode, cutoff, released, failed });
}
