-- Contextspaces Migration 088: an agent can be given "All my matters
-- (except SecureSpaces)".
--
-- NOT APPLIED BY THE PR THAT ADDS IT. Eden pastes it into the SQL editor after
-- the PR merges. Apply order: after 085, 086 and 087. Idempotent: the file can
-- be pasted twice and converges to the same state.
--
-- WHY
-- ---------------------------------------------------------------------------
-- An agent (connector_tokens kind='agent', migration 085) sees only the
-- matters listed in matter_scope and their sub-matters. "Everything" could
-- only be had by ticking every matter, and a matter created the next day was
-- then outside the grant. Eden wants Grok to reach every matter he can see —
-- as an AGENT, so the task board, the per-agent meter and the per-agent
-- Record entries keep working.
--
-- WHAT THIS ADDS
-- ---------------------------------------------------------------------------
--   1. connector_tokens.scope_all boolean not null default false.
--      For kind='agent': true = every matter the owner can open, NOW OR
--      LATER, except sealed ones (SecureSpace tier B/C, own or inherited).
--      matter_scope is ignored while it is true (it stays non-null, per 085's
--      check; the app stores '{}'). Every existing row reads false, i.e.
--      exactly what it was. A check keeps it false on user tokens, where it
--      would mean nothing.
--   2. The browser may READ it: 086 granted SELECT on connector_tokens to
--      `authenticated` column by column (so token_hash stays server-only) and
--      a column added later is unreadable until granted. This grants
--      scope_all. The browser may WRITE it on its own agent rows under 003's
--      existing policies (owner-only INSERT/UPDATE); nothing new is needed
--      for that, and nothing is widened.
--   3. oauth_grant_approve (087) gains p_scope_all boolean default false, so
--      the consent screen's "Connect as an agent" can grant "All my matters".
--      Adding a parameter changes the function's signature, so the 9-argument
--      version is DROPPED explicitly and the 10-argument one created, with
--      087's service-role-only execute grants re-applied to it. Everything
--      else in its body is 087's, line for line.
--
-- THE SEAL STILL WINS
-- ---------------------------------------------------------------------------
-- scope_all never reaches a SecureSpace: /api/mcp computes the sealed set on
-- every call (as it does for every external connector) and an agent can
-- neither name nor list a sealed matter. The AI pause still applies.
-- send_to_sandbox and /api/ext/* stay refused to agents.
--
-- NOTE ON 086
-- ---------------------------------------------------------------------------
-- 086 §1 revokes every column's SELECT and re-grants a written-out list that
-- does not name scope_all. If 086 is ever pasted again after this file, paste
-- this file again too (or the Agents page will say it cannot read agents).
--
-- ROLLBACK (in this order — the first statement matters):
--   -- Without the column, a scope_all agent would read matter_scope '{}'
--   -- = sees nothing. That narrows, never widens; but say so to the user
--   -- first, and revoke what should not linger:
--   --   update public.connector_tokens set revoked_at = now()
--   --    where scope_all and revoked_at is null;   -- optional
--   drop function if exists public.oauth_grant_approve(uuid, text, text, text[], text, text, text, uuid[], text, boolean);
--   -- then re-run section 3 of 087_oauth_grant_agent_link.sql and its
--   -- closing grant block (the 9-argument function, service role only)
--   revoke select (scope_all) on public.connector_tokens from authenticated;
--   alter table public.connector_tokens drop constraint if exists connector_tokens_scope_all_agent_chk;
--   alter table public.connector_tokens drop column if exists scope_all;
--
-- Verified by EXECUTION in PGlite with the real chain (001…022, 062, 063,
-- 065, 085, 086, 087, then 088 twice) and real RLS:
--   node scripts/_verify-agent-scope-all.mjs


-- ============================================================================
-- 1. The column
-- ============================================================================
alter table public.connector_tokens
  add column if not exists scope_all boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'connector_tokens_scope_all_agent_chk'
       and conrelid = 'public.connector_tokens'::regclass
  ) then
    alter table public.connector_tokens
      add constraint connector_tokens_scope_all_agent_chk
      check (not scope_all or kind = 'agent');
  end if;
end $$;

comment on column public.connector_tokens.scope_all is
  'For kind=agent: true = every matter the owner can open, now or later, except '
  'SecureSpaces (sealed tier B/C, inherited). matter_scope is ignored while true. '
  'False (the default) = only matter_scope and its sub-matters. Migration 088.';


-- ============================================================================
-- 2. The browser may read it (086 granted SELECT column by column)
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select (scope_all) on table public.connector_tokens to authenticated;
  else
    raise notice 'migration 088: role authenticated does not exist here — skipping the grant';
  end if;
end $$;


-- ============================================================================
-- 3. The consent write, with "All my matters"
--
-- Identical to 087 §3 except:
--   * p_scope_all (10th parameter, default false);
--   * an agent with p_scope_all stores matter_scope '{}' and scope_all true;
--   * reusing the live agent sets scope_all too, so re-consent can move an
--     agent from a list to "all" and back.
-- ============================================================================
drop function if exists public.oauth_grant_approve(uuid, text, text, text[], text, text, text, uuid[], text);

create or replace function public.oauth_grant_approve(
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
declare
  v_hash       text    := public.oauth_grant_hash(p_client_id);
  v_name       text    := coalesce(nullif(p_client_name, ''), 'Unknown client');
  v_scopes     text[]  := coalesce(p_scopes, array['mcp']::text[]);
  v_all        boolean := coalesce(p_scope_all, false);
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
  if p_matter_scope is null and not v_all then
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
  v_scope := case when v_all then '{}'::uuid[] else coalesce(
    (select array_agg(distinct s) from unnest(p_matter_scope) as s where s is not null),
    '{}'::uuid[]) end;

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
       set name = v_agent_name, agent_provider = v_provider,
           matter_scope = v_scope, scope_all = v_all
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
    (user_id, token_hash, token_prefix, name, kind, agent_provider, matter_scope, scope_all)
  values
    (p_user_id, p_token_hash, 'oauth', v_agent_name, 'agent', v_provider, v_scope, v_all)
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

-- Server-side only, exactly as 087 grants it. A customer who could call
-- oauth_grant_approve could mint an agent (or a grant) they never consented
-- to on the consent screen.
do $$
declare
  f text := 'public.oauth_grant_approve(uuid, text, text, text[], text, text, text, uuid[], text, boolean)';
begin
  execute format('revoke all on function %s from public', f);
  execute format('revoke all on function %s from anon', f);
  execute format('revoke all on function %s from authenticated', f);
  execute format('grant execute on function %s to service_role', f);
end $$;

notify pgrst, 'reload schema';
