// Moving or copying a document across a sealed matter's edge (S4a).
//
// A document carries its matter's seal only while it sits in that matter. The
// moment its row is re-pointed at an open matter (a move) or duplicated into
// one (a copy), its text falls under Tier A's rules — non-sealed pens,
// connected assistants — and nothing in the sealed matter's Record says it
// went. For a document with a stored file, migration 096 already makes the
// bucket refuse the user-JWT rename or copy; for a TEXT-ONLY document (no
// storage_path: pasted text, conversation-filed notes) there is no file for
// the bucket to refuse, only a row and its passages. So the rule is asked
// here, before the move or copy runs, by every door that can perform one:
//
//   api/move-document.mjs    the Vault's Move
//   api/sandbox.mjs          the Workbench's move_document / copy_document /
//                            send_to_sandbox (which copies into a Tier A box)
//
// The rule, for any source document whose matter's EFFECTIVE tier is sealed:
//   1. the step-up gate (094's matter_entry) is asked as the user for the
//      source and the destination;
//   2. the destination must be sealed at least as tightly (C > B > A) — a
//      sealed document moves or copies deeper into the seal or sideways
//      within it, never out (S7 decides anything more);
//   3. `file.exported {document_id, title, destination: 'move'|'copy',
//      to_matter, sealed: true}` is written on the SOURCE matter's chain
//      BEFORE the operation runs, and nothing runs unless every row landed.
// Tiers are read with the service role (fetchMatterTier), so a seal inherited
// from a parent the caller cannot see still counts — lib/export-gate.mjs's
// reason. Unsealed sources are untouched by all of this.

import { fetchMatterTier, matterTierWithClient, isSealedTier } from './ai-tier-policy.mjs';
import { record } from './ledger.mjs';

export const TIER_RANK = Object.freeze({ A: 0, B: 1, C: 2 });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A matter's effective tier, or null when it cannot be read (callers refuse). */
export async function effectiveTier(matterId, { supabaseUrl, serviceKey, userClient }) {
  try {
    return serviceKey
      ? await fetchMatterTier(supabaseUrl, serviceKey, matterId)
      : await matterTierWithClient(userClient, matterId);
  } catch {
    return null;
  }
}

/**
 * 094's gate, asked as the user for each matter. Returns null when every
 * matter may be entered, else the refusal to send. 094 not pasted (the RPC is
 * absent) means there is no gate to ask.
 */
export async function entryRefusal(userClient, matterIds) {
  for (const m of matterIds) {
    const { data: entry, error } = await userClient.rpc('matter_entry', { p_matter: m });
    if (error) {
      const code = String(error.code ?? '');
      if (code !== 'PGRST202' && code !== '42883') return { status: 503, body: { error: 'seal_unresolved' } };
    } else if (entry === 'stepup' || entry === 'enrol') {
      return { status: 403, body: { error: 'step_up_required', mode: entry, matter_id: m } };
    } else if (entry !== 'open') {
      return { status: 403, body: { error: 'destination_not_found_or_no_access' } };
    }
  }
  return null;
}

/** Null when a sealed source may go to this destination, else the refusal. */
export function crossingRefusal(srcTier, destTier, verb) {
  if (!isSealedTier(srcTier)) return null;
  if (TIER_RANK[destTier] >= TIER_RANK[srcTier]) return null;
  const what = verb === 'copy' ? 'copied' : 'moved';
  return {
    status: 409,
    body: {
      error: verb === 'copy' ? 'sealed_copy_refused' : 'sealed_move_refused',
      message: `This document is in a sealed matter. It can be ${what} only to a matter sealed at least as `
        + `tightly; ${verb === 'copy' ? 'copying' : 'moving'} it out would take it past the seal.`,
    },
  };
}

/** Write the crossing to the source matter's Record. Returns {ok}. */
export async function recordCrossing(userClient, { userId, doc, verb, toMatter, sealed }) {
  const out = await record(userClient, {
    kind: 'file.exported',
    matterId: doc.matterspace_id,
    actor: { kind: 'user', ref: userId, user_id: userId },
    payload: {
      document_id: doc.id,
      title: doc.title ?? doc.source_filename ?? null,
      destination: verb,
      to_matter: toMatter,
      sealed: Boolean(sealed),
    },
  });
  return { ok: Boolean(out?.ok), error: out?.error ?? null };
}

/**
 * The Workbench's door (api/sandbox.mjs): run the rule above for a
 * move_document / copy_document / send_to_sandbox call BEFORE it dispatches.
 * `resolveDestination(key)` resolves a matter argument as the user (mcp-core's
 * resolveMatter). Returns { refusal } to send, or {} to go ahead.
 */
export async function guardSandboxCrossing({ action, args, userClient, userId, supabaseUrl, serviceKey, resolveDestination }) {
  const verb = action === 'move_document' ? 'move' : 'copy';
  const ids = [];
  if (Array.isArray(args?.document_ids)) for (const d of args.document_ids) if (typeof d === 'string' && UUID_RE.test(d)) ids.push(d);
  if (typeof args?.document_id === 'string' && UUID_RE.test(args.document_id)) ids.push(args.document_id);
  if (ids.length === 0) return {};   // the handler reports the missing argument

  const { data: docs, error } = await userClient
    .from('documents').select('id, title, source_filename, matterspace_id').in('id', ids);
  if (error) return { refusal: { status: 503, body: { error: 'seal_unresolved' } } };

  const tiers = new Map();
  for (const m of new Set((docs ?? []).map((d) => d.matterspace_id))) {
    const t = await effectiveTier(m, { supabaseUrl, serviceKey, userClient });
    if (!t) return { refusal: { status: 503, body: { error: 'seal_unresolved' } } };
    tiers.set(m, t);
  }
  const sealedDocs = (docs ?? []).filter((d) => isSealedTier(tiers.get(d.matterspace_id)));
  if (sealedDocs.length === 0) return {};

  const gate = await entryRefusal(userClient, [...new Set(sealedDocs.map((d) => d.matterspace_id))]);
  if (gate) return { refusal: gate };

  // send_to_sandbox copies into a Sandbox box, which is an ordinary Tier A
  // matter (ensureSandboxBox sets no tier): out of the seal by construction.
  let dest = null;
  let destTier = 'A';
  if (action !== 'send_to_sandbox') {
    try {
      dest = await resolveDestination(String(args?.to_matter ?? ''));
    } catch {
      return { refusal: { status: 403, body: { error: 'destination_not_found_or_no_access' } } };
    }
    if (!dest?.id) return { refusal: { status: 403, body: { error: 'destination_not_found_or_no_access' } } };
    const destGate = await entryRefusal(userClient, [dest.id]);
    if (destGate) return { refusal: destGate };
    destTier = await effectiveTier(dest.id, { supabaseUrl, serviceKey, userClient });
    if (!destTier) return { refusal: { status: 503, body: { error: 'seal_unresolved' } } };
  }

  for (const d of sealedDocs) {
    const no = crossingRefusal(tiers.get(d.matterspace_id), destTier, verb);
    if (no) return { refusal: no };
  }

  // Allowed: written down first, every one, or nothing runs.
  for (const d of sealedDocs) {
    const r = await recordCrossing(userClient, { userId, doc: d, verb, toMatter: dest?.id ?? null, sealed: true });
    if (!r.ok) return { refusal: { status: 503, body: { error: 'record_failed' } } };
  }
  return {};
}
