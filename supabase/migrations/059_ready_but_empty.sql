-- Contextspaces Migration 059: make "ready but not searchable" a queryable
-- fact instead of a quarterly audit finding.
--
-- Why
-- ---------------------------------------------------------------------------
-- The 2026-08-22 ingestion audit's headline was not a crash — it was silence:
-- 99.3% of documents said `ready` while only 60.5% had any passage behind
-- them. 5,782 TIFFs (a full Bates production in a live matter) sat stored,
-- green-lit and unsearchable for weeks, and the monitor of the day would have
-- printed "All documents are ready."
--
-- The class of failure is structural: `ready` records that the PIPELINE
-- finished, not that TEXT EXISTS. Store-and-display is a legitimate outcome
-- for a photo or an untranscribed recording, so zero passages cannot simply
-- be an error — it has to be classified. This function returns the raw fact
-- (every ready document with zero passages, cheaply) and leaves the
-- classification to the caller (scripts/ingest-monitor.mjs), which knows
-- which extensions are text-bearing and mutes what is expected.
--
-- has_indexed_twin: 2,875 of the TIFFs were exact duplicates whose canonical
-- copy IS indexed (same matter + filename + byte size — the dedupe key the
-- 08-23 backfill used). Those are empty BY CHOICE, and re-flagging them every
-- run would train the reader to ignore the digest. The flag lets the monitor
-- fold them into a one-line "known-benign" count.
--
-- Performance: one pass over ready documents with one probe each into
-- idx_passages_document_seq (leading column document_id, migration 002), plus
-- a group-by for the twin flag. Well inside the 8-second statement timeout at
-- ~18k documents; no new index needed.
--
-- SECURITY DEFINER + service_role ONLY, deliberately: this function bypasses
-- RLS and returns filenames across every matter and tenant. Granting it to
-- authenticated would leak cross-tenant filenames to any signed-in user. The
-- in-app health panel, when it comes, needs its own RLS-scoped variant.
--
-- Verified by scripts/_verify-ready-but-empty.mjs (PGlite, executes this
-- file, seeds indexed + empty + duplicate-twin documents, checks the rows).

create or replace function public.ready_but_empty()
returns table (
  document_id uuid,
  matterspace_id uuid,
  source_filename text,
  title text,
  file_size_bytes bigint,
  created_at timestamptz,
  has_indexed_twin boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with ready as (
    select d.id, d.matterspace_id, d.source_filename, d.title,
           d.file_size_bytes, d.created_at,
           exists (select 1 from public.passages p where p.document_id = d.id) as has_passages
      from public.documents d
     where d.processing_status = 'ready'
  ),
  grp as (
    -- One row per (matter, filename, size) group: does ANY copy have text?
    -- Group-by treats NULL filenames as equal, matching the join below.
    select r.matterspace_id as m, r.source_filename as f,
           coalesce(r.file_size_bytes, -1) as sz,
           bool_or(r.has_passages) as any_indexed,
           count(*) as copies
      from ready r
     group by 1, 2, 3
  )
  select r.id, r.matterspace_id, r.source_filename, r.title,
         r.file_size_bytes::bigint, r.created_at,
         (g.any_indexed and g.copies > 1) as has_indexed_twin
    from ready r
    join grp g
      on g.m = r.matterspace_id
     and g.f is not distinct from r.source_filename
     and g.sz = coalesce(r.file_size_bytes, -1)
   where not r.has_passages
$$;

revoke execute on function public.ready_but_empty() from public, anon, authenticated;
grant  execute on function public.ready_but_empty() to service_role;
