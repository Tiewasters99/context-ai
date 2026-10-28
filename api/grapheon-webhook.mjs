// POST /api/grapheon-webhook — Stripe's side of a Grapheon sale.
//
// Grapheon.ai LLC's Stripe account (D3) has one endpoint, this one, and the
// events it sends are dispatched on `metadata.kind`: 'merch' today
// (migration 117), 'edition' when Phase 2's purchases join. Signed with
// GRAPHEON_STRIPE_WEBHOOK_SECRET — not Contextspaces' STRIPE_WEBHOOK_SECRET,
// which belongs to api/billing-webhook.mjs and a different account.
//
// What a merch `checkout.session.completed` does, in order
//   1. claim the order: PATCH merch_orders status pending → paid, by the
//      session id, with the amounts Stripe settled (a conditional update;
//      a replayed event finds nothing to claim and moves on);
//   2. place the Printify order if the row has none: a second claim on
//      `placing_at` so two deliveries cannot place it twice, then
//      createPrintifyOrder with the address Stripe collected (re-fetched
//      from the Session, so the shape is the pinned API version's, not the
//      endpoint's), external_id = our order id;
//   3. send it to production only when MERCH_SEND_TO_PRODUCTION=1. Off, the
//      order waits on hold in the shop and can be cancelled there without a
//      print — the test loop the spec describes. On, it prints.
//
// A database or Printify failure answers 500 so Stripe retries (up to three
// days); the claim is released so the retry can place the order. Only an
// unactionable event — another kind, an unknown session — is a 200.
//
// Body parsing is disabled: signature verification needs the exact bytes.

import { json, SUPABASE_URL, SERVICE_KEY } from '../lib/account-security.mjs';
import { verifyStripeSignature, readRawBody, stripeRequest } from '../lib/stripe-core.mjs';
import { printifyConfigured, createPrintifyOrder, sendOrderToProduction, cancelPrintifyOrder } from '../lib/printify.mjs';

export const config = { api: { bodyParser: false } };

const LOG = '[grapheon-webhook]';
const TIMEOUT_MS = 8000;
const base = () => String(SUPABASE_URL() || '').replace(/\/$/, '');

async function serviceWrite(method, table, query, body, doFetch) {
  try {
    const res = await doFetch(`${base()}/rest/v1/${table}${query ? `?${query}` : ''}`, {
      method,
      headers: {
        'content-type': 'application/json',
        apikey: SERVICE_KEY(),
        authorization: `Bearer ${SERVICE_KEY()}`,
        prefer: 'return=representation',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, rows: null, error: data?.message ?? `write_${res.status}` };
    return { ok: true, status: res.status, rows: Array.isArray(data) ? data : [data], error: null };
  } catch (err) {
    return { ok: false, status: 0, rows: null, error: err?.message || 'write_unreachable' };
  }
}

async function serviceSelect(table, query, doFetch) {
  try {
    const res = await doFetch(`${base()}/rest/v1/${table}?${query}`, {
      headers: { apikey: SERVICE_KEY(), authorization: `Bearer ${SERVICE_KEY()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, rows: null };
    const rows = await res.json().catch(() => null);
    return { ok: Array.isArray(rows), rows: Array.isArray(rows) ? rows : null };
  } catch {
    return { ok: false, rows: null };
  }
}

/** The shipping address off a Checkout Session, whichever field the API version put it in. */
export function addressFromSession(session) {
  const sd = session?.shipping_details || session?.collected_information?.shipping_details || null;
  const a = sd?.address || null;
  if (!a) return null;
  const name = String(sd.name || session?.customer_details?.name || '').trim();
  const space = name.lastIndexOf(' ');
  const firstName = space > 0 ? name.slice(0, space) : name || 'Reader';
  const lastName = space > 0 ? name.slice(space + 1) : '-';
  return {
    firstName,
    lastName,
    phone: session?.customer_details?.phone || sd.phone || '',
    country: a.country || 'US',
    state: a.state || '',
    address1: a.line1 || '',
    address2: a.line2 || '',
    city: a.city || '',
    zipCode: a.postal_code || '',
  };
}

export default async function handler(req, res, deps = {}) {
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const env = deps.env || process.env;
  const nowMs = deps.nowMs || Date.now();
  const ctx = { fetchImpl: doFetch, env };
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const secret = env.GRAPHEON_STRIPE_WEBHOOK_SECRET;
  if (!secret) return json(res, 503, { error: 'merch_not_configured', message: 'The Grapheon webhook is not enabled on this deployment.' });
  if (!SERVICE_KEY() || !SUPABASE_URL()) {
    console.error(`${LOG} cannot run without the Supabase service role`);
    return json(res, 500, { error: 'config_error' });
  }

  const raw = await readRawBody(req);
  const payload = raw.toString('utf8');
  if (!verifyStripeSignature(payload, req.headers['stripe-signature'], secret, 300, nowMs)) {
    return json(res, 400, { error: 'invalid_signature' });
  }
  let event;
  try { event = JSON.parse(payload); } catch { return json(res, 400, { error: 'invalid_payload' }); }
  if (!event?.id || !event?.type) return json(res, 400, { error: 'invalid_payload' });

  const object = event.data?.object || {};
  const kind = object?.metadata?.kind;

  if (event.type === 'checkout.session.completed' && kind === 'merch') {
    return onMerchPaid(res, { session: object, env, ctx, doFetch });
  }
  if (event.type === 'checkout.session.expired' && kind === 'merch') {
    const r = await serviceWrite('PATCH', 'merch_orders', `stripe_session_id=eq.${encodeURIComponent(object.id)}&status=eq.pending`, { status: 'canceled' }, doFetch);
    return json(res, r.ok ? 200 : 500, { received: true, expired: r.ok ? r.rows.length : 'error' });
  }
  if (event.type === 'charge.refunded' && object?.metadata?.kind === 'merch' && object?.metadata?.order_id) {
    return onRefund(res, { orderId: object.metadata.order_id, ctx, doFetch });
  }
  return json(res, 200, { received: true, ignored: event.type });
}

async function onMerchPaid(res, { session, env, ctx, doFetch }) {
  const sessionId = String(session.id || '');
  const orderId = String(session.metadata?.order_id || '');
  if (!sessionId || !orderId) return json(res, 200, { received: true, ignored: 'no order id' });
  if (session.payment_status && session.payment_status !== 'paid') {
    return json(res, 200, { received: true, ignored: `payment_status ${session.payment_status}` });
  }

  // 1. Claim: pending → paid, with the settled amounts.
  const amounts = {
    status: 'paid',
    stripe_session_id: sessionId,
    stripe_payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
    email: session.customer_details?.email || session.customer_email || null,
    tax_cents: Number(session.total_details?.amount_tax) || 0,
    shipping_cents: Number(session.total_details?.amount_shipping ?? session.shipping_cost?.amount_total) || 0,
    total_cents: Number(session.amount_total) || 0,
    error: null,
  };
  const claim = await serviceWrite('PATCH', 'merch_orders', `id=eq.${orderId}&status=eq.pending`, amounts, doFetch);
  if (!claim.ok) return json(res, 500, { error: 'db_error', message: claim.error });

  // The row, whether we claimed it just now or an earlier delivery did.
  const cur = await serviceSelect('merch_orders', `id=eq.${orderId}&select=*`, doFetch);
  const order = cur.ok ? cur.rows[0] : null;
  if (!order) return json(res, 200, { received: true, ignored: 'unknown order' });
  if (order.printify_order_id) return json(res, 200, { received: true, already: order.status });
  if (!printifyConfigured(env)) {
    console.error(`${LOG} paid order ${orderId} cannot be placed: Printify not configured`);
    return json(res, 500, { error: 'merch_not_configured' });
  }

  // 2. The placing claim: one delivery places; a stale claim (older than 5
  //    minutes, from a run that died) may be taken over.
  const now = new Date();
  const stale = new Date(now.getTime() - 5 * 60_000).toISOString();
  const take = await serviceWrite('PATCH', 'merch_orders',
    `id=eq.${orderId}&printify_order_id=is.null&or=(placing_at.is.null,placing_at.lt.${encodeURIComponent(stale)})`,
    { placing_at: now.toISOString() }, doFetch);
  if (!take.ok) return json(res, 500, { error: 'db_error', message: take.error });
  if (take.rows.length === 0) return json(res, 200, { received: true, placing: 'in progress' });

  const release = async (message) => {
    await serviceWrite('PATCH', 'merch_orders', `id=eq.${orderId}`, { placing_at: null, error: message }, doFetch);
  };

  // The product, for its Printify id.
  const pr = await serviceSelect('merch_products', `id=eq.${order.product_id}&select=id,printify_product_id,title`, doFetch);
  const product = pr.ok ? pr.rows[0] : null;
  if (!product?.printify_product_id) {
    await release('The product has no Printify id.');
    return json(res, 500, { error: 'db_error', message: 'product missing' });
  }

  // The address, from the Session as the pinned API version shapes it.
  const full = await stripeRequest(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'GET', secretKey: env.GRAPHEON_STRIPE_SECRET_KEY, fetchImpl: doFetch,
  });
  const address = addressFromSession(full.ok ? full.data : session) || addressFromSession(session);
  if (!address || !address.address1 || !address.city || !address.zipCode) {
    await release('Stripe gave no shipping address.');
    return json(res, 500, { error: 'no_address' });
  }
  const email = amounts.email || order.email || '';

  // 3. Place it at Printify (on hold), then send to production if told to.
  try {
    const placed = await createPrintifyOrder({
      externalId: orderId,
      label: `Grapheon ${orderId.slice(0, 8)}`,
      lineItems: [{ productId: product.printify_product_id, variantId: Number(order.variant_id), quantity: Number(order.quantity) }],
      shippingAddress: address,
      customerEmail: email,
      shippingMethod: 1,
    }, ctx);
    if (!placed?.id) throw new Error('Printify returned no order id.');
    let patch = { printify_order_id: placed.id, status: 'placed', placed_at: now.toISOString(), placing_at: null, error: null };
    if (env.MERCH_SEND_TO_PRODUCTION === '1') {
      await sendOrderToProduction(placed.id, ctx);
      patch = { ...patch, status: 'in_production', sent_to_production_at: new Date().toISOString() };
    }
    const saved = await serviceWrite('PATCH', 'merch_orders', `id=eq.${orderId}`, patch, doFetch);
    if (!saved.ok) {
      // Printify has the order; the record must catch up on the retry.
      console.error(`${LOG} order ${orderId} placed as ${placed.id} but not recorded: ${saved.error}`);
      return json(res, 500, { error: 'db_error', message: saved.error, printify_order_id: placed.id });
    }
    return json(res, 200, { received: true, order_id: orderId, printify_order_id: placed.id, status: patch.status });
  } catch (err) {
    const msg = err?.message || 'Printify failed.';
    console.error(`${LOG} order ${orderId} not placed: ${msg}`);
    await release(msg);
    return json(res, 500, { error: 'printify_error', message: msg });
  }
}

async function onRefund(res, { orderId, ctx, doFetch }) {
  const cur = await serviceSelect('merch_orders', `id=eq.${orderId}&select=*`, doFetch);
  const order = cur.ok ? cur.rows[0] : null;
  if (!order) return json(res, 200, { received: true, ignored: 'unknown order' });
  let note = null;
  if (order.printify_order_id && order.status === 'placed') {
    // Still on hold at Printify: cancel it so nothing prints.
    try { await cancelPrintifyOrder(order.printify_order_id, ctx); note = 'printify canceled'; } catch (err) { note = `printify not canceled: ${err?.message}`; }
  }
  const saved = await serviceWrite('PATCH', 'merch_orders', `id=eq.${orderId}`, { status: 'refunded', error: note }, doFetch);
  return json(res, saved.ok ? 200 : 500, { received: true, refunded: orderId, note });
}
