-- Context.ai Migration 011: book metadata on documents
--
-- EPUB ingestion pulls title/author/publisher from the OPF metadata.
-- Title already maps to documents.title; author and publisher need
-- their own nullable columns so MCP can surface them in citations and
-- list_matter_contents output without us reaching back into the
-- original file.
--
-- Both columns are nullable and default null; existing non-book rows
-- (transcripts, depositions, etc.) keep working unchanged.

alter table public.documents
  add column if not exists author text,
  add column if not exists publisher text;

create index if not exists idx_documents_author
  on public.documents(matterspace_id, author)
  where author is not null;
