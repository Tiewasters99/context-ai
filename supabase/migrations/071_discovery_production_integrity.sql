-- Contextspaces Migration 071: Discovery production integrity — a Bates range
-- is ALLOCATED once and stamping becomes re-runnable; local intake cannot be
-- claimed by a machine that has no such folder; an interactive Stamp/Package
-- click keeps its place in the queue; a held production and a failed document
-- both become visible instead of silent.
--
-- Closes F1, F2, F4, F5, F6 from discovery/RE-VERIFICATION-2026-09-20.md
-- (PR #174). F3 is designed, not built; F7's data side is here (the
-- duplicate/exception columns), its report is in the worker and lib/discovery.
--
-- Why this exists — the one that costs money
-- ---------------------------------------------------------------------------
-- A Bates number is a representation to a court and to an adversary. Since
-- migration 044 a worker that dies mid-stamp no longer leaves its job wedged:
-- the reaper requeues it, and the re-run re-derives the SAME start number,
-- walks into its own half-written bates_registry rows and dies on "Bates
-- collision" (worker/discovery-worker.mjs:758-767) — three times, until the
-- attempt budget is spent. The numbers already written can never be recovered,
-- because bates_registry deliberately has no DELETE policy (030:330-335). One
-- crash therefore burns a permanent hole in a matter's numbering and tells
-- nobody why.
--
-- The fix is to separate the two things the old code did at once:
--
--   ALLOCATION  — deciding which numbers this production gets. Happens once,
--                 in one transaction, under a per-matter advisory lock,
--                 recorded in production_bates_allocations with the exact
--                 per-item plan. Idempotent: asking twice returns the first
--                 answer.
--   REGISTRATION — writing the pages into bates_registry. Re-runnable:
--                 ON CONFLICT DO NOTHING plus a proof that every row in the
--                 range belongs to this document. A requeued job re-stamps
--                 only what is missing and produces byte-for-byte the same
--                 numbers.
--
-- Nothing here can spend a number twice, and nothing here can spend a number
-- and then lose it: the allocation row survives the crash that the registry
-- rows were written under.
--
-- Drift + apply order
-- ---------------------------------------------------------------------------
-- Idempotent, and independent of 064-070: every object is created IF NOT
-- EXISTS / OR REPLACE and every policy is dropped before it is created.
-- It restates two functions from 057 with their signatures unchanged —
-- public._processing_jobs_before_insert() and public.claim_discovery_job(text).
-- If a migration numbered 064-070 also restates either of them, whichever file
-- is pasted LAST wins; paste 071 last, or merge the two bodies by hand.
--
-- ⚠ ORDER IS STRICT: paste 071, reload the schema, THEN deploy the worker.
--
--   * 071 first, old worker still running: fine. The new columns and the
--     allocation table are simply never written, the old direct
--     bates_registry inserts still work exactly as before, and the new claim
--     still hands it jobs. An interactive Stamp/Package click starts getting
--     its +10 immediately, which is the point of the trigger living here.
--
--   * Worker first, 071 not applied: BROKEN, not fail-safe. Stamping does fail
--     safe — allocate_production_bates is its first write, so the job errors
--     with "function does not exist" having spent no number — but INTAKE does
--     not: the duplicate lookup selects duplicate_of_item_id, PostgREST
--     answers 400, and every intake job errors. setProductionStatus writes
--     status_reason, so no production reaches 'review'. holdJob writes 'held',
--     which is not yet a production_status. Do not deploy the worker first.
--
-- Verified by scripts/_verify-discovery-pipeline.mjs, which executes THIS FILE
-- at the end of the real 030 -> 060 chain inside PGlite and drives the whole
-- production through it (crash after allocation, crash mid-stamp, double
-- delivery, a concurrent second production).
--
-- Transaction note (the 060 precedent)
-- ---------------------------------------------------------------------------
-- ALTER TYPE ... ADD VALUE may run inside a transaction block on PG 12+, but
-- the new label may NOT be *used* by a statement in that same transaction.
-- 'held' is added to production_status below and is never used in this file —
-- no cast, no comparison, no default. This file is safe to paste whole into
-- the Supabase SQL editor.

-- ===========================================================================
-- 1. Vocabulary + columns
-- ===========================================================================

-- A production whose intake was parked by the SecureSpace seal is not an
-- error and is certainly not still 'processing'. F5.
alter type public.production_status add value if not exists 'held';

-- The plain sentence behind whatever status the production is in. The UI has
-- nowhere truthful to read today: 'error' prints a generic line and 'held'
-- would print nothing at all.
alter table public.productions
  add column if not exists status_reason text;

-- F6: an exact byte-for-byte duplicate of an earlier item in the SAME
-- production. It keeps its row (opposing counsel's ZIP really did contain it
-- twice, and that fact is part of the record), it is listed in the package's
-- DUPLICATES report, and it is never given a second Bates range.
-- idx_production_items_sha (030:122) is what finds it — the index that has
-- existed since June and was never once queried.
alter table public.production_items
  add column if not exists duplicate_of_item_id uuid
    references public.production_items(id) on delete set null;

create index if not exists idx_production_items_duplicate_of
  on public.production_items (duplicate_of_item_id)
  where duplicate_of_item_id is not null;

-- F2: a job that can only run where it was created. `--intake <folder>` reads
-- a path on the operator's laptop; two always-on Fly machines share this queue
-- and neither of them has that folder. Before this column the reaper could —
-- and on a slow file would — hand one of them the job, which then failed on a
-- missing path and set the whole production to 'error'.
alter table public.processing_jobs
  add column if not exists requires_worker text;

-- ===========================================================================
-- 2. Bates numbering: allocate once, register idempotently (F1)
-- ===========================================================================

-- The SQL twin of lib/discovery/util.mjs formatBates(): prefix + the sequence
-- left-padded to `pad`. Deliberately NOT lpad(), which TRUNCATES when the
-- number is already longer than the pad width — JavaScript's padStart() leaves
-- it alone, and a Bates number that silently loses its leading digit past
-- 9,999,999 pages would be the worst possible bug in this file.
create or replace function public._bates_number(p_prefix text, p_pad int, p_seq bigint)
returns text
language sql
immutable
as $$
  select coalesce(p_prefix, '')
      || case when coalesce(p_pad, 0) > length(p_seq::text)
              then repeat('0', coalesce(p_pad, 0) - length(p_seq::text))
              else '' end
      || p_seq::text
$$;

grant execute on function public._bates_number(text, int, bigint)
  to authenticated, service_role;

-- One row per production that has ever been given numbers. This row is the
-- authority a re-run consults, and it outlives the crash that interrupted the
-- registry writes.
--
-- item_plan is the whole point: a JSON array, in the stamping order, of
--   { item_id, pages, start_seq, end_seq, bates_first, bates_last }
-- so the numbers are DERIVED from a stable order that was fixed at allocation
-- time rather than recomputed from a table that may have changed underneath.
create table if not exists public.production_bates_allocations (
  production_id  uuid primary key references public.productions(id) on delete cascade,
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  bates_prefix   text,
  bates_pad      int not null default 7,
  start_seq      bigint not null,
  end_seq        bigint not null,
  total_pages    int not null,
  item_plan      jsonb not null default '[]',
  created_at     timestamptz not null default now(),
  check (end_seq >= start_seq),
  check (start_seq >= 1)
);

create index if not exists idx_bates_alloc_matter
  on public.production_bates_allocations (matterspace_id, end_seq desc);

alter table public.production_bates_allocations enable row level security;

-- Readable by the matter's members through 030's SECURITY INVOKER wrapper
-- (feedback_rls_security_invoker_wrappers: never call a SECURITY DEFINER
-- helper directly from a policy expression). No INSERT/UPDATE/DELETE policy
-- exists on purpose — like bates_registry, allocations are the worker's to
-- write, and the service role bypasses RLS to do it.
drop policy if exists "Matter members view bates allocations" on public.production_bates_allocations;
create policy "Matter members view bates allocations" on public.production_bates_allocations
  for select using (public._disc_matter_access(matterspace_id));

-- ---------------------------------------------------------------------------
-- allocate_production_bates — decide this production's numbers, once.
--
-- p_items: [{ "item_id": uuid, "pages": int }, ...] in the stamping order
--          (sort_order, id), page counts already pre-flighted by the worker.
-- The start number is the production's own bates_start when the lawyer set one
-- (the lawyer owns every call), otherwise the matter's high-water mark + 1 —
-- counting BOTH numbers already registered and numbers already reserved by
-- another production that is mid-stamp.
--
-- Asking twice returns the first answer. Asking with a DIFFERENT set of
-- documents is refused — unless not one number has been registered yet, in
-- which case the reservation is free to give back and is silently re-made.
-- ---------------------------------------------------------------------------
create or replace function public.allocate_production_bates(
  p_production uuid,
  p_items      jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prod   public.productions%rowtype;
  v_alloc  public.production_bates_allocations%rowtype;
  v_want   jsonb;
  v_have   jsonb;
  v_spent  int;
  v_total  bigint;
  v_start  bigint;
  v_end    bigint;
  v_hw     bigint;
  v_res    bigint;
  v_clash  int;
  v_plan   jsonb := '[]'::jsonb;
  v_seq    bigint;
  v_e      jsonb;
  v_pages  int;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'allocate_production_bates: p_items must be a non-empty array';
  end if;

  select * into v_prod from public.productions where id = p_production for update;
  if not found then
    raise exception 'allocate_production_bates: production % not found', p_production;
  end if;

  -- Serialise allocation per matter. Two productions stamping in the same
  -- second must not reserve the same numbers, and PGlite's single connection
  -- cannot prove that — a second Fly machine can.
  perform pg_advisory_xact_lock(hashtextextended(v_prod.matterspace_id::text, 0));

  -- What the caller is asking for, reduced to the part that is identity.
  select coalesce(jsonb_agg(jsonb_build_object(
           'item_id', t.e->>'item_id', 'pages', (t.e->>'pages')::int) order by t.ord), '[]'::jsonb)
    into v_want
    from jsonb_array_elements(p_items) with ordinality t(e, ord);

  select * into v_alloc from public.production_bates_allocations where production_id = p_production;
  if found then
    if coalesce(v_alloc.bates_prefix, '') is distinct from coalesce(v_prod.bates_prefix, '')
       or v_alloc.bates_pad is distinct from v_prod.bates_pad then
      raise exception
        'Bates numbers were already allocated for this production as %-%. Changing the prefix or the pad width now would split one production across two numbering schemes; create a supplemental production instead.',
        public._bates_number(v_alloc.bates_prefix, v_alloc.bates_pad, v_alloc.start_seq),
        public._bates_number(v_alloc.bates_prefix, v_alloc.bates_pad, v_alloc.end_seq);
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
             'item_id', t.e->>'item_id', 'pages', (t.e->>'pages')::int) order by t.ord), '[]'::jsonb)
      into v_have
      from jsonb_array_elements(v_alloc.item_plan) with ordinality t(e, ord);

    if v_have is distinct from v_want then
      select count(*) into v_spent from public.bates_registry where production_id = p_production;
      if v_spent > 0 then
        raise exception
          'The documents in this production changed after % Bates number(s) had already been assigned (%-%). Those numbers cannot be re-used. Finish or abandon this production and create a supplemental one.',
          v_spent,
          public._bates_number(v_alloc.bates_prefix, v_alloc.bates_pad, v_alloc.start_seq),
          public._bates_number(v_alloc.bates_prefix, v_alloc.bates_pad, v_alloc.end_seq);
      end if;
      -- Nothing was ever registered, so the reservation costs nothing to give
      -- back: the reviewer tagged a document between the failed attempt and
      -- this one, which is exactly what review is for.
      delete from public.production_bates_allocations where production_id = p_production;
    else
      return to_jsonb(v_alloc);
    end if;
  end if;

  select coalesce(sum((e->>'pages')::int), 0) into v_total from jsonb_array_elements(p_items) e;
  if v_total <= 0 then
    raise exception 'allocate_production_bates: the item plan totals % page(s)', v_total;
  end if;

  select coalesce(max(bates_seq), 0) into v_hw
    from public.bates_registry where matterspace_id = v_prod.matterspace_id;
  select coalesce(max(end_seq), 0) into v_res
    from public.production_bates_allocations where matterspace_id = v_prod.matterspace_id;

  v_start := coalesce(v_prod.bates_start, greatest(v_hw, v_res) + 1);
  if v_start < 1 then
    raise exception 'allocate_production_bates: a Bates start of % is not a number', v_start;
  end if;
  v_end := v_start + v_total - 1;

  select count(*) into v_clash from public.bates_registry
   where matterspace_id = v_prod.matterspace_id
     and bates_seq between v_start and v_end;
  if v_clash > 0 then
    raise exception 'Bates collision: % number(s) in %-% are already assigned in this matter',
      v_clash,
      public._bates_number(v_prod.bates_prefix, v_prod.bates_pad, v_start),
      public._bates_number(v_prod.bates_prefix, v_prod.bates_pad, v_end);
  end if;

  if exists (
    select 1 from public.production_bates_allocations a
     where a.matterspace_id = v_prod.matterspace_id
       and a.production_id <> p_production
       and a.start_seq <= v_end and a.end_seq >= v_start
  ) then
    raise exception 'Bates reservation conflict: %-% overlaps numbers already allocated to another production in this matter',
      public._bates_number(v_prod.bates_prefix, v_prod.bates_pad, v_start),
      public._bates_number(v_prod.bates_prefix, v_prod.bates_pad, v_end);
  end if;

  v_seq := v_start;
  for v_e in
    select t.e from jsonb_array_elements(p_items) with ordinality t(e, ord) order by t.ord
  loop
    v_pages := (v_e->>'pages')::int;
    if v_pages is null or v_pages < 1 then
      raise exception 'allocate_production_bates: item % was pre-flighted at % page(s)',
        v_e->>'item_id', coalesce(v_pages::text, 'null');
    end if;
    v_plan := v_plan || jsonb_build_array(jsonb_build_object(
      'item_id',     v_e->>'item_id',
      'pages',       v_pages,
      'start_seq',   v_seq,
      'end_seq',     v_seq + v_pages - 1,
      'bates_first', public._bates_number(v_prod.bates_prefix, v_prod.bates_pad, v_seq),
      'bates_last',  public._bates_number(v_prod.bates_prefix, v_prod.bates_pad, v_seq + v_pages - 1)));
    v_seq := v_seq + v_pages;
  end loop;

  insert into public.production_bates_allocations
    (production_id, matterspace_id, bates_prefix, bates_pad, start_seq, end_seq, total_pages, item_plan)
  values
    (p_production, v_prod.matterspace_id, v_prod.bates_prefix, v_prod.bates_pad,
     v_start, v_end, v_total, v_plan)
  returning * into v_alloc;

  -- The range is visible on the production the moment it is reserved, not
  -- only when stamping finishes. A crash between the two used to leave the
  -- production showing no range at all while its numbers were already gone.
  update public.productions
     set bates_start = v_start, bates_end = v_end
   where id = p_production;

  return to_jsonb(v_alloc);
end $$;

revoke execute on function public.allocate_production_bates(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.allocate_production_bates(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- register_bates_pages — write one document's pages into the registry, as
-- many times as anyone asks, with the same result every time.
--
-- The prefix and pad come from the ALLOCATION, never from the caller, so a
-- re-run cannot produce a different string for the same sequence number.
-- ---------------------------------------------------------------------------
create or replace function public.register_bates_pages(
  p_production uuid,
  p_item       uuid,
  p_start_seq  bigint,
  p_pages      int
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alloc   public.production_bates_allocations%rowtype;
  v_ok      boolean;
  v_ins     int := 0;
  v_foreign int;
  v_inrange int;
  v_last    bigint;
begin
  if p_pages is null or p_pages < 1 then
    raise exception 'register_bates_pages: % page(s) is not a document', coalesce(p_pages::text, 'null');
  end if;
  v_last := p_start_seq + p_pages - 1;

  select * into v_alloc from public.production_bates_allocations where production_id = p_production;
  if not found then
    raise exception 'register_bates_pages: production % has no Bates allocation — allocate first', p_production;
  end if;

  -- The range must be exactly the one this document was allocated. A caller
  -- that has drifted from the plan is refused before it can write anything.
  select true into v_ok
    from jsonb_array_elements(v_alloc.item_plan) e
   where e->>'item_id' = p_item::text
     and (e->>'start_seq')::bigint = p_start_seq
     and (e->>'pages')::int = p_pages
   limit 1;
  if not coalesce(v_ok, false) then
    raise exception 'register_bates_pages: %-% is not the range allocated to document % in this production',
      p_start_seq, v_last, p_item;
  end if;

  insert into public.bates_registry
    (matterspace_id, bates_number, bates_seq, production_id, production_item_id, page_number)
  select v_alloc.matterspace_id,
         public._bates_number(v_alloc.bates_prefix, v_alloc.bates_pad, p_start_seq + g),
         p_start_seq + g, p_production, p_item, g + 1
    from generate_series(0, p_pages - 1) g
  on conflict (matterspace_id, bates_number) do nothing;
  get diagnostics v_ins = row_count;

  -- Whatever was already there has to be OURS. ON CONFLICT DO NOTHING makes a
  -- re-run free; it must never make a genuine collision quiet.
  select count(*) into v_foreign from public.bates_registry r
   where r.matterspace_id = v_alloc.matterspace_id
     and r.bates_seq between p_start_seq and v_last
     and (r.production_item_id is distinct from p_item
          or r.production_id is distinct from p_production);
  if v_foreign > 0 then
    raise exception 'Bates collision: % number(s) in %-% belong to another document; nothing was re-used',
      v_foreign,
      public._bates_number(v_alloc.bates_prefix, v_alloc.bates_pad, p_start_seq),
      public._bates_number(v_alloc.bates_prefix, v_alloc.bates_pad, v_last);
  end if;

  -- ...and there must be exactly as many of them as the document has pages.
  -- Catches the one case the ownership test cannot see: the same document
  -- registered twice under two different prefixes.
  select count(*) into v_inrange from public.bates_registry r
   where r.matterspace_id = v_alloc.matterspace_id
     and r.bates_seq between p_start_seq and v_last;
  if v_inrange <> p_pages then
    raise exception 'Bates registry holds % row(s) for the % page(s) allocated at %-%',
      v_inrange, p_pages, p_start_seq, v_last;
  end if;

  return jsonb_build_object(
    'inserted', v_ins, 'pages', p_pages,
    'bates_first', public._bates_number(v_alloc.bates_prefix, v_alloc.bates_pad, p_start_seq),
    'bates_last',  public._bates_number(v_alloc.bates_prefix, v_alloc.bates_pad, v_last));
end $$;

revoke execute on function public.register_bates_pages(uuid, uuid, bigint, int) from public, anon, authenticated;
grant  execute on function public.register_bates_pages(uuid, uuid, bigint, int) to service_role;

-- ---------------------------------------------------------------------------
-- release_production_bates — the human escape hatch. Gives a reservation back
-- when, and only when, not one of its numbers has been registered. If any has,
-- it refuses: a spent Bates number is spent.
-- ---------------------------------------------------------------------------
create or replace function public.release_production_bates(p_production uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_spent int;
begin
  select count(*) into v_spent from public.bates_registry where production_id = p_production;
  if v_spent > 0 then
    raise exception 'Cannot release: % Bates number(s) have already been assigned in this production', v_spent;
  end if;
  delete from public.production_bates_allocations where production_id = p_production;
  update public.productions set bates_start = null, bates_end = null where id = p_production;
  return jsonb_build_object('released', true);
end $$;

revoke execute on function public.release_production_bates(uuid) from public, anon, authenticated;
grant  execute on function public.release_production_bates(uuid) to service_role;

-- ===========================================================================
-- 3. The queue: an interactive click keeps its place (F4), and a local job
--    stays local (F2)
-- ===========================================================================

-- Restated in full from 057, with one rule added.
--
-- 057's burst rule is per matter and counts rows: ten queued jobs in a matter
-- and the ELEVENTH normal-priority insert is written at -10. That eleventh
-- insert is very often the lawyer pressing Stamp on the production sitting in
-- that same matter, while the ten are a vault upload of a deposition batch.
-- The person is at the screen; the batch is not. 057 demoted exactly the wrong
-- one (057:130-138 — F4).
--
-- stamp_production and package_production are, by construction, a click: the
-- UI offers Stamp only at status 'review' and Package only at 'stamped', one
-- per production, and the production lock (030:359-380) stops a second. So
-- they are promoted to +10 by the TRIGGER rather than by the caller — which
-- keeps 057's clamp meaningful, because an authenticated caller still cannot
-- ask for a priority above 0 and get it.
--
-- And the promotion is itself burst-capped: past v_int_burst queued
-- interactive jobs in one matter it is no longer a person waiting at a screen,
-- it is a flood, and it falls through to 057's ordinary rule.
--
-- SECURITY INVOKER on purpose, exactly as in 057: current_user has to be the
-- CALLER's role for the clamp to mean anything.
create or replace function public._processing_jobs_before_insert()
returns trigger
language plpgsql
as $$
declare
  -- Queued jobs in one matter beyond which a normal-priority enqueue is
  -- treated as bulk. 057's value, unchanged.
  v_burst     constant int := 10;
  -- Queued interactive Discovery jobs in one matter beyond which a Stamp or
  -- Package click stops being a person and starts being a flood.
  v_int_burst constant int := 5;
  -- The job types a human is watching a spinner for.
  v_interactive constant text[] := array['stamp_production', 'package_production'];
  v_queued int;
begin
  if new.serverspace_id is null then
    select m.serverspace_id into new.serverspace_id
      from public.matterspaces m
     where m.id = new.matterspace_id;
  end if;

  if new.priority > 0 and current_user not in ('service_role', 'postgres') then
    new.priority := 0;
  end if;

  if new.priority = 0 and new.status = 'queued' then
    if new.job_type = any (v_interactive) then
      select count(*) into v_queued
        from public.processing_jobs j
       where j.matterspace_id = new.matterspace_id
         and j.status = 'queued'
         and j.job_type = any (v_interactive);
      if v_queued < v_int_burst then
        new.priority := 10;
        return new;
      end if;
    end if;

    select count(*) into v_queued
      from public.processing_jobs j
     where j.matterspace_id = new.matterspace_id
       and j.status = 'queued';
    if v_queued >= v_burst then
      new.priority := -10;
    end if;
  end if;

  return new;
end $$;

drop trigger if exists processing_jobs_before_insert on public.processing_jobs;
create trigger processing_jobs_before_insert
  before insert on public.processing_jobs
  for each row execute function public._processing_jobs_before_insert();

-- ---------------------------------------------------------------------------
-- claim_discovery_job — restated from 057 (which restated 045, which is the
-- body production runs). Two changes, both about requires_worker:
--
--   1. The reaper never requeues a pinned job. A `--intake <folder>` job whose
--      worker stopped is not retryable anywhere else: the folder is on that
--      machine. Before this, 044's reaper handed it to a Fly machine, which
--      failed on a missing path and set the production to 'error' with a
--      message about a directory nobody else can see (F2). It now goes
--      straight to a terminal 'error' with a sentence a lawyer can act on,
--      and the production says the same thing.
--
--   2. The claim itself skips a pinned job belonging to another worker, so
--      even a job requeued by hand cannot be taken by the wrong machine.
--
-- Everything else — the staleness window, the attempt accounting, the
-- SKIP LOCKED claim, the enum cast 045 hotfixed — is 057's, untouched.
-- ---------------------------------------------------------------------------
create or replace function public.claim_discovery_job(p_worker text)
returns setof public.processing_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stale interval := interval '5 minutes';
begin
  -- Reap dead claims. Capture the ones we are giving up on so their documents
  -- can be marked in the same statement chain.
  with reaped as (
    update public.processing_jobs
       set status       = (case
                             when requires_worker is not null then 'error'
                             when attempts >= max_attempts then 'error'
                             else 'queued' end)::discovery_job_status,
           error        = case
                            when requires_worker is not null
                              then 'This intake was run from a folder on ' || requires_worker ||
                                   '. That machine stopped responding, and no other worker can '
                                   || 'reach the folder. Re-run the intake on that machine.'
                            when attempts >= max_attempts
                              then 'The worker stopped responding ' || attempts ||
                                   ' times while processing this file. It may be too large '
                                   || 'to process in one piece.'
                            else error end,
           finished_at  = case
                            when requires_worker is not null or attempts >= max_attempts
                              then now() else finished_at end,
           claimed_by   = null,
           claimed_at   = null,
           heartbeat_at = null
     where status = 'running'
       and coalesce(heartbeat_at, claimed_at) < now() - v_stale
    returning id, job_type, status, payload, production_id, requires_worker
  ),
  -- A pinned intake that died takes its production out of 'processing' and
  -- says why, in one sentence, on the production itself. Without this the
  -- production sits at 'processing' forever with no worker and no error.
  -- A data-modifying CTE runs to completion whether or not the primary query
  -- reads it, so this needs no artificial reference below.
  parked as (
    update public.productions p
       set status = 'error',
           status_reason = 'The local intake running on ' || r.requires_worker ||
                           ' stopped before it finished. Re-run it on that machine; '
                           || 'nothing has been stamped.'
      from reaped r
     where r.requires_worker is not null
       and r.production_id = p.id
       and p.status not in ('stamped', 'packaged', 'delivered')
    returning p.id
  )
  update public.documents d
     set processing_status = 'error',
         processing_error  = 'Processing stopped unexpectedly and could not be resumed. '
                             || 'The file may be too large; try splitting it, or upload it again.'
    from reaped r
   where r.status = 'error'
     and r.job_type = 'ingest_document'
     and (r.payload->>'document_id')::uuid = d.id
     and d.processing_status not in ('ready', 'error');

  -- Then take the highest-priority queued job; oldest first among equals.
  -- A job pinned to another machine is not ours to take.
  return query
  update public.processing_jobs
     set status       = 'running',
         claimed_by   = p_worker,
         claimed_at   = now(),
         heartbeat_at = now(),
         attempts     = attempts + 1
   where id = (
     select id
       from public.processing_jobs
      where status = 'queued'
        and (requires_worker is null or requires_worker = p_worker)
      order by priority desc, created_at
      limit 1
      for update skip locked
   )
  returning *;
end $$;

revoke execute on function public.claim_discovery_job(text) from public, anon, authenticated;
grant  execute on function public.claim_discovery_job(text) to service_role;

notify pgrst, 'reload schema';
