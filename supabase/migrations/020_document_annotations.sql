-- Context.ai Migration 020: Document annotations (highlights + notes)
--
-- Per-user highlights anchored to a region of a document page. The reader
-- renders these as colored overlays beneath the pdfjs text layer so the
-- user can still select text on top to make new annotations.
--
-- Rects are stored as fractional bounding boxes (x, y, w, h ∈ [0, 1])
-- relative to the page width/height, so they scale cleanly to any zoom
-- level. anchor_text preserves the selected string for round-trip
-- validation / quote display.
--
-- RLS:
--   read   → anyone who can access the document's matter (matches the
--            existing documents-table SELECT policy from migration 002).
--            Highlights are matter-team visible — collaborators see each
--            other's annotations and who made them.
--   write  → user_id = auth.uid() AND has document access. Each user
--            owns their own annotations; you can't edit someone else's.

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

drop policy if exists "Members can read annotations in their matters" on public.document_annotations;
drop policy if exists "Users can insert their own annotations" on public.document_annotations;
drop policy if exists "Users can update their own annotations" on public.document_annotations;
drop policy if exists "Users can delete their own annotations" on public.document_annotations;

create policy "Members can read annotations in their matters"
  on public.document_annotations for select
  using (
    exists (
      select 1 from public.documents d
      where d.id = document_annotations.document_id
        and (
          d.matterspace_id is null
          or public.can_access_matter(d.matterspace_id)
        )
    )
  );

create policy "Users can insert their own annotations"
  on public.document_annotations for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.documents d
      where d.id = document_annotations.document_id
        and (
          d.matterspace_id is null
          or public.can_access_matter(d.matterspace_id)
        )
    )
  );

create policy "Users can update their own annotations"
  on public.document_annotations for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can delete their own annotations"
  on public.document_annotations for delete
  using (user_id = auth.uid());

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
