// lib/trademark/actions.mjs — the recipe's three model actions, server side.
//
// api/trademark.mjs authenticates the caller and hands this function the
// caller's OWN Supabase client (RLS applies to every read and write here) and
// a `send` that goes through serverLlmCall — the gate, the seal, the meter,
// the clamp and the Record, in /api/llm's order. Tests hand it stubs.
//
//   decompose  → {proposal}       returned for the reviewer to accept or edit
//   classes    → {proposal}       likewise; nothing is stored here
//   triage     → {proposed, discarded, remaining}
//                stored as tm_hits.proposed (never the bin: the bin is the
//                reviewer's), one Record row tm.hit.proposed per hit.
//
// Every output has already passed the forbidden-phrase lint (model.mjs).

import { proposeDecomposition, proposeClasses, proposeTriage, TRADEMARK_MODEL } from './model.mjs';
import { isDead } from './triage.mjs';

export const ACTIONS = Object.freeze(['decompose', 'classes', 'triage']);
/** Hits triaged per request (two model calls), so a request ends inside the function's time. */
export const MAX_HITS_PER_REQUEST = 50;

export class TrademarkActionError extends Error {
  constructor(message, status, code) { super(message); this.name = 'TrademarkActionError'; this.status = status; this.code = code; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const NOT_READY_MESSAGE = 'Trademark Clearance needs a database update (migration 121) that has not been applied yet.';

/** PostgREST's "that table does not exist" (before 121 is applied). */
export function isTableMissing(error) {
  const code = String(error?.code ?? '');
  const msg = String(error?.message ?? '');
  if (code === '42P01' || code === 'PGRST205') return true;
  return /tm_(clearances|hits|stages|queries|query_runs)/.test(msg) && /does not exist|schema cache/i.test(msg);
}

/**
 * @param {object} o
 * @param {string} o.action
 * @param {{clearance_id:string, all?:boolean}} o.args
 * @param {object} o.sb        the caller's supabase-js client
 * @param {string} o.userId
 * @param {(req:{feature:string, body:string, matterId:string}) => Promise<unknown>} o.send
 * @param {Function} o.record  lib/ledger.mjs record()
 * @param {object} [o.actor]   the Record's byline for tm.hit.proposed. Default: the
 *                             browser user. The connector tools (connector.mjs) pass
 *                             the connector's actor, so a bot's proposals are its own.
 */
export async function runTrademarkAction({ action, args, sb, userId, send, record, actor: actorOpt = null }) {
  if (!ACTIONS.includes(action)) throw new TrademarkActionError(`action must be one of: ${ACTIONS.join(', ')}`, 400, 'bad_action');
  const id = String(args?.clearance_id ?? '');
  if (!UUID_RE.test(id)) throw new TrademarkActionError('clearance_id must be a uuid', 400, 'bad_request');

  const { data: c, error } = await sb
    .from('tm_clearances')
    .select('id, matterspace_id, mark, goods_services, users, search_classes, filing_classes, decomposition')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    if (isTableMissing(error)) throw new TrademarkActionError(NOT_READY_MESSAGE, 503, 'not_ready');
    throw new TrademarkActionError(error.message, 500, 'read_failed');
  }
  if (!c) throw new TrademarkActionError('That clearance could not be found, or you do not have access to its matter.', 404, 'not_found');
  const { data: canWrite } = await sb.rpc('can_write_matter', { p_matter_id: c.matterspace_id });
  if (canWrite !== true) throw new TrademarkActionError('You can read this matter but not work in it.', 403, 'read_only');

  const sendFor = (req) => send({ ...req, matterId: c.matterspace_id });
  const actor = actorOpt ?? { kind: 'user', ref: userId, user_id: userId };

  if (action === 'decompose') return { proposal: await proposeDecomposition({ clearance: c, send: sendFor }) };
  if (action === 'classes') return { proposal: await proposeClasses({ clearance: c, send: sendFor }) };

  // triage: the live hits without a decision (or every live hit, when asked).
  const { data: rows, error: hitErr } = await sb
    .from('tm_hits')
    .select('serial, mark, owner, status_text, live, classes, goods_services, bin, proposed')
    .eq('clearance_id', c.id)
    .order('serial');
  if (hitErr) throw new TrademarkActionError(hitErr.message, 500, 'read_failed');
  const todo = (rows ?? []).filter((h) => !isDead(h) && !h.bin && (args.all || !h.proposed));
  const batch = todo.slice(0, MAX_HITS_PER_REQUEST);
  if (!batch.length) return { proposed: 0, discarded: [], remaining: 0, calls: 0 };

  const { proposals, discarded, calls } = await proposeTriage({ clearance: c, hits: batch, send: sendFor });
  let stored = 0;
  for (const p of proposals) {
    const { data: upd, error: upErr } = await sb
      .from('tm_hits')
      .update({ proposed: p.proposed })
      .eq('clearance_id', c.id)
      .eq('serial', p.serial)
      .select('serial');
    if (upErr || !upd?.length) { discarded.push({ serial: p.serial, reason: upErr?.message ?? 'not stored' }); continue; }
    stored++;
    await record(sb, {
      kind: 'tm.hit.proposed',
      matterId: c.matterspace_id,
      actor,
      payload: { clearance_id: c.id, serial: p.serial, bin: p.proposed.bin, model: TRADEMARK_MODEL },
    });
  }
  return { proposed: stored, discarded, remaining: Math.max(0, todo.length - batch.length), calls };
}
