-- Contextspaces Migration 089: a task can go to ANY connected AI, and the
-- Agents page is a core surface.
--
-- NOT APPLIED BY THE PR THAT ADDS IT. Eden pastes it into the SQL editor after
-- the PR merges. Apply order: after 083, 085 and 087 (088 is not needed).
-- Idempotent: the file can be pasted twice and converges to the same state.
--
-- WHY
-- ---------------------------------------------------------------------------
-- Eden (2026-09-25): "My idea was to have an agents tab and then route it
-- wherever you want: Claude, GPT, Gemini, Grok Bot, custom agent etc. I don't
-- want tasks limited to one Grok Bot." Until now (085) a task could only be
-- assigned to a connector_tokens row of kind 'agent'. An AI can also arrive
--   (a) on a full-access connector token (kind 'user': Claude Desktop, the
--       Gemini CLI, anything given a pasted csp_ token), or
--   (b) on an OAuth sign-in that is NOT linked to an agent (oauth_grants with
--       agent_token_id null: Claude, ChatGPT, Grok connected "as a full
--       assistant").
-- This file lets a task be assigned to either of those as well.
--
-- WHAT THIS CHANGES
-- ---------------------------------------------------------------------------
--   1. agent_tasks.assigned_grant_id uuid null → oauth_grants(id), ON DELETE
--      RESTRICT (a grant is revoked, never deleted, so the history survives —
--      the same rule 085 set for tokens).
--   2. agent_tasks.assigned_token_id loses NOT NULL. It still references
--      connector_tokens; it may now name a token of ANY kind.
--   3. A check: exactly one of assigned_token_id / assigned_grant_id is set.
--      Every existing row has a token and no grant, so every existing row
--      passes; nothing is rewritten.
--   4. An index on (assigned_grant_id, status) for "this assistant's tasks".
--   5. A new access wrapper, _agent_task_recipient_is_mine(token, grant):
--      true when the token (any kind) or the OAuth grant belongs to the
--      caller. A grant that is linked to an agent (087) does not count: that
--      connection signs in AS its agent token, so a task for it is assigned to
--      the token, never the grant (otherwise it would sit where nothing polls).
--      SECURITY INVOKER plpgsql, auth.uid() captured once at entry — the
--      078/085 pattern; no policy calls a SECURITY DEFINER function directly.
--   6. agent_tasks' INSERT and UPDATE policies are re-created with that
--      wrapper in place of 085's _agent_token_is_mine. The rule is otherwise
--      085's, unchanged: OWNER ONLY (Eden, 2026-09-25). A person may create or
--      update a task only in a matter they can open AND only for a connection
--      of their own; a co-counsel on a shared matter still reads, and cannot
--      put instructions in front of somebody else's AI. SELECT is untouched.
--   7. agent_task_events.actor_grant_id uuid null → oauth_grants(id), ON
--      DELETE SET NULL: which OAuth assistant made a log entry (the token
--      column 085 added covers tokens of both kinds).
--   8. plan_can_open (083) is re-created with one more CORE surface,
--      'agentTasks' — the new Agents page. Its body is 083's line for line;
--      only the core list grows. lib/surfaces.mjs and this list are compared
--      by scripts/_verify-entitlements.mjs, which reads the newest migration
--      that carries the marker comments. The frozen 'agents' surface (the
--      in-app agent-charters workshop) is NOT changed or renamed.
--
-- NOT CHANGED
-- ---------------------------------------------------------------------------
--   * 085's _agent_token_is_mine stays (nothing uses it after this file; it
--     is left so a rollback has it to go back to).
--   * No grant changes: 085 granted agent_tasks and agent_task_events at the
--     table level, so the new columns are covered; oauth_grants has had a
--     table-level SELECT grant since 065; 086's connector_tokens column list
--     already includes id, user_id and kind, which is all the wrapper reads.
--   * The seal and the AI pause are enforced in /api/mcp, as before: a task in
--     a sealed or paused matter is invisible to every recipient.
--
-- ROLLBACK (only while no task is assigned to a grant — the SET NOT NULL
-- below fails otherwise; cancel those first and re-point or delete them as
-- the service role):
--   drop policy if exists agent_tasks_insert on public.agent_tasks;
--   create policy agent_tasks_insert on public.agent_tasks for insert to authenticated
--     with check (created_by = auth.uid()
--       and public._agent_task_matter_access(matterspace_id)
--       and public._agent_token_is_mine(assigned_token_id));
--   drop policy if exists agent_tasks_update on public.agent_tasks;
--   create policy agent_tasks_update on public.agent_tasks for update to authenticated
--     using (public._agent_task_matter_access(matterspace_id)
--       and public._agent_token_is_mine(assigned_token_id))
--     with check (public._agent_task_matter_access(matterspace_id)
--       and public._agent_token_is_mine(assigned_token_id));
--   drop function if exists public._agent_task_recipient_is_mine(uuid, uuid);
--   alter table public.agent_task_events drop column if exists actor_grant_id;
--   alter table public.agent_tasks drop constraint if exists agent_tasks_one_recipient_chk;
--   drop index if exists public.idx_agent_tasks_grant_status;
--   alter table public.agent_tasks drop column if exists assigned_grant_id;
--   alter table public.agent_tasks alter column assigned_token_id set not null;
--   -- and re-run section 1 of 083_server_entitlements.sql (plan_can_open
--   -- without 'agentTasks'), after taking 'agentTasks' out of lib/surfaces.mjs.
--
-- Verified by EXECUTION in PGlite with the real migration chain and real RLS:
--   node scripts/_verify-tasks-any-recipient.mjs


-- ============================================================================
-- 1–4. agent_tasks: a second kind of recipient
-- ============================================================================

alter table public.agent_tasks
  add column if not exists assigned_grant_id uuid
  references public.oauth_grants(id) on delete restrict;

alter table public.agent_tasks
  alter column assigned_token_id drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'agent_tasks_one_recipient_chk'
       and conrelid = 'public.agent_tasks'::regclass
  ) then
    alter table public.agent_tasks
      add constraint agent_tasks_one_recipient_chk
      check (num_nonnulls(assigned_token_id, assigned_grant_id) = 1);
  end if;
end $$;

create index if not exists idx_agent_tasks_grant_status
  on public.agent_tasks(assigned_grant_id, status)
  where assigned_grant_id is not null;

comment on column public.agent_tasks.assigned_grant_id is
  'The OAuth assistant (oauth_grants, not linked to an agent) this task is for. '
  'Exactly one of assigned_token_id / assigned_grant_id is set. Migration 089.';


-- ============================================================================
-- 5. The access wrapper (SECURITY INVOKER, auth.uid() captured once)
-- ============================================================================

-- Is this recipient one of the caller's own connections? A token of any kind,
-- or an OAuth grant that is not an agent's sign-in. Exactly one argument is
-- expected; both or neither is "no".
create or replace function public._agent_task_recipient_is_mine(p_token uuid, p_grant uuid)
returns boolean
language plpgsql
security invoker
stable
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  if p_token is not null and p_grant is null then
    return exists (
      select 1 from public.connector_tokens ct
       where ct.id = p_token
         and ct.user_id = v_uid
    );
  end if;
  if p_grant is not null and p_token is null then
    return exists (
      select 1 from public.oauth_grants g
       where g.id = p_grant
         and g.user_id = v_uid
         and g.agent_token_id is null
    );
  end if;
  return false;
end;
$$;

grant execute on function public._agent_task_recipient_is_mine(uuid, uuid)
  to authenticated, service_role;


-- ============================================================================
-- 6. agent_tasks policies: owner-only, any recipient
-- ============================================================================

drop policy if exists agent_tasks_insert on public.agent_tasks;
create policy agent_tasks_insert on public.agent_tasks
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and public._agent_task_matter_access(matterspace_id)
    and public._agent_task_recipient_is_mine(assigned_token_id, assigned_grant_id)
  );

drop policy if exists agent_tasks_update on public.agent_tasks;
create policy agent_tasks_update on public.agent_tasks
  for update to authenticated
  using (
    public._agent_task_matter_access(matterspace_id)
    and public._agent_task_recipient_is_mine(assigned_token_id, assigned_grant_id)
  )
  with check (
    public._agent_task_matter_access(matterspace_id)
    and public._agent_task_recipient_is_mine(assigned_token_id, assigned_grant_id)
  );


-- ============================================================================
-- 7. agent_task_events: which OAuth assistant wrote the entry
-- ============================================================================

alter table public.agent_task_events
  add column if not exists actor_grant_id uuid
  references public.oauth_grants(id) on delete set null;


-- ============================================================================
-- 8. plan_can_open: the Agents page ('agentTasks') is core
-- ============================================================================
-- 083's function, line for line, with 'agentTasks' added to the core list.
-- The markers are read by scripts/_verify-entitlements.mjs.
create or replace function public.plan_can_open(p_surface text)
returns boolean
language plpgsql
stable
security invoker
as $$
declare
  v_uid  uuid := auth.uid();
  v_tier text;
  v_core text[] := array[
    -- 089-CORE-LIST-BEGIN
    'vault', 'serverspaces', 'calendar', 'bucketizer', 'discovery', 'reader',
    'connections', 'settings', 'suite', 'matterPages', 'fileSaver', 'agentTasks'
    -- 089-CORE-LIST-END
  ];
  v_known text[] := v_core || array[
    -- 089-NONCORE-LIST-BEGIN
    'office', 'agents', 'mootBench', 'mediation', 'connect', 'docBuilder',
    'editor', 'studentHub'
    -- 089-NONCORE-LIST-END
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
grant execute on function public.plan_can_open(text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
