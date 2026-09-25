-- Contextspaces Migration 090: until launch, only a workshop account may create
-- a clientspace or a serverspace (Eden, 2026-09-25).
--
-- Why: sign-ups are closed until October 15, but an account that already exists
-- (a free account shown the site for a walkthrough) could still create its own
-- clientspace and serverspace: 001's INSERT policies only check that the row is
-- the caller's own. These two RESTRICTIVE policies add one more condition on
-- INSERT: the caller's profile is on the 'workshop' tier. Nothing that already
-- exists changes; reading, updating, sharing and every matter/document inside an
-- existing serverspace are untouched. Service-role code bypasses RLS as before.
--
-- The helper reads auth.uid() once into a variable and is SECURITY INVOKER, per
-- the house rule (feedback_rls_security_invoker_wrappers): a policy never calls a
-- SECURITY DEFINER function directly. profiles' own RLS lets a user read their
-- own row, which is all it needs.
--
-- Safe to run twice. Rollback (at launch):
--   drop policy if exists prelaunch_clientspace_create on public.clientspaces;
--   drop policy if exists prelaunch_serverspace_create on public.serverspaces;
--   drop function if exists public._prelaunch_can_create_space();

create or replace function public._prelaunch_can_create_space()
returns boolean
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_tier text;
begin
  if v_uid is null then return false; end if;
  select p.pricing_tier into v_tier from public.profiles p where p.id = v_uid;
  return coalesce(v_tier, '') = 'workshop';
end;
$$;

revoke all on function public._prelaunch_can_create_space() from public, anon;
grant execute on function public._prelaunch_can_create_space() to authenticated, service_role;

drop policy if exists prelaunch_clientspace_create on public.clientspaces;
create policy prelaunch_clientspace_create on public.clientspaces
  as restrictive for insert to authenticated
  with check (public._prelaunch_can_create_space());

drop policy if exists prelaunch_serverspace_create on public.serverspaces;
create policy prelaunch_serverspace_create on public.serverspaces
  as restrictive for insert to authenticated
  with check (public._prelaunch_can_create_space());
