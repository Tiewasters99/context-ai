-- Contextspaces Migration 074: stop semantic search timing out (SQLSTATE 57014)
-- on matters that are a small-to-middling fraction of the corpus.
--
-- This is the bug flagged in #56 and open since 2026-08-22: "search works" for
-- the largest matter and fails for several smaller ones, which is the opposite
-- of what anyone expects. It was never diagnosable from the repo, because the
-- answer is in the plans. Measured 2026-09-20 against production, read-only,
-- through the Management API — which connects as `postgres` and therefore with
-- RLS BYPASSED. The MCP connector does NOT: api/mcp.mjs builds its client from
-- the anon key with the user's JWT in the Authorization header (the service
-- key is used only to look up connector_tokens), so every search that reports
-- 57014 runs as `authenticated`, with the policy `can_access_matter
-- (matterspace_id)` evaluated per row on top of everything below. Every number
-- in this file is therefore a LOWER BOUND on what production pays. The one
-- piece of that overhead measurable read-only is the recursive ancestry walk
-- inside matter_role: 10,145 calls in 228 ms, ~0.02 ms each, and the
-- membership lookups sit on top of it. See the last note in this file.
--
-- What production actually looks like
-- ---------------------------------------------------------------------------
--   passages                     417,979 rows   6,386 MB total
--     heap                                        449 MB
--     TOAST                                     3,013 MB   <-- the whole story
--     idx_passages_embedding_hnsw               2,550 MB   valid, one global
--     idx_passages_tsv (GIN)                      318 MB   valid
--   documents                     46,294 rows      23 MB
--   statement_timeout   anon 3s · authenticated 8s · authenticator 8s
--                       (service_role sets none, so it inherits the 8s)
--   pgvector 0.8.0 · work_mem 3.5 MB · shared_buffers 256 MB
--
-- `passages.embedding` is vector(1024) = 4,096 bytes, with attstorage = 'e'
-- (EXTERNAL, out of line, uncompressed). Every 1024-dimension cosine computed
-- from the heap therefore costs a TOAST fetch.
--
-- The plan node that proves it
-- ---------------------------------------------------------------------------
-- `p_matterspace_ids` is a PARAMETER. PostgREST binds the array at call time,
-- so when stage A is planned the planner cannot see how many matters are in it
-- or how big they are — it falls back to a generic estimate. Reproduced with
-- an array the planner cannot see through, over the 10,145-passage matter
-- (2.4% of the corpus) that has been timing out since August:
--
--   Index Scan using idx_passages_embedding_hnsw on passages p
--         (cost=704.22..696300.16 rows=18324 width=24)
--     Order By: (embedding <=> probe.e)
--     Filter: ((embedding IS NOT NULL) AND (summary_level = 0)
--              AND (embedding_model = 'text-embedding-3-small')
--              AND (embedding_version = 1)
--              AND (matterspace_id = ANY ((InitPlan 3).col1)))
--
-- That `Filter:` line is the bug. The matter is not an index condition, it is
-- a post-filter applied to whatever the graph walk hands up, so pgvector has
-- to keep walking until 200 survivors fall out of a scope holding 1 row in 41.
-- Timed with ef_search 200 and 056's `hnsw.iterative_scan = relaxed_order`:
--
--   Nested Loop Semi Join (actual time=639.044..4308.302 rows=200)
--     Rows Removed by Join Filter: 2233
--     ->  Index Scan using idx_passages_embedding_hnsw (rows=2433)
--           Buffers: shared hit=8429 read=7363
--   Execution Time: 4463.539 ms
--
-- 2,433 index tuples for 200 candidates, at ~1.5 ms a tuple: a 2,550 MB graph
-- being walked at random against a 256 MB cache. And nothing bounds it.
-- `hnsw.max_scan_tuples` — pgvector's own stop — has never been set by any
-- migration, so it sits at its default of 20,000. 20,000 x 1.5 ms is 30
-- seconds. The 8-second timeout simply arrives first. That is the 57014.
--
-- The second failure mode, for the scopes where the planner DOES see through
-- the array or estimates large, is the other extreme: it leaves the HNSW index
-- alone and brute-forces the scope.
--
--   Sort  (actual time=1510.833..1510.861 rows=200)
--     Sort Key: ((p.embedding <=> probe.e))
--     Sort Method: top-N heapsort  Memory: 47kB
--     ->  Index Scan using idx_passages_embedding_version on passages p
--           (actual time=5.118..1505.416 rows=10145)
--           Buffers: shared hit=84360 read=12170
--
-- 96,530 buffers for 10,145 rows — 9.5 per row, which is exactly one
-- EXTERNAL-toasted vector each. That path is not merely linear, it degrades
-- faster than linear once the scope's vectors stop fitting beside everything
-- else in 256 MB of cache. Measured, same instance, same day:
--
--     10,145 passages    1,511 ms    96,530 buffers   0.149 ms/row
--     29,600 passages   12,902 ms   282,700 buffers   0.436 ms/row
--
-- so the two failure modes meet in the middle and there is no scope size at
-- which today's function is safe by accident.
--
-- pg_stat_statements is the production-side witness, and it was the only one
-- there ever was: the three hottest search_passages entries are 512 calls mean
-- 1362 ms max 7890 ms, 599 calls mean 879 ms max 7968 ms, 249 calls mean 498
-- ms max 7626 ms. Those maxima are the 8-second wall, hit over and over.
--
-- The largest matter escapes only by being large. At 24% selectivity the
-- post-filter throws away little, so the graph walk fills quickly and it
-- answers in about a second. That is why the corpus's biggest matter has
-- always been the fast one, and why the bug has read as random.
--
-- What does NOT fix it
-- ---------------------------------------------------------------------------
-- Turning the ANN scan up, which is what 056's `iterative_scan = relaxed_order`
-- was reaching for. On the 10,145-passage matter it is two and a half times
-- WORSE than brute force (4,463 ms against 1,708 ms, above). Iterative scan
-- makes the starved result complete; it does not make it cheap.
--
-- A new index does not fix it either, and 074 adds none — see the note at the
-- bottom, which also answers "what lock, how long, off-hours or not".
--
-- The fix: pick the cheaper plan on purpose, and bound both of them
-- ---------------------------------------------------------------------------
-- Neither access path is wrong; each is right over a different range, and the
-- range is knowable before the query runs. So stage A leaves the big CTE and
-- becomes its own statement, chosen by a measurement:
--
--   * Count the scope, bounded. An index-only scan on
--     idx_passages_matterspace_level with `limit v_exact_max + 1` — it can
--     never read more than that many index entries and never touches TOAST.
--     Measured over three matters totalling 145k passages: 6.5 ms, 56 buffers,
--     29 heap fetches, with RLS bypassed. Under `authenticated` the policy
--     rides along as a per-tuple filter, which is the ancestry cost noted at
--     the top; the count is then the number of passages the CALLER can see,
--     which is the right number to branch on anyway.
--
--   * Scope at or under the threshold -> EXACT scan. Brute force is not a
--     failure here, it is the right plan: exact top-K, no recall loss, and
--     bounded by construction. At the default 15,000 that is a few seconds at
--     the very top of the range — the same plan measured 1,511 ms and 2,542 ms
--     on one 10,145-passage matter an hour apart, so it is load-dependent, not
--     a constant — and the overwhelming majority of matters are nowhere near
--     the threshold: a 557-passage matter measures 112 ms.
--
--     The ORDER BY in this branch is deliberately `(...) + 0.0` so that the
--     HNSW index cannot match it as a pathkey. That is the whole fix for the
--     first failure mode: it is what stops the planner reaching for the ANN
--     path on a scope where the post-filter starves it. Adding 0.0 to a float8
--     distance changes no ordering; it only removes an index the planner must
--     not use here.
--
--   * Scope over the threshold -> ANN scan, with the scan explicitly capped.
--     Above ~5% selectivity the graph walk finds in-scope neighbours quickly.
--     Measured on a 29,600-passage matter (7.1%), ef_search 200, iterative
--     relaxed_order, max_scan_tuples capped:
--
--         Index Scan using idx_passages_embedding_hnsw
--           (actual time=727.767..803.263 rows=200)
--           Rows Removed by Filter: 40
--         Execution Time: 1012.628 ms
--
--     1.0 s and a full 200 candidates, against 12.9 s measured for the
--     brute-force plan on the same matter.
--
--     `hnsw.max_scan_tuples` is set here for the first time. Today the ANN
--     branch inherits pgvector's default of 20,000, which at the measured
--     cold cost is 30 s of walking — the unbounded worst case that has been
--     sitting under every search since 056. Capping it at 8 x v_k
--     (2,000-4,000) bounds the branch: it trades recall for an answer, which
--     on a read path is the right way round, and it can only ever bite on a
--     scope large enough that the walk was going to fill anyway.
--
-- Everything else is byte-for-byte 061: same signature, same ten arguments,
-- same fifteen result columns, same 0.4/0.6 blend, same stage B, same stage C,
-- same model scoping (stage A one space, stage C same-space only, stage B
-- model-agnostic). SECURITY INVOKER as before, so RLS still decides what the
-- caller may see in every stage.
--
-- Matter isolation is unchanged and unchangeable: `p.matterspace_id =
-- any(p_matterspace_ids)` is present in the scope count, in both stage-A
-- branches and in stage B. lib/mcp-core.mjs removes sealed and paused
-- descendants from that array before the call (PRs #181/#179), so anything it
-- removed is outside every stage of this function by construction.
--
-- Idempotent against drift: `create or replace` with an unchanged signature.
-- Applying it twice, or applying it to a database still on 056, leaves the
-- same function. It does not depend on 061 having been applied.
--
-- Verified by EXECUTION in PGlite with real pgvector:
--   node scripts/_verify-search-scope-router.mjs
--   node scripts/_verify-search-model-scope.mjs   (061's guarantees, still green)

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
  -- The crossover, in passages in scope. 15,000 is where the two measured
  -- costs meet on this instance: the exact scan runs 1.5 s at 10,145 rows and
  -- 12.9 s at 29,600 (cache pressure, not arithmetic), while the ANN branch
  -- runs 4.5 s at 2.4% selectivity and 1.0 s at 7.1%. Between them, around
  -- 15,000 rows / 3.6%, they cross at roughly 3 s. Settable without a
  -- migration —
  --   alter role authenticator set contextspaces.search_exact_max = '25000';
  -- — because the right number is a property of the instance, not of the code,
  -- and it will move when the corpus, the cache or the plan does.
  v_exact_max int := coalesce(
    nullif(current_setting('contextspaces.search_exact_max', true), '')::int,
    15000);
  -- How far the ANN branch may walk the graph before answering with what it
  -- has: 8 index tuples per candidate wanted, floor 2,000. At the measured
  -- ~1.5 ms a tuple on a cold cache that is a ceiling of about 3 s, against
  -- pgvector's unbounded 20,000-tuple default.
  v_scan_cap int := greatest(v_k * 8, 2000);
  v_scope    int;
  v_narrow   boolean;
  -- Stage A's output, computed before the main query instead of inside it.
  v_ann      uuid[] := '{}'::uuid[];
begin
  -- numnode() counts the lexemes: websearch_to_tsquery('') returns an empty
  -- tsquery rather than null, and an empty tsquery matches nothing, so an
  -- embedding-only search must not pay for stage B at all.
  v_has_text := v_tsq is not null and numnode(v_tsq) > 0;

  if v_has_vec then
    -- A caller that named documents or witnesses has already narrowed the
    -- scope to something small, and both predicates are post-filters the ANN
    -- index cannot use — they are exactly the shape that starves a graph walk.
    -- Those searches always take the exact branch, where
    -- idx_passages_document_seq / idx_passages_witness make them cheap.
    v_narrow := p_document_ids is not null or p_witness_names is not null;

    if v_narrow then
      v_scope := 0;
    else
      -- Bounded scope measurement. The LIMIT is inside the subquery, so this
      -- reads at most v_exact_max + 1 index entries whatever the corpus does,
      -- and it is an index-only scan on (matterspace_id, summary_level): no
      -- heap rows, no TOAST, no vectors.
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
      -- ---------------------------------------------------------------------
      -- Stage A, exact. Every vector in scope is compared; the answer is the
      -- true top-K, not an approximation. `+ 0.0` keeps the HNSW index out of
      -- the plan — see the header. `, p.id` only makes ties deterministic.
      -- ---------------------------------------------------------------------
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
                    where d.id = p.document_id and d.doc_type = any(p_doc_types)))
           order by (p.embedding <=> p_query_embedding) + 0.0, p.id
           limit v_k
        ) a;
    else
      -- ---------------------------------------------------------------------
      -- Stage A, approximate. The bare distance operator, which is the one
      -- shape idx_passages_embedding_hnsw can answer, over a scope large
      -- enough that the post-filter keeps most of what the walk finds.
      --
      -- Guarded by pg_settings lookups because pgvector reserves the "hnsw"
      -- GUC prefix: setting a parameter it does not define is an error, not a
      -- no-op. (The GUCs register when the extension's library loads, which
      -- the vector-typed argument to this function has already forced.)
      -- ---------------------------------------------------------------------
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
                    where d.id = p.document_id and d.doc_type = any(p_doc_types)))
           order by p.embedding <=> p_query_embedding
           limit v_k
        ) a;
    end if;
  end if;

  return query
  with fts_matches as (
    -- Stage B (full-text). Model-agnostic on purpose — 061's Bug 1. This is
    -- the stage that must keep answering for a sealed or half-backfilled
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
    -- Stage A's ids now arrive as an array rather than as a CTE. Same set,
    -- same union, same de-duplication.
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
      -- Only a passage in the QUERY'S space gets a vector score. A passage
      -- carrying some other model's vector scores 0 here and rides on its text
      -- rank — 061's Bug 2. Silence beats a confident wrong number.
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

-- Grants are unchanged from 012 (execute to public; RLS does the work).

-- ---------------------------------------------------------------------------
-- HOW TO APPLY THIS, AND WHAT IT LOCKS
-- ---------------------------------------------------------------------------
-- 074 creates no index and alters no table. It is one `create or replace
-- function`, which takes an ACCESS EXCLUSIVE lock on nothing but the pg_proc
-- row for search_passages and returns in milliseconds. Sessions already inside
-- a search finish on the old body; the next call gets the new one. There is no
-- rewrite, no reindex, no downtime and no off-hours requirement — paste it into
-- the SQL editor whenever it is convenient, including under load.
--
-- Deliberately no index, and why the obvious ones would not help:
--
--   * A partial HNSW index matching stage A's predicates
--     (embedding_model / embedding_version / summary_level) would index the
--     same 417,979 rows it does today: every vector in production is
--     text-embedding-3-small version 1 at summary_level 0. Same 2,550 MB, same
--     graph, no change to any plan. The 130 voyage-4 passages that exist carry
--     no embedding at all, so they are not in the index in the first place.
--   * No btree helps the exact branch. 84,360 of its 96,530 buffers are the
--     TOAST fetch of the vector itself, which an index cannot avoid.
--
-- The one index change that WOULD move the numbers is a half-precision copy
-- (`hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops)`, ~1.3 GB instead of
-- 2,550 MB, so far more of the graph stays in a 256 MB cache). It is not in
-- this migration because it is a different kind of change with a different
-- risk, and it must not be run the way this file is run. For the record, when
-- it is done:
--
--   * `create index concurrently` CANNOT run inside a transaction, which is
--     what both the Supabase SQL editor and the Management API wrap every
--     statement in. It has to be issued over a direct psql connection
--     (Project Settings -> Database -> Connection string, session mode) as the
--     only statement in that session.
--   * CONCURRENTLY takes SHARE UPDATE EXCLUSIVE on passages: reads and writes
--     continue, only DDL and VACUUM are blocked. Without CONCURRENTLY it takes
--     SHARE, which blocks every INSERT — i.e. it stops ingestion for the whole
--     build.
--   * Expect hours, not minutes, and watch it. The existing 2,550 MB HNSW over
--     the same 417,979 vectors is the yardstick, and maintenance_work_mem on
--     this instance is 64 MB, which is small for an HNSW build — raise it for
--     the session (`set maintenance_work_mem = '2GB';`) or the build spills.
--   * That one IS an off-hours job, run when the Fly worker is idle.
--
-- Not fixed by 074, recorded so it is not rediscovered:
--
--   * The matter-omitted search path in lib/mcp-core.mjs fans out
--     ceil(N/12) RPCs in parallel — 21 at today's 251 matters. 074 bounds each
--     one; it does not reduce the fan-out, and 21 concurrent searches on a
--     2-core instance still contend.
--   * Stage B's `limit v_scan` (20,000) with no ordering inside it takes an
--     arbitrary 20,000 of the matches before ranking. That is a recall
--     compromise inherited from 056. It is not the timeout — vector-only
--     searches, which never reach stage B, timed out too — so it is left
--     alone here.
--   * Per-row RLS, which the connector DOES pay. `can_access_matter ->
--     matter_role -> matter_ancestry` runs once per candidate row in the exact
--     branch and once per index entry in the scope probe. Only the recursive
--     ancestry walk is measurable without a session (10,145 calls, 228 ms,
--     50,966 buffers); the membership lookups are additive on top. It is
--     roughly 0.02-0.1 ms a row against the exact scan's measured 0.15-0.44,
--     so it worsens every number above without changing which branch wins —
--     but it is why the threshold is a GUC. If the exact branch runs long on
--     this instance, lower it before touching anything else:
--       alter role authenticated set contextspaces.search_exact_max = '10000';
--     The structural fix is a SECURITY DEFINER pre-check that validates the id
--     array ONCE per call instead of the policy re-deciding per row, wrapped
--     per docs/RLS invoker rule. That is its own change, not this one.
