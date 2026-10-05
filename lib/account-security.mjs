// Settings → Account, server side: the second factor's Record rows and the
// devices list (docs/specs/SECURITY-BUILD-2026-09-26.md §S1).
//
// Two endpoints use this — api/account-factor-event.mjs and
// api/account-sessions.mjs — and both start the same way every other api/
// file does: the bearer is the caller's own Supabase access token, and
// Supabase Auth is asked who it belongs to before anything else happens.
//
// Enrolment, challenge and verify happen in the browser (supabase-js talks to
// Supabase Auth directly; there is no server step to hang a record on). So
// the browser reports each one here AFTER it succeeds, and this file writes
// the row only once it has checked the claim against Supabase Auth's own
// answer: an enrolled factor must be on the account and verified, a removed
// one must be gone, a step-up must be carried by a token that says aal2.
// A browser can therefore fail to report — that is a missing row, and the
// Record says nothing false — but it cannot report something that did not
// happen.
//
// Plain fetch, not supabase-js, for lib/billing.mjs's reasons: one round trip
// per call, and an injectable fetch is what lets scripts/_verify-stepup-seal.mjs
// drive these handlers with no network.

import { recordAccount } from './ledger.mjs';

const TIMEOUT_MS = 5000;

export const SUPABASE_URL = () => process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
export const ANON_KEY = () => process.env.VITE_SUPABASE_ANON_KEY;
export const SERVICE_KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

const base = () => String(SUPABASE_URL() || '').replace(/\/$/, '');

export function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  return res.end(JSON.stringify(obj));
}

export function corsPreflight(req, res, methods) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', methods);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

export function bearerFrom(req) {
  const h = req?.headers?.authorization || req?.headers?.Authorization;
  if (!h || !String(h).toLowerCase().startsWith('bearer ')) return null;
  return String(h).slice(7).trim() || null;
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/**
 * The whole user, as Supabase Auth sees it — including `factors`, which is
 * the authoritative answer to "is this factor enrolled and verified". Null
 * when the token is missing, expired or not Supabase's.
 */
export async function authUser(bearer, { fetchImpl = null } = {}) {
  if (!bearer || !SUPABASE_URL() || !ANON_KEY()) return null;
  const doFetch = fetchImpl || globalThis.fetch;
  try {
    const res = await doFetch(`${base()}/auth/v1/user`, {
      headers: { apikey: ANON_KEY(), authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

/**
 * The token's claims. Read ONLY after authUser() has accepted the same token:
 * Supabase Auth has then checked the signature and the expiry, and what is
 * left is reading the fields it signed (aal, session_id, amr).
 */
export function jwtClaims(bearer) {
  try {
    const part = String(bearer).split('.')[1];
    return part ? JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) : {};
  } catch {
    return {};
  }
}

/** A PostgREST RPC as the SERVICE role (the devices functions are service-only). */
export async function serviceRpc(fn, args, { fetchImpl = null } = {}) {
  if (!SUPABASE_URL() || !SERVICE_KEY()) return { ok: false, status: 0, data: null, error: 'supabase_env_missing' };
  const doFetch = fetchImpl || globalThis.fetch;
  try {
    const res = await doFetch(`${base()}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SERVICE_KEY(),
        authorization: `Bearer ${SERVICE_KEY()}`,
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) return { ok: false, status: res.status, data, error: data?.code || data?.message || `rpc_${res.status}` };
    return { ok: true, status: res.status, data, error: null };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err?.message || 'rpc_unreachable' };
  }
}

/**
 * A supabase-shaped client with only `.rpc`, AS THE USER — which is what
 * lib/ledger.mjs recordAccount() needs: ledger_append_account takes the
 * chain and the byline from auth.uid(), so the row can only ever land on the
 * caller's own account chain.
 */
export function userRpcClient(bearer, { fetchImpl = null } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  return {
    async rpc(fn, args) {
      try {
        const res = await doFetch(`${base()}/rest/v1/rpc/${fn}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            apikey: ANON_KEY(),
            authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify(args ?? {}),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const text = await res.text().catch(() => '');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        if (!res.ok) {
          return { data: null, error: { code: data?.code ?? String(res.status), message: data?.message ?? `rpc_${res.status}` } };
        }
        return { data, error: null };
      } catch (err) {
        return { data: null, error: { message: err?.message || 'rpc_unreachable' } };
      }
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FACTOR_TYPES = new Set(['totp', 'webauthn']);

export const FACTOR_EVENT_KINDS = Object.freeze([
  'auth.factor_enrolled', 'auth.factor_unenrolled', 'auth.stepup',
]);

/** Which kind of factor the session's latest aal2 step used, from `amr`. */
function stepupMethod(claims) {
  const amr = Array.isArray(claims?.amr) ? claims.amr : [];
  const latest = amr
    .filter((a) => a && typeof a.method === 'string')
    .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
    .find((a) => /totp|webauthn/.test(a.method));
  if (!latest) return null;
  return latest.method.includes('webauthn') ? 'webauthn' : 'totp';
}

/**
 * Check the browser's report against Supabase Auth and, if it holds, write
 * the row. Returns {status, body} for the handler to send.
 */
export async function recordFactorEvent({ bearer, body = {}, fetchImpl = null, ledgerClient = null }) {
  const kind = String(body.kind ?? '');
  if (!FACTOR_EVENT_KINDS.includes(kind)) return { status: 400, body: { error: 'unknown_kind' } };

  const user = await authUser(bearer, { fetchImpl });
  if (!user) return { status: 401, body: { error: 'invalid_session' } };

  const factors = Array.isArray(user.factors) ? user.factors : [];
  const factorId = typeof body.factor_id === 'string' && UUID_RE.test(body.factor_id) ? body.factor_id : null;
  let payload;

  if (kind === 'auth.factor_enrolled') {
    const f = factors.find((x) => x?.id === factorId);
    if (!f || f.status !== 'verified') return { status: 409, body: { error: 'factor_not_verified' } };
    payload = { factor_id: f.id, factor_type: f.factor_type ?? null };
  } else if (kind === 'auth.factor_unenrolled') {
    if (!factorId) return { status: 400, body: { error: 'factor_id_required' } };
    if (factors.some((x) => x?.id === factorId)) return { status: 409, body: { error: 'factor_still_enrolled' } };
    const t = FACTOR_TYPES.has(body.factor_type) ? body.factor_type : null;
    payload = { factor_id: factorId, factor_type: t };
  } else {
    const claims = jwtClaims(bearer);
    if (claims.aal !== 'aal2') return { status: 409, body: { error: 'not_stepped_up' } };
    let matterId = typeof body.matter_id === 'string' && UUID_RE.test(body.matter_id) ? body.matter_id : null;
    // The browser names the matter whose door the step-up opened. Kept only
    // if that matter exists and this person belongs to it (094's probe, asked
    // as the person); otherwise the step-up is recorded without it — a person
    // must not be able to write another matter's id into their own Record.
    if (matterId) {
      const probe = await (ledgerClient ?? userRpcClient(bearer, { fetchImpl }))
        .rpc('matter_entry', { p_matter: matterId });
      if (probe?.error || !['open', 'stepup', 'enrol'].includes(probe?.data)) matterId = null;
    }
    payload = { factor_type: stepupMethod(claims), matter_id: matterId };
  }

  const result = await recordAccount(ledgerClient ?? userRpcClient(bearer, { fetchImpl }), {
    kind,
    actor: { kind: 'user', ref: user.id, user_id: user.id },
    payload,
  });
  // Not deployed (094 or 072 not pasted yet) is not the browser's problem:
  // the factor itself worked, and the ledger has already said so in its log.
  return { status: 200, body: { recorded: Boolean(result.ok), not_deployed: Boolean(result.notDeployed) } };
}

/** Name the browser and the system from a user agent, without a library. */
export function describeUserAgent(ua) {
  const s = String(ua || '');
  if (!s) return 'Unknown device';
  const browser =
    /Edg\//.test(s) ? 'Edge'
      : /OPR\/|Opera/.test(s) ? 'Opera'
        : /Firefox\//.test(s) ? 'Firefox'
          : /Chrome\//.test(s) ? 'Chrome'
            : /Safari\//.test(s) ? 'Safari'
              : null;
  const system =
    /iPhone/.test(s) ? 'iPhone'
      : /iPad/.test(s) ? 'iPad'
        : /Android/.test(s) ? 'Android'
          : /Windows/.test(s) ? 'Windows'
            : /Mac OS X|Macintosh/.test(s) ? 'Mac'
              : /Linux/.test(s) ? 'Linux'
                : null;
  if (browser && system) return `${browser} on ${system}`;
  return browser || system || s.slice(0, 60);
}
