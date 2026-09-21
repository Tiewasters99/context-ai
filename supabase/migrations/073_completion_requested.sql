-- 073_completion_requested.sql
--
-- One kind, added to the Record's vocabulary: `completion.requested`.
--
-- WHY
-- ---------------------------------------------------------------------------
-- 064 records an AI answer AFTER it comes back (`completion.received`, written
-- by lib/assistant-core.mjs). That is enough for the in-app Assistant, which
-- buffers a sealed answer and can therefore refuse to deliver one it could not
-- write down. It is not enough for /api/llm — the browser passthrough behind
-- Bucketizer, Cite-Check, the Editor, DeckComposer, the AI Workbench and Moot
-- Bench — because that route STREAMS. Once the first byte has left the
-- function there is no un-sending it, so "the answer is withheld until the
-- record exists" cannot be honoured by a row written afterwards.
--
-- So a /api/llm call bound to a matter writes TWO rows: one BEFORE any
-- provider is contacted, and one after. On a sealed matter the first write is
-- strict — if it fails, the request is refused and no provider is called at
-- all (audits/2026-09-19/02-securespace.md, DoD 6: "a sealed exchange either
-- writes an undeletable record row or the answer is withheld"). The second row
-- carries tokens, cost and outcome and is always best-effort: by then the
-- undeletable row already exists.
--
-- WHY NOT A PAYLOAD PHASE ON completion.received
-- ---------------------------------------------------------------------------
-- Because `completion.received` means "a model answered", and the first row is
-- written when nothing has answered yet and may never. Reusing the kind would
-- make every existing reader wrong by default: the Record tab labels that kind
-- "AI answer", and the export's session index counts one exchange per row.
-- Both would have to learn a payload key before they could tell a pending call
-- from an answer — which is a payload convention masquerading as a contract.
-- A kind is the honest place to say what a row IS.
--
-- Apply order: AFTER 064 (and it is indifferent to whether 072 has run — the
-- list below is the UNION of 064's fourteen, 072's connector.connected and
-- this one, so applying it to a 064-only database ADDS connector.connected
-- rather than dropping anything, and applying it after 072 changes nothing but
-- the one new kind). Against a database that has never seen 064 it does
-- NOTHING and says so: the whole file is one guarded DO block, because a
-- `return` in a plpgsql block exits only that block and a guard above
-- top-level statements would stop nothing.
--
-- Re-runnable: drop-then-add of one named constraint, and nothing else.
--
-- ⚠ After pasting this file, run:  notify pgrst, 'reload schema';
--   (it is the last statement here, but a paste that stops early will not have
--   run it.)
--
-- MERGING BEFORE PASTING IS SAFE, and the code half makes it so. Until this
-- constraint is widened, an insert of `completion.requested` is refused by
-- Postgres with SQLSTATE 23514 naming `events_kind_check`. lib/ledger.mjs
-- classifies exactly that — 23514, that constraint name, and a kind outside
-- 064's own list — as NOT DEPLOYED, in the same family as PGRST202, with its
-- own once-per-process warning naming this file. So between merge and paste:
--
--   * a sealed matter keeps answering (it does NOT start refusing merely
--     because a CHECK constraint predates the code);
--   * the `completion.received` row still writes, because that kind has been
--     legal since 064 — every feature call is therefore still recorded, just
--     without its paired "requested" row;
--   * the export renders a lone `received` row as a complete call, which it is.
--
-- Nothing else in 064 or 072 is touched: no function, no policy, no trigger,
-- no grant, no index.

do $migration$
begin

if to_regclass('public.events') is null then
  raise notice '073: public.events is absent — migration 064 has not been applied.';
  raise notice '073: nothing was changed. Paste 064_events_ledger.sql first, then paste this file again.';
  return;
end if;

raise notice '073: 064 is present — widening events_kind_check by completion.requested.';

-- The UNION of every kind that is legal today. Never a subset: dropping and
-- re-adding a CHECK constraint with a shorter list would make existing rows
-- unvalidatable and future writes of a kind another migration added fail.
execute $sql$
  alter table public.events drop constraint if exists events_kind_check
$sql$;
execute $sql$
  alter table public.events add constraint events_kind_check check (kind in (
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
    'run.aborted'
  ))
$sql$;

-- `completion.requested` is MATTER-BOUND, exactly as `completion.received` is.
-- 072's events_chain_key_invariant trigger and _ledger_append_account_checked
-- already refuse any kind that is not in the account-legal set, and this kind
-- is deliberately not added to it: a model call that belongs to no matter
-- (Student Hub, the Editor's desk on pasted text) is out of the matter
-- Record's scope, and putting it on a person's own account chain is a
-- separate decision with its own migration. Nothing here widens that set.

perform pg_notify('pgrst', 'reload schema');
raise notice '073: applied.';

end $migration$;

notify pgrst, 'reload schema';
