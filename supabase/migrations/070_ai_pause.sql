-- 070_ai_pause.sql — W3: "pause all AI on this matter"
--
-- The seal answers "which minds may read this matter". It does not answer
-- "stop, now, everything". A lawyer who has just realised something about a
-- production, a client who telephones mid-deposition, an agent behaving oddly
-- at 11 p.m. — all of them want one switch, and until this migration there was
-- none (audit 2026-09-19, "Kill switch: none"; roadmap §W3).
--
-- A pause is NOT a tier. The tier says where content may go; the pause says
-- nothing goes anywhere at all, on any tier — A, B and C alike. It is meant to
-- be flipped and unflipped in seconds, which is why it is a boolean beside the
-- tier rather than a fourth letter inside it: re-tiering a matter to C would
-- refuse cloud models but leave the record saying the matter is a silo, and
-- unpausing would have to guess which tier to restore.
--
-- What this file adds
-- ---------------------------------------------------------------------------
--   1. matterspaces.ai_paused + who, when, and an optional note.
--   2. A trigger so those five columns can be changed by ONE function and
--      nothing else — not by a PATCH from the browser, not by a stray UPDATE.
--      (The pattern is migration 062's profiles_guard_plan, which guards
--      pricing_tier the same way and for the same reason.)
--   3. matter_set_ai_pause() — the RPC. INVOKER wrapper over a DEFINER
--      checker, per feedback_rls_security_invoker_wrappers: the wrapper
--      captures auth.uid() in a declared variable, and the DEFINER layer reads
--      auth.uid() ITSELF rather than taking it as a parameter (a uid parameter
--      on a function any signed-in user may call is a forged byline).
--   4. matter_ai_pause() — the read. One round trip for "is this matter
--      paused, who by, when, and was it paused here or on a parent".
--   5. Resuming RELEASES the work the pause held: documents and jobs parked in
--      'held' with the pause's own reason go back to 'pending' / 'queued'.
--      Rows held by the SEAL are left exactly where they are.
--
-- Who may pause
-- ---------------------------------------------------------------------------
-- The same people who may change the seal, and no others. That rule already
-- exists: matterspaces' UPDATE policy is public._mtspc_update_check(id,
-- serverspace_id) (migration 023) — owner/admin of the serverspace, or
-- owner/admin of the matter or any ancestor. This file REUSES it (the INVOKER
-- layer calls it when it is present) and does not restate it as policy. The
-- DEFINER layer re-checks the same rule with a self-contained query, so a
-- production database that never had 023 pasted is still guarded rather than
-- open — the same belt-and-braces 064 applies with _ledger_member.
--
-- Inheritance
-- ---------------------------------------------------------------------------
-- Mirrors the seal exactly (lib/ai-tier-policy.mjs walkEffectiveTier): a
-- matter is paused when it, or ANY ancestor on the chain to its root, is
-- paused. Pausing "Calder v. Atlas" pauses every sub-matter and folder inside
-- it. There is no second inheritance rule here and no cascading write: one
-- row changes, and every consequence is computed from the chain — which is
-- what makes resuming a single row too.
--
-- Apply order: after 064 if 064 is being applied, but this file does NOT
-- depend on it. 064–069 belong to other lanes; every object below is
-- create-if-not-exists or create-or-replace, every dependency is probed before
-- use, and the file has been executed TWICE end-to-end in PGlite, with and
-- without its neighbours, by scripts/_verify-ai-pause.mjs.
--
-- ⚠ After pasting this file, run:  notify pgrst, 'reload schema';
--   (it is the last statement here, but a paste that stops early will not have
--   run it.) Until it is pasted, lib/ai-tier-policy.mjs classifies the missing
--   column/function as NOT DEPLOYED and every path behaves exactly as it does
--   today; the UI control hides itself. Merging the code before pasting the
--   migration is safe, deliberately.


-- ============================================================================
-- 1. The state
-- ============================================================================
-- Five columns, all nullable but ai_paused, all changed together by one
-- function. ai_paused_by_name is a SNAPSHOT of the pauser's display name: the
-- refusal sentence says who paused the matter, and it must read the same for
-- every member without each of them being able to read the profiles table.
alter table public.matterspaces
  add column if not exists ai_paused         boolean not null default false;
alter table public.matterspaces
  add column if not exists ai_paused_at      timestamptz;
alter table public.matterspaces
  add column if not exists ai_paused_by      uuid;         -- NO fk: outlives the account
alter table public.matterspaces
  add column if not exists ai_paused_by_name text;
alter table public.matterspaces
  add column if not exists ai_pause_note     text;

-- Paused matters are the rare case; index the exception, not the rule. This is
-- the index behind pausedMatterIds() in lib/ai-tier-policy.mjs, which asks
-- "which matters are paused" rather than scanning the table (the same costing
-- rule as sealedMatterIds: a full scan would truncate at PostgREST's row cap
-- and fail OPEN).
create index if not exists idx_matterspaces_ai_paused
  on public.matterspaces (id)
  where ai_paused;


-- ============================================================================
-- 2. Only one door
-- ============================================================================
-- matterspaces already grants UPDATE to authenticated (policy "Admins can
-- update matterspaces"), and the SecureSpaces shelf uses it to write ai_tier
-- directly. The pause must not be writable that way: the byline
-- (ai_paused_by / _by_name / _at) is evidence, and evidence a client can type
-- is not evidence.
--
-- Column-level grants are the other way to do this, and 062 uses them on
-- profiles. Not here: revoking table-level UPDATE on matterspaces and granting
-- it column by column would silently un-grant every column a later migration
-- adds. A narrow BEFORE trigger cannot drift that way — it names the five
-- columns it guards and lets every other UPDATE through untouched.
create or replace function public._ai_pause_guard() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- Nothing is born paused. An INSERT that tries is not refused (that would
    -- break matter creation for a client that sends the column by accident);
    -- the columns are simply reset to their defaults.
    new.ai_paused         := false;
    new.ai_paused_at      := null;
    new.ai_paused_by      := null;
    new.ai_paused_by_name := null;
    new.ai_pause_note     := null;
    return new;
  end if;

  if new.ai_paused         is distinct from old.ai_paused
     or new.ai_paused_at   is distinct from old.ai_paused_at
     or new.ai_paused_by   is distinct from old.ai_paused_by
     or new.ai_paused_by_name is distinct from old.ai_paused_by_name
     or new.ai_pause_note  is distinct from old.ai_pause_note
  then
    if coalesce(current_setting('contextspaces.ai_pause_writing', true), '') <> 'on' then
      raise exception
        'the AI pause is changed through matter_set_ai_pause(), not by updating matterspaces'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists matterspaces_guard_ai_pause on public.matterspaces;
create trigger matterspaces_guard_ai_pause
  before insert or update on public.matterspaces
  for each row execute function public._ai_pause_guard();


-- ============================================================================
-- 3. Who may change it
-- ============================================================================
-- Two layers, the same rule twice.
--
-- _ai_pause_admin  — DEFINER, self-contained. The rule of 023 written out, so
--                    that a database where 023 was never pasted is still
--                    guarded. Revoked from every role: only the DEFINER
--                    functions below call it.
create or replace function public._ai_pause_admin(p_matter uuid, p_uid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select p_uid is not null and (
    -- owner/admin of the serverspace the matter lives in
    exists (
      select 1
        from public.matterspaces m
        join public.serverspace_members sm
          on sm.serverspace_id = m.serverspace_id
       where m.id = p_matter
         and sm.user_id = p_uid
         and sm.role in ('owner', 'admin')
    )
    -- or owner/admin of the matter itself, or of any ancestor
    or exists (
      with recursive ancestors(id, parent_id) as (
        select m.id, m.parent_matterspace_id
          from public.matterspaces m where m.id = p_matter
        union all
        select m.id, m.parent_matterspace_id
          from public.matterspaces m
          join ancestors a on m.id = a.parent_id
      )
      select 1
        from ancestors a
        join public.matterspace_members mm on mm.matterspace_id = a.id
       where mm.user_id = p_uid
         and mm.role in ('owner', 'admin')
    )
  )
$$;

revoke all on function public._ai_pause_admin(uuid, uuid) from public;
revoke all on function public._ai_pause_admin(uuid, uuid) from anon;
revoke all on function public._ai_pause_admin(uuid, uuid) from authenticated;
revoke all on function public._ai_pause_admin(uuid, uuid) from service_role;


-- _ai_pause_may_change — INVOKER plpgsql, auth.uid() captured into a declared
--                        variable at entry (the house rule for anything an RLS
--                        policy or an INVOKER wrapper consults). It DELEGATES
--                        to 023's _mtspc_update_check when that function
--                        exists, so "who may pause" is literally the same code
--                        as "who may change the seal" and cannot drift from
--                        it. When 023 is absent it falls back to the rule
--                        above. plpgsql binds function names at execution
--                        time, so the branch is only resolved when taken.
create or replace function public._ai_pause_may_change(p_matter uuid)
returns boolean
language plpgsql
security invoker
stable
as $$
declare
  v_uid uuid := auth.uid();
  v_ss  uuid;
  v_ok  boolean;
begin
  if v_uid is null then return false; end if;
  select m.serverspace_id into v_ss from public.matterspaces m where m.id = p_matter;
  if v_ss is null then return false; end if;   -- invisible to this caller, or gone

  if to_regprocedure('public._mtspc_update_check(uuid, uuid)') is not null then
    execute 'select public._mtspc_update_check($1, $2)' into v_ok using p_matter, v_ss;
    return coalesce(v_ok, false);
  end if;
  return public._ai_pause_admin(p_matter, v_uid);
end $$;

grant execute on function public._ai_pause_may_change(uuid) to authenticated, service_role;


-- ============================================================================
-- 4. The writer
-- ============================================================================
-- DEFINER, owner-only: it is the one thing that may raise the guard's flag.
create or replace function public._ai_pause_write(
  p_matter uuid,
  p_paused boolean,
  p_note   text,
  p_uid    uuid,
  p_name   text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.matterspaces;
begin
  -- Transaction-local, lowered again below: the guard in §2 refuses any
  -- change to these columns that does not come from here.
  perform set_config('contextspaces.ai_pause_writing', 'on', true);

  if p_paused then
    update public.matterspaces
       set ai_paused         = true,
           ai_paused_at      = coalesce(ai_paused_at, now()),
           ai_paused_by      = coalesce(ai_paused_by, p_uid),
           ai_paused_by_name = coalesce(ai_paused_by_name, p_name),
           ai_pause_note     = nullif(left(coalesce(p_note, ''), 500), '')
     where id = p_matter
     returning * into v_row;
  else
    update public.matterspaces
       set ai_paused         = false,
           ai_paused_at      = null,
           ai_paused_by      = null,
           ai_paused_by_name = null,
           ai_pause_note     = null
     where id = p_matter
     returning * into v_row;
  end if;

  perform set_config('contextspaces.ai_pause_writing', '', true);

  if v_row.id is null then
    raise exception 'matter % not found', p_matter using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'matter_id',      v_row.id,
    'paused',         v_row.ai_paused,
    'paused_at',      v_row.ai_paused_at,
    'paused_by',      v_row.ai_paused_by,
    'paused_by_name', v_row.ai_paused_by_name,
    'note',           v_row.ai_pause_note
  );
end $$;

revoke all on function public._ai_pause_write(uuid, boolean, text, uuid, text) from public;
revoke all on function public._ai_pause_write(uuid, boolean, text, uuid, text) from anon;
revoke all on function public._ai_pause_write(uuid, boolean, text, uuid, text) from authenticated;
revoke all on function public._ai_pause_write(uuid, boolean, text, uuid, text) from service_role;


-- ============================================================================
-- 5. Resuming releases what the pause held
-- ============================================================================
-- While a matter is paused, a new upload's model-driven steps are parked in
-- the existing 'held' status (migration 060) with the pause's own sentence as
-- the reason — never dropped, never retried, never marked 'ready' over an
-- empty index. Resuming has to put them back, or "pause" would quietly mean
-- "discard everything uploaded while I was away".
--
-- The marker is the reason text, because the held row has no other place to
-- carry why it was held (processing_error is a text column and documents have
-- no policy-hold column). lib/seal-pipes.mjs AiPausedError opens its message
-- with exactly this prefix and scripts/_verify-ai-pause.mjs asserts the two
-- strings stay in step.
--
-- Rows held by the SEAL are matched by neither clause and do not move: a
-- sealed scan waits for a sealed OCR route, pause or no pause.
create or replace function public._ai_pause_release(p_matter uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids   uuid[];
  v_docs  integer := 0;
  v_jobs  integer := 0;
  -- Two markers, because there are two ways the pause holds work: the matter
  -- IS paused, and the pause could not be read (fail-closed, lib/seal-pipes
  -- assertAiNotPaused). Both must be released, or a database blip during a
  -- pause would park an upload for ever.
  v_mark  text := 'AI is paused on this matter%';
  v_mark2 text := 'Whether AI is paused on this matter%';
begin
  with recursive tree(id) as (
    select p_matter
    union all
    select m.id from public.matterspaces m join tree t on m.parent_matterspace_id = t.id
  )
  select array_agg(id) into v_ids from tree;
  if v_ids is null then return 0; end if;

  if to_regclass('public.documents') is not null then
    update public.documents d
       set processing_status = 'pending', processing_error = null
     where d.matterspace_id = any (v_ids)
       and d.processing_status = 'held'
       and (d.processing_error like v_mark or d.processing_error like v_mark2);
    get diagnostics v_docs = row_count;
  end if;

  -- 'held' is a value of the discovery_job_status ENUM (migration 060). On a
  -- database where 060 was never pasted the label does not exist and the
  -- comparison would raise, so probe pg_enum first rather than assume.
  if to_regclass('public.processing_jobs') is not null
     and exists (
       select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
        where t.typname = 'discovery_job_status' and e.enumlabel = 'held')
  then
    execute $q$
      update public.processing_jobs j
         set status      = 'queued'::public.discovery_job_status,
             error       = null,
             claimed_by  = null,
             claimed_at  = null,
             finished_at = null
       where j.matterspace_id = any ($1)
         and j.status = 'held'::public.discovery_job_status
         and (j.error like $2 or j.error like $3)
    $q$ using v_ids, v_mark, v_mark2;
    get diagnostics v_jobs = row_count;
  end if;

  return v_docs + v_jobs;
end $$;

revoke all on function public._ai_pause_release(uuid) from public;
revoke all on function public._ai_pause_release(uuid) from anon;
revoke all on function public._ai_pause_release(uuid) from authenticated;
revoke all on function public._ai_pause_release(uuid) from service_role;


-- ============================================================================
-- 6. The RPC
-- ============================================================================
-- _matter_set_ai_pause_checked — DEFINER. Reads auth.uid() ITSELF, re-checks
-- membership without RLS, snapshots the display name, writes, and on a resume
-- releases the held work.
create or replace function public._matter_set_ai_pause_checked(
  p_matter uuid,
  p_paused boolean,
  p_note   text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();   -- the GUC, not a parameter: unforgeable
  v_name     text;
  v_out      jsonb;
  v_released integer := 0;
begin
  if v_uid is null then
    raise exception 'pausing AI requires an authenticated caller' using errcode = '42501';
  end if;
  if p_matter is null then
    raise exception 'a matter is required' using errcode = '22004';
  end if;
  if not public._ai_pause_admin(p_matter, v_uid) then
    raise exception 'you do not have permission to change the AI pause on this matter'
      using errcode = '42501';
  end if;

  if to_regclass('public.profiles') is not null then
    select nullif(btrim(coalesce(p.display_name, '')), '')
      into v_name from public.profiles p where p.id = v_uid;
  end if;

  v_out := public._ai_pause_write(p_matter, coalesce(p_paused, false), p_note, v_uid, v_name);
  if not coalesce(p_paused, false) then
    v_released := public._ai_pause_release(p_matter);
  end if;
  return v_out || jsonb_build_object('released', v_released);
end $$;

revoke all on function public._matter_set_ai_pause_checked(uuid, boolean, text) from public;
revoke all on function public._matter_set_ai_pause_checked(uuid, boolean, text) from anon;
grant execute on function public._matter_set_ai_pause_checked(uuid, boolean, text)
  to authenticated, service_role;


-- matter_set_ai_pause — INVOKER. The RPC the app calls.
create or replace function public.matter_set_ai_pause(
  p_matter uuid,
  p_paused boolean,
  p_note   text default null
) returns jsonb
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  -- Evaluated as the CALLER, so matterspaces' own RLS answers first and the
  -- error is the one the caller expects. The DEFINER layer re-asks without
  -- RLS; this one is the house pattern and the early, honest failure.
  if v_uid is not null and not public._ai_pause_may_change(p_matter) then
    raise exception 'you do not have permission to change the AI pause on this matter'
      using errcode = '42501';
  end if;
  return public._matter_set_ai_pause_checked(p_matter, p_paused, p_note);
end $$;

revoke all on function public.matter_set_ai_pause(uuid, boolean, text) from public;
revoke all on function public.matter_set_ai_pause(uuid, boolean, text) from anon;
grant execute on function public.matter_set_ai_pause(uuid, boolean, text)
  to authenticated, service_role;


-- ============================================================================
-- 7. The read
-- ============================================================================
-- "Is AI paused here?" in one round trip, with the chain walked in SQL so the
-- browser does not make one request per ancestor. INVOKER: what the caller can
-- see is what answers, exactly as the seal's own walk does — a chain that
-- passes through a matter this user cannot read stops there and reports what
-- it has, rather than leaking the existence of a parent.
--
-- Returns the NEAREST paused matter on the chain (self first), so the sentence
-- can name who paused it and when.
create or replace function public.matter_ai_pause(p_matter uuid)
returns table (
  paused          boolean,
  paused_matter   uuid,
  paused_matter_name text,
  paused_at       timestamptz,
  paused_by       uuid,
  paused_by_name  text,
  note            text,
  inherited       boolean
)
language plpgsql
security invoker
stable
as $$
declare
  v_id    uuid := p_matter;
  v_row   public.matterspaces;
  v_depth int := 0;
begin
  while v_id is not null and v_depth < 32 loop
    select * into v_row from public.matterspaces m where m.id = v_id;
    exit when v_row.id is null;          -- gone, or invisible to this caller
    if v_row.ai_paused then
      paused := true;
      paused_matter := v_row.id;
      paused_matter_name := v_row.name;
      paused_at := v_row.ai_paused_at;
      paused_by := v_row.ai_paused_by;
      paused_by_name := v_row.ai_paused_by_name;
      note := v_row.ai_pause_note;
      inherited := (v_row.id is distinct from p_matter);
      return next;
      return;
    end if;
    v_id := v_row.parent_matterspace_id;
    v_depth := v_depth + 1;
    v_row := null;
  end loop;

  paused := false;
  paused_matter := null; paused_matter_name := null; paused_at := null;
  paused_by := null; paused_by_name := null; note := null; inherited := false;
  return next;
end $$;

grant execute on function public.matter_ai_pause(uuid) to authenticated, service_role;


-- ============================================================================
-- 8. Tell PostgREST
-- ============================================================================
notify pgrst, 'reload schema';
