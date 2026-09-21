-- Contextspaces Migration 080: a connection's stored token is server-only
--
-- WHAT IS WRONG TODAY. public.connections holds one row per (user,
-- integration) for Gmail / Google Calendar / Google Drive / OneDrive /
-- Dropbox. Its durable credential lives in `encrypted_refresh_token`
-- (AES-256-GCM, app-layer, key in CONNECTIONS_ENC_KEY — see
-- lib/connections-crypto.mjs). RLS lets a signed-in user SELECT their own
-- rows, and Supabase's blanket default grant gives `authenticated` SELECT on
-- every column of every table in `public`. Put together, that means a signed-in
-- browser can ask PostgREST for its own `encrypted_refresh_token` and be given
-- it. It is ciphertext, not a live token — but it is the stored credential for
-- the user's mailbox and cloud drive, and nothing in the browser has any use
-- for it. The only code that needs it is `/api/*`, which reads with the service
-- role. So it should never leave the server, encrypted or not.
--
-- The front-end never asked for the column. That is not a defence: nothing
-- stopped it, and `select=*` — or one careless `.select('*')` in a future
-- hook — would have handed it over. This migration moves the guarantee from
-- "our code is careful" to "Postgres refuses".
--
-- WHAT THIS FILE DOES. Column-level SELECT privileges, not a view.
--   * The table-wide SELECT grant is taken away from `anon` and
--     `authenticated`, and SELECT is granted back on the named non-credential
--     columns only.
--   * Column privileges are checked by Postgres itself, on every statement,
--     for every client — PostgREST, a leaked anon key, psql, anything holding
--     a user JWT. They are not a filter the caller can decline.
--   * The table keeps its name, so every existing reader, policy and foreign
--     key is untouched, and the browser's disconnect (DELETE) still works.
--   * `service_role` is never mentioned, so the /api handlers are unaffected.
--
-- Why not a `security_invoker` view: a view would need every browser reader
-- repointed at a new name, and the DELETE the Connections page performs would
-- have to travel through an auto-updatable view. Column grants achieve the
-- same refusal with one object instead of two, and cannot be bypassed by
-- someone who goes back to the base table.
--
-- WHAT YOU WILL SEE WHEN YOU PASTE THIS. Step 1(b) below revokes column-level
-- SELECT on every column for both browser roles, and on a database where no
-- such column grant was ever made there is nothing to take away. Postgres says
-- so, once per column per role: `WARNING: no privileges could be revoked for
-- column "..." of relation "connections"`. About twenty of those are expected
-- and are NOT a failure — the SQL editor prints warnings and errors in the
-- same place. The only line that means something went wrong is an ERROR, and
-- the assertion at the bottom of this file raises one if the door is still
-- open. If THAT assertion fires, the likeliest cause is a grant made by some
-- other role: REVOKE only removes grants the current role issued, so re-run
-- this file as the role that granted it (`\dp public.connections` in psql, or
-- the `attacl` column of pg_attribute, names the grantor after the `/`).
--
-- CONSEQUENCE YOU SHOULD KNOW ABOUT: `select=*` NOW FAILS, LOUDLY.
-- With a column-level grant in place, `select * from public.connections` as
-- `authenticated` raises `42501 permission denied for table connections` —
-- Postgres expands the star before it checks privileges, so it sees the
-- ungranted column and refuses the whole statement. PostgREST passes that
-- error straight back. Every browser read of this table must therefore name
-- its columns. They all do (src/hooks/useConnections.ts, which now takes them
-- from one exported constant), and scripts/_verify-connections-columns.mjs
-- fails CI if a `*` or a credential column ever appears in src/ again.
--
-- TWO PostgREST BEHAVIOURS THIS RELIES ON, both true of the version Supabase
-- runs and neither exercised by the harness (which speaks SQL, not HTTP):
--   * a request with no `select=`, or with `select=*`, becomes `"connections".*`
--     in the generated SELECT list — which is why a star fails rather than
--     silently returning the granted columns; and
--   * a mutation with no `?select=` is generated with `RETURNING 1`, not
--     `RETURNING *`. That is the only reason the Connections page's
--     `.delete().eq('id', …)` still works under these grants. A `.select()`
--     chained onto a write of this table would ask for a representation and
--     be refused — see the note on disconnectConnection in
--     src/hooks/useConnections.ts.
--
-- APPLY ORDER. After 075. Relative to the front-end deploy the order does NOT
-- matter, and that is on purpose: the code already on main names its columns
-- explicitly, and an explicit column list is served identically under the old
-- blanket grant and under the new column grants. There is no minute in which
-- the live Connections page is broken, in either direction. The recommended
-- order is still MERGE FIRST, THEN APPLY — so that the exported constant and
-- the CI guard are on main before the grant lands, and nobody reintroduces a
-- `*` into a build that would then start failing in production.
--
-- Idempotent: it converges to the same ACLs from any starting state and
-- asserts the result at the end. Running it twice changes nothing.

-- ---------------------------------------------------------------------------
-- 0. The base table, so this file also applies to a database where 026 / 075
--    were never pasted — the class of drift this project has hit before (see
--    026's and 047's notes). On a database that has the table this is a no-op.
-- ---------------------------------------------------------------------------
create table if not exists public.connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,
  status text not null default 'connected'
    check (status in ('connected', 'needs_attention')),
  connected_email text,
  scopes text,
  encrypted_refresh_token text not null,
  last_verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, kind)
);

create index if not exists idx_connections_user on public.connections(user_id);

alter table public.connections enable row level security;

-- Unchanged from 026/075, restated so this file stands on its own: a user may
-- read and delete their own connections, and nothing else. There is still no
-- INSERT or UPDATE policy — rows are written only by the server-side OAuth
-- callbacks with the service role.
drop policy if exists "View own connections" on public.connections;
create policy "View own connections"
  on public.connections for select
  using (user_id = auth.uid());

drop policy if exists "Delete own connections" on public.connections;
create policy "Delete own connections"
  on public.connections for delete
  using (user_id = auth.uid());

comment on column public.connections.encrypted_refresh_token is
  'SERVER ONLY. AES-256-GCM ciphertext of the provider refresh token. '
  'anon/authenticated hold no SELECT privilege on this column (migration 080); '
  'only service-role code in api/ and lib/ may read it. Do not grant it back.';

-- ---------------------------------------------------------------------------
-- 1. The privilege change itself.
--
--    For each browser role that exists on this database:
--      (a) drop the table-wide SELECT grant. This has to happen first and
--          cannot be skipped: privileges in Postgres are additive, and a
--          table-level grant covers every column, so a column-level REVOKE on
--          top of it removes nothing. (Verified against real Postgres in
--          scripts/_verify-connections-columns.mjs.)
--      (b) drop any leftover column-level SELECT grant on EVERY column, so a
--          database where someone once granted a column by hand converges to
--          the same place as a clean one.
--      (c) grant SELECT back on the non-credential columns, and only those.
--          The list is written out here rather than computed, so a column
--          added by a later migration — an access-token cache, a second
--          secret — is unreadable by the browser by default and stays that
--          way until somebody deliberately names it.
--      (d) revoke INSERT and UPDATE entirely. No policy has ever allowed the
--          browser to write this table, so nothing loses a working path; what
--          this closes is UPDATE ... RETURNING, which is a READ dressed as a
--          write and the shape that has caught this project's RLS before.
--          DELETE is untouched — the Connections page's "Disconnect" uses it.
--
--    Roles are looked up before use because a local or PGlite database may not
--    have Supabase's roles at all.
-- ---------------------------------------------------------------------------
do $$
declare
  browser_role  text;
  col           text;
  safe_columns  constant text[] := array[
    'id',
    'user_id',
    'kind',
    'status',
    'connected_email',
    'scopes',
    'last_verified_at',
    'last_error',
    'created_at',
    'updated_at'
  ];
begin
  foreach browser_role in array array['anon', 'authenticated'] loop
    if not exists (select 1 from pg_roles where rolname = browser_role) then
      raise notice 'migration 080: role % does not exist here — skipping', browser_role;
      continue;
    end if;

    -- (a)
    execute format('revoke select on table public.connections from %I', browser_role);

    -- (b)
    for col in
      select a.attname
        from pg_attribute a
       where a.attrelid = 'public.connections'::regclass
         and a.attnum > 0
         and not a.attisdropped
    loop
      execute format(
        'revoke select (%I) on table public.connections from %I', col, browser_role);
    end loop;

    -- (c)
    for col in
      select a.attname
        from pg_attribute a
       where a.attrelid = 'public.connections'::regclass
         and a.attnum > 0
         and not a.attisdropped
         and a.attname = any (safe_columns)
       order by a.attnum
    loop
      execute format(
        'grant select (%I) on table public.connections to %I', col, browser_role);
    end loop;

    -- (d)
    execute format('revoke insert, update on table public.connections from %I', browser_role);
  end loop;
end
$$;

-- The browser's only write is the disconnect. Granted explicitly rather than
-- left to Supabase's blanket default, so this file is also correct on a
-- database built from the migrations folder alone. RLS still restricts it to
-- the caller's own rows, and `anon` is deliberately not granted it.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant delete on table public.connections to authenticated;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Assert the result, in the migration, against the same catalog the planner
--    consults. has_column_privilege() accounts for table-level grants, role
--    inheritance and PUBLIC, so this cannot be fooled by a grant made
--    somewhere else. If anything a browser role can still read is not on the
--    safe list, this raises and the whole migration rolls back rather than
--    reporting success over an open door.
-- ---------------------------------------------------------------------------
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
   where a.attrelid = 'public.connections'::regclass
     and a.attnum > 0
     and not a.attisdropped
     and a.attname <> all (array[
       'id', 'user_id', 'kind', 'status', 'connected_email', 'scopes',
       'last_verified_at', 'last_error', 'created_at', 'updated_at'
     ])
     and has_column_privilege(r.rolname, 'public.connections', a.attname, 'SELECT');

  if leaked is not null then
    raise exception
      'migration 080 did not close the browser''s read of public.connections: %', leaked;
  end if;
end
$$;

notify pgrst, 'reload schema';
