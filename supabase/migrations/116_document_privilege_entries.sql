-- 116_document_privilege_entries.sql
--
-- Discovery R3: one privilege-log entry per document, across the matter
-- (Eden, 2026-10-12/13; spec docs/specs/DISCOVERY-REVIEW-SETS-2026-10-12.md
-- §3.4, approved; "privileged in and withheld at stamp" confirmed 2026-10-13).
--
-- Until now a privilege-log entry lived only on a production item (030's
-- privilege_log_entries), drafted when the item was tagged Privileged in an
-- outgoing production, and written again for every production. This adds the
-- entry on the DOCUMENT:
--
--   document_privilege_entries (matterspace_id, document_id, the log fields)
--     one row per document per Discovery matter, the same scope as 113's
--     review tags.
--
-- How the two meet:
--   1. Tagging a document Privileged on the Review tab (113) drafts its entry
--      from the document's metadata. Removing the tag keeps the entry (the
--      work is not lost); the app lists only documents tagged Privileged now.
--   2. When the document goes into an OUTGOING production (114's trigger,
--      replaced below), the production's entry is COPIED from the document's
--      entry and linked to it (privilege_log_entries.document_entry_id). Blank
--      fields of the document's entry are first filled from the item's own
--      metadata (an email's headers are read at intake).
--   3. Until the production is stamped, the two stay in step: an edit to the
--      document's entry reaches the production's copy, and an edit made in
--      the production's Privilege Log reaches the document's entry. Once the
--      production is stamped the copy is the production's own: later edits
--      to the document's entry do not reach it, and edits to it stay in it.
--   Existing per-production entries keep working unchanged; the backfill
--   below links the ones whose item came from a matter document.
--
-- SECURITY INVOKER throughout (the migration-022 rule): no SECURITY DEFINER
-- function is created. Access is 030's _disc_matter_access, as in 113/114.
--
-- Idempotent: safe to paste twice. Additive only: no existing row's values
-- change (the backfill only fills the new link column and new rows).
-- Needs 030, 113 and 114.
-- ⚠ After pasting, run:  notify pgrst, 'reload schema';  (last statement here.)

do $pre$
begin
  if to_regclass('public.document_review_tags') is null
     or to_regprocedure('public._production_item_copy_review_tags()') is null then
    raise exception '116 needs migrations 113 and 114 — paste them first.';
  end if;
end $pre$;

-- A metadata date ("Fri, 5 Jan 2024 09:12:00 -0800", "2024-08-14", junk) as a
-- date, or null. Never an error: a junk date must not stop a production.
create or replace function public._disc_safe_date(p text)
returns date
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p is null or btrim(p) = '' then
    return null;
  end if;
  begin
    return (p::timestamptz)::date;
  exception when others then
    null;
  end;
  begin
    return p::date;
  exception when others then
    return null;
  end;
end $$;

-- 1. The entry on the document ------------------------------------------------

create table if not exists public.document_privilege_entries (
  id             uuid primary key default gen_random_uuid(),
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  document_id    uuid not null references public.documents(id) on delete cascade,
  doc_date       date,
  author         text,
  addressee      text,
  cc             text,
  subject_matter text,
  basis          privilege_basis not null default 'attorney_client',
  basis_custom   text,
  description    text,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (matterspace_id, document_id)
);

create index if not exists document_privilege_entries_document_idx
  on public.document_privilege_entries (document_id);

comment on table public.document_privilege_entries is
  'Discovery R3: the privilege-log entry of a matter document, written once. Outgoing productions copy it onto their own privilege_log_entries; the copy follows it until the production is stamped.';

-- Guard: the document is filed in the row's matter or its folders (as 113).
-- SECURITY INVOKER: an unreadable document reads as "not in the matter".
create or replace function public._document_privilege_entries_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_doc_matter uuid;
begin
  select matterspace_id into v_doc_matter
    from public.documents where id = new.document_id;
  if v_doc_matter is null or not exists (
    select 1 from public.matterspace_descendants(new.matterspace_id) d
     where d.id = v_doc_matter
  ) then
    raise exception 'privilege log: the document is not filed in this matter'
      using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists document_privilege_entries_guard on public.document_privilege_entries;
create trigger document_privilege_entries_guard
  before insert or update on public.document_privilege_entries
  for each row execute function public._document_privilege_entries_guard();

alter table public.document_privilege_entries enable row level security;

drop policy if exists "Matter members manage document privilege entries" on public.document_privilege_entries;
create policy "Matter members manage document privilege entries" on public.document_privilege_entries
  for all
  using (public._disc_matter_access(matterspace_id))
  with check (public._disc_matter_access(matterspace_id));

revoke all on public.document_privilege_entries from anon;
grant select, insert, update, delete on public.document_privilege_entries to authenticated;
grant all on public.document_privilege_entries to service_role;

-- 2. The production's copy points at it ---------------------------------------

alter table public.privilege_log_entries
  add column if not exists document_entry_id uuid
    references public.document_privilege_entries(id) on delete set null;

create index if not exists privilege_log_entries_document_entry_idx
  on public.privilege_log_entries (document_entry_id);

comment on column public.privilege_log_entries.document_entry_id is
  'The matter-wide entry (116) this production entry was copied from. They stay in step until the production is stamped.';

-- 3. Tagging a document Privileged drafts its entry ---------------------------

create or replace function public._review_tag_draft_privilege_entry()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_meta jsonb;
begin
  if not exists (
    select 1 from public.document_tag_defs d
     where d.id = new.tag_def_id and d.behavior = 'privileged'
  ) then
    return null;
  end if;
  select coalesce(metadata, '{}'::jsonb) into v_meta
    from public.documents where id = new.document_id;
  v_meta := coalesce(v_meta, '{}'::jsonb);
  insert into public.document_privilege_entries
    (matterspace_id, document_id, doc_date, author, addressee, cc, subject_matter, created_by)
  values
    (new.matterspace_id, new.document_id,
     public._disc_safe_date(v_meta->>'date'),
     nullif(coalesce(v_meta->>'author', v_meta->>'from'), ''),
     nullif(v_meta->>'to', ''), nullif(v_meta->>'cc', ''),
     nullif(v_meta->>'subject', ''), new.created_by)
  on conflict (matterspace_id, document_id) do nothing;

  -- Tagged in the Review Room: the production's entry was drafted a moment
  -- earlier, from the item's metadata (an email's headers), before this tag
  -- reached the document. Its words fill the document entry's blanks, and
  -- every unstamped production's entry for the document is linked to it.
  update public.document_privilege_entries de
     set doc_date       = coalesce(de.doc_date, pe.doc_date),
         author         = coalesce(de.author, pe.author),
         addressee      = coalesce(de.addressee, pe.addressee),
         cc             = coalesce(de.cc, pe.cc),
         subject_matter = coalesce(de.subject_matter, pe.subject_matter),
         description    = coalesce(de.description, pe.description)
    from (
      select e.*
        from public.privilege_log_entries e
        join public.production_items pi on pi.id = e.production_item_id
        join public.productions p on p.id = e.production_id
       where pi.document_id = new.document_id
         and e.matterspace_id = new.matterspace_id
         and e.document_entry_id is null
         and p.status not in ('stamped', 'packaged', 'delivered')
       order by e.updated_at desc
       limit 1
    ) pe
   where de.matterspace_id = new.matterspace_id
     and de.document_id = new.document_id;

  update public.privilege_log_entries e
     set document_entry_id = de.id,
         doc_date = de.doc_date, author = de.author, addressee = de.addressee, cc = de.cc,
         subject_matter = de.subject_matter, basis = de.basis, basis_custom = de.basis_custom,
         description = de.description, updated_at = now()
    from public.production_items pi, public.productions p, public.document_privilege_entries de
   where e.document_entry_id is null
     and pi.id = e.production_item_id
     and pi.document_id = new.document_id
     and e.matterspace_id = new.matterspace_id
     and p.id = e.production_id
     and p.status not in ('stamped', 'packaged', 'delivered')
     and de.matterspace_id = new.matterspace_id
     and de.document_id = new.document_id;
  return null;
end $$;

drop trigger if exists document_review_tags_draft_privilege on public.document_review_tags;
create trigger document_review_tags_draft_privilege
  after insert on public.document_review_tags
  for each row execute function public._review_tag_draft_privilege_entry();

-- 4. Into an outgoing production: copy the document's entry (replaces 114's) --

create or replace function public._production_item_copy_review_tags()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_direction text;
  v_meta jsonb := coalesce(new.source_metadata, '{}'::jsonb);
  v_entry public.document_privilege_entries%rowtype;
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
    -- The document's entry: drafted now if tagging did not (a tag from before
    -- 116), and its blanks filled from what intake read off the item. If the
    -- document has since left the matter the guard refuses the entry; the
    -- production must not fail for that, so its entry is drafted on its own,
    -- from the item's metadata, as 114 did.
    begin
    insert into public.document_privilege_entries
      (matterspace_id, document_id, doc_date, author, addressee, cc, subject_matter)
    values
      (new.matterspace_id, new.document_id, public._disc_safe_date(v_meta->>'date'),
       nullif(v_meta->>'author', ''), nullif(v_meta->>'to', ''),
       nullif(v_meta->>'cc', ''), nullif(v_meta->>'subject', ''))
    on conflict (matterspace_id, document_id) do update set
      doc_date       = coalesce(document_privilege_entries.doc_date, excluded.doc_date),
      author         = coalesce(document_privilege_entries.author, excluded.author),
      addressee      = coalesce(document_privilege_entries.addressee, excluded.addressee),
      cc             = coalesce(document_privilege_entries.cc, excluded.cc),
      subject_matter = coalesce(document_privilege_entries.subject_matter, excluded.subject_matter)
    returning * into v_entry;
    exception when insufficient_privilege then
      insert into public.privilege_log_entries
        (matterspace_id, production_id, production_item_id, doc_date, author, addressee, cc, subject_matter)
      values
        (new.matterspace_id, new.production_id, new.id, public._disc_safe_date(v_meta->>'date'),
         nullif(v_meta->>'author', ''), nullif(v_meta->>'to', ''),
         nullif(v_meta->>'cc', ''), nullif(v_meta->>'subject', ''))
      on conflict (production_item_id) do nothing;
      return null;
    end;

    insert into public.privilege_log_entries
      (matterspace_id, production_id, production_item_id, document_entry_id,
       doc_date, author, addressee, cc, subject_matter, basis, basis_custom, description)
    values
      (new.matterspace_id, new.production_id, new.id, v_entry.id,
       v_entry.doc_date, v_entry.author, v_entry.addressee, v_entry.cc,
       v_entry.subject_matter, v_entry.basis, v_entry.basis_custom, v_entry.description)
    on conflict (production_item_id) do nothing;
  end if;
  return null;
end $$;

-- (114's trigger already calls this function; re-created for a clean paste.)
drop trigger if exists production_items_copy_review_tags on public.production_items;
create trigger production_items_copy_review_tags
  after insert on public.production_items
  for each row execute function public._production_item_copy_review_tags();

-- An entry drafted any other way (the Review Room's own Privileged tag, the
-- app's ensurePrivilegeDraft) for an item that came from a matter document
-- which already has its entry: linked at once, and the document's words win
-- over the item's metadata, which only fills blanks.
create or replace function public._privilege_log_entry_link()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_entry public.document_privilege_entries%rowtype;
begin
  if new.document_entry_id is not null then
    return new;
  end if;
  select de.* into v_entry
    from public.production_items pi
    join public.document_privilege_entries de
      on de.document_id = pi.document_id and de.matterspace_id = new.matterspace_id
   where pi.id = new.production_item_id;
  if v_entry.id is null then
    return new;
  end if;
  new.document_entry_id := v_entry.id;
  new.doc_date       := coalesce(v_entry.doc_date, new.doc_date);
  new.author         := coalesce(v_entry.author, new.author);
  new.addressee      := coalesce(v_entry.addressee, new.addressee);
  new.cc             := coalesce(v_entry.cc, new.cc);
  new.subject_matter := coalesce(v_entry.subject_matter, new.subject_matter);
  new.basis          := v_entry.basis;
  new.basis_custom   := v_entry.basis_custom;
  new.description    := coalesce(v_entry.description, new.description);
  return new;
end $$;

drop trigger if exists privilege_log_entries_link on public.privilege_log_entries;
create trigger privilege_log_entries_link
  before insert on public.privilege_log_entries
  for each row execute function public._privilege_log_entry_link();

-- ...and what the item's metadata filled in goes back to the document's
-- blanks, so the next edit at the document does not blank it in the copy.
create or replace function public._privilege_log_entry_fill_document()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.document_entry_id is null then
    return null;
  end if;
  update public.document_privilege_entries de
     set doc_date       = coalesce(de.doc_date, new.doc_date),
         author         = coalesce(de.author, new.author),
         addressee      = coalesce(de.addressee, new.addressee),
         cc             = coalesce(de.cc, new.cc),
         subject_matter = coalesce(de.subject_matter, new.subject_matter),
         description    = coalesce(de.description, new.description)
   where de.id = new.document_entry_id
     and (de.doc_date is null and new.doc_date is not null
       or de.author is null and new.author is not null
       or de.addressee is null and new.addressee is not null
       or de.cc is null and new.cc is not null
       or de.subject_matter is null and new.subject_matter is not null
       or de.description is null and new.description is not null);
  return null;
end $$;

drop trigger if exists privilege_log_entries_fill_document on public.privilege_log_entries;
create trigger privilege_log_entries_fill_document
  after insert on public.privilege_log_entries
  for each row execute function public._privilege_log_entry_fill_document();

-- 5. In step until stamped ----------------------------------------------------
-- Each direction updates only rows whose values differ, so an edit travels
-- once and stops: document → copies → (no further change) → done.

create or replace function public._document_privilege_entry_to_copies()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  update public.privilege_log_entries pe
     set doc_date = new.doc_date, author = new.author, addressee = new.addressee,
         cc = new.cc, subject_matter = new.subject_matter, basis = new.basis,
         basis_custom = new.basis_custom, description = new.description,
         updated_at = now()
    from public.productions p
   where pe.document_entry_id = new.id
     and p.id = pe.production_id
     and p.status not in ('stamped', 'packaged', 'delivered')
     and (pe.doc_date, pe.author, pe.addressee, pe.cc, pe.subject_matter, pe.basis, pe.basis_custom, pe.description)
         is distinct from
         (new.doc_date, new.author, new.addressee, new.cc, new.subject_matter, new.basis, new.basis_custom, new.description);
  return null;
end $$;

drop trigger if exists document_privilege_entries_to_copies on public.document_privilege_entries;
create trigger document_privilege_entries_to_copies
  after update on public.document_privilege_entries
  for each row execute function public._document_privilege_entry_to_copies();

create or replace function public._privilege_log_entry_to_document()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.document_entry_id is null then
    return null;
  end if;
  if exists (
    select 1 from public.productions p
     where p.id = new.production_id
       and p.status in ('stamped', 'packaged', 'delivered')
  ) then
    return null;
  end if;
  update public.document_privilege_entries de
     set doc_date = new.doc_date, author = new.author, addressee = new.addressee,
         cc = new.cc, subject_matter = new.subject_matter, basis = new.basis,
         basis_custom = new.basis_custom, description = new.description
   where de.id = new.document_entry_id
     and (de.doc_date, de.author, de.addressee, de.cc, de.subject_matter, de.basis, de.basis_custom, de.description)
         is distinct from
         (new.doc_date, new.author, new.addressee, new.cc, new.subject_matter, new.basis, new.basis_custom, new.description);
  return null;
end $$;

drop trigger if exists privilege_log_entries_to_document on public.privilege_log_entries;
create trigger privilege_log_entries_to_document
  after update on public.privilege_log_entries
  for each row execute function public._privilege_log_entry_to_document();

-- 6. Backfill -----------------------------------------------------------------
-- a. Documents already tagged Privileged on the Review tab get their entry.
--    The newest production entry for the document seeds it when one exists
--    (it may hold a reviewer's work); otherwise the document's metadata.
--    Only documents still filed in the matter (the guard would refuse others).

insert into public.document_privilege_entries
  (matterspace_id, document_id, doc_date, author, addressee, cc, subject_matter,
   basis, basis_custom, description, created_by)
select distinct on (rt.matterspace_id, rt.document_id)
       rt.matterspace_id, rt.document_id,
       coalesce(pe.doc_date, public._disc_safe_date(doc.metadata->>'date')),
       coalesce(pe.author, nullif(coalesce(doc.metadata->>'author', doc.metadata->>'from'), '')),
       coalesce(pe.addressee, nullif(doc.metadata->>'to', '')),
       coalesce(pe.cc, nullif(doc.metadata->>'cc', '')),
       coalesce(pe.subject_matter, nullif(doc.metadata->>'subject', '')),
       coalesce(pe.basis, 'attorney_client'), pe.basis_custom, pe.description,
       rt.created_by
  from public.document_review_tags rt
  join public.document_tag_defs d on d.id = rt.tag_def_id and d.behavior = 'privileged'
  join public.documents doc on doc.id = rt.document_id
  left join lateral (
    select e.*
      from public.privilege_log_entries e
      join public.production_items pi on pi.id = e.production_item_id
     where pi.document_id = rt.document_id
       and e.matterspace_id = rt.matterspace_id
     order by e.updated_at desc
     limit 1
  ) pe on true
 where exists (
   select 1 from public.matterspace_descendants(rt.matterspace_id) t
    where t.id = doc.matterspace_id
 )
 order by rt.matterspace_id, rt.document_id
on conflict (matterspace_id, document_id) do nothing;

-- b. Existing production entries whose item came from a matter document point
--    at that document's entry. Only the link is written; no value changes.
update public.privilege_log_entries e
   set document_entry_id = de.id
  from public.production_items pi, public.document_privilege_entries de
 where e.document_entry_id is null
   and pi.id = e.production_item_id
   and pi.document_id is not null
   and de.document_id = pi.document_id
   and de.matterspace_id = e.matterspace_id;

notify pgrst, 'reload schema';
