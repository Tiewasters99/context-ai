-- 064_events_ledger.sql — W1: the matter's Record (append-only event ledger)
--
-- What this is, in the product's own words: every matter keeps a Record of
-- what was done to it and who did it — a person, an agent charter, or a
-- connected assistant. The Record is the thing a lawyer can hand to a court,
-- a client or an insurer. So it has to be true in the strong sense: nobody
-- rewrites it, nobody deletes it, and it outlives both the matter and the
-- account.
--
-- Designed in memory/project_security_provenance_roadmap_2026_09_10.md
-- (§W1 + §"W1 ledger signature"). Three deliberate deviations from that
-- section, all on Eden's W1 brief of 2026-09-20:
--
--   1. The event column is `kind` and the write function is `ledger_append`
--      (the roadmap wrote `type` / `record_event` + `events_record`). One
--      vocabulary, and `kind` is not a reserved word in any of the three
--      places it now appears (SQL, JS, the Record tab's props).
--   2. The hash is taken over a JSON ARRAY of the row's fields, with the
--      timestamp as epoch MICROSECONDS, not over a `||` concatenation of
--      `ts::text`. Two reasons: `timestamptz::text` renders in the session's
--      TimeZone, so the roadmap's formula would verify in New York and fail
--      in London; and a `||` join over free text (actor_ref) lets a caller
--      forge a canonical string. jsonb_build_array escapes, and jsonb's own
--      text form is key-sorted and stable.
--   3. Rows carry a `serverspace_id` snapshot as well as `matterspace_id` +
--      `matter_name`. Without it, "the record survives matter deletion" is
--      true of the bytes and false of the reading: with the matter gone
--      there is nothing left for RLS to check membership against, and the
--      row becomes invisible to everyone. The serverspace outlives the
--      matter, so it is what the firm's own people are checked against.
--
-- Also in this migration, because the audit of 2026-09-19 found the same
-- class of bug one table over: `ai_sessions` cascaded away when its matter
-- or its owner was deleted, and its owner could DELETE the rows. The AI
-- record died with the matter. Fixed here, guarded so it applies whether or
-- not production matches this folder.
--
-- Apply order: after 063. Re-runnable: every object is create-if-not-exists
-- or create-or-replace, and the file has been executed TWICE end-to-end in
-- PGlite by scripts/_verify-ledger.mjs.
--
-- ⚠ After pasting this file, run:  notify pgrst, 'reload schema';
--   (it is the last statement here, but a paste that stops early will not
--   have run it, and `ledger_append` stays invisible to PostgREST until it
--   does. lib/ledger.mjs treats "function not in the schema cache" as
--   NOT-DEPLOYED — it warns and the product behaves exactly as it does
--   today — so merging the code before pasting this is safe.)

-- ============================================================================
-- 1. events — one row per recorded act, one hash chain per matter
-- ============================================================================
-- No foreign keys at all. Every reference is a bare uuid plus a snapshot of
-- the name it had at the time, because a record that a DELETE can reach is
-- not a record. `chain_key` is the matterspace id, or the nil uuid for the
-- handful of events that belong to no matter (connector registered/revoked).
create table if not exists public.events (
  id             uuid primary key default gen_random_uuid(),
  ts             timestamptz not null default now(),
  chain_key      uuid not null,
  seq            bigint not null,
  kind           text not null,
  matterspace_id uuid,              -- NO fk: the row outlives the matter
  matter_name    text,              -- snapshot at write time
  serverspace_id uuid,              -- NO fk: snapshot, and the RLS fallback
  session_id     uuid,              -- NO fk: ai_sessions.id when there is one
  actor_kind     text not null default 'user'
    check (actor_kind in ('user', 'charter', 'connector', 'system')),
  actor_ref      text not null default 'unknown',
  actor_user_id  uuid,              -- auth.uid() at write time; NO fk
  actor_label    text,              -- snapshot: charter name / connector name
  payload        jsonb not null default '{}'::jsonb,
  prev_hash      text not null,     -- '' for seq 1
  hash           text not null,
  unique (chain_key, seq)
);

-- The vocabulary. Named so it can be widened by a later migration without
-- touching the table: W2 needs connector.*, W3 needs ai.*/run.aborted, W6
-- needs file.gate/citation.verified — all listed now so none of them has to
-- reopen this file.
alter table public.events drop constraint if exists events_kind_check;
alter table public.events add constraint events_kind_check check (kind in (
  'tool.invoked',
  'completion.received',
  'file.exported',
  'file.sent',
  'file.delivered',
  'file.gate',
  'citation.verified',
  'acl.changed',
  'seal.changed',
  'connector.registered',
  'connector.revoked',
  'ai.paused',
  'ai.resumed',
  'run.aborted'
));

create index if not exists events_chain_seq_idx    on public.events (chain_key, seq);
create index if not exists events_matter_ts_idx    on public.events (matterspace_id, ts desc);
create index if not exists events_serverspace_idx  on public.events (serverspace_id, ts desc);
create index if not exists events_session_idx      on public.events (session_id);
create index if not exists events_kind_ts_idx      on public.events (kind, ts desc);

alter table public.events enable row level security;

-- NOT `force row level security`: the SECURITY DEFINER writer below is owned
-- by postgres and needs the owner's RLS bypass to insert. Everyone else is
-- held by the policy set (SELECT only), the privilege grants, and the
-- triggers in §4 — which refuse even a superuser.


-- ============================================================================
-- 2. Who may read a row
-- ============================================================================
-- SECURITY INVOKER plpgsql, auth.uid() captured into a declared variable at
-- entry: the house rule for anything an RLS policy calls
-- (feedback_rls_security_invoker_wrappers / migration 022).
--
-- Three ways in, in order:
--   1. it is your own act;
--   2. the matter still exists and you can see it (022's wrapper, which
--      already inherits serverspace membership and ancestor matters);
--   3. the matter is gone — you are a member of the serverspace it was in.
create or replace function public._ledger_visible(
  p_matter uuid,
  p_serverspace uuid,
  p_actor_user uuid
) returns boolean
language plpgsql
security invoker
stable
as $$
declare
  v_uid uuid := auth.uid();
  v_ss uuid;
  v_parent uuid;
begin
  if v_uid is null then return false; end if;
  if p_actor_user is not null and p_actor_user = v_uid then return true; end if;

  if p_matter is not null then
    -- Runs as the caller, so matterspaces' own RLS answers "can you see it?".
    select m.serverspace_id, m.parent_matterspace_id
      into v_ss, v_parent
      from public.matterspaces m
     where m.id = p_matter;
    if v_ss is not null then
      return public._mtspc_select_check(p_matter, v_ss, v_parent);
    end if;
  end if;

  if p_serverspace is not null then
    return exists (
      select 1 from public.serverspace_members sm
       where sm.serverspace_id = p_serverspace and sm.user_id = v_uid
    );
  end if;
  return false;
end $$;

grant execute on function public._ledger_visible(uuid, uuid, uuid)
  to authenticated, service_role;

drop policy if exists "Record is visible to the matter's people" on public.events;
create policy "Record is visible to the matter's people"
  on public.events for select
  using (public._ledger_visible(matterspace_id, serverspace_id, actor_user_id));

-- There is deliberately NO insert, update or delete policy. Rows enter only
-- through ledger_append(); nothing removes them.


-- ============================================================================
-- 3. Privileges — belt to the policies' braces
-- ============================================================================
-- Supabase grants ALL on every new table in `public` to anon / authenticated
-- / service_role by default, and service_role additionally BYPASSRLS. So the
-- policy set above stops a signed-in user and stops nothing else. Take the
-- write privileges away by name.
revoke all on public.events from public;
revoke all on public.events from anon;
revoke all on public.events from authenticated;
revoke all on public.events from service_role;
grant select on public.events to authenticated, service_role;


-- ============================================================================
-- 4. Append-only, enforced by trigger
-- ============================================================================
-- Privileges stop a role. A trigger stops everybody, superuser included —
-- which is the point: the only way to alter this table is a migration that
-- first disables the trigger, and that is a deliberate, visible act.
create or replace function public._events_append_only() returns trigger
language plpgsql
as $$
begin
  raise exception
    'public.events is append-only: % is refused (the matter Record is never rewritten)', tg_op
    using errcode = '42501',
          hint = 'Corrections are appended as new events. To repair the table, a migration must disable trigger events_no_update / events_no_delete first.';
  return null;   -- unreachable; keeps plpgsql happy
end $$;

drop trigger if exists events_no_update on public.events;
create trigger events_no_update
  before update on public.events
  for each row execute function public._events_append_only();

drop trigger if exists events_no_delete on public.events;
create trigger events_no_delete
  before delete on public.events
  for each row execute function public._events_append_only();

drop trigger if exists events_no_truncate on public.events;
create trigger events_no_truncate
  before truncate on public.events
  for each statement execute function public._events_append_only();

-- And the way IN. RLS has no INSERT policy, which stops a signed-in user —
-- but service_role has BYPASSRLS, so any future `grant all on all tables in
-- schema public to service_role` (the paste that gets run whenever
-- permissions look wrong) would quietly reopen direct, unchained inserts.
-- _ledger_write raises a transaction-local flag for exactly the length of
-- its own INSERT; nothing else can be holding it.
create or replace function public._events_insert_guard() returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('contextspaces.ledger_writing', true), '') <> 'on' then
    raise exception
      'rows enter public.events only through ledger_append() — a direct INSERT would have no place in the hash chain'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists events_insert_only_via_append on public.events;
create trigger events_insert_only_via_append
  before insert on public.events
  for each row execute function public._events_insert_guard();


-- ============================================================================
-- 5. The hash
-- ============================================================================
-- One function, used by the writer and by verify_chain, so the two can never
-- drift apart. sha256() is built into Postgres 11+; no pgcrypto needed.
--
-- The timestamp goes in as epoch microseconds: an integer, identical in every
-- session regardless of the client's TimeZone or DateStyle. The fields go in
-- as a JSON array, so a value containing the separator cannot be used to
-- forge a different row's canonical form.
create or replace function public._ledger_hash(
  p_prev_hash text,
  p_seq bigint,
  p_ts timestamptz,
  p_kind text,
  p_matter uuid,
  p_matter_name text,
  p_actor_kind text,
  p_actor_ref text,
  p_actor_user uuid,
  p_session uuid,
  p_payload jsonb
) returns text
language sql
stable
as $$
  select encode(
    sha256(convert_to(
      jsonb_build_array(
        coalesce(p_prev_hash, ''),
        p_seq,
        (extract(epoch from p_ts) * 1000000)::bigint,
        coalesce(p_kind, ''),
        coalesce(p_matter::text, ''),
        coalesce(p_matter_name, ''),
        coalesce(p_actor_kind, ''),
        coalesce(p_actor_ref, ''),
        coalesce(p_actor_user::text, ''),
        coalesce(p_session::text, ''),
        coalesce(p_payload, '{}'::jsonb)
      )::text,
      'UTF8'
    )),
    'hex')
$$;


-- ============================================================================
-- 6. The writer — three layers, one job each
-- ============================================================================
--   _ledger_write          DEFINER, owner-only. Sequence, chain, INSERT.
--   _ledger_append_checked DEFINER. Reads auth.uid() ITSELF (never a
--                          parameter — a uid parameter on a function any
--                          signed-in user may call is a forged byline) and
--                          re-checks membership without RLS.
--   ledger_append          INVOKER. The RPC. Captures auth.uid() in a
--                          declared variable and asks the caller's own RLS
--                          whether the matter is visible.
--
-- Callers only ever reach ledger_append. _ledger_write's EXECUTE is revoked
-- from every role; the only things that can call it are the DEFINER
-- functions and triggers in this file, all owned by postgres.

-- Membership without RLS, for the DEFINER layer. Self-contained on purpose:
-- it does not depend on 016's helpers still existing in production.
create or replace function public._ledger_member(p_matter uuid, p_uid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    with recursive chain(id, parent_id, serverspace_id) as (
      select m.id, m.parent_matterspace_id, m.serverspace_id
        from public.matterspaces m
       where m.id = p_matter
      union all
      select m.id, m.parent_matterspace_id, m.serverspace_id
        from public.matterspaces m
        join chain c on m.id = c.parent_id
    )
    select 1 from chain c
     where exists (
             select 1 from public.serverspace_members sm
              where sm.serverspace_id = c.serverspace_id and sm.user_id = p_uid)
        or exists (
             select 1 from public.matterspace_members mm
              where mm.matterspace_id = c.id and mm.user_id = p_uid)
  )
$$;

revoke all on function public._ledger_member(uuid, uuid) from public;
revoke all on function public._ledger_member(uuid, uuid) from anon;
revoke all on function public._ledger_member(uuid, uuid) from authenticated;
revoke all on function public._ledger_member(uuid, uuid) from service_role;


create or replace function public._ledger_write(
  p_kind text,
  p_matter uuid,
  p_serverspace uuid,
  p_session uuid,
  p_actor_kind text,
  p_actor_ref text,
  p_actor_label text,
  p_payload jsonb,
  p_actor_user uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nil     constant uuid := '00000000-0000-0000-0000-000000000000';
  v_chain   uuid;
  v_ts      timestamptz := clock_timestamp();
  v_seq     bigint;
  v_prev    text;
  v_name    text;
  v_ss      uuid := p_serverspace;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_kind    text := coalesce(p_kind, '');
  v_akind   text := coalesce(nullif(p_actor_kind, ''), 'user');
  v_aref    text := coalesce(nullif(p_actor_ref, ''), coalesce(p_actor_user::text, 'unknown'));
  v_hash    text;
  v_id      uuid;
begin
  v_chain := coalesce(p_matter, v_nil);

  -- One writer at a time per chain. seq and prev_hash are read-then-written,
  -- so without this two concurrent appends would race to the same seq (the
  -- unique constraint would catch it, but one of them would simply fail).
  perform pg_advisory_xact_lock(hashtext(v_chain::text));

  if p_matter is not null then
    select m.name, m.serverspace_id into v_name, v_ss
      from public.matterspaces m where m.id = p_matter;
    if v_ss is null then v_ss := p_serverspace; end if;
  end if;

  -- 8 KB cap. Payloads are metadata — tool names, document ids, model,
  -- tokens, cost, retention tier. Never document text, never a prompt, never
  -- a model's answer. lib/ledger.mjs redacts before it gets here; this is the
  -- floor under that, not a substitute for it.
  if octet_length(v_payload::text) > 8192 then
    v_payload := jsonb_build_object(
      'truncated', true,
      'original_bytes', octet_length(v_payload::text),
      'keys', case when jsonb_typeof(v_payload) = 'object'
                   then (select coalesce(jsonb_agg(k order by k), '[]'::jsonb)
                           from jsonb_object_keys(v_payload) k)
                   else '[]'::jsonb end
    );
  end if;

  select e.seq, e.hash into v_seq, v_prev
    from public.events e
   where e.chain_key = v_chain
   order by e.seq desc
   limit 1;
  v_seq  := coalesce(v_seq, 0) + 1;
  v_prev := coalesce(v_prev, '');

  v_hash := public._ledger_hash(v_prev, v_seq, v_ts, v_kind, p_matter, v_name,
                                v_akind, v_aref, p_actor_user, p_session, v_payload);

  -- Transaction-local, and lowered again on the next line: the insert guard
  -- in §4 refuses anything that is not this statement.
  perform set_config('contextspaces.ledger_writing', 'on', true);
  insert into public.events (
    ts, chain_key, seq, kind, matterspace_id, matter_name, serverspace_id,
    session_id, actor_kind, actor_ref, actor_user_id, actor_label,
    payload, prev_hash, hash
  ) values (
    v_ts, v_chain, v_seq, v_kind, p_matter, v_name, v_ss,
    p_session, v_akind, v_aref, p_actor_user, p_actor_label,
    v_payload, v_prev, v_hash
  ) returning id into v_id;
  perform set_config('contextspaces.ledger_writing', '', true);

  return jsonb_build_object(
    'id', v_id, 'seq', v_seq, 'hash', v_hash, 'ts', v_ts, 'chain_key', v_chain);
end $$;

revoke all on function public._ledger_write(text, uuid, uuid, uuid, text, text, text, jsonb, uuid) from public;
revoke all on function public._ledger_write(text, uuid, uuid, uuid, text, text, text, jsonb, uuid) from anon;
revoke all on function public._ledger_write(text, uuid, uuid, uuid, text, text, text, jsonb, uuid) from authenticated;
revoke all on function public._ledger_write(text, uuid, uuid, uuid, text, text, text, jsonb, uuid) from service_role;


create or replace function public._ledger_append_checked(
  p_kind text,
  p_matter uuid,
  p_serverspace uuid,
  p_session uuid,
  p_actor_kind text,
  p_actor_ref text,
  p_actor_label text,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();   -- the GUC, not a parameter: unforgeable
begin
  if v_uid is null then
    -- No JWT: a server-side caller (the worker, a cron sweep). It may record
    -- system events and nothing else.
    if coalesce(p_actor_kind, 'user') <> 'system' then
      raise exception 'ledger_append requires an authenticated caller'
        using errcode = '42501';
    end if;
  elsif p_matter is not null and not public._ledger_member(p_matter, v_uid) then
    raise exception 'matter % is not accessible', p_matter using errcode = '42501';
  end if;

  return public._ledger_write(
    p_kind, p_matter, p_serverspace, p_session,
    coalesce(p_actor_kind, 'user'), p_actor_ref, p_actor_label,
    p_payload, v_uid);
end $$;

revoke all on function public._ledger_append_checked(text, uuid, uuid, uuid, text, text, text, jsonb) from public;
revoke all on function public._ledger_append_checked(text, uuid, uuid, uuid, text, text, text, jsonb) from anon;
grant execute on function public._ledger_append_checked(text, uuid, uuid, uuid, text, text, text, jsonb)
  to authenticated, service_role;


create or replace function public.ledger_append(
  p_kind text,
  p_matter uuid default null,
  p_serverspace uuid default null,
  p_session uuid default null,
  p_actor_kind text default 'user',
  p_actor_ref text default null,
  p_actor_label text default null,
  p_payload jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  -- Evaluated as the CALLER, so matterspaces' own RLS is what answers. The
  -- DEFINER layer below re-checks the same thing without RLS; this one is
  -- here because it is the house pattern and because it fails early with the
  -- error the caller expects.
  if v_uid is not null and p_matter is not null
     and not exists (select 1 from public.matterspaces where id = p_matter) then
    raise exception 'matter % not found or not accessible', p_matter
      using errcode = '42501';
  end if;

  return public._ledger_append_checked(
    p_kind, p_matter, p_serverspace, p_session,
    p_actor_kind, p_actor_ref, p_actor_label, p_payload);
end $$;

revoke all on function public.ledger_append(text, uuid, uuid, uuid, text, text, text, jsonb) from public;
revoke all on function public.ledger_append(text, uuid, uuid, uuid, text, text, text, jsonb) from anon;
grant execute on function public.ledger_append(text, uuid, uuid, uuid, text, text, text, jsonb)
  to authenticated, service_role;


-- ============================================================================
-- 7. verify_chain — recompute the chain and say where it first breaks
-- ============================================================================
-- SECURITY INVOKER: it verifies what the caller can see. A chain is one
-- matter, and RLS on events is per matter, so it is all-or-nothing — a
-- caller either checks the whole chain or sees none of it (checked = 0).
create or replace function public.verify_chain(p_chain_key uuid)
returns table (ok boolean, checked bigint, first_bad_seq bigint)
language plpgsql
security invoker
stable
as $$
declare
  r        record;
  v_prev   text   := '';
  v_n      bigint := 0;
  v_bad    bigint := null;
  v_expect bigint := 1;
begin
  for r in
    select e.* from public.events e
     where e.chain_key = p_chain_key
     order by e.seq asc
  loop
    if r.seq <> v_expect then v_bad := r.seq; exit; end if;
    if coalesce(r.prev_hash, '') <> v_prev then v_bad := r.seq; exit; end if;
    if r.hash is distinct from public._ledger_hash(
         v_prev, r.seq, r.ts, r.kind, r.matterspace_id, r.matter_name,
         r.actor_kind, r.actor_ref, r.actor_user_id, r.session_id, r.payload)
    then v_bad := r.seq; exit; end if;
    v_prev   := r.hash;
    v_n      := v_n + 1;
    v_expect := v_expect + 1;
  end loop;

  ok            := v_bad is null;
  checked       := v_n;
  first_bad_seq := v_bad;
  return next;
end $$;

grant execute on function public.verify_chain(uuid) to authenticated, service_role;


-- ============================================================================
-- 8. The events nobody has to remember to write
-- ============================================================================
-- ACL changes and seal changes are recorded by the database itself, so they
-- are in the Record even when the change was made by a script, by Studio, or
-- by a future screen nobody has written yet.
--
-- These triggers do NOT swallow their own failures. If the Record cannot be
-- written, the ACL change does not happen either — which is the right way
-- round for the one table whose history is the whole point.

create or replace function public._ledger_matter_acl_event() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_matter uuid;
  v_target uuid;
  v_old    text;
  v_new    text;
begin
  if tg_op = 'DELETE' then
    v_matter := old.matterspace_id; v_target := old.user_id;
    v_old := old.role;              v_new := null;
  elsif tg_op = 'INSERT' then
    v_matter := new.matterspace_id; v_target := new.user_id;
    v_old := null;                  v_new := new.role;
  else
    v_matter := new.matterspace_id; v_target := new.user_id;
    v_old := old.role;              v_new := new.role;
  end if;

  -- Deleting a matter cascades its membership rows away. That is not an ACL
  -- change anyone needs recorded, the matter is already gone so the event
  -- would be nameless, and raising here would block the delete.
  if not exists (select 1 from public.matterspaces where id = v_matter) then
    return null;
  end if;

  perform public._ledger_write(
    'acl.changed', v_matter, null, null,
    case when v_uid is null then 'system' else 'user' end,
    coalesce(v_uid::text, 'system'),
    null,
    jsonb_build_object(
      'table', 'matterspace_members',
      'op', lower(tg_op),
      'target_user_id', v_target,
      'old_role', v_old,
      'new_role', v_new),
    v_uid);
  return null;
end $$;

drop trigger if exists matterspace_members_acl_event on public.matterspace_members;
create trigger matterspace_members_acl_event
  after insert or update or delete on public.matterspace_members
  for each row execute function public._ledger_matter_acl_event();


create or replace function public._ledger_server_acl_event() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_ss     uuid;
  v_target uuid;
  v_old    text;
  v_new    text;
begin
  if tg_op = 'DELETE' then
    v_ss := old.serverspace_id; v_target := old.user_id;
    v_old := old.role;          v_new := null;
  elsif tg_op = 'INSERT' then
    v_ss := new.serverspace_id; v_target := new.user_id;
    v_old := null;              v_new := new.role;
  else
    v_ss := new.serverspace_id; v_target := new.user_id;
    v_old := old.role;          v_new := new.role;
  end if;

  if not exists (select 1 from public.serverspaces where id = v_ss) then
    return null;   -- the serverspace itself is being deleted
  end if;

  -- A serverspace membership governs every matter under it, so it belongs to
  -- no single chain: it goes on the nil chain with the serverspace
  -- snapshotted, which is what _ledger_visible checks for these rows.
  perform public._ledger_write(
    'acl.changed', null, v_ss, null,
    case when v_uid is null then 'system' else 'user' end,
    coalesce(v_uid::text, 'system'),
    null,
    jsonb_build_object(
      'table', 'serverspace_members',
      'op', lower(tg_op),
      'serverspace_id', v_ss,
      'target_user_id', v_target,
      'old_role', v_old,
      'new_role', v_new),
    v_uid);
  return null;
end $$;

drop trigger if exists serverspace_members_acl_event on public.serverspace_members;
create trigger serverspace_members_acl_event
  after insert or update or delete on public.serverspace_members
  for each row execute function public._ledger_server_acl_event();


-- seal.changed — matterspaces.ai_tier (migration 051). Guarded: if a
-- database somehow has no ai_tier column, the rest of this file still
-- applies.
create or replace function public._ledger_seal_event() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  perform public._ledger_write(
    'seal.changed', new.id, new.serverspace_id, null,
    case when v_uid is null then 'system' else 'user' end,
    coalesce(v_uid::text, 'system'),
    null,
    jsonb_build_object('old_tier', old.ai_tier, 'new_tier', new.ai_tier),
    v_uid);
  return null;
end $$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'matterspaces' and column_name = 'ai_tier'
  ) then
    execute 'drop trigger if exists matterspaces_seal_event on public.matterspaces';
    execute $t$
      create trigger matterspaces_seal_event
        after update of ai_tier on public.matterspaces
        for each row when (old.ai_tier is distinct from new.ai_tier)
        execute function public._ledger_seal_event()
    $t$;
  else
    raise notice '064: matterspaces.ai_tier absent — seal.changed trigger skipped';
  end if;
end $$;


-- ============================================================================
-- 9. The 051 repair — the AI record outlives the matter and the account
-- ============================================================================
-- Audit 2026-09-19: ai_sessions.matterspace_id and .owner_id were both
-- ON DELETE CASCADE, and the owner had a DELETE policy on sessions and on
-- messages. So the privileged record of what an AI did on a matter could be
-- erased by deleting the matter, by deleting the account, or by the owner
-- simply asking. All three closed here.
--
-- Everything is guarded and introspected rather than named, because
-- production has drifted from this folder before.
do $$
declare r record;
begin
  if to_regclass('public.ai_sessions') is null then
    raise notice '064: ai_sessions absent — skipping the 051 repair';
    return;
  end if;

  -- Snapshots, so a deleted matter and a deleted account still read.
  execute 'alter table public.ai_sessions add column if not exists matter_name text';
  execute 'alter table public.ai_sessions add column if not exists owner_email text';
  execute 'alter table public.ai_sessions add column if not exists serverspace_id uuid';

  -- SET NULL needs the columns to be nullable.
  execute 'alter table public.ai_sessions alter column matterspace_id drop not null';
  execute 'alter table public.ai_sessions alter column owner_id drop not null';

  -- Drop whatever foreign keys these two columns actually carry, by name.
  for r in
    select distinct con.conname
      from pg_constraint con
      join pg_class rel      on rel.oid = con.conrelid
      join pg_namespace ns   on ns.oid = rel.relnamespace
      cross join lateral unnest(con.conkey) as k(attnum)
      join pg_attribute att  on att.attrelid = rel.oid and att.attnum = k.attnum
     where ns.nspname = 'public'
       and rel.relname = 'ai_sessions'
       and con.contype = 'f'
       and att.attname in ('matterspace_id', 'owner_id')
  loop
    execute format('alter table public.ai_sessions drop constraint %I', r.conname);
  end loop;

  execute 'alter table public.ai_sessions
             add constraint ai_sessions_matterspace_id_fkey
             foreign key (matterspace_id) references public.matterspaces(id)
             on delete set null';

  if to_regclass('auth.users') is not null then
    execute 'alter table public.ai_sessions
               add constraint ai_sessions_owner_id_fkey
               foreign key (owner_id) references auth.users(id)
               on delete set null';
  end if;

  -- Backfill the snapshots for rows written before today.
  execute 'update public.ai_sessions s
              set matter_name    = coalesce(s.matter_name, m.name),
                  serverspace_id = coalesce(s.serverspace_id, m.serverspace_id)
             from public.matterspaces m
            where m.id = s.matterspace_id
              and (s.matter_name is null or s.serverspace_id is null)';
  if to_regclass('auth.users') is not null then
    execute 'update public.ai_sessions s
                set owner_email = u.email
               from auth.users u
              where u.id = s.owner_id and s.owner_email is null';
  end if;
end $$;

-- Keep the snapshots filled from now on.
create or replace function public._ai_sessions_snapshot() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.matterspace_id is not null
     and (new.matter_name is null or new.serverspace_id is null) then
    select m.name, m.serverspace_id into new.matter_name, new.serverspace_id
      from public.matterspaces m where m.id = new.matterspace_id;
  end if;
  if new.owner_id is not null and new.owner_email is null then
    begin
      select u.email into new.owner_email from auth.users u where u.id = new.owner_id;
    exception when others then null;   -- auth.users unreadable: not fatal
    end;
  end if;
  return new;
end $$;

do $$
begin
  if to_regclass('public.ai_sessions') is not null then
    execute 'drop trigger if exists ai_sessions_snapshot on public.ai_sessions';
    execute 'create trigger ai_sessions_snapshot
               before insert on public.ai_sessions
               for each row execute function public._ai_sessions_snapshot()';

    -- The owner may no longer erase the record. (service_role is left with
    -- DELETE: an account-closure request still has to be executable by the
    -- operator. `events` is the copy that nobody can erase.)
    execute 'drop policy if exists "Owners delete their sessions" on public.ai_sessions';
    execute 'revoke delete on public.ai_sessions from anon';
    execute 'revoke delete on public.ai_sessions from authenticated';

    -- Readable after the matter, or the account, is gone.
    execute 'drop policy if exists "Sessions visible to owner or matter members" on public.ai_sessions';
    execute 'create policy "Sessions visible to owner or matter members"
               on public.ai_sessions for select
               using (public._ledger_visible(matterspace_id, serverspace_id, owner_id))';
  end if;

  if to_regclass('public.ai_messages') is not null then
    execute 'drop policy if exists "Session owners delete messages" on public.ai_messages';
    execute 'revoke delete on public.ai_messages from anon';
    execute 'revoke delete on public.ai_messages from authenticated';
  end if;
end $$;


-- ============================================================================
-- 10. Tell PostgREST
-- ============================================================================
notify pgrst, 'reload schema';
