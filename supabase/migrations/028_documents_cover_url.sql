-- Cover image support for Vault documents.
--
-- Pages, lists, tables, matterspaces, and serverspaces all carry a
-- cover_url today; documents were the only persistent surface without
-- one. Adding the column lets the DocumentReader mount the existing
-- CoverImage component above its toolbar and reuse the cover-images
-- storage bucket, so Pages and Documents share the same picker,
-- upload, and library.
--
-- Nullable text URL — null means "no cover", same convention as
-- content_items.cover_url. RLS for documents is already in place;
-- this column inherits the row-level policies.

alter table documents
  add column if not exists cover_url text;
