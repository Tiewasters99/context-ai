-- Context.ai Migration 022: SECURITY INVOKER wrappers for matterspaces RLS policies
--
-- Background: migration 016 introduced has_serverspace_role + can_access_matter +
-- can_manage_matter + matter_role as SECURITY DEFINER, STABLE SQL functions and
-- used them directly in the WITH CHECK / USING expressions of the matterspaces
-- policies. In practice this combination produced a subtle bug in this Supabase
-- project: when called directly from a policy expression, auth.uid() inside
-- those functions returned values inconsistent with what they returned when
-- invoked from any other code path (RPC, INVOKER plpgsql, direct SQL). The
-- visible symptom: INSERT into matterspaces with RETURNING — which is what
-- supabase-js's .insert(...).select() pattern triggers — failed with "new row
-- violates row-level security policy" even for users with the correct
-- serverspace ownership and even on freshly issued JWTs. Plain INSERT without
-- RETURNING worked because it didn't fire the SELECT USING check; the
-- frontend always uses .select('id').single() to get back the new id, so
-- every matter creation failed in practice.
--
-- Fix: wrap the check logic in SECURITY INVOKER plpgsql functions that
-- capture auth.uid() in their own declared variable at function entry,
-- then use those wrappers in the policy expressions. The INVOKER context
-- preserves the JWT claim flow correctly across the call.
--
-- Diagnosed and applied 2026-05-19. See user memory
-- project_contextspaces_rls_invoker_fix_2026_05_19.md for the full story
-- and feedback_rls_security_invoker_wrappers.md for the general lesson.
--
-- Apply order: after 021.

-- ============================================================================
-- INSERT check wrapper
--
-- Top-level matter: caller must be owner/admin of the target serverspace.
-- Sub-matter: caller must be owner/admin of the parent matter's serverspace.
-- (Direct matterspace_members management of the parent matter is also valid
--  but the practical UX path goes through serverspace ownership; keeping
--  this simple matches the security model that existed before.)
-- ============================================================================
create or replace function public._mtspc_insert_check(p_ss uuid, p_parent uuid)
returns boolean
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  if exists (
    select 1 from public.serverspace_members
    where user_id = v_uid
      and serverspace_id = p_ss
      and role in ('owner', 'admin')
  ) then
    return true;
  end if;
  if p_parent is not null and exists (
    select 1 from public.matterspaces m
    join public.serverspace_members sm on sm.serverspace_id = m.serverspace_id
    where m.id = p_parent
      and sm.user_id = v_uid
      and sm.role in ('owner', 'admin')
  ) then
    return true;
  end if;
  return false;
end $$;

grant execute on function public._mtspc_insert_check(uuid, uuid)
  to authenticated, service_role;

-- ============================================================================
-- SELECT check wrapper
--
-- Caller can see a matter if any of:
--   1. Direct serverspace membership on the matter's serverspace
--   2. Direct matterspace_members row on the matter itself
--   3. Direct matterspace_members row on any ancestor matter
--      (sub-matters inherit visibility from parent matter members)
-- ============================================================================
create or replace function public._mtspc_select_check(
  p_matter_id uuid,
  p_serverspace_id uuid,
  p_parent_id uuid
) returns boolean
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  if exists (
    select 1 from public.serverspace_members
    where serverspace_id = p_serverspace_id and user_id = v_uid
  ) then return true; end if;
  if exists (
    select 1 from public.matterspace_members
    where matterspace_id = p_matter_id and user_id = v_uid
  ) then return true; end if;
  if p_parent_id is not null then
    return exists (
      with recursive ancestors(id, parent_id) as (
        select id, parent_matterspace_id
          from public.matterspaces where id = p_parent_id
        union all
        select m.id, m.parent_matterspace_id
          from public.matterspaces m
          join ancestors a on m.id = a.parent_id
      )
      select 1 from ancestors a
      join public.matterspace_members mm on mm.matterspace_id = a.id
      where mm.user_id = v_uid
    );
  end if;
  return false;
end $$;

grant execute on function public._mtspc_select_check(uuid, uuid, uuid)
  to authenticated, service_role;


-- ============================================================================
-- Replace the matterspaces SELECT + INSERT policies to use the new wrappers.
-- The UPDATE and DELETE policies are left as migration 016 defined them; they
-- have not (yet) shown the same symptom, but if a similar failure surfaces on
-- update or delete, apply the same INVOKER-wrapper fix pattern.
-- ============================================================================
drop policy if exists "Members can view matterspaces" on public.matterspaces;
create policy "Members can view matterspaces"
  on public.matterspaces for select
  using (public._mtspc_select_check(id, serverspace_id, parent_matterspace_id));

drop policy if exists "Admins can insert matterspaces" on public.matterspaces;
create policy "Admins can insert matterspaces"
  on public.matterspaces for insert
  with check (public._mtspc_insert_check(serverspace_id, parent_matterspace_id));

-- Tell PostgREST to drop its cached prepared statements so the new policies
-- and functions take effect on the next request.
notify pgrst, 'reload schema';
