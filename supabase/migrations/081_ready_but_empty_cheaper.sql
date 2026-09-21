-- Contextspaces Migration 081: make ready_but_empty() cheap enough to finish.
--
-- Why
-- ---------------------------------------------------------------------------
-- 059 answers "which ready documents have no passages", and the monitor's
-- headline depends on it. At ~46k documents it now sits on the 8-second
-- statement timeout: it ran at 17:44Z on 2026-09-20 and was cancelled at
-- 19:35Z. Worse, the cancellation read as health — the digest printed "All
-- documents are ready" and exited 0 with the question unanswered. The monitor
-- no longer treats a failed check as a pass (scripts/ingest-monitor.mjs), and
-- this migration removes the reason it was failing.
--
-- What was expensive: 059 computed the duplicate-twin flag by grouping EVERY
-- ready document (matter, filename, size) and joining that back. The group-by
-- ran over the whole corpus to answer a question that only matters for the
-- rows that come back empty — a few thousand at most.
--
-- This version finds the empty rows first, then asks about twins only for
-- those, and the new partial index serves that lookup. Same rows, same
-- has_indexed_twin semantics (a twin counts only when another copy in the same
-- matter, with the same filename and size, actually has passages). Proven
-- against 059's own results by scripts/_verify-ready-but-empty.mjs, which
-- executes both files in PGlite and asserts the two return identical rows.
--
-- SECURITY DEFINER + service_role only, unchanged from 059: this bypasses RLS
-- and returns filenames across every tenant.

-- Serves the twin lookup below, and any other dedupe-key probe over ready
-- documents. Partial: the whole query is about ready rows.
create index if not exists idx_documents_ready_dedupe_key
  on public.documents (matterspace_id, source_filename, file_size_bytes)
  where processing_status = 'ready';

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
  with empty as (
    -- The fact itself: ready, and nothing indexed behind it. One probe per
    -- ready document into idx_passages_document_seq (migration 002).
    select d.id, d.matterspace_id, d.source_filename, d.file_size_bytes, d.title, d.created_at
      from public.documents d
     where d.processing_status = 'ready'
       and not exists (select 1 from public.passages p where p.document_id = d.id)
  ),
  keys as (
    -- Only the dedupe keys the empty rows actually use.
    select distinct matterspace_id as m, source_filename as f, coalesce(file_size_bytes, -1) as sz
      from empty
  ),
  indexed_twins as (
    -- Of those keys, which have at least one copy that IS indexed.
    select k.m, k.f, k.sz
      from keys k
     where exists (
       select 1
         from public.documents t
        where t.processing_status = 'ready'
          and t.matterspace_id = k.m
          and t.source_filename is not distinct from k.f
          and coalesce(t.file_size_bytes, -1) = k.sz
          and exists (select 1 from public.passages p2 where p2.document_id = t.id)
     )
  )
  select e.id, e.matterspace_id, e.source_filename, e.title,
         e.file_size_bytes::bigint, e.created_at,
         (it.m is not null) as has_indexed_twin
    from empty e
    left join indexed_twins it
      on it.m = e.matterspace_id
     and it.f is not distinct from e.source_filename
     and it.sz = coalesce(e.file_size_bytes, -1)
$$;

revoke execute on function public.ready_but_empty() from public, anon, authenticated;
grant  execute on function public.ready_but_empty() to service_role;
