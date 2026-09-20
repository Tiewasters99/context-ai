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
 *   completion.requested {feature, call_id, tier, provider, model,
 *                         client_provider, client_model, route, streaming,
 *                         max_output_tokens, document_ids, refused, status}
 *                                                                    (073)
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
 *   connector.connected  {client_id, client_name, grant_id}          (W2, 072)
 *   connector.revoked    {client_id, client_name, by}                (W2)
 *   ai.paused/ai.resumed {reason}                                    (W3)
 *   run.aborted          {session_id, by, round}                     (W3)
 */
export const EVENT_KINDS = Object.freeze([
  'tool.invoked',
  'completion.requested',
  'completion.received',
  'file.exported',
  'file.sent',
  'file.delivered',
  'file.gate',
  'citation.verified',
  'acl.changed',
  'seal.changed',
  'connector.registered',
  'connector.connected',
  'connector.revoked',
  'ai.paused',
  'ai.resumed',
  'run.aborted',
]);

/**
 * The kinds that may sit on an ACCOUNT chain (migration 072). Everything
 * else is matter-bound by definition — a completion happened in a matter,
 * an ACL change changed a matter — and the database refuses it too.
 */
export const ACCOUNT_EVENT_KINDS = Object.freeze([
  'tool.invoked',
  'connector.registered',
  'connector.connected',
  'connector.revoked',
  'ai.paused',
  'ai.resumed',
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

// ---------------------------------------------------------------------------
// "The vocabulary has not been widened yet" — the same fact, one layer down
// ---------------------------------------------------------------------------
// isNotDeployed above answers "this database has no ledger". There is a second
// deployment state with exactly the same meaning for a caller and a completely
// different SQLSTATE: the ledger is there, but its CHECK constraint predates
// this build, so a kind a later migration adds is refused with 23514.
//
// It matters because of the sealed guarantee. On a sealed matter a REAL write
// failure refuses the request and no provider is called. If "your database
// has not had 073 pasted yet" counted as a real failure, merging the code
// before Eden pastes the file would take sealed Bucketizer, Cite-Check and the
// Editor offline — the precise thing 064's and 072's own "merging early is
// safe" contracts exist to prevent.
//
// So it is classified as NOT DEPLOYED, and the test is deliberately narrow on
// all three axes: the code is 23514, the message names `events_kind_check`,
// and the kind is one 064's own list never had. A check violation on any other
// constraint, or on a kind that has been legal since 064, stays a real failure.
const KINDS_064 = new Set([
  'tool.invoked', 'completion.received', 'file.exported', 'file.sent',
  'file.delivered', 'file.gate', 'citation.verified', 'acl.changed',
  'seal.changed', 'connector.registered', 'connector.revoked',
  'ai.paused', 'ai.resumed', 'run.aborted',
]);

/** Which migration a kind outside 064's list was added by, for the warning. */
const KIND_MIGRATIONS = Object.freeze({
  'connector.connected': '072_account_chain_and_session_immutability.sql',
  'completion.requested': '073_completion_requested.sql',
});

/**
 * True when the write failed only because this database's `events_kind_check`
 * has not been widened to admit `kind` yet.
 */
export function isKindNotAdmitted(error, kind) {
  if (!error || !kind || KINDS_064.has(kind)) return false;
  if (String(error.code ?? '') !== '23514') return false;
  const text = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`;
  return /events_kind_check/.test(text);
}

let warnedNotDeployed = false;
let warnedNoActor = false;
const warnedKinds = new Set();

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
    if (isKindNotAdmitted(error, eventKind)) {
      if (!warnedKinds.has(eventKind)) {
        warnedKinds.add(eventKind);
        const file = KIND_MIGRATIONS[eventKind] ?? 'the migration that adds it';
        console.warn(
          `[ledger] this database's events_kind_check does not admit '${eventKind}' yet — ` +
          `those rows are not being recorded. Paste supabase/migrations/${file}, ` +
          "then run: notify pgrst, 'reload schema';",
        );
      }
      return { ok: false, notDeployed: true, kindNotAdmitted: true, error };
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
  warnedAccountNotDeployed = false;
  warnedKinds.clear();
}

/**
 * A list of document ids, or its size — never a mixture, and never a string
 * the caller chose.
 *
 * `redact()` keeps any string under 256 characters, so a payload key called
 * `document_ids` whose elements a CLIENT supplied would put arbitrary text
 * into a row nobody can delete. Every element must be a uuid for the list to
 * survive; one that is not turns the whole list into its size. Same rule as
 * `redactToolArgs`'s `document_ids`, exported so the handlers that assemble
 * their own payloads can apply it before redact() ever sees the value.
 */
export function uuidList(value, max = MAX_ARRAY) {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return [];
  if (value.length > max) return { items: value.length };
  const ids = value.filter((v) => typeof v === 'string' && ARG_UUID_RE.test(v));
  return ids.length === value.length ? ids : { items: value.length };
}

// ===========================================================================
// 072 — the account chain, and the fan-out
// ===========================================================================
// #170 declared the hole and this closes it: a connected AI calling `search`
// with `matter` omitted — which the MCP tool description advertises, and
// which is the broadest read a connector can make — resolved to no single
// matter, so it was recorded nowhere.
//
// One such call now writes, at most, 1 + N rows:
//
//   * ONE row on the caller's own ACCOUNT chain, carrying COUNTS ONLY: the
//     tool, the connector, the shape of the arguments, how many matters were
//     touched and how many results came back. Never a matter id, never a
//     matter name, never the query text.
//
//   * ONE row in EACH matter the call actually read from, on that matter's
//     own chain, saying "a connected assistant read from this matter as part
//     of an account-wide search" and carrying THAT MATTER'S OWN result count
//     and nothing else.
//
// The isolation contract (feedback_strict_matter_isolation) is what dictates
// both halves:
//
//   * a fan-out row names only the matter it is in, so opening M1's Record —
//     or exporting it for a court — cannot tell anyone that M3 exists;
//   * the account row is on a chain only its own owner can read, and even
//     there it holds counts rather than ids, so an account-wide roll-up
//     cannot become a back door into a list of matter names;
//   * the QUERY TEXT is dropped from both. redact() keeps `query` (truncated)
//     because on a matter-scoped call it is the single most useful line in the
//     record. A cross-matter query is different in kind: "Peloso arbitration
//     award" typed once would otherwise be copied verbatim into every matter
//     it happened to hit, putting one client's words in another client's
//     record. shapeOnly() is used instead, for the account row AND for every
//     fan-out row. (The search tool's argument is `q`, not `query`, so this is
//     not theoretical: redact() would have stored it verbatim.)
//
// Sealed matters never appear on either side, because they never reach the
// result: enforceConnectorSeal removes them from the search scope before the
// query runs (lib/mcp-core.mjs). The filter below is a second line, not the
// first one.

/** The ceiling on fan-out rows for one call. */
export const FANOUT_CEILING = 100;

/** The string a fan-out row carries in payload.via. It is a read contract. */
export const FANOUT_VIA = 'account-wide search';

/**
 * Metadata about the SHAPE of an argument object, with no string values at
 * all. Numbers and booleans survive (a limit of 5, full_text:true); every
 * string becomes its length; arrays and objects become their sizes.
 *
 * redact() is the floor under a payload. This is the floor under an argument
 * set that is about to be copied into a matter that did not ask for it.
 */
export function shapeOnly(obj, depth = 0) {
  if (obj === null || obj === undefined) return null;
  const t = typeof obj;
  if (t === 'number' || t === 'boolean') return obj;
  if (t === 'bigint') return Number(obj);
  if (t === 'string') return { chars: obj.length };
  if (t !== 'object') return String(t);
  if (depth >= 3) return { truncated: 'depth' };
  if (Array.isArray(obj)) return { items: obj.length };
  const out = {};
  for (const k of Object.keys(obj)) {
    // Numbers and booleans carry no secret under ANY key — the same ordering
    // fix redact() and redactToolArgs() got: SECRET_RE matches "token", which
    // would otherwise turn `max_tokens: 8192` into '[redacted]'.
    const v = obj[k];
    if (SECRET_RE.test(k) && typeof v !== 'number' && typeof v !== 'boolean') { out[k] = '[redacted]'; continue; }
    out[k] = shapeOnly(v, depth + 1);
  }
  return out;
}

/**
 * Which matters a tool's RESULT actually read from, and how much each one
 * gave back. Returns a Map<matterId, count>, or an empty Map.
 *
 * Only `search` fans out today, and only when it ran without a matter: that
 * is the one tool whose result attributes each hit to a matter
 * (handleSearch's `matterByDoc`, which it populates only on the matter-less
 * path). `list_matters` deliberately does NOT fan out — it enumerates
 * matters, it does not read from them, and a row in every matter on every
 * connector handshake would be noise in the one place that must stay
 * readable. It is recorded on the account chain with its count.
 */
export function mattersTouchedBy(tool, result) {
  const counts = new Map();
  if (tool !== 'search' || !result || !Array.isArray(result.results)) return counts;
  for (const r of result.results) {
    const id = r?.matter?.id;
    if (typeof id !== 'string' || !id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

let warnedAccountNotDeployed = false;

/**
 * Write one event on the CALLER'S OWN account chain (migration 072).
 *
 * There is no matterId: the database takes the chain key from auth.uid()
 * inside a SECURITY DEFINER function, so this cannot be aimed at anybody
 * else's chain.
 *
 * Not-deployed is its own case with its own message. 064 present + 072
 * absent is a real state — Eden pastes two files — and in it the fan-out
 * rows still write, because they are ordinary 064 matter rows. Each
 * matter's own Record therefore stays true; only the account-level roll-up
 * is missing until the second paste.
 */
export async function recordAccount(supabase, {
  kind, type, sessionId = null, actor = null, payload = {}, strict = false,
} = {}) {
  const eventKind = kind ?? type;
  const a = normalizeActor(actor);

  if (!supabase || typeof supabase.rpc !== 'function') {
    return finish({ ok: false, error: { message: 'no supabase client' } }, strict, eventKind);
  }
  if (!eventKind || !ACCOUNT_EVENT_KINDS.includes(eventKind)) {
    return finish(
      { ok: false, error: { message: `not an account-chain event kind: ${eventKind}` } },
      strict, eventKind,
    );
  }

  let data = null;
  let error = null;
  try {
    ({ data, error } = await supabase.rpc('ledger_append_account', {
      p_kind: eventKind,
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
      if (!warnedAccountNotDeployed) {
        warnedAccountNotDeployed = true;
        console.warn(
          '[ledger] ledger_append_account is not deployed in this database — account-wide ' +
          'connector activity is not being rolled up (each matter it touched is still ' +
          'recorded). Paste supabase/migrations/072_account_chain_and_session_immutability.sql, ' +
          "then run: notify pgrst, 'reload schema';",
        );
      }
      return { ok: false, notDeployed: true, error };
    }
    return finish({ ok: false, error }, strict, eventKind);
  }

  const row = Array.isArray(data) ? data[0] : data;
  return { ok: true, id: row?.id ?? null, seq: row?.seq ?? null, hash: row?.hash ?? null };
}

/** Verify the caller's own account chain. */
export async function verifyAccountChain(supabase) {
  const { data, error } = await supabase.rpc('verify_account_chain', {});
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

/**
 * Record a tool call that reached beyond one matter.
 *
 * Called from mcp-core's recording point for EVERY tool call, and does
 * nothing at all for the ordinary case (a call that stayed inside one
 * matter and read from no other). Two things make it fire:
 *
 *   * `primaryMatterId` is null — the call resolved to no single matter, so
 *     #170 would have recorded nothing anywhere. One account row.
 *   * the RESULT names matters other than the primary one — an in-app
 *     assistant sitting in M1 can still call `search` with `matter` omitted
 *     and read M3, and M3's Record has exactly the same right to say so.
 *     Fan-out is keyed off the result, never off the argument.
 *
 * Never throws: the Record is not the reason a tool call fails.
 *
 * @returns {Promise<{account:object|null, fanout:number, overflow:number,
 *                    touched:number}>}
 */
export async function recordCrossMatter(supabase, {
  tool, args = {}, result = null, actor = null, sessionId = null,
  primaryMatterId = null, connector = false, excludeMatterIds = null,
  ok = true, refused = null, ms = null, error = null,
} = {}) {
  const nothing = { account: null, fanout: 0, overflow: 0, touched: 0 };
  try {
    const touchedAll = mattersTouchedBy(tool, result);
    // The seal, defensively. Sealed matters are already out of the scope
    // before the query runs, so this should never remove anything; if it
    // ever does, that is a bug upstream and the Record must not be the
    // thing that publishes it.
    if (excludeMatterIds && typeof excludeMatterIds.has === 'function') {
      for (const id of [...touchedAll.keys()]) {
        if (excludeMatterIds.has(id)) touchedAll.delete(id);
      }
    }
    // The matter the call already belongs to is recorded by #170's own row.
    if (primaryMatterId) touchedAll.delete(primaryMatterId);

    // A call that stayed inside its own matter is #170's business, not this
    // function's. A call that belongs to NO matter is always recorded, even
    // when it read nothing back: "a connected assistant searched everything
    // and found nothing" is a fact about the account worth keeping.
    if (primaryMatterId && touchedAll.size === 0) return nothing;

    const a = actor ?? null;
    const shape = shapeOnly(args ?? {});
    const common = {
      tool,
      args: shape,
      matter_filter: Boolean(args && typeof args.matter === 'string' && args.matter),
      connector: connector === true,
      connector_client_id: a?.kind === 'connector' ? (a.ref ?? null) : null,
      charter_id: a?.kind === 'charter' ? (a.ref ?? null) : null,
      // PR #166 puts the OAuth grant id on the token as `gid`. Read when it
      // is there; never depended on.
      ...(a?.grant_id ? { grant_id: a.grant_id } : {}),
      ok: ok === true,
      refused: refused ?? null,
      ms: ms ?? null,
      ...(error ? { error: String(error).slice(0, 200) } : {}),
    };

    const ids = [...touchedAll.keys()];
    const written = ids.slice(0, FANOUT_CEILING);
    const overflow = ids.length - written.length;

    // The account row goes FIRST, so the authoritative count exists even if
    // the fan-out is interrupted. It carries counts and nothing else: no
    // matter id, no matter name, not even how many results came from the
    // largest one.
    let account = null;
    if (!primaryMatterId) {
      // How much came back, as a count. `search` says so itself; a tool that
      // answers with a list (list_matters) is its length; anything else
      // reports nothing rather than guessing.
      let resultCount = null;
      if (Array.isArray(result)) resultCount = result.length;
      else if (result && typeof result === 'object') {
        if (typeof result.result_count === 'number') resultCount = result.result_count;
        else if (Array.isArray(result.results)) resultCount = result.results.length;
      }

      account = await recordAccount(supabase, {
        kind: 'tool.invoked',
        sessionId,
        actor,
        payload: {
          ...common,
          scope: 'account',
          matters_touched: ids.length,
          matters_recorded: written.length,
          matters_overflow: overflow,
          fanout_ceiling: FANOUT_CEILING,
          result_count: resultCount,
        },
      });
    }

    // Then one small row per matter, in batches. Each row knows only about
    // the matter it is in.
    let fanout = 0;
    const BATCH = 8;
    for (let i = 0; i < written.length; i += BATCH) {
      const slice = written.slice(i, i + BATCH);
      const settled = await Promise.all(slice.map((id) => record(supabase, {
        kind: 'tool.invoked',
        matterId: id,
        sessionId,
        actor,
        payload: {
          ...common,
          scope: 'matter',
          via: FANOUT_VIA,
          result_count: touchedAll.get(id) ?? 0,
        },
      }).catch(() => ({ ok: false }))));
      fanout += settled.filter((r) => r?.ok).length;
    }

    return { account, fanout, overflow, touched: ids.length };
  } catch {
    return nothing;
  }
}
