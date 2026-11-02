-- 127_document_versions.sql
--
-- Word is the editor, Equazia is the home (docs/specs/WORD-ROUNDTRIP-2026-11-01.md).
-- The .docx itself is the document in the matter; every "Save to Equazia"
-- from Word stores the bytes as a NEW object and writes one row here. The
-- documents row's storage_path is repointed at the newest object (the same
-- move 100's publishSnapshot makes for a Desk brief); older objects stay in
-- the bucket as the history and these rows say which is which.
--
--   document_versions  one row per saved version: label ("v.2"), the object,
--                      its size and sha256, who saved it and when, and where
--                      it came from (word | upload | desk).
--                      INSERT and SELECT only — a version is frozen. Readable
--                      with the document (RLS on documents is the membership
--                      test, as 100's snapshots do); insertable by someone who
--                      can write the matter.
--   _document_versions_in_matter()  a trigger refusing a storage_path outside
--                      the document's own matter: 097's rule, which a CHECK
--                      cannot state because it looks at another table.
--
-- No new Record kind: a Save writes 094's `file.filed` with
-- {document_id, version_id, label, sha256, source}.
--
-- Apply order: after 126. Re-runnable.
-- ⚠ After pasting this file, run:  notify pgrst, 'reload schema';

create table if not exists public.document_versions (
  id               uuid primary key default gen_random_uuid(),
  document_id      uuid not null references public.documents(id) on delete cascade,
  label            text not null,                 -- "v.2", "as sent 11-01"
  storage_path     text not null,                 -- vault-documents: <matter>/<document>/<file>
  filename         text not null,                 -- the name Word had for it
  file_size_bytes  bigint,
  sha256           text,                          -- of the bytes, hex, computed by the saver
  source           text not null default 'word'
                   check (source in ('word', 'upload', 'desk')),
  note             text,
  created_by       uuid not null,
  created_at       timestamptz not null default now(),
  constraint document_versions_label_len check (char_length(label) between 1 and 80),
  constraint document_versions_note_len  check (note is null or char_length(note) <= 500)
);

create index if not exists document_versions_document_idx
  on public.document_versions (document_id, created_at desc);

-- 097 for versions: the object must be filed under the document's matter,
-- exactly three plain segments.
create or replace function public._document_versions_in_matter() returns trigger
language plpgsql as $$
declare
  m uuid;
begin
  select d.matterspace_id into m from public.documents d where d.id = new.document_id;
  if m is null then
    raise exception 'document_versions: document % not found', new.document_id;
  end if;
  if new.storage_path !~ ('^' || m::text || '/[^/]+/[^/]+$')
     or new.storage_path ~ '(^|/)\.\.?(/|$)'
     or new.storage_path ~ '[%\\]' then
    raise exception 'document_versions: storage_path must be <matter>/<document>/<file> inside the document''s matter';
  end if;
  new.created_at := now();
  return new;
end $$;

drop trigger if exists document_versions_in_matter on public.document_versions;
create trigger document_versions_in_matter
  before insert on public.document_versions
  for each row execute function public._document_versions_in_matter();

alter table public.document_versions enable row level security;

drop policy if exists "Document versions visible with their document" on public.document_versions;
create policy "Document versions visible with their document"
  on public.document_versions for select
  using (exists (select 1 from public.documents d where d.id = document_versions.document_id));

drop policy if exists "Matter writers save a document version" on public.document_versions;
create policy "Matter writers save a document version"
  on public.document_versions for insert
  with check (
    created_by = auth.uid()
    and exists (select 1 from public.documents d
                 where d.id = document_versions.document_id
                   and public.can_write_matter(d.matterspace_id)));
-- No UPDATE policy and no DELETE policy: a version is frozen; it goes with
-- its document (on delete cascade).

grant select, insert on public.document_versions to authenticated;

notify pgrst, 'reload schema';
