-- Contextspaces Migration 086: the launch sweep
--
-- NOT APPLIED BY THE PR THAT ADDS IT. Eden pastes it into the SQL editor after
-- the PR merges. Apply order: after 063, 067 and 085 (it names 085's columns
-- and 063's tables). Every section is idempotent — the file can be pasted
-- twice and converges to the same state.
--
-- Sections:
--   1. connector_tokens.token_hash is server-only (column-level SELECT grants).
--   2. The connector rate ceilings: usage_budgets rows for kind 'connector'
--      (per account) and 'connector_agent' (per agent token), per plan.
--   3. connector_rate_consume() — the one round trip api/mcp.mjs makes before
--      every tool call to count it against those ceilings.
--
-- Rollback is written at the end of each section.
--
-- Code/SQL order: the code on this branch works BEFORE 086 is applied (the
-- rate RPC is missing, which the meter treats as "no rate ceiling yet" and
-- admits; costed calls are still charged through 063/067's usage_consume). So
-- merge first, then paste.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- 1. connector_tokens.token_hash is server-only
-- ===========================================================================
--
-- WHAT IS WRONG TODAY. The Connect pages (Claude / ChatGPT / Gemini / Grok)
-- and Connections › Agents mint a connector token in the browser, hash it
-- there, and INSERT the row. 003's policy then lets the owner SELECT that row
-- back — every column, because Supabase's blanket default grant gives
-- `authenticated` SELECT on every column of every table in `public`. So a
-- signed-in browser can ask PostgREST for its own `token_hash`. It is a
-- SHA-256 of a random 32-byte token, so it cannot be reversed — but it is the
-- exact value the MCP endpoint looks a bearer token up by, nothing in the
-- browser has any use for it, and the rule this project keeps for credentials
-- (080, `connections.encrypted_refresh_token`) is that Postgres refuses, not
-- that our code is careful.
--
-- WHAT THIS SECTION DOES. Exactly what 080 did for `connections`:
--   (a) the table-wide SELECT grant is taken from `anon` and `authenticated`;
--   (b) any leftover column-level SELECT grant is taken too, so a database
--       where someone once granted a column by hand converges to the same
--       place as a clean one;
--   (c) SELECT is granted back to `authenticated` on the named columns only —
--       every column except `token_hash`. The list is written out rather than
--       computed, so a column a later migration adds is unreadable by the
--       browser until somebody names it here. `anon` gets nothing back: no
--       policy has ever let an anonymous caller see a token row.
--   INSERT, UPDATE and DELETE are NOT touched. The browser still inserts the
--   row with its hash (a write, not a read), still revokes by UPDATE, and
--   still deletes. `service_role` is never mentioned, so api/mcp.mjs and
--   lib/connector-token-auth.mjs keep reading the hash exactly as before.
--
-- CONSEQUENCES YOU SHOULD KNOW ABOUT.
--   * `select=*` on connector_tokens now fails as `authenticated`
--     (42501 permission denied) — Postgres expands the star before it checks
--     column privileges. Every browser read already names its columns
--     (ClaudeConnect / ChatGPTConnect / GeminiConnect / GrokConnect,
--     Connections.tsx, useFirstRun.ts, src/lib/agentTokens.ts through
--     src/lib/agents-schema.ts readUserTokens), and
--     scripts/_verify-connector-token-columns.mjs fails CI if a `*` or
--     `token_hash` ever appears in a src/ read of this table.
--   * The hash cannot be used as an oracle either: naming it in WHERE or
--     ORDER BY is refused for the same reason.
--   * A browser write that chains `.select()` (RETURNING a representation)
--     would be refused if it asked for token_hash; none does — every insert
--     and update in src/ is bare, which PostgREST sends as RETURNING 1.
--
-- WHAT YOU WILL SEE WHEN YOU PASTE THIS. Step (b) revokes column SELECT on
-- every column for both roles, and where no such grant was ever made Postgres
-- says so: `WARNING: no privileges could be revoked for column "..." of
-- relation "connector_tokens"` — about two dozen of them. They are expected
-- and are NOT a failure. The only line that means something went wrong is an
-- ERROR, and the assertion at the end of this section raises one if the hash
-- is still readable.
--
-- ROLLBACK (restores Supabase's blanket default):
--   grant select on table public.connector_tokens to anon, authenticated;

do $$
declare
  browser_role  text;
  col           text;
  safe_columns  constant text[] := array[
    'id',
    'user_id',
    'token_prefix',
    'name',
    'scopes',
    'created_at',
    'last_used_at',
    'revoked_at',
    'expires_at',
    -- 085
    'kind',
    'agent_provider',
    'matter_scope'
  ];
begin
  foreach browser_role in array array['anon', 'authenticated'] loop
    if not exists (select 1 from pg_roles where rolname = browser_role) then
      raise notice 'migration 086: role % does not exist here — skipping', browser_role;
      continue;
    end if;

    -- (a)
    execute format('revoke select on table public.connector_tokens from %I', browser_role);

    -- (b)
    for col in
      select a.attname
        from pg_attribute a
       where a.attrelid = 'public.connector_tokens'::regclass
         and a.attnum > 0
         and not a.attisdropped
    loop
      execute format(
        'revoke select (%I) on table public.connector_tokens from %I', col, browser_role);
    end loop;

    -- (c) authenticated only. A column the list names that this database does
    -- not have yet (085 never pasted) is skipped, not an error.
    if browser_role = 'authenticated' then
      for col in
        select a.attname
          from pg_attribute a
         where a.attrelid = 'public.connector_tokens'::regclass
           and a.attnum > 0
           and not a.attisdropped
           and a.attname = any (safe_columns)
         order by a.attnum
      loop
        execute format(
          'grant select (%I) on table public.connector_tokens to %I', col, browser_role);
      end loop;
    end if;
  end loop;
end
$$;

comment on column public.connector_tokens.token_hash is
  'SERVER ONLY. SHA-256 hex of the opaque connector token. The browser may INSERT it '
  'but holds no SELECT privilege on it (migration 086); only service-role code in api/ '
  'and lib/ reads it. Do not grant it back.';

-- Assert, against the same catalog the planner consults. has_column_privilege()
-- accounts for table-level grants, role inheritance and PUBLIC. If a browser
-- role can still read token_hash, this raises and the section rolls back.
do $$
declare
  leaked text;
begin
  select string_agg(format('%s readable by %s', a.attname, r.rolname), ', ')
    into leaked
    from pg_attribute a
    cross join (
      select rolname from pg_roles where rolname in ('anon', 'authenticated')
    ) r
   where a.attrelid = 'public.connector_tokens'::regclass
     and a.attnum > 0
     and not a.attisdropped
     and a.attname = 'token_hash'
     and has_column_privilege(r.rolname, 'public.connector_tokens', a.attname, 'SELECT');

  if leaked is not null then
    raise exception
      'migration 086 did not close the browser''s read of connector_tokens.token_hash: %', leaked;
  end if;
end
$$;


-- ===========================================================================
-- 2. The connector rate ceilings — rows in usage_budgets, where the caps live
-- ===========================================================================
--
-- WHAT IS WRONG TODAY. api/mcp.mjs runs every tool call with no meter and no
-- cap. Since 085 an agent token (a Grok bot on a schedule) can call it
-- unattended, so a loop can run searches, file documents and queue OCR
-- without bound while the in-app paths are metered and capped.
--
-- WHAT THIS SECTION DOES. Adds two `kind`s to 063's usage_budgets, per plan:
--   * 'connector'       — every connector tool call on the ACCOUNT, from any
--                         connection (Claude, ChatGPT, Gemini, Grok, OAuth,
--                         agents), per window_seconds.
--   * 'connector_agent' — every call from ONE agent token, per window_seconds.
-- Only window_seconds and window_max_requests are read. monthly_cents stays
-- null: MONEY is charged through usage_consume on the same wallet as the app
-- (kind 'ingest' for file_document / ingest_document), not through these rows.
-- null window_max_requests = unlimited, which is what 'workshop' gets.
--
-- THE DEFAULTS, and why. The window is one hour. A lawyer's assistant doing a
-- heavy research turn makes perhaps 20–60 tool calls; a scheduled agent that
-- wakes, reads its tasks and does one piece of work makes a few dozen, and one
-- that polls my_tasks every 30 seconds while it waits makes 120 an hour. A
-- runaway loop at one call a second makes 3,600.
--
--   plan       per account / hour    per agent token / hour
--   free                600                    240
--   basic              1000                    400
--   pro                1500                    600
--   max                3000                   1200
--   workshop       unlimited              unlimited
--
-- A tier with no row reads the 'free' row: an unknown tier is never unlimited.
-- These are `on conflict do nothing`, so once Eden edits a number a second
-- paste of this file does not put it back. To change one:
--   update public.usage_budgets set window_max_requests = 2000
--    where pricing_tier = 'pro' and kind = 'connector';
--
-- ROLLBACK:
--   delete from public.usage_budgets where kind in ('connector', 'connector_agent');

insert into public.usage_budgets
  (pricing_tier, kind, monthly_cents, window_seconds, window_max_requests,
   max_output_tokens, max_request_bytes, note)
values
  ('free',     'connector',       null, 3600,  600, null, null, '086 default — connector tool calls per account per hour'),
  ('free',     'connector_agent', null, 3600,  240, null, null, '086 default — calls per agent token per hour'),
  ('basic',    'connector',       null, 3600, 1000, null, null, '086 default — connector tool calls per account per hour'),
  ('basic',    'connector_agent', null, 3600,  400, null, null, '086 default — calls per agent token per hour'),
  ('pro',      'connector',       null, 3600, 1500, null, null, '086 default — connector tool calls per account per hour'),
  ('pro',      'connector_agent', null, 3600,  600, null, null, '086 default — calls per agent token per hour'),
  ('max',      'connector',       null, 3600, 3000, null, null, '086 default — connector tool calls per account per hour'),
  ('max',      'connector_agent', null, 3600, 1200, null, null, '086 default — calls per agent token per hour'),
  ('workshop', 'connector',       null, 3600, null, null, null, 'Eden''s own account — unlimited by design'),
  ('workshop', 'connector_agent', null, 3600, null, null, null, 'Eden''s own account — unlimited by design')
on conflict (pricing_tier, kind) do nothing;


-- ===========================================================================
-- 3. connector_rate_consume(p_user, p_agent_token) — count one connector call
-- ===========================================================================
--
-- One round trip before every connector tool call. It counts the call in
-- 063's usage_windows (the same table and the same row-lock mechanism
-- usage_consume uses, so two calls arriving together serialise), first
-- against the agent token's own window when the caller is an agent, then
-- against the account's. It charges NOTHING and writes no usage_events row:
-- a free read costs nothing, and a costed call is charged separately through
-- usage_consume, where the wallet and the credits live.
--
-- What it stores: user_id, kind ('connector' | 'connector_agent'), a window
-- key (the window's start, prefixed by the agent token's id for an agent), a
-- count, an expiry. No tool name, no argument, no query, no document — there
-- is nowhere in these rows for content to go.
--
-- The answer is jsonb: {allowed, reason, status, tier, scope, window_seconds,
-- window_max_requests, window_requests, retry_after_seconds, reset_at}. A
-- refusal is status 429 with reason 'over_agent_rate' or 'over_connector_rate'
-- and reset_at (epoch seconds) so the caller can say "resets at 15:00 UTC".
-- 'workshop' is admitted before anything is counted: it is never refused,
-- whatever the rows say.
--
-- service_role only. The caller (api/mcp.mjs, through lib/connector-meter.mjs)
-- has already authenticated the token and passes its owner; a browser has no
-- reason to call it and is not granted it.
--
-- ROLLBACK:
--   drop function if exists public.connector_rate_consume(uuid, uuid);
--   delete from public.usage_windows where kind in ('connector', 'connector_agent');

create or replace function public.connector_rate_consume(
  p_user        uuid,
  p_agent_token uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier      text;
  v_acct      public.usage_budgets%rowtype;
  v_agent     public.usage_budgets%rowtype;
  v_secs      integer;
  v_start     timestamptz;
  v_key       text;
  v_reqs      integer;
  v_acct_reqs integer := null;
  v_agent_reqs integer := null;
begin
  if p_user is null then
    return jsonb_build_object('allowed', false, 'reason', 'unauthenticated', 'status', 401);
  end if;

  select p.pricing_tier into v_tier from public.profiles p where p.id = p_user;
  v_tier := coalesce(nullif(trim(v_tier), ''), 'free');

  if v_tier = 'workshop' then
    return jsonb_build_object('allowed', true, 'reason', 'ok', 'status', 200,
      'tier', v_tier, 'scope', 'unlimited');
  end if;

  select * into v_acct from public.usage_budgets where pricing_tier = v_tier and kind = 'connector';
  if not found then
    select * into v_acct from public.usage_budgets where pricing_tier = 'free' and kind = 'connector';
  end if;
  select * into v_agent from public.usage_budgets where pricing_tier = v_tier and kind = 'connector_agent';
  if not found then
    select * into v_agent from public.usage_budgets where pricing_tier = 'free' and kind = 'connector_agent';
  end if;

  delete from public.usage_windows w
   where w.user_id = p_user
     and w.kind in ('connector', 'connector_agent')
     and w.expires_at < now() - interval '1 hour';

  -- ---- the agent token's own window ----------------------------------------
  if p_agent_token is not null and v_agent.window_max_requests is not null then
    v_secs  := greatest(coalesce(v_agent.window_seconds, 3600), 1);
    v_start := to_timestamp(floor(extract(epoch from now()) / v_secs) * v_secs);
    v_key   := p_agent_token::text || '@'
               || to_char(v_start at time zone 'utc', 'YYYYMMDD"T"HH24MISS');
    insert into public.usage_windows (user_id, kind, window_key, requests, expires_at)
    values (p_user, 'connector_agent', v_key, 1, v_start + make_interval(secs => v_secs * 2))
    on conflict (user_id, kind, window_key) do update
      set requests = public.usage_windows.requests + 1
    returning requests into v_reqs;
    v_agent_reqs := v_reqs;

    if v_reqs > v_agent.window_max_requests then
      return jsonb_build_object(
        'allowed', false, 'reason', 'over_agent_rate', 'status', 429,
        'message', 'This agent connection has made as many calls as it may this hour.',
        'tier', v_tier, 'scope', 'agent',
        'window_seconds', v_secs, 'window_max_requests', v_agent.window_max_requests,
        'window_requests', v_reqs,
        'reset_at', extract(epoch from v_start)::bigint + v_secs,
        'retry_after_seconds',
          greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => v_secs) - now())))::integer));
    end if;
  end if;

  -- ---- the account's window -------------------------------------------------
  if v_acct.window_max_requests is not null then
    v_secs  := greatest(coalesce(v_acct.window_seconds, 3600), 1);
    v_start := to_timestamp(floor(extract(epoch from now()) / v_secs) * v_secs);
    v_key   := to_char(v_start at time zone 'utc', 'YYYYMMDD"T"HH24MISS');
    insert into public.usage_windows (user_id, kind, window_key, requests, expires_at)
    values (p_user, 'connector', v_key, 1, v_start + make_interval(secs => v_secs * 2))
    on conflict (user_id, kind, window_key) do update
      set requests = public.usage_windows.requests + 1
    returning requests into v_reqs;
    v_acct_reqs := v_reqs;

    if v_reqs > v_acct.window_max_requests then
      return jsonb_build_object(
        'allowed', false, 'reason', 'over_connector_rate', 'status', 429,
        'message', 'This account has made as many connector calls as its plan allows this hour.',
        'tier', v_tier, 'scope', 'account',
        'window_seconds', v_secs, 'window_max_requests', v_acct.window_max_requests,
        'window_requests', v_reqs,
        'reset_at', extract(epoch from v_start)::bigint + v_secs,
        'retry_after_seconds',
          greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => v_secs) - now())))::integer));
    end if;
  end if;

  return jsonb_build_object(
    'allowed', true, 'reason', 'ok', 'status', 200, 'tier', v_tier,
    'scope', case when p_agent_token is null then 'account' else 'agent' end,
    'window_requests', v_acct_reqs, 'window_max_requests', v_acct.window_max_requests,
    'agent_window_requests', v_agent_reqs, 'agent_window_max_requests', v_agent.window_max_requests);
end $$;

revoke all on function public.connector_rate_consume(uuid, uuid) from public, anon, authenticated;
grant execute on function public.connector_rate_consume(uuid, uuid) to service_role;


notify pgrst, 'reload schema';
