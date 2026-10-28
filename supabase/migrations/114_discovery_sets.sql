-- 114_discovery_sets.sql
--
-- Discovery R2: sets, and productions built from them (Eden, 2026-10-12;
-- spec docs/specs/DISCOVERY-REVIEW-SETS-2026-10-12.md, approved).
--
-- 1. discovery_sets: a saved, named question about the matter's documents.
--      rule = {"kind":"filter", "tags_has":[..], "tags_not":[..], "folder",
--              "ext", "text", "from", "to"}      stays current as review goes on
--           | {"kind":"list", "document_ids":[..]} a hand-picked list
--    The app evaluates the rule; the database only stores it.
--
-- 2. productions.source_set_id / source_set_rule: the set a production was
--    built from, and its rule FROZEN at that moment (the documents themselves
--    are frozen as the production's items).
--
-- 3. Tags follow the document into a production. When a production item is
--    created for a matter document (production_items.document_id), the
--    document's review tags (113) in the production's matter are copied onto
--    the item (030's document_tags), so stamping, exclusions, endorsements and
--    the load file read them exactly as if the reviewer had tagged the item.
--    A Privileged tag copied into an OUTGOING production also drafts its
--    privilege-log entry, as tagging in the Review Room does. The copy is made
--    once, at insert: later tag changes on the document do not reach a
--    production that already holds it, and a stamped production is frozen
--    anyway (030's lock).
--
-- SECURITY INVOKER throughout (the migration-022 rule). The worker inserts
-- items with the service role; a member who inserts an item copies only tags
-- their own RLS lets them read and write.
--
-- Idempotent: safe to paste twice. Additive only: no existing row changes.
-- Needs 030 and 113.
-- ⚠ After pasting, run:  notify pgrst, 'reload schema';  (last statement here.)

do $pre$
begin
  if to_regclass('public.document_review_tags') is null then
    raise exception '114 needs migration 113 (document_review_tags) — paste 113 first.';
  end if;
end $pre$;

-- 1. Sets ---------------------------------------------------------------------

create table if not exists public.discovery_sets (
  id             uuid primary key default gen_random_uuid(),
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  name           text not null check (length(btrim(name)) between 1 and 200),
  rule           jsonb not null check (jsonb_typeof(rule) = 'object' and rule ? 'kind'),
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (matterspace_id, name)
);

create index if not exists discovery_sets_matter_idx on public.discovery_sets (matterspace_id);

comment on table public.discovery_sets is
  'Discovery sets: a saved filter over the matter''s documents and their review tags, or a hand-picked list. Productions record the set they were built from.';

alter table public.discovery_sets enable row level security;

drop policy if exists "Matter members manage sets" on public.discovery_sets;
create policy "Matter members manage sets" on public.discovery_sets
  for all
  using (public._disc_matter_access(matterspace_id))
  with check (public._disc_matter_access(matterspace_id));

revoke all on public.discovery_sets from anon;
grant select, insert, update, delete on public.discovery_sets to authenticated;
grant all on public.discovery_sets to service_role;

-- 2. Which set a production came from ----------------------------------------

alter table public.productions
  add column if not exists source_set_id uuid references public.discovery_sets(id) on delete set null;
alter table public.productions
  add column if not exists source_set_rule jsonb;

comment on column public.productions.source_set_rule is
  'The rule of the set this production was built from, as it stood when the production was made (with the set''s name).';

-- 3. Tags follow the document into a production -------------------------------

create or replace function public._production_item_copy_review_tags()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_direction text;
  v_meta jsonb := coalesce(new.source_metadata, '{}'::jsonb);
  v_date date;
begin
  if new.document_id is null then
    return null;
  end if;

  insert into public.document_tags (tag_def_id, production_item_id, matterspace_id, created_by)
  select rt.tag_def_id, new.id, new.matterspace_id, rt.created_by
    from public.document_review_tags rt
   where rt.document_id = new.document_id
     and rt.matterspace_id = new.matterspace_id
  on conflict (tag_def_id, production_item_id) do nothing;

  select direction into v_direction from public.productions where id = new.production_id;
  if v_direction = 'outgoing' and exists (
    select 1
      from public.document_review_tags rt
      join public.document_tag_defs d on d.id = rt.tag_def_id
     where rt.document_id = new.document_id
       and rt.matterspace_id = new.matterspace_id
       and d.behavior = 'privileged'
  ) then
    begin
      v_date := nullif(v_meta->>'date', '')::date;
    exception when others then
      v_date := null;
    end;
    insert into public.privilege_log_entries
      (matterspace_id, production_id, production_item_id, doc_date, author, addressee, cc, subject_matter)
    values
      (new.matterspace_id, new.production_id, new.id, v_date,
       nullif(v_meta->>'author', ''), nullif(v_meta->>'to', ''),
       nullif(v_meta->>'cc', ''), nullif(v_meta->>'subject', ''))
    on conflict (production_item_id) do nothing;
  end if;
  return null;
end $$;

drop trigger if exists production_items_copy_review_tags on public.production_items;
create trigger production_items_copy_review_tags
  after insert on public.production_items
  for each row execute function public._production_item_copy_review_tags();

notify pgrst, 'reload schema';
