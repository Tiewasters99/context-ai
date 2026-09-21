-- Contextspaces Migration 078: authorize the search ONCE per matter instead of
-- once per passage.
--
-- 074 is applied in production and works — for `postgres`. The hosted connector
-- still times out, because the connector is not `postgres`.
--
-- Who actually runs a connector search
-- ---------------------------------------------------------------------------
-- api/mcp.mjs resolves the bearer token with the service key and then builds
-- `userScopedClient`: the ANON key with a signed user JWT in the Authorization
-- header. Every search therefore runs as `authenticated`, with RLS on, against
-- an 8-second statement_timeout. `service_role` has rolbypassrls; the role that
-- does the searching does not.
--
-- Measured 2026-09-21, read-only, as the real role (SET LOCAL ROLE +
-- SET LOCAL request.jwt.claims inside a rolled-back transaction), on the
-- fictional demo tree — 2 matters, 16,704 passages, i.e. just over 074's
-- 15,000 threshold, so 074 selects its ANN branch:
--
--     as postgres      41 ms warm  /  53 ms warm  /  5,140 ms cold
--     as authenticated             3,055 ms WARM, 385,844 buffers
--
-- Sixty times slower for the same call, and that is the warm number. Cold, it
-- is the 57014 the connector reports.
--
-- Where it goes, and the node that proves it
-- ---------------------------------------------------------------------------
-- The policy on passages is `can_access_matter(matterspace_id)` — a SECURITY
-- DEFINER SQL function that calls matter_role, which walks matter_ancestry
-- recursively and then joins two membership tables. It is not leakproof, so
-- PostgreSQL must evaluate it as a security qual on every row the scan touches
-- and may not push it down into an index condition. Stage A, as authenticated:
--
--   Sort  (actual time=1153.769..1153.799 rows=200)
--     Sort Key: ((p.embedding <=> probe.e))
--     Sort Method: top-N heapsort  Memory: 48kB
--     ->  Index Scan using idx_passages_embedding_version on passages p
--           (actual time=0.581..1146.145 rows=16704)
--           Filter: ((embedding IS NOT NULL) AND (summary_level = 0)
--                    AND can_access_matter(matterspace_id))
--           Buffers: shared hit=242405
--
-- Two things at once, and the second is the worse one:
--
--   1. 16,704 calls of can_access_matter, ~0.05 ms and ~6 buffers each.
--   2. `idx_passages_embedding_hnsw` IS NOT IN THE PLAN. A non-leakproof
--      security qual cannot ride an ordered ANN index scan, so the planner
--      will not cost that path at all. 074's ANN branch — the branch this
--      scope was routed to, the branch measured at 1,013 ms — is unreachable
--      for the only role that runs the query. Under RLS both of 074's
--      branches collapse to the same brute force, with a recursive membership
--      walk stapled to every row.
--
-- 074's scope probe pays it too. The bounded index-only count that measures
-- 6.5 ms as postgres:
--
--   Index Only Scan using idx_passages_matterspace_level on passages p
--         (actual time=2.776..756.894 rows=15001)
--     Filter: can_access_matter(matterspace_id)
--     Heap Fetches: 0
--     Buffers: shared hit=90576
--   Execution Time: 763.240 ms
--
-- 763 ms to decide which branch to take. Probe 763 + stage A 1,157 + stages
-- B and C ~= the 3,055 ms above.
--
-- Why this is safe to fix, exactly
-- ---------------------------------------------------------------------------
-- The policy expression is `can_access_matter(matterspace_id)` — a pure
-- function of ONE column. Every stage of search_passages already carries
-- `p.matterspace_id = any(p_matterspace_ids)`. So the set of rows the policy
-- admits is determined entirely by which members of p_matterspace_ids are
-- accessible: evaluating the policy once per ARRAY ELEMENT gives the identical
-- row set to evaluating it once per PASSAGE. It is the same predicate, applied
-- where it has 2 distinct inputs instead of 16,704 duplicate ones.
--
-- That is the whole of 078. Not a relaxation of the rule — the same rule,
-- evaluated at the only granularity at which it can differ.
--
-- The shape
-- ---------------------------------------------------------------------------
--   public.search_passages(...)                SECURITY INVOKER  (unchanged)
--     -> captures auth.uid() at entry
--     -> reduces p_matterspace_ids to the accessible subset, one
--        can_access_matter call per matter, in the INVOKER context
--     -> returns nothing at all if the subset is empty
--     -> delegates to
--   search_internal.search_passages_core(...)  SECURITY DEFINER
--     -> 074's body verbatim, now with no per-row policy to evaluate
--
-- Per feedback_rls_security_invoker_wrappers.md: the rule there is that a
-- POLICY expression must never call a SECURITY DEFINER + STABLE SQL function
-- directly, because auth.uid() misbehaves in that nesting. This is not a
-- policy expression, it is an RPC body — the invocation path that memo
-- records as the reliable one — and the wrapper still follows the pattern it
-- prescribes: auth.uid() is read ONCE, at function entry, into a declared
-- variable, and a context in which it is unavailable returns zero rows rather
-- than falling open.
--
-- The core lives in its own schema on purpose. `search_internal` is not in
-- PostgREST's exposed schemas, so `POST /rest/v1/rpc/search_passages_core`
-- does not exist and cannot be made to exist by guessing a name. EXECUTE is
-- granted to `authenticated` and `service_role` only — the wrapper runs as the
-- caller, so the caller must hold it — and deliberately NOT to `anon`, which
-- can never reach the core anyway because the wrapper returns first. If a
-- future edit ever removed that early return, anon would get a permission
-- error, not somebody's documents.
--
-- What does not change
-- ---------------------------------------------------------------------------
-- public.search_passages keeps its name, its ten arguments in the same order
-- with the same defaults, its fifteen result columns, and its grants. No
-- caller changes. lib/mcp-core.mjs still removes sealed and paused descendants
-- from the array before the call (PRs #181/#179), and the wrapper only ever
-- REMOVES ids from that array — never adds one — so every exclusion the caller
-- applied still holds, and so does every exclusion RLS applied.
--
-- Callers that bypass RLS today keep bypassing it: `row_security_active` is
-- false for service_role and postgres, and the wrapper then passes the array
-- through untouched. scripts/tools.mjs and the live harnesses are unaffected.
--
-- Idempotent against drift: create-or-replace throughout, unchanged signature,
-- `create schema if not exists`. Applying it twice leaves the same objects.
-- Rollback is re-pasting 074 (the wrapper is replaced by 074's body; the core
-- becomes unreferenced and harmless).
--
-- Verified by EXECUTION in PGlite with real pgvector, RLS enabled and the real
-- policy installed:  node scripts/_verify-search-rls-authorize.mjs

-- ---------------------------------------------------------------------------
-- 1. A home for the core that PostgREST does not serve.
-- ---------------------------------------------------------------------------
create schema if not exists search_internal;
revoke all on schema search_internal from public;
grant usage on schema search_internal to authenticated, service_role;

comment on schema search_internal is
  'Private helpers for search. NOT a PostgREST-exposed schema, and must never '
  'be added to one: the functions here assume their arguments have already '
  'been authorized by their public wrapper.';

-- ---------------------------------------------------------------------------
-- 2. The core: migration 074's body, unchanged except that the documents join
--    is now constrained to the same matter array as everything else.
--
--    SECURITY DEFINER, owned by postgres, which owns public.passages and
--    public.documents; neither table has FORCE ROW LEVEL SECURITY, so the
--    policies do not run here. That is the point, and it is why this function
--    is only safe when p_matterspace_ids is already the authorized subset.
-- ---------------------------------------------------------------------------
create or replace function search_internal.search_passages_core(
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
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_tsq      tsquery := websearch_to_tsquery('english', coalesce(p_query_text, ''));
  v_has_text boolean;
  v_has_vec  boolean := p_query_embedding is not null;
  v_limit    int     := greatest(coalesce(p_limit, 20), 1);
  v_k        int     := least(greatest(v_limit * 10, 200), 500);
  v_scan     int     := 20000;
  v_exact_max int := coalesce(
    nullif(current_setting('contextspaces.search_exact_max', true), '')::int,
    15000);
  v_scan_cap int := greatest(v_k * 8, 2000);
  v_scope    int;
  v_narrow   boolean;
  v_ann      uuid[] := '{}'::uuid[];
begin
  v_has_text := v_tsq is not null and numnode(v_tsq) > 0;

  if v_has_vec then
    v_narrow := p_document_ids is not null or p_witness_names is not null;

    if v_narrow then
      v_scope := 0;
    else
      -- 074's bounded scope probe. With no policy riding the index-only scan
      -- this is the 6.5 ms it was measured at, not 763 ms.
      select count(*) into v_scope
        from (
          select 1
            from public.passages p
           where p.matterspace_id = any(p_matterspace_ids)
             and p.summary_level  = p_summary_level
           limit v_exact_max + 1
        ) probe;
    end if;

    if v_scope <= v_exact_max then
      -- Stage A, exact. `+ 0.0` keeps the HNSW index out of the plan; see 074.
      select coalesce(array_agg(a.id), '{}'::uuid[]) into v_ann
        from (
          select p.id
            from public.passages p
           where p.embedding is not null
             and p.matterspace_id     = any(p_matterspace_ids)
             and p.summary_level      = p_summary_level
             and p.embedding_model    = p_embedding_model
             and p.embedding_version  = p_embedding_version
             and (p_witness_names is null or p.witness_name = any(p_witness_names))
             and (p_document_ids  is null or p.document_id  = any(p_document_ids))
             and (p_doc_types is null or exists (
                   select 1 from public.documents d
                    where d.id = p.document_id
                      and d.matterspace_id = any(p_matterspace_ids)
                      and d.doc_type = any(p_doc_types)))
           order by (p.embedding <=> p_query_embedding) + 0.0, p.id
           limit v_k
        ) a;
    else
      -- Stage A, approximate. Reachable again: with the security qual gone the
      -- planner can cost the ordered HNSW scan, which is what 074 measured at
      -- 1,013 ms on a scope this size.
      if exists (select 1 from pg_settings where name = 'hnsw.ef_search') then
        perform set_config('hnsw.ef_search', format('%s', greatest(v_k, 40)), true);
      end if;
      if exists (select 1 from pg_settings where name = 'hnsw.iterative_scan') then
        perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
      end if;
      if exists (select 1 from pg_settings where name = 'hnsw.max_scan_tuples') then
        perform set_config('hnsw.max_scan_tuples', format('%s', v_scan_cap), true);
      end if;

      select coalesce(array_agg(a.id), '{}'::uuid[]) into v_ann
        from (
          select p.id
            from public.passages p
           where p.embedding is not null
             and p.matterspace_id     = any(p_matterspace_ids)
             and p.summary_level      = p_summary_level
             and p.embedding_model    = p_embedding_model
             and p.embedding_version  = p_embedding_version
             and (p_witness_names is null or p.witness_name = any(p_witness_names))
             and (p_document_ids  is null or p.document_id  = any(p_document_ids))
             and (p_doc_types is null or exists (
                   select 1 from public.documents d
                    where d.id = p.document_id
                      and d.matterspace_id = any(p_matterspace_ids)
                      and d.doc_type = any(p_doc_types)))
           order by p.embedding <=> p_query_embedding
           limit v_k
        ) a;
    end if;
  end if;

  return query
  with fts_matches as (
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
              where d.id = p.document_id
                and d.matterspace_id = any(p_matterspace_ids)
                and d.doc_type = any(p_doc_types)))
     limit v_scan
  ),
  fts as (
    select m.id
      from fts_matches m
     order by ts_rank(m.tsv, v_tsq) desc
     limit v_k
  ),
  candidates as (
    select a.id from unnest(v_ann) as a(id)
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
      (case when v_has_vec and p.embedding is not null
             and p.embedding_model   = p_embedding_model
             and p.embedding_version = p_embedding_version
            then 1 - (p.embedding <=> p_query_embedding)
            else 0 end)::real as vector_score
      from candidates c
      join public.passages  p on p.id = c.id
      -- The matter guard on the join is new in 078 and it is load-bearing:
      -- inside a SECURITY DEFINER function the documents policy no longer runs,
      -- so this is what keeps a title from outside the authorized array out of
      -- the result if a passage and its document ever disagree about which
      -- matter they are in. Zero rows disagree in production today; that is a
      -- fact about today, not a contract.
      join public.documents d on d.id = p.document_id
                             and d.matterspace_id = any(p_matterspace_ids)
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

revoke all on function search_internal.search_passages_core(
  uuid[], text, vector, text[], text[], uuid[], int, int, text, int) from public;
grant execute on function search_internal.search_passages_core(
  uuid[], text, vector, text[], text[], uuid[], int, int, text, int)
  to authenticated, service_role;

comment on function search_internal.search_passages_core(
  uuid[], text, vector, text[], text[], uuid[], int, int, text, int) is
  'NEVER call this directly. It is SECURITY DEFINER and performs NO access '
  'check: p_matterspace_ids must already be the subset the caller may read. '
  'The only supported caller is public.search_passages, which does that '
  'reduction. Do not add search_internal to PostgREST''s exposed schemas.';

-- ---------------------------------------------------------------------------
-- 3. The wrapper: same name, same signature, same grants, SECURITY INVOKER.
--    All it does is decide which matters the caller may read, and stop early
--    if that is none of them.
-- ---------------------------------------------------------------------------
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
#variable_conflict use_column
declare
  -- Read ONCE, at entry, into a declared variable — the pattern
  -- feedback_rls_security_invoker_wrappers.md prescribes. Everything below
  -- keys off this value, and a context that cannot produce it returns nothing.
  v_uid     uuid    := auth.uid();
  -- True exactly when the policies would have run for this caller. It is false
  -- for service_role and postgres, which have rolbypassrls, and asking the
  -- question this way means 078 cannot accidentally start enforcing RLS on a
  -- caller that was never subject to it.
  v_rls     boolean := row_security_active('public.passages');
  v_allowed uuid[];
begin
  if not v_rls then
    v_allowed := p_matterspace_ids;
  elsif v_uid is null then
    -- anon, or a JWT carrying no subject. Nothing is accessible, and the core
    -- is not called at all.
    return;
  else
    -- One call per MATTER. can_access_matter stays the single source of truth
    -- for what "may read" means — this migration changes where that question
    -- is asked, never what the answer is.
    select coalesce(array_agg(m.id), '{}'::uuid[])
      into v_allowed
      from unnest(coalesce(p_matterspace_ids, '{}'::uuid[])) as m(id)
     where public.can_access_matter(m.id);
  end if;

  if v_allowed is null or cardinality(v_allowed) = 0 then
    return;
  end if;

  return query
  select *
    from search_internal.search_passages_core(
      v_allowed,
      p_query_text,
      p_query_embedding,
      p_doc_types,
      p_witness_names,
      p_document_ids,
      p_summary_level,
      p_limit,
      p_embedding_model,
      p_embedding_version);
end $$;

-- Grants on public.search_passages are unchanged from 012 (execute to public).

-- ---------------------------------------------------------------------------
-- APPLYING THIS
-- ---------------------------------------------------------------------------
-- One `create schema if not exists`, two `create or replace function`, three
-- grants and two comments. No table is touched, no index is built, nothing is
-- rewritten, nothing is locked beyond the pg_proc rows for the two functions.
-- It returns in milliseconds and can be pasted under load, at any hour.
--
-- Sessions mid-search finish on the old body. The next call gets the new one.
-- PostgREST needs no schema reload — public.search_passages keeps the exact
-- signature it already advertises — but `notify pgrst, 'reload schema';` is
-- harmless if pasted out of habit.
--
-- Rollback: re-paste 074_search_scope_aware_ann.sql. That restores the old
-- body of public.search_passages; search_internal.search_passages_core is then
-- simply unreferenced.
--
-- Still open, and NOT fixed by 078
-- ---------------------------------------------------------------------------
--   * The cold first hit. 5,140 ms as postgres on a tree this size, against
--     41-53 ms warm, is the 2,550 MB HNSW index being paged in after the
--     instance has been idle. 078 does not change it and no function can:
--     shared_buffers is 256 MB, so the graph cannot live in cache. The honest
--     mitigations are operational — pg_prewarm (not installed; and with 256 MB
--     of cache the useful mode is 'prefetch'/'read' into the OS page cache,
--     not 'buffer'), a pg_cron warm-up, or simply one throwaway search a
--     minute before a demo. Recommended, not built.
--   * The matter-omitted path in lib/mcp-core.mjs still fans out ceil(N/12)
--     RPCs in parallel. Each is now cheap; the fan-out is unchanged.
--   * Stage B's `limit v_scan` still takes an arbitrary 20,000 matches before
--     ranking — inherited from 056, unrelated to this.
