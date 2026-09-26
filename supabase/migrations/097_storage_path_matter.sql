-- 097_storage_path_matter.sql — a document's stored file is filed under the
-- document's own matter, and nowhere else
--
-- THE HOLE (pre-existing; found in the adversarial review of PR #247)
-- ---------------------------------------------------------------------------
-- Every object in vault-documents lives at "<matter id>/<document id>/<file>"
-- (016's convention), and the bucket's policies judge an object by that first
-- segment. Everything else judges a document by its row's matterspace_id.
-- Nothing made the two agree. `documents` INSERT/UPDATE policies check only
-- the row's matterspace_id, so a member of an OPEN matter — or someone who
-- once was a member and kept a path — could write a row there whose
-- storage_path names an object in a SEALED matter or another firm's matter.
-- The routes that read bytes with the service role after a user-scoped row
-- lookup (api/cloud-export, api/drive-export, api/ext/push-to-drive,
-- api/gmail-send, the worker's ingest, get_media from the stdio server) would
-- then fetch that object on the strength of the pointer row, and
-- lib/export-gate.mjs would judge the seal by the POINTER's matter. The raw
-- bytes of a matter the person cannot open would leave.
--
-- THE FIX
-- ---------------------------------------------------------------------------
-- A CHECK constraint: a documents row's storage_path, when present, begins
-- with that row's own matterspace_id. A pointer row can no longer be written
-- by anyone, the service role included. lib/storage-path.mjs asks the same
-- question in code right before each service-role read, so a route is safe
-- whether or not this file has been pasted.
--
-- Every writer of storage_path was checked against it (grep of api/, lib/,
-- worker/, src/): each builds "<the row's matter>/<row id>/<file>", and the
-- two MOVES (api/move-document.mjs; mcp-core move_document; the parent move in
-- lib/container-unpack.mjs) set matterspace_id and storage_path in ONE
-- UPDATE, which a CHECK sees as a single row change. copy_document strips
-- storage_path from the copied row and sets it afterwards to the target's
-- path. A move with no stored file changes matterspace_id only (null path).
--
-- Production audit (read-only, 2026-09-26): 0 of 46,475 documents rows
-- violate it. If that has changed by the time this is pasted, the ALTER fails
-- and names the constraint; nothing is half-applied.
--
-- Re-runnable. Needs nothing newer than 002.
-- ⚠ After pasting, run:  notify pgrst, 'reload schema';  (last statement here.)

alter table public.documents drop constraint if exists documents_storage_path_in_matter;
alter table public.documents add constraint documents_storage_path_in_matter
  check (storage_path is null or split_part(storage_path, '/', 1) = matterspace_id::text);

comment on constraint documents_storage_path_in_matter on public.documents is
  'A stored file lives under its document''s own matter (<matter>/<doc>/<file>). '
  'Refuses a row pointing at another matter''s object. Migration 097; lib/storage-path.mjs.';

notify pgrst, 'reload schema';
