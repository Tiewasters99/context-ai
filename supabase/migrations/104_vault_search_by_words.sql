-- 104_vault_search_by_words.sql — the Vault finds a document by its words.
--
-- Symptom (Eden, 10-01): "Verified Petition v. 18" found nothing, though the
-- document was filed, ready, and on the sidebar. Its name is
-- "Bushell-Verified-Petition-Art78-v18-FILING". 081's search matched the
-- query as ONE literal substring, and filenames spell spaces as hyphens,
-- underscores and dots: "verified petition" is not a substring of
-- "verified-petition", and "v. 18" is not a substring of "v18".
--
-- The rule now: the query is split on everything that is not a letter or a
-- digit, and EVERY word must appear somewhere in the filename or the title,
-- in any order. A literal substring hit is always also a word hit, so nothing
-- 081 found is lost; this only adds recall. The Brief Desk's picker got the
-- same rule client-side in PR #334.
--
-- What changes: ONLY the recall predicate of vault_internal.search_documents_core.
-- What does not: the signature, the returned columns, the ranking tiers, the
-- under-three-characters prefix branch, the clamps, the sealed flag, the
-- grants, and public.search_documents (the INVOKER gate, last written by 094)
-- — the gate is untouched, so isolation is exactly what it was.
--
-- Cost. Measured 10-01 on the live table (47,025 documents): the all-words
-- filter as a sequential scan over EVERY document took 84 ms. The core is
-- always scoped to the caller's matters, so real calls see less. The longest
-- word (three characters or more) is also tested against 081's trigram
-- expression, verbatim, so idx_documents_name_trgm can narrow the candidates
-- before the per-word test runs.
--
-- Write/DDL: catalog-only (one CREATE OR REPLACE FUNCTION). No table lock
-- beyond the function's own catalog row; safe to paste at any hour.
--
-- ROLLBACK: re-run section 7 of 081_vault_document_search_and_category.sql
-- (the `create or replace function vault_internal.search_documents_core`
-- statement through its `end $$;`).

set lock_timeout = '10s';
set search_path = public, extensions;

create or replace function vault_internal.search_documents_core(
  p_matterspace_ids uuid[],
  p_query text,
  p_categories text[] default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit int default 20,
  p_offset int default 0
)
returns table (
  document_id uuid,
  title text,
  source_filename text,
  matterspace_id uuid,
  matterspace_name text,
  category text,
  doc_type text,
  processing_status text,
  page_count int,
  file_size_bytes bigint,
  created_at timestamptz,
  updated_at timestamptz,
  sealed boolean,
  rank real
)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
#variable_conflict use_column
declare
  v_limit  int  := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset int  := least(greatest(coalesce(p_offset, 0), 0), 10000);
  v_q      text := lower(btrim(coalesce(p_query, '')));
  -- LIKE metacharacters in a name the person typed are literal characters, not
  -- wildcards. Backslash first, or it escapes the escapes.
  v_esc    text := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  v_short  boolean := length(v_q) > 0 and length(v_q) < 3;
  -- The words: letters and digits only, so none of them can carry a LIKE
  -- wildcard ([:alnum:] excludes the underscore) and none needs escaping.
  v_words  text[] := array(
    select w from regexp_split_to_table(v_q, '[^[:alnum:]]+') w where w <> '');
  -- The longest word of three characters or more, for the trigram index.
  v_lead   text := (
    select w from unnest(v_words) w where length(w) >= 3
     order by length(w) desc, w limit 1);
  v_pats   text[];
begin
  v_pats := array(select '%' || w || '%' from unnest(v_words) w);

  return query
  with hits as (
    select
      d.id,
      d.title,
      d.source_filename,
      d.matterspace_id,
      d.category,
      d.doc_type,
      d.processing_status,
      d.page_count,
      d.file_size_bytes,
      d.created_at,
      d.updated_at,
      d.sort_key,
      lower(coalesce(d.source_filename, '') || ' ' || coalesce(d.title, '')) as hay
      from public.documents d
     where d.matterspace_id = any(p_matterspace_ids)
       and (p_categories is null or d.category = any(p_categories))
       and (p_from is null or d.created_at >= p_from)
       and (p_to   is null or d.created_at <  p_to)
       and (
             v_q = ''
          or (v_short and d.sort_key like v_esc || '%' escape '\')
          -- A query of punctuation only has no words: keep 081's literal test.
          or (not v_short and cardinality(v_words) = 0
              and (coalesce(d.source_filename, '') || ' ' || coalesce(d.title, ''))
                  ilike '%' || v_esc || '%' escape '\')
          or (not v_short and cardinality(v_words) > 0
              -- 081's indexed expression, verbatim, so the trigram GIN applies.
              and (v_lead is null
                   or (coalesce(d.source_filename, '') || ' ' || coalesce(d.title, ''))
                      ilike '%' || v_lead || '%')
              and lower(coalesce(d.source_filename, '') || ' ' || coalesce(d.title, ''))
                  like all (v_pats))
       )
  ),
  ranked as (
    select
      h.*,
      (case
         when v_q = '' then 0.0
         when h.sort_key = v_q or lower(coalesce(h.source_filename, h.title, '')) = v_q then 4.0
         when h.sort_key like v_esc || '%' escape '\'
          and (length(h.sort_key) = length(v_q)
               or substring(h.sort_key from length(v_q) + 1 for 1) !~ '[a-z0-9]') then 3.0
         when h.sort_key like v_esc || '%' escape '\' then 2.0
         else 1.0
       end)::real
      + (case when v_q = '' then 0.0 else similarity(h.sort_key, v_q) end)::real
        as rank
      from hits h
  )
  select
    r.id,
    r.title,
    r.source_filename,
    r.matterspace_id,
    m.name,
    r.category,
    r.doc_type,
    r.processing_status,
    r.page_count,
    r.file_size_bytes,
    r.created_at,
    r.updated_at,
    -- The seal inherits downward, so the question is about the whole ancestry,
    -- not the matter's own tier. Evaluated on the page being returned only —
    -- at most 100 rows — never on the candidate set.
    exists (
      select 1
        from public.matter_ancestry(r.matterspace_id) a
        join public.matterspaces am on am.id = a.id
       where am.ai_tier is distinct from 'A'
    ),
    r.rank
    from ranked r
    join public.matterspaces m on m.id = r.matterspace_id
   order by r.rank desc, r.sort_key, r.id
   limit v_limit offset v_offset;
end $$;

-- CREATE OR REPLACE keeps the owner, grants and comment 081 set; restated so
-- this file stands on its own.
revoke all on function vault_internal.search_documents_core(
  uuid[], text, text[], timestamptz, timestamptz, int, int) from public;
grant execute on function vault_internal.search_documents_core(
  uuid[], text, text[], timestamptz, timestamptz, int, int)
  to authenticated, service_role;
