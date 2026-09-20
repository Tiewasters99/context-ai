# The matter's Record — W1 (migration 064 + `lib/ledger.mjs`)

Every matter keeps a Record: an append-only, hash-chained list of what was
done to it and who did it — a person, an agent charter, or a connected
assistant. The Record is the artefact a lawyer hands to a court, a client or
an insurer, so "append-only" is enforced by triggers that refuse a superuser,
not by a comment.

This file is the **contract**. W5's Record tab, the Matter Record export and
the in-product AI Use Record all read what is described here. W2 (connectors)
and W3 (kill switch) write into it. Nothing below changes without this file
changing first.

Designed in `memory/project_security_provenance_roadmap_2026_09_10.md` §W1
and §"W1 ledger signature". Where this file and that section differ, the
deviations are listed at the bottom, with why.

---

## The table

`public.events` — one row per recorded act. **No foreign keys at all**: every
reference is a bare uuid beside a snapshot of the name it had at the time,
because a record a `DELETE` can reach is not a record.

| column | meaning |
| --- | --- |
| `id` | uuid |
| `ts` | when (server clock, `clock_timestamp()`) |
| `chain_key` | the hash chain this row is in: the matterspace id, or the nil uuid `00000000-…` for acts that belong to no matter |
| `seq` | 1, 2, 3 … per `chain_key`, gapless, assigned under `pg_advisory_xact_lock` |
| `kind` | the event vocabulary below (CHECK-constrained) |
| `matterspace_id` | the matter, or null. **Not** a foreign key |
| `matter_name` | the matter's name at write time |
| `serverspace_id` | the serverspace at write time — this is what RLS falls back to once the matter is gone |
| `session_id` | `ai_sessions.id` where there is one. Not a foreign key |
| `actor_kind` | `user` \| `charter` \| `connector` \| `system` |
| `actor_ref` | the user id / `agent_charters.id` / OAuth `client_id` / `'worker'` |
| `actor_user_id` | **`auth.uid()` at write time — stamped by the database, never by the caller** |
| `actor_label` | the charter's or connector's display name at write time |
| `payload` | jsonb, metadata only, capped at 8 KB |
| `prev_hash` | the previous row's `hash` in this chain; `''` for `seq = 1` |
| `hash` | sha256 over the canonical form (below) |

Unique on `(chain_key, seq)`.

### The hash

```
hash = sha256( jsonb_build_array(
         prev_hash, seq, epoch_microseconds(ts), kind,
         matterspace_id, matter_name, actor_kind, actor_ref,
         actor_user_id, session_id, payload
       )::text )                                    -- hex
```

A JSON array rather than a `||` join, so a value containing the separator
cannot forge another row's canonical form; epoch **microseconds** rather than
`ts::text`, so the chain verifies identically whatever `TimeZone` the session
is in. One function — `public._ledger_hash(...)` — is used both to write and
to verify, so the two cannot drift.

`public.verify_chain(p_chain_key uuid) → (ok boolean, checked bigint,
first_bad_seq bigint)` recomputes a chain as the caller (RLS applies: a
stranger checks 0 rows rather than being told a falsehood).

---

## The vocabulary

`kind` is CHECK-constrained to this list. `lib/ledger.mjs` exports the same
list as `EVENT_KINDS`. All fourteen are legal today so that W2, W3 and W6 do
not each have to reopen the migration; only the first eight are written by
W1.

| kind | written by | payload |
| --- | --- | --- |
| `tool.invoked` | `lib/mcp-core.mjs` `callTool` | `{tool, args (redacted), document_ids[], connector, connector_client_id, charter_id, ok, refused: 'sealed'\|null, ms, error?}` |
| `completion.received` | `lib/assistant-core.mjs` `recordAssistant` | `{tier, provider, model, input_tokens, output_tokens, estimated_cost, within_policy, escalation, tools_used[], rounds, answer_chars, error?}` |
| `acl.changed` | trigger on `matterspace_members` / `serverspace_members` | `{table, op: insert\|update\|delete, target_user_id, old_role, new_role, serverspace_id?}` |
| `seal.changed` | trigger on `matterspaces.ai_tier` | `{old_tier, new_tier}` |
| `file.exported` | W1 lane leaves this to the export builder | `{document_id, title, destination: download\|drive\|gmail_draft, sha256?}` |
| `file.sent` | ditto | `{document_ids[], channel, to[], subject}` |
| `file.delivered` | ditto | `{production_id, delivery_id, recipient, package_sha256, bates_range}` |
| `file.gate` | W6 | `{document_id, gate, allowed, reason}` |
| `citation.verified` | W6 | `{document_id, run_id, cites, verified_by}` |
| `connector.registered` | W2 | `{client_id, client_name}` |
| `connector.revoked` | W2 | `{client_id, client_name, by}` |
| `ai.paused` / `ai.resumed` | W3 | `{reason?}` |
| `run.aborted` | W3 | `{session_id, by, round}` |

### What a payload may never contain

Document text. A prompt. A model's answer. A passage. Slide or deck copy.
`redact()` in `lib/ledger.mjs` enforces it mechanically before anything
leaves the process:

* a **content-bearing key** (`text`, `content`, `body`, `markdown`, `slides`,
  `headline`, `next_action`, `description`, `data`, … ) is replaced by
  `{chars: n}` or `{items: n}`;
* a **secret-bearing key** (matching `key|token|secret|password|
  authorization|credential|cookie|signature`) becomes `'[redacted]'`;
* **any string over 256 characters, under any key at all**, is replaced by
  `{chars: n}` — the default is refusal, so a new tool with a new argument
  name cannot leak prose by being unanticipated;
* `query` is kept (it is the single most useful line in a tool record) but
  hard-truncated to 200 characters.

Migration 064 then caps the whole payload at 8 KB, replacing anything larger
with `{truncated: true, original_bytes, keys[]}`.

---

## Who may write

```
ledger_append(p_kind, p_matter, p_serverspace, p_session,
              p_actor_kind, p_actor_ref, p_actor_label, p_payload)
```

is the only door, and it is the one thing `authenticated` may execute.
Three layers, one job each:

1. **`ledger_append`** — SECURITY **INVOKER**. Captures `auth.uid()` into a
   declared variable and asks the caller's own RLS whether the matter is
   visible. (The house rule from
   `feedback_rls_security_invoker_wrappers.md`.)
2. **`_ledger_append_checked`** — SECURITY DEFINER. Reads `auth.uid()`
   *itself* — never as a parameter, because a uid parameter on a function any
   signed-in user may call is a forged byline — and re-checks membership
   without RLS.
3. **`_ledger_write`** — SECURITY DEFINER, `EXECUTE` revoked from every role.
   Takes the lock, computes `seq` + `prev_hash` + `hash`, inserts. Only the
   DEFINER functions and the triggers above it — all owned by `postgres` —
   can reach it.

`actor.ref` is advisory. `actor_user_id` is `auth.uid()`, stamped inside the
database; a client cannot forge who it was.

### Who may read

RLS `SELECT` via `public._ledger_visible(matterspace_id, serverspace_id,
actor_user_id)`, an INVOKER wrapper. Three ways in, in order: it is your own
act; the matter exists and you can see it (022's `_mtspc_select_check`, which
already inherits serverspace membership and ancestor matters, so a parent
matter's Record covers its sub-matters); or the matter is gone and you are in
the serverspace it was in.

### Who may change or remove it

Nobody. `UPDATE`, `DELETE` and `TRUNCATE` are refused by triggers, which stop
a superuser as well as a role — and `INSERT` is refused unless it comes from
`_ledger_write`, so a future `grant all on all tables in schema public to
service_role` cannot quietly reopen the table. Repairing the table requires a
migration that first disables the triggers by name: a deliberate, visible act.
`scripts/_verify-ledger.mjs` proves each of these as the matter owner, as
`service_role` (which has `BYPASSRLS`), and as a superuser.

---

## From JavaScript

```js
import { record, recordStrict, verifyChain, EVENT_KINDS } from './lib/ledger.mjs';

await record(supabase, {
  kind: 'file.exported',
  matterId,
  sessionId,                                     // optional
  actor: { kind: 'user', ref: userId },          // or 'charter' / 'connector'
  payload: { document_id, title, destination: 'drive' },
});
// → {ok:true, id, seq, hash}
//   {ok:false, error}                  a real failure — warned, never thrown
//   {ok:false, notDeployed:true, …}    migration 064 is not in this database
```

`record()` takes the **user-scoped** client, never the service role.
`recordStrict()` is the same call but throws `LedgerWriteError` on a real
failure — and, deliberately, **not** when the ledger is merely not deployed.

## Merge order, and why merging early is safe

1. Merge the PR.
2. Paste `supabase/migrations/064_events_ledger.sql` into the SQL editor.
3. Run `notify pgrst, 'reload schema';`.

Between (1) and (2) the product behaves exactly as it does today. PostgREST
answers `PGRST202` for a function that is not in its schema cache;
`lib/ledger.mjs` classifies that (with `PGRST203`, `PGRST205`, `42883`,
`42P01`, `3F000`) as **not deployed**, warns once per process, and returns
`{ok:false, notDeployed:true}`. Nothing treats it as a write failure —
including the sealed strict mode below, which must not start refusing answers
merely because a table does not exist yet.

## Sealed strict mode

On a **sealed** matter (Tier B/C) the record is not paperwork about the work;
it is part of what the seal promises. So on a sealed matter the answer is
**held** until it has been written down:

* text deltas are buffered rather than streamed (status events —
  `session`, `tool`, `action` — still go out live);
* if the `ai_sessions` row cannot even be opened, the turn is refused
  *before any provider is contacted*;
* if the `ai_messages` row or the `events` row cannot be written, the
  buffered answer is discarded and the turn ends in
  `{type:'error', code:'exchange_unrecorded'}` with the plain-language
  refusal in `exchangeUnrecordedMessage()`;
* on an **unsealed** matter none of this applies: the answer streams as
  before and a failure is a `console.warn`.

## Deviations from the roadmap's §"W1 ledger signature"

| roadmap | here | why |
| --- | --- | --- |
| column `type`, functions `record_event` / `events_record` | column `kind`, function `ledger_append` | Eden's W1 brief of 2026-09-20. One vocabulary across SQL, JS and the Record tab. |
| `hash = sha256(prev_hash‖ts::text‖…)` | JSON array, epoch microseconds | `timestamptz::text` renders in the session's `TimeZone`, so the roadmap's chain would verify in New York and fail in London; and a `||` join over free text is forgeable. |
| `matterspace_id` + `matter_name` | plus `serverspace_id` | Without it the row survives matter deletion but becomes unreadable — there is nothing left for RLS to check membership against. Same column added to `ai_sessions`. |
| — | `_events_insert_guard` | The roadmap relies on "no INSERT policy". That stops a signed-in user, not `service_role`, which has `BYPASSRLS`. |
| `ai_sessions`: drop owner DELETE, cascades → SET NULL | plus its SELECT policy moved to `_ledger_visible` | Otherwise "the record survives the matter" is true of the bytes and false of the reading. |
