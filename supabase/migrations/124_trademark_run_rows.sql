-- 124_trademark_run_rows.sql — Trademark Clearance: a run holds a whole export.
--
-- WHY
-- 121 capped tm_query_runs.raw at 500 rows, and the browser and the connector
-- cut every import to match. A tmsearch export is larger than that for any
-- broad query: on QUALLET, Q5's export held 1,485 records and Q7's 638, and
-- each was stored as 500. The gap note said "reported 10391; 500 captured",
-- which reads as tmsearch's limit when it was ours. The cap moves to 10,000,
-- with lib/trademark/triage.mjs MAX_RUN_ROWS to match. Rows past it are still
-- named in the run's gap note, never dropped silently.
--
-- WHAT
-- Replaces the check on tm_query_runs.raw (array, ≤ 500 → array, ≤ 10,000).
-- No row changes; existing runs already satisfy the new check. Re-runnable.

do $$
begin
  if to_regclass('public.tm_query_runs') is null then
    raise exception 'needs migration 121 (Trademark Clearance) first';
  end if;
end $$;

alter table public.tm_query_runs drop constraint if exists tm_query_runs_raw_check;
alter table public.tm_query_runs
  add constraint tm_query_runs_raw_check
  check (jsonb_typeof(raw) = 'array' and jsonb_array_length(raw) <= 10000);

comment on column public.tm_query_runs.raw is
  'The rows as parsed: [{serial, mark, owner, status, classes, goods, ...}], at most 10,000 (migration 124).';

notify pgrst, 'reload schema';
