// lib/trademark/actions.mjs — the recipe's three model actions, server side.
//
// api/trademark.mjs authenticates the caller and hands this function the
// caller's OWN Supabase client (RLS applies to every read and write here) and
// a `send` that goes through serverLlmCall — the gate, the seal, the meter,
// the clamp and the Record, in /api/llm's order. Tests hand it stubs.
//
//   decompose  → {proposal}       returned for the reviewer to accept or edit
//   classes    → {proposal}       likewise. With args.save (slice 2, migration
//                                 122) the proposal is also SAVED PROPOSED on
//                                 the clearance (tm_clearances.proposals), never
//                                 as the confirmed value, with one Record row
//                                 tm.proposal.saved — so the one-box review
//                                 screen survives a reload, and a bot's
//                                 proposals are the ones the reviewer sees.
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

  if (action === 'decompose' || action === 'classes') {
    const proposal = action === 'decompose'
      ? await proposeDecomposition({ clearance: c, send: sendFor })
      : await proposeClasses({ clearance: c, send: sendFor });
    if (!args?.save) return { proposal };
    const saved = await saveProposal({ sb, clearance: c, step: action, proposal, record, actor });
    return { proposal, saved };
  }

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

/** True when the write failed because migration 122's columns are not there yet. */
export function isSlice2Missing(error) {
  const code = String(error?.code ?? '');
  const msg = String(error?.message ?? '');
  if (code === '42703' || code === 'PGRST204') return /proposals|application|tsdr|deep_check/.test(msg) || code === '42703';
  return /(proposals|application|tsdr|deep_check)/.test(msg) && /does not exist|schema cache|Could not find/i.test(msg);
}

export const SLICE2_NOT_READY_MESSAGE =
  'This step needs a database update (migration 122, Trademark Clearance slice 2) that has not been applied yet.';

/**
 * Save a proposal PROPOSED on the clearance (migration 122). Read-modify-write
 * of tm_clearances.proposals under the caller's RLS; the confirmed value is
 * untouched. Never throws for the Record. Returns true when stored.
 */
export async function saveProposal({ sb, clearance, step, proposal, record, actor, now = () => new Date().toISOString() }) {
  const { data: row, error: readErr } = await sb.from('tm_clearances').select('proposals').eq('id', clearance.id).maybeSingle();
  // Before 122 the proposal is still returned, just not saved (slice 1's behaviour).
  if (readErr) {
    if (isSlice2Missing(readErr)) return false;
    throw new TrademarkActionError(readErr.message, 500, 'read_failed');
  }
  const proposals = { ...(row?.proposals && typeof row.proposals === 'object' ? row.proposals : {}), [step]: { ...proposal, at: now() } };
  const { error } = await sb.from('tm_clearances').update({ proposals }).eq('id', clearance.id);
  if (error) {
    if (isSlice2Missing(error)) return false;
    throw new TrademarkActionError(`Could not save the proposal: ${error.message}`, 500, 'write_failed');
  }
  if (typeof record === 'function') {
    try {
      await record(sb, { kind: 'tm.proposal.saved', matterId: clearance.matterspace_id, actor, payload: { clearance_id: clearance.id, step, model: proposal?.model ?? null, ...(actor?.kind === 'connector' ? { via: 'connector' } : {}) } });
    } catch { /* the Record never blocks the work */ }
  }
  return true;
}
