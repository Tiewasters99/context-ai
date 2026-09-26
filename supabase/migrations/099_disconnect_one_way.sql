-- 099_disconnect_one_way.sql — S2b: a disconnection is one-way, and the
-- Record says who reconnected
--
-- docs/specs/SECURITY-BUILD-2026-09-26.md §S2. 095 built "Disconnect
-- everything". The adversarial review of PR #246 found that it could be
-- undone by the very people it is pressed against, and that the Record could
-- then say the owner had done it:
--
--   HIGH-1   A revoked or expired connector token came back with a plain
--            UPDATE (`set revoked_at = null`, `set expires_at = null`): 003's
--            policy "Users can update their own connector tokens" has no
--            column limit and no guard, and kind / matter_scope / scope_all /
--            user_id / token_hash were writable too.
--   HIGH-2   An OAuth client connected before 065 has no grant row, so the
--            press could not revoke it; its next refresh "adopted" it into a
--            new live grant, and that INSERT wrote account.unlocked
--            {via:'assistant'} under the owner's name.
--   MEDIUM-3 An access token issued before the press (up to an hour) could
--            mint a csp_ token, resume AI or re-enable a charter, and each
--            wrote account.unlocked as the owner.
--
-- This file closes those at the database, where a browser cannot argue with
-- them. The code half (lib/oauth-grants.mjs, api/mcp.mjs, api/oauth-approve,
-- api/account-lockdown, api/ext/*) is in the same PR.
--
-- What this file adds
-- ---------------------------------------------------------------------------
--   1. Prerequisites, asserted (095, 088, 094, 070, 052).
--   2. public.account_connection_locks — one row per account that has ever
--      pressed "Disconnect everything": when (locked_at) and, once the owner
--      has deliberately reconnected something, when and from which sign-in
--      (unlocked_*). Seeded from the Record for accounts 095 already locked.
--   3. The session: who is asking, and when their sign-in was issued — the
--      JWT's `sub`, `iat` and `session_id` for a browser; for the OAuth
--      consent screen (which writes as the service role) a transaction-local
--      marker set by oauth_grant_approve_session() from the browser's own
--      verified sign-in.
--   4. The gate: while an account has a lock row, a NEW credential for it —
--      a connector token, an OAuth grant, an enabled charter, a widened
--      agent — and AI resumed by it, are refused unless they come from a
--      sign-in issued AFTER the lock, by the account itself. A refusal is an
--      error, so nothing is written, and no account.unlocked is written.
--   5. connector_tokens' UPDATE guard (the 065/087 shape): nothing
--      un-revokes, nothing un-expires, nothing changes owner, secret or kind.
--   6. disconnect_internal.run, redefined: stamps the lock; pauses only the
--      serverspaces the presser OWNS (not admins — see §6); needs a second
--      factor (aal2) for the account press when the account has one.
--   7. account.unlocked, redefined: written only for the account's own
--      post-lock sign-in, with its session_id and iat; it clears the lock.
--   8. oauth_grant_adopt refuses for any account that has ever been locked,
--      and oauth_grant_approve_session() carries the consent sign-in in.
--   9. Two service-role reads for the API: the lock of an account, and a
--      grant's state together with its owner's lock.
--
-- WHY A TABLE AND NOT profiles.connections_locked_at
-- ---------------------------------------------------------------------------
-- 001's "Users can update own profile" policy still exists on profiles (062
-- narrowed it with column grants and a trigger on pricing_tier alone), and
-- 062's own header says the column grants are one blanket
-- `grant … to authenticated` away from being undone. A lock that the person
-- it is pressed against can PATCH back to null is not a lock. This table has
-- RLS on, a SELECT policy for the owner's own row and NO insert, update or
-- delete policy for anybody — so even under a blanket grant, RLS refuses
-- every write from a browser. Only the DEFINER functions below write it.
--
-- WHAT "LOCKED" MEANS NOW
-- ---------------------------------------------------------------------------
-- locked_at is the floor. It is moved forward by every account press and is
-- never cleared: a sign-in issued at or before it (iat ≤ the lock's second)
-- can never again bring back a connection for that account. After an hour
-- every such sign-in has expired anyway, so the floor costs the owner
-- nothing. unlocked_at is null while the account is locked; the first
-- deliberate reconnection from a post-lock sign-in sets it (and writes
-- account.unlocked). While unlocked_at is null the API also refuses every
-- OAuth token without a grant id and re-reads grant state instead of
-- trusting its cache.
--
-- The comparison is in whole seconds, because iat is: a sign-in issued in the
-- same second as the lock is treated as before it. The presser's own tab is
-- such a sign-in; src/lib/disconnect-all.ts refreshes it a second after the
-- press, so the owner reconnects from a new token. The devices the press
-- signed out cannot refresh — that asymmetry is the point.
--
-- WHICH connector_tokens COLUMNS A BROWSER MAY STILL WRITE (§5)
-- ---------------------------------------------------------------------------
--   name           freely.
--   last_used_at   freely (the server stamps it; a browser forging its own
--                  "last used" deceives only itself).
--   revoked_at     null → set, once; the server stamps now(). Never back.
--   expires_at     earlier only (null → a date, or a date → an earlier one).
--   matter_scope,  on a LIVE agent row only, and only through the gate:
--   scope_all      Connections › Agents › Edit matters is a real browser
--                  path (src/lib/agentTokens.ts updateAgentScope), and
--                  widening an agent to "all my matters" is a new grant of
--                  access, so it is gated exactly as a new token is. On a
--                  revoked or expired row they are frozen.
--   everything     refused: user_id, token_hash, kind, token_prefix,
--   else           agent_provider, scopes, created_at, id — and any column a
--                  later migration adds, until it is named here.
-- The service role, postgres and supabase_admin pass, as 065/087's guard lets
-- them: the definer functions (095's sweep, 087's consent) are the writers.
--
-- ROLLBACK (in this order):
--   drop trigger if exists connector_tokens_guard_update on public.connector_tokens;
--   drop trigger if exists connector_tokens_gate_insert on public.connector_tokens;
--   drop trigger if exists oauth_grants_gate_insert on public.oauth_grants;
--   drop trigger if exists agent_charters_gate_enable on public.agent_charters;
--   drop trigger if exists matterspaces_gate_resume on public.matterspaces;
--   drop function if exists public.connector_tokens_guard_update();
--   drop function if exists public.oauth_grant_approve_session(jsonb, uuid, text, text, text[], text, text, text, uuid[], text, boolean);
--   drop function if exists public.oauth_grant_lock_state(uuid);
--   drop function if exists public.account_connections_lock_state(uuid);
--   -- then re-paste 065 §4b (oauth_grant_adopt) and 095 §2 and §4 (run and
--   -- the unlock writers), and last:
--   drop table if exists public.account_connection_locks;
--   -- Rolling back re-opens HIGH-1/2 and MEDIUM-3. What a press revoked
--   -- stays revoked; the Record rows are append-only and stay.
--
-- Apply order: after 095 (and so after 088, 094). 097 and 098 are
-- independent of this file. Re-runnable: scripts/_verify-disconnect-one-way.mjs
-- executes it twice.
--
-- ⚠ After pasting this file, run:  notify pgrst, 'reload schema';
--   (it is the last statement here.)


-- ============================================================================
-- 1. Prerequisites
-- ============================================================================
do $migration$
declare
  v_missing text[] := '{}';
  v_fn text;
begin
  foreach v_fn in array array[
    'disconnect_internal.run(text,uuid,boolean)',                                  -- 095
    'disconnect_internal.note_unlocked(uuid,text,uuid)',                           -- 095
    'public.oauth_grant_approve(uuid,text,text,text[],text,text,text,uuid[],text,boolean)', -- 088
    'public.oauth_grant_adopt(uuid,text,text,text[],text)',                        -- 065
    'public.oauth_grant_hash(text)',                                               -- 065
    'stepup_internal.has_verified_factor(uuid)', 'public.auth_is_aal2()',          -- 094
    'public._ai_pause_write(uuid,boolean,text,uuid,text)',                         -- 070
    'public._ledger_write_scoped(text,uuid,uuid,uuid,text,text,text,jsonb,uuid,uuid)' -- 072
  ] loop
    if to_regprocedure(v_fn) is null then
      v_missing := v_missing || v_fn;
    end if;
  end loop;
  if to_regclass('public.agent_charters') is null then
    v_missing := v_missing || 'public.agent_charters (052)'::text;
  end if;
  if cardinality(v_missing) > 0 then
    raise exception '099 needs these first: %', array_to_string(v_missing, ', ')
      using hint = 'Paste 088, 094 and 095 (see this file''s header), then this file again.';
  end if;
end $migration$;


-- ============================================================================
-- 2. The lock
-- ============================================================================
create table if not exists public.account_connection_locks (
  user_id             uuid primary key references public.profiles(id) on delete cascade,
  locked_at           timestamptz not null,
  unlocked_at         timestamptz,
  unlocked_session_id text,
  unlocked_iat        bigint
);

comment on table public.account_connection_locks is
  'One row per account that has pressed "Disconnect everything" (migrations 095/099). '
  'locked_at is a floor: a sign-in issued at or before it can never bring a connection '
  'back. unlocked_at is null while the account is locked. Written only by '
  'disconnect_internal functions; browsers may read their own row and nothing else.';

alter table public.account_connection_locks enable row level security;

drop policy if exists "Users read their own connection lock" on public.account_connection_locks;
create policy "Users read their own connection lock"
  on public.account_connection_locks for select
  using (user_id = auth.uid());

revoke all on public.account_connection_locks from public, anon, authenticated;
grant select on public.account_connection_locks to authenticated;
grant all on public.account_connection_locks to service_role;

-- Accounts 095 already locked: the latest lock/unlock row on each account
-- chain says which. A chain whose latest is account.locked is locked from
-- that row's time. A chain whose latest is account.unlocked gets its floor
-- from the last lock before it, already unlocked — the floor still bites the
-- sign-ins that predate it, which is the review's MEDIUM-3.
insert into public.account_connection_locks (user_id, locked_at, unlocked_at)
select x.chain_key,
       x.locked_ts,
       case when x.latest_kind = 'account.unlocked' then x.latest_ts end
  from (
    select e.chain_key,
           (array_agg(e.kind order by e.seq desc))[1]                      as latest_kind,
           (array_agg(e.ts   order by e.seq desc))[1]                      as latest_ts,
           max(e.ts) filter (where e.kind = 'account.locked')              as locked_ts
      from public.events e
     where e.kind in ('account.locked', 'account.unlocked')
     group by e.chain_key
  ) x
 where x.locked_ts is not null
   and exists (select 1 from public.profiles p where p.id = x.chain_key)
on conflict (user_id) do nothing;


-- ============================================================================
-- 3. The session: who is asking, and when their sign-in was issued
-- ============================================================================
-- Decided by the CLAIMS, not by current_user: inside a SECURITY DEFINER
-- function current_user is the owner, but the claims are still the caller's.
-- So a definer RPC a browser calls (098's connector_token_create, for one) is
-- judged by the browser's own sign-in, exactly as a bare INSERT is.
--
--   role 'authenticated'  → the JWT: sub, iat, session_id. A token our own
--                           server minted for a connector (cs_via
--                           'connector', lib/supabase-user-jwt.mjs) is marked
--                           as such: its iat is always "now", and it is a
--                           connected app acting, never the person signing in.
--   anything else, with the consent marker set (§8) → the marker, which the
--                           service role wrote from the browser sign-in that
--                           api/oauth-approve.mjs had just verified.
--   the service role with no marker → null: no person is asking.
--   no claims at all (the SQL editor, a migration) → null, with role ''.
create or replace function disconnect_internal.session()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_claims jsonb;
  v_marker text;
begin
  begin
    v_claims := auth.jwt();
  exception when others then
    v_claims := null;
  end;
  if coalesce(v_claims ->> 'role', '') = 'authenticated' then
    return jsonb_build_object(
      'sub', v_claims ->> 'sub', 'iat', v_claims -> 'iat',
      'session_id', v_claims ->> 'session_id',
      'through', case when v_claims ->> 'cs_via' = 'connector' then 'connector' else 'sign-in' end);
  end if;
  v_marker := nullif(current_setting('disconnect.session', true), '');
  if v_marker is not null then
    return v_marker::jsonb || jsonb_build_object('through', 'consent');
  end if;
  return null;
end $$;

create or replace function disconnect_internal.claims_role()
returns text
language plpgsql
stable
security invoker
as $$
begin
  return coalesce(auth.jwt() ->> 'role', '');
exception when others then
  return '';
end $$;

-- iat as whole seconds, or null if it is missing or not a number. A real
-- Supabase access token always carries one; a claim set without it is
-- treated as "issued before any lock" — refused, never waved through.
create or replace function disconnect_internal.iat_of(p_session jsonb)
returns bigint
language sql
immutable
as $$
  select case when coalesce(p_session ->> 'iat', '') ~ '^[0-9]+(\.[0-9]+)?$'
              then floor((p_session ->> 'iat')::numeric)::bigint end
$$;

create or replace function disconnect_internal.lock_floor(p_locked_at timestamptz)
returns bigint
language sql
immutable
as $$ select floor(extract(epoch from p_locked_at))::bigint $$;


-- ============================================================================
-- 4. The gate
-- ============================================================================
-- Called by the BEFORE triggers in §4b with the account the new credential
-- belongs to. Raises, with errcode 42501 and a message beginning
-- 'connections_locked', when it refuses; the API layer recognises that prefix.
create or replace function disconnect_internal.gate(p_owner uuid, p_door text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lock    public.account_connection_locks;
  v_session jsonb;
  v_iat     bigint;
  v_role    text := disconnect_internal.claims_role();
begin
  if p_owner is null then
    return;
  end if;
  select * into v_lock from public.account_connection_locks where user_id = p_owner;
  if not found then
    return;
  end if;

  v_session := disconnect_internal.session();

  if v_session is null then
    -- No claims at all: an operator in the SQL editor or a migration. They
    -- can do anything anyway; nothing here pretends otherwise, and §7 writes
    -- no account.unlocked for them.
    if v_role = '' then
      return;
    end if;
    -- The service role with no consent marker (065's adopt and upsert, or
    -- any future server path that has not said whose sign-in it acts for).
    if v_lock.unlocked_at is null then
      raise exception 'connections_locked: this account was disconnected; its % can only be reconnected from a new sign-in', p_door
        using errcode = '42501',
              hint = 'Server paths that create credentials must carry the person''s sign-in (see oauth_grant_approve_session).';
    end if;
    return;
  end if;

  if (v_session ->> 'sub') is distinct from p_owner::text then
    -- Someone else bringing back this account's connection. While it is
    -- locked, only the account itself may.
    if v_lock.unlocked_at is null then
      raise exception 'connections_locked: only the account itself can reconnect it after "Disconnect everything"'
        using errcode = '42501';
    end if;
    return;
  end if;

  -- A connected app acting for the account (a connector's minted token)
  -- cannot bring anything back while the account is locked, however fresh
  -- its token: only a person signing in can.
  if (v_session ->> 'through') = 'connector' and v_lock.unlocked_at is null then
    raise exception 'connections_locked: a connected app cannot reconnect an account after "Disconnect everything"'
      using errcode = '42501';
  end if;

  v_iat := disconnect_internal.iat_of(v_session);
  if v_iat is null or v_iat <= disconnect_internal.lock_floor(v_lock.locked_at) then
    raise exception 'connections_locked: this sign-in was issued before "Disconnect everything"; sign in again to reconnect'
      using errcode = '42501',
            hint = 'A sign-in from before the press cannot reconnect anything. Refresh the session (or sign in) and try again.';
  end if;
end $$;

revoke all on function disconnect_internal.session() from public, anon, authenticated, service_role;
revoke all on function disconnect_internal.claims_role() from public, anon, authenticated, service_role;
revoke all on function disconnect_internal.gate(uuid, text) from public, anon, authenticated, service_role;


-- 4b. The doors. BEFORE triggers, so a refusal writes nothing at all — the
-- row, and the AFTER trigger that would have written account.unlocked, never
-- happen.
create or replace function disconnect_internal.gate_token_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform disconnect_internal.gate(new.user_id, case when new.kind = 'agent' then 'agent' else 'connected app' end);
  return new;
end $$;

create or replace function disconnect_internal.gate_grant_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform disconnect_internal.gate(new.user_id, case when new.agent_token_id is null then 'assistant' else 'agent' end);
  return new;
end $$;

create or replace function disconnect_internal.gate_charter_enable() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.enabled then
    return new;
  end if;
  perform disconnect_internal.gate(new.owner_id, 'in-app agent');
  return new;
end $$;

-- Resuming AI is judged against the person resuming (auth.uid()), as 095's
-- unlock trigger is: a colleague who is not locked may resume a firm matter;
-- the locked account may not, from a sign-in that predates its lock.
create or replace function disconnect_internal.gate_resume() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform disconnect_internal.gate(auth.uid(), 'AI resume');
  return new;
end $$;

drop trigger if exists connector_tokens_gate_insert on public.connector_tokens;
create trigger connector_tokens_gate_insert
  before insert on public.connector_tokens
  for each row execute function disconnect_internal.gate_token_insert();

drop trigger if exists oauth_grants_gate_insert on public.oauth_grants;
create trigger oauth_grants_gate_insert
  before insert on public.oauth_grants
  for each row execute function disconnect_internal.gate_grant_insert();

drop trigger if exists agent_charters_gate_enable on public.agent_charters;
create trigger agent_charters_gate_enable
  before insert or update of enabled on public.agent_charters
  for each row when (new.enabled)
  execute function disconnect_internal.gate_charter_enable();

drop trigger if exists matterspaces_gate_resume on public.matterspaces;
create trigger matterspaces_gate_resume
  before update of ai_paused on public.matterspaces
  for each row when (old.ai_paused and not new.ai_paused)
  execute function disconnect_internal.gate_resume();


-- ============================================================================
-- 5. connector_tokens: nothing un-revokes
-- ============================================================================
-- SECURITY INVOKER plpgsql, so current_user is the role PostgREST switched
-- into (feedback_rls_security_invoker_wrappers; 065 §3's shape). Refusals
-- RAISE rather than silently freezing the column: a browser that tries to
-- un-revoke a token should be told no, not told yes and ignored.
create or replace function public.connector_tokens_guard_update()
returns trigger
language plpgsql
security invoker
as $$
declare
  v_open constant text[] := array['name', 'last_used_at', 'revoked_at', 'expires_at',
                                  'matter_scope', 'scope_all'];
  v_old_live boolean;
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  if (to_jsonb(new) - v_open) is distinct from (to_jsonb(old) - v_open) then
    raise exception 'connector_tokens: only the name, the matters of a live agent, revoking and an earlier expiry can change'
      using errcode = '42501';
  end if;

  -- Revocation is one-way, and the server stamps the time.
  if old.revoked_at is not null then
    if new.revoked_at is distinct from old.revoked_at then
      raise exception 'connector_tokens: a revoked token stays revoked'
        using errcode = '42501';
    end if;
  elsif new.revoked_at is not null then
    new.revoked_at := now();
  end if;

  -- Expiry can only come sooner.
  if old.expires_at is not null
     and (new.expires_at is null or new.expires_at > old.expires_at) then
    raise exception 'connector_tokens: an expiry can be brought forward, never pushed back or removed'
      using errcode = '42501';
  end if;

  -- What an agent may see: only on a live agent row, and only from a sign-in
  -- the gate accepts (widening an agent is a new grant of access).
  if (to_jsonb(new) -> 'matter_scope') is distinct from (to_jsonb(old) -> 'matter_scope')
     or (to_jsonb(new) -> 'scope_all') is distinct from (to_jsonb(old) -> 'scope_all') then
    v_old_live := old.revoked_at is null
                  and (old.expires_at is null or old.expires_at > now())
                  and coalesce(to_jsonb(old) ->> 'kind', 'user') = 'agent';
    if not v_old_live then
      raise exception 'connector_tokens: the matters of a revoked, expired or non-agent token cannot change'
        using errcode = '42501';
    end if;
    perform disconnect_internal.gate(old.user_id, 'agent');
  end if;

  return new;
end $$;

-- The gate is DEFINER in a schema the browser has usage on; the guard calls
-- it as the caller, so the caller needs EXECUTE on it — and only through this
-- guard is it reachable, because disconnect_internal is not an exposed schema.
grant execute on function disconnect_internal.gate(uuid, text) to authenticated;

drop trigger if exists connector_tokens_guard_update on public.connector_tokens;
create trigger connector_tokens_guard_update
  before update on public.connector_tokens
  for each row execute function public.connector_tokens_guard_update();


-- ============================================================================
-- 6. The press, redefined
-- ============================================================================
-- 095's core with three changes, and nothing else:
--   (a) the account press stamps account_connection_locks (the floor, and
--       "locked" until the owner reconnects);
--   (b) the account press pauses the matters of serverspaces the presser
--       OWNS (serverspace_members.role = 'owner'). 095 also took 'admin'.
--       The spec says "every matter the caller owns"; an admin of a firm's
--       serverspace pressing for their OWN account (a lost phone) should not
--       stop every matter of the firm for everybody. The alternative is one
--       word — `in ('owner', 'admin')` in the two queries marked [owner] —
--       and is Eden's decision (see the PR).
--   (c) the account press needs aal2 when the account has a verified second
--       factor: a thief holding an aal1 session could otherwise disconnect
--       the owner (and, through api/account-lockdown.mjs, sign the owner's
--       other devices out). The preview (dry) does not need it.
create or replace function disconnect_internal.run(
  p_scope  text,
  p_matter uuid,
  p_dry    boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_scope        text := lower(coalesce(p_scope, ''));
  v_reach        uuid[];
  v_grants_full  uuid[] := '{}';
  v_grants_agent uuid[] := '{}';
  v_agents       uuid[] := '{}';
  v_apps         uuid[] := '{}';
  v_charters     uuid[] := '{}';
  v_roots        uuid[] := '{}';
  v_covered      int := 0;
  v_linked       uuid[] := '{}';
  v_counts       jsonb;
  v_name         text;
  v_now          timestamptz := now();
  r              record;
begin
  if v_uid is null then
    raise exception 'disconnecting requires a signed-in caller' using errcode = '42501';
  end if;

  if v_scope = 'matter' then
    if p_matter is null then
      raise exception 'a matter is required' using errcode = '22004';
    end if;
    if not exists (select 1 from public.matterspaces where id = p_matter) then
      raise exception 'matter % not found', p_matter using errcode = 'P0002';
    end if;
    if coalesce(public.matter_role(p_matter), '') not in ('owner', 'admin') then
      raise exception 'only an owner or admin of this matter can disconnect assistants from it'
        using errcode = '42501';
    end if;
    select coalesce(array_agg(a.id), '{}') into v_reach from public.matter_ancestry(p_matter) a;
  elsif v_scope <> 'account' then
    raise exception 'scope must be ''account'' or ''matter''' using errcode = '22023';
  end if;

  -- (c) 099: the account press is a second-factor act when there is one.
  if v_scope = 'account' and not coalesce(p_dry, false)
     and stepup_internal.has_verified_factor(v_uid)
     and not public.auth_is_aal2() then
    raise exception 'step_up_required: confirm your second factor to disconnect everything'
      using errcode = '42501';
  end if;

  select coalesce(array_agg(g.id order by g.created_at), '{}') into v_grants_full
    from public.oauth_grants g
   where g.user_id = v_uid and g.revoked_at is null and g.agent_token_id is null;

  select coalesce(array_agg(t.id order by t.created_at), '{}') into v_apps
    from public.connector_tokens t
   where t.user_id = v_uid and t.revoked_at is null
     and coalesce(t.kind, 'user') <> 'agent'
     and (t.expires_at is null or t.expires_at > v_now);

  select coalesce(array_agg(t.id order by t.created_at), '{}') into v_agents
    from public.connector_tokens t
   where t.user_id = v_uid and t.revoked_at is null
     and t.kind = 'agent'
     and (t.expires_at is null or t.expires_at > v_now)
     and (v_scope = 'account'
          or t.scope_all
          or coalesce(t.matter_scope, '{}') && v_reach);

  if v_scope = 'account' then
    select coalesce(array_agg(g.id order by g.created_at), '{}') into v_grants_agent
      from public.oauth_grants g
     where g.user_id = v_uid and g.revoked_at is null and g.agent_token_id is not null;

    select coalesce(array_agg(c.id order by c.created_at), '{}') into v_charters
      from public.agent_charters c
     where c.owner_id = v_uid and c.enabled;

    -- (b) [owner] Every matter in a serverspace the caller OWNS.
    select count(*)::int into v_covered
      from public.matterspaces m
     where m.serverspace_id in (
       select sm.serverspace_id from public.serverspace_members sm
        where sm.user_id = v_uid and sm.role = 'owner');

    -- (b) [owner]
    select coalesce(array_agg(m.id order by m.name), '{}') into v_roots
      from public.matterspaces m
     where m.parent_matterspace_id is null
       and not m.ai_paused
       and m.serverspace_id in (
         select sm.serverspace_id from public.serverspace_members sm
          where sm.user_id = v_uid and sm.role = 'owner');
  else
    select coalesce(array_agg(g.id order by g.created_at), '{}') into v_grants_agent
      from public.oauth_grants g
     where g.user_id = v_uid and g.revoked_at is null
       and g.agent_token_id = any (v_agents);

    v_covered := 1;
    select case when m.ai_paused then '{}'::uuid[] else array[m.id] end into v_roots
      from public.matterspaces m where m.id = p_matter;
  end if;

  select coalesce(array_agg(distinct g.agent_token_id), '{}') into v_linked
    from public.oauth_grants g where g.id = any (v_grants_agent);

  v_counts := jsonb_build_object(
    'scope',       v_scope,
    'matter_id',   case when v_scope = 'matter' then p_matter end,
    'assistants',  cardinality(v_grants_full),
    'agents',      (select count(*) from (
                      select unnest(v_agents) union select unnest(v_linked)) x),
    'apps',        cardinality(v_apps),
    'charters',    cardinality(v_charters),
    'matters',     v_covered,
    'matters_paused_now', cardinality(v_roots),
    'outright',    v_scope = 'matter' and cardinality(v_grants_full) + cardinality(v_apps) > 0
  );

  if coalesce(p_dry, false) then
    return v_counts;
  end if;

  update public.oauth_grants
     set revoked_at = v_now, revoked_by = v_uid
   where id = any (v_grants_full || v_grants_agent) and revoked_at is null;

  update public.connector_tokens
     set revoked_at = v_now
   where id = any (v_agents || v_apps || v_linked) and revoked_at is null;

  update public.agent_charters
     set enabled = false
   where id = any (v_charters);

  if cardinality(v_roots) > 0 then
    select nullif(btrim(coalesce(p.display_name, '')), '') into v_name
      from public.profiles p where p.id = v_uid;
  end if;
  for r in select unnest(v_roots) as id loop
    perform public._ai_pause_write(r.id, true, disconnect_internal.pause_note(), v_uid, v_name);
  end loop;

  -- (a) the lock. Inside the same transaction: a press that fails stamps
  -- nothing, and a press that commits cannot leave the account unlocked.
  if v_scope = 'account' then
    insert into public.account_connection_locks (user_id, locked_at)
    values (v_uid, v_now)
    on conflict (user_id) do update
      set locked_at = excluded.locked_at,
          unlocked_at = null, unlocked_session_id = null, unlocked_iat = null;
  end if;

  for r in
    select g.id, g.client_id_prefix, g.client_name, g.agent_token_id
      from public.oauth_grants g
     where g.id = any (v_grants_full || v_grants_agent)
     order by g.created_at
  loop
    perform public._ledger_append_account_checked(
      'connector.revoked', null, 'user', v_uid::text, null,
      jsonb_build_object(
        'client_id', r.client_id_prefix, 'client_name', r.client_name,
        'by', 'kill', 'scope', v_scope, 'grant_id', r.id,
        'kind', case when r.agent_token_id is null then 'assistant' else 'agent' end,
        'agent_token_id', r.agent_token_id));
  end loop;

  for r in
    select t.id, t.token_prefix, t.name, t.kind
      from public.connector_tokens t
     where t.id = any (v_agents || v_apps)
       and not (t.id = any (v_linked))
     order by t.created_at
  loop
    perform public._ledger_append_account_checked(
      'connector.revoked', null, 'user', v_uid::text, null,
      jsonb_build_object(
        'client_id', r.token_prefix, 'client_name', coalesce(r.name, 'Connector token'),
        'by', 'kill', 'scope', v_scope, 'token_id', r.id,
        'kind', case when r.kind = 'agent' then 'agent' else 'app' end));
  end loop;

  if v_scope = 'account' then
    for r in select unnest(v_roots) as id loop
      perform public._ledger_append_checked(
        'ai.paused', r.id, null, null, 'user', v_uid::text, null,
        jsonb_build_object('reason', 'kill', 'via', 'disconnect_all'));
    end loop;
    perform public._ledger_append_account_checked(
      'account.locked', null, 'user', v_uid::text, null, v_counts);
  else
    perform public._ledger_append_checked(
      'matter.disconnected', p_matter, null, null, 'user', v_uid::text, null, v_counts);
  end if;

  return v_counts || jsonb_build_object('done', true);
end $$;

revoke all on function disconnect_internal.run(text, uuid, boolean) from public;
revoke all on function disconnect_internal.run(text, uuid, boolean) from anon;
grant execute on function disconnect_internal.run(text, uuid, boolean) to authenticated, service_role;


-- ============================================================================
-- 7. account.unlocked, redefined
-- ============================================================================
-- Same four AFTER triggers as 095 (they call these functions by name), with
-- the rule the review asked for: the Record says "the owner reconnected" only
-- for the owner's OWN sign-in, issued after the lock. The row carries that
-- sign-in's session_id and iat, and which way it came in (a browser sign-in,
-- or the consent screen on the owner's behalf). It clears the lock. For
-- anything else — an operator, a colleague, a sign-in the gate would have
-- refused — it writes nothing, and the account stays locked.
create or replace function disconnect_internal.account_locked(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.account_connection_locks l
     where l.user_id = p_uid and l.unlocked_at is null)
$$;

create or replace function disconnect_internal.note_unlocked(p_uid uuid, p_via text, p_ref uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lock    public.account_connection_locks;
  v_session jsonb;
  v_iat     bigint;
begin
  if p_uid is null then
    return;
  end if;
  select * into v_lock from public.account_connection_locks
   where user_id = p_uid and unlocked_at is null
   for update;
  if not found then
    return;
  end if;
  v_session := disconnect_internal.session();
  if v_session is null or (v_session ->> 'sub') is distinct from p_uid::text
     or (v_session ->> 'through') = 'connector' then
    return;
  end if;
  v_iat := disconnect_internal.iat_of(v_session);
  if v_iat is null or v_iat <= disconnect_internal.lock_floor(v_lock.locked_at) then
    return;
  end if;

  update public.account_connection_locks
     set unlocked_at = now(),
         unlocked_session_id = v_session ->> 'session_id',
         unlocked_iat = v_iat
   where user_id = p_uid;

  perform public._ledger_write_scoped(
    'account.unlocked', null, null, null, 'user', p_uid::text, null,
    jsonb_build_object(
      'via', p_via, 'ref', p_ref,
      'session_id', v_session ->> 'session_id',
      'iat', v_iat,
      'through', v_session ->> 'through'),
    p_uid, p_uid);
end $$;

revoke all on function disconnect_internal.account_locked(uuid) from public, anon, authenticated, service_role;
revoke all on function disconnect_internal.note_unlocked(uuid, text, uuid) from public, anon, authenticated, service_role;


-- ============================================================================
-- 8. The consent screen and the legacy door
-- ============================================================================
-- 8a. oauth_grant_approve_session — 088's oauth_grant_approve, with the
-- browser sign-in that approved it. api/oauth-approve.mjs has verified the
-- person's Supabase session with Supabase Auth before it calls this, and
-- passes that token's own sub / iat / session_id. The marker is
-- transaction-local: it lives for this one call.
--
-- The gate runs FIRST, before anything is read or written: "attach to the
-- live grant" (no INSERT, so no trigger) must not hand a pre-lock sign-in a
-- code for a grant the owner has since reconnected.
create or replace function public.oauth_grant_approve_session(
  p_session        jsonb,
  p_user_id        uuid,
  p_client_id      text,
  p_client_name    text    default null,
  p_scopes         text[]  default null,
  p_notes          text    default null,
  p_agent_name     text    default null,
  p_agent_provider text    default null,
  p_matter_scope   uuid[]  default null,
  p_token_hash     text    default null,
  p_scope_all      boolean default false
)
returns table (grant_id uuid, agent_token_id uuid, outcome text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null or p_session is null
     or (p_session ->> 'sub') is distinct from p_user_id::text then
    raise exception 'oauth_grant_approve_session: the sign-in must be the approving user''s own'
      using errcode = '22023';
  end if;
  perform set_config('disconnect.session',
    jsonb_build_object('sub', p_user_id::text, 'iat', p_session -> 'iat',
                       'session_id', p_session ->> 'session_id')::text,
    true);
  perform disconnect_internal.gate(p_user_id,
    case when p_matter_scope is null and not coalesce(p_scope_all, false) then 'assistant' else 'agent' end);

  return query
    select a.grant_id, a.agent_token_id, a.outcome
      from public.oauth_grant_approve(
        p_user_id, p_client_id, p_client_name, p_scopes, p_notes,
        p_agent_name, p_agent_provider, p_matter_scope, p_token_hash, p_scope_all) a;

  perform set_config('disconnect.session', '', true);
end $$;

-- 8b. Adoption (065 §4b) — the pre-065 refresh token minting its own grant.
-- Same body, one rule added first: an account that has EVER pressed
-- "Disconnect everything" adopts nothing. The press could not see a client
-- that had no grant row, so the press could not have revoked it; adopting it
-- afterwards would bring back a connection the owner believes is gone
-- (HIGH-2). outcome 'locked' is a refusal to the API.
create or replace function public.oauth_grant_adopt(
  p_user_id    uuid,
  p_client_id  text,
  p_client_name text default null,
  p_scopes     text[] default null,
  p_notes      text default null
)
returns table (grant_id uuid, outcome text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text := public.oauth_grant_hash(p_client_id);
  v_id   uuid;
begin
  if p_user_id is null or coalesce(p_client_id, '') = '' then
    raise exception 'oauth_grant_adopt: p_user_id and p_client_id are required';
  end if;

  if exists (select 1 from public.account_connection_locks l where l.user_id = p_user_id) then
    return query select null::uuid, 'locked'::text;
    return;
  end if;

  select g.id into v_id
    from public.oauth_grants g
   where g.user_id = p_user_id
     and g.client_id_hash = v_hash
     and g.revoked_at is null;
  if v_id is not null then
    return query select v_id, 'attached'::text;
    return;
  end if;

  if exists (
    select 1 from public.oauth_grants g
     where g.user_id = p_user_id and g.client_id_hash = v_hash
  ) then
    return query select null::uuid, 'revoked'::text;
    return;
  end if;

  insert into public.oauth_grants
    (user_id, client_id_hash, client_id_prefix, client_name, scopes, notes)
  values
    (p_user_id, v_hash, left(p_client_id, 12),
     coalesce(nullif(p_client_name, ''), 'Unknown client'),
     coalesce(p_scopes, array['mcp']::text[]),
     coalesce(p_notes, 'adopted from a token issued before migration 065'))
  on conflict (user_id, client_id_hash) where revoked_at is null
  do update set client_name = excluded.client_name
  returning id into v_id;

  return query select v_id, 'adopted'::text;
end $$;


-- ============================================================================
-- 9. What the API reads
-- ============================================================================
-- 9a. An account's lock, for the paths that have no grant to read (a token
-- minted before 065). Zero rows = never locked.
create or replace function public.account_connections_lock_state(p_user_id uuid)
returns table (locked boolean, locked_at timestamptz, unlocked_at timestamptz)
language sql
security definer
stable
set search_path = public
as $$
  select (l.unlocked_at is null), l.locked_at, l.unlocked_at
    from public.account_connection_locks l
   where l.user_id = p_user_id
$$;

-- 9b. oauth_grant_link_state (087) plus whether the grant's owner is locked.
-- lib/oauth-grants.mjs keeps what this says in its cache entry; an entry that
-- says "owner locked" is never trusted again without a fresh read.
create or replace function public.oauth_grant_lock_state(p_grant_id uuid)
returns table (grant_id uuid, owner_id uuid, revoked boolean, client_name text,
               agent_token_id uuid, owner_locked boolean)
language sql
security definer
stable
set search_path = public
as $$
  select g.id, g.user_id, (g.revoked_at is not null), g.client_name, g.agent_token_id,
         exists (select 1 from public.account_connection_locks l
                  where l.user_id = g.user_id and l.unlocked_at is null)
    from public.oauth_grants g
   where g.id = p_grant_id
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.oauth_grant_approve_session(jsonb, uuid, text, text, text[], text, text, text, uuid[], text, boolean)',
    'public.oauth_grant_adopt(uuid, text, text, text[], text)',
    'public.account_connections_lock_state(uuid)',
    'public.oauth_grant_lock_state(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;


notify pgrst, 'reload schema';
