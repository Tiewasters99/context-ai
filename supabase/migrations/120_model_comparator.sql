-- 120_model_comparator.sql — the Model Comparator, slice 1 (a Sandbox feature)
--
-- Spec: MODEL-COMPARATOR-SPEC-2026-10-18 (Fable, v0.1) and its Opus build
-- handoff of the same date. A Comparison lives in a Sandbox box. It names a
-- type (a drop-down), a packet of the box's documents, the instructions every
-- candidate was given, and a rubric of 3–6 dimensions. Candidates are filed
-- into the box as "Candidate A — <title>", "Candidate B — …", and graded blind:
-- margin notes in the reader (document_annotations, now with a `tag`), and one
-- grade card per candidate. Who made each candidate is held back until every
-- candidate has a grade card; then it is revealed, once, and the reveal is in
-- the Record.
--
--   comparison_types            the drop-down. One row per type, with its
--                               default rubric. Adding a type is an INSERT
--                               (service role), never a build.
--   comparisons                 one comparison in one box.
--   comparison_candidates       the candidates, shown by their blind label.
--   comparison_candidate_keys   who/what made each candidate. Readable only
--                               after the comparison is revealed (RLS, below).
--   candidate_grades            the grade card: a 1–10 score per rubric
--                               dimension, overall, comment, initials, time.
--   document_annotations.tag    which rubric dimension a margin note speaks to
--                               (null = a general note).
--
-- THE KEY IS HELD BY THE DATABASE, NOT BY THE BROWSER.
-- The handoff put `revealed_label` on comparison_candidates and asked that it
-- be enforced "with a view or a column-level grant / RPC, not client
-- discipline". It is a separate table instead, so the rule is one RLS policy
-- and needs no SECURITY DEFINER function at all:
--   * a member who may write in the box may INSERT a key (that is how the
--     add-candidate action files it with the caller's own session);
--   * nobody can SELECT a key until comparisons.revealed_at is set — not the
--     person who filed it, not the grader, not an admin of the matter;
--   * nobody can UPDATE a key, ever. A key row may be deleted while the
--     comparison is unrevealed (to correct a mistake); that discloses nothing.
--
-- THE REVEAL IS A RULE, NOT A BUTTON. Setting comparisons.revealed_at is
-- refused (trigger, SECURITY INVOKER) unless the comparison has at least one
-- candidate and every candidate has a grade card. Once set it never changes
-- or clears; the database stamps the time and auth.uid() as revealed_by.
-- After the reveal, grades are frozen (they were blind; a later edit would
-- not be), no candidate is added or removed, and the rubric cannot move.
-- The rubric is also frozen as soon as the first grade card exists, because
-- the scores are keyed by its dimensions.
--
-- packet_hash is computed HERE from the packet documents' ids, filenames and
-- sizes (documents carry no content hash), so the fingerprint in the notes and
-- the Record is the database's, not whatever a browser sent (100's rule for
-- draft_snapshots.sha256). Every packet document must be filed in the box or
-- below it.
--
-- RLS: through the comparison's box. Read = can_access_matter(box); write =
-- can_write_matter(box). Both helpers are SECURITY INVOKER since 098, so the
-- policies call them directly. Every function this file creates is SECURITY
-- INVOKER (the migration-022 / house rule): there is no SECURITY DEFINER here.
--
-- The Record: five matter-bound kinds, re-declaring events_kind_check with the
-- UNION of every kind lib/ledger.mjs's EVENT_KINDS holds (064 + 072 + 073 +
-- 094 + 100 + these), in 100's guarded pattern. (119, on its own branch, does
-- not touch the constraint.)
--   comparison.created    {comparison_id, type, packet_count, packet_hash}
--   comparison.candidate  {comparison_id, candidate_id, document_id, label, source}
--                         — never the revealed name
--   comparison.graded     {comparison_id, candidate_id, label, overall, initials}
--   comparison.assembled  {comparison_id, document_id}
--   comparison.revealed   {comparison_id, revealed: [{label, revealed_label}]} (not `key`: redact() treats any key named like a secret as one)
--
-- Needs: 012 (matterspace_descendants), 048 + 084 (document_annotations),
-- 098 (INVOKER can_access_matter / can_write_matter). Additive only; no
-- existing row changes. Re-runnable: executed twice in PGlite by
-- scripts/_verify-comparator-120.mjs.
--
-- ⚠ NOT APPLIED. Eden approves this file by name before it is applied.
-- ⚠ After pasting, run:  notify pgrst, 'reload schema';  (last statement here.)

do $pre$
begin
  if to_regprocedure('public.can_access_matter(uuid)') is null
     or to_regprocedure('public.can_write_matter(uuid)') is null then
    raise exception '120 needs migration 098 (can_access_matter / can_write_matter) — paste 098 first.';
  end if;
  if to_regprocedure('public.matterspace_descendants(uuid)') is null then
    raise exception '120 needs migration 012 (matterspace_descendants) — paste 012 first.';
  end if;
  if to_regclass('public.document_annotations') is null then
    raise exception '120 needs migration 048 (document_annotations) — paste 048 first.';
  end if;
end $pre$;

-- ============================================================================
-- 1. comparison_types — the drop-down
-- ============================================================================
create table if not exists public.comparison_types (
  key             text primary key check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label           text not null check (char_length(label) between 1 and 80),
  default_rubric  jsonb not null,
  sort            int  not null default 100,
  constraint comparison_types_rubric_shape check (
    jsonb_typeof(default_rubric) = 'array'
    and jsonb_array_length(default_rubric) between 3 and 6
  )
);

comment on table public.comparison_types is
  'Model Comparator: the type drop-down. A type sets the default rubric and nothing else; adding a type is a row.';

alter table public.comparison_types enable row level security;
drop policy if exists "Anyone signed in reads comparison types" on public.comparison_types;
create policy "Anyone signed in reads comparison types" on public.comparison_types
  for select using (auth.uid() is not null);
revoke all on public.comparison_types from anon;
grant select on public.comparison_types to authenticated;
grant all on public.comparison_types to service_role;

-- Spec §1. `custom` has no rubric of its own in the spec; it gets three neutral
-- dimensions so the 3–6 rule holds, and is meant to be edited per comparison.
insert into public.comparison_types (key, label, default_rubric, sort) values
  ('motion_brief', 'Draft a motion or brief',
   '[{"key":"strategy","label":"Strategy"},{"key":"record_accuracy","label":"Record accuracy"},{"key":"authority","label":"Authority"},{"key":"prose","label":"Prose"},{"key":"form","label":"Form"}]', 10),
  ('cite_check', 'Cite-check a brief',
   '[{"key":"catches","label":"Catches"},{"key":"false_alarms","label":"False alarms"},{"key":"pinpoint_precision","label":"Pinpoint precision"},{"key":"explanation_quality","label":"Explanation quality"}]', 20),
  ('statement_of_facts', 'Statement of facts from the record',
   '[{"key":"completeness","label":"Completeness"},{"key":"pincite_accuracy","label":"Pincite accuracy"},{"key":"neutrality","label":"Neutrality"},{"key":"organization","label":"Organization"}]', 30),
  ('deposition_summary', 'Deposition summary',
   '[{"key":"fidelity","label":"Fidelity"},{"key":"page_line_coverage","label":"Page:line coverage"},{"key":"usefulness","label":"Usefulness"}]', 40),
  ('research_answer', 'Research answer',
   '[{"key":"correctness","label":"Correctness"},{"key":"authority","label":"Authority"},{"key":"scope_discipline","label":"Scope discipline"}]', 50),
  ('custom', 'Custom',
   '[{"key":"accuracy","label":"Accuracy"},{"key":"reasoning","label":"Reasoning"},{"key":"usefulness","label":"Usefulness"}]', 90)
on conflict (key) do nothing;

-- ============================================================================
-- 2. comparisons
-- ============================================================================
create table if not exists public.comparisons (
  id              uuid primary key default gen_random_uuid(),
  box_matter_id   uuid not null references public.matterspaces(id) on delete cascade,
  type            text not null references public.comparison_types(key),
  title           text not null check (char_length(btrim(title)) between 1 and 200),
  instructions    text not null default '' check (char_length(instructions) <= 20000),
  packet_doc_ids  uuid[] not null default '{}',
  packet_hash     text,
  rubric          jsonb not null,
  revealed_at     timestamptz,
  revealed_by     uuid,
  created_by      uuid not null default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint comparisons_rubric_shape check (
    jsonb_typeof(rubric) = 'array'
    and jsonb_array_length(rubric) between 3 and 6
  ),
  constraint comparisons_packet_size check (coalesce(array_length(packet_doc_ids, 1), 0) <= 200)
);

create index if not exists comparisons_box_idx on public.comparisons (box_matter_id, created_at desc);

comment on table public.comparisons is
  'Model Comparator: one comparison in one Sandbox box — type, packet (hashed by the database), instructions, rubric, reveal.';
comment on column public.comparisons.rubric is
  '[{key, label}], 3–6 dimensions, each scored 1–10 on a grade card. Frozen once a grade exists.';

-- Rubric entries must each be {key, label} with a unique, simple key.
create or replace function public._comparison_rubric_ok(p_rubric jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_typeof(p_rubric) = 'array'
     and jsonb_array_length(p_rubric) between 3 and 6
     and not exists (
       select 1 from jsonb_array_elements(p_rubric) e
        where jsonb_typeof(e) <> 'object'
           or coalesce(e->>'key', '') !~ '^[a-z][a-z0-9_]{0,40}$'
           or char_length(coalesce(e->>'label', '')) not between 1 and 80
     )
     and (select count(distinct e->>'key') from jsonb_array_elements(p_rubric) e)
         = jsonb_array_length(p_rubric)
$$;

create or replace function public._comparisons_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_candidates int;
  v_graded     int;
  v_found      int;
  v_wanted     int;
begin
  if not public._comparison_rubric_ok(new.rubric) then
    raise exception 'comparison: the rubric must be 3 to 6 dimensions, each {key, label}, keys unique'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.revealed_at := null;
    new.revealed_by := null;
  else
    if new.box_matter_id is distinct from old.box_matter_id
       or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'comparison: the box, author and creation time do not change'
        using errcode = '42501';
    end if;

    -- The reveal: once, and only when every candidate has a grade card.
    if old.revealed_at is not null then
      if new.revealed_at is distinct from old.revealed_at
         or new.revealed_by is distinct from old.revealed_by then
        raise exception 'comparison: it has been revealed; the reveal does not change'
          using errcode = '42501';
      end if;
      if new.rubric is distinct from old.rubric
         or new.type is distinct from old.type
         or new.packet_doc_ids is distinct from old.packet_doc_ids then
        raise exception 'comparison: it has been revealed; the type, packet and rubric are frozen'
          using errcode = '42501';
      end if;
    elsif new.revealed_at is not null then
      select count(*) into v_candidates from public.comparison_candidates where comparison_id = new.id;
      select count(*) into v_graded
        from public.comparison_candidates c
        join public.candidate_grades g on g.candidate_id = c.id
       where c.comparison_id = new.id;
      if v_candidates = 0 or v_graded < v_candidates then
        raise exception 'comparison: reveal needs a grade card on every candidate (% of % graded)', v_graded, v_candidates
          using errcode = '42501';
      end if;
      new.revealed_at := now();
      new.revealed_by := auth.uid();
    else
      new.revealed_by := null;
    end if;

    if new.rubric is distinct from old.rubric and exists (
      select 1 from public.comparison_candidates c
        join public.candidate_grades g on g.candidate_id = c.id
       where c.comparison_id = new.id
    ) then
      raise exception 'comparison: the rubric is frozen once a candidate has been graded'
        using errcode = '42501';
    end if;
  end if;

  -- The packet: every document filed in the box or below it, and readable by
  -- the caller (SECURITY INVOKER: an unreadable document counts as absent).
  if tg_op = 'INSERT' or new.packet_doc_ids is distinct from old.packet_doc_ids then
    select count(distinct x) into v_wanted from unnest(new.packet_doc_ids) x;
    select count(*) into v_found
      from public.documents d
     where d.id = any (new.packet_doc_ids)
       and d.matterspace_id in (select t.id from public.matterspace_descendants(new.box_matter_id) t);
    if v_found <> v_wanted then
      raise exception 'comparison: every packet document must be filed in this box (% of % are)', v_found, v_wanted
        using errcode = '42501';
    end if;
    select encode(sha256(convert_to(coalesce(string_agg(
             d.id::text || ':' || coalesce(d.source_filename, '') || ':' || coalesce(d.file_size_bytes::text, ''),
             E'\n' order by d.id), ''), 'UTF8')), 'hex')
      into new.packet_hash
      from public.documents d
     where d.id = any (new.packet_doc_ids);
  else
    new.packet_hash := old.packet_hash;
  end if;

  new.updated_at := now();
  return new;
end $$;

drop trigger if exists comparisons_guard on public.comparisons;
create trigger comparisons_guard
  before insert or update on public.comparisons
  for each row execute function public._comparisons_guard();

alter table public.comparisons enable row level security;

drop policy if exists "Matter members read comparisons" on public.comparisons;
create policy "Matter members read comparisons" on public.comparisons
  for select using (public.can_access_matter(box_matter_id));

drop policy if exists "Matter writers create comparisons" on public.comparisons;
create policy "Matter writers create comparisons" on public.comparisons
  for insert with check (created_by = auth.uid() and public.can_write_matter(box_matter_id));

drop policy if exists "Matter writers update comparisons" on public.comparisons;
create policy "Matter writers update comparisons" on public.comparisons
  for update using (public.can_write_matter(box_matter_id))
  with check (public.can_write_matter(box_matter_id));

drop policy if exists "Matter writers delete comparisons" on public.comparisons;
create policy "Matter writers delete comparisons" on public.comparisons
  for delete using (public.can_write_matter(box_matter_id));

revoke all on public.comparisons from anon;
grant select, insert, update, delete on public.comparisons to authenticated;
grant all on public.comparisons to service_role;

-- ============================================================================
-- 3. comparison_candidates — shown blind
-- ============================================================================
create table if not exists public.comparison_candidates (
  id              uuid primary key default gen_random_uuid(),
  comparison_id   uuid not null references public.comparisons(id) on delete cascade,
  label           text not null check (label ~ '^[A-Z]{1,2}$'),
  source          text not null default 'upload' check (source in ('upload', 'model')),
  document_id     uuid references public.documents(id) on delete set null,
  -- Slice 2 (model-run candidates). For an upload these stay null: a model
  -- name here would be visible to the grader and break the blind.
  model           text,
  settings        jsonb,
  usage           jsonb,
  checks          jsonb,
  word_count      int check (word_count is null or word_count >= 0),
  created_by      uuid not null default auth.uid(),
  created_at      timestamptz not null default now(),
  unique (comparison_id, label),
  unique (comparison_id, document_id)
);

create index if not exists comparison_candidates_document_idx on public.comparison_candidates (document_id);

comment on table public.comparison_candidates is
  'Model Comparator: one candidate (an upload in slice 1), filed into the box as "Candidate <label> — <title>". Who made it is in comparison_candidate_keys, unreadable until reveal.';

create or replace function public._comparison_candidates_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_box      uuid;
  v_revealed timestamptz;
  v_cmp      uuid := case when tg_op = 'DELETE' then old.comparison_id else new.comparison_id end;
begin
  select box_matter_id, revealed_at into v_box, v_revealed
    from public.comparisons where id = v_cmp;
  if v_box is null then
    -- The comparison itself is being deleted (cascade) or is not visible.
    if tg_op = 'DELETE' then return old; end if;
    raise exception 'candidate: comparison not found' using errcode = '42501';
  end if;
  if v_revealed is not null then
    raise exception 'candidate: the comparison has been revealed; its candidates are fixed'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;

  if tg_op = 'UPDATE' and (new.comparison_id is distinct from old.comparison_id
                           or new.label is distinct from old.label
                           or new.created_by is distinct from old.created_by) then
    raise exception 'candidate: the comparison, label and author do not change' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
  end if;

  if new.source = 'upload' and (new.model is not null or new.settings is not null) then
    raise exception 'candidate: an uploaded candidate names no model (it would break the blind)'
      using errcode = '23514';
  end if;

  if new.document_id is not null and not exists (
    select 1 from public.documents d
     where d.id = new.document_id
       and d.matterspace_id in (select t.id from public.matterspace_descendants(v_box) t)
  ) then
    raise exception 'candidate: the document is not filed in the comparison''s box'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists comparison_candidates_guard on public.comparison_candidates;
create trigger comparison_candidates_guard
  before insert or update or delete on public.comparison_candidates
  for each row execute function public._comparison_candidates_guard();

alter table public.comparison_candidates enable row level security;

drop policy if exists "Matter members read candidates" on public.comparison_candidates;
create policy "Matter members read candidates" on public.comparison_candidates
  for select using (exists (
    select 1 from public.comparisons c
     where c.id = comparison_candidates.comparison_id
       and public.can_access_matter(c.box_matter_id)));

drop policy if exists "Matter writers add candidates" on public.comparison_candidates;
create policy "Matter writers add candidates" on public.comparison_candidates
  for insert with check (
    created_by = auth.uid()
    and exists (select 1 from public.comparisons c
                 where c.id = comparison_candidates.comparison_id
                   and public.can_write_matter(c.box_matter_id)));

drop policy if exists "Matter writers update candidates" on public.comparison_candidates;
create policy "Matter writers update candidates" on public.comparison_candidates
  for update
  using (exists (select 1 from public.comparisons c
                  where c.id = comparison_candidates.comparison_id
                    and public.can_write_matter(c.box_matter_id)))
  with check (exists (select 1 from public.comparisons c
                       where c.id = comparison_candidates.comparison_id
                         and public.can_write_matter(c.box_matter_id)));

drop policy if exists "Matter writers remove candidates" on public.comparison_candidates;
create policy "Matter writers remove candidates" on public.comparison_candidates
  for delete using (exists (
    select 1 from public.comparisons c
     where c.id = comparison_candidates.comparison_id
       and public.can_write_matter(c.box_matter_id)));

revoke all on public.comparison_candidates from anon;
grant select, insert, update, delete on public.comparison_candidates to authenticated;
grant all on public.comparison_candidates to service_role;

-- ============================================================================
-- 4. comparison_candidate_keys — who made it, sealed until reveal
-- ============================================================================
create table if not exists public.comparison_candidate_keys (
  candidate_id    uuid primary key references public.comparison_candidates(id) on delete cascade,
  revealed_label  text not null check (char_length(btrim(revealed_label)) between 1 and 200),
  created_by      uuid not null default auth.uid(),
  created_at      timestamptz not null default now()
);

comment on table public.comparison_candidate_keys is
  'Model Comparator: the key (who or what made each candidate). INSERT by a box writer; SELECT only after comparisons.revealed_at is set; never UPDATE.';

alter table public.comparison_candidate_keys enable row level security;

drop policy if exists "Keys read only after the reveal" on public.comparison_candidate_keys;
create policy "Keys read only after the reveal" on public.comparison_candidate_keys
  for select using (exists (
    select 1 from public.comparison_candidates k
      join public.comparisons c on c.id = k.comparison_id
     where k.id = comparison_candidate_keys.candidate_id
       and c.revealed_at is not null
       and public.can_access_matter(c.box_matter_id)));

drop policy if exists "Box writers file a key before the reveal" on public.comparison_candidate_keys;
create policy "Box writers file a key before the reveal" on public.comparison_candidate_keys
  for insert with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.comparison_candidates k
        join public.comparisons c on c.id = k.comparison_id
       where k.id = comparison_candidate_keys.candidate_id
         and c.revealed_at is null
         and public.can_write_matter(c.box_matter_id)));

drop policy if exists "Box writers withdraw a key before the reveal" on public.comparison_candidate_keys;
create policy "Box writers withdraw a key before the reveal" on public.comparison_candidate_keys
  for delete using (exists (
    select 1 from public.comparison_candidates k
      join public.comparisons c on c.id = k.comparison_id
     where k.id = comparison_candidate_keys.candidate_id
       and c.revealed_at is null
       and public.can_write_matter(c.box_matter_id)));

-- No UPDATE policy and no UPDATE grant: a key is never rewritten.
revoke all on public.comparison_candidate_keys from anon;
revoke update on public.comparison_candidate_keys from authenticated;
grant select, insert, delete on public.comparison_candidate_keys to authenticated;
grant all on public.comparison_candidate_keys to service_role;

-- ============================================================================
-- 5. candidate_grades — the grade card
-- ============================================================================
create table if not exists public.candidate_grades (
  candidate_id    uuid primary key references public.comparison_candidates(id) on delete cascade,
  scores          jsonb not null default '{}'::jsonb check (jsonb_typeof(scores) = 'object'),
  overall         int not null check (overall between 1 and 10),
  comment         text not null default '' check (char_length(comment) <= 8000),
  -- 103's initials discipline: who signed, in their own initials.
  initials        text not null check (char_length(btrim(initials)) between 1 and 6),
  graded_by       uuid not null default auth.uid(),
  graded_at       timestamptz not null default now()
);

comment on table public.candidate_grades is
  'Model Comparator: one grade card per candidate — a 1–10 score for every rubric dimension, overall, comment, initials, time. Frozen after the reveal.';

create or replace function public._candidate_grades_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_rubric   jsonb;
  v_revealed timestamptz;
  v_key      text;
  v_val      jsonb;
begin
  select c.rubric, c.revealed_at into v_rubric, v_revealed
    from public.comparison_candidates k
    join public.comparisons c on c.id = k.comparison_id
   where k.id = case when tg_op = 'DELETE' then old.candidate_id else new.candidate_id end;

  if v_rubric is null then
    if tg_op = 'DELETE' then return old; end if;
    raise exception 'grade: candidate not found' using errcode = '42501';
  end if;
  if v_revealed is not null then
    raise exception 'grade: the comparison has been revealed; grade cards are frozen'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;

  if tg_op = 'UPDATE' and new.candidate_id is distinct from old.candidate_id then
    raise exception 'grade: a grade card stays on its candidate' using errcode = '42501';
  end if;

  -- Every rubric dimension scored, 1–10, and nothing else.
  for v_key in select e->>'key' from jsonb_array_elements(v_rubric) e loop
    v_val := new.scores -> v_key;
    if v_val is null or jsonb_typeof(v_val) <> 'number'
       or (v_val::text)::numeric <> trunc((v_val::text)::numeric)
       or (v_val::text)::numeric not between 1 and 10 then
      raise exception 'grade: "%" needs a whole-number score from 1 to 10', v_key using errcode = '23514';
    end if;
  end loop;
  if exists (select 1 from jsonb_object_keys(new.scores) s
              where s not in (select e->>'key' from jsonb_array_elements(v_rubric) e)) then
    raise exception 'grade: a score names a dimension that is not in the rubric' using errcode = '23514';
  end if;

  new.initials  := upper(btrim(new.initials));
  new.graded_by := coalesce(auth.uid(), new.graded_by);
  new.graded_at := now();
  return new;
end $$;

drop trigger if exists candidate_grades_guard on public.candidate_grades;
create trigger candidate_grades_guard
  before insert or update or delete on public.candidate_grades
  for each row execute function public._candidate_grades_guard();

alter table public.candidate_grades enable row level security;

drop policy if exists "Matter members read grade cards" on public.candidate_grades;
create policy "Matter members read grade cards" on public.candidate_grades
  for select using (exists (
    select 1 from public.comparison_candidates k
      join public.comparisons c on c.id = k.comparison_id
     where k.id = candidate_grades.candidate_id
       and public.can_access_matter(c.box_matter_id)));

drop policy if exists "Matter writers sign grade cards" on public.candidate_grades;
create policy "Matter writers sign grade cards" on public.candidate_grades
  for insert with check (
    graded_by = auth.uid()
    and exists (select 1 from public.comparison_candidates k
                  join public.comparisons c on c.id = k.comparison_id
                 where k.id = candidate_grades.candidate_id
                   and public.can_write_matter(c.box_matter_id)));

drop policy if exists "Matter writers re-sign grade cards" on public.candidate_grades;
create policy "Matter writers re-sign grade cards" on public.candidate_grades
  for update
  using (exists (select 1 from public.comparison_candidates k
                   join public.comparisons c on c.id = k.comparison_id
                  where k.id = candidate_grades.candidate_id
                    and public.can_write_matter(c.box_matter_id)))
  with check (
    graded_by = auth.uid()
    and exists (select 1 from public.comparison_candidates k
                  join public.comparisons c on c.id = k.comparison_id
                 where k.id = candidate_grades.candidate_id
                   and public.can_write_matter(c.box_matter_id)));

drop policy if exists "Matter writers remove grade cards" on public.candidate_grades;
create policy "Matter writers remove grade cards" on public.candidate_grades
  for delete using (exists (
    select 1 from public.comparison_candidates k
      join public.comparisons c on c.id = k.comparison_id
     where k.id = candidate_grades.candidate_id
       and public.can_write_matter(c.box_matter_id)));

revoke all on public.candidate_grades from anon;
grant select, insert, update, delete on public.candidate_grades to authenticated;
grant all on public.candidate_grades to service_role;

-- ============================================================================
-- 6. document_annotations.tag — a margin note's rubric dimension
-- ============================================================================
-- No RLS change: 048's policies already decide who reads and writes the row.
-- Free text on purpose (the suggested values are the comparison's rubric
-- keys); the assembly files any value it does not recognise under "General".
alter table public.document_annotations
  add column if not exists tag text;

do $tag$
begin
  if not exists (select 1 from pg_constraint where conname = 'document_annotations_tag_len') then
    alter table public.document_annotations
      add constraint document_annotations_tag_len check (tag is null or char_length(tag) between 1 and 64);
  end if;
end $tag$;

comment on column public.document_annotations.tag is
  'Optional label for a margin note — in the Model Comparator, a rubric dimension key. Null = a general note.';

-- ============================================================================
-- 7. The vocabulary — 100's guarded pattern, the UNION of every legal kind
-- ============================================================================
do $migration$
begin

if to_regclass('public.events') is null then
  raise notice '120: public.events is absent — migration 064 has not been applied; kinds skipped.';
  return;
end if;

execute $sql$
  alter table public.events drop constraint if exists events_kind_check
$sql$;
execute $sql$
  alter table public.events add constraint events_kind_check check (kind in (
    'tool.invoked',
    'completion.requested',
    'completion.received',
    'file.exported',
    'file.sent',
    'file.delivered',
    'file.gate',
    'citation.verified',
    'acl.changed',
    'seal.changed',
    'connector.registered',
    'connector.connected',
    'connector.revoked',
    'ai.paused',
    'ai.resumed',
    'run.aborted',
    -- 094: the security build
    'auth.factor_enrolled',
    'auth.factor_unenrolled',
    'auth.stepup',
    'auth.new_device',
    'account.locked',
    'account.unlocked',
    'matter.disconnected',
    'file.filed',
    'file.integrity',
    'file.opened',
    'file.flagged',
    'share.expired',
    'share.reviewed',
    'tripwire.tripped',
    'tripwire.cleared',
    -- 100: the Brief Desk
    'draft.snapshot',
    'cite.checked',
    'draft.exported',
    -- 120: the Model Comparator
    'comparison.created',
    'comparison.candidate',
    'comparison.graded',
    'comparison.assembled',
    'comparison.revealed'
  ))
$sql$;

raise notice '120: events_kind_check widened by five kinds (comparison.created, .candidate, .graded, .assembled, .revealed).';

end $migration$;

notify pgrst, 'reload schema';
