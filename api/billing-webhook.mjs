// POST /api/billing-webhook — Stripe's side of the conversation.
//
// This is the only writer of `profiles.pricing_tier` in the product. Migration
// 062 made that column writable by the service role alone, guarded by a BEFORE
// UPDATE trigger, precisely so that upgrading a plan is something a payment
// causes and not something a browser can ask for.
//
// What it handles
// ---------------------------------------------------------------------------
//   checkout.session.completed            both modes: a new subscription, or a
//                                         credit pack that has been paid for
//   customer.subscription.created/updated/deleted
//   invoice.paid / invoice.payment_failed
//
// Everything else is acknowledged with a 200 and ignored. A webhook endpoint
// that 4xx's on an event type it did not ask for teaches Stripe to retry
// forever.
//
// Three properties worth naming
// ---------------------------------------------------------------------------
// 1. IDEMPOTENT. Stripe guarantees at-least-once delivery. Every event id is
//    recorded in `billing_events` INSIDE the same transaction as the work it
//    guards, so a resend grants nothing twice — and a failure rolls the event
//    row back with it, so a retry still does the job. (The Mediation webhook,
//    which this one deliberately does not touch, has no such guard.)
//
// 2. ORDER-INDEPENDENT. State is derived from the subscription object and the
//    event's own `created` stamp, never from arrival order. An `updated` that
//    overtakes its `created` converges on the same answer.
//
// 3. IT RETRIES RATHER THAN SWALLOWS. A database error answers 500 so Stripe
//    tries again (it retries for up to three days). Only a genuinely
//    unactionable event — an unknown type, an unknown customer — is a 200.
//
// Body parsing is disabled: signature verification needs the exact bytes that
// arrived, and re-serialising parsed JSON changes them.

import { json, pgRpc, LOG } from '../lib/billing.mjs';
import {
  verifyStripeSignature, readRawBody, stripeRequest, webhookConfigured,
} from '../lib/stripe-core.mjs';

export const config = { api: { bodyParser: false } };

const HANDLED = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

/** The Stripe id whether the field is expanded or not. */
const idOf = (v) => (v && typeof v === 'object' ? v.id : v) || null;

export default async function handler(req, res, deps = {}) {
  const fetchImpl = deps.fetchImpl || null;
  const nowMs = deps.nowMs || Date.now();
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookConfigured()) {
    // Dormant, like every other endpoint in this feature. A 503 here is also
    // the correct answer for Stripe: it will retry, and once the secret is set
    // the backlog is delivered.
    return json(res, 503, {
      error: 'billing_not_configured',
      message: 'Billing is not yet enabled on this deployment.',
    });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(`${LOG} webhook cannot run without SUPABASE_SERVICE_ROLE_KEY`);
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

  if (!HANDLED.has(event.type)) {
    return json(res, 200, { received: true, ignored: event.type });
  }

  const object = event.data?.object || {};
  const created = Number(event.created) || 0;

  try {
    let result;
    switch (event.type) {
      case 'checkout.session.completed':
        result = await onCheckoutCompleted(event, object, created, fetchImpl);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        result = await applySubscriptionObject(event.id, event.type, created, object, fetchImpl);
        break;
      case 'invoice.paid':
      case 'invoice.payment_failed':
        result = await onInvoice(event, object, created, fetchImpl);
        break;
      default:
        result = { ok: true, ignored: event.type };
    }

    if (result?.transport_error) {
      // The database could not be reached or the RPC is not deployed yet. Ask
      // Stripe to come back rather than pretending this was handled.
      console.error(`${LOG} ${event.type} ${event.id}: ${result.transport_error}`);
      return json(res, 500, { error: 'fulfilment_failed', detail: result.transport_error });
    }
    if (result?.ok === false) {
      // Understood and declined — an unknown customer, a price we do not sell.
      // Retrying will not change the answer, so acknowledge and log loudly.
      console.error(`${LOG} ${event.type} ${event.id} not applied: ${result.reason}`);
      return json(res, 200, { received: true, applied: false, reason: result.reason });
    }
    return json(res, 200, { received: true, ...result });
  } catch (err) {
    console.error(`${LOG} ${event.type} ${event.id} threw: ${err?.message || err}`);
    return json(res, 500, { error: 'fulfilment_failed' });
  }
}

// ---------------------------------------------------------------------------
// checkout.session.completed — one event type, two entirely different jobs.
// ---------------------------------------------------------------------------
async function onCheckoutCompleted(event, session, created, fetchImpl) {
  const md = session.metadata || {};
  const userId = md.user_id || session.client_reference_id || null;

  if (session.mode === 'payment' || md.kind === 'usage_credits') {
    // A credit pack. Do not grant on an unpaid session: with certain payment
    // methods a Session completes before the money has actually arrived.
    if (session.payment_status && session.payment_status !== 'paid') {
      return { ok: false, reason: `payment_status_${session.payment_status}` };
    }
    const cents = Number(md.credit_cents || 0) || Number(session.amount_total || 0);
    const invoiceId = idOf(session.invoice);

    // The hosted invoice URL is not on the session — it is on the invoice. One
    // GET, and if it fails the grant still happens and the Portal's invoice
    // list is the fallback. A missing link is not a reason to lose a purchase.
    let invoiceUrl = null;
    if (invoiceId) {
      const inv = await stripeRequest(`/v1/invoices/${invoiceId}`, { method: 'GET', fetchImpl });
      invoiceUrl = inv.ok ? (inv.data?.hosted_invoice_url || inv.data?.invoice_pdf || null) : null;
    }

    const { ok, data, error } = await pgRpc('usage_credits_grant', {
      p_event_id: event.id,
      p_user: userId,
      p_credit_cents: cents,
      p_pack_key: md.pack_key || null,
      p_matter_id: md.matter_id || null,
      p_matter_name: md.matter_name || null,
      p_session_id: session.id || null,
      p_payment_intent: idOf(session.payment_intent),
      p_invoice_id: invoiceId,
      p_receipt_url: session.receipt_url || null,
      p_invoice_url: invoiceUrl,
      p_event_type: event.type,
      p_event_created: created,
    }, { fetchImpl });
    if (!ok) return { transport_error: error };
    return data;
  }

  // A subscription. The session names the subscription but not its status or
  // period, so fetch the object the subscription events would have carried and
  // apply exactly the same way — which is what makes this event and
  // `customer.subscription.created` converge whichever arrives first.
  const subId = idOf(session.subscription);
  if (!subId) return { ok: false, reason: 'no_subscription_on_session' };

  let subscription = typeof session.subscription === 'object' ? session.subscription : null;
  if (!subscription) {
    const got = await stripeRequest(`/v1/subscriptions/${subId}`, { method: 'GET', fetchImpl });
    subscription = got.ok ? got.data : null;
  }
  if (!subscription) {
    // Link what we do know; the subscription.* events will finish the job.
    const { ok, data, error } = await pgRpc('billing_apply_subscription', {
      p_event_id: event.id,
      p_event_type: event.type,
      p_event_created: created,
      p_user: userId,
      p_customer: idOf(session.customer),
      p_subscription: subId,
      p_status: null,
      p_price_id: null,
      p_period_end: null,
      p_cancel_at_period_end: false,
      p_trial_end: null,
    }, { fetchImpl });
    if (!ok) return { transport_error: error };
    return data;
  }

  return applySubscriptionObject(event.id, event.type, created, subscription, fetchImpl, userId);
}

// ---------------------------------------------------------------------------
// One shape for every subscription-carrying event.
// ---------------------------------------------------------------------------
async function applySubscriptionObject(eventId, eventType, created, sub, fetchImpl, userHint = null) {
  const item = sub.items?.data?.[0] || {};
  const priceId = idOf(item.price) || idOf(sub.plan) || null;
  // Stripe moved the period onto the subscription item in newer API versions
  // and kept it on the subscription in older ones; read both.
  const periodEnd = Number(sub.current_period_end || item.current_period_end || 0) || null;

  const { ok, data, error } = await pgRpc('billing_apply_subscription', {
    p_event_id: eventId,
    p_event_type: eventType,
    p_event_created: created,
    p_user: userHint || sub.metadata?.user_id || null,
    p_customer: idOf(sub.customer),
    p_subscription: sub.id || null,
    p_status: sub.status || null,
    p_price_id: priceId,
    p_period_end: periodEnd,
    p_cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    p_trial_end: Number(sub.trial_end || 0) || null,
  }, { fetchImpl });
  if (!ok) return { transport_error: error };
  return data;
}

// ---------------------------------------------------------------------------
// invoice.paid / invoice.payment_failed
// ---------------------------------------------------------------------------
async function onInvoice(event, invoice, created, fetchImpl) {
  const paid = event.type === 'invoice.paid';
  const { ok, data, error } = await pgRpc('billing_apply_invoice', {
    p_event_id: event.id,
    p_event_type: event.type,
    p_event_created: created,
    p_user: invoice.metadata?.user_id || null,
    p_customer: idOf(invoice.customer),
    p_subscription: idOf(invoice.subscription) || idOf(invoice.parent?.subscription_details?.subscription),
    p_invoice_id: invoice.id || null,
    p_paid: paid,
    // NEVER the invoice's own period. `invoice.period_end` is the window of
    // usage the invoice bills in arrears, and on a subscription's FIRST
    // invoice it is the creation instant — so writing it here overwrote the
    // real renewal date the subscription event had just stored, and Settings
    // said "Renews on <today>". A one-off invoice (a credit pack) has no
    // subscription at all and would have done the same. The subscription
    // events (created / updated at every renewal / checkout's fetch) carry the
    // real current_period_end and are the only source of it; null here makes
    // billing_apply_invoice's coalesce keep what they wrote.
    p_period_end: null,
    p_invoice_url: invoice.hosted_invoice_url || null,
  }, { fetchImpl });
  if (!ok) return { transport_error: error };
  return data;
}
