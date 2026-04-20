-- Context.ai Migration 005: Fix RLS infinite recursion across membership policies
--
-- Background: migration 001's policies on public.serverspace_members are
-- self-referential — the SELECT and INSERT policies query
-- serverspace_members to decide whether a row is visible or insertable.
-- Postgres attempts to enforce the same policy when evaluating the
-- subquery, and the recursion never terminates. Any authenticated call
-- that transitively touches serverspace_members returns error 42P17
-- ("infinite recursion detected in policy for relation ...").
-- This was invisible while every query ran as service_role (which
-- bypasses RLS). The hosted HTTP MCP endpoint (api/mcp.mjs) runs
-- queries as the authenticated user, so the bug surfaced immediately.
--
-- Fix pattern: replace the recursive lookups with SECURITY DEFINER
-- helper functions. SECURITY DEFINER functions run as their owner
-- (postgres, a superuser in Supabase), bypassing RLS internally, which
-- breaks the loop while preserving the access semantics. The same two
-- helpers support every membership check in the schema.


-- =============================================================================
-- Helpers
-- =============================================================================

create or replace function public.is_serverspace_member(p_serverspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.serverspace_members
    where serverspace_id = p_serverspace_id
      and user_id = auth.uid()
  );
$$;

create or replace function public.has_serverspace_role(
  p_serverspace_id uuid,
  p_roles text[]
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.serverspace_members
    where serverspace_id = p_serverspace_id
      and user_id = auth.uid()
      and role = any(p_roles)
  );
$$;

revoke all on function public.is_serverspace_member(uuid) from public;
revoke all on function public.has_serverspace_role(uuid, text[]) from public;
grant execute on function public.is_serverspace_member(uuid) to authenticated, service_role;
grant execute on function public.has_serverspace_role(uuid, text[]) to authenticated, service_role;


-- =============================================================================
-- serverspace_members — drop the recursive originals, replace with safe ones
-- =============================================================================

drop policy if exists "Members can view serverspace members" on public.serverspace_members;
drop policy if exists "Admins can manage members" on public.serverspace_members;

-- Anyone sees their own membership row outright.
create policy "Users see their own membership rows"
  on public.serverspace_members for select
  using (user_id = auth.uid());

-- Members see co-members in shared serverspaces.
create policy "Members see co-members in shared serverspaces"
  on public.serverspace_members for select
  using (public.is_serverspace_member(serverspace_id));

-- Admins add members. The old policy also used INSERT only; keeping scope.
create policy "Admins add members"
  on public.serverspace_members for insert
  with check (public.has_serverspace_role(serverspace_id, array['owner','admin']));

create policy "Admins remove members"
  on public.serverspace_members for delete
  using (public.has_serverspace_role(serverspace_id, array['owner','admin']));


-- =============================================================================
-- serverspaces — replace recursive SELECT and UPDATE
-- =============================================================================

drop policy if exists "Members can view serverspaces" on public.serverspaces;
drop policy if exists "Admins can update serverspaces" on public.serverspaces;

create policy "Members can view serverspaces"
  on public.serverspaces for select
  using (public.is_serverspace_member(id));

create policy "Admins can update serverspaces"
  on public.serverspaces for update
  using (public.has_serverspace_role(id, array['owner','admin']));


-- =============================================================================
-- matterspaces — replace the policies from migration 004 with helper-based ones
-- =============================================================================

drop policy if exists "Members can view matterspaces" on public.matterspaces;
drop policy if exists "Admins can insert matterspaces" on public.matterspaces;
drop policy if exists "Admins can update matterspaces" on public.matterspaces;
drop policy if exists "Owners can delete matterspaces" on public.matterspaces;

create policy "Members can view matterspaces"
  on public.matterspaces for select
  using (public.is_serverspace_member(serverspace_id));

create policy "Admins can insert matterspaces"
  on public.matterspaces for insert
  with check (public.has_serverspace_role(serverspace_id, array['owner','admin']));

create policy "Admins can update matterspaces"
  on public.matterspaces for update
  using (public.has_serverspace_role(serverspace_id, array['owner','admin']));

create policy "Owners can delete matterspaces"
  on public.matterspaces for delete
  using (public.has_serverspace_role(serverspace_id, array['owner']));


-- =============================================================================
-- documents — rewrite migration 002 policies without the triple-join recursion
-- =============================================================================

drop policy if exists "Members can view documents in their matterspaces" on public.documents;
drop policy if exists "Members can insert documents in their matterspaces" on public.documents;
drop policy if exists "Members can update documents in their matterspaces" on public.documents;
drop policy if exists "Owners and admins can delete documents" on public.documents;

create policy "Members can view documents in their matterspaces"
  on public.documents for select
  using (
    exists (
      select 1 from public.matterspaces m
      where m.id = documents.matterspace_id
        and public.is_serverspace_member(m.serverspace_id)
    )
  );

create policy "Members can insert documents in their matterspaces"
  on public.documents for insert
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.matterspaces m
      where m.id = documents.matterspace_id
        and public.has_serverspace_role(m.serverspace_id, array['owner','admin','member'])
    )
  );

create policy "Members can update documents in their matterspaces"
  on public.documents for update
  using (
    exists (
      select 1 from public.matterspaces m
      where m.id = documents.matterspace_id
        and public.has_serverspace_role(m.serverspace_id, array['owner','admin','member'])
    )
  );

create policy "Owners and admins can delete documents"
  on public.documents for delete
  using (
    exists (
      select 1 from public.matterspaces m
      where m.id = documents.matterspace_id
        and public.has_serverspace_role(m.serverspace_id, array['owner','admin'])
    )
  );


-- =============================================================================
-- passages — rewrite migration 002 policies
-- =============================================================================

drop policy if exists "Members can view passages in their matterspaces" on public.passages;
drop policy if exists "Members can insert passages in their matterspaces" on public.passages;
drop policy if exists "Members can update passages in their matterspaces" on public.passages;

create policy "Members can view passages in their matterspaces"
  on public.passages for select
  using (
    exists (
      select 1 from public.matterspaces m
      where m.id = passages.matterspace_id
        and public.is_serverspace_member(m.serverspace_id)
    )
  );

create policy "Members can insert passages in their matterspaces"
  on public.passages for insert
  with check (
    exists (
      select 1 from public.matterspaces m
      where m.id = passages.matterspace_id
        and public.has_serverspace_role(m.serverspace_id, array['owner','admin','member'])
    )
  );

create policy "Members can update passages in their matterspaces"
  on public.passages for update
  using (
    exists (
      select 1 from public.matterspaces m
      where m.id = passages.matterspace_id
        and public.has_serverspace_role(m.serverspace_id, array['owner','admin','member'])
    )
  );


-- =============================================================================
-- storage.objects for vault-documents — same triple-join, same rewrite
-- =============================================================================

drop policy if exists "Members can read vault-documents files in their matterspaces" on storage.objects;
drop policy if exists "Members can upload vault-documents files to their matterspaces" on storage.objects;
drop policy if exists "Admins can delete vault-documents files" on storage.objects;

create policy "Members can read vault-documents files in their matterspaces"
  on storage.objects for select
  using (
    bucket_id = 'vault-documents'
    and exists (
      select 1 from public.matterspaces m
      where m.id::text = (storage.foldername(storage.objects.name))[1]
        and public.is_serverspace_member(m.serverspace_id)
    )
  );

create policy "Members can upload vault-documents files to their matterspaces"
  on storage.objects for insert
  with check (
    bucket_id = 'vault-documents'
    and exists (
      select 1 from public.matterspaces m
      where m.id::text = (storage.foldername(storage.objects.name))[1]
        and public.has_serverspace_role(m.serverspace_id, array['owner','admin','member'])
    )
  );

create policy "Admins can delete vault-documents files"
  on storage.objects for delete
  using (
    bucket_id = 'vault-documents'
    and exists (
      select 1 from public.matterspaces m
      where m.id::text = (storage.foldername(storage.objects.name))[1]
        and public.has_serverspace_role(m.serverspace_id, array['owner','admin'])
    )
  );
