-- 100_brief_desk.sql — the Brief Desk, slice D1: the brief as an editable document
--
-- docs/specs/BRIEF-DESK-2026-09-26.md §3.1. A brief is an ordinary `documents`
-- row (doc_type 'brief', category 'pleading') with an editable body beside it.
-- No new document kind: the Vault, search, the seal, shares and the Record all
-- apply to it as they do to any document.
--
--   draft_bodies     the live body: TipTap JSON (schema `brief` v1) plus the
--                    same content in the master.md dialect. One row per brief.
--                    `updated_at` is the optimistic lock — the desk saves with
--                    `.eq('updated_at', <what it loaded>)`, and a save that
--                    matches nothing is "changed elsewhere", never an overwrite.
--   draft_snapshots  frozen copies: what a cite-check run checked, what an
--                    export sent. INSERT and SELECT only — nobody updates or
--                    deletes a snapshot through the API (a run row points at
--                    it). `sha256` is computed HERE from body_md, so the
--                    fingerprint the Record and the Cite Verification Record
--                    carry is the database's, not whatever a browser claimed.
--   cite_notes       the telegraphic note per cite (≤ 280 chars), keyed by
--                    cite_key (§3.3), which survives re-checks. D3 writes it.
--   cite_check_runs.snapshot_id — which snapshot a run checked (D3).
--
-- RLS follows the documents policies exactly (016): read = can see the
-- document; write = can_write_matter on the document's matter; the acting
-- user is always auth.uid(). The policies reach the matter THROUGH the
-- documents row (`exists (select 1 from documents …)`), so documents' own
-- policy — and whatever S4b later does to the shared helpers — governs these
-- tables too. The shared helpers themselves are not touched.
--
-- The Record: three matter-bound kinds, re-declaring events_kind_check with
-- the UNION of every kind lib/ledger.mjs's EVENT_KINDS holds (064 + 072 + 073
-- + 094 + these), in 073/094's guarded pattern. Applying this file to a
-- database WITHOUT 094 therefore also adds 094's fifteen, never drops them —
-- and applying 094 after this file would drop these three, which is why the
-- spec held D1 until 094 was on main (§3.1 ⚠). Autosave writes no event.
--
--   draft.snapshot  {document_id, snapshot_id, sha256, label}
--   cite.checked    {document_id, run_id, snapshot_id, counts}          (D3)
--   draft.exported  {document_id, snapshot_id, destination, task_id?}
--
-- Apply order: after 095. Re-runnable: executed twice end-to-end in PGlite by
-- scripts/_verify-brief-md-roundtrip.mjs, against a 094 database and a
-- pre-094 one.
--
-- ⚠ After pasting this file, run:  notify pgrst, 'reload schema';

-- ============================================================================
-- 1. draft_bodies — the live body
-- ============================================================================
create table if not exists public.draft_bodies (
  document_id     uuid primary key references public.documents(id) on delete cascade,
  body            jsonb not null,               -- TipTap JSON, brief schema (spec §3.2)
  body_md         text  not null,               -- the same content in the master.md dialect
  schema_version  int   not null default 1,
  updated_by      uuid  not null,
  updated_at      timestamptz not null default now()
);

-- The lock only works if the server moves the clock: a client that sends its
-- own updated_at could otherwise pin it and defeat the next reader's check.
create or replace function public._draft_bodies_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists draft_bodies_touch on public.draft_bodies;
create trigger draft_bodies_touch
  before insert or update on public.draft_bodies
  for each row execute function public._draft_bodies_touch();

-- ============================================================================
-- 2. draft_snapshots — frozen versions
-- ============================================================================
create table if not exists public.draft_snapshots (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references public.documents(id) on delete cascade,
  label           text,                          -- "v3", "as sent to Claude 26 Sep"
  body            jsonb not null,
  body_md         text  not null,
  sha256          text  not null,                -- of body_md, utf-8, hex
  created_by      uuid  not null,
  created_at      timestamptz not null default now()
);
create index if not exists draft_snapshots_document_idx
  on public.draft_snapshots (document_id, created_at desc);

create or replace function public._draft_snapshots_fingerprint() returns trigger
language plpgsql as $$
begin
  new.sha256 := encode(sha256(convert_to(new.body_md, 'UTF8')), 'hex');
  new.created_at := now();
  return new;
end $$;

drop trigger if exists draft_snapshots_fingerprint on public.draft_snapshots;
create trigger draft_snapshots_fingerprint
  before insert on public.draft_snapshots
  for each row execute function public._draft_snapshots_fingerprint();

-- ============================================================================
-- 3. cite_notes — one telegraphic note per cite per person
-- ============================================================================
create table if not exists public.cite_notes (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references public.documents(id) on delete cascade,
  cite_key        text not null,                 -- spec §3.3
  user_id         uuid not null,
  note            text not null check (char_length(note) <= 280),
  annotation_id   uuid,                          -- the long note, on the authority (D4)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (document_id, cite_key, user_id)
);

-- The long note lives in document_annotations (020/048/084). Guarded: a
-- database that never had 020 applied (the 08-14 drift finding) still takes
-- this file, and gets the foreign key the day 020 lands and this is re-run.
do $fk$
begin
  if to_regclass('public.document_annotations') is not null
     and not exists (select 1 from pg_constraint where conname = 'cite_notes_annotation_id_fkey') then
    alter table public.cite_notes
      add constraint cite_notes_annotation_id_fkey
      foreign key (annotation_id) references public.document_annotations(id) on delete set null;
  end if;
end $fk$;

-- ============================================================================
-- 4. cite_check_runs.snapshot_id — which frozen version a run checked (D3)
-- ============================================================================
do $runs$
begin
  if to_regclass('public.cite_check_runs') is null then
    raise notice '100: public.cite_check_runs is absent (015 not applied); snapshot_id skipped.';
  else
    alter table public.cite_check_runs
      add column if not exists snapshot_id uuid references public.draft_snapshots(id);
  end if;
end $runs$;

-- ============================================================================
-- 5. RLS — the documents policies, reached through the documents row
-- ============================================================================
alter table public.draft_bodies    enable row level security;
alter table public.draft_snapshots enable row level security;
alter table public.cite_notes      enable row level security;

-- draft_bodies: read with the document; write if you may write the matter.
drop policy if exists "Brief body visible with its document" on public.draft_bodies;
create policy "Brief body visible with its document"
  on public.draft_bodies for select
  using (exists (select 1 from public.documents d where d.id = draft_bodies.document_id));

drop policy if exists "Matter writers create a brief body" on public.draft_bodies;
create policy "Matter writers create a brief body"
  on public.draft_bodies for insert
  with check (
    updated_by = auth.uid()
    and exists (select 1 from public.documents d
                 where d.id = draft_bodies.document_id
                   and public.can_write_matter(d.matterspace_id)));

drop policy if exists "Matter writers edit a brief body" on public.draft_bodies;
create policy "Matter writers edit a brief body"
  on public.draft_bodies for update
  using (exists (select 1 from public.documents d
                  where d.id = draft_bodies.document_id
                    and public.can_write_matter(d.matterspace_id)))
  with check (
    updated_by = auth.uid()
    and exists (select 1 from public.documents d
                 where d.id = draft_bodies.document_id
                   and public.can_write_matter(d.matterspace_id)));
-- No DELETE policy: a body goes when its document goes (on delete cascade).

-- draft_snapshots: read with the document; insert if you may write the
-- matter. NO update policy and NO delete policy — a snapshot is frozen.
drop policy if exists "Brief snapshots visible with their document" on public.draft_snapshots;
create policy "Brief snapshots visible with their document"
  on public.draft_snapshots for select
  using (exists (select 1 from public.documents d where d.id = draft_snapshots.document_id));

drop policy if exists "Matter writers take a brief snapshot" on public.draft_snapshots;
create policy "Matter writers take a brief snapshot"
  on public.draft_snapshots for insert
  with check (
    created_by = auth.uid()
    and exists (select 1 from public.documents d
                 where d.id = draft_snapshots.document_id
                   and public.can_write_matter(d.matterspace_id)));

-- cite_notes: everyone on the matter reads them (co-counsel sees your note);
-- you write, edit and delete only your own.
drop policy if exists "Cite notes visible with their document" on public.cite_notes;
create policy "Cite notes visible with their document"
  on public.cite_notes for select
  using (exists (select 1 from public.documents d where d.id = cite_notes.document_id));

drop policy if exists "Matter writers add their own cite note" on public.cite_notes;
create policy "Matter writers add their own cite note"
  on public.cite_notes for insert
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.documents d
                 where d.id = cite_notes.document_id
                   and public.can_write_matter(d.matterspace_id)));

drop policy if exists "Authors edit their own cite note" on public.cite_notes;
create policy "Authors edit their own cite note"
  on public.cite_notes for update
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.documents d
                 where d.id = cite_notes.document_id
                   and public.can_write_matter(d.matterspace_id)));

drop policy if exists "Authors delete their own cite note" on public.cite_notes;
create policy "Authors delete their own cite note"
  on public.cite_notes for delete
  using (user_id = auth.uid());

-- ============================================================================
-- 6. The vocabulary — 073/094's guarded pattern, the UNION of every legal kind
-- ============================================================================
do $migration$
begin

if to_regclass('public.events') is null then
  raise notice '100: public.events is absent — migration 064 has not been applied; kinds skipped.';
  return;
end if;

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
    'run.aborted',
    -- 094: the security build
    'auth.factor_enrolled',
    'auth.factor_unenrolled',
    'auth.stepup',
    'auth.new_device',
    'account.locked',
    'account.unlocked',
    'matter.disconnected',
    'file.filed',
    'file.integrity',
    'file.opened',
    'file.flagged',
    'share.expired',
    'share.reviewed',
    'tripwire.tripped',
    'tripwire.cleared',
    -- 100: the Brief Desk
    'draft.snapshot',
    'cite.checked',
    'draft.exported'
  ))
$sql$;

raise notice '100: events_kind_check widened by three kinds (draft.snapshot, cite.checked, draft.exported).';

end $migration$;
