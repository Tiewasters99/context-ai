-- 110_intake_documents_scope.sql
--
-- Discovery: produce documents already in the matter (Eden, 2026-10-11).
--
-- A new job type, intake_documents, carries payload.document_ids — documents
-- filed in the matter's Vault that the worker reads server-side and produces,
-- so nobody downloads a (possibly sealed) document to upload it again.
--
-- 097's trigger checks the payload keys it knows (document_id, run_id,
-- storage_paths, local_path). A LIST of documents is a key it has never seen,
-- so without this migration a signed-in member could queue an
-- intake_documents job naming any document id and only the worker's own
-- assert (lib/job-scope.mjs) would stand in the way. 097's rule is "both
-- layers"; this restores it for the new key:
--
--   payload.document_ids  → a json array of 1..5000 canonical lower-case
--                           uuids, a production_id must be set, and EVERY
--                           document must sit in the job matter's SUBTREE
--                           (the matter, its folders and sub-matters — never
--                           a sibling sub-matter or a parent). A document id
--                           that does not exist is refused here, as 097
--                           refuses an unknown singular document_id.
--
-- Everything else in job_refusal is byte-identical to 097's. The seal is not
-- this check's rule: the worker refuses a document from a sub-matter sealed
-- more tightly than the production's matter (lib/seal-crossing.mjs).
--
-- Idempotent: safe to paste twice. ORDER MATTERS: 110 replaces 097's
-- jobs_internal.job_refusal, so re-pasting 097 after 110 would silently drop
-- the document_ids check. If 097 is ever re-pasted, paste 110 again after it.
-- Needs 097 (the jobs_internal schema, its helpers and the trigger).
-- ⚠ After pasting, run:  notify pgrst, 'reload schema';  (last statement here.)

do $pre$
begin
  if to_regprocedure('jobs_internal.matter_of_document(uuid)') is null then
    raise exception '110 needs migration 097 (jobs_internal.matter_of_document) — paste 097 first.';
  end if;
end $pre$;

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
  v_id    jsonb;
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

  -- 110: a list of the matter's own documents, to be produced.
  if p_payload ? 'document_ids' then
    if jsonb_typeof(p_payload -> 'document_ids') <> 'array' or p_production is null
       or jsonb_array_length(p_payload -> 'document_ids') = 0
       or jsonb_array_length(p_payload -> 'document_ids') > 5000 then
      return 'document_ids must be a list of this matter''s documents, for a production';
    end if;
    for v_id in select * from jsonb_array_elements(p_payload -> 'document_ids') loop
      v_doc := case when jsonb_typeof(v_id) = 'string' then v_id #>> '{}' end;
      if v_doc is null or v_doc !~ c_uuid then
        return 'a document is not in this job''s matter';
      end if;
      v_dm := jobs_internal.matter_of_document(v_doc::uuid);
      if v_dm is null or not exists (select 1 from public.matter_ancestry(v_dm) a where a.id = p_matter) then
        return 'a document is not in this job''s matter';
      end if;
    end loop;
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

notify pgrst, 'reload schema';
