-- 123_trademark_register_copy.sql — Trademark Clearance: runs recorded from
-- Equazia's own copy of the USPTO register.
--
-- Why a migration (the brief allowed one only if unavoidable): 121 fixed the
-- run log's source to ('manual', 'export', 'failed'), so a run from the
-- register copy cannot be recorded with its own source without widening that
-- check. Everything else is extended, not replaced:
--
--   1. tm_query_runs.source also accepts 'register_copy'.
--   2. Two columns on tm_query_runs: register_as_of (the copy's as-of date at
--      the time of the run) and register_preliminary (true while the copy's
--      recall gate has not passed: "preliminary: confirm on tmsearch"). A
--      register_copy run must carry both; any other run carries neither.
--   3. Stage 4 cannot be signed done while any query's CURRENT run (the
--      latest) is a preliminary register-copy run: until the gate passes, the
--      copy's results cannot by themselves complete stage 4. Re-running those
--      queries on tmsearch (a manual or export run) lifts it. A new trigger
--      (tm_stages_guard_123), firing after 121's and 122's in name order; no
--      existing function is redefined.
--
-- The run log stays append-only (121's guard: captured_count and gap are the
-- database's own; raw ≤ 500 rows, so a capped register run records a gap
-- exactly as a capped tmsearch export does). The Record is unchanged:
-- tm.query.run already carries {source}; the connector adds register_as_of
-- and preliminary to its payload (metadata only). No new event kind.
--
-- Additive and re-runnable; every function SECURITY INVOKER (house rule).
-- Needs 121 (and runs after 122). Executed twice in PGlite by
-- scripts/_verify-trademark-123.mjs.
--
-- ⚠ NOT APPLIED until Eden approves this file by name.
-- ⚠ After pasting, run:  notify pgrst, 'reload schema';  (last statement here.)

do $pre$
begin
  if to_regclass('public.tm_query_runs') is null then
    raise exception '123 needs migration 121 (public.tm_query_runs is absent)';
  end if;
end $pre$;

-- 1. The source.
alter table public.tm_query_runs drop constraint if exists tm_query_runs_source_check;
alter table public.tm_query_runs add constraint tm_query_runs_source_check
  check (source in ('manual', 'export', 'failed', 'register_copy'));

-- 2. The copy's as-of date and the preliminary flag.
alter table public.tm_query_runs add column if not exists register_as_of date;
alter table public.tm_query_runs add column if not exists register_preliminary boolean;

alter table public.tm_query_runs drop constraint if exists tm_query_runs_register_fields_check;
alter table public.tm_query_runs add constraint tm_query_runs_register_fields_check check (
  (source = 'register_copy' and register_as_of is not null and register_preliminary is not null)
  or (source <> 'register_copy' and register_as_of is null and register_preliminary is null)
);

comment on column public.tm_query_runs.register_as_of is
  'Trademark Clearance: for a register_copy run, the as-of date of Equazia''s copy of the USPTO register when the run was made.';
comment on column public.tm_query_runs.register_preliminary is
  'Trademark Clearance: for a register_copy run, true while the copy''s recall gate had not passed (preliminary: confirm on tmsearch).';

-- 3. Stage 4 and preliminary runs.
create or replace function public._tm_stages_guard_123()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_seqs text;
begin
  if tg_op <> 'UPDATE' or new.stage <> 4 then return new; end if;
  if new.status = 'done' and new.status is distinct from old.status then
    select string_agg('Q' || q.seq, ', ' order by q.seq) into v_seqs
      from public.tm_queries q
      join lateral (
        select r.source, r.register_preliminary
          from public.tm_query_runs r
         where r.query_id = q.id
         order by r.run_at desc, r.id desc
         limit 1
      ) cur on true
     where q.clearance_id = new.clearance_id
       and cur.source = 'register_copy' and cur.register_preliminary;
    if v_seqs is not null then
      raise exception 'stage 4: % ran only on Equazia''s copy of the register, whose results are preliminary until its recall test passes; confirm them on tmsearch first', v_seqs
        using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists tm_stages_guard_123 on public.tm_stages;
create trigger tm_stages_guard_123
  before update on public.tm_stages
  for each row execute function public._tm_stages_guard_123();

notify pgrst, 'reload schema';
