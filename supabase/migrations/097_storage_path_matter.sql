-- 097_storage_path_matter.sql — a document's stored file is filed under the
-- document's own matter, and nowhere else
--
-- THE HOLE (pre-existing; found in the adversarial review of PR #247)
-- ---------------------------------------------------------------------------
-- Every object in vault-documents lives at "<matter id>/<document id>/<file>"
-- (016's convention), and the bucket's policies judge an object by that first
-- segment. Everything else judges a document by its row's matterspace_id.
-- Nothing made the two agree. `documents` INSERT/UPDATE policies check only
-- the row's matterspace_id, so a member of an OPEN matter — or someone who
-- once was a member and kept a path — could write a row there whose
-- storage_path names an object in a SEALED matter or another firm's matter.
-- The routes that read bytes with the service role after a user-scoped row
-- lookup (api/cloud-export, api/drive-export, api/ext/push-to-drive,
-- api/gmail-send, the worker's ingest, get_media from the stdio server) would
-- then fetch that object on the strength of the pointer row, and
-- lib/export-gate.mjs would judge the seal by the POINTER's matter. The raw
-- bytes of a matter the person cannot open would leave.
--
-- THE FIX
-- ---------------------------------------------------------------------------
-- A CHECK constraint: a documents row's storage_path, when present, has the
-- exact shape <matter>/<doc>/<file> (ROUND 2 below) and begins
-- with that row's own matterspace_id. A pointer row can no longer be written
-- by anyone, the service role included. lib/storage-path.mjs asks the same
-- question in code right before each service-role read, so a route is safe
-- whether or not this file has been pasted.
--
-- Every writer of storage_path was checked against it (grep of api/, lib/,
-- worker/, src/): each builds "<the row's matter>/<row id>/<file>", and the
-- two MOVES (api/move-document.mjs; mcp-core move_document; the parent move in
-- lib/container-unpack.mjs) set matterspace_id and storage_path in ONE
-- UPDATE, which a CHECK sees as a single row change. copy_document strips
-- storage_path from the copied row and sets it afterwards to the target's
-- path. A move with no stored file changes matterspace_id only (null path).
--
-- Production audit (read-only, 2026-09-26): 0 of 46,475 documents rows
-- violate it. If that has changed by the time this is pasted, the ALTER fails
-- and names the constraint; nothing is half-applied.
--
-- ROUND 2 (adversarial review of #249) — the shape, not just the prefix
-- ---------------------------------------------------------------------------
-- A first-segment test is bypassable: Storage is reached by URL, and a URL
-- resolves dot segments, so "OPEN/../SEALED/doc/file" starts with OPEN and
-- names SEALED's object ("OPEN/../../discovery-files/…" even changes
-- bucket; "%2e%2e" and "..\" do the same). So the CHECK requires the exact
-- shape "<the row's matter uuid>/<segment>/<segment>" — three segments, none
-- empty, none "." or "..", no "%", no backslash. Case-sensitive, as uuid::text
-- is lower case. lib/storage-path.mjs asks the same, and refuses anything a
-- URL parser would rewrite besides.
--
-- The same class of hole in Discovery: production_items.native_storage_path
-- and display_storage_path are member-writable while a production is a draft
-- (030), and the worker reads them with the service role when it stamps and
-- packages. Their CHECK: "<the row's matter>/<the row's production>/…", same
-- segment rules. (Production objects are deeper than three segments:
-- <matter>/<production>/<item>/native/<file>.)
--
-- Production audit (read-only, 2026-09-26, round 2): ALL 46,496 documents
-- rows with a path are exactly <matter-uuid>/<doc>/<file> — 0 dot segments,
-- 0 '%', 0 backslashes, 0 empty segments, max length 282. production_items
-- has 0 rows. So the strict rule has no exceptions; if that has changed by
-- the time this is pasted, the ALTER fails whole and names the constraint.
--
-- ROUND 3 (the class: a job that names another matter's things)
-- ---------------------------------------------------------------------------
-- processing_jobs rows are member-writable (032 checks only that the row's
-- matterspace_id is reachable), and the payload is free-form jsonb that the
-- worker acts on with the service role: a Bucketizer job naming a sealed
-- document of another matter (its text went to the run's unsealed model), a
-- stamp or package job naming another matter's production, an ingest job
-- re-indexing another tenant's document. A BEFORE INSERT OR UPDATE trigger
-- now checks, for a SIGNED-IN caller (current_user authenticated or anon —
-- the service role, the worker and definer RPCs such as claim_discovery_job
-- pass), that every reference in the row belongs to new.matterspace_id:
--   production_id           → productions.matterspace_id
--   payload.document_id     → documents.matterspace_id
--   payload.run_id          → bucketizer_runs.matterspace_id, and with a
--                             document_id, a bucketizer_run_documents row
--   payload.storage_paths[] → "<matter>/<production>/…", 097's segment rules
--   payload.local_path, job_type intake_folder → refused outright
-- Ids must be canonical lower-case uuids. lib/job-scope.mjs is the same rule
-- in the worker, asked first by every handler; both layers, as with the paths.
-- The lookups are SECURITY DEFINER helpers in jobs_internal (not exposed by
-- PostgREST): they must see another matter's rows to say they are not yours.
-- ROUND 4: the trigger calls ONE definer wrapper, jobs_internal.job_refusal;
-- the helpers are owner-only. And "belongs" is a tree question: a Bucketizer
-- document may sit anywhere in the run matter's subtree (runs cover folders
-- and sub-matters), and an ingest job's document anywhere in the job matter's
-- tree (an upload filed into a folder after it was queued); a move now also
-- re-points the document's queued jobs with the service role.
--
-- Also round 3: no path segment may start or end with whitespace (a URL
-- parser trims the end of a path, so such a row is one the code refuses and
-- the database used to accept). ⚠ Unlike the round 2 rules this was not in
-- the production audit; before pasting, run
--   select count(*) from documents where storage_path ~ '(^|/)\s|\s(/|$)';
-- and expect 0 (the ALTER fails whole otherwise, and names the constraint).
--
-- Re-runnable. Needs 002 and 030; the job trigger's run checks need 079 and
-- are skipped without it.
-- ⚠ After pasting, run:  notify pgrst, 'reload schema';  (last statement here.)

alter table public.documents drop constraint if exists documents_storage_path_in_matter;
alter table public.documents add constraint documents_storage_path_in_matter
  check (
    storage_path is null or (
      storage_path ~ ('^' || matterspace_id::text || '/[^/]+/[^/]+$')
      and storage_path !~ '(^|/)\.{1,2}(/|$)'
      and position('%' in storage_path) = 0
      and position(chr(92) in storage_path) = 0
      and storage_path !~ '(^|/)\s|\s(/|$)'   -- round 3: no segment starts or ends with whitespace
    )
  );

comment on constraint documents_storage_path_in_matter on public.documents is
  'A stored file lives under its document''s own matter, exactly <matter>/<doc>/<file>: '
  'no dot segments, no %, no backslash. Refuses a row pointing at another matter''s '
  'object, directly or by traversal. Migration 097; lib/storage-path.mjs.';

do $pi$
begin
  if to_regclass('public.production_items') is null then
    raise notice '097: public.production_items is absent (030 not applied) — its constraints skipped.';
    return;
  end if;

  execute $sql$
    alter table public.production_items drop constraint if exists production_items_paths_in_production
  $sql$;
  execute $sql$
    alter table public.production_items add constraint production_items_paths_in_production
      check (
        (native_storage_path is null or (
          native_storage_path ~ ('^' || matterspace_id::text || '/' || production_id::text || '/[^/]+(/[^/]+)*$')
          and native_storage_path !~ '(^|/)\.{1,2}(/|$)'
          and position('%' in native_storage_path) = 0
          and position(chr(92) in native_storage_path) = 0
          and native_storage_path !~ '(^|/)\s|\s(/|$)'))
        and
        (display_storage_path is null or (
          display_storage_path ~ ('^' || matterspace_id::text || '/' || production_id::text || '/[^/]+(/[^/]+)*$')
          and display_storage_path !~ '(^|/)\.{1,2}(/|$)'
          and position('%' in display_storage_path) = 0
          and position(chr(92) in display_storage_path) = 0
          and display_storage_path !~ '(^|/)\s|\s(/|$)'))
      )
  $sql$;
end $pi$;

-- ============================================================================
-- Round 3: processing_jobs may name only its own matter's things
-- ============================================================================
create schema if not exists jobs_internal;
revoke all on schema jobs_internal from public;
grant usage on schema jobs_internal to authenticated, anon, service_role;

-- The lookups. Owner-only (round 4): nothing but job_refusal() below calls
-- them, and job_refusal runs as the owner.
create or replace function jobs_internal.matter_of_document(p uuid)
returns uuid language sql stable security definer set search_path = public
as $$ select d.matterspace_id from public.documents d where d.id = p $$;

create or replace function jobs_internal.matter_of_production(p uuid)
returns uuid language plpgsql stable security definer set search_path = public
as $$
declare v uuid;
begin
  if to_regclass('public.productions') is null then return null; end if;
  execute 'select matterspace_id from public.productions where id = $1' into v using p;
  return v;
end $$;

create or replace function jobs_internal.matter_of_run(p uuid)
returns uuid language plpgsql stable security definer set search_path = public
as $$
declare v uuid;
begin
  if to_regclass('public.bucketizer_runs') is null then return null; end if;
  execute 'select matterspace_id from public.bucketizer_runs where id = $1' into v using p;
  return v;
end $$;

create or replace function jobs_internal.run_lists_document(p_run uuid, p_doc uuid)
returns boolean language plpgsql stable security definer set search_path = public
as $$
declare v boolean;
begin
  if to_regclass('public.bucketizer_run_documents') is null then return false; end if;
  execute 'select exists (select 1 from public.bucketizer_run_documents where run_id = $1 and document_id = $2)'
    into v using p_run, p_doc;
  return coalesce(v, false);
end $$;

revoke all on function jobs_internal.matter_of_document(uuid) from public, anon, authenticated;
revoke all on function jobs_internal.matter_of_production(uuid) from public, anon, authenticated;
revoke all on function jobs_internal.matter_of_run(uuid) from public, anon, authenticated;
revoke all on function jobs_internal.run_lists_document(uuid, uuid) from public, anon, authenticated;

-- THE ONE WRAPPER the trigger calls (round 4). Definer, so it can see
-- another matter's rows to say they are not yours; returns the reason to
-- refuse, or null. "Belongs" is a tree question (round 4):
--   a Bucketizer document  → inside the job matter's SUBTREE (a run over a
--                            matter includes its folders and sub-matters),
--                            and listed by the run;
--   any other document     → in the SAME TREE as the job's matter (an upload
--                            filed into a folder after it was queued);
--   a production           → exactly the job's matter.
-- matter_ancestry (016) is the definer walk, self + ancestors.
create or replace function jobs_internal.job_refusal(
  p_matter uuid, p_job_type text, p_production uuid, p_payload jsonb
) returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  c_uuid  constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_doc   text;
  v_run   text;
  v_dm    uuid;
  v_path  jsonb;
  v_p     text;
begin
  if p_job_type = 'intake_folder' or (p_payload ? 'local_path') then
    return 'a job naming a local folder can only be started from the worker itself';
  end if;

  if p_production is not null
     and jobs_internal.matter_of_production(p_production) is distinct from p_matter then
    return 'that production is not in this job''s matter';
  end if;

  if p_payload ? 'run_id' then
    v_run := p_payload ->> 'run_id';
    if v_run is null or v_run !~ c_uuid
       or jobs_internal.matter_of_run(v_run::uuid) is distinct from p_matter then
      return 'that Bucketizer run is not in this job''s matter';
    end if;
  end if;

  if p_payload ? 'document_id' then
    v_doc := p_payload ->> 'document_id';
    if v_doc is null or v_doc !~ c_uuid then
      return 'that document is not in this job''s matter';
    end if;
    v_dm := jobs_internal.matter_of_document(v_doc::uuid);
    if v_dm is null then
      return 'that document is not in this job''s matter';
    end if;
    if v_run is not null then
      if not exists (select 1 from public.matter_ancestry(v_dm) a where a.id = p_matter) then
        return 'that document is not in this job''s matter';
      end if;
      if not jobs_internal.run_lists_document(v_run::uuid, v_doc::uuid) then
        return 'that document is not in that Bucketizer run';
      end if;
    elsif v_dm is distinct from p_matter and not exists (
      select 1 from public.matter_ancestry(v_dm) x
        join public.matter_ancestry(p_matter) y on y.id = x.id
    ) then
      return 'that document is not in this job''s matter';
    end if;
  end if;

  if p_payload ? 'storage_paths' then
    if jsonb_typeof(p_payload -> 'storage_paths') <> 'array' or p_production is null then
      return 'storage_paths must be a list of this production''s files';
    end if;
    for v_path in select * from jsonb_array_elements(p_payload -> 'storage_paths') loop
      v_p := case when jsonb_typeof(v_path) = 'string' then v_path #>> '{}' end;
      if v_p is null
         or v_p !~ ('^' || p_matter::text || '/' || p_production::text || '/[^/]+(/[^/]+)*$')
         or v_p ~ '(^|/)\.{1,2}(/|$)' or position('%' in v_p) > 0 or position(chr(92) in v_p) > 0
         or v_p ~ '(^|/)\s|\s(/|$)' then
        return 'a storage path outside this production';
      end if;
    end loop;
  end if;

  return null;
end $$;

revoke all on function jobs_internal.job_refusal(uuid, text, uuid, jsonb) from public;
grant execute on function jobs_internal.job_refusal(uuid, text, uuid, jsonb) to authenticated, anon, service_role;

-- INVOKER on purpose: current_user is then the CALLER (authenticated for a
-- browser or a forwarded user token; service_role or the owner otherwise).
create or replace function public._processing_jobs_scope_check()
returns trigger language plpgsql security invoker
as $$
declare
  v_why text;
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  v_why := jobs_internal.job_refusal(new.matterspace_id, new.job_type, new.production_id, new.payload);
  if v_why is not null then
    raise exception '%', v_why using errcode = '42501';
  end if;
  return new;
end $$;

do $jobs$
begin
  if to_regclass('public.processing_jobs') is null then
    raise notice '097: public.processing_jobs is absent (030 not applied) — the job trigger is skipped.';
    return;
  end if;
  execute 'drop trigger if exists processing_jobs_scope_check on public.processing_jobs';
  execute 'create trigger processing_jobs_scope_check before insert or update on public.processing_jobs
             for each row execute function public._processing_jobs_scope_check()';
end $jobs$;

notify pgrst, 'reload schema';
