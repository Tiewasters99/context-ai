-- 095_disconnect_all.sql — S2: one press disconnects every assistant, agent
-- and app, and pauses AI
--
-- docs/specs/SECURITY-BUILD-2026-09-26.md §S2. "One press disconnects every
-- assistant, agent and connected app from my account — or from one matter —
-- and pauses AI there."
--
-- Until this file every revoke existed one row at a time — a grant in
-- Connections, an agent in Connections › Agents, a pause in the matter header
-- — and each was checked per request (065/085/087 in lib/oauth-grants.mjs and
-- api/mcp.mjs, 070 in lib/ai-tier-policy.mjs). What did not exist was the
-- sweep: the owner who has just lost a laptop, or who sees an agent doing
-- something at 11 p.m., had to find and press every one. This file is the
-- sweep. It adds NO new check anywhere: everything it does is a write the
-- existing per-request checks already refuse on the next request.
--
-- What this file adds
-- ---------------------------------------------------------------------------
--   1. Prerequisites, asserted. A sweep that half-works because an earlier
--      migration is missing is worse than one that refuses to install, so the
--      file raises at the top rather than skipping with a notice.
--   2. disconnect_internal.run(scope, matter, dry) — the one DEFINER core.
--      It chooses the targets, and either counts them (dry: the confirm
--      sentence) or revokes them and writes the Record. Preview and act share
--      the selection, so the sentence cannot name a different set from the
--      one the press then touches.
--   3. public.disconnect_all(scope, matter) and
--      public.disconnect_all_preview(scope, matter) — the INVOKER wrappers the
--      app calls (feedback_rls_security_invoker_wrappers; 070's shape).
--   4. account.unlocked — written the first time, after a lock, that the
--      owner resumes AI, reconnects an assistant or app, or switches an
--      in-app agent back on. Four small AFTER triggers, one per door (see §4).
--
-- WHAT "ACCOUNT" MEANS (p_scope = 'account')
-- ---------------------------------------------------------------------------
--   * every live OAuth grant of the caller (065): revoked_at = now(),
--     revoked_by = the caller. There is no `revoked` boolean on the table —
--     `revoked` is what oauth_grant_state computes from revoked_at;
--   * every live connector token of the caller (003/085) — pasted csp_ tokens
--     (kind 'user', "connected apps") and agents (kind 'agent', including the
--     identity row behind an agent that signed in over OAuth, 087):
--     revoked_at = now(). An already-expired token is dead and left alone;
--   * every enabled in-app agent (agent_charters, 052): enabled = false;
--   * AI paused on every matter in every serverspace the caller runs
--     (serverspace_members role owner/admin — since 099, role OWNER only;
--     see 099 §6). NOT matters the caller merely
--     belongs to, and not a matter where the caller is only a matter-level
--     admin: an outside co-counsel pressing this for their own account must
--     not stop the firm's matter for everybody. The pause is set on each ROOT
--     matter only — it is inherited (070), so the whole tree is paused, and
--     resuming the root resumes the tree rather than leaving every sub-matter
--     individually paused. A root already paused is left exactly as it was
--     (its note and byline are someone's evidence). The count reports every
--     matter covered, so "AI paused on 41 matters" is true afterwards.
--
-- WHAT "MATTER" MEANS (p_scope = 'matter')
-- ---------------------------------------------------------------------------
-- Pressed by an owner/admin of the matter (016's matter_role — direct, an
-- ancestor, or the serverspace). It touches THE CALLER'S OWN credentials only:
--   * the caller's full-access OAuth grants and pasted tokens are revoked
--     OUTRIGHT — a full-access connection is access to every matter, so it
--     cannot be narrowed to "not this one"; the confirm sentence says so;
--   * the caller's agents whose scope reaches the matter (the matter or an
--     ancestor in matter_scope — an agent sees sub-matters of what it is
--     given — or scope_all, 088), and any OAuth grant linked to one;
--   * AI paused on the matter itself (and so on everything inside it).
-- Other members' credentials are not revoked here: the connector.revoked row
-- belongs on the credential owner's account chain, which only that person may
-- write, and revoking a colleague's Claude across all of their matters is not
-- what "this matter" means. The pause covers them: a paused matter is refused
-- to every connector, agent and chat, whoever connected it — including the
-- Chrome extension's /api/ext/* endpoints, which did not check it until 099.
--
-- THE RECORD (all through the existing ledger functions, 064/072/094)
-- ---------------------------------------------------------------------------
--   account chain  connector.revoked {client_id, client_name, by:'kill', …}
--                  one per grant, and one per token not already named by a
--                  revoked grant's row (an OAuth agent is one row, not two);
--                  client_id is the stored 12-character prefix — the full
--                  client id is never stored (065)
--   account chain  account.locked {counts}                     account scope
--   each root      ai.paused {reason:'kill'}                   account scope
--   the matter     matter.disconnected {counts}                matter scope
--
-- FAILS CLOSED
-- ---------------------------------------------------------------------------
-- One plpgsql call is one statement is one transaction, and nothing below
-- catches an exception. Any failure — a revoke, a pause, a Record row —
-- undoes every revoke before it and comes back to the caller as the error.
-- The Record is written LAST, so a failure to record undoes the revokes: a
-- disconnect nobody can later see is not one this product performs.
--
-- WHAT A REVOKE MEANS ON THE NEXT REQUEST (the existing checks, unchanged)
-- ---------------------------------------------------------------------------
--   csp_ tokens and agents   read fresh on every request (api/mcp.mjs path A,
--                            lib/connector-token-auth.mjs, readAgentTokenRow)
--                            → refused on the very next request.
--   OAuth agent grants       checked fresh (087: no cache for `agt` tokens).
--   OAuth full-access grants lib/oauth-grants.mjs caches grant state for up
--                            to GRANT_CACHE_TTL_MS (60 s) per warm instance;
--                            the next REFRESH is refused at once. The same
--                            "within a minute" Connections already says.
--   Browser sessions         api/account-lockdown.mjs signs out every other
--                            session after this commits (their refresh
--                            tokens die; an access token already issued lasts
--                            until it expires, an hour by default).
--
-- Apply order: after 094. Needs 003, 016, 052, 064, 065, 070, 072, 085, 087,
-- 088 and 094 — asserted in §1. Re-runnable; scripts/_verify-disconnect-all.mjs
-- executes it twice end-to-end.
--
-- ROLLBACK (in this order):
--   drop trigger if exists matterspaces_unlock_on_resume on public.matterspaces;
--   drop trigger if exists oauth_grants_unlock_on_connect on public.oauth_grants;
--   drop trigger if exists connector_tokens_unlock_on_connect on public.connector_tokens;
--   drop trigger if exists agent_charters_unlock_on_enable on public.agent_charters;
--   drop function if exists public.disconnect_all(text, uuid);
--   drop function if exists public.disconnect_all_preview(text, uuid);
--   drop schema if exists disconnect_internal cascade;
--   drop index if exists public.events_account_lock_idx;
--   -- What a press already revoked or paused stays revoked or paused (rolling
--   -- back narrows nothing and widens nothing); the Record rows are
--   -- append-only and stay.
--
-- ⚠ After pasting this file, run:  notify pgrst, 'reload schema';
--   (it is the last statement here.) Until it is pasted, the preview RPC is
--   missing (PGRST202) and both buttons hide themselves; nothing else changes.


-- ============================================================================
-- 1. Prerequisites
-- ============================================================================
do $migration$
declare
  v_missing text[] := '{}';
  v_col record;
  v_fn text;
begin
  for v_col in
    select * from (values
      ('oauth_grants', 'revoked_at'), ('oauth_grants', 'revoked_by'),
      ('oauth_grants', 'agent_token_id'),                             -- 087
      ('connector_tokens', 'revoked_at'), ('connector_tokens', 'kind'),
      ('connector_tokens', 'matter_scope'),                           -- 085
      ('connector_tokens', 'scope_all'),                              -- 088
      ('agent_charters', 'enabled'),                                  -- 052
      ('matterspaces', 'ai_paused'),                                  -- 070
      ('events', 'chain_key')                                         -- 064
    ) as t(tbl, col)
  loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = v_col.tbl and column_name = v_col.col)
    then
      v_missing := v_missing || (v_col.tbl || '.' || v_col.col);
    end if;
  end loop;

  foreach v_fn in array array[
    'public._ai_pause_write(uuid,boolean,text,uuid,text)',                        -- 070
    'public._ledger_append_checked(text,uuid,uuid,uuid,text,text,text,jsonb)',    -- 064
    'public._ledger_append_account_checked(text,uuid,text,text,text,jsonb)',      -- 072
    'public._ledger_write_scoped(text,uuid,uuid,uuid,text,text,text,jsonb,uuid,uuid)', -- 072
    'public.matter_role(uuid)', 'public.can_manage_matter(uuid)',                 -- 016
    'public.matter_ancestry(uuid)'                                                -- 016
  ] loop
    if to_regprocedure(v_fn) is null then
      v_missing := v_missing || v_fn;
    end if;
  end loop;

  if cardinality(v_missing) > 0 then
    raise exception '095 needs these first: %', array_to_string(v_missing, ', ')
      using hint = 'Paste the migrations that add them (see this file''s header), then this file again.';
  end if;

  -- 094 is what lets the Record hold account.locked / matter.disconnected at all.
  if not exists (
    select 1 from pg_constraint
     where conname = 'events_kind_check'
       and pg_get_constraintdef(oid) like '%account.locked%')
  then
    raise exception '095 needs 094 (the account.* and matter.disconnected kinds) first';
  end if;
end $migration$;


-- ============================================================================
-- 2. The core
-- ============================================================================
create schema if not exists disconnect_internal;
revoke all on schema disconnect_internal from public;
grant usage on schema disconnect_internal to authenticated, service_role;

comment on schema disconnect_internal is
  'SECURITY DEFINER bodies for migration 095 (disconnect everything). Reached only '
  'through the public INVOKER wrappers. Do not add to PostgREST''s exposed schemas.';

-- How the pause says who set it and why. The matter header maps this exact
-- note to a sentence (src/components/matter/AiPauseControl.tsx), so it never
-- shows the raw word to anyone.
create or replace function disconnect_internal.pause_note()
returns text language sql immutable as $$ select 'disconnect_all'::text $$;

-- DEFINER: reads auth.uid() ITSELF — never a parameter, because a uid
-- parameter on a function a signed-in user may call is a forged byline (070,
-- 064). p_dry = true counts and changes nothing.
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
  v_reach        uuid[];      -- the matter and its ancestors (matter scope)
  v_grants_full  uuid[] := '{}';
  v_grants_agent uuid[] := '{}';
  v_agents       uuid[] := '{}';
  v_apps         uuid[] := '{}';
  v_charters     uuid[] := '{}';
  v_roots        uuid[] := '{}';   -- matters this press will pause
  v_covered      int := 0;         -- matters paused afterwards, inherited or not
  v_linked       uuid[] := '{}';   -- agent rows named by a revoked grant's row
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
    -- 016's rule, asked as the caller: owner/admin of the matter, of an
    -- ancestor, or of its serverspace. A member or viewer is refused.
    if coalesce(public.matter_role(p_matter), '') not in ('owner', 'admin') then
      raise exception 'only an owner or admin of this matter can disconnect assistants from it'
        using errcode = '42501';
    end if;
    select coalesce(array_agg(a.id), '{}') into v_reach from public.matter_ancestry(p_matter) a;
  elsif v_scope <> 'account' then
    raise exception 'scope must be ''account'' or ''matter''' using errcode = '22023';
  end if;

  -- ---- what is connected -------------------------------------------------
  -- Full-access OAuth grants and pasted tokens: the whole account's reach, so
  -- the same set in both scopes.
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

    -- Every matter in a serverspace the caller runs.
    select count(*)::int into v_covered
      from public.matterspaces m
     where m.serverspace_id in (
       select sm.serverspace_id from public.serverspace_members sm
        where sm.user_id = v_uid and sm.role in ('owner', 'admin'));

    select coalesce(array_agg(m.id order by m.name), '{}') into v_roots
      from public.matterspaces m
     where m.parent_matterspace_id is null
       and not m.ai_paused
       and m.serverspace_id in (
         select sm.serverspace_id from public.serverspace_members sm
          where sm.user_id = v_uid and sm.role in ('owner', 'admin'));
  else
    -- An OAuth grant that IS one of those agents goes with it.
    select coalesce(array_agg(g.id order by g.created_at), '{}') into v_grants_agent
      from public.oauth_grants g
     where g.user_id = v_uid and g.revoked_at is null
       and g.agent_token_id = any (v_agents);

    v_covered := 1;
    select case when m.ai_paused then '{}'::uuid[] else array[m.id] end into v_roots
      from public.matterspaces m where m.id = p_matter;
  end if;

  -- An agent that signed in over OAuth is one agent: its grant and its
  -- identity row are counted once, as an agent.
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
    -- Matter scope: the grants and tokens above reach every matter, so they
    -- are revoked outright. The UI says so before the press.
    'outright',    v_scope = 'matter' and cardinality(v_grants_full) + cardinality(v_apps) > 0
  );

  if coalesce(p_dry, false) then
    return v_counts;
  end if;

  -- ---- revoke --------------------------------------------------------------
  -- revoked_by is set here, not left to 065's guard: the guard stamps it for
  -- a browser's UPDATE and passes the table owner's through untouched.
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
  -- 070's writer, the only door past its guard: one row per root.
  for r in select unnest(v_roots) as id loop
    perform public._ai_pause_write(r.id, true, disconnect_internal.pause_note(), v_uid, v_name);
  end loop;

  -- ---- the Record, last ----------------------------------------------------
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
-- 3. The wrappers the app calls
-- ============================================================================
-- INVOKER plpgsql, auth.uid() captured into a declared variable at entry. The
-- permission question is asked here first, as the caller, so the error is the
-- one the caller expects — through can_manage_matter rather than a read of
-- matterspaces, because since 094 an aal1 read of a sealed matter returns
-- nothing and would turn "you may" into "no such matter". The DEFINER core
-- asks again without RLS.
create or replace function public.disconnect_all(
  p_scope  text,
  p_matter uuid default null
) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'disconnecting requires a signed-in caller' using errcode = '42501';
  end if;
  if lower(coalesce(p_scope, '')) = 'matter'
     and (p_matter is null or not public.can_manage_matter(p_matter)) then
    raise exception 'only an owner or admin of this matter can disconnect assistants from it'
      using errcode = '42501';
  end if;
  return disconnect_internal.run(p_scope, p_matter, false);
end $$;

-- The counts the confirm card names BEFORE the press. Same core, dry.
create or replace function public.disconnect_all_preview(
  p_scope  text,
  p_matter uuid default null
) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'disconnecting requires a signed-in caller' using errcode = '42501';
  end if;
  if lower(coalesce(p_scope, '')) = 'matter'
     and (p_matter is null or not public.can_manage_matter(p_matter)) then
    raise exception 'only an owner or admin of this matter can disconnect assistants from it'
      using errcode = '42501';
  end if;
  return disconnect_internal.run(p_scope, p_matter, true);
end $$;

revoke all on function public.disconnect_all(text, uuid) from public, anon;
revoke all on function public.disconnect_all_preview(text, uuid) from public, anon;
grant execute on function public.disconnect_all(text, uuid) to authenticated, service_role;
grant execute on function public.disconnect_all_preview(text, uuid) to authenticated, service_role;


-- ============================================================================
-- 4. account.unlocked — the first deliberate reconnection after a lock
-- ============================================================================
-- There is no single "undo", on purpose: each thing comes back only when its
-- owner brings it back. The Record marks the first of those moments, once:
-- the account is "locked" while the latest of account.locked /
-- account.unlocked on its chain is account.locked.
--
-- Four doors, one AFTER trigger each, because each has more than one caller:
--   matterspaces      ai_paused true → false   (070's resume, any matter)
--   oauth_grants      insert                   (the consent screen: 065/087/088
--                                                functions, as the service role)
--   connector_tokens  insert                   (a token pasted from a Connect
--                                                page or Agents — the browser —
--                                                and the agent row 087 mints)
--   agent_charters    enabled false → true, or a new enabled charter
-- oauth_grant_adopt cannot write a false unlock: after a lock every grant for
-- the pair is revoked, and adoption refuses where a revoked grant exists.
-- (Not so for a client that never had a grant — the review of #246, HIGH-2.
-- 099 refuses adoption for any account that has been locked, and writes
-- account.unlocked only for the account's own post-lock sign-in.)
--
-- The account is the row's owner (new.user_id / new.owner_id), not auth.uid():
-- the consent screen's write runs as the service role, after
-- api/oauth-approve.mjs has verified the person's own Supabase session. For
-- the resume it is auth.uid() — the person who pressed Resume. The row goes
-- through 072's scoped writer with chain = actor = that account, the one
-- aim 072 allows for a row with no matter.
--
-- Like 064's acl.changed / seal.changed triggers, these do not swallow a
-- failure to record.

-- Finding "the latest lock or unlock" must not walk a long account chain.
create index if not exists events_account_lock_idx
  on public.events (chain_key, seq desc)
  where kind in ('account.locked', 'account.unlocked');

create or replace function disconnect_internal.account_locked(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select e.kind = 'account.locked'
      from public.events e
     where e.chain_key = p_uid
       and e.kind in ('account.locked', 'account.unlocked')
     order by e.seq desc
     limit 1), false)
$$;

create or replace function disconnect_internal.note_unlocked(p_uid uuid, p_via text, p_ref uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_uid is null or not disconnect_internal.account_locked(p_uid) then
    return;
  end if;
  perform public._ledger_write_scoped(
    'account.unlocked', null, null, null, 'user', p_uid::text, null,
    jsonb_build_object('via', p_via, 'ref', p_ref), p_uid, p_uid);
end $$;

revoke all on function disconnect_internal.account_locked(uuid) from public, anon, authenticated, service_role;
revoke all on function disconnect_internal.note_unlocked(uuid, text, uuid) from public, anon, authenticated, service_role;

create or replace function disconnect_internal.on_resume() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  perform disconnect_internal.note_unlocked(v_uid, 'ai.resumed', new.id);
  return null;
end $$;

create or replace function disconnect_internal.on_grant() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform disconnect_internal.note_unlocked(
    new.user_id, case when new.agent_token_id is null then 'assistant' else 'agent' end, new.id);
  return null;
end $$;

create or replace function disconnect_internal.on_token() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform disconnect_internal.note_unlocked(
    new.user_id, case when new.kind = 'agent' then 'agent' else 'app' end, new.id);
  return null;
end $$;

create or replace function disconnect_internal.on_charter() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform disconnect_internal.note_unlocked(new.owner_id, 'in-app agent', new.id);
  return null;
end $$;

drop trigger if exists matterspaces_unlock_on_resume on public.matterspaces;
create trigger matterspaces_unlock_on_resume
  after update of ai_paused on public.matterspaces
  for each row when (old.ai_paused and not new.ai_paused)
  execute function disconnect_internal.on_resume();

drop trigger if exists oauth_grants_unlock_on_connect on public.oauth_grants;
create trigger oauth_grants_unlock_on_connect
  after insert on public.oauth_grants
  for each row execute function disconnect_internal.on_grant();

drop trigger if exists connector_tokens_unlock_on_connect on public.connector_tokens;
create trigger connector_tokens_unlock_on_connect
  after insert on public.connector_tokens
  for each row execute function disconnect_internal.on_token();

drop trigger if exists agent_charters_unlock_on_enable on public.agent_charters;
create trigger agent_charters_unlock_on_enable
  after insert or update of enabled on public.agent_charters
  for each row when (new.enabled)
  execute function disconnect_internal.on_charter();


notify pgrst, 'reload schema';
