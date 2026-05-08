-- Contextspaces Migration 012: tree-aware search via matter descendants
--
-- Phase 2 of the Vault retrieval story. Until now, search_passages took a
-- single matterspace_id and returned only passages directly inside that
-- matter — so opening "History" and asking for a quote from Quantum (a
-- sub-matter) would surface nothing.
--
-- Two changes here:
--   1) A recursive CTE function matterspace_descendants(uuid) that returns
--      a matter id and every descendant (sub-matter, sub-sub-matter, ...)
--      reachable via parent_matterspace_id.
--   2) search_passages is dropped and recreated to accept p_matterspace_ids
--      uuid[] instead of a single uuid. mcp-core.mjs now resolves the
--      target matter, expands it to its descendant set, and passes the
--      whole set in. Same hybrid scoring, same filters, same return shape.
--
-- Why drop+recreate (per migration 007's lesson): PostgreSQL treats a
-- different parameter list as a new overload, so a bare `create or
-- replace` would leave the old single-uuid signature live and existing
-- service-role calls binding to it would silently bypass the descendant
-- expansion. Drop the precise old signature, then create the new one.

-- =============================================================================
-- matterspace_descendants(p_root uuid)
--   Returns p_root and every matter beneath it. SECURITY INVOKER so RLS on
--   the underlying matterspaces table still applies — a user cannot enumerate
--   descendants of a matter they don't have read access to.
-- =============================================================================
create or replace function public.matterspace_descendants(p_root uuid)
returns table (id uuid)
language sql stable as $$
  with recursive tree as (
    select m.id
    from public.matterspaces m
    where m.id = p_root
    union all
    select c.id
    from public.matterspaces c
    join tree t on c.parent_matterspace_id = t.id
  )
  select id from tree;
$$;

-- =============================================================================
-- search_passages: switch from single matter to matter array
-- =============================================================================
drop function if exists public.search_passages(uuid, text, vector, text[], text[], uuid[], int, int, text, int);

create or replace function public.search_passages(
  p_matterspace_ids uuid[],
  p_query_text text,
  p_query_embedding vector(1024),
  p_doc_types text[] default null,
  p_witness_names text[] default null,
  p_document_ids uuid[] default null,
  p_summary_level int default 0,
  p_limit int default 20,
  p_embedding_model text default 'text-embedding-3-small',
  p_embedding_version int default 1
)
returns table (
  passage_id uuid,
  document_id uuid,
  document_title text,
  doc_type text,
  page_start int,
  page_end int,
  line_start int,
  line_end int,
  witness_name text,
  examination_type text,
  passage_type text,
  text text,
  hybrid_score real,
  text_rank real,
  vector_score real
)
language sql stable as $$
  with q as (
    select websearch_to_tsquery('english', coalesce(p_query_text, '')) as tsq
  ),
  candidates as (
    select
      p.id          as passage_id,
      p.document_id,
      d.title       as document_title,
      d.doc_type,
      p.page_start,
      p.page_end,
      p.line_start,
      p.line_end,
      p.witness_name,
      p.examination_type,
      p.passage_type,
      p.text,
      case
        when q.tsq is null then 0::real
        else ts_rank(p.tsv, q.tsq)
      end as text_rank,
      case
        when p_query_embedding is null or p.embedding is null then 0::real
        else (1 - (p.embedding <=> p_query_embedding))::real
      end as vector_score
    from public.passages p
    join public.documents d on d.id = p.document_id
    cross join q
    where p.matterspace_id = any(p_matterspace_ids)
      and p.summary_level  = p_summary_level
      and p.embedding_model   = p_embedding_model
      and p.embedding_version = p_embedding_version
      and (p_doc_types     is null or d.doc_type      = any(p_doc_types))
      and (p_witness_names is null or p.witness_name  = any(p_witness_names))
      and (p_document_ids  is null or p.document_id   = any(p_document_ids))
      and (
        p.tsv @@ q.tsq
        or p_query_embedding is not null
      )
  )
  select
    passage_id,
    document_id,
    document_title,
    doc_type,
    page_start,
    page_end,
    line_start,
    line_end,
    witness_name,
    examination_type,
    passage_type,
    text,
    (0.4 * text_rank + 0.6 * vector_score)::real as hybrid_score,
    text_rank,
    vector_score
  from candidates
  order by hybrid_score desc
  limit p_limit;
$$;
