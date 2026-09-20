// SecureSpace — the seal on an EXPORT (2026-09-20)
// -----------------------------------------------------------------------------
// The pen gate (lib/ai-tier-policy.mjs) decides which MINDS may read a sealed
// matter. The connector seal (lib/mcp-core.mjs) hides sealed matters from
// outside AI clients. The pipe seal (lib/seal-pipes.mjs) stops the conveyor
// belt. All three govern what the SOFTWARE does with a sealed matter's content.
//
// This module governs what the USER does with it: "Save to Google Drive",
// "attach it to a Gmail draft", and — designed for, not yet built — OneDrive
// and Dropbox. Until today three server routes handed a document's bytes to
// Google with no tier check at all; none of the three files contained the
// string "tier" or "seal":
//
//   api/drive-export.mjs      the reader's Save to Google Drive
//   api/ext/push-to-drive.mjs the browser extension's push
//   api/gmail-send.mjs        the document as an attachment on a Gmail draft
//
// EDEN'S DECISION, 2026-09-20: when a document from a sealed matter is handed
// to any outside service, the rule is WARN AND RECORD — not block, not silent.
// Export is the user's own deliberate act on their own file; the product's job
// is to make sure they know the copy is leaving the seal, and to write down
// that it did. That is a different rule from the pen and the pipes, which
// refuse outright, and the difference is deliberate: a model reading the
// matter was never the user's act.
//
// So this gate does exactly three things, in this order, and nothing else:
//
//   1. Resolves the document's matter and that matter's EFFECTIVE tier, using
//      the pen gate's own resolver (fetchMatterTier) — not a third copy of the
//      walk. Fails CLOSED: a document that belongs to a matter whose tier
//      cannot be read is refused, in the register of lib/seal-pipes.mjs.
//   2. Unsealed → allow, and the caller behaves exactly as it did before this
//      file existed. Sealed and not confirmed → 409 with a stable code and a
//      sentence a lawyer can read; NOTHING is fetched from storage and NOTHING
//      is sent, because the gate runs before the storage download and before
//      any outside API client is constructed.
//   3. Sealed and confirmed → allow, and record that the copy left.
//
// The confirmation is per request (`confirm_leave_seal: true` in the body) and
// is NEVER remembered server-side. There is no "don't ask again": the warning
// is the product promise being kept, once per copy that leaves.
//
// WHY THE TIER WALK USES THE SERVICE ROLE. The document lookup is user-scoped,
// so RLS still decides whether this user may touch this document. The TIER is
// policy, not content (the comment fetchMatterTier carries), and it is read
// with the service role for a specific reason: walkEffectiveTier stops when an
// ancestor is invisible to the caller and keeps the tier it has so far. A user
// who can see sub-matter S but not its sealed parent M would otherwise resolve
// to Tier A and export a sealed matter's document with no warning and no
// record — fail-open on exactly the inherited seal the policy exists for.
// /api/llm's gateLlmRequest uses the service role for the same reason.

import { fetchMatterTier, isSealedTier } from './ai-tier-policy.mjs';

/**
 * The outside services a document can be handed to. A destination is a
 * STRUCTURED value — { service, account?, recipient? } — so a connector added
 * later passes through this function unchanged: register it here and the gate,
 * the wording, and the record all work without another edit.
 *
 * `party` is who actually receives the bytes, which is what the user needs to
 * be told. It is not always the brand on the button: Gmail and Drive are both
 * Google; OneDrive is Microsoft.
 */
export const EXPORT_SERVICES = Object.freeze({
  google_drive: { label: 'Google Drive', party: 'Google', mail: false, verb: 'Saving it to Google Drive' },
  gmail: { label: 'Gmail', party: 'Google', mail: true, verb: 'Attaching it to a Gmail draft' },
  onedrive: { label: 'OneDrive', party: 'Microsoft', mail: false, verb: 'Saving it to OneDrive' },
  dropbox: { label: 'Dropbox', party: 'Dropbox', mail: false, verb: 'Saving it to Dropbox' },
});

const UNKNOWN_SERVICE = Object.freeze({
  label: 'an outside service', party: 'that service', mail: false, verb: 'Sending it there',
});

/**
 * What a destination looks like once the gate has cleaned it up. Idempotent:
 * every function here normalizes its argument, so a caller may pass the raw
 * `{ service, recipient }` or an already-cleaned one and get the same answer.
 */
function normalizeDestination(destination) {
  const raw = typeof destination === 'string' ? { service: destination } : (destination || {});
  const service = typeof raw.service === 'string' ? raw.service : 'unknown';
  const spec = EXPORT_SERVICES[service] ?? UNKNOWN_SERVICE;
  return {
    service,
    label: spec.label,
    party: spec.party,
    mail: spec.mail,
    verb: spec.verb,
    // The account the file lands in, when the caller knows it. Never a token.
    account: typeof raw.account === 'string' ? raw.account : null,
    // 'draft' when the copy is staged in the user's own mailbox rather than
    // transmitted to anyone. /api/gmail-send creates a draft with no To:.
    delivery: typeof raw.delivery === 'string' ? raw.delivery : null,
    // DOMAIN ONLY, ever. A recipient's full address is not ours to keep — the
    // local part never enters this object, so re-normalizing cannot recover it.
    recipientDomain: recipientDomain(raw.recipient)
      ?? (typeof raw.recipientDomain === 'string' ? raw.recipientDomain : null),
  };
}

function recipientDomain(recipient) {
  if (typeof recipient !== 'string' || !recipient.includes('@')) return null;
  const domain = recipient.trim().split('@').pop();
  return domain ? domain.toLowerCase() : null;
}

/**
 * What kind of event this is, said literally, because Eden reads a record
 * literally: a copy PLACED in an outside service is an export; a copy
 * TRANSMITTED to a named recipient is a send. /api/gmail-send creates a draft
 * in the user's own mailbox with no To: header, so it is an export to Google
 * — it becomes a send the day something addresses it.
 */
export function exportEventKind(destination) {
  const d = normalizeDestination(destination);
  return d.mail && d.recipientDomain ? 'file.sent' : 'file.exported';
}

// ── the wording ──────────────────────────────────────────────────────────────
// Everything the user reads is composed here and travels in the response, so
// the client renders a sentence it was given rather than one it assumed. That
// matters for the recording clause especially: whether the export is written
// to the matter's record is a fact about THIS server at THIS moment (see the
// ledger seam below), not a build-time assumption, and the copy must not claim
// a record that does not exist.

export function exportConfirmMessage({ tier, destination, title, willRecord }) {
  const d = normalizeDestination(destination);
  const what = title ? `a copy of “${title}”` : 'a copy of this document';
  const where = d.label === 'an outside service' ? 'outside Contextspaces' : `outside Contextspaces, to ${d.party}`;

  const opening = tier === 'C'
    ? 'This matter is in a Silo (SecureSpace Tier C): nothing in it is meant to leave the building.'
    : 'This matter is sealed (SecureSpace Tier B).';

  const act = `${d.verb} sends ${what} ${where}, where the seal does not reach. Nothing has been sent yet.`;

  const record = willRecord
    ? 'If you continue, the export is written to this matter’s record — what left, where it went, and when.'
    : 'Exports are not written to any record yet, so if you continue, this copy leaves the seal with nothing logging that it did.';

  return `${opening} ${act} ${record}`;
}

/**
 * The line the banner adds after a sealed export has actually happened. Three
 * cases, because there are three truths: it was recorded; there is nothing
 * recording exports yet; or there is, and the write failed — which the user is
 * told rather than being left with the first sentence.
 */
export function exportedNote({ destination, recorded, reason }) {
  const d = normalizeDestination(destination);
  const left = `This matter is sealed: a copy has left Contextspaces for ${d.label}`;
  if (recorded) return `${left}, and it is recorded in the matter’s record.`;
  if (reason === 'ledger_error') {
    return `${left}. The matter’s record could not be written for it — the failure is logged on the server and should be reported.`;
  }
  return `${left}. Exports are not written to any record yet, so nothing logs it.`;
}

export function sealUnresolvedMessage() {
  return (
    'This document belongs to a matter whose seal could not be read, so nothing was sent — a matter is ' +
    'treated as sealed until its tier is known. Try again in a moment; if it keeps failing, the matter ' +
    'needs attention.'
  );
}

// ── the ledger seam ──────────────────────────────────────────────────────────
// The append-only ledger (roadmap W1: migration 064 + lib/ledger.mjs with
// record()) is being built in a parallel lane and is NOT on main as this is
// written. This module therefore has ONE seam and no migration of its own:
// it probes for ./ledger.mjs at runtime, uses it when it is there, and writes
// a structured server log line when it is not.
//
// The user-facing copy follows the probe, never a guess — while the ledger is
// absent the dialog says plainly that the copy will leave with nothing logging
// it, and the day the ledger lands the same dialog says it is recorded. One
// constant to review when that happens: the call shape below.

let ledgerModule; // undefined = not probed yet · null = absent · object = loaded

/** Test seam: inject a ledger module (or null) without touching lib/ledger.mjs. */
export function __setLedgerForTests(mod) {
  ledgerModule = mod === null ? null : (mod ?? undefined);
}

async function loadLedger() {
  if (ledgerModule !== undefined) return ledgerModule;
  try {
    // A literal specifier so file tracing can follow it once the file exists.
    // Absent today, and an absent module is an expected state, not an error.
    const mod = await import('./ledger.mjs');
    ledgerModule = mod && typeof mod.record === 'function' ? mod : null;
  } catch {
    ledgerModule = null;
  }
  return ledgerModule;
}

/** Will an export be written to a record on this server, right now? */
export async function exportsAreRecorded() {
  return (await loadLedger()) !== null;
}

/**
 * Write down that a copy left the seal. METADATA ONLY — the document's id, a
 * snapshot of its title, where it went, who sent it and when. Never the
 * content, never the storage path, never a token, never a full email address.
 *
 * Returns { recorded: boolean, reason? }. It never throws and never blocks the
 * export: Eden's rule is warn and record, not warn and refuse, so a ledger that
 * is absent or broken degrades to a log line and the response says `recorded:
 * false` rather than claiming a record that was not written.
 */
export async function recordExport({ supabase, userId, tier, matterId, documentId, title, destination }) {
  const d = normalizeDestination(destination);
  const event = {
    kind: exportEventKind(d),
    at: new Date().toISOString(),
    actor: userId ?? null,
    matter_id: matterId ?? null,
    document_id: documentId ?? null,
    document_title: title ?? null,
    tier: tier ?? null,
    destination: {
      service: d.service,
      label: d.label,
      party: d.party,
      account: d.account,
      delivery: d.delivery,
      recipient_domain: d.recipientDomain,
    },
    // The user was shown what leaving the seal means and said yes, per request.
    confirmed_leaving_seal: true,
    source: 'export-gate',
  };

  const ledger = await loadLedger();
  if (ledger) {
    try {
      // record(client, event) or record(event) — whichever lib/ledger.mjs
      // declares. One line to pin down when that file lands; a mismatch falls
      // through to the log below rather than failing the export.
      if (ledger.record.length >= 2) await ledger.record(supabase, event);
      else await ledger.record(event);
      return { recorded: true, event };
    } catch (err) {
      logExport(event, { recorded: false, reason: `ledger_error: ${err?.message ?? 'unknown'}` });
      return { recorded: false, reason: 'ledger_error', event };
    }
  }

  logExport(event, { recorded: false, reason: 'ledger_absent' });
  return { recorded: false, reason: 'ledger_absent', event };
}

/**
 * The honest fallback: one structured line on stdout. It is not a record in
 * the matter — nobody can show it to a client — and the copy shown to the user
 * says so. It exists so that when the ledger does land, this moment is not a
 * blank in the history of the deployment.
 */
function logExport(event, outcome) {
  try {
    console.warn(`[export-gate] ${JSON.stringify({ ...event, ...outcome })}`);
  } catch {
    console.warn('[export-gate] a sealed matter’s document left for an outside service (unloggable payload)');
  }
}

// ── the gate ─────────────────────────────────────────────────────────────────

/**
 * May this document be handed to this outside service?
 *
 *   supabase    — the USER-SCOPED client. RLS decides whether this user may
 *                 see this document at all.
 *   userId      — the actor, for the record.
 *   documentId  — documents.id.
 *   destination — { service, account?, recipient?, delivery? } (see above).
 *   confirmed   — strictly `true` and nothing else. PR #159's rule: a
 *                 truthy-but-not-true value does not leave the seal.
 *
 * Resolves to one of:
 *   { ok: true,  sealed: false, tier, matterId }
 *     — proceed; the caller behaves exactly as it did before the gate existed.
 *   { ok: true,  sealed: true,  tier, matterId, recorded, note }
 *     — proceed, and tell the user `note` when it lands.
 *   { ok: false, status, code, body }
 *     — answer with `body` and send nothing. 409 = the user has not been asked
 *       yet; 403 = the seal could not be read, which is a refusal.
 */
export async function checkExport({ supabase, userId, documentId, destination, confirmed = false }) {
  const d = normalizeDestination(destination);

  const refuse = (status, code, message, extra = {}) => ({
    ok: false,
    status,
    code,
    body: { error: code, code, message, destination: { service: d.service }, ...extra },
  });

  if (!documentId) {
    return refuse(400, 'export_document_required', 'No document was named, so nothing was sent.');
  }

  // 1. Which matter is this document in? User-scoped on purpose: if RLS will
  //    not show the document to this user, the gate does not resolve a seal
  //    for it and nothing leaves.
  let doc = null;
  try {
    const { data, error } = await supabase
      .from('documents')
      .select('id, title, matterspace_id')
      .eq('id', documentId)
      .maybeSingle();
    if (!error) doc = data;
  } catch {
    doc = null; // a client that throws is not an open door
  }
  if (!doc) return refuse(403, 'export_seal_unresolved', sealUnresolvedMessage());

  // 2. A document in no matter — a loose upload — has no seal to violate,
  //    the same rule /api/llm applies to an unbound draft.
  if (!doc.matterspace_id) {
    return { ok: true, sealed: false, tier: null, matterId: null, title: doc.title ?? null };
  }

  // 3. The effective tier, with the service role (see the header).
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return refuse(403, 'export_seal_unresolved', sealUnresolvedMessage());
  }
  let tier = null;
  try {
    tier = await fetchMatterTier(supabaseUrl, serviceKey, doc.matterspace_id);
  } catch {
    tier = null; // a lookup that throws is not an open door
  }
  if (!tier) return refuse(403, 'export_seal_unresolved', sealUnresolvedMessage());

  if (!isSealedTier(tier)) {
    return { ok: true, sealed: false, tier, matterId: doc.matterspace_id, title: doc.title ?? null };
  }

  // 4. Sealed. Has the user been told, for this request?
  const willRecord = await exportsAreRecorded();
  if (confirmed !== true) {
    return refuse(
      409,
      'export_needs_confirmation',
      exportConfirmMessage({ tier, destination: d, title: doc.title, willRecord }),
      {
        needs_confirmation: true,
        sealed: true,
        tier,
        will_record: willRecord,
        // What a client that has no UI of ours (the browser extension) must
        // send to proceed, named rather than guessed at.
        confirm_field: 'confirm_leave_seal',
      },
    );
  }

  // 5. Told, and said yes. Write it down before the copy moves: the record is
  //    of the authorization to leave, which is the moment the seal is crossed.
  const { recorded, reason } = await recordExport({
    supabase, userId, tier, matterId: doc.matterspace_id, documentId: doc.id, title: doc.title, destination: d,
  });

  return {
    ok: true,
    sealed: true,
    tier,
    matterId: doc.matterspace_id,
    title: doc.title ?? null,
    recorded,
    note: exportedNote({ destination: d, recorded, reason }),
  };
}

/**
 * The `seal` block a handler adds to its 200 when — and only when — the matter
 * was sealed. An unsealed export's response body stays byte-identical to what
 * it was before this gate existed.
 */
export function sealResult(gate) {
  if (!gate?.sealed) return null;
  return { sealed: true, tier: gate.tier, recorded: Boolean(gate.recorded), note: gate.note };
}
