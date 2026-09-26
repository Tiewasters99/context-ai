// POST /api/account-factor-event — write a second-factor row to the caller's
// own Record (account chain), after checking it happened.
//
//   body: { kind: 'auth.factor_enrolled' | 'auth.factor_unenrolled' | 'auth.stepup',
//           factor_id?, factor_type?, matter_id? }
//
// The browser enrols, challenges and verifies with Supabase Auth directly, so
// it reports each success here. lib/account-security.mjs checks the report
// against Supabase Auth's own view of the account (and, for a step-up, the
// token's aal) before anything is written. See that file for why a report can
// be missing but never false.

import {
  json, corsPreflight, bearerFrom, readJsonBody, recordFactorEvent,
} from '../lib/account-security.mjs';

export default async function handler(req, res, deps = {}) {
  if (corsPreflight(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const bearer = bearerFrom(req);
  if (!bearer) return json(res, 401, { error: 'missing_bearer' });

  const body = await readJsonBody(req);
  const { status, body: out } = await recordFactorEvent({
    bearer,
    body,
    fetchImpl: deps.fetchImpl || null,
    ledgerClient: deps.ledgerClient || null,
  });
  return json(res, status, out);
}
