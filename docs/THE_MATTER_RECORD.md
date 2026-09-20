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
list as `EVENT_KINDS`. 064 made fourteen legal at once so that W2, W3 and W6
would not each have to reopen the migration; 072 added `connector.connected`
and 073 added `completion.requested`, bringing it to sixteen. W1 itself writes
only the first eight.

| kind | written by | payload |
| --- | --- | --- |
| `tool.invoked` | `lib/mcp-core.mjs` `callTool` | `{tool, args (allow-listed — see below), document_ids[], connector, connector_client_id, charter_id, ok, refused: 'sealed'\|null, ms, error?}` |
| `completion.requested` | `lib/llm-record.mjs` `recordLlmRequested`, from `api/llm.mjs` — **migration 073** | `{feature, call_id, tier, provider, model, client_provider?, client_model?, route, streaming, max_output_tokens?, byok, document_ids?, refused, status?}` |
| `completion.received` | `lib/assistant-core.mjs` `recordAssistant`, and `lib/llm-record.mjs` `recordLlmReceived` | `{tier, provider, model, input_tokens, output_tokens, estimated_cost, within_policy, escalation, tools_used[], rounds, answer_chars, error?}` — and, for a feature call, `{feature, call_id, route, streaming, outcome, ok, status, ms}` in place of the chat-only keys |
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

### What is *not* recorded

~~A tool call that resolves to **no** matter leaves no row.~~ **Closed by
migration 072** — see "The account chain" below. A cross-matter `search`
now writes one row on the caller's own account chain *and* one row in each
matter it actually read from.

Still not recorded: work done outside Contextspaces, and anything a
connector did before it connected. Absence of a row is not evidence that
nothing happened; it is evidence that nothing happened *here*.

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

> **Note for W1, found while building 072.** The `search` tool's argument is
> `q`, not `query`, so the special case above never fires for it: on an
> ordinary matter-scoped search `args.q` is stored **verbatim** up to the
> general 256-character limit rather than truncated to 200. That is inside
> the matter the searcher was working in, so it is not a leak, and 072 does
> not change it — but it is the reason 072's cross-matter rows use
> `shapeOnly()` rather than `redact()`.

Migration 064 then caps the whole payload at 8 KB, replacing anything larger
with `{truncated: true, original_bytes, keys[]}`.

### Tool arguments — an allow-list, not a deny-list

The bullets above describe `redact()`, the floor under **every** payload this
module writes. For `tool.invoked` there is a second, stricter pass that runs
**first**, because that is the one payload which embeds a tool's *raw*
arguments — keys chosen by whoever writes the next tool, not by `ledger.mjs`.

A deny-list is the wrong shape for that. It was also wrong in fact: `search`'s
query argument is named **`q`**, and `redact()`'s special case is spelled
`query`, so a search string went into the Record **verbatim** up to 256
characters — in a row that neither its author, nor `service_role`, nor a
superuser can ever delete. A lawyer's search string is the question counsel
was asking; it can be privileged even when the passages it finds are not.

So `redactToolArgs()` inverts the rule. A value survives only if it is safe
**by construction**, and the *value* is checked, not just the key name:

| kept | keys | only when |
| --- | --- | --- |
| container ids | `matter`, `to_matter`, `parent`, `serverspace`, `short_code` | the value is a uuid, or a handle matching `^[A-Za-z][A-Za-z0-9_-]{0,63}$` |
| document / passage ids | `document_id`, `doc`, `id` | the value is a uuid |
| id lists | `document_ids` | **every** element is a uuid (otherwise the list becomes `{items: n}`) |
| enums | `encoding`, `doc_type`, `status`, `type` | the value is one the tool's own schema lists |
| numbers, booleans | any key | always — neither can carry prose |
| secrets | any key matching the secret pattern | never: `'[redacted]'` |
| **everything else** | any other string, under any key, known or not yet invented | never: `{present: true, length: n}`. Arrays become `{items: n}` |

The default is refusal, which is what makes a tool added next year safe
without anyone remembering to come back here.

Argument by argument, across the twenty tools (◆ kept, ▫ shape only):

| tool | kept | shape only |
| --- | --- | --- |
| `list_matters` | — | — (no arguments) |
| `list_matter_contents` | ◆ `matter` | — |
| `search` | ◆ `matter`, `document_ids`, `limit`, `full_text` | ▫ `q`, `doc_types`, `witnesses` |
| `get_passage` | ◆ `id`, `context_pages` | — |
| `get_outline` | ◆ `doc`, `depth` | — |
| `grep` | ◆ `matter`, `doc`, `regex`, `case_sensitive`, `max_matches`, `context_chars` | ▫ `pattern` |
| `file_document` | ◆ `matter`, `encoding`, `doc_type` | ▫ `filename`, `content`, `title` |
| `ingest_document` | ◆ `document_id`, `force` | — |
| `check_ingest_status` | ◆ `matter`, `document_id` | — |
| `get_media` | ◆ `document_id`, `expires_in` | — |
| `get_matter_state` | ◆ `matter` | — |
| `set_matter_state` | ◆ `matter`, `status` | ▫ `headline`, `next_action`, `next_action_owner`, `waiting_on`, `note` |
| `create_matter` | ◆ `serverspace`, `parent`, `short_code` | ▫ `name`, `description` |
| `move_document` | ◆ `document_ids`, `to_matter` | — |
| `copy_document` | ◆ `document_ids`, `to_matter` | — |
| `send_to_sandbox` | ◆ `document_ids` | — |
| `assemble_documents` | ◆ `matter`, `document_ids`, `doc_type` | ▫ `filename`, `title` |
| `edit_pdf` | ◆ `document_id` | ▫ `pages`, `rotate`, `inserts`, `filename`, `title` |
| `create_deck` | ◆ `matter` | ▫ `title`, `subtitle`, `filename`, `accent`, `slides` |
| `create_chart` | ◆ `matter`, `type` | ▫ `title`, `categories`, `series`, `y_label`, `x_label`, `filename` |

A filename and a matter's display name are shape-only deliberately: both are
routinely the client's name and the dispute, and the row already snapshots
`matter_name` beside it. `pages`, `rotate` and `inserts` are shapes because
they are not on the list, which is the point of a list.

### The error beside the arguments

Shaping the arguments is not sufficient on its own. Several handlers quote an
argument back in the message they throw — `resolveMatter` raises *"No
matterspace with short_code '…'"* — and `payload.error` carries that message.
`scrubArgValues()` therefore removes every argument value of four characters
or more from the error before it is recorded. `_verify-ledger.mjs` proves both
halves: with the scrub removed, nine of the twenty tools put an argument back
into the payload by that route.

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

~~051's `"Owners update their sessions"` policy is deliberately left alone.~~
**Closed by migration 072** — see "The AI session record" below.

---

# Migration 072 — the account chain, and the session record

072 closes the two holes 064 declared in its own PR. It applies **on top of
064**; against a database that has never seen 064 it does nothing at all and
says so in a notice, because the whole file lives inside one guarded `DO`
block (a `return` in a plpgsql block exits only that block, so a guard over
top-level statements would stop nothing).

## The account chain

### Why the same table

Same table, `public.events`, with a new kind of `chain_key`. Not a sibling
table. Two lines of 064 decide it:

* **RLS.** `_ledger_visible(matter, serverspace, actor_user)` answers TRUE on
  its first rule when `actor_user = auth.uid()`, and when **both**
  `matterspace_id` and `serverspace_id` are null there is no second or third
  rule to reach. A row with `(matter null, serverspace null, actor_user = me)`
  is therefore readable by me and by nobody else — not by a colleague in my
  own serverspace, not by a matter's members. **072 changes no policy.**
* **`verify_chain`.** It is INVOKER and keyed on `chain_key` alone. A chain
  whose every row is visible to exactly one person verifies whole for that
  person and reports `checked = 0` for everyone else — which is precisely the
  account-chain contract, with no second verifier to drift.

A sibling table would have needed its own policy set, its own grants, its own
append-only triggers and its own verifier. The chain key of an account chain
is the account's **own user id**, taken from `auth.uid()` inside a DEFINER
function — never a parameter, so it cannot be aimed at anybody else's chain.

### What a cross-matter call records

One connector `search` with `matter` omitted now writes **1 + N** rows.

**One account row**, on the caller's own chain, `kind = 'tool.invoked'`:

```jsonc
{ "scope": "account", "tool": "search",
  "args": { "q": {"chars": 60}, "limit": 5, "doc_types": {"items": 1} },
  "matter_filter": false,
  "connector": true, "connector_client_id": "…", "grant_id": "…",
  "matters_touched": 2, "matters_recorded": 2, "matters_overflow": 0,
  "fanout_ceiling": 100, "result_count": 3, "ok": true, "ms": 812 }
```

**One row in each matter the call actually read from**, on that matter's own
chain, `kind = 'tool.invoked'`:

```jsonc
{ "scope": "matter", "via": "account-wide search", "tool": "search",
  "args": { "q": {"chars": 60}, … }, "matter_filter": false,
  "connector": true, "connector_client_id": "…",
  "result_count": 2, "ok": true, "ms": 812 }
```

`list_matters` (and any other call that resolves to no matter) writes the
account row only. It enumerates matters; it does not read from them, and a
row in every matter on every connector handshake would be noise in the one
place that has to stay readable.

### The isolation argument

A fan-out row names only the matter it sits in — its `result_count` is that
matter's own, and no other matter's id, name or count appears anywhere in
it — so opening M1's Record, or exporting it for a court, cannot tell anyone
that M3 exists. The account row lives on a chain only its owner can read and
carries **counts rather than ids**, so the roll-up cannot become a back door
into a list of matter names either.

The **query text is dropped from both**. `redact()` keeps `query` because on
a matter-scoped call it is the most useful line in the record; a cross-matter
query is different in kind — "Peloso arbitration award", typed once, would
otherwise be copied verbatim into every matter it happened to hit, putting
one client's words into another client's record. `shapeOnly()` is used
instead, for the account row **and** every fan-out row. This is not
theoretical: the search tool's argument is `q`, not `query`, so `redact()`
would have stored it verbatim.

**Sealed matters** never appear on either side. `enforceConnectorSeal`
removes them from the search scope before the query runs, so they cannot be
in the result; `recordCrossMatter` filters `excludeMatterIds` as a second
line. They are neither recorded as touched nor counted as touched.

### The ceiling

`FANOUT_CEILING = 100` distinct matters per call. A search touching 60
matters writes 60 rows. Past 100, the first 100 (highest-ranked first) get
rows and the account row states all three numbers — `matters_touched`,
`matters_recorded`, `matters_overflow` — so a reader knows the per-matter
record is partial and by exactly how much. **Nothing is ever dropped
silently.**

### The functions

```
ledger_append_account(p_kind, p_session, p_actor_kind,        INVOKER, granted
                      p_actor_ref, p_actor_label, p_payload)
  └─ _ledger_append_account_checked(…)                        DEFINER, granted
       reads auth.uid() ITSELF — byline and chain key both
       └─ _ledger_write_scoped(…, p_chain)                    DEFINER, revoked from all
```

`_ledger_write_scoped` is 064's writer body with the chain key made explicit;
`_ledger_write` keeps its exact 064 signature and becomes a one-line delegate
to it, so there is one implementation of lock → seq → prev_hash → hash →
insert and the two kinds of chain cannot drift. It is a **new name** rather
than a tenth parameter because `create or replace` with a different argument
list makes an *overload*, and an ambiguous nine-argument call inside 064's
`acl.changed` trigger would block every membership change in the product.

Account-legal kinds: `tool.invoked`, `connector.registered`,
`connector.connected`, `connector.revoked`, `ai.paused`, `ai.resumed`.
`completion.received`, `acl.changed` and `seal.changed` are matter-bound by
definition and are refused on an account chain, by the database and by
`lib/ledger.mjs` both. **`connector.connected` is new in 072's CHECK
constraint and is defined for PR #166 to write, not wired here.**

The chain key invariant is also a **trigger**
(`events_chain_key_invariant`), because a future writer can route around a
function but not around a trigger. Three shapes are legal and no fourth is:
a matter row (`chain_key = matterspace_id`); an account row
(`matterspace_id` and `serverspace_id` null, `chain_key = actor_user_id`);
064's nil chain for serverspace-wide acts.

### From JavaScript

```js
import { recordAccount, recordCrossMatter, verifyAccountChain,
         shapeOnly, FANOUT_VIA, FANOUT_CEILING } from './lib/ledger.mjs';

// One call, from mcp-core's recording point. Does nothing for an ordinary
// in-matter call; never throws.
await recordCrossMatter(supabase, {
  tool, args, result, actor, sessionId,
  primaryMatterId,          // null ⇒ an account row is written too
  connector, excludeMatterIds, ok, refused, ms, error,
});

// For PR #166, when it wants connector.connected / connector.revoked:
await recordAccount(supabase, { kind: 'connector.connected', actor,
                                payload: { client_id, client_name, grant_id } });
```

Fan-out is keyed off the **result**, never off the argument, so the in-app
assistant sitting in M1 and calling `search` with `matter` omitted also gives
M3 its row. (Its own M1 row is #170's; no account row is written, because the
call does belong to a matter.)

**Between the two pastes** — 064 in, 072 not yet — `ledger_append_account`
answers `PGRST202`, which `recordAccount` classifies as **not deployed** with
its own once-per-process warning naming 072. The fan-out rows still write:
they are ordinary 064 matter rows. Every matter's own Record therefore stays
true; only the account-level roll-up is missing until the second paste.

## The AI session record

051 gave the owner a blanket `UPDATE` policy on `ai_sessions`. Everything on
that row except its title is provenance: which matter, whose account, which
**tier** governed the session (stamped at creation precisely so a later
re-tiering cannot rewrite history), and 064's `matter_name` / `owner_email` /
`serverspace_id` snapshots. A record whose subject can edit it is not a
record.

Every write of these two tables in the repo was read before narrowing:

| site | what |
| --- | --- |
| `lib/assistant-core.mjs:833` | `update({updated_at})` on `ai_sessions` |
| `lib/assistant-core.mjs:839` | `insert into ai_sessions` |
| `lib/assistant-core.mjs:879` | `insert into ai_messages` |
| `src/` | **no writes at all** (`Assistant.tsx` only holds the id) |

So exactly one column is updated by the product. **Left updatable:
`updated_at` and `title`** — `updated_at` because the product moves it,
`title` because the insert already sets one and a rename is a label the owner
chose, not a record of what an AI did. Both move only through
`ai_session_touch(p_session, p_title)` (INVOKER wrapper → DEFINER worker that
re-checks ownership from `auth.uid()`). **Immutable after insert:** `id`,
`matterspace_id`, `owner_id`, `tier`, `status`, `created_at`, `matter_name`,
`owner_email`, `serverspace_id`. If the product ever needs to close a
session, widen the function by one line — never the policy.

`ai_messages` — role, content, model, provider, tokens, cost,
`within_policy` — is **wholly immutable**. Nothing in the product updates a
message, so nothing needs a door: the trigger refuses every `UPDATE`.

Two layers, as 062 did for `profiles.pricing_tier`: the dropped policy and
the revoked grants stop a signed-in user; a `BEFORE UPDATE` trigger stops
`service_role` (which has `BYPASSRLS`) and a superuser (which a grant cannot
stop either). The trigger refuses unless a transaction-local flag is up, and
only `_ai_session_touch_checked` raises that flag, for the length of its own
`UPDATE` — 064's own idiom for `public.events`, one table over. Even with
the flag up, the trigger re-checks that only `title` and `updated_at`
differ.

`lib/assistant-core.mjs:833` now calls `supabase.rpc('ai_session_touch', …)`
instead of `.update({updated_at})`, still fire-and-forget. Before 072 is
pasted the RPC is simply absent and the call is swallowed, exactly as the
`UPDATE`'s own failure was.

---

# The read contract for the Record tab and the export (PR #175)

#175 needs **no new query shape** and no new migration. Two additions.

**1. An "Account-wide activity" section in the Matter Record export.** For
the export's date range, state how many account-wide connector calls touched
**this** matter — read from this matter's own fan-out rows, and saying
nothing about any other matter:

```ts
// per matter (or across matterspace_descendants, as the Record tab already does)
const { count } = await supabase
  .from('events')
  .select('id', { count: 'exact', head: true })
  .in('matterspace_id', matterIds)
  .eq('kind', 'tool.invoked')
  .eq('payload->>scope', 'matter')
  .eq('payload->>via', 'account-wide search')
  .gte('ts', from).lte('ts', to);
```

`payload.result_count` on each of those rows is how many passages that call
returned **from this matter**. Suggested sentence, which is true and claims
nothing more:

> Account-wide activity — 4 searches run by a connected assistant across
> every matter this account can see returned passages from this matter during
> the period. Each is listed above. What those searches returned from other
> matters is not part of this matter's Record.

`scope`, `via` (`'account-wide search'`, exported as `FANOUT_VIA`) and
`result_count` are now an **interface**, not a payload convention. A partial
index `events_fanout_idx` exists for exactly this count.

**2. The docket line for a fan-out row.** It is an ordinary `tool.invoked`
row, so #175 already renders it; the only thing worth adding is that
`payload.via` is present:

```ts
// one line, in the tool.invoked case of the docket's phrasing function
if (e.payload?.via === 'account-wide search')
  return `${who} searched across every matter and read from this one`;
```

**What #175 must NOT do:** never read another matter's chain to fill in a
matter's Record, and never surface the account chain inside a *matter*
export. The account chain is the person's own view of their own connectors;
a Matter Record that quoted it would be quoting counts drawn from matters the
reader may have no right to know exist. If an account-level surface is wanted
later, it is its own screen, reading `verify_account_chain()` and
`events where chain_key = account_chain_key()`.

---

# Migration 073 — a feature's own model calls

## The hole

064 records the in-app Assistant's completions and `mcp-core`'s tool calls.
It records nothing about **`/api/llm`** — the browser passthrough behind
Bucketizer (tree, classify, evidence), Cite-Check (extract, check), the
Editor's four passes, DeckComposer, the AI Workbench and Moot Bench. That
endpoint was gated (`lib/ai-tier-policy.mjs`), sealed (`lib/llm-sealed-route.mjs`,
#163) and metered (`lib/usage-meter.mjs`, #161/#178), and wrote nothing here.
On 2026-09-19 a real sealed Bucketizer classification ran in production —
21,578 in, 6,342 out, served by the sealed pen — and the matter's Record did
not know it had happened. For a product whose pitch is that a lawyer can show
a court how AI was used on a matter, that is a hole.

## Two rows, not one

`/api/llm` **streams**. The Assistant honours "no record, no answer" by
buffering a sealed answer and discarding it if the write fails; this route
cannot, because once the first byte has left the function there is nothing to
discard. The ledger is append-only, so the answer is to write twice:

| when | kind | strict? |
| --- | --- | --- |
| **before any provider is contacted** | `completion.requested` | on a **sealed** matter, yes — a real failure refuses the call with `exchange_unrecorded` and ZERO provider requests, and the meter's pre-charge is settled back to nothing. On an unsealed matter, never. |
| after the answer has been delivered | `completion.received` | never, on either route: the undeletable row already exists and the answer has already gone out. |

Both carry the same **`call_id`**, which is a read contract: the export pairs
them so one call is one line. Three shapes are legal and each is reported as
what it is — `requested` + `received` (an ordinary call); `received` alone
(also an ordinary call — what every call looks like until 073 is pasted);
`requested` alone (a **refusal** if `refused` is set and nothing was sent,
otherwise a call that never came back, which the export counts and names).

### Why a new kind rather than a phase on `completion.received`

`completion.received` means *a model answered*. The first row is written when
nothing has answered yet and may never. Reusing the kind would make every
existing reader wrong by default — the Record tab labels that kind "AI
answer", and the export's session index counts one exchange per row — so both
would have to learn a payload key before they could tell a pending call from
an answer. A kind is the honest place to say what a row **is**.

### Merging before pasting 073 is safe, and the code half makes it so

Until the CHECK constraint is widened, Postgres refuses `completion.requested`
with SQLSTATE **23514** naming `events_kind_check`. That is not
`isNotDeployed`'s family, and on a sealed matter a real write failure withholds
the answer — so without a second classification, merging would take sealed
Bucketizer, Cite-Check and the Editor offline. `lib/ledger.mjs`
`isKindNotAdmitted(error, kind)` therefore treats it as **not deployed**, with
its own once-per-process warning naming the file to paste. It is narrow on all
three axes: the code is `23514`, the message names `events_kind_check`, **and**
the kind is one 064's own list never had. A check violation on any other
constraint, or on a kind legal since 064, stays a real failure.
`scripts/_verify-ledger.mjs` asserts each axis, and that the same insert lands
once 073 has run.

## The feature label

The caller sends `feature` in the **request envelope** beside `provider`,
`model` and `matterId` — never inside `body`, which is forwarded to the
provider verbatim. So Tier A request bytes are byte-for-byte what they were
before this change; `scripts/_verify-llm-record.mjs` asserts that against
`origin/main`'s own handler.

The server does not trust it. `LLM_FEATURES` in `lib/llm-record.mjs` is the
allow-list; anything else becomes `'unspecified'`, and a bad label is never a
reason to refuse a call. `src/lib/llm/features.ts` holds the same list as a TS
union so a typo at a call site is a build error, and the harness asserts the
two arrays are identical.

```
bucketizer.tree   bucketizer.classify   bucketizer.evidence
citecheck.extract citecheck.check
editor.light      editor.plan           editor.section       editor.critic
deck              workbench             moot.generate        moot.converse
unspecified                                     (never claimable by a caller)
```

Two other client-supplied values are shaped server-side, because `redact()`
keeps any string under 256 characters: `model` / `client_model` must match a
model-id pattern or are reduced to `{present, length}`, and `document_ids`
survive only when **every** element is a uuid (`uuidList()` in
`lib/ledger.mjs`), otherwise `{items: n}`. A provider's own error body never
enters a payload even truncated — a 4xx routinely echoes the request back — so
what is recorded is `outcome` plus the HTTP `status`.

## What is NOT on the account chain

A `/api/llm` call with **no matter** — Student Hub, the Editor's desk on
pasted text, a dashboard draft — is recorded nowhere, and 073 does not change
that. It is not a contained addition: 072's `ACCOUNT_EVENT_KINDS` and
`_ledger_append_account_checked` both refuse `completion.received` on an
account chain *by design* ("matter-bound by definition"), so putting feature
calls there would need a second migration widening that set — and it would put
a person's Student Hub usage on their own permanent chain. It is a decision
worth taking deliberately, not as a rider.

## The read side

`describe.ts` gains `featureOwner()` / `featurePhrase()` and a docket line per
entry ("Bucketizer asked a model to classify a document — …" / "Bucketizer
classified a document — …"). `assemble.ts` gains `featureCalls`: the paired
rows, grouped by feature × model × provider × tier, with calls, refusals,
unfinished calls, tokens, cost and first/last use. It renders inside **section
2, "Feature AI calls"**, so no section is renumbered. The tools memo takes its
feature blocks from those paired rows rather than from raw entries — counting
entries would double every feature's use count — and the session index skips
them, because a feature call belongs to no chat session.
