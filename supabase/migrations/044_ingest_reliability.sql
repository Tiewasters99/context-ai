-- Ingestion reliability: heartbeats, bounded retries, automatic recovery.
--
-- On 2026-08-01 thirty-eight documents were stranded mid-pipeline. Two
-- independent failure modes, both silent, neither able to recover:
--
--   1. /api/ingest ran ingestion inline on Vercel, where maxDuration = 60
--      kills the function mid-embed. A killed function runs no catch block,
--      so the row froze at 'embedding' with no error written, and the severed
--      connection surfaced in the browser as "Failed to fetch".
--
--   2. The Fly worker was OOM-killed (SIGKILL) on large files. SIGKILL also
--      runs no catch block, and claim_discovery_job only ever looked at
--      status = 'queued' — so a claim held by a dead worker was never
--      reclaimed. The job sat at status = 'running' forever and the document
--      behind it was unreachable by any retry path in the app.
--
-- The through-line: the queue could not tell a working worker from a dead
-- one. This migration makes liveness explicit (heartbeat_at), makes failure
-- bounded (attempts/max_attempts), and makes both recoverable without a human.

alter table public.processing_jobs
  add column if not exists heartbeat_at  timestamptz,
  add column if not exists attempts      int not null default 0,
  add column if not exists max_attempts  int not null default 3;

-- Backfill so pre-existing rows are not instantly considered stale-and-dead.
update public.processing_jobs
   set heartbeat_at = coalesce(heartbeat_at, claimed_at)
 where status = 'running';

create index if not exists processing_jobs_status_heartbeat_idx
  on public.processing_jobs (status, heartbeat_at);

-- ---------------------------------------------------------------------------
-- Claim, with reaping.
--
-- Every claim first reaps jobs whose worker stopped heartbeating. A job that
-- still has attempts left goes back to 'queued'; one that has burned them all
-- goes to 'error' and its document is marked failed, so a poison file fails
-- loudly instead of cycling forever and blocking everything behind it.
--
-- 5 minutes is comfortably longer than the slowest step that does not
-- heartbeat, and short enough that a crash-looping machine recovers on its own
-- within one poll cycle of coming back.
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
       set status       = case when attempts >= max_attempts then 'error' else 'queued' end,
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

-- ---------------------------------------------------------------------------
-- Heartbeat. The worker calls this on a timer while a job runs, so that a long
-- OCR or transcription pass is not mistaken for a dead process.
-- ---------------------------------------------------------------------------
create or replace function public.heartbeat_job(p_job uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.processing_jobs
     set heartbeat_at = now()
   where id = p_job and status = 'running';
$$;

revoke execute on function public.heartbeat_job(uuid) from public, anon, authenticated;
grant  execute on function public.heartbeat_job(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Recover documents the queue lost track of entirely.
--
-- This is the safety net for failure mode 1: a document left mid-pipeline by a
-- killed serverless function has no job row at all, so no amount of reaping
-- finds it. Anything sitting in a non-terminal state with no open job and no
-- recent progress gets a fresh job. Returns the number requeued.
--
-- Documents whose upload never completed (no storage_path) cannot be recovered
-- by requeueing — they are marked failed with an instruction instead.
-- ---------------------------------------------------------------------------
create or replace function public.recover_stranded_documents(p_idle_minutes int default 15)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
begin
  -- Uploads that never landed: nothing to process, say so plainly. A document
  -- whose upload died still reads 'pending' — there is no 'uploading' state to
  -- check for, the CHECK constraint on documents.processing_status permits only
  -- pending/extracting/chunking/embedding/ready/error. The null storage_path is
  -- what distinguishes "never arrived" from "waiting its turn".
  update public.documents
     set processing_status = 'error',
         processing_error  = 'The upload did not finish, so there is no file to process. Please upload it again.'
   where processing_status = 'pending'
     and storage_path is null
     and created_at < now() - make_interval(mins => p_idle_minutes);

  with stranded as (
    select d.id, d.matterspace_id
      from public.documents d
     where d.processing_status in ('pending', 'extracting', 'chunking', 'embedding')
       and d.storage_path is not null
       and d.created_at < now() - make_interval(mins => p_idle_minutes)
       and not exists (
         select 1 from public.processing_jobs j
          where j.job_type = 'ingest_document'
            and j.status in ('queued', 'running')
            and (j.payload->>'document_id')::uuid = d.id
       )
  ), queued as (
    insert into public.processing_jobs (matterspace_id, job_type, payload)
    select s.matterspace_id, 'ingest_document', jsonb_build_object('document_id', s.id)
      from stranded s
    returning (payload->>'document_id')::uuid as doc_id
  )
  update public.documents d
     set processing_status = 'pending',
         processing_error  = null
    from queued q
   where d.id = q.doc_id;

  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke execute on function public.recover_stranded_documents(int) from public, anon, authenticated;
grant  execute on function public.recover_stranded_documents(int) to service_role;
