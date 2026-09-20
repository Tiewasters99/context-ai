// lib/ledger.mjs — the matter's Record, from the application side.
//
// One function matters: record(). It writes exactly one row into
// public.events (migration 064) through the ledger_append RPC, under the
// CALLER's Supabase client — never the service role — so the row is stamped
// with the real auth.uid() and the database decides whether the caller was
// allowed to touch that matter.
//
// Three rules this file exists to keep:
//
//   1. **Metadata only.** A payload may carry a tool name, document ids, a
//      model, a provider, token counts, a cost, a retention tier, an
//      outcome. It may never carry document text, a prompt, or a model's
//      answer. redact() enforces that mechanically before anything leaves
//      this process, and migration 064 caps what it writes at 8 KB.
//
//   2. **It does not break the thing it is recording.** record() never
//      throws into its caller: a failure returns {ok:false} and warns.
//      recordStrict() is the opposite and is used in exactly one place —
//      a sealed matter, where the record IS the product.
//
//   3. **"Not deployed" is not "failed".** If migration 064 has not been
//      pasted yet, PostgREST answers PGRST202 ("could not find the function
//      … in the schema cache"). That is reported as {ok:false,
//      notDeployed:true} and NEVER as a write failure, so merging this code
//      before Eden pastes the migration changes nothing about how the
//      product behaves — including on sealed matters, which must not start
//      refusing answers merely because a table does not exist yet.

/**
 * The vocabulary. Kept in step with the CHECK constraint on public.events;
 * a kind that is not in the table's list is refused by Postgres (23514).
 *
 *   tool.invoked         {tool, matter_ids, document_ids, connector_client_id,
 *                         charter_id, ok, refused, ms, args, result_summary}
 *   completion.received  {tier, provider, model, input_tokens, output_tokens,
 *                         estimated_cost, within_policy, escalation,
 *                         tools_used, rounds, retention, error}
 *   file.exported        {document_id, title, destination, sha256}
 *   file.sent            {document_ids, channel, to, subject}
 *   file.delivered       {production_id, delivery_id, recipient,
 *                         package_sha256, bates_range}
 *   file.gate            {document_id, gate, allowed, reason}        (W6)
 *   citation.verified    {document_id, run_id, cites, verified_by}   (W6)
 *   acl.changed          {table, op, target_user_id, old_role, new_role}
 *   seal.changed         {old_tier, new_tier}
 *   connector.registered {client_id, client_name}                    (W2)
 *   connector.revoked    {client_id, client_name, by}                (W2)
 *   ai.paused/ai.resumed {reason}                                    (W3)
 *   run.aborted          {session_id, by, round}                     (W3)
 */
export const EVENT_KINDS = Object.freeze([
  'tool.invoked',
  'completion.received',
  'file.exported',
  'file.sent',
  'file.delivered',
  'file.gate',
  'citation.verified',
  'acl.changed',
  'seal.changed',
  'connector.registered',
  'connector.revoked',
  'ai.paused',
  'ai.resumed',
  'run.aborted',
]);

/** The roadmap calls them event types; the schema calls them kinds. Same list. */
export const EVENT_TYPES = EVENT_KINDS;

/** The nil uuid: the chain events that belong to no matter share. */
export const NIL_CHAIN = '00000000-0000-0000-0000-000000000000';

export class LedgerWriteError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'LedgerWriteError';
    this.code = 'ledger_write_failed';
    this.detail = detail ?? null;
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------
// Two separate jobs, and the order matters.
//
// First, KEYS THAT CARRY CONTENT. A tool's arguments are not metadata:
// file_document carries `text`, create_deck carries `slides`, set_matter_state
// carries `headline` and `next_action`, the editor tools carry `markdown`.
// Those are the matter's own words and they must not be copied into a second
// table with different retention. They are replaced by their size.
//
// Second, KEYS THAT CARRY SECRETS — api keys, bearer tokens, passwords.
//
// Finally, anything still long enough to be prose rather than an identifier
// is replaced by its size too. An id, a short_code, a tool name, a model name
// and a matter title all fit comfortably under the limit.
const CONTENT_KEYS = new Set([
  'text', 'content', 'contents', 'body', 'markdown', 'md', 'html', 'prose',
  'slides', 'notes', 'note', 'prompt', 'answer', 'message', 'messages',
  'headline', 'next_action', 'next_action_owner', 'description', 'summary',
  'instructions', 'system', 'passage', 'passages', 'quote', 'excerpt',
  'data', 'rows', 'values', 'caption',
]);
const SECRET_RE = /(key|token|secret|password|passwd|authorization|credential|cookie|signature)/i;
const MAX_STRING = 256;
const MAX_ARRAY = 50;
const MAX_DEPTH = 6;

/**
 * Metadata-only copy of `obj`. Never returns the caller's strings verbatim
 * beyond MAX_STRING characters, and never returns a value under a
 * content-bearing or secret-bearing key.
 */
export function redact(obj, depth = 0) {
  if (obj === null || obj === undefined) return null;
  const t = typeof obj;
  if (t === 'number' || t === 'boolean') return obj;
  if (t === 'bigint') return Number(obj);
  if (t === 'string') return obj.length > MAX_STRING ? { chars: obj.length } : obj;
  if (t !== 'object') return String(t);
  if (depth >= MAX_DEPTH) return { truncated: 'depth' };

  if (Array.isArray(obj)) {
    const out = obj.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
    if (obj.length > MAX_ARRAY) out.push({ omitted: obj.length - MAX_ARRAY });
    return out;
  }

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    // A number or a boolean cannot carry a secret or prose, so it survives
    // under ANY key. Found 2026-09-20: SECRET_RE matches on "token", so
    // `input_tokens` and `output_tokens` — two columns of the Record's own
    // published contract — were being written as '[redacted]', and every
    // reconciliation of a turn against its cost read a string where a count
    // belonged. `estimated_cost` escaped only because its name has no match.
    if (typeof v === 'number' || typeof v === 'boolean') { out[k] = v; continue; }
    if (SECRET_RE.test(k)) { out[k] = '[redacted]'; continue; }
    if (CONTENT_KEYS.has(k.toLowerCase())) {
      // A value that has ALREADY been reduced to its shape is left alone, so
      // that running redact() over redactToolArgs()'s output does not reduce
      // {present:true, length:11} to the size of *that object's* JSON.
      out[k] = isShapeMarker(v) ? v : sizeOf(v);
      continue;
    }
    if (k.toLowerCase() === 'query' && typeof v === 'string') {
      // A search query is the user's own words, but it is also the single
      // most useful line in a tool record. Kept, hard-truncated.
      out[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
      continue;
    }
    out[k] = redact(v, depth + 1);
  }
  return out;
}

function sizeOf(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return { chars: v.length };
  if (Array.isArray(v)) return { items: v.length };
  try { return { chars: JSON.stringify(v).length }; } catch { return { chars: -1 }; }
}

/** One of the markers this module writes in place of a value it will not store. */
function isShapeMarker(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length === 1 && ['chars', 'items', 'truncated'].includes(keys[0])) return true;
  return keys.length === 2 && v.present === true && typeof v.length === 'number';
}

// ---------------------------------------------------------------------------
// Tool arguments — an ALLOW-list, not a deny-list
// ---------------------------------------------------------------------------
// redact() above is a DENY-list: it names the keys it knows carry content and
// lets everything else through. That is the right shape for the payloads this
// module assembles itself, where every key was chosen here. It is the wrong
// shape for `tool.invoked`, whose payload embeds a tool's RAW arguments — a
// set of keys chosen by whoever writes the next tool, not by this file.
//
// The hole it left: `search`'s query argument is named `q`. redact() special
// cases `query`, so `q` fell through to the general 256-character limit and a
// lawyer's search string went into the Record VERBATIM — in a row that
// neither its author, nor service_role, nor a superuser can ever delete. A
// search string can itself be privileged ("did Peloso know about the side
// letter before the closing"): it is the question counsel was asking, which
// is work product even when the passages it found are not.
//
// So the rule is inverted here. An argument survives only if it is safe BY
// CONSTRUCTION — and the VALUE is checked, not just the key name, because a
// tool is free to put prose in an argument called `id`:
//
//   * ids       `matter`, `to_matter`, `parent`, `serverspace`, `short_code`
//               survive as a uuid or a slug; `document_id`, `doc`, `id` only
//               as a uuid; `document_ids` only when EVERY element is a uuid;
//   * enums     `encoding`, `doc_type`, `status`, `type` survive only when
//               the value is one the tool's own schema lists;
//   * numbers   and booleans survive under any key — a limit, a page count,
//               `full_text: true` — because neither can carry prose;
//   * anything else string-valued, under any key, known or not yet invented,
//               becomes {present: true, length: n}. Arrays become {items: n}.
//
// The default is therefore refusal, which is what makes a tool added next
// year safe without anyone remembering to come back here.
const ARG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A short_code / serverspace handle: letters, digits, _ and - only. */
const ARG_HANDLE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ARG_UUID_KEYS = new Set(['document_id', 'doc', 'id']);
const ARG_HANDLE_KEYS = new Set(['matter', 'to_matter', 'parent', 'serverspace', 'short_code']);
const ARG_UUID_LIST_KEYS = new Set(['document_ids']);
const ARG_ENUMS = Object.freeze({
  encoding: ['utf8', 'base64'],
  doc_type: ['transcript', 'deposition', 'exhibit', 'brief', 'expert_report',
    'contract', 'correspondence', 'other'],
  status: ['active', 'urgent', 'waiting', 'dormant', 'archived'],
  type: ['bar', 'line', 'pie', 'doughnut'],
});
const ARG_MAX_DEPTH = 4;

const presence = (s) => ({ present: true, length: s.length });

/**
 * The shape of a tool's arguments, and nothing else. Used for the `args` key
 * of every `tool.invoked` payload before it reaches redact().
 */
export function redactToolArgs(args, depth = 0) {
  if (args === null || args === undefined) return null;
  const t = typeof args;
  if (t === 'number' || t === 'boolean') return args;
  if (t === 'bigint') return Number(args);
  if (t === 'string') return presence(args);   // a bare string has no key to vouch for it
  if (t !== 'object') return String(t);
  if (depth >= ARG_MAX_DEPTH) return { truncated: 'depth' };
  if (Array.isArray(args)) return { items: args.length };

  const out = {};
  for (const [k, v] of Object.entries(args)) {
    const key = k.toLowerCase();
    // Numbers and booleans first, as this function's own rule above says:
    // "a limit, a page count, `full_text: true` — because neither can carry
    // prose". Testing SECRET_RE ahead of them turned `max_tokens: 8192` into
    // '[redacted]' (same "token" match as in redact()).
    if (typeof v === 'number' || typeof v === 'boolean') { out[k] = v; continue; }
    if (SECRET_RE.test(k)) { out[k] = '[redacted]'; continue; }
    if (typeof v === 'string') { out[k] = allowedArgString(key, v); continue; }
    if (ARG_UUID_LIST_KEYS.has(key) && Array.isArray(v)) {
      const ids = v.filter((d) => typeof d === 'string' && ARG_UUID_RE.test(d));
      out[k] = ids.length === v.length && v.length <= MAX_ARRAY ? ids : { items: v.length };
      continue;
    }
    out[k] = redactToolArgs(v, depth + 1);
  }
  return out;
}

function allowedArgString(key, v) {
  if (ARG_UUID_KEYS.has(key)) return ARG_UUID_RE.test(v) ? v : presence(v);
  if (ARG_HANDLE_KEYS.has(key)) {
    return ARG_UUID_RE.test(v) || ARG_HANDLE_RE.test(v) ? v : presence(v);
  }
  const allowed = ARG_ENUMS[key];
  if (allowed) return allowed.includes(v) ? v : presence(v);
  return presence(v);
}

/**
 * An error message with every free-text argument value taken back out of it.
 *
 * The arguments themselves are shaped above, but a handler is free to quote
 * one back — Postgres does, when a malformed tsquery comes back as `syntax
 * error in tsquery: "..."`. That would put the very string the allow-list
 * just refused into the same undeletable row by the back door.
 */
export function scrubArgValues(text, args) {
  let out = String(text ?? '');
  if (!out || !args || typeof args !== 'object') return out;
  for (const v of argStrings(args)) {
    if (v.length < 4 || !out.includes(v)) continue;
    out = out.split(v).join('[argument]');
  }
  return out;
}

/** Every string anywhere in an argument object, longest first. */
function argStrings(node, depth = 0, acc = []) {
  if (depth >= ARG_MAX_DEPTH || node === null || typeof node !== 'object') return acc;
  for (const v of Object.values(node)) {
    if (typeof v === 'string') acc.push(v);
    else if (v && typeof v === 'object') argStrings(v, depth + 1, acc);
  }
  return depth === 0 ? acc.sort((a, b) => b.length - a.length) : acc;
}

// ---------------------------------------------------------------------------
// "The migration has not been pasted yet" vs "the write failed"
// ---------------------------------------------------------------------------
const NOT_DEPLOYED_CODES = new Set([
  'PGRST202',  // function not found in the schema cache
  'PGRST203',  // overloaded function not resolvable
  'PGRST205',  // table not found in the schema cache
  '42883',     // undefined_function
  '42P01',     // undefined_table
  '3F000',     // invalid_schema_name
]);
const NOT_DEPLOYED_RE =
  /(could not find the (function|table)|schema cache|function .* does not exist|relation .* does not exist)/i;

/** True when the ledger simply is not in this database yet. */
export function isNotDeployed(error) {
  if (!error) return false;
  if (error.code && NOT_DEPLOYED_CODES.has(String(error.code))) return true;
  return NOT_DEPLOYED_RE.test(String(error.message ?? ''));
}

let warnedNotDeployed = false;
let warnedNoActor = false;

// ---------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------
/**
 * Write one event.
 *
 * @param supabase  the USER-scoped client (never the service role: the row's
 *                  byline is auth.uid(), stamped by the database).
 * @param {object}  o
 * @param {string}  o.kind        one of EVENT_KINDS (alias: o.type).
 * @param {string?} o.matterId    the matter this act belongs to, when there is one.
 * @param {string?} o.serverspaceId  for the few events that belong to no matter.
 * @param {string?} o.sessionId   ai_sessions.id, when there is one.
 * @param {object?} o.actor       {kind:'user'|'charter'|'connector'|'system',
 *                                 ref, user_id?, label?} — see the roadmap's
 *                                 W1/W2 contract. Missing ⇒ {user, unknown}.
 * @param {object?} o.payload     METADATA ONLY; redacted here before it leaves.
 * @param {boolean} o.strict      throw LedgerWriteError instead of warning.
 * @returns {Promise<{ok:boolean, notDeployed?:boolean, id?:string, seq?:number,
 *                    hash?:string, error?:object}>}
 */
export async function record(supabase, {
  kind, type, matterId = null, serverspaceId = null, sessionId = null,
  actor = null, payload = {}, strict = false,
} = {}) {
  const eventKind = kind ?? type;
  const a = normalizeActor(actor);

  if (!supabase || typeof supabase.rpc !== 'function') {
    return finish({ ok: false, error: { message: 'no supabase client' } }, strict, eventKind);
  }
  if (!eventKind || !EVENT_KINDS.includes(eventKind)) {
    return finish(
      { ok: false, error: { message: `unknown ledger event kind: ${eventKind}` } },
      strict, eventKind,
    );
  }

  let data = null;
  let error = null;
  try {
    ({ data, error } = await supabase.rpc('ledger_append', {
      p_kind: eventKind,
      p_matter: matterId ?? null,
      p_serverspace: serverspaceId ?? null,
      p_session: sessionId ?? a.session_id ?? null,
      p_actor_kind: a.kind,
      p_actor_ref: a.ref,
      p_actor_label: a.label,
      p_payload: redact(payload ?? {}) ?? {},
    }));
  } catch (err) {
    error = { message: err?.message || String(err), code: err?.code };
  }

  if (error) {
    if (isNotDeployed(error)) {
      if (!warnedNotDeployed) {
        warnedNotDeployed = true;
        console.warn(
          '[ledger] public.events / ledger_append is not deployed in this database — ' +
          'events are not being recorded. Paste supabase/migrations/064_events_ledger.sql, ' +
          "then run: notify pgrst, 'reload schema';",
        );
      }
      return { ok: false, notDeployed: true, error };
    }
    return finish({ ok: false, error }, strict, eventKind);
  }

  // PostgREST hands back whatever the function returned. A stub or an older
  // deployment may answer with an empty array; an absent error is the only
  // signal that actually matters.
  const row = Array.isArray(data) ? data[0] : data;
  return {
    ok: true,
    id: row?.id ?? null,
    seq: row?.seq ?? null,
    hash: row?.hash ?? null,
  };
}

/** record(), but a failure throws LedgerWriteError. Not-deployed still does not. */
export async function recordStrict(supabase, opts = {}) {
  return record(supabase, { ...opts, strict: true });
}

function finish(result, strict, kind) {
  const msg = result.error?.message || 'ledger write failed';
  if (strict) throw new LedgerWriteError(`${kind ?? 'event'}: ${msg}`, result.error);
  console.warn(`[ledger] ${kind ?? 'event'} was not recorded: ${msg}`);
  return result;
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object' || !actor.kind) {
    if (!warnedNoActor) {
      warnedNoActor = true;
      console.warn('[ledger] no actor supplied — recording as {kind:"user", ref:"unknown"}');
    }
    return { kind: 'user', ref: 'unknown', user_id: null, session_id: null, label: null };
  }
  const kind = ['user', 'charter', 'connector', 'system'].includes(actor.kind) ? actor.kind : 'user';
  return {
    kind,
    ref: str(actor.ref) ?? str(actor.user_id) ?? 'unknown',
    user_id: actor.user_id ?? null,
    session_id: actor.session_id ?? null,
    label: str(actor.label) ?? null,
  };
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);

// ---------------------------------------------------------------------------
// verifyChain
// ---------------------------------------------------------------------------
/**
 * Recompute one chain's hashes in the database.
 * @returns {Promise<{ok:boolean, checked:number, first_bad_seq:number|null,
 *                    notDeployed?:boolean, error?:object}>}
 */
export async function verifyChain(supabase, chainKey) {
  const { data, error } = await supabase.rpc('verify_chain', {
    p_chain_key: chainKey ?? NIL_CHAIN,
  });
  if (error) {
    return {
      ok: false, checked: 0, first_bad_seq: null,
      ...(isNotDeployed(error) ? { notDeployed: true } : {}),
      error,
    };
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    ok: Boolean(row?.ok),
    checked: Number(row?.checked ?? 0),
    first_bad_seq: row?.first_bad_seq ?? null,
  };
}

/** Test seam: the module warns once per process; harnesses run many cases. */
export function _resetWarnings() {
  warnedNotDeployed = false;
  warnedNoActor = false;
}
