-- Contextspaces Migration 068: passage-level evidence under a bucket.
--
-- WHY A TABLE, AND NOT JSON ON THE ROW THAT ALREADY EXISTS
-- ---------------------------------------------------------------------------
-- The obvious cheaper move is to hang the evidence off
-- bucketizer_classifications, which is already unique on exactly the
-- (document_id, node_id) pair this feature works over. It does not survive
-- contact with what the evidence has to do:
--
--   * That row has NO json column. There is nothing to put an array in, so
--     "keep it in the existing row's JSON" is itself a migration — the choice
--     is between adding a jsonb column and adding a table, not between a
--     migration and none.
--   * Each evidence item carries its own ATTORNEY DECISION (proposed →
--     confirmed / rejected, by whom, when) and its own ORDER within the issue.
--     Confirming one quotation out of six, in a json array, is a
--     read-modify-write of the whole array: two tabs, or an attorney and a
--     running pass, and one of the decisions is silently lost. The same race
--     is already acknowledged and tolerated on documents.metadata.bucketizer
--     (PR #168) because nothing there is a decision. A decision recorded
--     against a quotation that will be read to a witness is not something to
--     tolerate losing.
--   * The outline has to answer "every confirmed quotation in this matter,
--     in the attorney's order, with its passage" in one query, and the gaps
--     section has to count confirmed items per node. Over a jsonb array that
--     is a lateral unnest on every read with no index behind it; over rows it
--     is an indexed scan.
--   * `passage_id` wants a real foreign key. It is the whole point of the
--     feature (below).
--
-- What DOES belong on the existing row is the pair-level RUN STATE — whether
-- this (document, node) pairing has been read for evidence at all, by which
-- model, and with what refusal if it could not be used. That is one fact per
-- pair, the pair already has a row, and it is what makes the pass resumable
-- without paying twice. So: three columns there, one table here.
--
-- THE CASCADE ON passage_id IS A FIDELITY FEATURE, NOT HOUSEKEEPING
-- ---------------------------------------------------------------------------
-- Re-ingesting a document REPLACES its passages. Every quotation recorded
-- against the old passages then points at text the database no longer holds,
-- and a citation that cannot be turned to is not a citation
-- (feedback: deposition-fidelity). The cascade makes that loud: the evidence
-- disappears with the passage and the issue falls back into the outline's
-- "what still needs evidence" section, rather than sitting there quoting a
-- page that has moved. The Fleming depositions are the live case — they are
-- waiting to be re-indexed for page:line, and when they are, their evidence
-- must be re-found, not re-labelled.
--
-- RLS follows 036's own pattern exactly: the SECURITY INVOKER wrapper
-- public._bktz_matter_access(uuid), which delegates to _mtspc_select_check.
-- No policy here calls a SECURITY DEFINER helper directly
-- (feedback: rls-security-invoker-wrappers).
--
-- Idempotent against drift. The live database is not the migrations folder
-- (project-dev-environment-cautions), so every object is created with
-- `if not exists` / `create or replace` and every policy is dropped first.
-- Re-pasting this file is a no-op.
--
-- Apply order: after 036 (which creates the tables and the access wrapper).

-- ============================================================================
-- 1. Pair-level run state, on the row that already keys the pair
-- ============================================================================

alter table public.bucketizer_classifications
  add column if not exists evidence_run_at timestamptz;

alter table public.bucketizer_classifications
  add column if not exists evidence_model text;

-- A plain sentence, for a human, about why this pairing produced no quotation:
-- the model's answer could not be used twice, or every quotation it gave was
-- absent from the stored passages, or the row records no candidate passages at
-- all. Null means the pass ran clean — which, with no evidence rows, means the
-- honest answer "these passages do not support this issue".
alter table public.bucketizer_classifications
  add column if not exists evidence_failed text;

-- The pass lists what is left to do. Partial, because the whole point is the
-- rows that have NOT been run.
create index if not exists bucketizer_classifications_evidence_todo_idx
  on public.bucketizer_classifications (matterspace_id, status)
  where evidence_run_at is null;

-- ============================================================================
-- 2. The evidence
-- ============================================================================

create table if not exists public.bucketizer_evidence (
  id uuid primary key default gen_random_uuid(),
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  node_id uuid not null references public.bucketizer_nodes(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  -- See the header: when a document is re-ingested its passages are replaced,
  -- and the quotations recorded against them must go with them.
  passage_id uuid not null references public.passages(id) on delete cascade,

  -- The PASSAGE's own characters for the quoted span, copied out of
  -- passages.text after the span was located in it — never the model's
  -- re-typing of them. `quote_offset` is where the span starts in that text,
  -- so a reader can highlight it without searching.
  quote text not null,
  quote_offset integer not null default 0 check (quote_offset >= 0),

  -- One sentence: what this quotation establishes about this issue.
  rationale text,

  -- Born 'proposed'. Only an attorney decision moves it
  -- (decided_by / decided_at). Nothing that is not 'confirmed' is presented as
  -- established anywhere the outline is rendered.
  status text not null default 'proposed'
    check (status in ('proposed', 'confirmed', 'rejected')),

  -- The attorney's order within the issue. The outline reads it verbatim.
  position integer not null default 0,

  model_id text,
  proposed_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,

  -- One quotation per passage per issue. A second span from the same passage
  -- is the same citation, and the outline would print it twice.
  unique (node_id, passage_id)
);

-- The outline's read: everything confirmed in a matter, in one pass.
create index if not exists bucketizer_evidence_matter_idx
  on public.bucketizer_evidence (matterspace_id, status);

-- The node panel's read, already in the attorney's order.
create index if not exists bucketizer_evidence_node_idx
  on public.bucketizer_evidence (node_id, position, id);

-- "Which pairings already have evidence", and the document index at the end
-- of the outline.
create index if not exists bucketizer_evidence_pair_idx
  on public.bucketizer_evidence (document_id, node_id);

-- ============================================================================
-- 3. RLS — the same SECURITY INVOKER wrapper migration 036 installed
-- ============================================================================

alter table public.bucketizer_evidence enable row level security;

drop policy if exists bucketizer_evidence_select on public.bucketizer_evidence;
create policy bucketizer_evidence_select on public.bucketizer_evidence
  for select to authenticated
  using (public._bktz_matter_access(matterspace_id));

drop policy if exists bucketizer_evidence_insert on public.bucketizer_evidence;
create policy bucketizer_evidence_insert on public.bucketizer_evidence
  for insert to authenticated
  with check (public._bktz_matter_access(matterspace_id));

drop policy if exists bucketizer_evidence_update on public.bucketizer_evidence;
create policy bucketizer_evidence_update on public.bucketizer_evidence
  for update to authenticated
  using (public._bktz_matter_access(matterspace_id))
  with check (public._bktz_matter_access(matterspace_id));

drop policy if exists bucketizer_evidence_delete on public.bucketizer_evidence;
create policy bucketizer_evidence_delete on public.bucketizer_evidence
  for delete to authenticated
  using (public._bktz_matter_access(matterspace_id));
