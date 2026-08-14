-- Context.ai Migration 048: Marginalia — visibility, addressing, and links
--
-- Phase 1 of the margin-notes design (2026-08-14). The reader's side margins
-- become a quiet annotation layer: a note is an utterance anchored at a
-- page position (page + fractional rects + verbatim anchor_text, per
-- migration 020), collapsed to a small mark in the margin.
--
-- This migration builds on document_annotations rather than adding a parallel
-- table — the anchoring machinery (page, rects, anchor_text) is the same one
-- the reader's highlights use. NOTE: that table was declared in migration 020
-- but never applied to production, so this file creates it if absent (see the
-- next section) before adding the marginalia columns.
--
--   * visibility: 'matter' (default — the document is common property),
--     'private' (note to self; can be flipped to 'matter' later), and
--     'client_shared' (reserved for the client layer — clients never see
--     the team layer and can only ever author into client_shared; treated
--     as matter-visible until client roles land in a later phase).
--   * addressee_user_id / addressed_to_ai: routing metadata for later
--     phases (@teammate → inbox + thread; @claude → research task whose
--     prompt stays visible as the first entry of the thread). Carried in
--     the schema now so those phases need no migration; Phase 1 UI never
--     sets them.
--   * line_start / line_end: page:line citation display, populated when
--     the anchor can be matched to an ingested passage. The verbatim
--     anchor_text remains the ground truth (deposition-fidelity rule);
--     line numbers are the address, the quote is the anchor.
--   * annotation_links: a note can point at a passage of another document
--     in the matter ("seems contradictory with Smith" → Smith depo 45:12).
--     Indexed in both directions, so "which notes point AT this page" is
--     one query — margin cross-reference marks fall out of the link graph.
--
-- RLS: rewritten through a SECURITY INVOKER wrapper per migration 022 and
-- the standing rule (feedback_rls_security_invoker_wrappers): policy
-- expressions never call the SECURITY DEFINER helpers directly. The
-- author-visibility clause (user_id = auth.uid()) also guarantees that
-- INSERT .. RETURNING passes the SELECT policy with no trigger dependency
-- (the 42501 class of bug from migrations 022/047).

-- ============================================================================
-- Base table (from migration 020, which never reached production)
--
-- Verified 2026-08-14 against the live database: public.document_annotations
-- did not exist, so 048's ALTER failed with 42P01. Migration 020 was written
-- but never applied — the same live-DB-vs-migrations drift documented in
-- migration 047's notes. Recreated here (idempotently) so this file applies
-- cleanly to prod and to any dev DB that *does* have 020.
--
-- 020's four RLS policies are deliberately NOT recreated: they called the
-- SECURITY DEFINER helper can_access_matter() directly from the policy
-- expression, which is the latent 42501 bug class described in migration 022.
-- The policies further down this file supersede them.
--
-- Rects are fractional bounding boxes (x, y, w, h ∈ [0,1]) relative to the
-- page, so they scale to any zoom. anchor_text preserves the selected string.
-- ============================================================================

create table if not exists public.document_annotations (
  id uuid primary key default uuid_generate_v4(),
  document_id uuid references public.documents(id) on delete cascade not null,
  user_id uuid references public.profiles(id) on delete cascade not null,
  page int not null check (page >= 1),
  color text not null default 'gold'
    check (color in ('gold', 'green', 'pink', 'blue')),
  note text,
  anchor_text text,
  rects jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_document_annotations_doc_page
  on public.document_annotations(document_id, page);
create index if not exists idx_document_annotations_user
  on public.document_annotations(user_id);

alter table public.document_annotations enable row level security;

create or replace function public.set_document_annotations_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_document_annotations_updated_at on public.document_annotations;
create trigger trg_document_annotations_updated_at
  before update on public.document_annotations
  for each row execute function public.set_document_annotations_updated_at();

-- ============================================================================
-- Marginalia columns
-- ============================================================================

alter table public.document_annotations
  add column if not exists visibility text not null default 'matter'
    check (visibility in ('private', 'matter', 'client_shared')),
  add column if not exists addressee_user_id uuid
    references public.profiles(id) on delete set null,
  add column if not exists addressed_to_ai boolean not null default false,
  add column if not exists line_start int check (line_start >= 1),
  add column if not exists line_end int check (line_end >= 1);

comment on column public.document_annotations.visibility is
  'private = author only (note to self); matter = whole matter team; client_shared = client layer (clients can only ever author/see this value).';
comment on column public.document_annotations.addressee_user_id is
  'Phase 2 (@teammate). NULL in Phase 1.';
comment on column public.document_annotations.addressed_to_ai is
  'Phase 3 (@claude). The prompt is the note body and stays visible; the answer arrives as a reply.';

-- ============================================================================
-- annotation_links — notes pointing at passages of other documents
-- ============================================================================

create table if not exists public.annotation_links (
  id uuid primary key default uuid_generate_v4(),
  annotation_id uuid not null
    references public.document_annotations(id) on delete cascade,
  target_document_id uuid not null
    references public.documents(id) on delete cascade,
  target_page int check (target_page >= 1),
  target_line int check (target_line >= 1),
  label text,
  created_at timestamptz not null default now()
);

comment on table public.annotation_links is
  'Bidirectional link graph for marginalia: forward = the note cites a passage; reverse (by target_document_id) = cross-reference marks on the cited document.';

create index if not exists idx_annotation_links_annotation
  on public.annotation_links(annotation_id);
create index if not exists idx_annotation_links_target
  on public.annotation_links(target_document_id, target_page);

alter table public.annotation_links enable row level security;

-- ============================================================================
-- SECURITY INVOKER access wrapper
--
-- Document-level access = the document's matter passes the canonical
-- matterspaces SELECT check (022's _mtspc_select_check, itself INVOKER).
-- Matterless documents follow the migration-020 convention (accessible).
-- ============================================================================

create or replace function public._docann_doc_access(p_document_id uuid)
returns boolean
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  return exists (
    select 1
    from public.documents d
    left join public.matterspaces m on m.id = d.matterspace_id
    where d.id = p_document_id
      and (
        d.matterspace_id is null
        or public._mtspc_select_check(m.id, m.serverspace_id, m.parent_matterspace_id)
      )
  );
end $$;

grant execute on function public._docann_doc_access(uuid)
  to authenticated, service_role;

-- ============================================================================
-- document_annotations policies (replace migration 020's)
-- ============================================================================

drop policy if exists "Members can read annotations in their matters" on public.document_annotations;
drop policy if exists "Users can insert their own annotations" on public.document_annotations;
drop policy if exists "Users can update their own annotations" on public.document_annotations;
drop policy if exists "Users can delete their own annotations" on public.document_annotations;

-- Authors always see their own rows (private notes, and RETURNING on insert).
-- Everyone else needs document access AND a non-private row.
create policy "Annotations visible to author or matter"
  on public.document_annotations for select
  using (
    user_id = auth.uid()
    or (visibility <> 'private' and public._docann_doc_access(document_id))
  );

create policy "Users can insert their own annotations"
  on public.document_annotations for insert
  with check (
    user_id = auth.uid()
    and public._docann_doc_access(document_id)
  );

create policy "Users can update their own annotations"
  on public.document_annotations for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can delete their own annotations"
  on public.document_annotations for delete
  using (user_id = auth.uid());

-- ============================================================================
-- annotation_links policies
--
-- Visibility derives from the parent annotation: the EXISTS subquery runs
-- under the caller's own RLS on document_annotations, so a link is visible
-- exactly when its note is (same pattern migration 020 used against
-- documents). Writes require authorship of the note.
-- ============================================================================

drop policy if exists "Links visible with their annotation" on public.annotation_links;
drop policy if exists "Authors can add links to their annotations" on public.annotation_links;
drop policy if exists "Authors can remove links from their annotations" on public.annotation_links;

create policy "Links visible with their annotation"
  on public.annotation_links for select
  using (
    exists (
      select 1 from public.document_annotations a
      where a.id = annotation_links.annotation_id
    )
  );

create policy "Authors can add links to their annotations"
  on public.annotation_links for insert
  with check (
    exists (
      select 1 from public.document_annotations a
      where a.id = annotation_links.annotation_id
        and a.user_id = auth.uid()
    )
    and public._docann_doc_access(target_document_id)
  );

create policy "Authors can remove links from their annotations"
  on public.annotation_links for delete
  using (
    exists (
      select 1 from public.document_annotations a
      where a.id = annotation_links.annotation_id
        and a.user_id = auth.uid()
    )
  );

-- ============================================================================
-- Realtime — margin notes appear live for the matter team (matches the
-- matter_comments precedent from 017; RLS applies on the receive side).
-- ============================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'document_annotations'
  ) then
    execute 'alter publication supabase_realtime add table public.document_annotations';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'annotation_links'
  ) then
    execute 'alter publication supabase_realtime add table public.annotation_links';
  end if;
end $$;

notify pgrst, 'reload schema';
