-- Hotfix for 044: the reaper could not assign a status, so nothing could be
-- claimed and the whole queue stopped.
--
-- In 044 the reaping UPDATE wrote
--
--   set status = case when attempts >= max_attempts then 'error' else 'queued' end
--
-- Assigning a bare literal to an enum column works, because Postgres resolves
-- the unknown literal against the target column. A CASE does not get that
-- benefit: its result type is settled from the branch expressions alone, which
-- makes it text, and text does not implicitly cast to discovery_job_status. So
-- every call to claim_discovery_job raised
--
--   column "status" is of type discovery_job_status but expression is of type text
--
-- and since reaping happens before the claim, the failure took the claim with
-- it. The worker logged the error every poll and no job of any type — ingest,
-- intake, stamping, packaging — could start.
--
-- Same function as 044 with the cast made explicit. Nothing else changes.

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
       set status       = (case when attempts >= max_attempts then 'error' else 'queued' end)::discovery_job_status,
           error        = case when attempts >= max_attempts
                               then 'The worker stopped responding ' || attempts ||
                                    ' times while processing this file. It may be too large '
                                    || 'to process in one piece.'
                               else error end,
           finished_at  = case when attempts >= max_attempts then now() else finished_at end,
           claimed_by   = null,
           claimed_at   = null,
           heartbeat_at = null
     where status = 'running'
       and coalesce(heartbeat_at, claimed_at) < now() - v_stale
    returning id, job_type, status, payload
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

  -- Then take the oldest queued job.
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
      order by created_at
      limit 1
      for update skip locked
   )
  returning *;
end $$;

revoke execute on function public.claim_discovery_job(text) from public, anon, authenticated;
grant  execute on function public.claim_discovery_job(text) to service_role;

-- No repair pass is needed for the outage itself. The reaping UPDATE runs
-- before the claim in the same function, so when it raised, the whole call
-- aborted: nothing was claimed, no attempt was charged, and no row changed
-- state. The queue simply stood still. Once this lands, the first successful
-- claim reaps the genuinely dead pre-restart jobs and requeues them with their
-- attempt budget intact.
