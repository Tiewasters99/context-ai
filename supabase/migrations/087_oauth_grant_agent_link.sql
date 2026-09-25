-- Contextspaces Migration 087: an OAuth sign-in can connect AS AN AGENT.
--
-- WHY
-- ---------------------------------------------------------------------------
-- Grok (grok.com connectors and Grok Bot plugins) reaches an MCP server by
-- OAuth only; it cannot be handed a pasted csp_ token. Until now an OAuth
-- approval always made a FULL-ACCESS connection (every matter the user can
-- open, minus SecureSpaces). The agent model (085) — a named identity that
-- sees only the matters ticked for it and works a task board — existed only
-- for pasted csp_ tokens. So Eden's Grok Bot could sign in, but only as
-- Eden, and my_tasks refused it ("These tools are for agent connections").
--
-- WHAT THIS ADDS
-- ---------------------------------------------------------------------------
--   1. oauth_grants.agent_token_id — when set, this OAuth connection IS that
--      agent: /api/mcp authenticates every call on the grant as the agent
--      (kind 'agent', its matter_scope, its metering bucket, its ledger ref
--      'agent:<id>'), exactly as it would a csp_ agent token. Null = today's
--      full-access connection, unchanged.
--   2. oauth_grants_guard_update() gains one line: a customer's UPDATE cannot
--      change agent_token_id (the only update a customer may make is still
--      "revoke"). Same body as 065 otherwise.
--   3. oauth_grant_approve() — the consent write for both choices on the
--      consent screen, service role only. See §3 for exactly what it does.
--   4. oauth_grant_link_state() — oauth_grant_state plus agent_token_id,
--      so /api/mcp and /api/oauth-token can see the link. A new function
--      rather than a changed one: 065's oauth_grant_state keeps its exact
--      signature, so the code already deployed keeps working unchanged.
--
-- THE AGENT'S IDENTITY ROW HAS NO USABLE SECRET
-- ---------------------------------------------------------------------------
-- The agent created at consent is an ordinary connector_tokens row
-- (kind='agent', agent_provider, matter_scope, name), so it appears in
-- Connections › Agents like any other agent, and Edit matters / Revoke work
-- on it there. connector_tokens.token_hash stays NOT NULL UNIQUE: the server
-- stores the SHA-256 of 32 random bytes it generates and discards at once.
-- Nobody holds a preimage, so path A (csp_ lookup by hash) can never match
-- it. That was chosen over making token_hash nullable because it touches no
-- existing column, constraint, index or query. token_prefix is 'oauth' so
-- the row reads as a sign-in agent from connector_tokens alone.
--
-- ADDITIVE ONLY
-- ---------------------------------------------------------------------------
-- One nullable column (every existing grant reads null = full access, as
-- today), one index, two new functions, and the guard re-created with one
-- extra frozen column. Nothing in 065's functions is changed or dropped.
--
-- FAILURE DIRECTION
-- ---------------------------------------------------------------------------
-- lib/oauth-grants.mjs fails OPEN when grant state cannot be read (a 3-second
-- blip must not disconnect a full-access client). That would be wrong for an
-- agent: failing open would make a scoped agent a full user. So the agent
-- token id also rides inside the OAuth code / access / refresh tokens
-- (`agt`, next to `gid`), and /api/mcp fails CLOSED for any token that
-- carries it: unreadable state, a missing or revoked agent row, or a link
-- that no longer matches → 401, never a fall back to the user.
--
-- ON DELETE SET NULL
-- ---------------------------------------------------------------------------
-- The UI never deletes a token (it revokes). If a row is deleted anyway, the
-- grant's link goes null; tokens issued on it still carry `agt`, and /api/mcp
-- refuses them because the link no longer matches. The grant does not
-- silently become a full-access one.
--
-- ROLLBACK (in this order — the first statement matters):
--   -- An agent-linked grant without its link would be a full-access grant.
--   -- Revoke them first so rolling back can never widen anyone's access.
--   update public.oauth_grants set revoked_at = now()
--    where agent_token_id is not null and revoked_at is null;
--   drop function if exists public.oauth_grant_approve(uuid, text, text, text[], text, text, text, uuid[], text);
--   drop function if exists public.oauth_grant_link_state(uuid);
--   -- restore 065's guard: re-run section 3 of 065_oauth_grants.sql
--   drop index if exists public.idx_oauth_grants_agent_token;
--   alter table public.oauth_grants drop column if exists agent_token_id;
--
-- Verified by EXECUTION in PGlite with the real chain (001…022, 065, 085,
-- 087 twice) and real RLS:  node scripts/_verify-oauth-agent.mjs
--
-- Apply order: after 065 and 085. Idempotent. NOT APPLIED until Eden approves.


-- ============================================================================
-- 1. The link
-- ============================================================================
alter table public.oauth_grants
  add column if not exists agent_token_id uuid
  references public.connector_tokens(id) on delete set null;

create index if not exists idx_oauth_grants_agent_token
  on public.oauth_grants(agent_token_id)
  where agent_token_id is not null;

comment on column public.oauth_grants.agent_token_id is
  'When set, this OAuth connection is that agent (connector_tokens kind=agent): '
  'it sees only the agent''s matter_scope, never a SecureSpace. Null = the user''s '
  'own full-access connection. Written only by oauth_grant_approve (service role).';

-- 065 granted SELECT on the whole table to authenticated, so a customer can
-- read the new column on their own rows (the Connections page shows
-- "connected as agent <name>"). The column-level UPDATE grant stays
-- revoked_at only; the guard below is the second lock.


-- ============================================================================
-- 2. The guard, with agent_token_id frozen too
--
-- Identical to 065 §3 except the one added line. SECURITY INVOKER plpgsql,
-- auth.uid() captured at entry (feedback_rls_security_invoker_wrappers).
-- ============================================================================
create or replace function public.oauth_grants_guard_update()
returns trigger
language plpgsql
security invoker
as $$
declare
  actor uuid := auth.uid();
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  if old.revoked_at is not null then
    raise exception 'oauth_grants: a revoked grant cannot be changed'
      using errcode = '42501';
  end if;
  if new.revoked_at is null then
    raise exception 'oauth_grants: the only permitted update is revocation'
      using errcode = '42501';
  end if;

  new.id               := old.id;
  new.user_id          := old.user_id;
  new.client_id_hash   := old.client_id_hash;
  new.client_id_prefix := old.client_id_prefix;
  new.client_name      := old.client_name;
  new.scopes           := old.scopes;
  new.notes            := old.notes;
  new.created_at       := old.created_at;
  new.last_used_at     := old.last_used_at;
  new.agent_token_id   := old.agent_token_id;   -- 087
  new.revoked_at       := now();
  new.revoked_by       := actor;
  return new;
end $$;

-- The trigger itself (065) is unchanged and still points at this function.


-- ============================================================================
-- 3. The consent write — both choices on the consent screen
--
-- p_matter_scope NULL  → "Connect as a full assistant" (today's behaviour).
-- p_matter_scope set   → "Connect as an agent" ('{}' = sees nothing).
--
-- The rule is one connection per (user, client), in one mode:
--
--   full, and the live grant is full     → attach to it ('attached'), as 065.
--   full, and the live grant is an agent → revoke that grant AND its agent
--                                          row, mint a new full grant
--                                          ('replaced'). A mode change is a
--                                          new grant, so no token issued in
--                                          one mode ever serves the other.
--   agent, and the live grant is linked  → update that agent's name,
--        to a live agent row               provider and matters to what was
--                                          just ticked; same grant, same
--                                          agent, its tasks kept ('attached').
--   agent, anything else                 → revoke the live grant (and any
--                                          agent row it had), create the
--                                          agent row, mint a grant linked to
--                                          it ('created' / 'replaced').
--
-- It does NOT decide whether the matters may be granted. /api/oauth-approve
-- checks, as the signed-in user, that every id is a matter the user can open
-- and that none is in a SecureSpace, before it calls this. The MCP server
-- enforces the seal again on every call regardless (the seal wins).
-- ============================================================================
create or replace function public.oauth_grant_approve(
  p_user_id        uuid,
  p_client_id      text,
  p_client_name    text    default null,
  p_scopes         text[]  default null,
  p_notes          text    default null,
  p_agent_name     text    default null,
  p_agent_provider text    default null,
  p_matter_scope   uuid[]  default null,
  p_token_hash     text    default null
)
returns table (grant_id uuid, agent_token_id uuid, outcome text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash       text    := public.oauth_grant_hash(p_client_id);
  v_name       text    := coalesce(nullif(p_client_name, ''), 'Unknown client');
  v_scopes     text[]  := coalesce(p_scopes, array['mcp']::text[]);
  v_live_id    uuid;
  v_live_token uuid;
  v_reusable   boolean := false;
  v_replaced   boolean := false;
  v_provider   text;
  v_agent_name text;
  v_scope      uuid[];
  v_token      uuid;
  v_gid        uuid;
begin
  if p_user_id is null or coalesce(p_client_id, '') = '' then
    raise exception 'oauth_grant_approve: p_user_id and p_client_id are required';
  end if;

  -- The live grant for this pair, locked so two consents cannot interleave.
  select g.id, g.agent_token_id
    into v_live_id, v_live_token
    from public.oauth_grants g
   where g.user_id = p_user_id
     and g.client_id_hash = v_hash
     and g.revoked_at is null
   for update;

  -- ---- full assistant -----------------------------------------------------
  if p_matter_scope is null then
    if v_live_id is not null and v_live_token is null then
      update public.oauth_grants set client_name = v_name where id = v_live_id;
      return query select v_live_id, null::uuid, 'attached'::text;
      return;
    end if;

    if v_live_id is not null then
      update public.oauth_grants
         set revoked_at = now(), revoked_by = p_user_id
       where id = v_live_id;
      update public.connector_tokens
         set revoked_at = now()
       where id = v_live_token and revoked_at is null;
      v_replaced := true;
    end if;

    insert into public.oauth_grants
      (user_id, client_id_hash, client_id_prefix, client_name, scopes, notes)
    values
      (p_user_id, v_hash, left(p_client_id, 12), v_name, v_scopes, p_notes)
    returning id into v_gid;

    return query select v_gid, null::uuid,
      case when v_replaced then 'replaced' else 'created' end;
    return;
  end if;

  -- ---- agent --------------------------------------------------------------
  v_provider := case
    when p_agent_provider in ('grok', 'chatgpt', 'claude', 'gemini', 'other') then p_agent_provider
    else 'other' end;
  v_agent_name := left(coalesce(nullif(btrim(p_agent_name), ''), v_name), 120);
  v_scope := coalesce(
    (select array_agg(distinct s) from unnest(p_matter_scope) as s where s is not null),
    '{}'::uuid[]);

  if v_live_id is not null and v_live_token is not null then
    select exists (
      select 1 from public.connector_tokens ct
       where ct.id = v_live_token
         and ct.user_id = p_user_id
         and ct.kind = 'agent'
         and ct.revoked_at is null
         and (ct.expires_at is null or ct.expires_at > now())
    ) into v_reusable;
  end if;

  if v_reusable then
    update public.connector_tokens
       set name = v_agent_name, agent_provider = v_provider, matter_scope = v_scope
     where id = v_live_token;
    update public.oauth_grants set client_name = v_name where id = v_live_id;
    return query select v_live_id, v_live_token, 'attached'::text;
    return;
  end if;

  if v_live_id is not null then
    update public.oauth_grants
       set revoked_at = now(), revoked_by = p_user_id
     where id = v_live_id;
    if v_live_token is not null then
      update public.connector_tokens
         set revoked_at = now()
       where id = v_live_token and revoked_at is null;
    end if;
    v_replaced := true;
  end if;

  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'oauth_grant_approve: an agent needs a 64-hex p_token_hash';
  end if;

  insert into public.connector_tokens
    (user_id, token_hash, token_prefix, name, kind, agent_provider, matter_scope)
  values
    (p_user_id, p_token_hash, 'oauth', v_agent_name, 'agent', v_provider, v_scope)
  returning id into v_token;

  insert into public.oauth_grants
    (user_id, client_id_hash, client_id_prefix, client_name, scopes, notes, agent_token_id)
  values
    (p_user_id, v_hash, left(p_client_id, 12), v_name, v_scopes,
     coalesce(p_notes, 'connected as an agent on the consent screen'), v_token)
  returning id into v_gid;

  return query select v_gid, v_token,
    case when v_replaced then 'replaced' else 'created' end;
end $$;


-- ============================================================================
-- 4. Read one grant's state, with its link
-- ============================================================================
create or replace function public.oauth_grant_link_state(p_grant_id uuid)
returns table (grant_id uuid, owner_id uuid, revoked boolean, client_name text, agent_token_id uuid)
language sql
security definer
stable
set search_path = public
as $$
  select g.id, g.user_id, (g.revoked_at is not null), g.client_name, g.agent_token_id
    from public.oauth_grants g
   where g.id = p_grant_id
$$;


-- Server-side only, as 065's functions are. A customer who could call
-- oauth_grant_approve could mint an agent (or a grant) they never consented
-- to on the consent screen.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.oauth_grant_approve(uuid, text, text, text[], text, text, text, uuid[], text)',
    'public.oauth_grant_link_state(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
