-- Contextspaces Migration 057: job priority, so one tenant's production cannot
-- starve another tenant's upload.
--
-- The problem
-- ---------------------------------------------------------------------------
-- claim_discovery_job hands out work strictly oldest-first:
--
--     where status = 'queued' order by created_at limit 1 for update skip locked
--
-- and the worker runs one job at a time. So the moment anyone enqueues a large
-- batch — a Bates production of thousands of TIFFs, a bulk import, a recovery
-- sweep — every other upload in every other matter queues behind it for as
-- long as it takes. On 2026-08-23 the 2,883-document TIFF backfill had to
-- bypass the queue entirely and run locally with its own lanes, because through
-- the one-lane worker it would have held every matter's uploads for the better
-- part of a day. A repair script routing around the queue is the clearest
-- possible statement that the queue is not yet an ingestion pathway for more
-- than one user.
--
-- Scaling the worker out (fly scale count N) makes a backlog drain faster. It
-- does not change who goes next: N lanes of the same FIFO are N lanes of the
-- same production.
--
-- The fix: priority, with bursts demoting themselves
-- ---------------------------------------------------------------------------
--   * processing_jobs.priority, smallint, default 0. Higher claims sooner;
--     among equals, oldest first exactly as before. The claim query becomes
--     `order by priority desc, created_at`.
--
--   * Bulk enqueuers say so. scripts/bulk-import.mjs and ingest-monitor --fix
--     enqueue at JOB_PRIORITY.BULK (-10).
--
--   * Bursts demote themselves. The web Vault and MCP file one document at a
--     time and cannot know they are part of a mass upload — but the queue can.
--     The BEFORE INSERT trigger below counts queued jobs in the same matter;
--     once there are v_burst (10) of them, a job enqueued at normal priority
--     is written as bulk. So a lawyer's single deposition video never waits
--     behind a stranger's production, while a production's own first ten files
--     still start immediately. Nothing in the app changes for this: the
--     interactive paths do not mention priority at all — which is also what
--     makes this migration safe to apply before OR after the code deploys.
--
--   * serverspace_id is denormalised onto the job by the same trigger. The
--     priority rule does not need it. The next rule will — fair sharing between
--     two tenants who are both bulk-uploading — and it is the column the
--     monitor needs to answer "which tenant is the queue full of".
--
--   * Only the service role may RAISE priority. An authenticated caller asking
--     for more than 0 gets 0. Without that clamp one tenant could put +100 on
--     every job and starve everyone else, which is the very hole this closes.
--     Migration 032 grants authenticated no UPDATE on processing_jobs, so the
--     insert is the only door.
--
-- What this does NOT do, stated plainly
-- ---------------------------------------------------------------------------
-- Strict priority: bulk work never runs while any normal job is queued. That is
-- the intent, and it has a corollary — two tenants bulk-uploading at once are
-- FIFO between themselves, so the first still starves the second until fair
-- sharing lands. And the burst rule is per matter: a client's own interactive
-- upload INTO the matter their production is landing in is demoted with it.
-- Both are bounded and visible in the priority column, not silent.
--
-- claim_discovery_job is restated in full from 045 (044's body plus the enum
-- cast hotfix, which is what production runs); only the ORDER BY changes.
-- Migration 055 replaces recover_stranded_documents and does not touch this
-- function, so 055 and 057 apply in either order.
--
-- Verified by scripts/_verify-job-priority.mjs, which executes THIS FILE
-- against a real Postgres (PGlite, no Docker needed) and checks the claim
-- order, the burst demotion, the clamp and the index.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table public.processing_jobs
  add column if not exists priority       smallint not null default 0,
  add column if not exists serverspace_id uuid references public.serverspaces(id) on delete cascade;

update public.processing_jobs j
   set serverspace_id = m.serverspace_id
  from public.matterspaces m
 where m.id = j.matterspace_id
   and j.serverspace_id is null;

-- The claim query's index: the queued set only, already in claim order. The
-- queued set is small by construction, so this is cheap to maintain and makes
-- the claim a single index probe regardless of how many finished jobs the
-- table has accumulated.
create index if not exists processing_jobs_queued_priority_idx
  on public.processing_jobs (priority desc, created_at)
  where status = 'queued';

-- The burst rule's index: queued jobs per matter.
create index if not exists processing_jobs_queued_matter_idx
  on public.processing_jobs (matterspace_id)
  where status = 'queued';

-- ---------------------------------------------------------------------------
-- Insert trigger: tenant stamp, priority clamp, burst demotion.
--
-- SECURITY INVOKER on purpose. current_user has to be the CALLER's role for the
-- clamp to mean anything; inside a SECURITY DEFINER function it would be the
-- owner's, and every caller would look like the service role. Running as the
-- caller also means RLS on matterspaces applies to the tenant lookup — which
-- is fine, because the insert policy (032) already required the caller to
-- have access to the matter they are enqueueing into.
-- ---------------------------------------------------------------------------
create or replace function public._processing_jobs_before_insert()
returns trigger
language plpgsql
as $$
declare
  -- Queued jobs in one matter beyond which a normal-priority enqueue is
  -- treated as bulk. Ten is well above what a person uploads by hand in one
  -- go (only heavy files reach the queue at all — big scans, media, TIFF) and
  -- well below the first minute of a production.
  v_burst  constant int := 10;
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
-- Claim. Restated from 045 — 044's function with its enum-cast hotfix, which
-- is the version production runs — with exactly one change: the ORDER BY.
-- The reaping preamble, the attempt accounting and the SKIP LOCKED claim are
-- untouched; they are what has been running in production since 045, and
-- what makes running more than one worker safe.
--
-- Restating from 044 instead would silently reintroduce the outage 045 fixed:
-- an uncast CASE assigned to the enum column raises 42804 and takes the claim
-- down with it. scripts/_verify-job-priority.mjs runs 044, 045 and this file
-- in order, and caught exactly that when this migration was first drafted.
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

  -- Then take the highest-priority queued job; oldest first among equals.
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
      order by priority desc, created_at
      limit 1
      for update skip locked
   )
  returning *;
end $$;

revoke execute on function public.claim_discovery_job(text) from public, anon, authenticated;
grant  execute on function public.claim_discovery_job(text) to service_role;
