-- Contextspaces Migration 085: agent connections and the task board.
--
-- WHAT THIS ADDS
-- ---------------------------------------------------------------------------
-- An external agent (a Grok Bot first; any MCP-capable agent) connects to the
-- hosted MCP server with a csp_ token like every other connector. What is new
-- is a second KIND of token: an agent token sees only the matters it has been
-- granted, and it works a task board that it polls (Grok Bots can only call
-- out, so nothing can push work to them).
--
--   1. connector_tokens gains three columns:
--        kind           'user' (every existing row, by default) or 'agent'
--        agent_provider display only: 'grok' | 'chatgpt' | 'claude' |
--                       'gemini' | 'other'
--        matter_scope   for an agent: the matters granted. Each grant covers
--                       that matter's sub-matters. '{}' = nothing granted,
--                       which is the default a new agent starts with.
--                       Ignored (and left null) for kind='user'.
--   2. agent_tasks — one row per delegated task (who asked, which agent,
--      what to do, what came back).
--   3. agent_task_events — the append-only log of what the human and the
--      agent did on each task. The matter's record of the agent's work.
--
-- PRIVILEGE DEFAULT IS OFF, AND IT IS ENFORCED OUTSIDE THIS FILE
-- ---------------------------------------------------------------------------
-- This migration only stores the grant. The enforcement is in /api/mcp
-- (lib/mcp-core.mjs, dispatchWithSeal): an agent token reaches no matter that
-- is not in matter_scope or under one that is, and never a sealed matter
-- (SecureSpace tier B/C), even a granted one. The REST endpoints under
-- /api/ext refuse agent tokens outright (lib/connector-token-auth.mjs).
--
-- ADDITIVE ONLY
-- ---------------------------------------------------------------------------
-- New columns with defaults, two new tables, new policies on the new tables.
-- No existing row is rewritten: every existing connector_tokens row reads
-- kind='user', matter_scope=null, and behaves exactly as it did.
--
-- RLS
-- ---------------------------------------------------------------------------
-- The access question ("can this user see this matter?") goes through a
-- SECURITY INVOKER plpgsql wrapper that captures auth.uid() at entry and
-- delegates to _mtspc_select_check (022) — the same shape as 036's
-- _bktz_matter_access and 064's _ledger_visible. No policy here calls a
-- SECURITY DEFINER helper directly (feedback: rls-security-invoker-wrappers;
-- see the 078 header).
--
--   agent_tasks
--     select  anyone who can access the task's matter
--     insert  can access the matter, created_by = auth.uid(), AND the
--             assigned token is one of the caller's OWN agent tokens
--     update  can access the matter AND the assigned token is the caller's
--             own (both before and after the change)
--     delete  none — a task is cancelled, never deleted
--
--   The "own agent token" rule is tighter than "anyone in the matter", on
--   purpose: without it, anyone with access to a shared matter could put
--   instructions in front of someone else's agent. connector_tokens' own RLS
--   (003) already limits the subquery to the caller's rows; the policy says
--   user_id = auth.uid() as well so it does not depend on that.
--
--   agent_task_events
--     select  anyone who can access the task's matter
--     insert  can access the task's matter, and actor_user = auth.uid()
--     update / delete  none — append-only
--
-- DELETING A TOKEN
-- ---------------------------------------------------------------------------
-- agent_tasks.assigned_token_id is ON DELETE RESTRICT: a token that has tasks
-- cannot be hard-deleted (003's delete policy would otherwise allow it).
-- Revoking sets connector_tokens.revoked_at and keeps the history; the
-- interface must revoke agent tokens, not delete them.
--
-- Idempotent against drift: `add column if not exists`, `create table if not
-- exists`, constraints added in DO blocks, every policy dropped first.
-- Applying it twice leaves the same objects.
--
-- ROLLBACK (nothing else depends on these objects):
--   drop table if exists public.agent_task_events;
--   drop table if exists public.agent_tasks;
--   drop function if exists public._agent_task_matter_access(uuid);
--   drop function if exists public._agent_token_is_mine(uuid);
--   alter table public.connector_tokens
--     drop constraint if exists connector_tokens_agent_scope_chk,
--     drop constraint if exists connector_tokens_kind_chk,
--     drop constraint if exists connector_tokens_agent_provider_chk,
--     drop column if exists matter_scope,
--     drop column if exists agent_provider,
--     drop column if exists kind;
--
-- Verified by EXECUTION in PGlite with the real migration chain and real RLS:
--   node scripts/_verify-agent-tasks-rls.mjs
--
-- Deleting a PROFILE that created tasks is likewise blocked (created_by has no
-- cascade, and the token cascade meets the restrict above). There is no
-- account-deletion flow in the product today; if one is added, it must cancel
-- and archive the account's tasks first.
--
-- Apply order: after 001, 003 and 022. NOT APPLIED until Eden approves.

-- ============================================================================
-- 1. connector_tokens: kind, agent_provider, matter_scope
-- ============================================================================

alter table public.connector_tokens
  add column if not exists kind text not null default 'user';

alter table public.connector_tokens
  add column if not exists agent_provider text;

alter table public.connector_tokens
  add column if not exists matter_scope uuid[];

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'connector_tokens_kind_chk'
       and conrelid = 'public.connector_tokens'::regclass
  ) then
    alter table public.connector_tokens
      add constraint connector_tokens_kind_chk check (kind in ('user', 'agent'));
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'connector_tokens_agent_provider_chk'
       and conrelid = 'public.connector_tokens'::regclass
  ) then
    alter table public.connector_tokens
      add constraint connector_tokens_agent_provider_chk
      check (agent_provider is null
             or agent_provider in ('grok', 'chatgpt', 'claude', 'gemini', 'other'));
  end if;

  -- An agent always carries an explicit grant list, even an empty one. A null
  -- scope on an agent would be ambiguous; '{}' is unambiguous: nothing.
  if not exists (
    select 1 from pg_constraint
     where conname = 'connector_tokens_agent_scope_chk'
       and conrelid = 'public.connector_tokens'::regclass
  ) then
    alter table public.connector_tokens
      add constraint connector_tokens_agent_scope_chk
      check (kind <> 'agent' or matter_scope is not null);
  end if;
end $$;

-- "My agents" in the Connections page, without scanning user tokens.
create index if not exists idx_connector_tokens_user_agents
  on public.connector_tokens(user_id)
  where kind = 'agent';


-- ============================================================================
-- 2. Access wrappers (SECURITY INVOKER, auth.uid() captured once)
-- ============================================================================

-- Can the caller see this matter? Same body as 036's _bktz_matter_access,
-- under a name that says what it is for.
create or replace function public._agent_task_matter_access(p_matter uuid)
returns boolean
language plpgsql
security invoker
stable
as $$
declare
  v_uid uuid := auth.uid();
  v_ss uuid;
  v_parent uuid;
begin
  if v_uid is null or p_matter is null then return false; end if;
  select serverspace_id, parent_matterspace_id
    into v_ss, v_parent
    from public.matterspaces where id = p_matter;
  if v_ss is null then return false; end if;
  return public._mtspc_select_check(p_matter, v_ss, v_parent);
end;
$$;

grant execute on function public._agent_task_matter_access(uuid)
  to authenticated, service_role;

-- Is this token one of the caller's own AGENT tokens?
create or replace function public._agent_token_is_mine(p_token uuid)
returns boolean
language plpgsql
security invoker
stable
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_token is null then return false; end if;
  return exists (
    select 1 from public.connector_tokens ct
     where ct.id = p_token
       and ct.user_id = v_uid
       and ct.kind = 'agent'
  );
end;
$$;

grant execute on function public._agent_token_is_mine(uuid)
  to authenticated, service_role;


-- ============================================================================
-- 3. agent_tasks
-- ============================================================================

create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  created_by uuid not null references public.profiles(id),
  assigned_token_id uuid not null references public.connector_tokens(id) on delete restrict,
  title text not null check (length(trim(title)) > 0 and length(title) <= 500),
  instructions text not null default '' check (length(instructions) <= 20000),
  -- [{kind:'document'|'content_item'|'calendar_event', id:uuid, label?:string}]
  attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),
  due_at timestamptz,
  status text not null default 'open'
    check (status in ('open', 'claimed', 'needs_input', 'done', 'failed', 'cancelled')),
  -- The ask_human round trip; the latest question and its answer.
  question text,
  answer text,
  result text,
  -- Same shape as attachments: what the agent filed or points to.
  result_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(result_refs) = 'array'),
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_agent_tasks_token_status
  on public.agent_tasks(assigned_token_id, status);
create index if not exists idx_agent_tasks_matter_created
  on public.agent_tasks(matterspace_id, created_at desc);

drop trigger if exists update_agent_tasks_updated_at on public.agent_tasks;
create trigger update_agent_tasks_updated_at
  before update on public.agent_tasks
  for each row execute function public.update_updated_at();

alter table public.agent_tasks enable row level security;

drop policy if exists agent_tasks_select on public.agent_tasks;
create policy agent_tasks_select on public.agent_tasks
  for select to authenticated
  using (public._agent_task_matter_access(matterspace_id));

drop policy if exists agent_tasks_insert on public.agent_tasks;
create policy agent_tasks_insert on public.agent_tasks
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and public._agent_task_matter_access(matterspace_id)
    and public._agent_token_is_mine(assigned_token_id)
  );

drop policy if exists agent_tasks_update on public.agent_tasks;
create policy agent_tasks_update on public.agent_tasks
  for update to authenticated
  using (
    public._agent_task_matter_access(matterspace_id)
    and public._agent_token_is_mine(assigned_token_id)
  )
  with check (
    public._agent_task_matter_access(matterspace_id)
    and public._agent_token_is_mine(assigned_token_id)
  );

-- No delete policy: a task is cancelled (status = 'cancelled'), never removed.


-- ============================================================================
-- 4. agent_task_events (append-only)
-- ============================================================================

create table if not exists public.agent_task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  at timestamptz not null default now(),
  actor_kind text not null check (actor_kind in ('human', 'agent')),
  actor_user uuid references public.profiles(id) on delete set null,
  actor_token_id uuid references public.connector_tokens(id) on delete set null,
  kind text not null check (kind in (
    'created', 'claimed', 'asked', 'answered', 'result',
    'failed', 'cancelled', 'reassigned', 'note'
  )),
  body text check (body is null or length(body) <= 100000)
);

create index if not exists idx_agent_task_events_task_at
  on public.agent_task_events(task_id, at);

alter table public.agent_task_events enable row level security;

drop policy if exists agent_task_events_select on public.agent_task_events;
create policy agent_task_events_select on public.agent_task_events
  for select to authenticated
  using (
    exists (
      select 1 from public.agent_tasks t
       where t.id = agent_task_events.task_id
         and public._agent_task_matter_access(t.matterspace_id)
    )
  );

drop policy if exists agent_task_events_insert on public.agent_task_events;
create policy agent_task_events_insert on public.agent_task_events
  for insert to authenticated
  with check (
    actor_user = auth.uid()
    and exists (
      select 1 from public.agent_tasks t
       where t.id = agent_task_events.task_id
         and public._agent_task_matter_access(t.matterspace_id)
    )
  );

-- No update or delete policy, for anybody: the log is append-only.


-- ============================================================================
-- 5. Privileges — belt to the policies' braces
-- ============================================================================
-- Supabase grants every new public table to anon. Nothing here is for anon.
revoke all on public.agent_tasks from anon;
revoke all on public.agent_task_events from anon;
grant select, insert, update on public.agent_tasks to authenticated;
grant select, insert on public.agent_task_events to authenticated;
revoke update, delete on public.agent_task_events from authenticated;
revoke delete on public.agent_tasks from authenticated;
grant all on public.agent_tasks, public.agent_task_events to service_role;
