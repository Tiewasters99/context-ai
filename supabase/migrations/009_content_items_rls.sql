-- Context.ai Migration 009: tighten content_items RLS
--
-- Migration 001 created content_items with deliberately permissive
-- policies (using (true)) because no UI existed yet. Now that the
-- Pages/Lists/Tables surfaces are going active inside matterspaces,
-- access has to follow the parent space — same pattern as documents
-- and passages from migration 005.
--
-- Routing:
--   space_type = 'matterspace' -> member of the matter's serverspace
--   space_type = 'serverspace' -> member of the serverspace
--   space_type = 'clientspace' -> owner of the clientspace
-- The space_id column is untyped (no FK) so we have to switch on
-- space_type at policy time. Existing helpers from migration 005
-- (is_serverspace_member, has_serverspace_role) handle the
-- serverspace/matterspace branches without recursing through RLS.

-- =============================================================================
-- Drop the permissive originals from migration 001
-- =============================================================================
drop policy if exists "Users can view content in their spaces" on public.content_items;
drop policy if exists "Users can insert content"             on public.content_items;
drop policy if exists "Users can update unlocked content"    on public.content_items;


-- =============================================================================
-- Helper: can the current user access a (space_type, space_id) tuple?
-- SECURITY DEFINER avoids re-entering RLS while we resolve the parent.
-- =============================================================================
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
  v_serverspace uuid;
  v_user uuid;
begin
  v_user := auth.uid();
  if v_user is null then return false; end if;

  if p_space_type = 'matterspace' then
    select serverspace_id into v_serverspace
      from public.matterspaces where id = p_space_id;
    if v_serverspace is null then return false; end if;
    return public.is_serverspace_member(v_serverspace);
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

revoke all on function public.can_access_space(text, uuid) from public;
grant execute on function public.can_access_space(text, uuid)
  to authenticated, service_role;


-- =============================================================================
-- New policies
-- =============================================================================

-- SELECT: any user who can access the parent space
create policy "Members can view content in their spaces"
  on public.content_items for select
  using (public.can_access_space(space_type, space_id));

-- INSERT: must be a member AND created_by must equal the caller
create policy "Members can create content in their spaces"
  on public.content_items for insert
  with check (
    created_by = auth.uid()
    and public.can_access_space(space_type, space_id)
  );

-- UPDATE: members can update; locked content only by the locker
create policy "Members can update content in their spaces"
  on public.content_items for update
  using (
    public.can_access_space(space_type, space_id)
    and (not is_locked or locked_by = auth.uid())
  );

-- DELETE: members can delete (no role gating in MVP — tighten later if needed)
create policy "Members can delete content in their spaces"
  on public.content_items for delete
  using (public.can_access_space(space_type, space_id));
