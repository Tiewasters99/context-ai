-- 101_citation_resolvers.sql — the Brief Desk, slice D2: two resolvers
--
-- docs/specs/BRIEF-DESK-2026-09-26.md §3.4. Resolution is code, not a model:
-- a cite in a brief → the case document in the matter that it names, and a
-- pinpoint → the passage that carries that printed page. Both answers come
-- from metadata the ingest pass already writes (documents.metadata.westlaw_case
-- and passages.metadata); nothing here calls a model or reads storage.
--
--   document_citations          one row per reporter cite a case document
--                               carries, e.g. (…, 'F.3d', 143, 1219). Written
--                               at ingest (lib/ingest-core.mjs,
--                               upsertDocumentCitations) and, for what was
--                               indexed before 101, by
--                               scripts/backfill-document-citations.mjs.
--   resolve_citation(...)       → the documents in the matter (and the
--                               sub-matters the caller may read) that carry
--                               the cite. Zero rows = not in the corpus; two
--                               rows = two copies, the desk says "pick one".
--   passage_for_printed_page()  → the passage of one document on a printed
--                               page, with the basis and the caveat in words.
--
-- One column the spec's DDL does not show: `star_level`. The spec says the
-- reporter ordinal passage_for_printed_page takes "comes from which of the
-- document's document_citations rows matched", so the row must carry it.
-- A Westlaw download of a case with parallel reporters marks each reporter's
-- pages at its own star level (printed_page = level 1, star_pages "2"/"3"),
-- and which reporter a level belongs to is decided by page
-- (lib/bluebook.mjs levelsForReporters) — it is not recoverable from
-- documents.metadata alone. Null = no level could be tied to that reporter;
-- the resolver then says the pin is not known rather than reading level 1.
--
-- The shape, per feedback_rls_security_invoker_wrappers and 078/094:
--
--   public.resolve_citation / public.passage_for_printed_page   SECURITY INVOKER plpgsql
--     -> auth.uid() read ONCE at entry; no uid under RLS → no rows
--     -> the matter scope decided once per MATTER, as the caller:
--        matterspace_descendants(p_matter) (invoker: RLS on matterspaces),
--        each kept only if can_access_matter(id) and, at aal1, not sealed
--        (094's sealed_entry_allowed / effective_tier_is_sealed — the same
--        rule search_passages applies)
--     -> service_role / postgres (row_security_active false) pass through,
--        exactly as 078 arranged for search
--     -> delegate to
--   brief_internal.*_core                                        SECURITY DEFINER sql
--     -> only ever sees the authorized matter array / document
--
-- brief_internal is not a PostgREST-exposed schema, so the cores cannot be
-- called by name over HTTP. EXECUTE on them is granted to authenticated and
-- service_role only (the wrapper runs as the caller, so the caller must hold
-- it) and never to anon.
--
-- RLS on document_citations follows migration 100: read with the document,
-- write if you may write the document's matter (api/ingest.mjs indexes with
-- the uploader's session). The shared RLS helpers are not touched.
--
-- Depends on: 016 (can_access_matter, can_write_matter), 012
-- (matterspace_descendants), 081 (documents.category), 094
-- (sealed_entry_allowed, effective_tier_is_sealed). Idempotent: `if not
-- exists` and create-or-replace throughout; applying it twice leaves the same
-- objects. Adds no event kinds.
--
-- Verified by EXECUTION in PGlite with real roles and real RLS:
--   node --import ./scripts/_node-src-loader.mjs scripts/_verify-citation-resolvers.mjs

-- ============================================================================
-- 1. The table
-- ============================================================================
create table if not exists public.document_citations (
  document_id  uuid not null references public.documents(id) on delete cascade,
  reporter     text not null,                     -- as lib/bluebook.mjs normalizeReporter prints it ("F.3d", "N.Y.S.2d")
  volume       int  not null,
  page         int  not null,
  case_name    text,                              -- westlaw_case.case_name, lowercased
  star_level   int  check (star_level between 1 and 3),   -- which star level carries this reporter's pages
  primary key (document_id, reporter, volume, page)
);
create index if not exists document_citations_cite_idx
  on public.document_citations (reporter, volume, page);

alter table public.document_citations enable row level security;

drop policy if exists "Document citations visible with their document" on public.document_citations;
create policy "Document citations visible with their document"
  on public.document_citations for select
  using (exists (select 1 from public.documents d where d.id = document_citations.document_id));

drop policy if exists "Matter writers index a document's citations" on public.document_citations;
create policy "Matter writers index a document's citations"
  on public.document_citations for insert
  with check (exists (select 1 from public.documents d
                       where d.id = document_citations.document_id
                         and public.can_write_matter(d.matterspace_id)));

drop policy if exists "Matter writers re-index a document's citations" on public.document_citations;
create policy "Matter writers re-index a document's citations"
  on public.document_citations for delete
  using (exists (select 1 from public.documents d
                  where d.id = document_citations.document_id
                    and public.can_write_matter(d.matterspace_id)));
-- No UPDATE policy: a re-index deletes the document's rows and inserts them.

revoke all on public.document_citations from anon;
grant select, insert, delete on public.document_citations to authenticated;
grant all on public.document_citations to service_role;

-- ============================================================================
-- 2. A home for the cores that PostgREST does not serve
-- ============================================================================
create schema if not exists brief_internal;
revoke all on schema brief_internal from public;
grant usage on schema brief_internal to authenticated, service_role;

comment on schema brief_internal is
  'Private helpers for the Brief Desk resolvers. NOT a PostgREST-exposed '
  'schema, and must never be added to one: the functions here assume their '
  'arguments have already been authorized by their public wrapper.';

-- ============================================================================
-- 3. resolve_citation
-- ============================================================================
-- Reporter first. The name fallback runs ONLY when the caller has no reporter
-- cite (the parse failed: a WL cite, a slip opinion, a name alone). A reporter
-- cite that parsed and matched nothing is "not in the corpus"; answering it
-- with a same-named document would be a different case, or a guess.
--
-- The fallback's candidates: documents filed as cases (081 `category = 'case'`)
-- OR carrying a parsed Westlaw case header. The spec names only the category;
-- in production (probed 2026-09-26) 234 documents have it and 917 have the
-- header, so the category alone would miss three cases in four. Matching is on
-- words: lowercased, every run of non-alphanumerics one space, then equal, or
-- one containing the other when the shorter side is at least 8 characters.
create or replace function brief_internal.resolve_citation_core(
  p_matters   uuid[],
  p_reporter  text,
  p_volume    int,
  p_page      int,
  p_case_name text
)
returns table (
  document_id    uuid,
  title          text,
  how            text,
  matterspace_id uuid,
  reporter       text,
  volume         int,
  page           int,
  star_level     int,
  case_name      text
)
language sql
stable
security definer
set search_path = public
as $$
  with by_reporter as (
    select d.id as document_id, d.title, 'reporter'::text as how, d.matterspace_id,
           c.reporter, c.volume, c.page, c.star_level,
           coalesce(c.case_name, lower(d.metadata->'westlaw_case'->>'case_name')) as case_name
      from public.document_citations c
      join public.documents d on d.id = c.document_id
     where p_reporter is not null and p_volume is not null and p_page is not null
       and d.matterspace_id = any(p_matters)
       and c.volume = p_volume
       and c.page = p_page
       and replace(c.reporter, ' ', '') = replace(p_reporter, ' ', '')
  ),
  wanted as (
    select trim(regexp_replace(lower(p_case_name), '[^a-z0-9]+', ' ', 'g')) as n
     where (p_reporter is null or p_volume is null or p_page is null)
       and p_case_name is not null
  ),
  candidates as (
    select d.id, d.title, d.matterspace_id,
           lower(coalesce(nullif(d.metadata->'westlaw_case'->>'case_name', ''), d.title)) as case_name,
           trim(regexp_replace(lower(coalesce(nullif(d.metadata->'westlaw_case'->>'case_name', ''), d.title, '')),
                               '[^a-z0-9]+', ' ', 'g')) as n
      from public.documents d
     where d.matterspace_id = any(p_matters)
       and (d.category = 'case' or d.metadata->'westlaw_case'->>'kind' = 'case')
  ),
  by_name as (
    select c.id as document_id, c.title, 'name'::text as how, c.matterspace_id,
           null::text as reporter, null::int as volume, null::int as page, null::int as star_level,
           c.case_name,
           (c.n = w.n) as exact
      from candidates c, wanted w
     where char_length(w.n) > 0
       and (c.n = w.n
            or (least(char_length(c.n), char_length(w.n)) >= 8
                and (position(w.n in c.n) > 0 or position(c.n in w.n) > 0)))
  )
  select document_id, title, how, matterspace_id, reporter, volume, page, star_level, case_name
    from by_reporter
  union all
  select * from (
    select document_id, title, how, matterspace_id, reporter, volume, page, star_level, case_name
      from by_name
     order by exact desc, title
     limit 10
  ) n
$$;

revoke all on function brief_internal.resolve_citation_core(uuid[], text, int, int, text) from public;
grant execute on function brief_internal.resolve_citation_core(uuid[], text, int, int, text) to authenticated, service_role;

create or replace function public.resolve_citation(
  p_matter    uuid,
  p_reporter  text,
  p_volume    int,
  p_page      int,
  p_case_name text default null
)
returns table (
  document_id    uuid,
  title          text,
  how            text,
  matterspace_id uuid,
  reporter       text,
  volume         int,
  page           int,
  star_level     int,
  case_name      text
)
language plpgsql
stable
security invoker
as $fn$
#variable_conflict use_column
declare
  v_uid     uuid    := auth.uid();
  v_rls     boolean := row_security_active('public.documents');
  v_allowed uuid[];
  v_open    boolean;
begin
  if p_matter is null then
    return;
  end if;

  if not v_rls then
    select coalesce(array_agg(t.id), '{}'::uuid[])
      into v_allowed
      from public.matterspace_descendants(p_matter) t;
  elsif v_uid is null then
    return;
  else
    -- The scope check, once per matter, as the caller: the matter and every
    -- sub-matter beneath it that this person may read, less the sealed ones
    -- at aal1 (094). The same rule search_passages applies.
    v_open := public.sealed_entry_allowed();
    select coalesce(array_agg(t.id), '{}'::uuid[])
      into v_allowed
      from public.matterspace_descendants(p_matter) t
     where public.can_access_matter(t.id)
       and (v_open or not public.effective_tier_is_sealed(t.id));
  end if;

  if v_allowed is null or cardinality(v_allowed) = 0 then
    return;
  end if;

  return query
  select * from brief_internal.resolve_citation_core(v_allowed, p_reporter, p_volume, p_page, p_case_name);
end $fn$;

revoke all on function public.resolve_citation(uuid, text, int, int, text) from public, anon;
grant execute on function public.resolve_citation(uuid, text, int, int, text) to authenticated, service_role;

-- ============================================================================
-- 4. passage_for_printed_page
-- ============================================================================
-- Scans ONE document's summary_level = 0 passages (a few hundred rows; no
-- index on passages). p_reporter_ordinal is the star level from the matched
-- document_citations row: 1 reads printed_page..printed_page_end, 2 or 3
-- reads star_pages->'2' / '3' (a parallel reporter). The answer's basis:
--
--   printed             the pin is on this passage, level 1
--   parallel            the pin is on this passage, a parallel reporter's level
--   pin_not_found       this copy has star pages at that level, and the pin is
--                       not among them (a typo, or a page past the opinion);
--                       the first passage, with the range in the caveat.
--                       Not one of the spec's four: its §3.3 table needs
--                       "pin not found" as its own state.
--   pdf_index_declined  no star pages at that level, and the detector looked
--                       and declined (lib/cite-page.mjs Tier 2); first passage
--   unknown             nothing recorded; or no star level carries this
--                       reporter (ordinal null — a Supreme Court download
--                       marks the U.S. pages, not the S. Ct. or L. Ed. ones;
--                       a quarter of production's rows, probed 2026-09-26);
--                       first passage
--
-- The pdf_index_declined caveat is lib/cite-page.mjs PDF_INDEX_CAVEAT, word for
-- word; the harness holds the two to the same string.

-- One passage's page range at one star level, from its metadata: level 1 is
-- printed_page..printed_page_end, levels 2 and 3 are star_pages->'2'/'3'.
-- Numbers only; anything else is null.
create or replace function brief_internal.star_range(p_meta jsonb, p_level int)
returns int[]
language sql
immutable
set search_path = public
as $$
  select case
    when p_level = 1 and jsonb_typeof(p_meta->'printed_page') = 'number'
      then array[(p_meta->>'printed_page')::int,
                 coalesce(case when jsonb_typeof(p_meta->'printed_page_end') = 'number'
                               then (p_meta->>'printed_page_end')::int end,
                          (p_meta->>'printed_page')::int)]
    when p_level in (2, 3) and jsonb_typeof(p_meta->'star_pages'->(p_level::text)->0) = 'number'
      then array[(p_meta->'star_pages'->(p_level::text)->>0)::int,
                 coalesce(case when jsonb_typeof(p_meta->'star_pages'->(p_level::text)->1) = 'number'
                               then (p_meta->'star_pages'->(p_level::text)->>1)::int end,
                          (p_meta->'star_pages'->(p_level::text)->>0)::int)]
  end
$$;

revoke all on function brief_internal.star_range(jsonb, int) from public;
grant execute on function brief_internal.star_range(jsonb, int) to authenticated, service_role;

create or replace function brief_internal.passage_for_printed_page_core(
  p_document         uuid,
  p_page             int,
  p_reporter_ordinal int
)
returns table (
  passage_id       uuid,
  page_start       int,
  basis            text,
  caveat           text,
  printed_page     int,
  printed_page_end int
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
#variable_conflict use_column
declare
  v_level int := case when p_reporter_ordinal between 1 and 3 then p_reporter_ordinal end;
  v_basis text := case when p_reporter_ordinal = 1 then 'printed' else 'parallel' end;
  v_lo    int;
  v_hi    int;
  v_first record;
begin
  -- Reading order: sequence_number, then page.
  select p.id, p.page_start, p.metadata->>'page_source' as src
    into v_first
    from public.passages p
   where p.document_id = p_document and p.summary_level = 0
   order by p.sequence_number nulls last, p.page_start nulls last, p.id
   limit 1;
  if not found then
    return;   -- a document with no passages: nothing to open at
  end if;

  if v_level is null then
    return query select v_first.id, v_first.page_start, 'unknown'::text,
      'This copy does not mark this reporter''s pages — showing the first page'::text,
      null::int, null::int;
    return;
  end if;

  select min(r[1]), max(r[2]) into v_lo, v_hi
    from (select brief_internal.star_range(p.metadata, v_level) as r
            from public.passages p
           where p.document_id = p_document and p.summary_level = 0) s
   where r is not null;

  if v_lo is not null then
    -- The pin's passage; with no pin, where the reporter's pages begin.
    return query
    select s.id, s.page_start, v_basis, null::text, s.r[1], s.r[2]
      from (select p.id, p.page_start, p.sequence_number, brief_internal.star_range(p.metadata, v_level) as r
              from public.passages p
             where p.document_id = p_document and p.summary_level = 0) s
     where s.r is not null
       and (p_page is null or (s.r[1] <= p_page and s.r[2] >= p_page))
     order by s.sequence_number nulls last, s.page_start nulls last, s.id
     limit 1;
    if found then
      return;
    end if;
    return query select v_first.id, v_first.page_start, 'pin_not_found'::text,
      format('Page %s is not among this copy''s star pages (%s–%s) — showing the first page', p_page, v_lo, v_hi),
      null::int, null::int;
    return;
  end if;

  if v_first.src = 'pdf_index' then
    return query select v_first.id, v_first.page_start, 'pdf_index_declined'::text,
      'PDF page; the printed page was not confirmed'::text, null::int, null::int;
    return;
  end if;

  return query select v_first.id, v_first.page_start, 'unknown'::text,
    'No star pages in this copy — showing page 1'::text, null::int, null::int;
end $fn$;


revoke all on function brief_internal.passage_for_printed_page_core(uuid, int, int) from public;
grant execute on function brief_internal.passage_for_printed_page_core(uuid, int, int) to authenticated, service_role;

create or replace function public.passage_for_printed_page(
  p_document         uuid,
  p_page             int,
  p_reporter_ordinal int default 1
)
returns table (
  passage_id       uuid,
  page_start       int,
  basis            text,
  caveat           text,
  printed_page     int,
  printed_page_end int
)
language plpgsql
stable
security invoker
as $fn$
#variable_conflict use_column
declare
  v_uid    uuid    := auth.uid();
  v_rls    boolean := row_security_active('public.documents');
  v_matter uuid;
begin
  if p_document is null then
    return;
  end if;

  if v_rls then
    if v_uid is null then
      return;
    end if;
    -- The document as the caller sees it (documents' own policy applies),
    -- then the same once-per-matter check as resolve_citation.
    select d.matterspace_id into v_matter from public.documents d where d.id = p_document;
    if v_matter is null
       or not public.can_access_matter(v_matter)
       or (not public.sealed_entry_allowed() and public.effective_tier_is_sealed(v_matter)) then
      return;
    end if;
  end if;

  return query
  select * from brief_internal.passage_for_printed_page_core(p_document, p_page, p_reporter_ordinal);
end $fn$;

revoke all on function public.passage_for_printed_page(uuid, int, int) from public, anon;
grant execute on function public.passage_for_printed_page(uuid, int, int) to authenticated, service_role;
