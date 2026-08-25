-- Contextspaces Migration 061: make search correct when a matter holds more
-- than one embedding model — which Phase B of the seal makes routine.
--
-- The setting
-- ---------------------------------------------------------------------------
-- Phase A stopped sealed matters from being embedded by OpenAI. Phase B gives
-- them an embedding model of their own, on a US zero-retention route. The
-- moment that lands, `passages.embedding_model` stops being a formality with
-- one value in it and starts being load-bearing: an unsealed matter's rows say
-- one thing, a sealed matter's rows say another, and a matter that gets
-- re-tiered holds BOTH while its backfill runs.
--
-- Migration 056's two-stage search has one bug that only appears in that world
-- and one trap laid directly behind it. Both are silent, and the second is
-- reachable only once the first is fixed — so they have to be fixed together,
-- in this order, in one migration.
--
-- Bug 1 — full-text is filtered by embedding model
-- ---------------------------------------------------------------------------
-- Stage B, the pure-Postgres full-text stage, carries these two predicates
-- inherited from 007/012 (where a single query did everything):
--
--     and p.embedding_model    = p_embedding_model
--     and p.embedding_version  = p_embedding_version
--
-- Full-text ranking has nothing to do with embeddings. A tsvector match is a
-- tsvector match whatever vector happens to sit in the next column. Keeping the
-- filter there means:
--
--   * a sealed matter embedded with anything other than the default becomes
--     INVISIBLE to text search unless the caller guesses its model — and the
--     text stage is precisely the half that is supposed to keep working when
--     the vector half cannot;
--   * a matter mid-backfill can never text-search both halves of itself at
--     once, no matter what the caller passes.
--
-- Both failures return an empty result set rather than an error, which is the
-- worst way for a legal search tool to be wrong. Stage B loses the filter.
--
-- The trap behind it — cosine distance across incompatible spaces
-- ---------------------------------------------------------------------------
-- The obvious fix for bug 1 is to delete those two lines from stage B and stop
-- there. Do that and you introduce a worse bug than the one you fixed, because
-- stage C scores EVERY candidate, including the ones stage B found by text:
--
--     case when v_has_vec and p.embedding is not null
--          then 1 - (p.embedding <=> p_query_embedding)
--
-- Nothing there asks whether the passage's vector and the query's vector come
-- from the same model. Vectors from different models are not comparable — the
-- number that comes back is not a weak similarity, it is meaningless. And
-- because every model here is pinned to 1024 dimensions by the column type,
-- Postgres cannot object: `<=>` happily returns a plausible-looking float that
-- then takes 60% of the weight in the hybrid score.
--
-- This is not hypothetical. scripts/_verify-search-model-scope.mjs derives a
-- stage-B-only variant from this very file and measures it: a passage from a
-- different embedding space comes back scoring 1.0000, top of the results.
-- Today 056 is protected from that purely by accident — bug 1's filter throws
-- the passage away before stage C can score it. The mask and the trap are the
-- same line of SQL, which is why removing it is only safe together with the
-- guard below.
--
-- So the model check does not disappear, it MOVES to where it belongs: stage A
-- still only ever scans one model's vectors (an HNSW scan across spaces would
-- be nonsense), and stage C now only credits a vector score to a passage whose
-- embedding is in the query's space. Everything else scores on text alone,
-- which is exactly right — it is what we know about it.
--
-- Net effect: text search covers the whole matter always; vector search
-- contributes wherever it legitimately can. A re-tiered matter degrades
-- smoothly from hybrid to text-only and back again as its backfill proceeds,
-- with no window in which it silently returns nothing.
--
-- Nothing else about 056 changes: same signature, same defaults, same two-stage
-- shape, same indexes (no index is added or dropped here).

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
  v_k        int     := least(greatest(v_limit * 10, 200), 500);
  v_scan     int     := 20000;
begin
  v_has_text := v_tsq is not null and numnode(v_tsq) > 0;

  if v_has_vec then
    if exists (select 1 from pg_settings where name = 'hnsw.ef_search') then
      perform set_config('hnsw.ef_search', format('%s', greatest(v_k, 40)), true);
    end if;
    if exists (select 1 from pg_settings where name = 'hnsw.iterative_scan') then
      perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
    end if;
  end if;

  return query
  with ann as (
    -- Stage A (vector). Still strictly one embedding space: an HNSW scan that
    -- mixed models would be ranking noise, and the index cannot help across
    -- spaces anyway.
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
    -- Stage B (full-text). Model-agnostic on purpose — see Bug 1 above. This
    -- is the stage that must keep answering for a sealed or half-backfilled
    -- matter, so it looks at every passage in scope.
    select p.id, p.tsv
      from public.passages p
     where v_has_text
       and p.tsv @@ v_tsq
       and p.matterspace_id     = any(p_matterspace_ids)
       and p.summary_level      = p_summary_level
       and (p_witness_names is null or p.witness_name = any(p_witness_names))
       and (p_document_ids  is null or p.document_id  = any(p_document_ids))
       and (p_doc_types is null or exists (
             select 1 from public.documents d
              where d.id = p.document_id and d.doc_type = any(p_doc_types)))
     limit v_scan
  ),
  fts as (
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
      -- Only a passage in the QUERY'S space gets a vector score. A passage
      -- carrying some other model's vector scores 0 here and rides on its text
      -- rank — see Bug 2. Silence beats a confident wrong number.
      (case when v_has_vec and p.embedding is not null
             and p.embedding_model   = p_embedding_model
             and p.embedding_version = p_embedding_version
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
