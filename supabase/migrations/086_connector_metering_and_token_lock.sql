-- Contextspaces Migration 086: the launch sweep
--
-- NOT APPLIED BY THE PR THAT ADDS IT. Eden pastes it into the SQL editor after
-- the PR merges. Apply order: after 085 (it names 085's columns). Every section
-- is idempotent — the file can be pasted twice and converges to the same state.
--
-- Sections:
--   1. connector_tokens.token_hash is server-only (column-level SELECT grants).
--
-- Rollback, per section, is written at the end of each section.
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


notify pgrst, 'reload schema';
