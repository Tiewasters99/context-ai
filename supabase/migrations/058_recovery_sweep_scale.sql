-- Contextspaces Migration 058: make 055's recovery sweep survive its own
-- pathological case.
--
-- What happened (2026-08-24, minutes after 055 went live)
-- ---------------------------------------------------------------------------
-- The redeployed worker's first idle sweep logged:
--
--     recover_stranded_documents failed: canceling statement due to statement timeout
--
-- Measured state at that moment: exactly TWO stranded documents (the 20-day
-- loop victims 055 exists to retire) and 4,959 processing_jobs rows — 1,641
-- error jobs per victim.
--
-- Two defects in 055's stranded query compounded:
--
--   1. The `failure_count` correlated subquery sat in the SELECT list of a
--      query that LEFT JOINs every historical job for the document and then
--      takes DISTINCT ON. Correlated subqueries in a select list run per
--      JOINED row, before DISTINCT ON collapses them — so the count over
--      1,641 rows was computed 1,641 times per victim. O(matches²).
--
--   2. Every probe compared `(payload->>'document_id')::uuid = <uuid>`. The
--      index 055 itself created is on the TEXT expression
--      `(payload->>'document_id')` — a uuid-cast predicate cannot use it, so
--      each of those ~3,282 evaluations was a full scan of processing_jobs.
--
-- ~3,282 scans × ~5,000 jsonb rows ran straight through the 8-second
-- statement timeout. The documents 055 was written to retire are precisely
-- the documents with enough failed jobs to trigger this — the fix could never
-- have run against its own target. The verify harness missed it because it
-- seeded a handful of jobs per document; scripts/_verify-recovery-sweep.mjs
-- now seeds the real 1,641-per-victim shape and would have caught it.
--
-- The fix
-- ---------------------------------------------------------------------------
-- Same function, same signature, same three-way decision per document, same
-- return value. Only the shape of the lookup changes:
--
--   * Every payload probe compares TEXT: `payload->>'document_id' = d.id::text`
--     — the form 055's own index serves.
--   * The latest job comes from a LEFT JOIN LATERAL ... LIMIT 1: one probe
--     per document, replacing the join-everything-then-DISTINCT ON.
--   * failure_count is evaluated once per DOCUMENT, not once per joined row.
--
-- Cost per stranded document is now three index probes. Nothing else changes:
-- 044/045's claim, 057's priority, the worker contract, and the terminal
-- messages are untouched.

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
  -- 1. Uploads that never landed: nothing to process, say so plainly.
  --    (Unchanged from 055.)
  update public.documents
     set processing_status = 'error',
         processing_error  = 'The upload did not finish, so there is no file to process. Please upload it again.'
   where processing_status = 'pending'
     and storage_path is null
     and created_at < now() - v_idle;

  -- 2. Walk the stranded documents. The candidate set is small by
  --    construction — anything healthy is either 'ready' or has an open job —
  --    and each candidate now costs three index probes, not a quadratic
  --    blowup over its own failure history.
  for c in
    select d.id             as document_id,
           d.matterspace_id as matterspace_id,
           j.id             as job_id,
           coalesce(j.attempts, 0)     as attempts,
           coalesce(j.max_attempts, 3) as max_attempts,
           coalesce(j.finished_at, j.claimed_at, j.created_at) as job_last_at,
           -- Once per document. In 055 this expression ran once per joined
           -- job row, which for a document with 1,641 failures meant 1,641
           -- counts of 1,641 rows.
           (select count(*)
              from public.processing_jobs f
             where f.job_type = 'ingest_document'
               and f.status = 'error'
               and f.payload->>'document_id' = d.id::text) as failure_count
      from public.documents d
      left join lateral (
        select pj.id, pj.attempts, pj.max_attempts,
               pj.finished_at, pj.claimed_at, pj.created_at
          from public.processing_jobs pj
         where pj.job_type = 'ingest_document'
           and pj.payload->>'document_id' = d.id::text
         order by pj.created_at desc
         limit 1
      ) j on true
     where d.processing_status in ('pending', 'extracting', 'chunking', 'embedding')
       and d.storage_path is not null
       and d.created_at < now() - v_idle
       and not exists (
         select 1 from public.processing_jobs oj
          where oj.job_type = 'ingest_document'
            and oj.status in ('queued', 'running')
            and oj.payload->>'document_id' = d.id::text
       )
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
