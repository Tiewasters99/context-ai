// GET /api/health — connector triage endpoint.
//
// One URL that answers "is the MCP server healthy, or is it my client's
// token?" in five seconds, from any device. When a connector (claude.ai,
// ChatGPT, Gemini, Grok — especially on mobile mid-trial-prep) can't reach
// Contextspaces, open https://www.contextspaces.ai/api/health in a browser:
//   - all checks ok  → the server is fine; the CLIENT's auth is stale.
//     Fix: remove + re-add / re-authenticate the connector on that device.
//   - a check failed → the named subsystem is down/misconfigured server-side.
//
// Public by design: it reports only presence/health booleans, never values,
// and touches nothing user-scoped. No auth so that it still works when auth
// itself is what broke.
//
// INGESTION (2026-09-20, migration 066)
// ---------------------------------------------------------------------------
// Until now this endpoint could say the database answers and still know
// nothing about whether anything was PROCESSING. The Fly worker could be down
// for a day — every upload sitting in 'pending', every Vault showing a
// spinner — and /api/health would return a cheerful 200. So it now also
// reports the three numbers that describe that outage: is a worker beating,
// how deep the queue is, and how old the oldest document that has not reached
// a terminal state is.
//
// UNAUTHENTICATED, AND NUMBERS ONLY — the decision and why
// ---------------------------------------------------------------------------
// The alternative was a HEALTH_TOKEN header for a "detailed view". Rejected:
//
//   * there is nothing to protect. `ingest_worker_status()` (066) returns six
//     integers and a boolean. No title, no filename, no matter, no user id,
//     and no argument in which to name one. A count of queued jobs tells a
//     stranger that this service has users, which the pricing page says too.
//   * a token makes the check fail exactly when it is needed. The free tier of
//     every uptime monitor (UptimeRobot, Better Stack, Pingdom, a GitHub
//     Actions curl) can fetch a URL and match a string; custom request headers
//     are a paid feature on several of them. A monitoring endpoint that only
//     privileged callers can read is a monitoring endpoint nobody monitors.
//   * a shared token in a monitor's config is another secret to rotate, for
//     data that is already aggregate.
//
// The line is therefore drawn at the shape of the data, not at a header: this
// endpoint may never learn anything tenant-scoped, and 066 is written so that
// it cannot. Anything per-document or per-owner goes to the monitor's digest
// (service role, Eden's mailbox), never here.
//
// STATUS CODE: an ingestion problem returns 200 with `degraded: true`, not
// 5xx. A 503 here means "this server cannot serve connectors" and the MCP
// triage flow at the top of this file depends on that meaning; a worker outage
// is a different fact, and collapsing the two would make every real outage
// look like an auth failure to the person reading the hint. Uptime monitors
// should therefore alert on the BODY — keyword `"degraded": true` — which is
// the one thing every free tier can do.

import { signJwt, verifyJwt, getOauthSecret } from '../lib/oauth-jwt.mjs';

const BUILD = '2026-09-20-health-v2-ingestion';

// A worker beats every ~60 s (lib/worker-heartbeat.mjs). Ten missed beats is
// not a blip: it is the audit's Definition of Done item 4, "worker down 10 min
// → the UI says so and an alert fires".
const WORKER_ALIVE_MINUTES = 10;
// "No document sits non-terminal > 30 min unnoticed" — same item.
const STUCK_DOCUMENT_MINUTES = 30;
// A long queue is not an outage. It is worth saying out loud, and worth saying
// differently from a dead worker, because the fix is different.
const DEEP_QUEUE = 50;

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const checks = {};

  // Env presence (booleans only — never values).
  checks.env = {
    supabase_url: !!(process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL),
    supabase_anon_key: !!process.env.VITE_SUPABASE_ANON_KEY,
    openai_api_key: !!process.env.OPENAI_API_KEY,
    google_api_key: !!process.env.GOOGLE_API_KEY,
    mcp_oauth_secret: false,
    mcp_signing_key: !!process.env.MCP_SIGNING_KEY_JWK_B64,
  };

  // OAuth secret usable end-to-end: present + sign/verify roundtrip works.
  // If this fails after an env change, every connector token is dead and
  // clients need re-auth (see lib/oauth-jwt.mjs getOauthSecret).
  try {
    const secret = getOauthSecret();
    const probe = signJwt({ typ: 'health', sub: 'probe' }, secret, 60);
    checks.env.mcp_oauth_secret = true;
    checks.oauth_sign_verify = !!verifyJwt(probe, secret);
  } catch {
    checks.oauth_sign_verify = false;
  }

  // Database reachable (anon key, no user data — RLS applies regardless).
  const t0 = Date.now();
  try {
    const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
    const r = await fetch(`${url}/rest/v1/matterspaces?select=id&limit=1`, {
      headers: { apikey: process.env.VITE_SUPABASE_ANON_KEY || '' },
    });
    checks.database = { reachable: r.ok || r.status === 401 || r.status === 400, status: r.status, ms: Date.now() - t0 };
  } catch (e) {
    checks.database = { reachable: false, error: e.message?.slice(0, 120), ms: Date.now() - t0 };
  }

  // Is anything actually processing uploads? (migration 066)
  checks.ingestion = await ingestionHealth();

  // OAuth discovery serves on this host (what MCP clients fetch first).
  checks.oauth_metadata_url = `https://${host}/.well-known/oauth-authorization-server`;

  const ok =
    Object.values(checks.env).every(Boolean) &&
    checks.oauth_sign_verify === true &&
    checks.database.reachable === true;

  // Deliberately NOT folded into `ok`: see the header. A worker outage is a
  // 200 with degraded:true, so a connector's triage hint stays truthful and an
  // uptime monitor alerts on the body.
  const degraded = checks.ingestion.degraded === true;

  res.statusCode = ok ? 200 : 503;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify({
    ok,
    degraded,
    hint: !ok
      ? 'Server-side problem — see failed checks.'
      : degraded
        ? `Connectors are fine; ingestion is degraded — ${checks.ingestion.reason}`
        : 'Server healthy. If a connector still fails, its token is stale — remove and re-add the connector on that device.',
    host,
    build: BUILD,
    checks,
  }, null, 2));
}

// Aggregate ingestion liveness, through 066's argument-free SECURITY DEFINER
// function called with the ANON key — the same key a logged-out browser has,
// so this endpoint can never see more than the function is willing to tell
// anybody. Every field below is a number or a boolean.
//
// Before 066 is pasted the RPC does not exist: PostgREST answers 404 /
// PGRST202. That is reported as `available: false` and is NOT degraded —
// "we cannot tell" must not page anyone, and it would otherwise alert every
// minute between this deploy and Eden's paste.
async function ingestionHealth() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    return { available: false, degraded: false, reason: 'no Supabase URL/anon key in this environment' };
  }
  try {
    const r = await fetch(`${url}/rest/v1/rpc/ingest_worker_status`, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ p_alive_minutes: WORKER_ALIVE_MINUTES }),
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 404) {
      return { available: false, degraded: false, reason: 'migration 066 is not applied yet (ingest_worker_status missing)' };
    }
    if (!r.ok) {
      return { available: false, degraded: false, reason: `ingest_worker_status returned ${r.status}` };
    }
    const body = await r.json();
    const row = Array.isArray(body) ? body[0] : body;
    if (!row) return { available: false, degraded: false, reason: 'ingest_worker_status returned no row' };

    const num = (v) => (v === null || v === undefined ? null : Number(v));
    const workerAlive = row.worker_alive === true;
    const secondsSinceBeat = num(row.seconds_since_beat);
    const queueDepth = num(row.queue_depth) ?? 0;
    const oldestQueued = num(row.oldest_queued_seconds);
    const processing = num(row.documents_processing) ?? 0;
    const oldestProcessing = num(row.oldest_processing_seconds);

    // A brand-new database has never seen a beat. Unknown is not down: say so
    // and do not fire. The first beat after a worker deploy settles it.
    const neverBeaten = secondsSinceBeat === null;
    const stuck = oldestProcessing !== null && oldestProcessing > STUCK_DOCUMENT_MINUTES * 60;
    const deepQueue = queueDepth >= DEEP_QUEUE;
    const workerDown = !workerAlive && !neverBeaten;

    const reasons = [];
    if (workerDown) reasons.push(`no worker heartbeat for ${Math.round(secondsSinceBeat / 60)} min`);
    if (stuck) reasons.push(`a document has been processing for ${Math.round(oldestProcessing / 60)} min`);
    if (deepQueue) reasons.push(`${queueDepth} jobs queued`);

    return {
      available: true,
      degraded: workerDown || stuck,
      worker_alive: workerAlive,
      workers_beating: num(row.workers_beating) ?? 0,
      seconds_since_beat: secondsSinceBeat,
      alive_window_minutes: WORKER_ALIVE_MINUTES,
      queue_depth: queueDepth,
      oldest_queued_seconds: oldestQueued,
      documents_processing: processing,
      oldest_processing_seconds: oldestProcessing,
      stuck_threshold_seconds: STUCK_DOCUMENT_MINUTES * 60,
      deep_queue: deepQueue,
      reason: reasons.length
        ? reasons.join('; ')
        : neverBeaten
          ? 'no worker has ever reported in (deploy the Fly worker with the 066 heartbeat)'
          : 'processing normally',
    };
  } catch (e) {
    // The probe failing is not evidence that the worker failed.
    return { available: false, degraded: false, reason: `probe failed: ${String(e?.message || e).slice(0, 120)}` };
  }
}
