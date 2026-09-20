-- Context.ai Migration 065: per-connection OAuth grants
--
-- The hole this closes
-- ---------------------------------------------------------------------------
-- Every OAuth connection to the hosted MCP endpoint is stateless. /api/oauth-
-- approve mints a signed authorization code, /api/oauth-token mints an HS256
-- access token (12 h) and refresh token (30 d), and NOT ONE ROW IS WRITTEN
-- ANYWHERE. Two consequences, both live in production today:
--
--   1. The Connections page cannot truthfully say "Connected". It reads
--      connector_tokens, which an OAuth connection never touches, so a
--      customer who just connected claude.ai was told "Not connected"
--      (PR #157 removed the false badge and said this table was needed).
--   2. There is no way to revoke ONE client. The only lever is rotating
--      MCP_OAUTH_SECRET, which invalidates every token every customer holds
--      — "revoke Claude on my laptop" and "log out every paying customer"
--      are the same button.
--
-- This table is the record an approval leaves behind. The token carries the
-- grant's id (`gid`); /api/mcp checks the grant before serving a tool call;
-- /api/oauth-token refuses to refresh a revoked one. Revocation is a soft
-- state — the row stays as the account's history of who was let in and when.
--
-- The INVOKER memo (feedback_rls_security_invoker_wrappers) and why no
-- wrapper appears below
-- ---------------------------------------------------------------------------
-- That memo's hazard is a policy expression calling a SECURITY DEFINER +
-- STABLE SQL function: inside one, auth.uid() comes back inconsistent in this
-- project. The policies here consult nothing — they are bare
-- `user_id = auth.uid()`, the same shape migration 003 uses on
-- connector_tokens — so there is no DEFINER function in a policy expression
-- and the hazard cannot arise. Adding a wrapper for appearance would add a
-- plpgsql call per row and prove nothing.
--
-- The one function that DOES read auth.uid() in a policy-adjacent context is
-- the BEFORE UPDATE guard, and it follows the memo exactly: SECURITY INVOKER
-- plpgsql, auth.uid() captured into a declared variable at entry.
--
-- Belt and braces, after 062
-- ---------------------------------------------------------------------------
-- Column privileges are the tidy answer and PostgREST honours them, but they
-- are one `grant all on all tables in schema public to authenticated` away
-- from being silently undone — a line that appears in Supabase's own
-- bootstrap. So the guarantee that a customer cannot un-revoke a grant,
-- rename it, or move it onto someone else's account is a BEFORE UPDATE
-- trigger that refuses every transition but "active becomes revoked", for
-- every role except the service role. scripts/_verify-oauth-grants.mjs
-- re-runs the blanket grant after 065 and shows the trigger still holds.
--
-- Writes are server-side only
-- ---------------------------------------------------------------------------
-- Minting a grant and stamping last_used_at happen in SECURITY DEFINER
-- functions whose EXECUTE is revoked from public/anon/authenticated and
-- granted to service_role alone. A customer holds exactly two verbs on this
-- table: read my own grants, revoke my own grant. There is no INSERT policy
-- and no DELETE policy for anybody — deleting the user cascades the rows
-- away, and nothing else removes them.
--
-- Idempotent on purpose: the live database is known to drift from this folder
-- (several migrations here were never applied; 047 records the same class of
-- drift on policies). Every statement is create-if-not-exists /
-- create-or-replace / drop-then-create. Running it twice is a no-op, and the
-- harness runs it twice to prove it.
--
-- Apply order: after 063. Safe to apply while the app is running — before the
-- matching code deploys, nothing reads or writes this table; after it
-- deploys, a token with no grant id behaves exactly as it does today until
-- the cut-off in lib/oauth-grants.mjs.


-- ============================================================================
-- 1. The table
--
-- client_id is NOT stored. It is a ~500-character signed JWT (the stateless
-- dynamic-client-registration record from /api/oauth-register), and nothing
-- here needs to read it back: every lookup arrives holding the client_id and
-- matches on its SHA-256. What is stored is the hash, a 12-character prefix
-- for support ("which registration was that?", the convention migration 003
-- uses for connector tokens), and the client's self-declared name at the
-- moment of consent — a snapshot, because the client can re-register under
-- any name it likes later.
-- ============================================================================
create table if not exists public.oauth_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  client_id_hash text not null,          -- sha256 hex of the client_id JWT
  client_id_prefix text,                 -- first 12 chars, for support only
  client_name text not null default 'Unknown client',
  scopes text[] not null default array['mcp']::text[],
  notes text,                            -- e.g. how the grant came to exist
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.profiles(id) on delete set null
);

-- Columns, added separately so the migration also repairs a partially
-- applied table rather than failing on `create table if not exists`.
alter table public.oauth_grants add column if not exists client_id_prefix text;
alter table public.oauth_grants add column if not exists notes text;
alter table public.oauth_grants add column if not exists last_used_at timestamptz;
alter table public.oauth_grants add column if not exists revoked_at timestamptz;
alter table public.oauth_grants add column if not exists revoked_by uuid;

create index if not exists idx_oauth_grants_user
  on public.oauth_grants(user_id);

-- At most ONE active grant per (user, client). Re-approving the same client
-- attaches to the grant that already exists instead of piling up rows, and
-- the partial predicate keeps every revoked row as history.
create unique index if not exists uq_oauth_grants_active
  on public.oauth_grants(user_id, client_id_hash)
  where revoked_at is null;

comment on table public.oauth_grants is
  'One row per AI client a user has approved over OAuth. The access and '
  'refresh tokens carry this row''s id as `gid`; revoking the row cuts that '
  'one client off without touching any other client or any other customer.';


-- ============================================================================
-- 2. RLS — read mine, revoke mine, nothing else
-- ============================================================================
alter table public.oauth_grants enable row level security;

drop policy if exists "Users read their own OAuth grants" on public.oauth_grants;
create policy "Users read their own OAuth grants"
  on public.oauth_grants for select
  using (user_id = auth.uid());

-- The USING clause decides which rows a customer may touch; the guard trigger
-- below decides what the touch is allowed to do to them.
drop policy if exists "Users revoke their own OAuth grants" on public.oauth_grants;
create policy "Users revoke their own OAuth grants"
  on public.oauth_grants for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- No INSERT policy, no DELETE policy. Grants are minted server-side and
-- revoked softly.

revoke all on public.oauth_grants from anon;
revoke all on public.oauth_grants from authenticated;
grant select on public.oauth_grants to authenticated;
grant update (revoked_at) on public.oauth_grants to authenticated;
-- Supabase's own bootstrap grants this, but the table whose entire purpose is
-- server-side writes should not depend on a line in someone else's script.
grant all on public.oauth_grants to service_role;


-- ============================================================================
-- 3. The guard: the only update a customer may make is a revocation
--
-- SECURITY INVOKER plpgsql with auth.uid() captured into a declared variable
-- at entry — the pattern feedback_rls_security_invoker_wrappers requires and
-- migration 022 established.
--
-- current_user is the role PostgREST switched into for the request:
-- 'authenticated' for any anon-key call carrying a user JWT, 'anon' without
-- one, 'service_role' for the service key. Eden's SQL editor runs as
-- 'postgres'; supabase_admin covers the dashboard's other internal paths.
-- The SECURITY DEFINER functions in section 4 also run as the owner, which is
-- how last_used_at gets stamped at all.
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

  -- Every other column is frozen. A customer cannot rename a grant, move it
  -- to another account, back-date it, or forge a last_used_at.
  new.id               := old.id;
  new.user_id          := old.user_id;
  new.client_id_hash   := old.client_id_hash;
  new.client_id_prefix := old.client_id_prefix;
  new.client_name      := old.client_name;
  new.scopes           := old.scopes;
  new.notes            := old.notes;
  new.created_at       := old.created_at;
  new.last_used_at     := old.last_used_at;
  -- The server stamps the time and the actor, not the browser.
  new.revoked_at       := now();
  new.revoked_by       := actor;
  return new;
end $$;

drop trigger if exists oauth_grants_guard_update on public.oauth_grants;
create trigger oauth_grants_guard_update
  before update on public.oauth_grants
  for each row execute function public.oauth_grants_guard_update();


-- ============================================================================
-- 4. Server-side functions (service_role only)
--
-- Each takes the RAW client_id and hashes it here, so no caller has to agree
-- with Postgres about the hash, and the api/ layer never has to hold a
-- hashing convention. sha256() is core Postgres (11+); no pgcrypto.
-- ============================================================================
create or replace function public.oauth_grant_hash(p_client_id text)
returns text
language sql
immutable
as $$
  select encode(sha256(convert_to(coalesce(p_client_id, ''), 'UTF8')), 'hex')
$$;


-- 4a. The consent path. Called by /api/oauth-approve when the user clicks
-- Approve, and by /api/oauth-token when it exchanges a code that predates
-- the grants table. Attaches to the live grant if there is one, otherwise
-- mints a new one — including when an older grant for the same client was
-- revoked, because the user has just said yes again on the consent screen.
create or replace function public.oauth_grant_upsert(
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
  v_hash     text := public.oauth_grant_hash(p_client_id);
  v_id       uuid;
  v_inserted boolean;
begin
  if p_user_id is null or coalesce(p_client_id, '') = '' then
    raise exception 'oauth_grant_upsert: p_user_id and p_client_id are required';
  end if;

  -- One statement, so two approvals arriving together cannot both insert.
  insert into public.oauth_grants
    (user_id, client_id_hash, client_id_prefix, client_name, scopes, notes)
  values
    (p_user_id, v_hash, left(p_client_id, 12),
     coalesce(nullif(p_client_name, ''), 'Unknown client'),
     coalesce(p_scopes, array['mcp']::text[]),
     p_notes)
  on conflict (user_id, client_id_hash) where revoked_at is null
  do update set client_name = excluded.client_name
  returning id, (xmax = 0) into v_id, v_inserted;

  return query select v_id, case when v_inserted then 'created' else 'attached' end;
end $$;


-- 4b. The legacy-token path. Called by /api/oauth-token when a refresh token
-- minted BEFORE this migration (no `gid`) is presented.
--
-- The rule that matters: adoption may create a grant only where the user has
-- never had one for this client. If a grant for this (user, client) exists
-- and is revoked, adoption REFUSES — otherwise a pre-revocation refresh
-- token, which has no denylist and stays valid for its full 30 days, could
-- be replayed to mint a fresh grant and walk straight back in. Only the
-- consent screen (4a) may re-open a door the user closed.
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
    -- Revoked, and nothing active. The user said no.
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


-- 4c. Read one grant's state. Zero rows = the grant is gone, which the
-- resource server treats as a refusal: a token naming a grant that does not
-- exist is not a token this server issued against a live approval.
create or replace function public.oauth_grant_state(p_grant_id uuid)
returns table (grant_id uuid, owner_id uuid, revoked boolean, client_name text)
language sql
security definer
stable
set search_path = public
as $$
  select g.id, g.user_id, (g.revoked_at is not null), g.client_name
    from public.oauth_grants g
   where g.id = p_grant_id
$$;


-- 4d. Read the state for a (user, client) pair — the only question a token
-- minted before 065 can answer, because it carries no grant id. Prefers the
-- live grant; falls back to the most recent revoked one. Zero rows = this
-- user has never approved this client, which during the transition window
-- means "a token from before the table existed", not "forged".
create or replace function public.oauth_grant_state_by_client(
  p_user_id   uuid,
  p_client_id text
)
returns table (grant_id uuid, revoked boolean)
language sql
security definer
stable
set search_path = public
as $$
  select g.id, (g.revoked_at is not null)
    from public.oauth_grants g
   where g.user_id = p_user_id
     and g.client_id_hash = public.oauth_grant_hash(p_client_id)
   order by (g.revoked_at is null) desc, g.created_at desc
   limit 1
$$;


-- 4e. Stamp last_used_at. Called at most once every few minutes per grant per
-- serverless instance (see lib/oauth-grants.mjs) — this is "when did this
-- client last touch my matters", not an access log. A revoked grant is never
-- stamped, so the timestamp a customer sees is the last time the client
-- actually had access.
create or replace function public.oauth_grant_touch(p_grant_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.oauth_grants
     set last_used_at = now()
   where id = p_grant_id
     and revoked_at is null
$$;


-- Execute is server-side only. A customer who could call oauth_grant_upsert
-- could mint themselves a grant for a client they never approved; one who
-- could call oauth_grant_touch could forge the "last used" column they are
-- shown. Both are read-only-looking verbs that write.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.oauth_grant_hash(text)',
    'public.oauth_grant_upsert(uuid, text, text, text[], text)',
    'public.oauth_grant_adopt(uuid, text, text, text[], text)',
    'public.oauth_grant_state(uuid)',
    'public.oauth_grant_state_by_client(uuid, text)',
    'public.oauth_grant_touch(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
