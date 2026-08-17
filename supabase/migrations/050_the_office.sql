-- Context.ai Migration 050: The Office — publish from the vault to the firm's public room
--
-- The Office (2026-08-17) is the externally-facing face of the workspace: a
-- photoreal walkable office (currently the Office v.1 depth-parallax build)
-- whose Library shelves and Practice Areas are POPULATED FROM Contextspaces.
-- The owner drags a document into an Office section in the app; the public
-- office fetches a read-only manifest and the item appears on its shelf.
-- "The more you fill your back end, the richer your front-end office."
--
-- Two tables:
--   * office_sections — the section tree, mirroring the public office's menu:
--       kind 'library'  → a shelf/study in THE LIBRARY (e.g. "CLE Presentations")
--       kind 'practice' → an entry under AREAS OF PRACTICE (e.g. "Defamation")
--       kind 'cle'      → reserved alias for library-style CLE shelves
--       kind 'page'     → reserved for future editable pages (About, etc.)
--   * office_items — what is SHOWN in a section. Usually born from a vault
--     document (document_id kept as provenance; on delete set null so the
--     public item survives the vault reshuffle), with a display title,
--     author line, excerpt, and spine color for the library shelf.
--
-- One-way glass: there are NO anon/public RLS policies here. The public
-- reads exclusively through the service-role manifest endpoint
-- (/api/office), which serves published rows only — metadata and excerpts,
-- never files. Nothing in the office links back to storage.
--
-- RLS: owner-only, expressed directly as owner_id = auth.uid() in every
-- policy — no helper functions, so the 42501 INSERT..RETURNING bug class
-- (migrations 022/047/048) cannot arise: the SELECT policy is satisfied
-- by construction for freshly inserted rows.

create table if not exists public.office_sections (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid not null default auth.uid(),
  kind text not null check (kind in ('library', 'practice', 'cle', 'page')),
  title text not null,
  blurb text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.office_items (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid not null default auth.uid(),
  section_id uuid not null references public.office_sections(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  title text not null,
  author text not null default '',
  excerpt text not null default '',
  spine text not null default '#39505f',
  published boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists office_items_section_idx
  on public.office_items (section_id, sort_order);
create index if not exists office_sections_owner_idx
  on public.office_sections (owner_id, kind, sort_order);

alter table public.office_sections enable row level security;
alter table public.office_items enable row level security;

drop policy if exists office_sections_select on public.office_sections;
create policy office_sections_select on public.office_sections
  for select using (owner_id = auth.uid());
drop policy if exists office_sections_insert on public.office_sections;
create policy office_sections_insert on public.office_sections
  for insert with check (owner_id = auth.uid());
drop policy if exists office_sections_update on public.office_sections;
create policy office_sections_update on public.office_sections
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists office_sections_delete on public.office_sections;
create policy office_sections_delete on public.office_sections
  for delete using (owner_id = auth.uid());

drop policy if exists office_items_select on public.office_items;
create policy office_items_select on public.office_items
  for select using (owner_id = auth.uid());
drop policy if exists office_items_insert on public.office_items;
create policy office_items_insert on public.office_items
  for insert with check (owner_id = auth.uid());
drop policy if exists office_items_update on public.office_items;
create policy office_items_update on public.office_items
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists office_items_delete on public.office_items;
create policy office_items_delete on public.office_items
  for delete using (owner_id = auth.uid());
