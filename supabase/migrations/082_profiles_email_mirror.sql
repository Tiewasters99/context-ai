-- 082_profiles_email_mirror.sql
--
-- profiles.email is a copy, and nothing kept the copy current.
--
-- What happened (2026-09-21)
-- ---------------------------------------------------------------------------
-- Share › Add by email answered "No Contextspaces account for
-- quaintonlaw@gmail.com" for an account that has existed since April and
-- signs in with exactly that address. The account's login email had been
-- changed at some point; auth.users.email moved, profiles.email did not:
--
--     auth.users.email   = quaintonlaw@gmail.com     (what the person types)
--     profiles.email     = equainton@gmail.com       (what the app looked up)
--
-- handle_new_user copies new.email into profiles once, on INSERT. There has
-- never been anything on UPDATE, so every later email change left the profile
-- row behind. find_profile_by_email (062) matches profiles.email, so the
-- address the person actually uses could not be invited, and member lists
-- showed the old address. One row of nine had drifted; any future email
-- change would have added another.
--
-- What this migration does
-- ---------------------------------------------------------------------------
--   1. Mirrors auth.users.email into profiles.email whenever it changes.
--   2. Repairs the rows that have already drifted (the backfill is the same
--      statement the trigger would have run, so one paste fixes both).
--   3. Makes find_profile_by_email answer from auth.users.email — the address
--      the account signs in with is the definition of "an account for this
--      address", and it stays right even if the mirror is ever dropped.
--      Same signature, same exact-match one-row contract, still returns no
--      email of its own.
--
-- Re-runnable: prod drifts from this folder, so every statement is
-- create-or-replace / drop-if-exists / a no-op on a second run.


-- ============================================================================
-- 1. The mirror.
--
-- SECURITY DEFINER for the same reason handle_new_user is: GoTrue performs the
-- update as supabase_auth_admin, which has no rights on public.profiles. As
-- the owner it also passes profiles_guard_plan (062), which only objects to a
-- pricing_tier change, and this never touches pricing_tier.
--
-- Supabase's confirmed-email-change flow parks the new address in
-- auth.users.email_change and only writes auth.users.email once the change is
-- confirmed, so keying on `email` mirrors confirmed addresses only.
--
-- It must never be the reason a person cannot change their login email, so a
-- failure here is a warning, not an error. (profiles.email carries no unique
-- constraint today; the handler is for whatever is added later.)
-- ============================================================================
create or replace function public.mirror_auth_email_to_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is null then return new; end if;
  begin
    update public.profiles
       set email = new.email
     where id = new.id
       and email is distinct from new.email;
  exception when others then
    raise warning 'mirror_auth_email_to_profile: profile % not updated (%)', new.id, sqlerrm;
  end;
  return new;
end $$;

revoke all on function public.mirror_auth_email_to_profile() from public;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row
  when (new.email is distinct from old.email)
  execute function public.mirror_auth_email_to_profile();


-- ============================================================================
-- 2. Repair what has already drifted.
-- ============================================================================
update public.profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id
   and u.email is not null
   and p.email is distinct from u.email;


-- ============================================================================
-- 3. Invite-by-email answers from the login address.
--
-- Everything 062 said about this function still holds: exact match, one row,
-- signed-in callers only, no email in the result, cannot enumerate. The only
-- change is which column is the authority. The join to profiles stays because
-- the membership tables reference profiles(id) — an auth user with no profile
-- row could not be inserted as a member anyway.
-- ============================================================================
create or replace function public.find_profile_by_email(p_email text)
returns table (id uuid, display_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return; end if;
  if p_email is null or btrim(p_email) = '' then return; end if;
  return query
    select p.id, p.display_name
      from auth.users u
      join public.profiles p on p.id = u.id
     where lower(u.email) = lower(btrim(p_email))
     limit 1;
end $$;

revoke all on function public.find_profile_by_email(text) from public;
grant execute on function public.find_profile_by_email(text)
  to authenticated, service_role;


notify pgrst, 'reload schema';
