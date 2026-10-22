// lib/trademark/connector-opts.mjs — what api/mcp.mjs adds to callTool's
// options for the Trademark Clearance tools (lib/trademark/connector.mjs).
//
//   actor      the connector's byline on every Record row the call causes:
//              tool.invoked, the tm.* rows, and completion.requested /
//              completion.received for a model call. An agent token keeps the
//              actor callToolOptsFor already gave it (agent:<token id>); a
//              user token is token:<id>, an OAuth sign-in oauth:<grant id> —
//              the same refs the connector meter uses (actorRef). Set here
//              for the tm_* tools only, so every other tool's Record rows are
//              exactly what they were.
//   trademark  {userId, actor, send}: `send` is the model door —
//              lib/llm-server-call.mjs serverLlmCall, with the gate (tier →
//              pause → allowlist), the SEAL, the provider key, the meter on
//              the REQUESTING user's month, the clamp and the Record, in
//              /api/llm's order — the same call api/trademark.mjs makes for
//              the browser, with the connector as the actor.

//              Slice 2 adds `tsdr` (the USPTO TSDR client, keyed from the
//              server's env only — lib/trademark/tsdr.mjs) and `fileDocument`
//              (file_document through callTool with the connector's actor, the
//              comparator's pattern), for tm_deep_check and tm_application_draft.
//
//              2026-10-21 adds `register`: Equazia's copy of the USPTO register
//              (lib/trademark/register/), for tm_run_search and the stage-4
//              guidance in next_step. TM_REGISTER_DB_URL unset = feature off:
//              `register.configured` is false and every tm_* tool behaves as
//              before; nothing is opened or imported.

import { serverLlmCall } from '../llm-server-call.mjs';
import { makeTsdrClient, TSDR_KEY_ENV } from './tsdr.mjs';
import { actorRef } from '../connector-meter.mjs';
import { TRADEMARK_MODEL } from './model.mjs';
import { registerAccess } from './register/service.mjs';

/** The Record's byline for a connector call. */
export function connectorActorFor(identity, baseOpts = {}) {
  if (baseOpts.actor && baseOpts.actor.kind === 'connector') return baseOpts.actor;
  const name = typeof identity?.name === 'string' && identity.name.trim() ? identity.name.trim() : null;
  return {
    kind: 'connector',
    ref: actorRef(identity),
    user_id: identity?.userId ?? null,
    label: name || (identity?.tokenId ? 'connector token' : 'connected assistant'),
  };
}

/**
 * @param {object} identity   lib/oauth-bearer.mjs authenticate()'s result
 * @param {object} sb         the caller's user-scoped client (the Record's writer)
 * @param {object} baseOpts   callToolOptsFor(identity)
 * @param {{supabaseUrl:string, serviceKey:string, env?:object, fetchImpl?:Function, register?:object}} cfg
 */
export function trademarkToolOptsFor(identity, sb, baseOpts, { supabaseUrl, serviceKey, env, fetchImpl, register } = {}) {
  const actor = connectorActorFor(identity, baseOpts);
  const userId = identity?.userId ?? null;
  const send = async ({ feature, body, matterId }) => {
    const out = await serverLlmCall({
      supabaseUrl, serviceKey, userId, matterId,
      provider: 'anthropic', model: TRADEMARK_MODEL, body, feature,
      ledger: sb, actor, usageRoute: 'trademark-connector',
      ...(env ? { env } : {}), ...(fetchImpl ? { fetchImpl } : {}),
    });
    return out.json;
  };
  const tsdr = makeTsdrClient({ apiKey: (env ?? process.env)[TSDR_KEY_ENV], ...(fetchImpl ? { fetchImpl } : {}) });
  const fileDocument = async (args) => {
    const { callTool } = await import('../mcp-core.mjs');
    return callTool(sb, 'file_document', args, { ...baseOpts, actor, userId });
  };
  const reg = register ?? registerAccess({ env: env ?? process.env });
  return { actor, trademark: { userId, actor, send, tsdr, fileDocument, register: reg } };
}
