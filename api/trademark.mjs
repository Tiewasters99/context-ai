// POST /api/trademark — Trademark Clearance's model actions (a recipe, slice 1).
//
// Request body: { action: 'decompose' | 'classes' | 'triage' | 'deep_check', args: { clearance_id, all?, save?, force? } }
//
// Slice 2 (2026-10-21): `save: true` on decompose / classes also saves the
// proposal PROPOSED on the clearance (migration 122); `deep_check` runs stage 6
// (lib/trademark/deepcheck.mjs): the TSDR key comes from this server's env
// (USPTO_TSDR_API_KEY) only, and each status record is filed through
// file_document under the caller's own client.
// Response: the action's JSON (lib/trademark/actions.mjs), or { error, message }.
//
// Modeled on api/sandbox.mjs: the bearer is the user's own Supabase access
// token, so every read and write here runs under the user's RLS — the
// clearance must be readable, and its matter writable, by the caller. Browser
// sessions only: a connector token is refused.
//
// That refusal stays, deliberately (2026-10-20). A connected assistant runs the
// recipe through the hosted MCP endpoint instead — the tm_* tools in
// lib/trademark/connector.mjs — which call the same runTrademarkAction and the
// same serverLlmCall, but behind callTool's seal / pause / agent-grant gates
// and the connector meter, with the connector named on every Record row, and
// with no way to decide a bin, sign a stage or file the report. Opening this
// endpoint to connector tokens would bypass all of that.
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
import { timeoutFetch, callTool } from '../lib/mcp-core.mjs';
import { jwtClaims, readJsonBody } from '../lib/account-security.mjs';
import { serverLlmCall } from '../lib/llm-server-call.mjs';
import { LlmCallError } from '../lib/llm-call-error.mjs';
import { record } from '../lib/ledger.mjs';
import { runTrademarkAction, TrademarkActionError, ACTIONS } from '../lib/trademark/actions.mjs';
import { TrademarkModelError, TRADEMARK_MODEL } from '../lib/trademark/model.mjs';
import { runDeepCheck } from '../lib/trademark/deepcheck.mjs';
import { makeTsdrClient, TSDR_KEY_ENV } from '../lib/trademark/tsdr.mjs';
import { selectAll } from '../lib/trademark/rows.mjs';

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
  if (action === 'deep_check') {
    try {
      return json(res, 200, await deepCheckFor({ sb, userId, args: body?.args ?? {} }));
    } catch (err) {
      if (err instanceof TrademarkActionError) return json(res, err.status, { error: err.code, message: err.message });
      return json(res, 500, { error: 'trademark_failed', message: err?.message || String(err) });
    }
  }
  if (!ACTIONS.includes(action)) return json(res, 400, { error: `action must be one of: ${[...ACTIONS, 'deep_check'].join(', ')}` });

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stage 6 for the browser: the caller's RLS, the server's TSDR key, the caller's filing. */
async function deepCheckFor({ sb, userId, args }) {
  const id = String(args?.clearance_id ?? '');
  if (!UUID_RE.test(id)) throw new TrademarkActionError('clearance_id must be a uuid', 400, 'bad_request');
  const { data: clearance, error } = await sb.from('tm_clearances').select('*').eq('id', id).maybeSingle();
  if (error) throw new TrademarkActionError(error.message, 500, 'read_failed');
  if (!clearance) throw new TrademarkActionError('That clearance could not be found, or you do not have access to its matter.', 404, 'not_found');
  const { data: canWrite } = await sb.rpc('can_write_matter', { p_matter_id: clearance.matterspace_id });
  if (canWrite !== true) throw new TrademarkActionError('You can read this matter but not work in it.', 403, 'read_only');
  const [hs, st] = await Promise.all([
    selectAll(() => sb.from('tm_hits').select('*').eq('clearance_id', id).order('serial')),
    sb.from('tm_stages').select('*').eq('clearance_id', id).order('stage'),
  ]);
  if (hs.error) throw new TrademarkActionError(hs.error.message, 500, 'read_failed');
  const actor = { kind: 'user', ref: userId, user_id: userId, label: 'Trademark clearance' };
  const toolOpts = { openaiApiKey: process.env.OPENAI_API_KEY, googleApiKey: process.env.GOOGLE_API_KEY, userId, actor };
  return runDeepCheck({
    sb, bundle: { clearance, hits: hs.data ?? [], stages: st.data ?? [] },
    client: makeTsdrClient({ apiKey: process.env[TSDR_KEY_ENV] }),
    fileDocument: (a) => callTool(sb, 'file_document', a, toolOpts),
    record, actor, force: args?.force === true,
  });
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}
