-- 121_trademark_clearance.sql — Trademark Clearance (a recipe), slice 1
--
-- Spec: docs/specs/TRADEMARK-CLEARANCE-2026-10-18.md (Fable, v0.1) and its
-- Opus build handoff of the same date.
--
-- WHY
-- A knockout search for a proposed mark is a judgment made by a lawyer over a
-- list of register records. The recipe prepares that list and keeps a record
-- someone else could reconstruct: every query generated, every run recorded
-- (with its reported and captured counts, so a short page or a pagination
-- overlap shows as a GAP rather than as "no results"), every hit, every
-- proposed bin and every bin the reviewer decided, with initials. The product
-- never says a mark is clear; the reviewer decides every bin and signs every
-- stage, and this file is where that rule is enforced.
--
-- WHAT
--   tm_clearances   one mark searched in one matter: intake, applicant block,
--                   known marks, SEARCH classes and FILING classes (two lists;
--                   filing ⊆ search, by trigger), the confirmed decomposition,
--                   foreign equivalents, the procedure hash and the self-test.
--   tm_stages       the docket: ten rows per clearance, seeded by trigger.
--                   'done' (or 'skipped') is a sign-off: initials required, the
--                   signer and time stamped by the database. Stage N cannot be
--                   'done' before its prerequisite is: 2←1, 3←2, 4←3, 5←4, 8←5.
--   tm_queries      the generated (or hand-written) query list. A query that
--                   has a run is frozen: its string cannot change and it cannot
--                   be deleted, so regeneration replaces only queries not run.
--   tm_query_runs   one recorded run of one query, append-only. The database
--                   computes captured_count from the rows and sets `gap` when
--                   the run failed, the reported count is missing or differs,
--                   or a serial repeats inside the run (pagination overlap).
--   tm_hits         one register record per clearance (unique by serial),
--                   with the model's proposal and the reviewer's decision.
--                   Any change of bin is a decision: initials required,
--                   decided_by = auth.uid() and decided_at = now() stamped
--                   here. query_seqs is merged, never replaced, so a re-run
--                   never erases where a hit was found.
--
-- RLS: through the clearance's matter. Read = can_access_matter(matter),
-- write = can_write_matter(matter); both SECURITY INVOKER since 098, called
-- directly. Every function here is SECURITY INVOKER: there is no SECURITY
-- DEFINER in this file (house rule). created_by / run_by / done_by /
-- decided_by come from auth.uid(), never from the client.
--
-- The Record (events, 064): nine matter-bound kinds, re-declaring
-- events_kind_check with the UNION of every kind lib/ledger.mjs's EVENT_KINDS
-- holds (064 + 072 + 073 + 094 + 100 + 120 + these), in 120's guarded pattern.
-- Payloads are metadata only: serials, counts, bins, initials, ids, hashes —
-- never goods text or the mark's description.
--   tm.clearance.created {clearance_id}
--   tm.intake.updated    {clearance_id, fields}
--   tm.classes.set       {clearance_id, search, filing}        (codes only)
--   tm.queries.generated {clearance_id, count, procedure_hash}
--   tm.query.run         {clearance_id, seq, reported, captured, gap, source}
--   tm.hit.proposed      {clearance_id, serial, bin, model}
--   tm.hit.decided       {clearance_id, serial, bin, initials}
--   tm.stage.done        {clearance_id, stage, status, initials}
--   tm.report.filed      {clearance_id, document_id, sha256}
--
-- Needs: 098 (INVOKER can_access_matter / can_write_matter), matterspaces,
-- documents. Additive only: five new tables and a wider kind list; no
-- existing row or column changes. Re-runnable: executed twice in PGlite by
-- scripts/_verify-trademark-121.mjs.
--
-- ⚠ NOT APPLIED until Eden approves this file by name.
-- ⚠ After pasting, run:  notify pgrst, 'reload schema';  (last statement here.)

do $pre$
begin
  if to_regprocedure('public.can_access_matter(uuid)') is null
     or to_regprocedure('public.can_write_matter(uuid)') is null then
    raise exception '121 needs migration 098 (can_access_matter / can_write_matter) — paste 098 first.';
  end if;
  if to_regclass('public.matterspaces') is null or to_regclass('public.documents') is null then
    raise exception '121 needs public.matterspaces and public.documents.';
  end if;
end $pre$;

-- ============================================================================
-- 1. tm_clearances — one mark, one matter
-- ============================================================================
create table if not exists public.tm_clearances (
  id                  uuid primary key default gen_random_uuid(),
  matterspace_id      uuid not null references public.matterspaces(id) on delete cascade,
  mark                text not null check (char_length(btrim(mark)) between 1 and 200),
  mark_format         text not null default 'standard' check (mark_format in ('standard', 'stylized')),
  goods_services      text not null default '' check (char_length(goods_services) <= 20000),
  users               text not null default '' check (char_length(users) <= 4000),
  -- {legal_name, entity_type, state, formation_status: 'formed'|'pending'|'individual',
  --  formation_date, domicile_address, mailing_address,
  --  address_is_mail_drop: 'yes'|'no'|'unknown'}
  applicant           jsonb not null default '{}'::jsonb check (jsonb_typeof(applicant) = 'object'),
  known_marks         jsonb not null default '[]'::jsonb check (jsonb_typeof(known_marks) = 'array'),
  search_classes      jsonb not null default '[]'::jsonb check (jsonb_typeof(search_classes) = 'array'),
  filing_classes      jsonb not null default '[]'::jsonb check (jsonb_typeof(filing_classes) = 'array'),
  -- {opening, hinge, ending, reason, foreign: [{word, language, meaning}]}
  decomposition       jsonb,
  foreign_equivalents text[] not null default '{}',
  procedure_hash      text check (procedure_hash is null or procedure_hash ~ '^[0-9a-f]{64}$'),
  self_test_passed    boolean,
  created_by          uuid not null default auth.uid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists tm_clearances_matter_idx on public.tm_clearances (matterspace_id);

comment on table public.tm_clearances is
  'Trademark Clearance: one proposed mark searched in one matter. Search classes and filing classes are two lists; filing ⊆ search.';

-- A class list: [{code:'009', reason}], codes three digits and unique.
create or replace function public._tm_class_list_ok(p jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) <= 45
     and not exists (
       select 1 from jsonb_array_elements(p) e
        where jsonb_typeof(e) <> 'object'
           or coalesce(e->>'code', '') !~ '^[0-9]{3}$'
           or char_length(coalesce(e->>'reason', '')) > 2000
     )
     and (select count(distinct e->>'code') from jsonb_array_elements(p) e) = jsonb_array_length(p)
$$;

create or replace function public._tm_clearances_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
  else
    if new.matterspace_id is distinct from old.matterspace_id
       or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'clearance: the matter, author and creation time do not change'
        using errcode = '42501';
    end if;
  end if;

  new.mark := btrim(new.mark);

  if not public._tm_class_list_ok(new.search_classes) then
    raise exception 'clearance: search classes must be [{code, reason}] with unique three-digit codes'
      using errcode = '23514';
  end if;
  if not public._tm_class_list_ok(new.filing_classes) then
    raise exception 'clearance: filing classes must be [{code, reason}] with unique three-digit codes'
      using errcode = '23514';
  end if;
  -- Search classes are not filing classes (spec §0.1, rule 7): filing is
  -- narrower, never broader.
  if exists (
    select 1 from jsonb_array_elements(new.filing_classes) f
     where not exists (select 1 from jsonb_array_elements(new.search_classes) s
                        where s->>'code' = f->>'code')
  ) then
    raise exception 'clearance: every filing class must also be a search class'
      using errcode = '23514';
  end if;

  if new.decomposition is not null and jsonb_typeof(new.decomposition) <> 'object' then
    raise exception 'clearance: the decomposition is {opening, hinge, ending, reason, foreign}'
      using errcode = '23514';
  end if;
  if coalesce(array_length(new.foreign_equivalents, 1), 0) > 50 then
    raise exception 'clearance: at most 50 foreign equivalents' using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end $$;

drop trigger if exists tm_clearances_guard on public.tm_clearances;
create trigger tm_clearances_guard
  before insert or update on public.tm_clearances
  for each row execute function public._tm_clearances_guard();

alter table public.tm_clearances enable row level security;

drop policy if exists "Matter members read clearances" on public.tm_clearances;
create policy "Matter members read clearances" on public.tm_clearances
  for select using (public.can_access_matter(matterspace_id));

drop policy if exists "Matter writers create clearances" on public.tm_clearances;
create policy "Matter writers create clearances" on public.tm_clearances
  for insert with check (created_by = auth.uid() and public.can_write_matter(matterspace_id));

drop policy if exists "Matter writers update clearances" on public.tm_clearances;
create policy "Matter writers update clearances" on public.tm_clearances
  for update using (public.can_write_matter(matterspace_id))
  with check (public.can_write_matter(matterspace_id));

drop policy if exists "Matter writers delete clearances" on public.tm_clearances;
create policy "Matter writers delete clearances" on public.tm_clearances
  for delete using (public.can_write_matter(matterspace_id));

revoke all on public.tm_clearances from anon;
grant select, insert, update, delete on public.tm_clearances to authenticated;
grant all on public.tm_clearances to service_role;

-- ============================================================================
-- 2. tm_stages — the docket, ten rows per clearance
-- ============================================================================
create table if not exists public.tm_stages (
  clearance_id        uuid not null references public.tm_clearances(id) on delete cascade,
  stage               int  not null check (stage between 1 and 10),
  status              text not null default 'pending'
                      check (status in ('pending', 'in_progress', 'awaiting_review', 'done', 'skipped')),
  done_by             uuid,
  initials            text check (initials is null or char_length(initials) between 1 and 4),
  done_at             timestamptz,
  output_document_id  uuid references public.documents(id) on delete set null,
  note                text check (note is null or char_length(note) <= 2000),
  primary key (clearance_id, stage)
);

comment on table public.tm_stages is
  'Trademark Clearance: the docket. Done (or skipped) is a reviewer sign-off with initials; a stage cannot be done before its prerequisite.';

-- The prerequisite of each stage that has one (spec §2, handoff §2).
create or replace function public._tm_stage_prerequisite(p_stage int)
returns int
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select case p_stage when 2 then 1 when 3 then 2 when 4 then 3 when 5 then 4 when 8 then 5 else null end
$$;

create or replace function public._tm_stages_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_pre      int;
  v_pre_done boolean;
begin
  if tg_op = 'INSERT' then
    -- A stage is born pending, unsigned.
    new.status := 'pending';
    new.done_by := null; new.done_at := null; new.initials := null;
    return new;
  end if;

  if new.clearance_id is distinct from old.clearance_id or new.stage is distinct from old.stage then
    raise exception 'stage: a stage row stays on its clearance and number' using errcode = '42501';
  end if;

  if new.status in ('done', 'skipped') then
    -- A sign-off: initials, stamped by the database. Re-signing (new
    -- initials on a done stage) re-stamps; an untouched done row keeps its stamp.
    if new.status is distinct from old.status
       or new.initials is distinct from old.initials then
      if char_length(btrim(coalesce(new.initials, ''))) not between 1 and 4 then
        raise exception 'stage %: signing a stage off needs your initials (1 to 4 characters)', new.stage
          using errcode = '23514';
      end if;
      new.initials := upper(btrim(new.initials));
      new.done_by := auth.uid();
      new.done_at := now();
    else
      new.done_by := old.done_by;
      new.done_at := old.done_at;
    end if;

    if new.status = 'done' then
      v_pre := public._tm_stage_prerequisite(new.stage);
      if v_pre is not null then
        select status = 'done' into v_pre_done
          from public.tm_stages where clearance_id = new.clearance_id and stage = v_pre;
        if not coalesce(v_pre_done, false) then
          raise exception 'stage %: stage % must be done first', new.stage, v_pre
            using errcode = '23514';
        end if;
      end if;
    end if;
  else
    -- Not signed off: no signer.
    new.done_by := null; new.done_at := null; new.initials := null;
  end if;
  return new;
end $$;

drop trigger if exists tm_stages_guard on public.tm_stages;
create trigger tm_stages_guard
  before insert or update on public.tm_stages
  for each row execute function public._tm_stages_guard();

-- Seed the ten rows AFTER the clearance exists, so the stage insert policy's
-- join to tm_clearances can see it (SECURITY INVOKER, the caller's RLS).
create or replace function public._tm_clearances_seed_stages()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  insert into public.tm_stages (clearance_id, stage)
  select new.id, s from generate_series(1, 10) s
  on conflict (clearance_id, stage) do nothing;
  return null;
end $$;

drop trigger if exists tm_clearances_seed_stages on public.tm_clearances;
create trigger tm_clearances_seed_stages
  after insert on public.tm_clearances
  for each row execute function public._tm_clearances_seed_stages();

alter table public.tm_stages enable row level security;

drop policy if exists "Matter members read stages" on public.tm_stages;
create policy "Matter members read stages" on public.tm_stages
  for select using (exists (
    select 1 from public.tm_clearances c
     where c.id = tm_stages.clearance_id and public.can_access_matter(c.matterspace_id)));

drop policy if exists "Matter writers seed stages" on public.tm_stages;
create policy "Matter writers seed stages" on public.tm_stages
  for insert with check (exists (
    select 1 from public.tm_clearances c
     where c.id = tm_stages.clearance_id and public.can_write_matter(c.matterspace_id)));

drop policy if exists "Matter writers sign stages" on public.tm_stages;
create policy "Matter writers sign stages" on public.tm_stages
  for update
  using (exists (select 1 from public.tm_clearances c
                  where c.id = tm_stages.clearance_id and public.can_write_matter(c.matterspace_id)))
  with check (exists (select 1 from public.tm_clearances c
                       where c.id = tm_stages.clearance_id and public.can_write_matter(c.matterspace_id)));

-- No DELETE policy or grant: stage rows go only with their clearance (cascade).
revoke all on public.tm_stages from anon;
revoke delete on public.tm_stages from authenticated;
grant select, insert, update on public.tm_stages to authenticated;
grant all on public.tm_stages to service_role;

-- ============================================================================
-- 3. tm_queries — the query list
-- ============================================================================
create table if not exists public.tm_queries (
  id                  uuid primary key default gen_random_uuid(),
  clearance_id        uuid not null references public.tm_clearances(id) on delete cascade,
  seq                 int  not null check (seq between 0 and 999),
  purpose             text not null check (purpose in (
                        'selftest', 'exact', 'embedded', 'hinge', 'variants', 'stems', 'endings',
                        'prefix', 'prefix_narrowed', 'known', 'owner', 'foreign', 'rescued', 'manual')),
  query               text not null check (char_length(btrim(query)) between 1 and 2000),
  class_filter        text[] not null default '{}',
  live_only           boolean not null default false,
  generator_version   text check (generator_version is null or char_length(generator_version) <= 40),
  created_at          timestamptz not null default now(),
  unique (clearance_id, seq)
);

create index if not exists tm_queries_clearance_idx on public.tm_queries (clearance_id, seq);

comment on table public.tm_queries is
  'Trademark Clearance: the queries. A query with a recorded run is frozen (string, seq and purpose) and cannot be deleted.';

create or replace function public._tm_queries_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id     uuid := case when tg_op = 'DELETE' then old.id else new.id end;
  v_parent uuid := case when tg_op = 'DELETE' then old.clearance_id else new.clearance_id end;
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from unnest(new.class_filter) c where c !~ '^[0-9]{3}$') then
      raise exception 'query: class filters are three-digit class codes' using errcode = '23514';
    end if;
    return new;
  end if;

  -- The clearance itself is being deleted (cascade): let it go.
  if not exists (select 1 from public.tm_clearances where id = v_parent) then
    if tg_op = 'DELETE' then return old; end if;
    raise exception 'query: clearance not found' using errcode = '42501';
  end if;

  if exists (select 1 from public.tm_query_runs r where r.query_id = v_id) then
    if tg_op = 'DELETE' then
      raise exception 'query %: it has a recorded run and stays in the record', old.seq
        using errcode = '42501';
    end if;
    if new.query is distinct from old.query or new.seq is distinct from old.seq
       or new.purpose is distinct from old.purpose
       or new.class_filter is distinct from old.class_filter
       or new.live_only is distinct from old.live_only then
      raise exception 'query %: it has a recorded run; its string and filters are frozen', old.seq
        using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;

  if new.clearance_id is distinct from old.clearance_id then
    raise exception 'query: a query stays on its clearance' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(new.class_filter) c where c !~ '^[0-9]{3}$') then
    raise exception 'query: class filters are three-digit class codes' using errcode = '23514';
  end if;
  return new;
end $$;

-- (The trigger is created after tm_query_runs exists, below.)

alter table public.tm_queries enable row level security;

drop policy if exists "Matter members read queries" on public.tm_queries;
create policy "Matter members read queries" on public.tm_queries
  for select using (exists (
    select 1 from public.tm_clearances c
     where c.id = tm_queries.clearance_id and public.can_access_matter(c.matterspace_id)));

drop policy if exists "Matter writers add queries" on public.tm_queries;
create policy "Matter writers add queries" on public.tm_queries
  for insert with check (exists (
    select 1 from public.tm_clearances c
     where c.id = tm_queries.clearance_id and public.can_write_matter(c.matterspace_id)));

drop policy if exists "Matter writers update queries" on public.tm_queries;
create policy "Matter writers update queries" on public.tm_queries
  for update
  using (exists (select 1 from public.tm_clearances c
                  where c.id = tm_queries.clearance_id and public.can_write_matter(c.matterspace_id)))
  with check (exists (select 1 from public.tm_clearances c
                       where c.id = tm_queries.clearance_id and public.can_write_matter(c.matterspace_id)));

drop policy if exists "Matter writers remove unrun queries" on public.tm_queries;
create policy "Matter writers remove unrun queries" on public.tm_queries
  for delete using (exists (
    select 1 from public.tm_clearances c
     where c.id = tm_queries.clearance_id and public.can_write_matter(c.matterspace_id)));

revoke all on public.tm_queries from anon;
grant select, insert, update, delete on public.tm_queries to authenticated;
grant all on public.tm_queries to service_role;

-- ============================================================================
-- 4. tm_query_runs — one recorded run, append-only
-- ============================================================================
create table if not exists public.tm_query_runs (
  id                  uuid primary key default gen_random_uuid(),
  query_id            uuid not null references public.tm_queries(id) on delete cascade,
  run_at              timestamptz not null default now(),
  run_by              uuid default auth.uid(),
  source              text not null check (source in ('manual', 'export', 'failed')),
  reported_count      int check (reported_count is null or reported_count >= 0),
  captured_count      int not null default 0 check (captured_count >= 0),
  gap                 boolean not null default false,
  gap_note            text check (gap_note is null or char_length(gap_note) <= 2000),
  export_document_id  uuid references public.documents(id) on delete set null,
  -- the rows as parsed: [{serial, mark, owner, status, classes, goods, ...}], ≤ 500
  raw                 jsonb not null default '[]'::jsonb
                      check (jsonb_typeof(raw) = 'array' and jsonb_array_length(raw) <= 500)
);

create index if not exists tm_query_runs_query_idx on public.tm_query_runs (query_id, run_at desc);

comment on table public.tm_query_runs is
  'Trademark Clearance: one recorded run of one query. Append-only. captured_count and gap are computed by the database from the rows.';

create or replace function public._tm_query_runs_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_rows    int;
  v_serials int;
  v_blank   int;
begin
  new.run_by := coalesce(auth.uid(), new.run_by);
  new.run_at := now();

  v_rows := jsonb_array_length(new.raw);
  select count(distinct btrim(e->>'serial')), count(*) filter (where coalesce(btrim(e->>'serial'), '') = '')
    into v_serials, v_blank
    from jsonb_array_elements(new.raw) e;
  if v_blank > 0 then
    raise exception 'run: every captured row needs a serial number (% without one)', v_blank
      using errcode = '23514';
  end if;

  -- The database's count, not the browser's.
  new.captured_count := case when new.source = 'failed' then 0 else v_rows end;

  -- No silent gaps (spec §0.1, rule 3).
  new.gap := coalesce(new.gap, false)
          or new.source = 'failed'
          or new.reported_count is null
          or new.reported_count <> new.captured_count
          or v_serials < v_rows;
  return new;
end $$;

drop trigger if exists tm_query_runs_guard on public.tm_query_runs;
create trigger tm_query_runs_guard
  before insert on public.tm_query_runs
  for each row execute function public._tm_query_runs_guard();

drop trigger if exists tm_queries_guard on public.tm_queries;
create trigger tm_queries_guard
  before insert or update or delete on public.tm_queries
  for each row execute function public._tm_queries_guard();

alter table public.tm_query_runs enable row level security;

drop policy if exists "Matter members read runs" on public.tm_query_runs;
create policy "Matter members read runs" on public.tm_query_runs
  for select using (exists (
    select 1 from public.tm_queries q join public.tm_clearances c on c.id = q.clearance_id
     where q.id = tm_query_runs.query_id and public.can_access_matter(c.matterspace_id)));

drop policy if exists "Matter writers record runs" on public.tm_query_runs;
create policy "Matter writers record runs" on public.tm_query_runs
  for insert with check (
    run_by = auth.uid()
    and exists (
      select 1 from public.tm_queries q join public.tm_clearances c on c.id = q.clearance_id
       where q.id = tm_query_runs.query_id and public.can_write_matter(c.matterspace_id)));

-- No UPDATE or DELETE: a run is a record. A query may be re-run; the latest is current.
revoke all on public.tm_query_runs from anon;
revoke update, delete on public.tm_query_runs from authenticated;
grant select, insert on public.tm_query_runs to authenticated;
grant all on public.tm_query_runs to service_role;

-- ============================================================================
-- 5. tm_hits — the register records, proposals and decisions
-- ============================================================================
create table if not exists public.tm_hits (
  id                  uuid primary key default gen_random_uuid(),
  clearance_id        uuid not null references public.tm_clearances(id) on delete cascade,
  serial              text not null check (serial ~ '^[0-9]{6,9}$'),
  registration_number text check (registration_number is null or char_length(registration_number) <= 20),
  mark                text check (mark is null or char_length(mark) <= 500),
  owner               text check (owner is null or char_length(owner) <= 500),
  status_text         text check (status_text is null or char_length(status_text) <= 200),
  live                boolean,
  classes             text[] not null default '{}',
  goods_services      text check (goods_services is null or char_length(goods_services) <= 20000),
  filing_date         date,
  raw                 jsonb not null default '{}'::jsonb check (jsonb_typeof(raw) = 'object'),
  query_seqs          int[] not null default '{}',
  -- {bin, similarity:{score, reason}, relatedness:{score, reason}, model, at}
  proposed            jsonb check (proposed is null or jsonb_typeof(proposed) = 'object'),
  bin                 text check (bin is null or bin in ('flag', 'note', 'dismiss')),
  bin_reason          text check (bin_reason is null or char_length(bin_reason) <= 2000),
  decided_by          uuid,
  initials            text check (initials is null or char_length(initials) between 1 and 4),
  decided_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (clearance_id, serial)
);

create index if not exists tm_hits_clearance_bin_idx on public.tm_hits (clearance_id, bin);

comment on table public.tm_hits is
  'Trademark Clearance: one register record per clearance. A bin is the reviewer''s decision: initials required, decided_by and decided_at stamped by the database.';

create or replace function public._tm_hits_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_decision boolean;
begin
  new.serial := btrim(new.serial);

  if tg_op = 'INSERT' then
    new.created_at := now();
    v_decision := new.bin is not null;
  else
    if new.clearance_id is distinct from old.clearance_id or new.serial is distinct from old.serial then
      raise exception 'hit: a hit stays on its clearance and serial' using errcode = '42501';
    end if;
    new.created_at := old.created_at;
    -- Where a hit was found accumulates; a re-run never erases it.
    new.query_seqs := array(select distinct x from unnest(old.query_seqs || new.query_seqs) x order by x);
    v_decision := new.bin is distinct from old.bin
               or new.initials is distinct from old.initials
               or new.bin_reason is distinct from old.bin_reason;
  end if;

  if v_decision then
    if char_length(btrim(coalesce(new.initials, ''))) not between 1 and 4 then
      raise exception 'hit %: a decision needs your initials (1 to 4 characters)', new.serial
        using errcode = '23514';
    end if;
    new.initials := upper(btrim(new.initials));
    new.decided_by := auth.uid();
    new.decided_at := now();
  elsif tg_op = 'INSERT' then
    new.initials := null; new.decided_by := null; new.decided_at := null;
  else
    new.decided_by := old.decided_by;
    new.decided_at := old.decided_at;
  end if;

  if exists (select 1 from unnest(new.classes) c where c !~ '^[0-9A-Za-z]{1,3}$') then
    raise exception 'hit %: classes are class codes', new.serial using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end $$;

drop trigger if exists tm_hits_guard on public.tm_hits;
create trigger tm_hits_guard
  before insert or update on public.tm_hits
  for each row execute function public._tm_hits_guard();

alter table public.tm_hits enable row level security;

drop policy if exists "Matter members read hits" on public.tm_hits;
create policy "Matter members read hits" on public.tm_hits
  for select using (exists (
    select 1 from public.tm_clearances c
     where c.id = tm_hits.clearance_id and public.can_access_matter(c.matterspace_id)));

drop policy if exists "Matter writers add hits" on public.tm_hits;
create policy "Matter writers add hits" on public.tm_hits
  for insert with check (exists (
    select 1 from public.tm_clearances c
     where c.id = tm_hits.clearance_id and public.can_write_matter(c.matterspace_id)));

drop policy if exists "Matter writers decide hits" on public.tm_hits;
create policy "Matter writers decide hits" on public.tm_hits
  for update
  using (exists (select 1 from public.tm_clearances c
                  where c.id = tm_hits.clearance_id and public.can_write_matter(c.matterspace_id)))
  with check (exists (select 1 from public.tm_clearances c
                       where c.id = tm_hits.clearance_id and public.can_write_matter(c.matterspace_id)));

-- No DELETE: a hit seen is kept in the log (dead records included).
revoke all on public.tm_hits from anon;
revoke delete on public.tm_hits from authenticated;
grant select, insert, update on public.tm_hits to authenticated;
grant all on public.tm_hits to service_role;

-- ============================================================================
-- 6. The vocabulary — 120's guarded pattern, the UNION of every legal kind
-- ============================================================================
do $migration$
begin

if to_regclass('public.events') is null then
  raise notice '121: public.events is absent — migration 064 has not been applied; kinds skipped.';
  return;
end if;

execute $sql$
  alter table public.events drop constraint if exists events_kind_check
$sql$;
execute $sql$
  alter table public.events add constraint events_kind_check check (kind in (
    'tool.invoked',
    'completion.requested',
    'completion.received',
    'file.exported',
    'file.sent',
    'file.delivered',
    'file.gate',
    'citation.verified',
    'acl.changed',
    'seal.changed',
    'connector.registered',
    'connector.connected',
    'connector.revoked',
    'ai.paused',
    'ai.resumed',
    'run.aborted',
    -- 094: the security build
    'auth.factor_enrolled',
    'auth.factor_unenrolled',
    'auth.stepup',
    'auth.new_device',
    'account.locked',
    'account.unlocked',
    'matter.disconnected',
    'file.filed',
    'file.integrity',
    'file.opened',
    'file.flagged',
    'share.expired',
    'share.reviewed',
    'tripwire.tripped',
    'tripwire.cleared',
    -- 100: the Brief Desk
    'draft.snapshot',
    'cite.checked',
    'draft.exported',
    -- 120: the Model Comparator
    'comparison.created',
    'comparison.candidate',
    'comparison.graded',
    'comparison.assembled',
    'comparison.revealed',
    -- 121: Trademark Clearance
    'tm.clearance.created',
    'tm.intake.updated',
    'tm.classes.set',
    'tm.queries.generated',
    'tm.query.run',
    'tm.hit.proposed',
    'tm.hit.decided',
    'tm.stage.done',
    'tm.report.filed'
  ))
$sql$;

raise notice '121: events_kind_check widened by nine tm.* kinds.';

end $migration$;

notify pgrst, 'reload schema';
