// POST /api/billing-credits-checkout — buy a one-time pack of usage credits.
//
// Why credit packs exist at all
// ---------------------------------------------------------------------------
// Eden's instinct was three monthly price points and NOT unlimited: "above a
// certain usage there has to be credit-based pricing." A subscription buys a
// monthly allowance (migration 063's wallet); a pack tops it up when a month
// runs heavy, and it does not expire when the month rolls over.
//
// The matter tag, and why it is the point rather than a nicety
// ---------------------------------------------------------------------------
// A solo lawyer's tools are billable to the client whose matter used them, in
// the months that matter used them. So a pack purchase may name a matter, and
// when it does:
//
//   * the matter's NAME goes on the Stripe line item and into the session
//     metadata, so the invoice reads "Contextspaces usage credits — Matter:
//     Peloso v. Curtis" and is a document that supports the pass-through;
//   * invoice_creation is switched on, so Stripe issues a real invoice with a
//     number and a PDF rather than only a card receipt;
//   * the name is SNAPSHOTTED into the ledger at fulfilment, so renaming or
//     closing the matter later does not rewrite the receipt.
//
// Access is checked with the BUYER's own token before the Session is created.
// The matter's name is about to be printed on a document that leaves the
// building; the only honest way to decide whether this buyer may put it there
// is to ask the database as them and let RLS answer. A matter they cannot read
// is refused in the same words as a matter that does not exist.
//
// Credits are ONE balance per account today. The tag is for the receipt and for
// reporting, not a lock — see the header of migration 067 for how to make it a
// lock later without a rewrite.

import {
  json, notConfigured, corsPreflight, isConfigured, readJsonBody, verifyUser, bearerFrom,
  pgRpc, loadPack, loadSettings, loadAccount, matterNameForBuyer, originFor,
  creditLineDescription, LOG,
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
  const packKey = String(body.pack_key || '').trim().toLowerCase();
  const matterId = body.matter_id ? String(body.matter_id).trim() : null;
  if (!packKey) return json(res, 400, { error: 'missing_pack_key' });

  const pack = await loadPack(packKey, { fetchImpl });
  if (!pack || pack.active === false) {
    return json(res, 404, { error: 'unknown_pack', message: 'That credit pack does not exist.' });
  }

  // ---- the matter tag, checked as the buyer --------------------------------
  let matterName = null;
  if (matterId) {
    matterName = await matterNameForBuyer(matterId, bearer, { fetchImpl });
    if (!matterName) {
      return json(res, 403, {
        error: 'matter_not_accessible',
        message: 'That matter is not one you can tag a purchase to.',
      });
    }
  }

  const settings = await loadSettings({ fetchImpl });
  const origin = originFor(req);
  const currency = String(settings.currency || 'usd').toLowerCase();
  const description = creditLineDescription(pack, matterName);

  // A named price in Stripe if Eden made one; otherwise inline price_data, so
  // the packs work the moment the table is edited and before anything is set up
  // in the dashboard. Either way the DESCRIPTION carries the matter, because a
  // shared Price object cannot be per-purchase.
  const lineItem = pack.stripe_price_id
    ? { price: pack.stripe_price_id, quantity: 1 }
    : {
        quantity: 1,
        price_data: {
          currency,
          unit_amount: pack.price_cents,
          product_data: { name: pack.display_name, description },
        },
      };

  const session = await stripeRequest('/v1/checkout/sessions', {
    body: {
      mode: 'payment',
      customer: (await loadAccount(user.id, { fetchImpl }))?.stripe_customer_id || undefined,
      customer_email: (await loadAccount(user.id, { fetchImpl }))?.stripe_customer_id
        ? undefined
        : (user.email || undefined),
      client_reference_id: user.id,
      line_items: [lineItem],
      // The receipt that a client pass-through rests on. Without this, a
      // one-time payment produces a card receipt and no invoice.
      invoice_creation: settings.pack_invoice_creation === false
        ? undefined
        : {
            enabled: true,
            invoice_data: {
              description,
              metadata: {
                kind: 'usage_credits',
                user_id: user.id,
                pack_key: pack.pack_key,
                matter_id: matterId || '',
                matter_name: matterName || '',
              },
            },
          },
      success_url: `${origin}${settings.checkout_success_path}`,
      cancel_url: `${origin}${settings.checkout_cancel_path}`,
      metadata: {
        kind: 'usage_credits',
        user_id: user.id,
        pack_key: pack.pack_key,
        credit_cents: String(pack.credit_cents),
        matter_id: matterId || '',
        // Snapshotted here too: this is what the webhook writes to the ledger,
        // so the ledger says what the invoice says even if the matter is
        // renamed between the click and the payment.
        matter_name: matterName || '',
      },
    },
    fetchImpl,
  });

  if (!session.ok || !session.data?.url) {
    console.error(`${LOG} credit checkout failed: ${session.error}`);
    return json(res, 502, { error: 'stripe_error', message: session.error || 'Could not start checkout.' });
  }

  // Make sure the customer Stripe just created (if it did) is on file, so the
  // webhook can resolve this account from the customer id alone.
  const customerId = session.data.customer || null;
  if (customerId) {
    await pgRpc('billing_link_customer', { p_user: user.id, p_customer: customerId }, { fetchImpl });
  }

  return json(res, 200, {
    url: session.data.url,
    session_id: session.data.id,
    pack: {
      pack_key: pack.pack_key,
      display_name: pack.display_name,
      price_cents: pack.price_cents,
      credit_cents: pack.credit_cents,
    },
    matter: matterId ? { id: matterId, name: matterName } : null,
  });
}
