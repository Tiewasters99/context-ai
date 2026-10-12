-- 113_document_review_tags.sql
--
-- Discovery R1: review tags on the matter's documents (Eden, 2026-10-12;
-- spec docs/specs/DISCOVERY-REVIEW-SETS-2026-10-12.md, approved).
--
-- Until now a tag could only sit on a production item (030's document_tags),
-- so a document was tagged only after it was put into a production, and again
-- for every production. This adds tags on the DOCUMENT itself:
--
--   document_review_tags (tag_def_id, document_id, matterspace_id, ...)
--     tag_def_id      one of the matter's tag definitions (document_tag_defs,
--                     the same list the Review Room uses)
--     document_id     a document filed in that matter or any of its folders
--                     and sub-matters (never a sibling or a parent)
--     matterspace_id  the Discovery matter, i.e. the tag definition's matter
--
-- Access is the same as the rest of Discovery: 030's SECURITY INVOKER
-- wrapper _disc_matter_access (the migration-022 rule: no SECURITY DEFINER
-- helper is called from a policy). The guard trigger below is SECURITY
-- INVOKER too, so it sees only documents and matters the caller may read: a
-- document the caller cannot see cannot be tagged.
--
-- Nothing in stamping or packaging reads this table. Productions keep their
-- own tags (document_tags) exactly as before; R2 copies these onto a
-- production's items when a production is built from a set.
--
-- Number: 112 is taken by the Grapheon editions draft (PR #407), so this is
-- 113. There is no dependency between them.
--
-- Idempotent: safe to paste twice. Additive only: no existing row changes.
-- Needs 030 (_disc_matter_access, document_tag_defs) and 012
-- (matterspace_descendants).
-- ⚠ After pasting, run:  notify pgrst, 'reload schema';  (last statement here.)

do $pre$
begin
  if to_regprocedure('public._disc_matter_access(uuid)') is null
     or to_regclass('public.document_tag_defs') is null then
    raise exception '113 needs migration 030 (Discovery) — paste 030 first.';
  end if;
  if to_regprocedure('public.matterspace_descendants(uuid)') is null then
    raise exception '113 needs migration 012 (matterspace_descendants) — paste 012 first.';
  end if;
end $pre$;

create table if not exists public.document_review_tags (
  id             uuid primary key default gen_random_uuid(),
  tag_def_id     uuid not null references public.document_tag_defs(id) on delete cascade,
  document_id    uuid not null references public.documents(id) on delete cascade,
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (tag_def_id, document_id)
);

create index if not exists document_review_tags_matter_idx
  on public.document_review_tags (matterspace_id);
create index if not exists document_review_tags_document_idx
  on public.document_review_tags (document_id);

comment on table public.document_review_tags is
  'Discovery review tags on matter documents (one tag, one document, seen everywhere). Productions copy them onto their items; nothing here is stamped.';

-- Guard: the tag definition belongs to the row's matter, and the document is
-- filed in that matter's subtree. SECURITY INVOKER: RLS on documents and
-- matterspaces applies, so an unreadable document reads as "not in the matter".
create or replace function public._document_review_tags_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_def_matter uuid;
  v_doc_matter uuid;
begin
  select matterspace_id into v_def_matter
    from public.document_tag_defs where id = new.tag_def_id;
  if v_def_matter is null or v_def_matter <> new.matterspace_id then
    raise exception 'review tag: the tag does not belong to this matter'
      using errcode = '42501';
  end if;

  select matterspace_id into v_doc_matter
    from public.documents where id = new.document_id;
  if v_doc_matter is null or not exists (
    select 1 from public.matterspace_descendants(new.matterspace_id) d
     where d.id = v_doc_matter
  ) then
    raise exception 'review tag: the document is not filed in this matter'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists document_review_tags_guard on public.document_review_tags;
create trigger document_review_tags_guard
  before insert or update on public.document_review_tags
  for each row execute function public._document_review_tags_guard();

alter table public.document_review_tags enable row level security;

drop policy if exists "Matter members manage review tags" on public.document_review_tags;
create policy "Matter members manage review tags" on public.document_review_tags
  for all
  using (public._disc_matter_access(matterspace_id))
  with check (public._disc_matter_access(matterspace_id));

revoke all on public.document_review_tags from anon;
grant select, insert, update, delete on public.document_review_tags to authenticated;
grant all on public.document_review_tags to service_role;

notify pgrst, 'reload schema';
