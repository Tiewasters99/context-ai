-- ============================================================================
-- 106_document_workshop.sql — the Workshop beside a book
--
-- A reader of a scanned book snips a plate off a page, or copies a passage,
-- takes it away to make something from it (a clip in Flow, a still in
-- Midjourney), brings the result back, and lays the two side by side before
-- deciding whether the book should carry it. The Workshop panel in the Reader
-- (src/components/reader/WorkshopPanel.tsx) is that bench; this table is what
-- is on it.
--
-- Three kinds of item, one table:
--   snip     a rectangle on one page (fractions of the page box, the
--            document_annotations convention) and the quarter turn that makes
--            it upright — a recipe, never pixels: the picture is re-rendered
--            from the PDF, so crop = a new rect and rotate = a new turn, and
--            nothing is stored twice;
--   snippet  a passage of the page's text, for the law-student case: the
--            paragraph that a clip should illustrate;
--   media    a file brought back (an ordinary document filed in the same
--            matter, like 062's clips), sitting under its source
--            (parent_id) so the pair reads as original-and-derivative.
--
-- Laying a media item on the page is NOT recorded here: that is a
-- document_animations row (062), created from the source's page, rect and
-- turn — the Workshop is where the decision is made, 062 is the decision.
--
-- Security follows 062 to the letter: policies go through the SECURITY
-- INVOKER wrapper public._docann_doc_access(uuid) (048), and a media item
-- demands access to BOTH the book and the file, so a row can never point at a
-- document from another matter.
-- ============================================================================

create table if not exists public.document_workshop_items (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  page integer not null check (page > 0),
  kind text not null check (kind in ('snip', 'snippet', 'media')),
  -- snip: {"x":0.12,"y":0.08,"w":0.76,"h":0.62} — fractions of the page box.
  rect jsonb,
  -- Clockwise degrees that make the plate upright (snip; copied onto the
  -- animation when a media item is laid on the page).
  turn smallint not null default 0 check (turn in (0, 90, 180, 270)),
  -- snippet: the text.
  text text,
  -- media: the file, an ordinary document in the same matter.
  media_document_id uuid references public.documents(id) on delete cascade,
  -- media: the snip or snippet it was made from.
  parent_id uuid references public.document_workshop_items(id) on delete cascade,
  label text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_workshop_items_shape check (
    (kind = 'snip' and rect is not null and media_document_id is null)
    or (kind = 'snippet' and text is not null and media_document_id is null)
    or (kind = 'media' and media_document_id is not null)
  )
);

create index if not exists document_workshop_items_document_page_idx
  on public.document_workshop_items (document_id, page);
create index if not exists document_workshop_items_parent_idx
  on public.document_workshop_items (parent_id);
create index if not exists document_workshop_items_media_idx
  on public.document_workshop_items (media_document_id);

alter table public.document_workshop_items enable row level security;

drop policy if exists "Workshop items visible to author or matter" on public.document_workshop_items;
drop policy if exists "Users can insert their own workshop items" on public.document_workshop_items;
drop policy if exists "Users can update their own workshop items" on public.document_workshop_items;
drop policy if exists "Users can delete their own workshop items" on public.document_workshop_items;

create policy "Workshop items visible to author or matter"
  on public.document_workshop_items for select
  using (
    user_id = auth.uid()
    or public._docann_doc_access(document_id)
  );

create policy "Users can insert their own workshop items"
  on public.document_workshop_items for insert
  with check (
    user_id = auth.uid()
    and public._docann_doc_access(document_id)
    and (media_document_id is null or public._docann_doc_access(media_document_id))
  );

create policy "Users can update their own workshop items"
  on public.document_workshop_items for update
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and public._docann_doc_access(document_id)
    and (media_document_id is null or public._docann_doc_access(media_document_id))
  );

create policy "Users can delete their own workshop items"
  on public.document_workshop_items for delete
  using (user_id = auth.uid());

-- updated_at, kept by the schema's own trigger function (001).
drop trigger if exists update_document_workshop_items_updated_at on public.document_workshop_items;
create trigger update_document_workshop_items_updated_at
  before update on public.document_workshop_items
  for each row execute function public.update_updated_at();
