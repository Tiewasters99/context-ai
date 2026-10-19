// POST /api/trademark — Trademark Clearance's model actions (a recipe, slice 1).
//
// Request body: { action: 'decompose' | 'classes' | 'triage', args: { clearance_id, all? } }
// Response: the action's JSON (lib/trademark/actions.mjs), or { error, message }.
//
// Modeled on api/sandbox.mjs: the bearer is the user's own Supabase access
// token, so every read and write here runs under the user's RLS — the
// clearance must be readable, and its matter writable, by the caller. Browser
// sessions only: a connector token is refused.
//
// The model is reached ONLY through lib/llm-server-call.mjs serverLlmCall:
// the gate (tier → pause → allowlist), the SEAL, the provider key, the meter
// on the caller's month, the per-tier clamp, and the Record (completion.
// requested / completion.received under the feature labels trademark.*),
// in /api/llm's order. A sealed matter takes the sealed route or refuses;
// there is no fallback here. The deterministic stages need none of this and
// run in the browser.
//
// What never comes from the client: a model id, a provider, a prompt, a key.

import { createClient } from '@supabase/supabase-js';
import { timeoutFetch } from '../lib/mcp-core.mjs';
import { jwtClaims, readJsonBody } from '../lib/account-security.mjs';
import { serverLlmCall } from '../lib/llm-server-call.mjs';
import { LlmCallError } from '../lib/llm-call-error.mjs';
import { record } from '../lib/ledger.mjs';
import { runTrademarkAction, TrademarkActionError, ACTIONS } from '../lib/trademark/actions.mjs';
import { TrademarkModelError, TRADEMARK_MODEL } from '../lib/trademark/model.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_KEY) return json(res, 500, { error: 'config_error' });

  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !String(authHeader).toLowerCase().startsWith('bearer ')) return json(res, 401, { error: 'missing_bearer' });
  const userToken = String(authHeader).slice(7).trim();
  if (jwtClaims(userToken).cs_via === 'connector') return json(res, 403, { error: 'browser_sessions_only' });

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userToken}` }, fetch: timeoutFetch(15000, 'supabase query') },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return json(res, 401, { error: 'invalid_session' });
  const userId = userData.user.id;

  const body = await readJsonBody(req);
  const action = body?.action;
  if (!ACTIONS.includes(action)) return json(res, 400, { error: `action must be one of: ${ACTIONS.join(', ')}` });

  const send = async ({ feature, body: reqBody, matterId }) => {
    const out = await serverLlmCall({
      supabaseUrl: SUPABASE_URL,
      serviceKey: SERVICE_KEY,
      userId,
      matterId,
      provider: 'anthropic',
      model: TRADEMARK_MODEL,
      body: reqBody,
      feature,
      ledger: sb,
      actor: { kind: 'user', ref: userId, user_id: userId, label: 'Trademark clearance' },
      usageRoute: 'trademark',
    });
    return out.json;
  };

  try {
    const result = await runTrademarkAction({ action, args: body?.args ?? {}, sb, userId, send, record });
    return json(res, 200, result);
  } catch (err) {
    if (err instanceof TrademarkActionError) return json(res, err.status, { error: err.code, message: err.message });
    if (err instanceof TrademarkModelError) return json(res, err.status, { error: 'proposal_discarded', message: err.message });
    if (err instanceof LlmCallError) {
      // The server's own sentence (sealed, paused, spend cap, tier): the
      // stage says so, and the reviewer can still do the step by hand.
      return json(res, err.status || 502, { error: err.code || 'model_refused', message: err.message });
    }
    return json(res, 500, { error: 'trademark_failed', message: err?.message || String(err) });
  }
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}
