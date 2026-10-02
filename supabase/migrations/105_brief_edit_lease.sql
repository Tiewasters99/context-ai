-- 105_brief_edit_lease.sql — one person edits a brief at a time.
--
-- Eden, 10-02: "Only one person at a time can work on a Desk Brief copy."
-- Versions are worked one at a time, Word style; when a review is done it is
-- saved as the next version (PR #342). Two windows editing the same brief —
-- a second tab, a phone, a colleague — is what produced the "changed
-- elsewhere" banner, and an edit made in the losing window had nowhere to go.
--
-- The rule: the first window to open a brief for editing holds it; every
-- other window opens it read-only and says who holds it and since when. The
-- holding window renews its hold every 30 s; a hold not renewed for 150 s has
-- lapsed (a closed laptop, a crashed tab) and the next window takes it. A
-- window may also take the hold over on purpose ("Take over editing"); the
-- one that lost it turns read-only on its next renewal.
--
-- What this is NOT: a lock on the data. A save is still guarded by the
-- optimistic `updated_at` check (migration 100): no save ever lands on a
-- brief changed since it was loaded. The hold only decides which window lets
-- you type, so that a second window never gets as far as a refused save.
--
-- Shape (per feedback_rls_security_invoker_wrappers): the public functions
-- are SECURITY INVOKER — they read auth.uid() once, and find the brief through
-- `documents` under the CALLER's own RLS, so a brief the caller cannot read
-- answers nothing, and only a matter writer (016 can_write_matter) may hold
-- one. They then call DEFINER cores in the private schema `brief_internal`,
-- which is not exposed through PostgREST. The table itself has a read policy
-- and no write policy: rows change only through the cores.
--
-- `brief_internal` is the Brief Desk's private schema from migration 101 (it
-- holds the citation-resolver cores). The schema lines below repeat 101's
-- exactly, so on a database that has 101 they change nothing.
--
-- Write/DDL: one new table, four new functions. Nothing existing is altered.
-- Safe to paste at any hour.
--
-- ROLLBACK (never drop the schema: 101's resolvers live in it):
--   drop function if exists public.claim_brief_edit(uuid, uuid, text, boolean);
--   drop function if exists public.release_brief_edit(uuid, uuid);
--   drop function if exists brief_internal.claim(uuid, uuid, uuid, text, boolean);
--   drop function if exists brief_internal.release(uuid, uuid, uuid);
--   drop table if exists public.brief_edit_leases;

set lock_timeout = '10s';

create table if not exists public.brief_edit_leases (
  document_id  uuid primary key references public.documents(id) on delete cascade,
  -- A random id per browser tab, made by the tab; never shown to anyone.
  holder_tab   uuid not null,
  holder_user  uuid not null,
  -- The holder's name as the holding window gave it ("Eden Quainton").
  holder_name  text not null default '' check (char_length(holder_name) <= 120),
  claimed_at   timestamptz not null default now(),
  heartbeat_at timestamptz not null default now()
);

comment on table public.brief_edit_leases is
  'Which window may edit a Brief Desk brief (105). Advisory: saves are still '
  'guarded by draft_bodies.updated_at (100). Written only through '
  'public.claim_brief_edit / public.release_brief_edit.';

alter table public.brief_edit_leases enable row level security;

drop policy if exists brief_edit_leases_read on public.brief_edit_leases;
create policy brief_edit_leases_read on public.brief_edit_leases
  for select using (
    exists (select 1 from public.documents d
             where d.id = document_id and public.can_access_matter(d.matterspace_id))
  );

-- Supabase grants ALL on a new public table to anon and authenticated by
-- default; take it back. Reads go through the policy above; writes only
-- through the functions below.
revoke all on public.brief_edit_leases from anon, authenticated;
grant select on public.brief_edit_leases to authenticated;

-- ---------------------------------------------------------------------------
-- DEFINER cores in 101's private schema. No access check here: the INVOKER
-- wrappers below are the only callers, and they check first.
-- ---------------------------------------------------------------------------
create schema if not exists brief_internal;
revoke all on schema brief_internal from public;
grant usage on schema brief_internal to authenticated, service_role;

create or replace function brief_internal.claim(
  p_document_id uuid, p_tab uuid, p_user uuid, p_name text, p_force boolean
)
returns table (holder_is_me boolean, holder_user uuid, holder_name text, claimed_at timestamptz, heartbeat_at timestamptz)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  insert into public.brief_edit_leases as l
    (document_id, holder_tab, holder_user, holder_name, claimed_at, heartbeat_at)
  values (p_document_id, p_tab, p_user, left(coalesce(p_name, ''), 120), now(), now())
  on conflict (document_id) do update
     set holder_tab   = excluded.holder_tab,
         holder_user  = excluded.holder_user,
         holder_name  = excluded.holder_name,
         -- A renewal keeps the time the hold began; a new holder starts it.
         claimed_at   = case when l.holder_tab = excluded.holder_tab then l.claimed_at else now() end,
         heartbeat_at = now()
   where l.holder_tab = excluded.holder_tab                      -- this window renewing
      or l.heartbeat_at < now() - interval '150 seconds'         -- the hold has lapsed
      or p_force;                                                -- "Take over editing"

  return query
  select l.holder_tab = p_tab, l.holder_user, l.holder_name, l.claimed_at, l.heartbeat_at
    from public.brief_edit_leases l
   where l.document_id = p_document_id;
end $$;

create or replace function brief_internal.release(p_document_id uuid, p_tab uuid, p_user uuid)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  delete from public.brief_edit_leases
   where document_id = p_document_id and holder_tab = p_tab and holder_user = p_user;
$$;

revoke all on function brief_internal.claim(uuid, uuid, uuid, text, boolean) from public;
revoke all on function brief_internal.release(uuid, uuid, uuid) from public;
grant execute on function brief_internal.claim(uuid, uuid, uuid, text, boolean) to authenticated, service_role;
grant execute on function brief_internal.release(uuid, uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- INVOKER wrappers: the whole of the access rule.
-- ---------------------------------------------------------------------------

-- Claim (or renew, or with p_force take over) the hold on a brief for this
-- window. Returns the hold as it stands afterwards: holder_is_me says whether
-- this window may edit. A brief the caller cannot read raises; a caller who
-- can read but not write gets the current holder (if any) and never holds it.
create or replace function public.claim_brief_edit(
  p_document_id uuid, p_tab uuid, p_name text default '', p_force boolean default false
)
returns table (holder_is_me boolean, holder_user uuid, holder_name text, claimed_at timestamptz, heartbeat_at timestamptz)
language plpgsql
volatile
security invoker
as $$
#variable_conflict use_column
declare
  v_uid    uuid := auth.uid();
  v_matter uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if p_tab is null then
    raise exception 'p_tab is required' using errcode = '22004';
  end if;
  -- Under the caller's own RLS: a brief they cannot read is not found.
  select d.matterspace_id into v_matter from public.documents d where d.id = p_document_id;
  if v_matter is null then
    raise exception 'brief not found' using errcode = 'P0002';
  end if;
  if not public.can_write_matter(v_matter) then
    return query
    select false, l.holder_user, l.holder_name, l.claimed_at, l.heartbeat_at
      from public.brief_edit_leases l where l.document_id = p_document_id;
    return;
  end if;
  return query select * from brief_internal.claim(p_document_id, p_tab, v_uid, p_name, coalesce(p_force, false));
end $$;

-- Let go of the hold, if this window (and this person) holds it. Anything else
-- is a no-op: a window can only release its own hold.
create or replace function public.release_brief_edit(p_document_id uuid, p_tab uuid)
returns void
language plpgsql
volatile
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_tab is null then return; end if;
  perform brief_internal.release(p_document_id, p_tab, v_uid);
end $$;

revoke all on function public.claim_brief_edit(uuid, uuid, text, boolean) from public;
revoke all on function public.release_brief_edit(uuid, uuid) from public;
grant execute on function public.claim_brief_edit(uuid, uuid, text, boolean) to authenticated, service_role;
grant execute on function public.release_brief_edit(uuid, uuid) to authenticated, service_role;
