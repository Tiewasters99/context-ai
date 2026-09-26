// The billing endpoints' shared middle: who is asking, what the plans and
// packs are, and how to say "not configured" the same way every time.
//
// It speaks PostgREST directly rather than importing @supabase/supabase-js, for
// the same two reasons lib/usage-meter.mjs does: the client is a real cold-start
// cost on a function whose whole job is one round trip, and a plain `fetch` is
// injectable, which is what lets scripts/_verify-billing.mjs drive the REAL
// handlers against a real Postgres with no network and no Stripe account.
//
// Dormancy is the default. There is no Stripe account yet (2026-09-20), so
// every endpoint that imports this answers 503 `billing_not_configured` until
// STRIPE_SECRET_KEY is set — the same convention lib/mediation-core.mjs uses to
// waive the mediation fee when Stripe is absent. Nothing half-works: the UI
// renders a quiet "Billing is not yet enabled" panel and no button lies.

import { stripeConfigured } from './stripe-core.mjs';
import { isSealedTier, walkEffectiveTier } from './ai-tier-policy.mjs';

const TIMEOUT_MS = 5000;
export const LOG = '[billing]';

export const SUPABASE_URL = () => process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
export const ANON_KEY = () => process.env.VITE_SUPABASE_ANON_KEY;
export const SERVICE_KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

export function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}

/** The one refusal every endpoint gives while Stripe does not exist. */
export function notConfigured(res, detail = 'STRIPE_SECRET_KEY is not set on this deployment.') {
  return json(res, 503, {
    error: 'billing_not_configured',
    message: 'Billing is not yet enabled on this deployment.',
    detail,
  });
}

export function corsPreflight(req, res, methods = 'POST, OPTIONS') {
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

export function isConfigured(env = process.env) {
  return stripeConfigured(env) && Boolean(SUPABASE_URL()) && Boolean(SERVICE_KEY());
}

/** Whatever JSON body arrived, however the platform chose to hand it over. */
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
 * Who is asking. The bearer is the caller's own Supabase access token; this
 * asks Supabase Auth to turn it into a user, which is exactly what
 * supabase-js's getUser() does underneath.
 */
export async function verifyUser(bearer, { fetchImpl = null, timeoutMs = TIMEOUT_MS } = {}) {
  const url = SUPABASE_URL();
  const anon = ANON_KEY();
  if (!url || !anon || !bearer) return null;
  const doFetch = fetchImpl || globalThis.fetch;
  try {
    const res = await doFetch(`${url.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: anon, authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user?.id ? { id: user.id, email: user.email || null } : null;
  } catch {
    return null;
  }
}

/** The bearer token out of the Authorization header, or null. */
export function bearerFrom(req) {
  const h = req?.headers?.authorization || req?.headers?.Authorization;
  if (!h || !String(h).toLowerCase().startsWith('bearer ')) return null;
  return String(h).slice(7).trim() || null;
}

/** A PostgREST GET. `key` decides whose eyes: the user's token, or the service key. */
export async function pgSelect(path, { bearer, apikey = null, fetchImpl = null, timeoutMs = TIMEOUT_MS } = {}) {
  const url = SUPABASE_URL();
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(`${url.replace(/\/$/, '')}/rest/v1/${path}`, {
    headers: {
      apikey: apikey || ANON_KEY(),
      authorization: `Bearer ${bearer}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

/** A PostgREST RPC. Service-role only for every function in migration 067. */
export async function pgRpc(fn, args, { fetchImpl = null, timeoutMs = TIMEOUT_MS } = {}) {
  const url = SUPABASE_URL();
  const key = SERVICE_KEY();
  if (!url || !key) return { ok: false, status: 0, data: null, error: 'supabase_env_missing' };
  const doFetch = fetchImpl || globalThis.fetch;
  try {
    const res = await doFetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: key, authorization: `Bearer ${key}` },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) return { ok: false, status: res.status, data, error: data?.message || `rpc_${res.status}` };
    return { ok: true, status: res.status, data, error: null };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err?.message || 'rpc_unreachable' };
  }
}

/**
 * A plan row, by internal tier key.
 *
 * The Stripe price can live in the row or in an env var, and neither is a code
 * change: STRIPE_PRICE_BASIC / _PRO / _MAX is the escape hatch for the evening
 * Eden creates the prices in the dashboard and does not want to open the SQL
 * editor. The row wins when both are set.
 */
export async function loadPlan(tierKey, { fetchImpl = null } = {}) {
  const key = String(tierKey || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{1,40}$/.test(key)) return null;
  const { ok, data } = await pgSelect(
    `billing_plans?tier_key=eq.${encodeURIComponent(key)}&select=*`,
    { bearer: SERVICE_KEY(), apikey: SERVICE_KEY(), fetchImpl },
  );
  if (!ok || !Array.isArray(data) || data.length === 0) return null;
  const plan = data[0];
  const envPrice = process.env[`STRIPE_PRICE_${key.toUpperCase()}`] || null;
  return { ...plan, stripe_price_id: plan.stripe_price_id || envPrice || null };
}

/** A credit pack row, by pack key. Same env escape hatch: STRIPE_PRICE_PACK_25. */
export async function loadPack(packKey, { fetchImpl = null } = {}) {
  const key = String(packKey || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{1,40}$/.test(key)) return null;
  const { ok, data } = await pgSelect(
    `billing_credit_packs?pack_key=eq.${encodeURIComponent(key)}&select=*`,
    { bearer: SERVICE_KEY(), apikey: SERVICE_KEY(), fetchImpl },
  );
  if (!ok || !Array.isArray(data) || data.length === 0) return null;
  const pack = data[0];
  const envPrice = process.env[`STRIPE_PRICE_${key.toUpperCase()}`] || null;
  return { ...pack, stripe_price_id: pack.stripe_price_id || envPrice || null };
}

/** The one settings row, with the defaults this code would use anyway. */
export async function loadSettings({ fetchImpl = null } = {}) {
  const fallback = {
    past_due_grace_days: 7,
    default_trial_days: 0,
    currency: 'usd',
    pack_invoice_creation: true,
    allow_promotion_codes: true,
    billing_return_path: '/app/settings',
    checkout_success_path: '/app/settings?billing=success',
    checkout_cancel_path: '/app/settings?billing=cancelled',
  };
  const { ok, data } = await pgSelect('billing_settings?select=*&limit=1',
    { bearer: SERVICE_KEY(), apikey: SERVICE_KEY(), fetchImpl });
  if (!ok || !Array.isArray(data) || data.length === 0) return fallback;
  return { ...fallback, ...data[0] };
}

/** This user's billing_accounts row, read with the service role. */
export async function loadAccount(userId, { fetchImpl = null } = {}) {
  const { ok, data } = await pgSelect(
    `billing_accounts?user_id=eq.${encodeURIComponent(userId)}&select=*`,
    { bearer: SERVICE_KEY(), apikey: SERVICE_KEY(), fetchImpl },
  );
  if (!ok || !Array.isArray(data) || data.length === 0) return null;
  return data[0];
}

/**
 * May this buyer tag a purchase with this matter?
 *
 * Read with the BUYER's own token, so the answer is whatever RLS says — the
 * matter's name ends up on an invoice, and an invoice is a document that
 * leaves the building. Returns the matter's name, or null if they cannot see
 * it (which reads the same as "it does not exist", deliberately).
 *
 * A SEALED matter (tier B or C, lib/ai-tier-policy.mjs) is also null, on
 * Eden's decision of 2026-09-25: the point of sealing a matter is that its
 * name never leaves the system, and a Stripe receipt is exactly that. The
 * seal is inherited, so the test is the EFFECTIVE tier — the strongest on the
 * path to the root — and a sealed matter is refused in the same words as one
 * the buyer cannot read, so the refusal does not itself say "this is sealed".
 *
 * The walk fails CLOSED where the /api/llm gate does not. RLS lets a direct
 * member of a sub-matter read it without being able to read its parent
 * (migration 022, _mtspc_select_check), and walkEffectiveTier stops at an
 * invisible parent and keeps what it has — right for choosing a model, wrong
 * for printing a name, because that parent may be the sealed one. So any
 * ancestor this buyer cannot read makes the answer null.
 */
export async function matterNameForBuyer(matterId, bearer, { fetchImpl = null } = {}) {
  if (!matterId || !/^[0-9a-f-]{36}$/i.test(String(matterId))) return null;
  let name = null;
  let ancestorHidden = false;
  const fetchRow = async (id) => {
    const { ok, data } = await pgSelect(
      `matterspaces?id=eq.${encodeURIComponent(id)}&select=id,name,ai_tier,parent_matterspace_id`,
      { bearer, fetchImpl },
    );
    const row = ok && Array.isArray(data) && data.length > 0 ? data[0] : null;
    if (id === matterId) name = row?.name || null;
    else if (!row) ancestorHidden = true;
    return row;
  };
  const tier = await walkEffectiveTier(fetchRow, matterId);
  if (!tier || ancestorHidden || isSealedTier(tier)) return null;
  return name;
}

/** https://this-deployment, however it is being reached. */
export function originFor(req) {
  if (process.env.SITE_ORIGIN) return process.env.SITE_ORIGIN.replace(/\/$/, '');
  const proto = req?.headers?.['x-forwarded-proto'] || 'https';
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host || 'www.contextspaces.ai';
  return `${proto}://${host}`;
}

/**
 * The statuses that mean "this account already has a live subscription".
 *
 * A second Checkout in any of these states creates a SECOND subscription at
 * Stripe and bills the card twice — plan changes belong in the Customer Portal,
 * where Stripe prorates them. 'canceled' and 'incomplete_expired' are absent on
 * purpose: subscribing again after cancelling is a normal thing to do.
 */
export const LIVE_SUBSCRIPTION_STATUSES = new Set([
  'active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused',
]);

/**
 * The account's Stripe customer, created once and written down immediately.
 *
 * Used by BOTH checkout endpoints, and the order is the point. Stripe's
 * `customer.subscription.created` regularly reaches the webhook before
 * `checkout.session.completed`, identifying the account only by customer id —
 * so the mapping has to exist before any Session does. It also means a person
 * who buys a credit pack first and subscribes later is ONE customer at Stripe
 * with one invoice history, rather than two strangers who share an email.
 *
 * Returns the customer id, or null if Stripe would not make one.
 */
export async function ensureStripeCustomer(user, { fetchImpl = null } = {}) {
  const existing = (await loadAccount(user.id, { fetchImpl }))?.stripe_customer_id || null;
  if (existing) return existing;

  const { stripeRequest } = await import('./stripe-core.mjs');
  const created = await stripeRequest('/v1/customers', {
    body: { email: user.email || undefined, metadata: { user_id: user.id, app: 'contextspaces' } },
    // A retried request must not leave two customers behind for one person.
    idempotencyKey: `cs-customer-${user.id}`,
    fetchImpl,
  });
  if (!created.ok || !created.data?.id) {
    console.error(`${LOG} customer create failed: ${created.error}`);
    return null;
  }

  const link = await pgRpc('billing_link_customer',
    { p_user: user.id, p_customer: created.data.id }, { fetchImpl });
  if (!link.ok) {
    // Without this row the webhook cannot resolve the account from the events
    // that are about to arrive, so this is not something to shrug past.
    console.error(`${LOG} could not link customer ${created.data.id}: ${link.error}`);
    return null;
  }
  return created.data.id;
}

/** "$49.99" from 4999. For a line-item description, not for arithmetic. */
export function formatCents(cents) {
  const n = Number(cents) || 0;
  return `$${(n / 100).toFixed(2)}`;
}

/**
 * The line-item description a credit purchase carries.
 *
 * The matter's NAME, not its id: the point is that the invoice reads as a
 * document about a client's matter, so it can support passing that month's cost
 * to that client. Trimmed to a length Stripe accepts.
 */
export function creditLineDescription(pack, matterName) {
  const base = 'Contextspaces usage credits';
  if (!matterName) return `${base} — ${formatCents(pack.credit_cents)}`;
  return `${base} — Matter: ${String(matterName).slice(0, 150)}`;
}
