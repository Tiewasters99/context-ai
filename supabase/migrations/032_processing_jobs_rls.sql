-- 032: RLS for processing_jobs.
--
-- The queue table shipped in 030 without RLS, which left it readable and
-- writable by any authenticated user across matters — a violation of the
-- per-matter isolation contract. Now that /api/ingest enqueues
-- ingest_document jobs with the *user's* JWT, lock the table down properly:
--
--   * select/insert: only within matters the user can access, via the
--     SECURITY INVOKER wrapper _disc_matter_access (migration-030/022
--     pattern — never call SECURITY DEFINER fns directly from policies).
--   * update/delete: service role only (the worker claims and finishes jobs
--     with the service key, which bypasses RLS entirely).

alter table public.processing_jobs enable row level security;

drop policy if exists processing_jobs_select on public.processing_jobs;
create policy processing_jobs_select on public.processing_jobs
  for select to authenticated
  using (public._disc_matter_access(matterspace_id));

drop policy if exists processing_jobs_insert on public.processing_jobs;
create policy processing_jobs_insert on public.processing_jobs
  for insert to authenticated
  with check (public._disc_matter_access(matterspace_id));

-- No update/delete policies for authenticated: those operations are the
-- worker's alone (service role bypasses RLS). Users cancel/retry through
-- application endpoints, not raw table writes.
