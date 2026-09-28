-- 103_cite_confirmations.sql — the human check of a brief's citations, one row per click.
--
-- "Confirm this brief" is the machine's pass: it finds each cite in the record
-- and flags what it cannot find. Courts want the lawyer's own reading (Eden,
-- 09-27: "you can't rely on the machine to verify the brief"). This table is
-- that reading. On the Brief Desk a person highlights a cite, opens it with
-- Find in corpus, reads the page, and presses Confirm with their initials —
-- or Problem, with a word on what is wrong. Each press is one row here, with
-- the cite as the brief writes it, the sentence it sits in, the authority and
-- page that were open, who, and when.
--
-- Append-only. Nothing here is ever updated or deleted through the app: a
-- second reading is a second row, and the latest row for a cite is what the
-- desk shows. That is what makes the log a record rather than a status.
--
-- Read = anyone who can see the brief (RLS on documents decides); write = a
-- matter writer, as themselves (016 can_write_matter). No update or delete
-- policy exists, on purpose.

create table if not exists public.cite_confirmations (
  id                     uuid primary key default gen_random_uuid(),
  document_id            uuid not null references public.documents(id) on delete cascade,   -- the brief
  cite_raw               text not null check (char_length(cite_raw) between 1 and 400),     -- the cite as highlighted
  context                text not null default '' check (char_length(context) <= 2000),     -- the sentence/paragraph it sits in
  pm_from                integer,                                                            -- where in the brief it was (a hint; text is the anchor)
  authority_document_id  uuid references public.documents(id) on delete set null,           -- what was open beside the brief
  authority_title        text,
  authority_page         integer,
  status                 text not null check (status in ('confirmed', 'problem')),
  note                   text not null default '' check (char_length(note) <= 400),
  initials               text not null check (char_length(initials) between 1 and 6),
  user_id                uuid not null,
  created_at             timestamptz not null default now()
);

create index if not exists idx_cite_confirmations_document on public.cite_confirmations (document_id, created_at);

alter table public.cite_confirmations enable row level security;

drop policy if exists "Cite confirmations visible with their document" on public.cite_confirmations;
create policy "Cite confirmations visible with their document"
  on public.cite_confirmations for select
  using (exists (select 1 from public.documents d where d.id = cite_confirmations.document_id));

drop policy if exists "Matter writers confirm a cite as themselves" on public.cite_confirmations;
create policy "Matter writers confirm a cite as themselves"
  on public.cite_confirmations for insert
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.documents d
                 where d.id = cite_confirmations.document_id
                   and public.can_write_matter(d.matterspace_id)));

grant select, insert on public.cite_confirmations to authenticated;

comment on table public.cite_confirmations is
  'The lawyer''s own check of a brief''s citations on the Brief Desk: one append-only row per Confirm/Problem press '
  '(cite as written, its sentence, the authority and page open, initials, time). Never updated or deleted by the app.';
