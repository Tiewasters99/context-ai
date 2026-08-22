-- Contextspaces Migration 055: make document recovery terminate.
--
-- The bug (found by the 2026-08-22 ingestion audit)
-- ---------------------------------------------------------------------------
-- Migration 044 gave *jobs* a bounded retry budget: claim_discovery_job
-- increments processing_jobs.attempts, and a job that burns max_attempts is
-- parked in 'error' with its document marked failed. That budget works.
--
-- 044 also added recover_stranded_documents(), the safety net for a document
-- left mid-pipeline by a killed serverless function — a document with no job
-- row at all, which no amount of reaping can find. It found such documents and
-- INSERTED A FRESH JOB for each one.
--
-- Those two mechanisms cancel out. A poison document fails its job; the worker
-- marks the *job* 'error' and moves on, leaving the *document* wherever the
-- pipeline dropped it (typically 'embedding', processing_error null). Fifteen
-- minutes later recovery sees a non-terminal document with no open job and
-- mints a brand-new job at attempts = 0. max_attempts = 3 never fires, because
-- no single job ever reaches 3.
--
-- Measured on prod 2026-08-22: processing_jobs held 4,652 rows, 3,753 of them
-- 'error', and 3,282 of those failures were the SAME error on TWO documents —
-- 1,641 attempts each, one every ~15 minutes since 2026-08-02, still firing
-- while the audit ran. ~8 pointless worker cycles an hour for twenty days, and
-- both documents still read 'embedding' with processing_error = null, i.e.
-- invisible in the app.
--
-- The fix
-- ---------------------------------------------------------------------------
-- Recovery stops minting jobs.
--
--   * If the document already has an ingest job, recovery REQUEUES THAT ROW.
--     attempts carries over, so the budget 044 established is the budget that
--     is actually spent and claim_discovery_job's reaper can finally reach
--     max_attempts.
--   * If that job has burned its budget — or the document has accumulated more
--     than p_max_failures failed ingest jobs over its whole life, which is how
--     the existing loop victims present — the document lands in a TERMINAL,
--     VISIBLE state: processing_status = 'error' with a plain-English
--     processing_error, and its job parked in 'error' too.
--   * Only a document with no ingest job at all (the original 044 case: a
--     serverless function killed before it could enqueue) gets a new job.
--   * Reuse is gated on the JOB's own last activity, not the document's
--     created_at. 044 gated on created_at, which is always older than the idle
--     window, so every sweep fired unconditionally.
--
-- Nothing here changes claim_discovery_job, heartbeat_job, or the worker
-- contract: the worker calls recover_stranded_documents(15) on its idle path
-- exactly as before and still gets back "how many did you put back in the
-- queue". Documents failed out surface through the normal error path — the
-- Vault document list, scripts/ingest-monitor.mjs, check_ingest_status — which
-- is the point. A file that cannot be processed must say so once, loudly,
-- rather than retry silently forever.
--
-- Safe on a database that already has 044/045 and on one that does not: every
-- object is created if-not-exists or replaced. No data is rewritten by this
-- migration; the two loop victims are resolved by the first sweep after it.

-- ---------------------------------------------------------------------------
-- Columns 044 introduced, restated so this migration is self-sufficient.
-- ---------------------------------------------------------------------------
alter table public.processing_jobs
  add column if not exists heartbeat_at  timestamptz,
  add column if not exists attempts      int not null default 0,
  add column if not exists max_attempts  int not null default 3;

-- Recovery looks jobs up by the document id buried in the payload, several
-- times per stranded document per sweep. 4,652 rows seq-scan fine today; this
-- keeps it fine at a hundred times that.
create index if not exists processing_jobs_payload_document_idx
  on public.processing_jobs (((payload->>'document_id')), job_type, status);

-- ---------------------------------------------------------------------------
-- recover_stranded_documents(p_idle_minutes, p_max_failures)
--
-- Same name and same first parameter name as 044's version, so the worker's
-- existing named call (`{ p_idle_minutes: 15 }`) keeps binding. p_max_failures
-- is the lifetime ceiling on failed ingest jobs for one document: 5 is
-- comfortably above the 3-attempt job budget (a document can legitimately be
-- re-uploaded and re-queued) and far below the 1,641 the loop produced.
--
-- Returns the number of documents put back in the queue, exactly as before.
-- Documents failed out are NOT counted as recovered — they are terminal.
-- ---------------------------------------------------------------------------
create or replace function public.recover_stranded_documents(
  p_idle_minutes int default 15,
  p_max_failures int default 5
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requeued int := 0;
  v_idle     interval := make_interval(mins => greatest(coalesce(p_idle_minutes, 15), 1));
  v_cap      int := greatest(coalesce(p_max_failures, 5), 1);
  c          record;
begin
  -- 1. Uploads that never landed: nothing to process, say so plainly. A
  --    document whose upload died still reads 'pending' — there is no
  --    'uploading' state; the CHECK constraint on documents.processing_status
  --    permits only pending/extracting/chunking/embedding/ready/error. The null
  --    storage_path is what distinguishes "never arrived" from "waiting its
  --    turn". (Unchanged from 044.)
  update public.documents
     set processing_status = 'error',
         processing_error  = 'The upload did not finish, so there is no file to process. Please upload it again.'
   where processing_status = 'pending'
     and storage_path is null
     and created_at < now() - v_idle;

  -- 2. Walk the stranded documents one at a time. The set is small by
  --    construction — anything healthy is either 'ready' or has an open job —
  --    and a loop makes the three-way decision (fail / requeue / create)
  --    readable, which the previous single-statement version was not.
  for c in
    with stranded as (
      select d.id, d.matterspace_id
        from public.documents d
       where d.processing_status in ('pending', 'extracting', 'chunking', 'embedding')
         and d.storage_path is not null
         and d.created_at < now() - v_idle
         and not exists (
           select 1 from public.processing_jobs j
            where j.job_type = 'ingest_document'
              and j.status in ('queued', 'running')
              and (j.payload->>'document_id')::uuid = d.id
         )
    )
    select distinct on (s.id)
           s.id             as document_id,
           s.matterspace_id as matterspace_id,
           j.id             as job_id,
           coalesce(j.attempts, 0)     as attempts,
           coalesce(j.max_attempts, 3) as max_attempts,
           coalesce(j.finished_at, j.claimed_at, j.created_at) as job_last_at,
           (select count(*)
              from public.processing_jobs f
             where f.job_type = 'ingest_document'
               and f.status = 'error'
               and (f.payload->>'document_id')::uuid = s.id) as failure_count
      from stranded s
      left join public.processing_jobs j
        on j.job_type = 'ingest_document'
       and (j.payload->>'document_id')::uuid = s.id
     order by s.id, j.created_at desc nulls last
  loop
    if c.job_id is null then
      -- 2a. The original 044 case: no job row at all, so there is nothing to
      --     reuse. A fresh job here is correct — it is this document's first
      --     attempt, not its 1,642nd.
      insert into public.processing_jobs (matterspace_id, job_type, payload)
      values (c.matterspace_id, 'ingest_document',
              jsonb_build_object('document_id', c.document_id));
      update public.documents
         set processing_status = 'pending',
             processing_error  = null
       where id = c.document_id;
      v_requeued := v_requeued + 1;

    elsif c.attempts >= c.max_attempts or c.failure_count >= v_cap then
      -- 2b. Budget spent. Terminal and visible, both on the job and on the
      --     document. This is the state the twenty-day loop could never reach.
      update public.processing_jobs
         set status       = 'error',
             finished_at  = coalesce(finished_at, now()),
             claimed_by   = null,
             claimed_at   = null,
             heartbeat_at = null,
             error        = coalesce(nullif(error, ''),
                              'Gave up after ' || c.failure_count
                              || ' failed attempts on this file.')
       where id = c.job_id
         and status <> 'error';

      update public.documents
         set processing_status = 'error',
             processing_error  =
               'This file failed to process ' || c.failure_count
               || ' times and will not be retried automatically. It is stored and '
               || 'viewable, but its text is not searchable. Check that it opens '
               || 'outside Contextspaces, then upload it again — or delete it if it '
               || 'is not needed.'
       where id = c.document_id;

    elsif c.job_last_at < now() - v_idle then
      -- 2c. Budget left, and the idle window has genuinely elapsed since this
      --     job last did anything. Reuse the row so attempts carries over.
      update public.processing_jobs
         set status       = 'queued',
             claimed_by   = null,
             claimed_at   = null,
             heartbeat_at = null,
             finished_at  = null
       where id = c.job_id;
      update public.documents
         set processing_status = 'pending',
             processing_error  = null
       where id = c.document_id;
      v_requeued := v_requeued + 1;
    end if;
    -- else: a recent job, still inside the backoff window. Leave it alone.
  end loop;

  return v_requeued;
end $$;

revoke execute on function public.recover_stranded_documents(int, int) from public, anon, authenticated;
grant  execute on function public.recover_stranded_documents(int, int) to service_role;

-- Drop 044's single-argument version. Leaving it live would give PostgREST two
-- candidate overloads for the worker's one-argument call, and it would refuse
-- to choose (PGRST203). The two-argument version answers that call because
-- p_max_failures has a default.
drop function if exists public.recover_stranded_documents(int);
