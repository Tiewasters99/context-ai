-- Context.ai Migration 021: Document attachments on matter comments
--
-- Lets users attach one or more documents from the matter's vault to a
-- thread comment. Attachments render inline in the thread as chips that
-- open the reader. Use case: "@Sarah see Exhibit 4 ¶ 12 — does this
-- support the venue argument?" with Exhibit 4 right there in-line.
--
-- Stored as a uuid[] of document_ids on the existing matter_comments
-- table. RLS on documents already gates read access by matter membership,
-- so the IDs alone are safe to surface to anyone with comment access —
-- when the reader tries to open one, the documents-table RLS does the
-- real check. Cross-matter attachments are prevented at the app layer
-- (the picker only shows docs from the comment's matter).

alter table public.matter_comments
  add column if not exists attachment_document_ids uuid[] not null default '{}';

create index if not exists idx_matter_comments_attachments
  on public.matter_comments using gin (attachment_document_ids);
