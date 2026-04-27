-- Context.ai Migration 007: Book ingestion support
--
-- Extends the existing documents/passages model to handle ebooks (EPUB,
-- and later MOBI/AZW via Calibre conversion). No parallel schema: a book
-- is a documents row with doc_type = 'book'; chapters and sections are
-- passages rows linked through parent_passage_id, with chapter_number /
-- chapter_title / section_title stored in passages.metadata.
--
-- Also adds embedding_model + embedding_version on passages so we can
-- migrate to a different embedding provider later without losing the
-- existing vectors. The search_passages RPC is updated to filter by
-- a single embedding version so mid-migration queries don't mix vector
-- spaces.

-- =============================================================================
-- doc_type: add 'book'
-- =============================================================================
alter table public.documents
  drop constraint if exists documents_doc_type_check;

alter table public.documents
  add constraint documents_doc_type_check check (doc_type in (
    'transcript', 'deposition', 'exhibit', 'brief',
    'expert_report', 'contract', 'correspondence',
    'book', 'other'
  ));

-- =============================================================================
-- passage_type: add 'chapter_heading' and 'footnote'
-- =============================================================================
alter table public.passages
  drop constraint if exists passages_passage_type_check;

alter table public.passages
  add constraint passages_passage_type_check check (passage_type in (
    'qa_pair', 'monologue', 'colloquy', 'exhibit_reference',
    'section_heading', 'chapter_heading', 'footnote', 'summary'
  ));

-- =============================================================================
-- Embedding provenance
--
-- Every passage records which model produced its vector and which logical
-- version of that model it is. The version is a small integer the
-- application bumps when re-embedding (e.g. switching from OpenAI
-- text-embedding-3-small to Voyage voyage-3, or upgrading Voyage from one
-- generation to the next).
--
-- IMPORTANT: dimension changes are NOT handled by ALTER COLUMN on the
-- vector column. They are handled by:
--   1. Creating a new column embedding_v2 vector(new_dim)
--   2. Re-embedding rows into embedding_v2 with a new (model, version)
--   3. Updating the application to read from the new column + version
--   4. Dropping the old column once all rows are migrated
-- This keeps mid-migration queries coherent. Do not try to ALTER COLUMN
-- the vector dimension in place; pgvector allows it on empty tables only.
-- =============================================================================
alter table public.passages
  add column if not exists embedding_model text not null
    default 'text-embedding-3-small';

alter table public.passages
  add column if not exists embedding_version int not null default 1;

create index if not exists idx_passages_embedding_version
  on public.passages (matterspace_id, embedding_model, embedding_version);

-- =============================================================================
-- search_passages: filter by embedding version
--
-- Adds p_embedding_model + p_embedding_version. Defaults match the current
-- production values so existing callers (mcp-core.mjs) keep working without
-- code changes. When we migrate providers, the application bumps the version
-- and updates the default args here.
--
-- Drop the previous 8-arg signature first. PostgreSQL treats functions with
-- different parameter lists as separate overloads, so a bare `create or
-- replace` would leave the old version alive — and existing callers passing
-- 8 named args would silently bind to it, bypassing the version filter.
-- =============================================================================
drop function if exists public.search_passages(uuid, text, vector, text[], text[], uuid[], int, int);

create or replace function public.search_passages(
  p_matterspace_id uuid,
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
    where p.matterspace_id = p_matterspace_id
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
