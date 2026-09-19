-- Context.ai Migration 062: profiles — the plan is server-owned, email is not public
--
-- Two holes shipped in migration 001 and have been open ever since:
--
--   001:131  create policy "Users can update own profile" on public.profiles
--              for update using (auth.uid() = id);
--            No WITH CHECK, no column restriction. `authenticated` held a
--            table-wide UPDATE grant, so any signed-in user could
--            PATCH /rest/v1/profiles?id=eq.<self> {"pricing_tier":"max"}
--            from the browser console and upgrade their own account.
--
--   001:130  create policy "Profiles are viewable by everyone" on public.profiles
--              for select using (true);
--            Every user could read every other user's row — `GET
--            /rest/v1/profiles?select=email` returned the whole customer list.
--
-- Both had to be closed before `pricing_tier` could mean anything, because
-- 2026-09-19 Eden made one plan value per account the switch for the
-- investor/new-user account, the Beta labels and (later) billing.
--
-- What this migration does
-- ---------------------------------------------------------------------------
--   1. Extends the pricing_tier vocabulary with 'workshop' (sees every
--      surface — Eden's own account). It sets NO row's value; the one line
--      for Eden's account is in the PR body.
--   2. Makes pricing_tier writable by the service role only, with a BEFORE
--      UPDATE guard trigger AND column-level privileges.
--   3. Replaces the everybody-reads-everybody SELECT policy with: your own
--      row in full, plus the rows of people you actually share a workspace
--      with (which is where the member lists, comment authors and margin-note
--      authors get their names and emails from).
--   4. Adds find_profile_by_email() so the Share dialog can still turn a typed
--      email into an account without being able to enumerate the user table.
--
-- Why a trigger AND column privileges (belt and braces, trigger is the belt)
-- ---------------------------------------------------------------------------
-- Column privileges are the tidy answer and PostgREST honours them: it runs
-- every anon-key request as the `authenticated` role, so `revoke update on
-- profiles` + `grant update (display_name, avatar_url, assistant_mode)` makes
-- a PATCH that carries pricing_tier fail in Postgres itself with 42501,
-- before any policy runs. But they are one blanket
-- `grant all on all tables in schema public to authenticated` away from being
-- silently undone — a line that appears in Supabase's own bootstrap, in this
-- repo's harness stubs, and in any future "fix the permissions" paste. The
-- live database is known to drift from this folder (several migrations here
-- were never applied; 047 records the same class of drift on policies), so
-- the guarantee has to be the thing a re-grant cannot reopen: a BEFORE UPDATE
-- trigger that refuses the column change for every role except the service
-- role. scripts/_verify-profiles-rls.mjs asserts exactly that — it re-runs the
-- blanket grant after 062 and the trigger still holds.
--
-- RLS recursion
-- ---------------------------------------------------------------------------
-- The new SELECT policy has to consult serverspace_members and
-- matterspace_members. Per feedback_rls_security_invoker_wrappers (and
-- migration 022, which exists because of it), a policy expression in this
-- project must not call a SECURITY DEFINER + STABLE SQL function directly —
-- auth.uid() comes back inconsistent inside one. So the function the policy
-- calls is SECURITY INVOKER plpgsql and captures auth.uid() into its own
-- variable at entry, exactly like _mtspc_select_check. The membership lookup
-- underneath it is DEFINER but takes both user ids as arguments and never
-- calls auth.uid(), so the hazard cannot apply to it either (see section 3).
-- Nothing loops back to profiles: neither function reads that table.
--
-- Idempotent on purpose: every statement is drop-if-exists / create-or-replace
-- and the constraint is dropped by catalog lookup rather than by an assumed
-- name, because prod may not match this folder. Running it twice is a no-op.
--
-- Apply order: after 061. Safe to apply while the app is running — the only
-- thing that changes for a signed-in user is that strangers' rows disappear.


-- ============================================================================
-- 1. pricing_tier vocabulary: free | pro | max | workshop
--
-- 'workshop' = sees every surface (Eden's own account). Everything else =
-- the focused core. The old constraint was created inline by 001 and is
-- therefore system-named; drop whatever check mentions pricing_tier rather
-- than guessing the name.
-- ============================================================================
do $$
declare
  c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.profiles'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%pricing_tier%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.profiles
  add constraint profiles_pricing_tier_check
  check (pricing_tier in ('free', 'pro', 'max', 'workshop'));


-- ============================================================================
-- 2a. The guard: pricing_tier changes only under the service role.
--
-- current_user is the role PostgREST switched into for the request:
-- 'authenticated' for any anon-key call with a user JWT, 'anon' for a call
-- without one, 'service_role' for the service key. Eden's SQL editor runs as
-- 'postgres', which is how the workshop line gets applied; supabase_admin
-- covers the dashboard's other internal paths.
--
-- Deliberately narrow: this guards pricing_tier only. profiles.email is left
-- to the column grants below (it is written by handle_new_user, which is
-- SECURITY DEFINER and runs as the owner, so the grants do not affect signup).
-- ============================================================================
create or replace function public.profiles_guard_plan()
returns trigger
language plpgsql
security invoker
as $$
begin
  if new.pricing_tier is distinct from old.pricing_tier
     and current_user not in ('service_role', 'postgres', 'supabase_admin')
  then
    raise exception
      'pricing_tier is set by the service role only (% tried to change % -> %)',
      current_user, old.pricing_tier, new.pricing_tier
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard_plan on public.profiles;
create trigger profiles_guard_plan
  before update on public.profiles
  for each row execute function public.profiles_guard_plan();


-- ============================================================================
-- 2b. The braces: column-level UPDATE privileges.
--
-- A table-level REVOKE does not remove column-level grants and vice versa, so
-- both are stated explicitly to stay idempotent against whatever prod holds.
-- Users keep editing their own name, avatar and assistant mode; id, email,
-- pricing_tier, assistant-agnostic timestamps are not theirs to write.
-- ============================================================================
revoke update on public.profiles from anon, authenticated;
revoke update (id, email, pricing_tier, created_at, updated_at)
  on public.profiles from anon, authenticated;
grant update (display_name, avatar_url, assistant_mode)
  on public.profiles to authenticated;


-- ============================================================================
-- 2c. The UPDATE policy gets the WITH CHECK 001 never had.
--
-- (Postgres already reuses USING as WITH CHECK when the latter is absent, so
-- this is not the hole — the hole was the column grant — but leaving it
-- implicit is how the hole read as harmless for four months.)
-- ============================================================================
drop policy if exists "Users can update own profile" on public.profiles;
drop policy if exists "Users update own profile" on public.profiles;
create policy "Users update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);


-- ============================================================================
-- 3. Who may read whose row.
--
-- Three ways to be a co-worker, covering every profiles read in the app:
--   1. we are both members of the same serverspace   (ShareModal serverspace
--      scope, matter comments, margin notes, activity feed)
--   2. we are both members of the same matter        (ShareModal matter scope
--      — co-counsel shared into one case, migration 016)
--   3. one of us holds a matter membership inside a serverspace the other
--      belongs to — the asymmetric case. The serverspace owner and the
--      co-counsel invited into one of its matters share no row in either
--      table, yet they read each other's names in the same share dialog and
--      the same comment thread.
--
-- Two functions, and the split matters:
--
--   _profiles_share_workspace is SECURITY DEFINER and takes BOTH user ids as
--   arguments. It never calls auth.uid(), so it cannot run into the
--   auth.uid()-inside-DEFINER inconsistency that migration 022 exists to work
--   around. DEFINER is required, not cosmetic: under the caller's own RLS the
--   membership tables are only half-visible — a matter-level co-counsel
--   cannot see the serverspace_members row of the serverspace owner (005's
--   policy needs serverspace membership to show it), so clause 3 silently
--   failed in one direction. The PGlite harness caught exactly that.
--
--   _profiles_select_check is the one the POLICY calls: SECURITY INVOKER
--   plpgsql that captures auth.uid() into its own variable at entry, the
--   pattern feedback_rls_security_invoker_wrappers and migration 022 require.
--   It answers the self case itself and hands the membership question down
--   with explicit ids.
--
-- Nothing recurses back into profiles: neither function reads it.
-- ============================================================================
create or replace function public._profiles_share_workspace(
  p_viewer uuid,
  p_subject uuid
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    -- 1. same serverspace
    exists (
      select 1
        from public.serverspace_members a
        join public.serverspace_members b on b.serverspace_id = a.serverspace_id
       where a.user_id = p_viewer and b.user_id = p_subject
    )
    -- 2. same matter
    or exists (
      select 1
        from public.matterspace_members a
        join public.matterspace_members b on b.matterspace_id = a.matterspace_id
       where a.user_id = p_viewer and b.user_id = p_subject
    )
    -- 3. one is in a matter of a serverspace the other belongs to
    or exists (
      select 1
        from public.matterspace_members mm
        join public.matterspaces m on m.id = mm.matterspace_id
        join public.serverspace_members sm on sm.serverspace_id = m.serverspace_id
       where (mm.user_id = p_viewer and sm.user_id = p_subject)
          or (mm.user_id = p_subject and sm.user_id = p_viewer)
    );
$$;

create or replace function public._profiles_select_check(p_profile_id uuid)
returns boolean
language plpgsql
stable
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  if v_uid = p_profile_id then return true; end if;
  return public._profiles_share_workspace(v_uid, p_profile_id);
end $$;

revoke all on function public._profiles_share_workspace(uuid, uuid) from public;
revoke all on function public._profiles_select_check(uuid) from public;
-- anon is granted too, deliberately: without it a signed-out request to
-- /rest/v1/profiles fails with 42501 "permission denied for function" instead
-- of returning the empty list the policy intends.
grant execute on function public._profiles_share_workspace(uuid, uuid)
  to anon, authenticated, service_role;
grant execute on function public._profiles_select_check(uuid)
  to anon, authenticated, service_role;

drop policy if exists "Profiles are viewable by everyone" on public.profiles;
drop policy if exists "Users read own profile" on public.profiles;
drop policy if exists "Co-workers read each other's profiles" on public.profiles;

-- Own row: the fast path, and the one the app reads on every page load for
-- pricing_tier. No function call, no membership lookup.
create policy "Users read own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Co-workers read each other's profiles"
  on public.profiles for select
  using (public._profiles_select_check(id));


-- ============================================================================
-- 4. The one read that is NOT a co-worker read: invite by email.
--
-- ShareModal turns a typed email into a user id before inserting the
-- membership row — by definition the person is not yet a co-member, so the
-- policies above cannot serve it. This replaces that lookup with the
-- narrowest possible disclosure: an exact-match, one-row probe that answers
-- "does an account exist for this address" and returns no email of its own.
-- It cannot be used to enumerate (no LIKE, no listing) and it tells the
-- caller nothing they did not already type.
--
-- SECURITY DEFINER is correct here and does NOT contradict
-- feedback_rls_security_invoker_wrappers: that rule is about functions called
-- from a policy USING/WITH CHECK expression. This one is an RPC.
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
      from public.profiles p
     where lower(p.email) = lower(btrim(p_email))
     limit 1;
end $$;

revoke all on function public.find_profile_by_email(text) from public;
grant execute on function public.find_profile_by_email(text)
  to authenticated, service_role;


-- Drop PostgREST's cached prepared statements so the new policies, grants and
-- functions take effect on the next request (022 does the same).
notify pgrst, 'reload schema';
