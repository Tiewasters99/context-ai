// POST /api/billing-portal — a Stripe Customer Portal session.
//
// This is where cancelling, changing plan, updating a card and downloading past
// invoices live. Building those four screens would be building a worse copy of
// something Stripe maintains, keeps compliant and localises; the Portal is one
// redirect and Eden configures what it allows from the dashboard.
//
// Dormant until Stripe exists: 503 `billing_not_configured`, and the Settings
// page never shows the button.
//
// An account with no Stripe customer gets a plain 409 rather than a portal
// session that would 404 at Stripe — a person who has never subscribed has
// nothing to manage, and saying so is kinder than a broken redirect.

import {
  json, notConfigured, corsPreflight, isConfigured, verifyUser, bearerFrom,
  loadAccount, loadSettings, originFor, LOG,
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

  const account = await loadAccount(user.id, { fetchImpl });
  if (!account?.stripe_customer_id) {
    return json(res, 409, {
      error: 'no_stripe_customer',
      message: 'There is nothing to manage yet — this account has never subscribed.',
    });
  }

  const settings = await loadSettings({ fetchImpl });
  const session = await stripeRequest('/v1/billing_portal/sessions', {
    body: {
      customer: account.stripe_customer_id,
      return_url: `${originFor(req)}${settings.billing_return_path}`,
    },
    fetchImpl,
  });

  if (!session.ok || !session.data?.url) {
    console.error(`${LOG} portal session failed: ${session.error}`);
    // The commonest cause by far is that the Portal has never been configured
    // in the Stripe dashboard, which is a one-time click and not an app bug.
    return json(res, 502, {
      error: 'stripe_error',
      message: session.error || 'Could not open the billing portal.',
      detail: 'If this is the first time: the Customer Portal must be enabled once in the Stripe dashboard.',
    });
  }

  return json(res, 200, { url: session.data.url });
}
