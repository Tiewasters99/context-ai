// POST /api/billing-checkout — start a monthly subscription.
//
// Dormant until Stripe exists. With no STRIPE_SECRET_KEY this answers 503
// `billing_not_configured` and does nothing, which is the convention
// lib/mediation-core.mjs already set for the one other Stripe path in this
// repo.
//
// Monthly only. There is no annual price anywhere in this feature, and that is
// a decision rather than an omission: Eden bought a $300/month discovery tool
// on a one-year commitment, could pass the cost to a client only in the months
// a matter used it, and took the loss himself. A tool a solo lawyer can stop
// paying for in a month he does not need it is the whole point.
//
// The order of operations matters more than it looks
// ---------------------------------------------------------------------------
// The Stripe customer is created and WRITTEN TO THE DATABASE before the
// Checkout Session is created. `customer.subscription.created` frequently
// reaches the webhook before `checkout.session.completed`, and it identifies
// the account only by Stripe customer id — so if that mapping is not already
// stored, the first event of a new subscription has nothing to resolve against
// and is dropped. Belt and braces: the user id also rides along as
// `client_reference_id` and in the subscription's own metadata.

import {
  json, notConfigured, corsPreflight, isConfigured, readJsonBody, verifyUser, bearerFrom,
  pgRpc, loadPlan, loadSettings, loadAccount, originFor, LOG,
} from '../lib/billing.mjs';
import { stripeRequest, stripeConfigured } from '../lib/stripe-core.mjs';

export default async function handler(req, res, deps = {}) {
  const fetchImpl = deps.fetchImpl || null;
  if (corsPreflight(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  if (!stripeConfigured()) return notConfigured(res);
  if (!isConfigured()) {
    return notConfigured(res, 'Supabase service-role credentials are missing on this deployment.');
  }

  const bearer = bearerFrom(req);
  if (!bearer) return json(res, 401, { error: 'missing_bearer' });
  const user = await verifyUser(bearer, { fetchImpl });
  if (!user) return json(res, 401, { error: 'invalid_session' });

  const body = await readJsonBody(req);
  const planKey = String(body.plan_key || body.tier_key || '').trim().toLowerCase();
  if (!planKey) return json(res, 400, { error: 'missing_plan_key' });

  const plan = await loadPlan(planKey, { fetchImpl });
  if (!plan) return json(res, 404, { error: 'unknown_plan', message: 'That plan does not exist.' });
  if (plan.purchasable === false || plan.active === false) {
    return json(res, 400, {
      error: 'plan_not_purchasable',
      message: 'That plan is not something you can subscribe to.',
    });
  }
  if (!plan.stripe_price_id) {
    // The plan row exists but nobody has told it which Stripe price it is. This
    // is the most likely first-day mistake, so it gets its own message rather
    // than a generic 500.
    return json(res, 503, {
      error: 'plan_price_missing',
      message: 'This plan has not been connected to a price in Stripe yet.',
      detail: `Set billing_plans.stripe_price_id for '${planKey}', or STRIPE_PRICE_${planKey.toUpperCase()}.`,
    });
  }

  const settings = await loadSettings({ fetchImpl });
  const origin = originFor(req);

  // ---- the Stripe customer, before anything else --------------------------
  let customerId = (await loadAccount(user.id, { fetchImpl }))?.stripe_customer_id || null;
  if (!customerId) {
    const created = await stripeRequest('/v1/customers', {
      body: {
        email: user.email || undefined,
        metadata: { user_id: user.id, app: 'contextspaces' },
      },
      // A retried request must not create a second customer for the same person.
      idempotencyKey: `cs-customer-${user.id}`,
      fetchImpl,
    });
    if (!created.ok || !created.data?.id) {
      console.error(`${LOG} customer create failed: ${created.error}`);
      return json(res, 502, { error: 'stripe_error', message: 'Could not start checkout.' });
    }
    customerId = created.data.id;
  }

  const link = await pgRpc('billing_link_customer',
    { p_user: user.id, p_customer: customerId }, { fetchImpl });
  if (!link.ok) {
    // Without this row the webhook cannot resolve the account, so a failure
    // here is not something to shrug at and continue past.
    console.error(`${LOG} could not link customer ${customerId}: ${link.error}`);
    return json(res, 500, { error: 'link_failed', message: 'Could not start checkout.' });
  }

  // ---- the Checkout Session ------------------------------------------------
  const trialDays = plan.trial_days == null
    ? Number(settings.default_trial_days || 0)
    : Number(plan.trial_days);

  const session = await stripeRequest('/v1/checkout/sessions', {
    body: {
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      allow_promotion_codes: settings.allow_promotion_codes !== false,
      success_url: `${origin}${settings.checkout_success_path}`,
      cancel_url: `${origin}${settings.checkout_cancel_path}`,
      metadata: { kind: 'subscription', user_id: user.id, tier_key: plan.tier_key },
      subscription_data: {
        // The same binding again, on the object the subscription events carry.
        metadata: { user_id: user.id, tier_key: plan.tier_key },
        trial_period_days: trialDays > 0 ? trialDays : undefined,
      },
    },
    fetchImpl,
  });

  if (!session.ok || !session.data?.url) {
    console.error(`${LOG} checkout session failed: ${session.error}`);
    return json(res, 502, {
      error: 'stripe_error',
      message: session.error || 'Could not start checkout.',
    });
  }

  return json(res, 200, {
    url: session.data.url,
    session_id: session.data.id,
    plan: { tier_key: plan.tier_key, display_name: plan.display_name, monthly_cents: plan.monthly_cents },
    trial_days: trialDays > 0 ? trialDays : 0,
  });
}
