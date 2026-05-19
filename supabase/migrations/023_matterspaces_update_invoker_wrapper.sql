-- Context.ai Migration 023: SECURITY INVOKER wrapper for matterspaces UPDATE policy
--
-- Migration 022 fixed the matterspaces SELECT and INSERT policies by
-- routing them through SECURITY INVOKER plpgsql wrappers. The UPDATE
-- policy still calls SECURITY DEFINER + STABLE SQL functions directly
-- (has_serverspace_role, can_manage_matter) — the same combination that
-- triggers the "auth.uid() returns inconsistent values" bug when called
-- from policy contexts.
--
-- The bug wasn't visible on UPDATE until the user tried to re-parent a
-- matter via drag-and-drop (changing parent_matterspace_id), at which
-- point matter updates would silently fail with the same 42501
-- "row-level security policy" error we chased through 022.
--
-- Applying the same INVOKER-wrapper pattern here, so drag-to-reparent
-- works and any other matter UPDATE (rename, description edit, cover
-- url change, etc.) is also robust against the same latent bug.
--
-- Apply order: after 022.

create or replace function public._mtspc_update_check(
  p_matter_id uuid,
  p_serverspace_id uuid
) returns boolean
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  -- Owner/admin of the serverspace can manage any matter in it.
  if exists (
    select 1 from public.serverspace_members
    where user_id = v_uid
      and serverspace_id = p_serverspace_id
      and role in ('owner', 'admin')
  ) then return true; end if;
  -- Owner/admin of the matter itself (direct or via ancestor matter membership).
  return exists (
    with recursive ancestors(id, parent_id) as (
      select id, parent_matterspace_id
        from public.matterspaces where id = p_matter_id
      union all
      select m.id, m.parent_matterspace_id
        from public.matterspaces m
        join ancestors a on m.id = a.parent_id
    )
    select 1 from ancestors a
    join public.matterspace_members mm on mm.matterspace_id = a.id
    where mm.user_id = v_uid
      and mm.role in ('owner', 'admin')
  );
end $$;

grant execute on function public._mtspc_update_check(uuid, uuid)
  to authenticated, service_role;

drop policy if exists "Admins can update matterspaces" on public.matterspaces;
create policy "Admins can update matterspaces"
  on public.matterspaces for update
  using (public._mtspc_update_check(id, serverspace_id));

notify pgrst, 'reload schema';
