// Stripe, spoken as raw REST.
//
// Why there is no SDK here
// ---------------------------------------------------------------------------
// This repo already talks to Stripe without one: api/mediation.mjs builds a
// form-encoded POST to /v1/checkout/sessions by hand, and
// api/mediation-webhook.mjs verifies the signature with crypto.createHmac. Two
// endpoints do not justify a dependency in a bundle that ships to a serverless
// function, and the Stripe API is stable enough that the form encoding is the
// least interesting part of this feature.
//
// Why this is a SECOND copy of that code rather than a shared import
// ---------------------------------------------------------------------------
// The Mediation module is frozen. Reaching into api/mediation-webhook.mjs to
// export its verifier would mean editing a file nobody is testing, on behalf of
// a feature it has nothing to do with. Forty lines of duplication is the
// cheaper mistake. If Mediation ever thaws, it should import from here and the
// duplicate should go.
//
// Two things this version does that the Mediation one does not:
//
//   * it accepts MULTIPLE v1 signatures. During a webhook-secret rotation
//     Stripe signs each request with both the old and the new secret and sends
//     `t=…,v1=…,v1=…`. Parsing that header with Object.fromEntries keeps only
//     the LAST one, so half of every rotation would be rejected.
//   * `fetchImpl` is injectable, so scripts/_verify-billing.mjs can drive the
//     real handlers against a stubbed Stripe with no network and no account.
//
// Nothing in this file has ever called Stripe. There is no Stripe account yet;
// every endpoint that imports this is dormant until STRIPE_SECRET_KEY exists.

import { createHmac, timingSafeEqual } from 'crypto';

export const STRIPE_API = 'https://api.stripe.com';

/** Is Stripe configured on this deployment at all? */
export function stripeConfigured(env = process.env) {
  return Boolean(env.STRIPE_SECRET_KEY);
}

/** Is the webhook configured? (A different secret, and a different failure.) */
export function webhookConfigured(env = process.env) {
  return Boolean(env.STRIPE_WEBHOOK_SECRET);
}

/** Test mode or live mode, read off the key itself. Null when not configured. */
export function stripeMode(env = process.env) {
  const key = env.STRIPE_SECRET_KEY || '';
  if (!key) return null;
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'test';
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'live';
  return 'unknown';
}

/**
 * Verify a Stripe-Signature header against the RAW payload bytes.
 *
 * Stripe signs `${timestamp}.${payload}` with HMAC-SHA256. The payload must be
 * the exact bytes that arrived: re-serialising the parsed JSON changes key
 * order and whitespace and the signature stops matching, which is why every
 * webhook in this repo disables the body parser.
 *
 * @param {string} payload  raw request body, as text
 * @param {string} header   the Stripe-Signature header
 * @param {string} secret   whsec_…
 * @param {number} toleranceSec  how old a timestamp may be (Stripe's own
 *                               example uses 300; a replay of an older request
 *                               is refused even with a valid signature)
 */
export function verifyStripeSignature(payload, header, secret, toleranceSec = 300, nowMs = Date.now()) {
  if (!header || !secret || typeof payload !== 'string') return false;

  let t = null;
  const signatures = [];
  for (const part of String(header).split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && t === null) t = Number(v);
    // Every v1, not just the last: during a secret rotation Stripe sends two.
    else if (k === 'v1') signatures.push(v);
  }
  if (!t || !Number.isFinite(t) || signatures.length === 0) return false;
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return false;

  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  return signatures.some((sig) => {
    const b = Buffer.from(sig, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/**
 * Flatten an object into Stripe's bracket form.
 *
 *   { line_items: [{ price: 'p', quantity: 1 }] }
 *     → line_items[0][price]=p&line_items[0][quantity]=1
 *
 * undefined and null are dropped (Stripe treats an empty string as "set this
 * to empty", which is not the same thing as "do not send it").
 */
export function toStripeForm(obj, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(obj || {})) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item !== null && typeof item === 'object') toStripeForm(item, `${name}[${i}]`, out);
        else if (item !== undefined && item !== null) out.append(`${name}[${i}]`, String(item));
      });
    } else if (typeof value === 'object') {
      toStripeForm(value, name, out);
    } else if (typeof value === 'boolean') {
      out.append(name, value ? 'true' : 'false');
    } else {
      out.append(name, String(value));
    }
  }
  return out;
}

/**
 * One Stripe REST call.
 *
 * Returns { ok, status, data, error } and never throws for an HTTP error —
 * every caller here has a better answer than a 500, and a Stripe outage should
 * not read as a bug in Contextspaces.
 *
 * `idempotencyKey` matters on every POST that creates something: a retried
 * checkout must not create a second Session (or, worse, a second customer).
 */
export async function stripeRequest(path, {
  method = 'POST',
  body = null,
  secretKey = process.env.STRIPE_SECRET_KEY,
  idempotencyKey = null,
  fetchImpl = null,
  timeoutMs = 10000,
} = {}) {
  if (!secretKey) return { ok: false, status: 0, data: null, error: 'billing_not_configured' };
  const doFetch = fetchImpl || globalThis.fetch;
  const headers = {
    Authorization: `Bearer ${secretKey}`,
    'Stripe-Version': '2024-06-20',
  };
  let url = `${STRIPE_API}${path}`;
  let payload;
  if (method === 'GET') {
    if (body) url += `?${toStripeForm(body).toString()}`;
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = toStripeForm(body || {}).toString();
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  }

  try {
    const res = await doFetch(url, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data,
        error: data?.error?.message || `stripe_http_${res.status}`,
      };
    }
    return { ok: true, status: res.status, data, error: null };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err?.message || 'stripe_unreachable' };
  }
}

/** Read the raw request body as a Buffer (the webhook needs the exact bytes). */
export async function readRawBody(req) {
  if (req.rawBody) return Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody);
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
