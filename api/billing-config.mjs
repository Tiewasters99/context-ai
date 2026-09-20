// GET /api/billing-config — is billing switched on, and in which mode?
//
// The plans, packs and the account's own subscription are all readable from the
// browser under RLS (migration 067), so the Settings page reads those itself.
// The one thing it cannot see is whether the SERVER has a Stripe key, because
// that is a server-only secret — and without knowing, the page has no honest
// way to choose between showing buttons and showing "Billing is not yet
// enabled". So: one tiny endpoint that answers exactly that and discloses
// nothing else.
//
// It returns the MODE (test or live) but never the key, and never any part of
// it. `mode` is read from the key's own prefix, which is how a person can tell
// at a glance that the staging deployment is not about to charge a real card.

import { json, corsPreflight, verifyUser, bearerFrom, SUPABASE_URL, SERVICE_KEY } from '../lib/billing.mjs';
import { stripeConfigured, webhookConfigured, stripeMode } from '../lib/stripe-core.mjs';

export default async function handler(req, res, deps = {}) {
  const fetchImpl = deps.fetchImpl || null;
  if (corsPreflight(req, res, 'GET, OPTIONS')) return;
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });

  // Signed-in only. Nothing here is dangerous, but the deployment's payment
  // posture is not something to hand to an anonymous crawler.
  const bearer = bearerFrom(req);
  if (!bearer) return json(res, 401, { error: 'missing_bearer' });
  const user = await verifyUser(bearer, { fetchImpl });
  if (!user) return json(res, 401, { error: 'invalid_session' });

  const configured = stripeConfigured() && Boolean(SUPABASE_URL()) && Boolean(SERVICE_KEY());
  return json(res, 200, {
    configured,
    mode: configured ? stripeMode() : null,
    // False here and true above means Checkout works but nothing will ever be
    // fulfilled — worth seeing on the page rather than discovering by waiting.
    webhook_configured: webhookConfigured(),
  });
}
