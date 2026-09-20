-- Contextspaces Migration 066: proof of life for the ingestion worker, and an
-- honest answer for the person watching a spinner.
--
-- The problem (2026-09-19 ship-readiness audit, 01-ingestion.md)
-- ---------------------------------------------------------------------------
-- Everything that watches ingestion today runs on one laptop. The nightly
-- suite and the six-hourly monitor are Windows Scheduled Tasks on Eden's PC;
-- both have been dying with LastTaskResult 0xC000013A, and when the lid is
-- shut nothing is watching production at all. `/api/health` checks env
-- presence and an OAuth round-trip — it has never known whether the Fly worker
-- is running.
--
-- So the failure that costs a paying customer is invisible from both ends: the
-- worker stops, an uploaded document sits in 'pending' forever, the Vault shows
-- a spinner with no message, and no alert fires anywhere.
--
-- The missing fact is tiny: *is a worker alive right now?* Nothing in this
-- database records it. `processing_jobs.heartbeat_at` (migration 044) is a beat
-- per CLAIMED JOB — an idle worker with an empty queue writes nothing, and an
-- idle worker is indistinguishable from a dead one. Liveness has to be a
-- property of the WORKER, not of a job it happens to be holding.
--
-- What this migration installs
-- ---------------------------------------------------------------------------
--   * public.worker_heartbeats     — one row per worker process. Written ONLY
--                                    by the service role (RLS on, no policies,
--                                    grants revoked from anon/authenticated).
--   * ingest_worker_status(int)    — SECURITY DEFINER, aggregate numbers only:
--                                    is anything alive, how stale the last
--                                    beat is, global queue depth, oldest
--                                    non-terminal document age. No identifiers
--                                    of any kind. Safe for anon (this is what
--                                    /api/health calls) because there is
--                                    nothing tenant-shaped in it.
--   * ingest_status_for_me()       — SECURITY INVOKER plpgsql, no arguments.
--                                    The caller's OWN queue numbers plus the
--                                    global liveness facts, for the Vault.
--
-- Why no uuid is ever an argument
-- ---------------------------------------------------------------------------
-- A SECURITY DEFINER function that takes a user id is a tenant-data endpoint:
-- functions are EXECUTE-to-PUBLIC by default and PostgREST exposes every one of
-- them, so `rpc/whatever?p_user=<someone else>` would answer. The split here is
-- deliberate — the DEFINER half has no arguments that identify anybody, and the
-- per-caller half is INVOKER, so `auth.uid()` and RLS are the only things that
-- decide which rows it can see. The caller cannot ask about another tenant
-- because there is no parameter in which to name one.
--
-- Per [[feedback-rls-security-invoker-wrappers]] the INVOKER half captures
-- auth.uid() into its own declared variable at function entry and uses that
-- variable, never a repeated auth.uid() call.
--
-- Applies to a drifted database
-- ---------------------------------------------------------------------------
-- Idempotent: every object is `if not exists` / `create or replace`, and the
-- columns are added one at a time so a re-paste over an earlier partial apply
-- is a no-op. It depends on nothing newer than migration 030 (processing_jobs)
-- and 002 (documents), so it applies whether or not 062/063/064/065/067+ have
-- been pasted, and in any order relative to them. It references only
-- 'pending' | 'extracting' | 'chunking' | 'embedding' — the four transient
-- values that have existed since 002 — so it does not care whether 060's
-- 'held' is present.
--
-- Verified by scripts/_verify-worker-heartbeat.mjs, which EXECUTES this file
-- against a real Postgres (PGlite, no Docker) twice, with and without its
-- neighbours, and proves the tenant boundary with two signed-in users.

-- ---------------------------------------------------------------------------
-- 1. The table. One row per worker process, upserted on its own id.
--
-- Not a log: a worker that restarts overwrites its own row, and a machine that
-- is retired leaves one stale row that every reader ignores by age. Keeping
-- history here would make the hot path a growing table for no operational
-- gain — the history that matters is in the monitor's digest.
--
-- queue_depth / oldest_queued_at are a place for a worker to record what it
-- SAW, and the worker deliberately leaves them null: a beat must be one write
-- and nothing else, and ingest_worker_status() computes both numbers from
-- processing_jobs itself, where they are authoritative. They exist so a future
-- worker-side snapshot does not need another migration.
-- ---------------------------------------------------------------------------
create table if not exists public.worker_heartbeats (
  worker_id        text primary key,
  machine_id       text,
  worker_release   text,
  started_at       timestamptz not null default now(),
  last_beat_at     timestamptz not null default now(),
  last_job_at      timestamptz,
  jobs_done        bigint      not null default 0,
  queue_depth      int,
  oldest_queued_at timestamptz,
  note             text
);

-- Added one at a time so this file also repairs a row-shape from a partial
-- earlier apply rather than failing on it.
alter table public.worker_heartbeats add column if not exists machine_id       text;
alter table public.worker_heartbeats add column if not exists worker_release   text;
alter table public.worker_heartbeats add column if not exists started_at       timestamptz not null default now();
alter table public.worker_heartbeats add column if not exists last_beat_at     timestamptz not null default now();
alter table public.worker_heartbeats add column if not exists last_job_at      timestamptz;
alter table public.worker_heartbeats add column if not exists jobs_done        bigint not null default 0;
alter table public.worker_heartbeats add column if not exists queue_depth      int;
alter table public.worker_heartbeats add column if not exists oldest_queued_at timestamptz;
alter table public.worker_heartbeats add column if not exists note             text;

-- "Is anything alive" is a max() over a table with a handful of rows, so the
-- index is for the monitor's ordered listing, not for the liveness question.
create index if not exists idx_worker_heartbeats_beat
  on public.worker_heartbeats (last_beat_at desc);

-- ---------------------------------------------------------------------------
-- 2. Nobody reads this table but the service role.
--
-- RLS with no policies denies everything to anon/authenticated — but RLS alone
-- is not the whole story in a Supabase project: the default grants hand `all
-- privileges on all tables in public` to anon and authenticated, and a table
-- owner (or a future `alter table ... disable row level security` by mistake)
-- would expose it. So the grant is revoked explicitly as well: two independent
-- locks, and the readers below are functions, which need neither.
-- ---------------------------------------------------------------------------
alter table public.worker_heartbeats enable row level security;

do $$
begin
  execute 'revoke all on public.worker_heartbeats from anon';
  execute 'revoke all on public.worker_heartbeats from authenticated';
exception when undefined_object then
  -- A bare Postgres (PGlite, a local dev database) has no anon/authenticated
  -- roles. The revoke is meaningless there and must not stop the file.
  null;
end $$;

do $$
begin
  execute 'grant select, insert, update, delete on public.worker_heartbeats to service_role';
exception when undefined_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 3. The global facts. Numbers only.
--
-- Returns exactly six numbers and one boolean. There is no title, no filename,
-- no matter id, no user id, and no way to ask about a particular one of any of
-- them — which is what makes it safe to grant to anon and therefore safe for
-- an unauthenticated /api/health to call with the anon key.
--
-- p_alive_minutes is a threshold, not an identifier; it is clamped so a caller
-- cannot turn it into an expensive or silly question.
--
-- SECURITY DEFINER because worker_heartbeats is readable by nobody (§2), and
-- because the document/queue counts must be GLOBAL — an operator wants to know
-- that *someone's* upload is stuck, not only their own.
-- ---------------------------------------------------------------------------
create or replace function public.ingest_worker_status(p_alive_minutes int default 10)
returns table (
  worker_alive              boolean,
  workers_beating           int,
  seconds_since_beat        int,
  queue_depth               int,
  oldest_queued_seconds     int,
  documents_processing      int,
  oldest_processing_seconds int
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_window interval;
  v_last   timestamptz;
begin
  v_window := make_interval(mins => least(greatest(coalesce(p_alive_minutes, 10), 1), 120));

  select max(h.last_beat_at),
         count(*) filter (where h.last_beat_at > now() - v_window)
    into v_last, workers_beating
    from public.worker_heartbeats h;

  workers_beating := coalesce(workers_beating, 0);
  worker_alive := workers_beating > 0;
  -- null, not 0, when no worker has EVER beaten: "we do not know" and "it beat
  -- this second" are different answers and a reader must be able to tell them
  -- apart. A brand-new deployment reads as unknown, not as healthy.
  seconds_since_beat := case when v_last is null then null
                             else greatest(0, floor(extract(epoch from (now() - v_last)))::int) end;

  select count(*)::int,
         greatest(0, floor(extract(epoch from (now() - min(j.created_at))))::int)
    into queue_depth, oldest_queued_seconds
    from public.processing_jobs j
   where j.status in ('queued', 'running');
  queue_depth := coalesce(queue_depth, 0);

  -- The audit's real symptom: a document that never reaches a terminal state.
  -- updated_at, not created_at — /api/ingest stamps 'extracting' before the
  -- heavy work (PR #169), so a document that is genuinely moving keeps
  -- refreshing this and only a stalled one grows old.
  select count(*)::int,
         greatest(0, floor(extract(epoch from (now() - min(d.updated_at))))::int)
    into documents_processing, oldest_processing_seconds
    from public.documents d
   where d.processing_status in ('pending', 'extracting', 'chunking', 'embedding');
  documents_processing := coalesce(documents_processing, 0);

  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. What the person staring at a spinner is allowed to know.
--
-- SECURITY INVOKER, no arguments, auth.uid() captured once into v_uid per
-- [[feedback-rls-security-invoker-wrappers]]. The document counts run as the
-- CALLER, so RLS on public.documents applies on top of the created_by filter:
-- two independent reasons this can only ever count the caller's own rows, and
-- no parameter in which to name somebody else's.
--
-- The global numbers it returns are the ones from §3, which contain no tenant
-- data — the caller learns "processing is paused" and "the queue is 40 deep",
-- never whose queue it is.
-- ---------------------------------------------------------------------------
create or replace function public.ingest_status_for_me(p_alive_minutes int default 10)
returns table (
  worker_alive              boolean,
  seconds_since_beat        int,
  queue_depth               int,
  oldest_queued_seconds     int,
  my_processing             int,
  my_oldest_seconds         int
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  w     record;
begin
  -- Signed out: no rows at all. Not zeros — zeros would read as "nothing of
  -- yours is processing", which is a claim this function cannot make.
  if v_uid is null then
    return;
  end if;

  select * into w from public.ingest_worker_status(p_alive_minutes);
  worker_alive          := w.worker_alive;
  seconds_since_beat    := w.seconds_since_beat;
  queue_depth           := w.queue_depth;
  oldest_queued_seconds := w.oldest_queued_seconds;

  select count(*)::int,
         greatest(0, floor(extract(epoch from (now() - min(d.updated_at))))::int)
    into my_processing, my_oldest_seconds
    from public.documents d
   where d.created_by = v_uid
     and d.processing_status in ('pending', 'extracting', 'chunking', 'embedding');
  my_processing := coalesce(my_processing, 0);

  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Who may call what.
--
-- EXECUTE is granted to PUBLIC by default on every new function, so each one is
-- revoked first and then granted deliberately. ingest_worker_status is open to
-- anon on purpose (/api/health is unauthenticated by design — it has to work
-- when auth itself is what broke); ingest_status_for_me is not, because it
-- answers nothing at all without a session.
-- ---------------------------------------------------------------------------
do $$
begin
  execute 'revoke all on function public.ingest_worker_status(int) from public';
  execute 'revoke all on function public.ingest_status_for_me(int) from public';
  execute 'grant execute on function public.ingest_worker_status(int) to anon, authenticated, service_role';
  execute 'grant execute on function public.ingest_status_for_me(int) to authenticated, service_role';
exception when undefined_object then
  -- No Supabase roles (bare Postgres / PGlite). The revoke from PUBLIC above
  -- may have already run; either way the file must complete.
  null;
end $$;

comment on table public.worker_heartbeats is
  'One row per ingestion worker process. Service role only. Read as aggregates through ingest_worker_status() / ingest_status_for_me().';
comment on function public.ingest_worker_status(int) is
  'Aggregate ingestion liveness. Numbers only, no identifiers — safe for the unauthenticated /api/health.';
comment on function public.ingest_status_for_me(int) is
  'The caller''s own ingestion queue numbers plus global worker liveness. SECURITY INVOKER: RLS decides what it can count.';
