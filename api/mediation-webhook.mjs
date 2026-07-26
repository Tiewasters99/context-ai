// POST /api/mediation-webhook — Stripe webhook for mediation registration fees.
//
// Dormant until Stripe is configured (STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET
// on Vercel, and a Stripe webhook pointed at this URL for
// checkout.session.completed). Fulfillment: marks the paying PARTY's fee_paid,
// then advances the case intake → scheduling once both parties have paid AND
// both intake summaries are on file.
//
// Signature verification is done by hand (HMAC-SHA256 over `${t}.${payload}`,
// per Stripe's docs) so this repo doesn't need the stripe SDK. Body parsing is
// disabled — verification requires the exact raw payload bytes.

import { createHmac, timingSafeEqual } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { caseFeeSatisfied } from '../lib/mediation-core.mjs';

export const config = { api: { bodyParser: false } };

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Verify a Stripe-Signature header against the raw payload. */
function verifyStripeSignature(payload, header, secret, toleranceSec = 300) {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i), kv.slice(i + 1)];
    })
  );
  const t = Number(parts.t);
  const sig = parts.v1;
  if (!t || !sig) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret || !SUPABASE_URL || !SERVICE_KEY) {
    return json(res, 500, { error: 'config_error' });
  }

  const raw = await readRawBody(req);
  const payload = raw.toString('utf8');
  if (!verifyStripeSignature(payload, req.headers['stripe-signature'], webhookSecret)) {
    return json(res, 400, { error: 'invalid_signature' });
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return json(res, 400, { error: 'invalid_payload' });
  }

  if (event.type !== 'checkout.session.completed') {
    return json(res, 200, { received: true, ignored: event.type });
  }

  const session = event.data?.object || {};
  const md = session.metadata || {};
  if (md.kind !== 'mediation_fee' || !md.mediationCaseId || !md.mediationPartyId) {
    return json(res, 200, { received: true, ignored: 'not_mediation_fee' });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error: payErr } = await admin
    .from('mediation_parties')
    .update({ fee_paid: true })
    .eq('id', md.mediationPartyId)
    .eq('case_id', md.mediationCaseId);
  if (payErr) {
    console.error('[mediation-webhook] fee_paid update failed:', payErr.message);
    return json(res, 500, { error: 'fulfillment_failed' });
  }

  // Advance intake → scheduling when both fees are paid AND both intakes filed.
  const { data: caseRow } = await admin
    .from('mediation_cases')
    .select('id,status')
    .eq('id', md.mediationCaseId)
    .maybeSingle();
  if (caseRow?.status === 'intake') {
    const { data: parties } = await admin
      .from('mediation_parties')
      .select('fee_paid,intake_summary')
      .eq('case_id', md.mediationCaseId);
    const bothIn =
      (parties || []).length === 2 &&
      caseFeeSatisfied(parties) &&
      parties.every((p) => !!p.intake_summary);
    if (bothIn) {
      await admin.from('mediation_cases').update({ status: 'scheduling' }).eq('id', md.mediationCaseId);
    }
  }

  return json(res, 200, { received: true });
}
