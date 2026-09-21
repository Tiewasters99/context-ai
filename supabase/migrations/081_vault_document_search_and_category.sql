-- Contextspaces Migration 081: finding ONE document by name, and putting a
-- matter in an order a reviewing attorney reads in.
--
-- The problem, stated plainly
-- ---------------------------------------------------------------------------
-- A matter here holds 7,600 documents. There is no way to find one of them by
-- NAME. `search_passages` (002 → 012 → 056 → 061 → 074 → 078) is a different
-- question entirely: it finds a *passage inside* a document, it needs an
-- embedding, and it is scoped to one matter tree. Asking it "where is the
-- Watson case?" is asking a concordance for a shelf mark.
--
-- The Vault's own list has a filter box, but it filters rows the browser has
-- already loaded, in ONE matter tree, in upload order. Across matters there is
-- nothing at all. So: a document-level search — title, filename, category,
-- date, matter — across every matter the caller may open; and a category on
-- the document so a matter can be read in Table-of-Authorities order instead
-- of upload order.
--
-- NOTHING here touches passage search. `public.search_passages` and
-- `search_internal.*` are not referenced, not replaced and not read by this
-- file. It is a different question with a different answer.
--
-- The shape (and why it is 078's shape)
-- ---------------------------------------------------------------------------
-- The policy on `documents` is `can_access_matter(matterspace_id)` — the same
-- non-leakproof SECURITY DEFINER function whose per-row evaluation 078 removed
-- from passage search. A trigram search that has to run a recursive membership
-- walk on every candidate row is the same mistake in a new table. So the same
-- shape, and for the same reason:
--
--   public.search_documents(...)               SECURITY INVOKER
--     -> reads auth.uid() ONCE, at entry
--     -> reduces the scope to the matters this caller may read, ONE
--        can_access_matter call per MATTER (hundreds), not per DOCUMENT
--        (tens of thousands)
--     -> returns nothing at all if that set is empty
--     -> delegates to
--   vault_internal.search_documents_core(...)  SECURITY DEFINER
--     -> the bounded query, with no per-row policy left to evaluate
--
-- Per feedback_rls_security_invoker_wrappers.md: this is an RPC body, not a
-- policy expression; auth.uid() is read once into a declared variable at entry,
-- and a context that cannot produce it returns zero rows rather than falling
-- open. `vault_internal` is a NEW private schema — deliberately not
-- `search_internal`, which belongs to passage search — and it is not in
-- PostgREST's exposed schemas, so its functions have no REST endpoint.
--
-- What the search returns, and what it never returns
-- ---------------------------------------------------------------------------
-- Ids, titles, filenames, the matter, the category, the dates, the size, the
-- page count, the processing status, and a rank. It does NOT return passage
-- text, document text, or any body content — there is no column here that
-- could. That is what makes the sealed-matter answer below the same answer the
-- app already gives everywhere else.
--
-- Sealed matters (SecureSpace, migration 051)
-- ---------------------------------------------------------------------------
-- INCLUDED, and flagged. This matches what the app does today for the person
-- whose matters they are:
--   * the sidebar lists a sealed matter with a lock badge (Sidebar.tsx);
--   * the Vault's file list lists a sealed matter's documents unchanged;
--   * the in-app content search searches them — `lib/mcp-core.mjs` prunes
--     sealed matters only when `opts.sealConnector` is true, which ONLY
--     `api/mcp.mjs` sets. In the app a mixed scope is split and the sealed
--     group is searched TEXT-ONLY.
-- This search is text-only by construction and reaches no provider, so it is
-- the sealed group's half of that rule with nothing else attached. Every row
-- carries `sealed`, computed server-side from the matter's own ancestry, so
-- the surface can say so rather than the client guessing from a tree it may
-- not hold in full. (The 2026-09-09 spec said "sealed excluded". That predates
-- the in-app/connector split; excluding them would now make this the only
-- in-app list that hides a person's own matters from them.)
--
-- Categories
-- ---------------------------------------------------------------------------
-- `documents.category`, in the order a Table of Authorities is read:
-- case, statute, rule, secondary, pleading, supporting, other. Assignment is
-- DETERMINISTIC — a pure function of the title and the filename, written here
-- in SQL and nowhere else. No model is called by this migration or by the
-- feature it serves. `category_source` records who decided ('rule' or 'user'),
-- and a value a person set is NEVER overwritten: the organize pass excludes
-- `category_source = 'user'` in its WHERE clause, so a re-run cannot reach it.
--
-- Why the rule lives in SQL rather than in lib/document-category.mjs (which is
-- where the spec put it): organizing a 7,600-document matter is then ONE
-- statement that touches only the rows whose answer changes, instead of 7,600
-- round trips. Deterministic first, and deterministic in the place where the
-- rows already are.
--
-- Verified by EXECUTION in PGlite: node scripts/_verify-vault-document-search.mjs

-- ---------------------------------------------------------------------------
-- HOW TO APPLY THIS — read before pasting
-- ---------------------------------------------------------------------------
-- Section 4 adds five columns to `public.documents`, two of them STORED
-- GENERATED. A stored generated column REWRITES THE TABLE and holds ACCESS
-- EXCLUSIVE while it does. On this deployment `documents` is tens of thousands
-- of short rows, so the rewrite itself is seconds — but the ALTER must first
-- get the lock, and while it waits every reader queues BEHIND it. The
-- `set lock_timeout` on the first line is what keeps a busy minute from
-- becoming a stalled site: if the lock is not free within ten seconds the
-- whole paste fails cleanly, changes nothing, and can be pasted again when the
-- ingest worker is quiet.
--
-- Section 8 builds four indexes, one of them a trigram GIN. They are built
-- WITHOUT `concurrently`, on purpose: `CREATE INDEX CONCURRENTLY` cannot run
-- inside a transaction block, and the Supabase SQL editor wraps a pasted file
-- in exactly one. A plain build takes SHARE (readers continue, writes to
-- `documents` queue) and on a table this size finishes in about a second. If
-- this table is ever an order of magnitude larger, split the CREATE INDEX
-- statements out of the file and run each one on its own, outside a
-- transaction, with `concurrently` added.
--
-- Everything else — the schema, the functions, the trigger, the grants — is
-- create-or-replace and returns in milliseconds.
--
-- ORDER: the application code MERGES FIRST and this file is pasted whenever is
-- convenient. Nothing regresses in between. The Vault's default list read is
-- byte-for-byte the request it makes today (it does not select or order by any
-- column added here); the A–Z and Category views ask for the new columns, get
-- a 400 while they do not exist, and fall back to the date list with one line
-- saying so; the search box gets a 404 from PostgREST and says "Search arrives
-- with migration 081." Applying the file turns all three on with no deploy.
--
-- ROLLBACK: `drop function public.search_documents(...) cascade;` and the
-- matching organize/category functions, then `drop schema vault_internal
-- cascade;`. The columns and indexes are additive and can be left in place;
-- nothing outside this feature reads them.

set lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- 1. Extension.
--
-- `pg_trgm` is ALREADY enabled: migration 001/002 create it (002, line 12), so
-- on this deployment the statement below is a no-op. It is here for a database
-- restored from a dump that dropped extensions, and for PGlite, where the
-- harness starts from nothing. If this line ever actually CREATES the
-- extension on production, that is a fact worth knowing — it means 002 did not
-- fully apply, and the trigram index in section 8 is the first thing that
-- depends on it.
-- ---------------------------------------------------------------------------
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- 2. A private home for the SECURITY DEFINER half.
--
-- NOT `search_internal` — that schema belongs to passage search and this file
-- must not reach into it. Same contract, its own room.
-- ---------------------------------------------------------------------------
create schema if not exists vault_internal;
revoke all on schema vault_internal from public;
grant usage on schema vault_internal to authenticated, service_role;

comment on schema vault_internal is
  'Private helpers for the Vault''s document search and organize pass. NOT a '
  'PostgREST-exposed schema, and must never be added to one: the functions '
  'here assume their matter array has already been authorized by their public '
  'wrapper.';

-- ---------------------------------------------------------------------------
-- 3. The two pure functions the columns are generated from.
--
-- Both are IMMUTABLE because a STORED generated column requires it. That has a
-- consequence worth writing down: the stored values are computed ONCE, at
-- write time. `create or replace` on either function below does NOT recompute
-- what is already stored. Changing a rule means a backfill —
--   alter table public.documents alter column sort_key drop expression;
--   alter table public.documents drop column sort_key;
-- then re-run section 4. Treat these two bodies as versioned.
-- ---------------------------------------------------------------------------

-- The A–Z key. Not the title: the title. A reviewing attorney looks for
-- "Watson", and the row is called "2026-09-08 04 - Watson v Long Island RCo.pdf".
--
--   * drop a known file extension (a KNOWN list, never `\.\w+$` — that would
--     turn "Watson v. Long Island R.Co" into "Watson v. Long Island R");
--   * drop a leading date (2026-09-08, 09.08.26) and/or a leading list index
--     ("04 - ", "12. ");
--   * drop a leading article and "In re" — a shelf does not file under "The";
--   * collapse whitespace and punctuation runs, lower-case, trim.
--
-- Everything after the first word is left alone: "Glasstech Inc v Freund"
-- still sorts under G, and the reporter cite after the comma travels with it.
create or replace function public.document_sort_key(p_name text)
returns text
language sql
immutable
as $$
  select btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              lower(coalesce(p_name, '')),
              '\.(pdf|docx?|dotx?|txt|rtf|html?|md|markdown|csv|tsv|xlsx?|pptx?|png|jpe?g|gif|tiff?|bmp|heic|eml|msg|zip|ptx|lef|xmef|mp3|mp4|m4a|wav|mov|json|xml)$',
              ''),
            -- leading date and/or leading index number, repeatedly: a filing
            -- night produces "2026-09-08 04 - Watson v Long Island RCo.pdf".
            -- The trailing [\s\-_]* is INSIDE the repeated group, or the second
            -- pass cannot start across the space that follows the first.
            '^[\s\-_\[\(]*(((19|20)\d{2}[-._ ]\d{1,2}[-._ ]\d{1,2}|\d{1,2}[-._]\d{1,2}[-._]\d{2,4}|\d{1,3}\s*[-._)\]])[\s\-_]*)+',
            ''),
          '^(the|an?|in re,?|in the matter of)\s+',
          ''),
        -- leading punctuation left over from the strips above
        '^[^a-z0-9]+',
        ''),
      '\s+', ' ', 'g')
  )
$$;

comment on function public.document_sort_key(text) is
  'The A–Z sort key for a document''s displayed name: extension, leading date '
  'or index, and a leading article/"In re" removed. IMMUTABLE because '
  'documents.sort_key is generated from it — changing this body requires '
  'dropping and re-adding that column.';

-- The deterministic category. First match wins, and the order of the tests IS
-- the rule — it is what decides the two-signal names:
--
--   "Decl. of Teman in Support of Motion to Dismiss"  -> supporting (test 1
--       beats test 6: what the document IS, is a declaration; the motion is
--       what it is about)
--   "Ex. 7 — Watson v. Long Island R. Co."            -> supporting (test 1
--       beats test 4: it was filed as an exhibit)
--   "Fed. R. Civ. P. 26"                              -> rule
--   "Glasstech Inc v Freund"                          -> case
--   "Memorandum of Law in Opposition"                 -> pleading
--
-- The case test runs on the ORIGINAL string, not the lower-cased one: " v. "
-- only means a caption when there is a capitalised party on each side of it,
-- which is what keeps "Motion v Draft.docx" out of the case shelf.
create or replace function public.document_category_rule(p_title text, p_filename text)
returns text
language plpgsql
immutable
as $$
declare
  -- The displayed name first, exactly as the Vault shows it, then the other.
  v_raw   text := btrim(coalesce(nullif(btrim(coalesce(p_filename, '')), ''), p_title, ''));
  v_other text := btrim(coalesce(p_title, ''));
  v_name  text;
  v_low   text;
begin
  if v_raw = '' then return 'other'; end if;
  -- Sort-key normalisation first so a leading date or index does not hide the
  -- word that decides ("2026-09-08 Decl of Smith.pdf").
  v_name := public.document_sort_key(v_raw);
  v_low  := v_name || ' ' || public.document_sort_key(v_other);

  -- NOTE ON \y. PostgreSQL's regular expressions are AREs, where the word
  -- boundary is \y (\m start, \M end) and \b is a BACKSPACE character. Every
  -- boundary below is \y on purpose; a \b here would silently match nothing
  -- and quietly file half a matter under "other".

  -- 1. What the document IS, when it announces it at the front.
  if v_name ~ '^(ex|exh|exhibit|dx|px|attachment|appendix)\y[\s.:\-]*[0-9a-z]{0,4}[\s.:\-]'
     or v_name ~ '^(decl|declaration|aff|affid|affidavit|cert|certificate|verification)\y'
     or v_name ~ '^(dep|depo|deposition|transcript|tr)\y' then
    return 'supporting';
  end if;

  -- 2. Secondary authority. BEFORE statutes, because a treatise section is
  --    still a treatise: "Wright & Miller, Federal Practice § 1391" carries a
  --    § and is not a statute.
  if v_low ~ '(law review|l\.?\s?rev\.?\y|restatement|treatise|hornbook|handbook|wright (&|and) miller|moore''s federal|\ya\.?l\.?r\.?\y|law journal|\yj\.? of \y|practice commentar)' then
    return 'secondary';
  end if;

  -- 3. Rules of procedure and evidence.
  if v_low ~ '(fed\.?\s*r\.?\s*(civ|crim|app|evid|bankr)|\yf\.?r\.?(c\.?p|e|a\.?p|cr\.?p)\y|federal rules?|local (civil |criminal )?rule|l\.?\s?civ\.?\s?r\.?|\yl\.?r\.?\s*\d|\yrule\s*\d)' then
    return 'rule';
  end if;

  -- 4. Statutes and regulations.
  if v_low ~ '(§|u\.?\s?s\.?\s?c\.?\y|c\.?\s?f\.?\s?r\.?\y|\ycplr\y|\ystat\.|public law|pub\.?\s?l\.?\s*no|\yusc\y|\ynyc admin|admin\.? code)' then
    return 'statute';
  end if;

  -- 5. Cases. Two accepted captions, and a reporter cite:
  --      * "… v. Pepsi" / "… vs. Pepsi" — the abbreviation with its period,
  --        followed by a capitalised party. The left side may be anything
  --        ending in a word character, which is what lets "Soft Drink Workers
  --        Local 812 v. Pepsi" through.
  --      * "Watson v Long Island" — the BARE v, which only means a caption
  --        when a capitalised party stands on each side of it. That is what
  --        keeps "Motion v Draft.docx" out of the case shelf.
  --    "In re" is tested on the raw string, because document_sort_key has
  --    already stripped it from the front of v_name.
  if v_raw ~ '[A-Za-z0-9)\]]\s+vs?\.\s+[A-Z]'
     or v_raw ~ '[A-Z][A-Za-z.''&\-]*\s+v\s+[A-Z]'
     or v_low ~ '\d+\s+(u\.?s\.?|f\.?\s?(2d|3d|4th)|f\.?\s?supp\.?|s\.?\s?ct\.?|n\.?y\.?(s\.?)?\s?(2d|3d)?|a\.?d\.?\s?(2d|3d)?|misc\.?\s?(2d|3d)?|n\.?e\.?\s?(2d|3d)?|f\.?r\.?d\.?|l\.?\s?ed\.?)\s*\d+'
     or v_raw ~ '^\s*[Ii]n [Rr]e\y' then
    return 'case';
  end if;

  -- 6. Things filed with the court.
  if v_low ~ '(complaint|answer\y|\ymotion\y|memorandum|mem\.? of law|\ybrief\y|\yreply\y|opposition|\yopp\.|\yorder\y|notice of|petition|stipulation|summons|counterclaim|cross-?claim|subpoena|pleading|affirmation in (support|opposition)|judgment|\ydocket\y)' then
    return 'pleading';
  end if;

  -- 7. Everything that supports one, named anywhere in the string.
  if v_low ~ '(declaration|affidavit|exhibit|transcript|deposition|\yletter\y|e-?mail|correspondence|invoice|\yreport\y|statement|\ychart\y|photograph|\yphoto\y|records?\y|\ynotes?\y|contract|agreement)' then
    return 'supporting';
  end if;

  return 'other';
end $$;

comment on function public.document_category_rule(text, text) is
  'The deterministic document category: case / statute / rule / secondary / '
  'pleading / supporting / other, decided from the filename and title alone. '
  'No model is consulted. First match wins and the ORDER of the tests is the '
  'rule — see the body. IMMUTABLE; see document_sort_key''s comment.';

-- ---------------------------------------------------------------------------
-- 4. The columns. ONE alter, so ONE table rewrite.
--
--   category        what shelf this document sits on. NULL until the matter is
--                   organized (or until a row is inserted, see section 6) —
--                   deliberately NOT backfilled here, because a backfill is a
--                   second rewrite of every row on a table that has just had
--                   one, and the feature has a button for it.
--   category_source who decided: 'rule' (this file's function) or 'user'.
--                   NOTHING may overwrite 'user'.
--   category_at     when.
--   sort_key        generated. The A–Z key for the DISPLAYED name, which is
--                   source_filename first — that is what documentToVaultFile
--                   puts on the row, so it is what A–Z must agree with.
--   category_rank   generated. Table-of-Authorities order as a number, so
--                   PostgREST can `order=category_rank` and use an index.
--                   Uncategorised sorts last, not first.
--
-- `if not exists` makes this idempotent, and that cuts both ways: if a column
-- of this name already exists with a DIFFERENT generation expression, this
-- statement keeps the old one silently. On a database where 081 has never run
-- that cannot happen; on one where it has, re-running changes nothing, which
-- is the point.
-- ---------------------------------------------------------------------------
alter table public.documents
  add column if not exists category        text,
  add column if not exists category_source text,
  add column if not exists category_at     timestamptz,
  add column if not exists sort_key        text
    generated always as (
      public.document_sort_key(coalesce(nullif(source_filename, ''), title))
    ) stored,
  add column if not exists category_rank   smallint
    generated always as (
      case category
        when 'case'       then 1
        when 'statute'    then 2
        when 'rule'       then 3
        when 'secondary'  then 4
        when 'pleading'   then 5
        when 'supporting' then 6
        when 'other'      then 7
        else 8
      end
    ) stored;

-- The vocabulary, as constraints rather than as a convention. Dropped first so
-- a re-paste replaces rather than duplicates.
alter table public.documents drop constraint if exists documents_category_check;
alter table public.documents add constraint documents_category_check
  check (category is null or category in
    ('case','statute','rule','secondary','pleading','supporting','other'));

alter table public.documents drop constraint if exists documents_category_source_check;
alter table public.documents add constraint documents_category_source_check
  check (category_source is null or category_source in ('rule','user'));

comment on column public.documents.category is
  'case / statute / rule / secondary / pleading / supporting / other. NULL '
  'means nobody has decided yet.';
comment on column public.documents.category_source is
  '''rule'' = public.document_category_rule decided it; ''user'' = a person '
  'did, and nothing automatic may overwrite it.';
comment on column public.documents.sort_key is
  'Generated A–Z key for the displayed name. See public.document_sort_key.';
comment on column public.documents.category_rank is
  'Generated Table-of-Authorities order for `category`. Uncategorised = 8, '
  'so it sorts after every named shelf rather than before all of them.';

-- ---------------------------------------------------------------------------
-- 5. A person's own choice, and the pass that must not overwrite it.
-- ---------------------------------------------------------------------------

-- Set (or clear) one document's category by hand. SECURITY INVOKER with no
-- privileges of its own: the UPDATE below is governed by the documents UPDATE
-- policy from 016 (`can_write_matter`), so a viewer cannot reach it and a
-- stranger's document is simply not found.
--
-- p_category NULL means "go back to the automatic answer": the rule is applied
-- and the source returns to 'rule', so a later organize pass owns the row again.
create or replace function public.set_document_category(
  p_document_id uuid,
  p_category text
)
returns text
language plpgsql
volatile
security invoker
as $$
declare
  v_uid  uuid := auth.uid();
  v_next text;
  v_src  text;
  v_out  text;
begin
  if v_uid is null and row_security_active('public.documents') then
    return null;
  end if;

  if p_category is null then
    select public.document_category_rule(d.title, d.source_filename)
      into v_next
      from public.documents d
     where d.id = p_document_id;
    v_src := 'rule';
  else
    if p_category not in ('case','statute','rule','secondary','pleading','supporting','other') then
      raise exception 'set_document_category: % is not a category', p_category
        using errcode = '22023';
    end if;
    v_next := p_category;
    v_src  := 'user';
  end if;

  update public.documents d
     set category = v_next,
         category_source = v_src,
         category_at = now()
   where d.id = p_document_id
  returning d.category into v_out;

  return v_out;
end $$;

revoke all on function public.set_document_category(uuid, text) from public;
grant execute on function public.set_document_category(uuid, text)
  to authenticated, service_role;

-- The organize pass, DEFINER half. No access check of its own: the wrapper
-- below has already reduced the array to matters the caller may WRITE.
--
-- Two guards make it safe and make a re-run free:
--   * `category_source is distinct from 'user'` — a person's choice is not in
--     the UPDATE's row set at all, so no re-run can reach it;
--   * `category is distinct from <the rule's answer>` — a second run updates
--     ZERO rows and returns instantly, instead of rewriting 7,600 of them.
create or replace function vault_internal.organize_documents_core(
  p_matterspace_ids uuid[]
)
returns table (matterspace_id uuid, assigned bigint)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with upd as (
    update public.documents d
       set category        = public.document_category_rule(d.title, d.source_filename),
           category_source = 'rule',
           category_at     = now()
     where d.matterspace_id = any(p_matterspace_ids)
       and d.category_source is distinct from 'user'
       and d.category is distinct from public.document_category_rule(d.title, d.source_filename)
    returning d.matterspace_id as mid
  )
  select u.mid, count(*)::bigint from upd u group by u.mid;
end $$;

revoke all on function vault_internal.organize_documents_core(uuid[]) from public;
grant execute on function vault_internal.organize_documents_core(uuid[])
  to authenticated, service_role;

comment on function vault_internal.organize_documents_core(uuid[]) is
  'NEVER call this directly. SECURITY DEFINER, no access check: '
  'p_matterspace_ids must already be the subset the caller may WRITE. The only '
  'supported caller is public.organize_matter_documents.';

-- "Organize my matter", INVOKER half.
create or replace function public.organize_matter_documents(
  p_matterspace_ids uuid[]
)
returns table (matterspace_id uuid, assigned bigint)
language plpgsql
volatile
security invoker
as $$
declare
  v_uid     uuid    := auth.uid();
  v_rls     boolean := row_security_active('public.documents');
  v_allowed uuid[];
begin
  if p_matterspace_ids is null or cardinality(p_matterspace_ids) = 0 then
    return;
  end if;

  if not v_rls then
    -- service_role / postgres: RLS never applied to this caller, so the array
    -- is taken as given, exactly as 078 does.
    v_allowed := p_matterspace_ids;
  elsif v_uid is null then
    return;
  else
    -- Organizing WRITES, so the question is can_write_matter, not
    -- can_access_matter: a viewer may read a matter and may not re-file it.
    select coalesce(array_agg(m.id), '{}'::uuid[])
      into v_allowed
      from unnest(p_matterspace_ids) as m(id)
     where public.can_write_matter(m.id);
  end if;

  if v_allowed is null or cardinality(v_allowed) = 0 then
    return;
  end if;

  return query select * from vault_internal.organize_documents_core(v_allowed);
end $$;

revoke all on function public.organize_matter_documents(uuid[]) from public;
grant execute on function public.organize_matter_documents(uuid[])
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. A new document arrives already on a shelf.
--
-- BEFORE INSERT only, and only when nothing was supplied. Never on UPDATE:
-- an update trigger would re-decide a row a person had just decided, which is
-- the one thing this feature promises not to do.
-- ---------------------------------------------------------------------------
create or replace function public._documents_default_category()
returns trigger
language plpgsql
as $$
begin
  if new.category is null then
    new.category        := public.document_category_rule(new.title, new.source_filename);
    new.category_source := coalesce(new.category_source, 'rule');
    new.category_at     := coalesce(new.category_at, now());
  end if;
  return new;
end $$;

drop trigger if exists documents_default_category on public.documents;
create trigger documents_default_category
  before insert on public.documents
  for each row execute function public._documents_default_category();

-- ---------------------------------------------------------------------------
-- 7. The search.
--
-- DEFINER core. Every WHERE clause is keyed on the pre-authorized array.
--
-- Recall, in two branches, because pg_trgm has a floor:
--   * a query shorter than three characters produces no trigrams, so `%ab%`
--     degrades to a sequential scan with no index to help it. Under three
--     characters this searches the PREFIX of the sort key instead, which the
--     btree in section 8 answers directly. The surface says so.
--   * three characters or more: ILIKE 'contains', answered by the trigram GIN.
-- `similarity()` is used for RANKING ONLY, never as the recall predicate — a
-- similarity threshold silently drops exact substring matches on long titles.
--
-- Ranking, highest tier wins, similarity breaks ties inside a tier:
--   4  the displayed name IS the query
--   3  the sort key starts with the query AND the query ends on a word
--      boundary there — "watson" opening "Watson v Long Island RCo"
--   2  the sort key starts with the query mid-word — "watson" opening
--      "Watsonville Report". Without this tier the Watsonville report wins,
--      because it is the shorter string and so the more SIMILAR one, which is
--      exactly the wrong answer for a lawyer looking for Watson.
--   1  a word inside the name starts with the query, or the query appears
--      anywhere in either name
--   +  similarity(sort key, query) in [0,1)
-- The ORDER BY ends `sort_key, document_id`: a total order, which is what
-- makes `offset` stable between pages instead of shuffling rows across the
-- boundary (the rule paged.ts exists to enforce).
--
-- Bounds. `p_limit` is clamped to 100 and `p_offset` to 10,000, so the sort
-- never holds more than ~10,100 rows however the call is written. There is NO
-- statement_timeout set inside this function, and that is deliberate rather
-- than an omission: PostgreSQL arms the statement timer when the STATEMENT
-- begins, and a `set`/`set local` inside a function cannot re-arm it — a
-- timeout written here would read as a guarantee and be worth nothing. The
-- real cut-off is the caller's role setting (PostgREST runs this as
-- `authenticated`, 8 s on this project); the bound this file owns is
-- structural, and the indexes in section 8 are what keep the work under it.
-- ---------------------------------------------------------------------------
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
set search_path = public, pg_temp
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
begin
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
          or (not v_short
              and (coalesce(d.source_filename, '') || ' ' || coalesce(d.title, ''))
                  ilike '%' || v_esc || '%' escape '\')
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

revoke all on function vault_internal.search_documents_core(
  uuid[], text, text[], timestamptz, timestamptz, int, int) from public;
grant execute on function vault_internal.search_documents_core(
  uuid[], text, text[], timestamptz, timestamptz, int, int)
  to authenticated, service_role;

comment on function vault_internal.search_documents_core(
  uuid[], text, text[], timestamptz, timestamptz, int, int) is
  'NEVER call this directly. SECURITY DEFINER and performs NO access check: '
  'p_matterspace_ids must already be the subset the caller may read. The only '
  'supported caller is public.search_documents.';

-- The INVOKER gate. This is the whole of the isolation guarantee.
--
-- p_matterspace_ids NULL means "everywhere I may look". For an RLS-subject
-- caller that is resolved from `public.matterspaces` — read under the caller's
-- own RLS, so the row set is already theirs — and then filtered AGAIN through
-- can_access_matter, which is the same predicate the documents policy uses.
-- Two independent gates agreeing is cheap at a few hundred matters and means a
-- drift in either one cannot open the door on its own.
--
-- For a caller that BYPASSES RLS (service_role, postgres) NULL is REFUSED
-- outright. `select id from matterspaces` would be every matter belonging to
-- every tenant on the deployment, and a script that forgot an argument would
-- quietly search all of them. A bypassing caller must name its scope.
create or replace function public.search_documents(
  p_query text,
  p_matterspace_ids uuid[] default null,
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
security invoker
as $$
#variable_conflict use_column
declare
  -- Read ONCE, at entry, into a declared variable —
  -- feedback_rls_security_invoker_wrappers.md's pattern.
  v_uid     uuid    := auth.uid();
  v_rls     boolean := row_security_active('public.documents');
  v_allowed uuid[];
begin
  if not v_rls then
    if p_matterspace_ids is null then
      raise exception
        'search_documents: p_matterspace_ids is required for a caller that bypasses RLS'
        using errcode = '22023';
    end if;
    v_allowed := p_matterspace_ids;
  elsif v_uid is null then
    -- anon, or a JWT with no subject. Nothing is accessible and the core is
    -- not called at all.
    return;
  elsif p_matterspace_ids is null then
    select coalesce(array_agg(m.id), '{}'::uuid[])
      into v_allowed
      from public.matterspaces m            -- the caller's own RLS applies here
     where public.can_access_matter(m.id);  -- and the documents policy's own test
  else
    select coalesce(array_agg(m.id), '{}'::uuid[])
      into v_allowed
      from unnest(p_matterspace_ids) as m(id)
     where public.can_access_matter(m.id);
  end if;

  if v_allowed is null or cardinality(v_allowed) = 0 then
    return;
  end if;

  return query
  select * from vault_internal.search_documents_core(
    v_allowed, p_query, p_categories, p_from, p_to, p_limit, p_offset);
end $$;

revoke all on function public.search_documents(
  text, uuid[], text[], timestamptz, timestamptz, int, int) from public;
grant execute on function public.search_documents(
  text, uuid[], text[], timestamptz, timestamptz, int, int)
  to authenticated, service_role;

comment on function public.search_documents(
  text, uuid[], text[], timestamptz, timestamptz, int, int) is
  'Find DOCUMENTS by name, filename, category or date across every matter the '
  'caller may open. Returns metadata only — never passage or body text. '
  'Sealed matters are included and flagged, matching the in-app lists; '
  'connector-side exclusion is lib/mcp-core.mjs''s business, not this '
  'function''s. This is NOT passage search: see public.search_passages.';

-- ---------------------------------------------------------------------------
-- 8. The indexes. See "HOW TO APPLY THIS": built without `concurrently`
--     because a pasted file is one transaction and CIC cannot run in one.
-- ---------------------------------------------------------------------------

-- The A–Z list: `order by sort_key, id` inside one matter, answered as an
-- ordered index read with no sort step at all. Default collation, because that
-- is the order PostgREST's `order=sort_key` asks for.
create index if not exists idx_documents_matter_sortkey
  on public.documents (matterspace_id, sort_key, id);

-- The under-three-characters PREFIX branch, and it needs its own index for a
-- reason that is easy to miss: a btree in a non-C collation (this project is
-- en_US.UTF-8) cannot answer `sort_key LIKE 'zy%'` as an index condition. Only
-- `text_pattern_ops` can. The index above orders; this one matches. It also
-- carries no matterspace_id, which is deliberate — with `matterspace_id =
-- ANY(<every matter you can open>)` the planner cannot use a composite index's
-- second column as a condition anyway, so the site-wide two-letter search
-- would otherwise have nothing to stand on.
create index if not exists idx_documents_sortkey_prefix
  on public.documents (sort_key text_pattern_ops);

-- The category list: Table-of-Authorities order, A–Z inside each shelf.
create index if not exists idx_documents_matter_category
  on public.documents (matterspace_id, category_rank, sort_key, id);

-- The date list — the Vault's default read (created_at desc, id desc) has had
-- only `(matterspace_id)` to work with since 002.
create index if not exists idx_documents_matter_created
  on public.documents (matterspace_id, created_at desc, id desc);

-- The contains branch. One index over BOTH names, so "watson" finds the
-- document whether the word is in the title or only in the uploaded filename.
create index if not exists idx_documents_name_trgm
  on public.documents using gin (
    (coalesce(source_filename, '') || ' ' || coalesce(title, '')) gin_trgm_ops
  );

-- Keep the planner honest about columns that did not exist a moment ago.
analyze public.documents;
