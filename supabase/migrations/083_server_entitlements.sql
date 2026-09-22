-- Context.ai Migration 083: hidden also means LOCKED — the database half
--
-- What this is for
-- ---------------------------------------------------------------------------
-- 062 made `profiles.pricing_tier` mean something and stopped a user writing
-- their own. What it did NOT do is refuse anybody anything: the tier decided
-- what the BUNDLE drew, and every table and endpoint underneath stayed open to
-- any signed-in account. Three of the frozen modules — Moot Bench, Agents, the
-- Student Hub — have no endpoint of their own at all. They talk to /api/llm,
-- which cannot be gated on the feature label the browser sends, because a
-- label in a request body is a thing anyone can type.
--
-- So the lock for those goes where the browser cannot reach it: the INSERT
-- that STARTS the work. A non-entitled account may not open a Moot Bench
-- session, write an agent charter, or add a Student Hub text, session or
-- group. With no row, there is nothing for /api/llm to be pointed at.
--
-- What it deliberately does NOT do
-- ---------------------------------------------------------------------------
--   * It does not touch `profiles` — not a policy, not the check constraint,
--     not a grant. 062 owns the plan column and 067 owns the vocabulary
--     ('basic'), and this file only ever READS pricing_tier.
--   * It does not touch SELECT, UPDATE or DELETE on any table. Nobody loses
--     access to work they have already done: a row that exists stays readable,
--     editable and deletable by its owner exactly as before. The gate is on
--     BEGINNING something new, which is the only thing a plan can honestly
--     decide.
--   * It cannot shut `workshop` out of anything: plan_can_open() answers true
--     for that tier before it looks at the surface, and the service role
--     bypasses RLS entirely.
--
-- Shape of the lock: RESTRICTIVE policies
-- ---------------------------------------------------------------------------
-- Each fenced table already has a permissive INSERT policy from its own
-- migration ("owner_id = auth.uid()", and for agent_charters a matter-
-- membership clause as well). This file does not rewrite those. A RESTRICTIVE
-- policy is ANDed with whatever permissive policies exist, so the original
-- rule keeps working, drift in prod cannot be flattened by a copy of a
-- predicate that is out of date here, and re-running this file is a no-op.
--
-- Postgres house rule (feedback_rls_security_invoker_wrappers, migration 022)
-- ---------------------------------------------------------------------------
-- A function called from a policy expression must be SECURITY INVOKER plpgsql
-- that captures auth.uid() into its own declared variable at entry. A
-- SECURITY DEFINER + STABLE SQL function called from a WITH CHECK returns
-- inconsistent auth.uid() in this project, and the visible symptom is an
-- INSERT … RETURNING failing with 42501 for a user who is perfectly entitled —
-- the serverspace bug of 2026-08-13. plan_can_open is therefore INVOKER
-- plpgsql, and it reads only `profiles`, which the caller can already read for
-- themselves under 062's "Users read own profile". Nothing recurses: no policy
-- on profiles calls this function.
--
-- Idempotent throughout: create-or-replace, drop-policy-if-exists,
-- create-table/index-if-not-exists, and every policy block is skipped where
-- the table does not exist in this database (the live schema is known to drift
-- from this folder — see 047 and 062). Running it twice changes nothing.
--
-- Apply order: any time after 062. RECOMMENDED BEFORE the code deploys —
-- lib/entitlements.mjs reads `profiles` directly and calls nothing in this
-- file, so there is no dependency in either direction, and pasting first means
-- the hole is shut at the moment of the merge rather than after it.


-- ============================================================================
-- 1. plan_can_open(surface) — "may the caller open this room?"
--
-- The answer is the same one src/lib/plan.ts and lib/entitlements.mjs give,
-- and scripts/_verify-entitlements.mjs proves it by comparing this function's
-- answer with canOpenSurfaceId() from lib/surfaces.mjs for every surface
-- against every tier. The core list below is transcribed from that table; the
-- day it drifts, CI goes red rather than a room going quietly open.
--
--   workshop          → true for everything (Eden's own account)
--   a core surface    → true for every plan, including an unknown one
--   anything else     → false unless workshop
--   signed out        → false
--   a surface name    → false. A policy asking about a room that does not
--   nobody knows        exist must not open it.
-- ============================================================================
create or replace function public.plan_can_open(p_surface text)
returns boolean
language plpgsql
stable
security invoker
as $$
declare
  -- Captured at entry, per the house rule above. Never read auth.uid() twice.
  v_uid  uuid := auth.uid();
  v_tier text;
  -- The `core` tier of lib/surfaces.mjs, verbatim. The markers are not
  -- decoration: scripts/_verify-entitlements.mjs reads the ids between them
  -- and fails the build if this list and the shared table have drifted.
  v_core text[] := array[
    -- 083-CORE-LIST-BEGIN
    'vault', 'serverspaces', 'calendar', 'bucketizer', 'discovery', 'reader',
    'connections', 'settings', 'suite', 'matterPages', 'fileSaver'
    -- 083-CORE-LIST-END
  ];
  -- Every surface the table knows. An id outside this list is a typo or a
  -- room that has not been declared, and either way the answer is no.
  v_known text[] := v_core || array[
    -- 083-NONCORE-LIST-BEGIN
    'office', 'agents', 'mootBench', 'mediation', 'connect', 'docBuilder',
    'editor', 'studentHub'
    -- 083-NONCORE-LIST-END
  ];
begin
  if v_uid is null then return false; end if;
  if p_surface is null or not (p_surface = any (v_known)) then return false; end if;

  select p.pricing_tier into v_tier from public.profiles p where p.id = v_uid;
  v_tier := coalesce(nullif(btrim(coalesce(v_tier, '')), ''), 'free');

  if v_tier = 'workshop' then return true; end if;
  return p_surface = any (v_core);
end $$;

revoke all on function public.plan_can_open(text) from public;
-- anon is granted deliberately, the same way 062 grants _profiles_select_check
-- to anon: without it a signed-out request fails with 42501 "permission denied
-- for function" instead of the plain refusal the policy intends.
grant execute on function public.plan_can_open(text) to anon, authenticated, service_role;


-- ============================================================================
-- 2. The fences. One RESTRICTIVE INSERT policy per table that a frozen or
--    beta module must write to in order to BEGIN work.
--
--    argument_prep_sessions   Moot Bench          (034)
--    agent_charters           Agents              (052)
--    student_hub_texts        Student Hub         (039)
--    student_hub_sessions     Student Hub         (037)
--    student_hub_groups       Student Hub         (041)
--
--    `to authenticated` is the role PostgREST switches into for any anon-key
--    request carrying a user JWT. The service role holds BYPASSRLS, so the
--    worker and every server-side admin client are untouched by all of this.
-- ============================================================================
do $$
declare
  t record;
begin
  for t in
    select * from (values
      -- 083-FENCE-BEGIN  (table, surface) — read by scripts/_verify-entitlements.mjs
      ('argument_prep_sessions', 'mootBench'),
      ('agent_charters',         'agents'),
      ('student_hub_texts',      'studentHub'),
      ('student_hub_sessions',   'studentHub'),
      ('student_hub_groups',     'studentHub')
      -- 083-FENCE-END
    ) as v(tbl, surface)
  loop
    if to_regclass('public.' || quote_ident(t.tbl)) is null then
      raise notice '083: public.% is not in this database — fence skipped', t.tbl;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t.tbl);
    execute format('drop policy if exists "plan_gate_insert" on public.%I', t.tbl);
    execute format(
      'create policy "plan_gate_insert" on public.%I'
      || ' as restrictive for insert to authenticated'
      || ' with check (public.plan_can_open(%L))',
      t.tbl, t.surface);
  end loop;
end $$;


-- ============================================================================
-- 3. Student Hub invitations: a counted cap, so an unclaimed seat cannot be
--    re-mailed forever.
--
-- api/student-hub-invite.mjs would send a Resend email every time it was
-- called, for as long as the seat stayed unclaimed: the owner check and the
-- seat check both pass every time, so one seat was an unmetered, un-rate-
-- limited mail button pointed at an address of the caller's choosing.
--
-- The cap is deterministic and lives here rather than in the handler, because
-- Vercel has no shared memory: two requests on two instances would both read
-- "none sent yet". One row per send, counted inside one transaction.
-- ============================================================================
create table if not exists public.student_hub_invite_sends (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid        not null,
  email      text        not null,
  sent_by    uuid        not null,
  sent_at    timestamptz not null default now()
);

create index if not exists student_hub_invite_sends_seat_idx
  on public.student_hub_invite_sends (group_id, email, sent_at desc);
create index if not exists student_hub_invite_sends_sender_idx
  on public.student_hub_invite_sends (sent_by, sent_at desc);

alter table public.student_hub_invite_sends enable row level security;
-- No policies at all, on purpose: this is the server's own counter. With RLS
-- on and nothing permissive, `anon` and `authenticated` see and write nothing,
-- and the revoke below survives the blanket
-- `grant all on all tables in schema public to authenticated` that Supabase's
-- bootstrap and every "fix the permissions" paste re-applies.
revoke all on public.student_hub_invite_sends from anon, authenticated;
grant all on public.student_hub_invite_sends to service_role;

-- ---------------------------------------------------------------------------
-- student_hub_invite_charge — count, decide, and record, in one transaction.
--
-- Returns jsonb shaped like usage_consume's answer so the handler can treat a
-- refusal the same way it treats a spend refusal:
--   { allowed: true }
--   { allowed: false, reason, status, message, retry_after_seconds }
--
-- Two ceilings, both rolling 24 hours:
--   3 per seat   — an invitation can be lost or mistyped; it cannot need a
--                  fourth send in one day.
--  20 per owner  — a group holds six people (GROUP_CAP), so twenty is several
--                  groups' worth of honest use and nothing like a mail relay.
--
-- The row is written BEFORE the mail goes out (the handler charges first), so
-- a Resend failure does consume one of the three. That is the safe direction:
-- the other one lets a slow or failing provider be retried without limit.
--
-- SECURITY DEFINER and service_role only. Granted to `authenticated` this
-- would let a browser write its own send history.
-- ---------------------------------------------------------------------------
create or replace function public.student_hub_invite_charge(
  p_group  uuid,
  p_email  text,
  p_sender uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c_seat_cap  constant integer := 3;
  c_owner_cap constant integer := 20;
  v_email     text := lower(btrim(coalesce(p_email, '')));
  v_since     timestamptz := now() - interval '24 hours';
  v_count     integer;
  v_oldest    timestamptz;
  v_retry     integer;
begin
  if p_group is null or p_sender is null or v_email = '' then
    return jsonb_build_object(
      'allowed', false, 'reason', 'bad_request', 'status', 400,
      'message', 'An invitation needs a group and an address.');
  end if;

  select count(*), min(s.sent_at) into v_count, v_oldest
    from public.student_hub_invite_sends s
   where s.group_id = p_group and lower(s.email) = v_email and s.sent_at >= v_since;

  if v_count >= c_seat_cap then
    v_retry := greatest(1, ceil(extract(epoch from (v_oldest + interval '24 hours' - now())))::integer);
    return jsonb_build_object(
      'allowed', false, 'reason', 'invite_seat_cap', 'status', 429,
      'message', 'That seat has already been sent its invitation three times today. '
                 || 'Try again tomorrow, or ask them to check their spam folder.',
      'retry_after_seconds', v_retry);
  end if;

  select count(*), min(s.sent_at) into v_count, v_oldest
    from public.student_hub_invite_sends s
   where s.sent_by = p_sender and s.sent_at >= v_since;

  if v_count >= c_owner_cap then
    v_retry := greatest(1, ceil(extract(epoch from (v_oldest + interval '24 hours' - now())))::integer);
    return jsonb_build_object(
      'allowed', false, 'reason', 'invite_daily_cap', 'status', 429,
      'message', 'You have sent as many study-group invitations as Contextspaces allows '
                 || 'in a day. Try again tomorrow.',
      'retry_after_seconds', v_retry);
  end if;

  insert into public.student_hub_invite_sends (group_id, email, sent_by)
  values (p_group, v_email, p_sender);

  return jsonb_build_object('allowed', true, 'reason', 'ok', 'status', 200);
end $$;

revoke all on function public.student_hub_invite_charge(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.student_hub_invite_charge(uuid, text, uuid)
  to service_role;


-- Drop PostgREST's cached prepared statements so the new function and policies
-- take effect on the next request (022, 062 and 063 all end the same way).
notify pgrst, 'reload schema';
