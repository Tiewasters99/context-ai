-- Context.ai Migration 016: Matter-level membership + permission helpers
--
-- Until now, sharing a serverspace gave the recipient access to every
-- matter under it. That's too coarse for a law firm: one outside co-counsel
-- ought to see exactly one matter (and any of its sub-matters), not the
-- whole serverspace. This migration adds a parallel membership table on
-- matterspaces and rewrites the visibility / write / management policies to
-- honor either path (direct on the matter, inherited from an ancestor
-- matter, or inherited from the serverspace).
--
-- Schema:
--   matterspace_members(matter_id, user_id, role)
--   where role ∈ {'admin','member','viewer'}.
--   ('owner' lives at the serverspace level; matter-scoped owners aren't
--   useful — a matter without an owner serverspace wouldn't exist.)
--
-- Helpers (SECURITY DEFINER, to avoid RLS re-entry while resolving access):
--   matter_role(matter_id)          → highest role across direct, ancestor,
--                                     and serverspace memberships
--   can_access_matter(matter_id)    → role is not null
--   can_write_matter(matter_id)     → role ∈ {owner, admin, member}
--   can_manage_matter(matter_id)    → role ∈ {owner, admin}
--   matter_ancestry(matter_id)      → table of self + ancestor ids
--
-- Existing RLS on matterspaces, documents, passages, storage.objects
-- (vault-documents), and content_items is replaced to use these helpers.
-- The old serverspace-only checks become a subset of the new logic, so
-- no existing access is revoked — additional access paths are now
-- available.
--
-- Apply order: anytime after 005 (which introduced the recursion-safe
-- helper pattern). Numbered 016 because 015 was taken by cite_check_runs.

-- ============================================================================
-- Table
-- ============================================================================

create table if not exists public.matterspace_members (
  id uuid primary key default uuid_generate_v4(),
  matterspace_id uuid references public.matterspaces(id) on delete cascade not null,
  user_id uuid references public.profiles(id) on delete cascade not null,
  role text not null default 'member' check (role in ('admin', 'member', 'viewer')),
  joined_at timestamptz not null default now(),
  unique (matterspace_id, user_id)
);

create index if not exists idx_matterspace_members_user
  on public.matterspace_members(user_id);
create index if not exists idx_matterspace_members_matter
  on public.matterspace_members(matterspace_id);

alter table public.matterspace_members enable row level security;


-- ============================================================================
-- Helper functions
-- ============================================================================

-- Returns the ids of the matter itself plus every ancestor (parent, grand-
-- parent, …). SECURITY DEFINER so it can read matterspaces.parent_matterspace_id
-- without re-entering this table's RLS.
create or replace function public.matter_ancestry(p_matter_id uuid)
returns table (id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with recursive a(id, parent_matterspace_id) as (
    select id, parent_matterspace_id
      from public.matterspaces
      where id = p_matter_id
    union all
    select m.id, m.parent_matterspace_id
      from public.matterspaces m
      join a on m.id = a.parent_matterspace_id
  )
  select id from a
$$;

-- Highest-privileged role the caller has on a matter, considering:
--   1. Direct membership on the matter or any ancestor matter.
--   2. Membership on the parent serverspace.
-- Returns 'owner' / 'admin' / 'member' / 'viewer' / null.
create or replace function public.matter_role(p_matter_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  best text;
begin
  if uid is null then return null; end if;

  select role into best
  from (
    -- Direct or ancestor matter membership.
    select mm.role
      from public.matterspace_members mm
      where mm.user_id = uid
        and mm.matterspace_id in (select id from public.matter_ancestry(p_matter_id))
    union all
    -- Serverspace membership.
    select sm.role
      from public.matterspaces m
      join public.serverspace_members sm on sm.serverspace_id = m.serverspace_id
      where m.id = p_matter_id and sm.user_id = uid
  ) r
  order by case role
    when 'owner'  then 4
    when 'admin'  then 3
    when 'member' then 2
    when 'viewer' then 1
    else 0
  end desc
  limit 1;

  return best;
end;
$$;

create or replace function public.can_access_matter(p_matter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$ select public.matter_role(p_matter_id) is not null $$;

create or replace function public.can_write_matter(p_matter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$ select public.matter_role(p_matter_id) in ('owner','admin','member') $$;

create or replace function public.can_manage_matter(p_matter_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$ select public.matter_role(p_matter_id) in ('owner','admin') $$;


-- ============================================================================
-- matterspace_members RLS
-- ============================================================================

drop policy if exists "Users see their own matter memberships"
  on public.matterspace_members;
drop policy if exists "Members see co-members in shared matters"
  on public.matterspace_members;
drop policy if exists "Admins of the matter can add members"
  on public.matterspace_members;
drop policy if exists "Admins of the matter can remove members"
  on public.matterspace_members;

create policy "Users see their own matter memberships"
  on public.matterspace_members for select
  using (user_id = auth.uid());

create policy "Members see co-members in shared matters"
  on public.matterspace_members for select
  using (public.can_access_matter(matterspace_id));

create policy "Admins of the matter can add members"
  on public.matterspace_members for insert
  with check (public.can_manage_matter(matterspace_id));

create policy "Admins of the matter can remove members"
  on public.matterspace_members for delete
  using (public.can_manage_matter(matterspace_id));


-- ============================================================================
-- matterspaces RLS — replace with helper-based versions
-- ============================================================================

drop policy if exists "Members can view matterspaces" on public.matterspaces;
drop policy if exists "Admins can insert matterspaces" on public.matterspaces;
drop policy if exists "Admins can update matterspaces" on public.matterspaces;
-- (Owners can delete matterspaces stays as-is — destructive op kept at
-- serverspace-owner level.)

create policy "Members can view matterspaces"
  on public.matterspaces for select
  using (public.can_access_matter(id));

create policy "Admins can insert matterspaces"
  on public.matterspaces for insert
  with check (
    public.has_serverspace_role(serverspace_id, array['owner','admin'])
    or (parent_matterspace_id is not null
        and public.can_manage_matter(parent_matterspace_id))
  );

create policy "Admins can update matterspaces"
  on public.matterspaces for update
  using (
    public.has_serverspace_role(serverspace_id, array['owner','admin'])
    or public.can_manage_matter(id)
  );


-- ============================================================================
-- documents RLS — replace
-- ============================================================================

drop policy if exists "Members can view documents in their matterspaces"
  on public.documents;
drop policy if exists "Members can insert documents in their matterspaces"
  on public.documents;
drop policy if exists "Members can update documents in their matterspaces"
  on public.documents;
drop policy if exists "Owners and admins can delete documents"
  on public.documents;

create policy "Members can view documents in their matterspaces"
  on public.documents for select
  using (public.can_access_matter(matterspace_id));

create policy "Members can insert documents in their matterspaces"
  on public.documents for insert
  with check (created_by = auth.uid() and public.can_write_matter(matterspace_id));

create policy "Members can update documents in their matterspaces"
  on public.documents for update
  using (public.can_write_matter(matterspace_id));

create policy "Owners and admins can delete documents"
  on public.documents for delete
  using (public.can_manage_matter(matterspace_id));


-- ============================================================================
-- passages RLS — replace
-- ============================================================================

drop policy if exists "Members can view passages in their matterspaces"
  on public.passages;
drop policy if exists "Members can insert passages in their matterspaces"
  on public.passages;
drop policy if exists "Members can update passages in their matterspaces"
  on public.passages;

create policy "Members can view passages in their matterspaces"
  on public.passages for select
  using (public.can_access_matter(matterspace_id));

create policy "Members can insert passages in their matterspaces"
  on public.passages for insert
  with check (public.can_write_matter(matterspace_id));

create policy "Members can update passages in their matterspaces"
  on public.passages for update
  using (public.can_write_matter(matterspace_id));


-- ============================================================================
-- storage.objects on vault-documents — replace
--
-- Paths are "<matter_id>/<doc_id>/<filename>". Defensive uuid cast: only
-- evaluate the matter check when the first folder segment is shaped like a
-- uuid (everything we put there is, but storage is permissive).
-- ============================================================================

drop policy if exists "Members can read vault-documents files in their matterspaces"
  on storage.objects;
drop policy if exists "Members can upload vault-documents files to their matterspaces"
  on storage.objects;
drop policy if exists "Admins can delete vault-documents files"
  on storage.objects;

create policy "Members can read vault-documents files in their matterspaces"
  on storage.objects for select
  using (
    bucket_id = 'vault-documents'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.can_access_matter(((storage.foldername(name))[1])::uuid)
  );

create policy "Members can upload vault-documents files to their matterspaces"
  on storage.objects for insert
  with check (
    bucket_id = 'vault-documents'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.can_write_matter(((storage.foldername(name))[1])::uuid)
  );

create policy "Admins can delete vault-documents files"
  on storage.objects for delete
  using (
    bucket_id = 'vault-documents'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.can_manage_matter(((storage.foldername(name))[1])::uuid)
  );


-- ============================================================================
-- content_items: extend can_access_space() to honor matter-level membership
-- ============================================================================

create or replace function public.can_access_space(
  p_space_type text,
  p_space_id uuid
) returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid;
begin
  v_user := auth.uid();
  if v_user is null then return false; end if;

  if p_space_type = 'matterspace' then
    return public.can_access_matter(p_space_id);
  elsif p_space_type = 'serverspace' then
    return public.is_serverspace_member(p_space_id);
  elsif p_space_type = 'clientspace' then
    return exists (
      select 1 from public.clientspaces
      where id = p_space_id and user_id = v_user
    );
  end if;
  return false;
end;
$$;
