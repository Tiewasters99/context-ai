-- Contextspaces Migration 079: a Bucketizer run is a ROW, not a tab.
--
-- THE PROBLEM
-- ---------------------------------------------------------------------------
-- Bulk classification is a browser loop. PR #168 made it whole-document and
-- resumable — every finished window is written down, and nothing finished is
-- paid for twice — but it only ADVANCES while the tab is open. The 2026-09-19
-- ship-readiness audit states the Definition of Done for this module as "500
-- documents classify server-side, resumable, tab closed", and the real Fleming
-- run was done with a local CLI holding a service-role key open on Eden's
-- laptop precisely because the product could not do it.
--
-- A lawyer should be able to choose four hundred documents, see the price,
-- press the button, and shut the laptop.
--
-- WHAT THIS ADDS, AND WHY EACH TABLE EXISTS
-- ---------------------------------------------------------------------------
--   bucketizer_runs          The run itself: which matter, which act, WHO
--                            asked (their wallet is charged and their name is
--                            on the Record), the documents they confirmed, the
--                            estimate they were shown and accepted, the status,
--                            the counters the progress line reads, and the
--                            sentence to show when it stopped. Reload the page,
--                            open a different machine, come back tomorrow: the
--                            progress line reads this row.
--
--   bucketizer_run_documents One row per document IN this run. It is what
--                            makes the closing report ("done / skipped with
--                            reasons / failed") a fact rather than a memory of
--                            the tab that ran it, and what a Resume enqueues
--                            from.
--
--   bucketizer_run_windows   One row per finished WINDOW. This is the thing
--                            that makes a crashed worker resume at the next
--                            UNDONE window and never re-charge a finished one.
--
-- WHY WINDOWS ARE KEYED ON (document, plan_hash, window_index) AND NOT ON THE
-- RUN
-- ---------------------------------------------------------------------------
-- A window is a fact about a DOCUMENT's text, not about the run that happened
-- to pay for it. `plan_hash` is lib/bucketizer-windows.mjs's plan identity over
-- that text, so:
--
--   * a second run over the same document resumes the first run's finished
--     windows instead of buying them again — which is the difference between a
--     cancelled-then-resumed 500-document run costing $8 and costing $16;
--   * re-ingesting a document changes its passages, which changes the hash, so
--     the old windows simply stop matching. They are not resumed and they are
--     not silently mixed into a new plan, because window 3 of the old plan is
--     not window 3 of the new one.
--
-- The `run_id` is kept as a reference (who paid for it) and is nulled rather
-- than cascaded when a run is deleted: the window is still a true statement
-- about the document.
--
-- WHAT IS DELIBERATELY NOT HERE
-- ---------------------------------------------------------------------------
-- No new job type column, no change to processing_jobs, and no change to
-- claim_discovery_job or to the priority rules in 057/071. The runner enqueues
-- ordinary `processing_jobs` rows — one per document, at BULK priority (-10) —
-- so a 500-document run queues behind every interactive upload exactly as a
-- bulk import does. That is the whole fairness story, and it is already built.
--
-- One corollary, stated rather than discovered: 057's burst rule counts QUEUED
-- jobs per matter, so a 500-document run also demotes that matter's own next
-- uploads to bulk while it drains. It is bounded, visible in the priority
-- column, and per matter — not cross-tenant.
--
-- RLS
-- ---------------------------------------------------------------------------
-- SELECT only, for `authenticated`, through migration 036's own SECURITY
-- INVOKER wrapper `public._bktz_matter_access(uuid)` — the same helper every
-- other Bucketizer table uses, and no policy here calls a SECURITY DEFINER
-- helper directly (feedback: rls-security-invoker-wrappers).
--
-- There is NO insert, update or delete policy, on purpose. A run is created by
-- /api/bucketizer-run.mjs and advanced by the worker, both with the service
-- role, and both after checking the caller's own access. A client that could
-- write these rows could say a run had finished, or re-point it at another
-- matter's documents.
--
-- Idempotent against drift. The live database is not the migrations folder
-- (project-dev-environment-cautions), so every object is created with
-- `if not exists` / `create or replace`, every column is added separately, the
-- check constraints are dropped and re-added, and every policy is dropped
-- first. Re-pasting this file is a no-op.
--
-- Apply order: after 036 (the Bucketizer tables and _bktz_matter_access) and
-- after 057/071 (priority). Verified by scripts/_verify-bucketizer-server-run.mjs,
-- which executes THIS FILE against a real Postgres (PGlite, no Docker needed).

-- ============================================================================
-- 1. The run
-- ============================================================================

create table if not exists public.bucketizer_runs (
  id uuid primary key default gen_random_uuid(),
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade
);

-- Columns one at a time, so a database that already has an earlier shape of
-- this table converges on the current one instead of keeping it.
alter table public.bucketizer_runs
  add column if not exists kind text not null default 'classify';
alter table public.bucketizer_runs
  add column if not exists requested_by uuid references public.profiles(id);
alter table public.bucketizer_runs
  add column if not exists model_id text;
-- The documents the person confirmed, in the order they were chosen. The
-- per-document rows below are the working set; this is the record of what was
-- asked for, which survives a document being deleted afterwards.
alter table public.bucketizer_runs
  add column if not exists document_ids uuid[] not null default '{}';
-- The estimate the person was shown and clicked through, in cents. Nobody
-- discovers the price afterwards (feedback: agent-economics-deterministic-first).
alter table public.bucketizer_runs
  add column if not exists estimate_cents integer not null default 0;
alter table public.bucketizer_runs
  add column if not exists status text not null default 'queued';
-- The sentence to show a person. The server's own words on a 402/429, the
-- gate's own words on a paused matter, the product's own words on a sealed
-- matter with no pen — never a code, and never this file's paraphrase of one.
alter table public.bucketizer_runs
  add column if not exists pause_reason text;
alter table public.bucketizer_runs
  add column if not exists retry_after_seconds integer;
alter table public.bucketizer_runs
  add column if not exists last_error text;
alter table public.bucketizer_runs
  add column if not exists documents_total integer not null default 0;
alter table public.bucketizer_runs
  add column if not exists documents_done integer not null default 0;
alter table public.bucketizer_runs
  add column if not exists documents_skipped integer not null default 0;
alter table public.bucketizer_runs
  add column if not exists documents_failed integer not null default 0;
-- Windows actually sent to a model on this run — what was paid for — and
-- windows skipped because a previous run had already finished them. The two
-- kept apart is how a resumed run can be shown to have cost nothing extra.
alter table public.bucketizer_runs
  add column if not exists windows_called integer not null default 0;
alter table public.bucketizer_runs
  add column if not exists windows_resumed integer not null default 0;
alter table public.bucketizer_runs
  add column if not exists proposed integer not null default 0;
alter table public.bucketizer_runs
  add column if not exists created_at timestamptz not null default now();
alter table public.bucketizer_runs
  add column if not exists started_at timestamptz;
alter table public.bucketizer_runs
  add column if not exists finished_at timestamptz;
alter table public.bucketizer_runs
  add column if not exists updated_at timestamptz not null default now();

-- The vocabulary, dropped and re-added so a database carrying an older,
-- narrower version of either check converges on this one.
alter table public.bucketizer_runs drop constraint if exists bucketizer_runs_kind_check;
alter table public.bucketizer_runs add constraint bucketizer_runs_kind_check
  check (kind in ('classify', 'evidence'));

-- queued    enqueued, not yet claimed
-- running   at least one document is with a worker
-- paused    the wallet, the rate window, or the matter's AI pause. Resumable.
-- held      the matter is sealed and the sealed pen is not provisioned. NOT an
--           error and NOT a fallback: nothing was sent (lib/seal-pipes.mjs).
-- done | cancelled | failed   terminal.
alter table public.bucketizer_runs drop constraint if exists bucketizer_runs_status_check;
alter table public.bucketizer_runs add constraint bucketizer_runs_status_check
  check (status in ('queued', 'running', 'paused', 'held', 'done', 'cancelled', 'failed'));

-- ONE active run per matter per act. This is the per-user/per-run concurrency
-- bound: without it a person could start the same 500 documents four times and
-- pay four times, and two runs writing the same document's windows would race.
-- A terminal run does not count, so starting again after Cancel is immediate.
create unique index if not exists bucketizer_runs_one_active_idx
  on public.bucketizer_runs (matterspace_id, kind)
  where status in ('queued', 'running', 'paused', 'held');

-- "What is the current run on this matter" — the read the progress line makes
-- after a reload, when all it knows is the matter.
create index if not exists bucketizer_runs_matter_idx
  on public.bucketizer_runs (matterspace_id, created_at desc);

-- ============================================================================
-- 2. One row per document in the run
-- ============================================================================

create table if not exists public.bucketizer_run_documents (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.bucketizer_runs(id) on delete cascade,
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  -- The title as it was when the run was started. The closing report names
  -- documents that may since have been renamed, moved or deleted, and a report
  -- that says "a document" is not a report.
  title text,
  status text not null default 'queued',
  -- Plain language, for a person: why this document was skipped, or what could
  -- not be read. Never a stack trace and never a provider's error body.
  note text,
  windows_total integer not null default 0,
  windows_called integer not null default 0,
  windows_resumed integer not null default 0,
  windows_failed integer not null default 0,
  proposed integer not null default 0,
  attempts integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  -- A document appears once in a run. The job that carries it is enqueued once
  -- per row, and a re-enqueue on Resume finds the same row.
  unique (run_id, document_id)
);

alter table public.bucketizer_run_documents
  drop constraint if exists bucketizer_run_documents_status_check;
alter table public.bucketizer_run_documents
  add constraint bucketizer_run_documents_status_check
  check (status in ('queued', 'running', 'done', 'skipped', 'failed', 'held', 'cancelled'));

-- The report's read, and the "what is left" read a Resume makes.
create index if not exists bucketizer_run_documents_run_idx
  on public.bucketizer_run_documents (run_id, status);

-- ============================================================================
-- 3. One row per finished window — the thing that survives the crash
-- ============================================================================

create table if not exists public.bucketizer_run_windows (
  id uuid primary key default gen_random_uuid(),
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  -- lib/bucketizer-windows.mjs's plan identity over this document's TEXT.
  -- Re-ingest the document and the hash changes, so these rows stop matching
  -- and are neither resumed nor mixed into the new plan.
  plan_hash text not null,
  window_index integer not null,
  -- Which run paid for it. Nulled rather than cascaded when the run row goes:
  -- the window is still a true statement about the document.
  run_id uuid references public.bucketizer_runs(id) on delete set null,
  done_at timestamptz not null default now(),
  first_page integer,
  last_page integer,
  -- The window's own answers, already resolved to node ids and passage ids:
  -- [{ n: <node uuid>, c: <0..1>, r: <rationale>, p: [<passage uuid>] }].
  -- Never the document's text, and never the model's raw reply.
  assignments jsonb not null default '[]',
  -- Set when the model's answer failed the contract twice, or when the request
  -- was permanently too large. A plain sentence a person can read.
  failed text,
  model_id text,
  -- The identity of a window, and the reason nothing is ever paid for twice.
  unique (document_id, plan_hash, window_index)
);

create index if not exists bucketizer_run_windows_run_idx
  on public.bucketizer_run_windows (run_id);

-- ============================================================================
-- 4. Finishing a document, atomically
-- ============================================================================
-- Two Fly machines finishing the last two documents of a run in the same
-- second must not both read "one still running" and leave the run stuck at
-- 'running' forever. So the document's row, the run's counters and the run's
-- terminal state are one statement chain in one transaction, and the counters
-- are RECOMPUTED from the per-document rows rather than incremented — an
-- increment is what makes a retried job count its document twice.
--
-- SECURITY DEFINER, service_role only, exactly like claim_discovery_job: it
-- writes rows no authenticated caller may write.
create or replace function public.bucketizer_run_finish_document(
  p_run uuid,
  p_document uuid,
  p_status text,
  p_note text default null,
  p_windows_total integer default 0,
  p_windows_called integer default 0,
  p_windows_resumed integer default 0,
  p_windows_failed integer default 0,
  p_proposed integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_left  int;
  v_run   public.bucketizer_runs%rowtype;
begin
  -- One writer at a time per run, so the recount below cannot interleave.
  perform pg_advisory_xact_lock(hashtext(p_run::text));

  update public.bucketizer_run_documents
     set status          = p_status,
         note            = p_note,
         windows_total   = greatest(coalesce(p_windows_total, 0), 0),
         windows_called  = greatest(coalesce(p_windows_called, 0), 0),
         windows_resumed = greatest(coalesce(p_windows_resumed, 0), 0),
         windows_failed  = greatest(coalesce(p_windows_failed, 0), 0),
         proposed        = greatest(coalesce(p_proposed, 0), 0),
         finished_at     = now()
   where run_id = p_run
     and document_id = p_document;

  update public.bucketizer_runs r
     set documents_done    = c.done,
         documents_skipped = c.skipped,
         documents_failed  = c.failed,
         windows_called    = c.called,
         windows_resumed   = c.resumed,
         proposed          = c.proposed,
         updated_at        = now()
    from (
      select
        count(*) filter (where status = 'done')    as done,
        count(*) filter (where status = 'skipped') as skipped,
        count(*) filter (where status in ('failed', 'held')) as failed,
        coalesce(sum(windows_called), 0)  as called,
        coalesce(sum(windows_resumed), 0) as resumed,
        coalesce(sum(proposed), 0)        as proposed
      from public.bucketizer_run_documents
      where run_id = p_run
    ) c
   where r.id = p_run;

  select count(*) into v_left
    from public.bucketizer_run_documents
   where run_id = p_run
     and status in ('queued', 'running');

  -- The run finishes only from a state that was still going. A run paused by
  -- the meter, held by the seal or cancelled by the person keeps that status
  -- even when its last in-flight document lands.
  if v_left = 0 then
    update public.bucketizer_runs
       set status      = 'done',
           finished_at = now(),
           updated_at  = now()
     where id = p_run
       and status in ('queued', 'running');
  end if;

  select * into v_run from public.bucketizer_runs where id = p_run;
  return jsonb_build_object(
    'remaining', v_left,
    'status', v_run.status,
    'documents_done', v_run.documents_done,
    'documents_failed', v_run.documents_failed,
    'documents_skipped', v_run.documents_skipped);
end $$;

revoke execute on function public.bucketizer_run_finish_document(uuid, uuid, text, text, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.bucketizer_run_finish_document(uuid, uuid, text, text, integer, integer, integer, integer, integer)
  to service_role;

-- ============================================================================
-- 5. Stopping a run — pause, hold, cancel, fail
-- ============================================================================
-- One function for all four, because they do the same three things and doing
-- them separately is how one of them ends up forgetting the third:
--
--   1. the run takes its new status and the SENTENCE to show a person;
--   2. every document still queued or running goes back to 'queued' (on a
--      cancel, to 'cancelled'), so a Resume knows exactly what is left;
--   3. the run's own remaining QUEUED jobs are deleted from processing_jobs.
--
-- Step 3 is the one that matters for the shared worker. A paused run that left
-- four hundred queued jobs behind would have the worker claim each of them,
-- find the run paused, and mark it done — four hundred claims of work that is
-- not going to happen, in front of everybody else's uploads. A RUNNING job is
-- left alone: it is with a worker that will settle it.
create or replace function public.bucketizer_run_halt(
  p_run uuid,
  p_status text,
  p_reason text default null,
  p_retry_after integer default null,
  p_error text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jobs int;
  v_docs int;
begin
  perform pg_advisory_xact_lock(hashtext(p_run::text));

  update public.bucketizer_runs
     set status              = p_status,
         pause_reason        = p_reason,
         retry_after_seconds = p_retry_after,
         last_error          = coalesce(p_error, last_error),
         finished_at         = case when p_status in ('done', 'cancelled', 'failed')
                                    then now() else finished_at end,
         updated_at          = now()
   where id = p_run;

  update public.bucketizer_run_documents
     set status = case when p_status = 'cancelled' then 'cancelled' else 'queued' end,
         started_at = null
   where run_id = p_run
     and status in ('queued', 'running');
  get diagnostics v_docs = row_count;

  delete from public.processing_jobs
   where job_type = 'bucketizer_classify_document'
     and status = 'queued'
     and (payload->>'run_id')::uuid = p_run;
  get diagnostics v_jobs = row_count;

  return jsonb_build_object('documents_reset', v_docs, 'jobs_removed', v_jobs);
end $$;

revoke execute on function public.bucketizer_run_halt(uuid, text, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.bucketizer_run_halt(uuid, text, text, integer, text)
  to service_role;

-- ============================================================================
-- 6. RLS — read your own matters' runs, and write nothing
-- ============================================================================

alter table public.bucketizer_runs           enable row level security;
alter table public.bucketizer_run_documents  enable row level security;
alter table public.bucketizer_run_windows    enable row level security;

drop policy if exists bucketizer_runs_select on public.bucketizer_runs;
create policy bucketizer_runs_select on public.bucketizer_runs
  for select to authenticated
  using (public._bktz_matter_access(matterspace_id));

drop policy if exists bucketizer_run_documents_select on public.bucketizer_run_documents;
create policy bucketizer_run_documents_select on public.bucketizer_run_documents
  for select to authenticated
  using (public._bktz_matter_access(matterspace_id));

drop policy if exists bucketizer_run_windows_select on public.bucketizer_run_windows;
create policy bucketizer_run_windows_select on public.bucketizer_run_windows
  for select to authenticated
  using (public._bktz_matter_access(matterspace_id));

-- No insert / update / delete policy on any of the three. With RLS enabled and
-- no policy, `authenticated` cannot write them at all; the service role (the
-- API handler and the worker) is not subject to RLS and does, after checking
-- the caller's own access itself.
