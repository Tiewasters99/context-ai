-- ============================================================================
-- 062_document_animations.sql — living illustrations
--
-- A clip attached to a rectangle on one page of a document: the plate in a
-- scanned book that should come alive when it is tapped. The row is a recipe,
-- never pixels — the clip itself is an ordinary document filed in the same
-- matter (`media_document_id`), and the rectangle is stored in fractions of
-- the page box, exactly like `document_annotations.rects`, so it survives any
-- zoom, page size or device.
--
-- `turn` is what the plate needs to be upright: landscape illustrations are
-- often printed turned a quarter turn to fit a portrait page, and the reader
-- should never have to rotate anything by hand — whoever attaches the clip
-- records it once, and one tap turns the plate and plays.
--
-- Security follows 048's rule to the letter: policy expressions go through the
-- SECURITY INVOKER wrapper `public._docann_doc_access(uuid)` (defined in 048,
-- itself calling 022's `_mtspc_select_check`), never a SECURITY DEFINER helper
-- directly. Inserting demands access to BOTH the book and the clip, so an
-- animation can never quietly point at a document from another matter.
-- ============================================================================

create table if not exists public.document_animations (
  id uuid primary key default gen_random_uuid(),
  -- The document being read (the book), and the clip that plays on it.
  document_id uuid not null references public.documents(id) on delete cascade,
  media_document_id uuid not null references public.documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  page integer not null check (page > 0),
  -- {"x":0.12,"y":0.08,"w":0.76,"h":0.62} — fractions of the page box.
  rect jsonb not null,
  -- Clockwise degrees that make the illustration upright.
  turn smallint not null default 0 check (turn in (0, 90, 180, 270)),
  loops boolean not null default true,
  label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists document_animations_document_page_idx
  on public.document_animations (document_id, page);
create index if not exists document_animations_media_idx
  on public.document_animations (media_document_id);

alter table public.document_animations enable row level security;

-- ============================================================================
-- Policies
--
-- The author always sees their own rows (this is also what lets
-- `insert … returning` pass the SELECT check); everyone else needs access to
-- the document the clip is attached to.
-- ============================================================================

drop policy if exists "Animations visible to author or matter" on public.document_animations;
drop policy if exists "Users can insert their own animations" on public.document_animations;
drop policy if exists "Users can update their own animations" on public.document_animations;
drop policy if exists "Users can delete their own animations" on public.document_animations;

create policy "Animations visible to author or matter"
  on public.document_animations for select
  using (
    user_id = auth.uid()
    or public._docann_doc_access(document_id)
  );

create policy "Users can insert their own animations"
  on public.document_animations for insert
  with check (
    user_id = auth.uid()
    and public._docann_doc_access(document_id)
    and public._docann_doc_access(media_document_id)
  );

create policy "Users can update their own animations"
  on public.document_animations for update
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and public._docann_doc_access(document_id)
    and public._docann_doc_access(media_document_id)
  );

create policy "Users can delete their own animations"
  on public.document_animations for delete
  using (user_id = auth.uid());
