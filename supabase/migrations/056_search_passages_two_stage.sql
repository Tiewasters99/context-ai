-- Contextspaces Migration 056: two-stage retrieval for search_passages.
--
-- The bug (2026-08-22 ingestion audit, §2f)
-- ---------------------------------------------------------------------------
-- Migration 012's search_passages computes a blended score for every passage in
-- scope and then sorts:
--
--     where p.matterspace_id = any(p_matterspace_ids)
--       and (p.tsv @@ q.tsq or p_query_embedding is not null)
--     order by (0.4 * text_rank + 0.6 * vector_score) desc
--     limit p_limit
--
-- Two index defeats in four lines.
--
--   1. ORDER BY is a *blended expression*, not the distance operator. An HNSW
--      index can only answer `order by embedding <=> $1`. Postgres therefore
--      cannot use idx_passages_embedding_hnsw at all: it sequentially scans the
--      matter's passages and computes a 1024-dimension cosine for every row.
--
--   2. `or p_query_embedding is not null` makes the WHERE clause
--      unconditionally true the moment a caller passes an embedding — which
--      every caller does. So idx_passages_tsv (GIN) is never used either.
--
-- Every semantic search is a full scan of the matter. Measured on prod, service
-- role, sequential, unloaded, against an 8-second statement timeout:
--
--     ai-personhood alone   ~10,145 passages   200 rows in 2.1 s
--     12 small matters      ~18,494 passages   200 rows in 4.4 s
--     fleming alone        ~100,723 passages   500 — statement timeout at 8.2 s
--     top-12 batch         ~231,930 passages   500 at 8.1 s
--     all 214 matters      ~299,879 passages   500 at 8.1 s
--
-- ~0.22 ms per passage scanned, i.e. a hard ceiling near 35,000 passages per
-- query. Fleming — the matter with the most text in the practice, 100,723
-- passages — cannot be searched at all, and global search fans 18 batches of
-- that same brute-force scan at one instance in parallel, which is the "16 of
-- 16 matter groups timed out" the MCP client reports.
--
-- The fix: retrieve, then rank
-- ---------------------------------------------------------------------------
-- Blending is cheap. Blending 100,723 rows is not. So blend last, over a small
-- candidate set gathered by two queries that each use an index:
--
--   Stage A (vector). `order by p.embedding <=> p_query_embedding limit K`
--     — the raw operator, so the HNSW index answers it. Approximate, ordered,
--     and logarithmic rather than linear in the corpus.
--
--   Stage B (text).   `where p.tsv @@ tsq` — a real predicate now, with no
--     `or ... is not null` beside it to short-circuit it, so the GIN index
--     answers it. Ranked by ts_rank and cut to K.
--
--   Stage C (blend).  Union the two candidate id sets (<= 2K rows, typically
--     400), compute ts_rank and cosine for exactly those rows, apply the same
--     0.4/0.6 weights, order, and cut to p_limit.
--
-- The contract is unchanged on purpose: same function name, same ten argument
-- names in the same order with the same defaults, same fifteen result columns
-- with the same meanings. lib/mcp-core.mjs, the app, and the Orchestrator all
-- bind to it and none of them need to know.
--
-- What does change, stated plainly: this is now approximate retrieval. A
-- passage ranked 250th by vector *and* 250th by text could in principle beat
-- something in the pool on the blended score and will not be seen. That is the
-- standard trade every hybrid search makes, K is 10x the requested limit
-- (floor 200), and the alternative currently in production is returning
-- nothing at all after eight seconds.
--
-- SECURITY INVOKER (the default, as before): RLS on passages and documents
-- still decides what the caller may see, in all three stages.
--
-- Not applied by this branch. Paste into the Supabase SQL editor after 055.

-- ---------------------------------------------------------------------------
-- Indexes the plan depends on. All three already exist from migration 002 —
-- restated so the dependency is explicit rather than folklore, and so the
-- function is never installed against a database that lacks them.
--
-- ⚠ If any of these three actually has to be BUILT, it will not be quick: an
-- HNSW index over 300,000 1024-dimension vectors takes minutes and holds a
-- write lock the whole time, and the SQL editor may time out mid-build. Run
-- this block on its own first and watch it. If a build is needed, prefer
-- `create index concurrently` in a separate session (it cannot run inside a
-- transaction, so it must be its own statement). On a database where 002 was
-- applied — which is every database that has passages in it — all three are
-- no-ops that return in milliseconds.
-- ---------------------------------------------------------------------------
create index if not exists idx_passages_tsv
  on public.passages using gin(tsv);
create index if not exists idx_passages_embedding_hnsw
  on public.passages using hnsw (embedding vector_cosine_ops);
create index if not exists idx_passages_matterspace_level
  on public.passages(matterspace_id, summary_level);

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
language plpgsql
stable
as $$
-- RETURNS TABLE declares `text`, `document_id`, `doc_type`, `witness_name` …
-- as plpgsql variables, every one of which is also a column name on passages
-- or documents. Every reference below is table-qualified, but pin the rule
-- anyway: inside a query, a name that could be either is the column.
#variable_conflict use_column
declare
  v_tsq      tsquery := websearch_to_tsquery('english', coalesce(p_query_text, ''));
  v_has_text boolean;
  v_has_vec  boolean := p_query_embedding is not null;
  v_limit    int     := greatest(coalesce(p_limit, 20), 1);
  -- Candidates per stage. Ten per requested result, floor 200, ceiling 500:
  -- enough that the blend has real choices, small enough that stage C is a
  -- few hundred index lookups.
  v_k        int     := least(greatest(v_limit * 10, 200), 500);
  -- Worst-case ceiling on how many full-text matches get ranked. A one-word
  -- query against a large corpus can match tens of thousands of passages, and
  -- ts_rank on every one of them would re-create the problem this migration
  -- exists to fix. Beyond this many matches the query is too broad for ranking
  -- to mean much anyway.
  v_scan     int     := 20000;
begin
  -- numnode() counts the lexemes: websearch_to_tsquery('') returns an empty
  -- tsquery rather than null, and an empty tsquery matches nothing, so an
  -- embedding-only search must not pay for stage B at all.
  v_has_text := v_tsq is not null and numnode(v_tsq) > 0;

  if v_has_vec then
    -- An HNSW scan returns at most hnsw.ef_search tuples, default 40. Asking
    -- for 200 candidates without raising it silently returns 40. Guarded by a
    -- pg_settings lookup because pgvector reserves the "hnsw" GUC prefix:
    -- setting a parameter it does not define is an error, not a no-op.
    if exists (select 1 from pg_settings where name = 'hnsw.ef_search') then
      perform set_config('hnsw.ef_search', format('%s', greatest(v_k, 40)), true);
    end if;
    -- pgvector 0.8+. When the scope is a small fraction of the corpus the
    -- filter is applied *after* the index scan, so a fixed ef_search can come
    -- back short; iterative scan keeps going until it has enough. Absent on
    -- older pgvector, hence the same guard — the plan is still correct without
    -- it, because a highly selective matter filter makes the planner prefer
    -- idx_passages_matterspace_level and an exact top-N sort over the handful
    -- of rows in scope, which is the right plan for a small matter anyway.
    if exists (select 1 from pg_settings where name = 'hnsw.iterative_scan') then
      perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
    end if;
  end if;

  return query
  with ann as (
    -- Stage A. The ORDER BY is the bare distance operator against a parameter:
    -- the one shape idx_passages_embedding_hnsw can answer.
    select p.id
      from public.passages p
     where v_has_vec
       and p.embedding is not null
       and p.matterspace_id     = any(p_matterspace_ids)
       and p.summary_level      = p_summary_level
       and p.embedding_model    = p_embedding_model
       and p.embedding_version  = p_embedding_version
       and (p_witness_names is null or p.witness_name = any(p_witness_names))
       and (p_document_ids  is null or p.document_id  = any(p_document_ids))
       and (p_doc_types is null or exists (
             select 1 from public.documents d
              where d.id = p.document_id and d.doc_type = any(p_doc_types)))
     order by p.embedding <=> p_query_embedding
     limit v_k
  ),
  fts_matches as (
    -- Stage B, part 1: the GIN predicate on its own, bounded. No
    -- `or p_query_embedding is not null` beside it this time, which is the
    -- whole reason the index becomes usable.
    select p.id, p.tsv
      from public.passages p
     where v_has_text
       and p.tsv @@ v_tsq
       and p.matterspace_id     = any(p_matterspace_ids)
       and p.summary_level      = p_summary_level
       and p.embedding_model    = p_embedding_model
       and p.embedding_version  = p_embedding_version
       and (p_witness_names is null or p.witness_name = any(p_witness_names))
       and (p_document_ids  is null or p.document_id  = any(p_document_ids))
       and (p_doc_types is null or exists (
             select 1 from public.documents d
              where d.id = p.document_id and d.doc_type = any(p_doc_types)))
     limit v_scan
  ),
  fts as (
    -- Stage B, part 2: rank the bounded match set, keep the best K.
    select m.id
      from fts_matches m
     order by ts_rank(m.tsv, v_tsq) desc
     limit v_k
  ),
  candidates as (
    select id from ann
    union
    select id from fts
  ),
  scored as (
    -- Stage C. A few hundred primary-key lookups. Both signals are computed
    -- here, for every candidate from either stage, so a passage found by text
    -- still gets its true vector score and vice versa — the scores a caller
    -- sees mean exactly what they meant before.
    select
      p.id              as passage_id,
      p.document_id     as document_id,
      d.title           as document_title,
      d.doc_type        as doc_type,
      p.page_start      as page_start,
      p.page_end        as page_end,
      p.line_start      as line_start,
      p.line_end        as line_end,
      p.witness_name    as witness_name,
      p.examination_type as examination_type,
      p.passage_type    as passage_type,
      p.text            as text,
      (case when v_has_text then ts_rank(p.tsv, v_tsq) else 0 end)::real as text_rank,
      (case when v_has_vec and p.embedding is not null
            then 1 - (p.embedding <=> p_query_embedding)
            else 0 end)::real as vector_score
      from candidates c
      join public.passages  p on p.id = c.id
      join public.documents d on d.id = p.document_id
     where (p_doc_types is null or d.doc_type = any(p_doc_types))
  )
  select
    s.passage_id,
    s.document_id,
    s.document_title,
    s.doc_type,
    s.page_start,
    s.page_end,
    s.line_start,
    s.line_end,
    s.witness_name,
    s.examination_type,
    s.passage_type,
    s.text,
    (0.4 * s.text_rank + 0.6 * s.vector_score)::real as hybrid_score,
    s.text_rank,
    s.vector_score
  from scored s
  order by (0.4 * s.text_rank + 0.6 * s.vector_score) desc, s.passage_id
  limit v_limit;
end $$;

-- Grants are unchanged from 012 (execute to public; RLS does the work).
