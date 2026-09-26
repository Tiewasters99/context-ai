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
-- A CHECK constraint: a documents row's storage_path, when present, has the
-- exact shape <matter>/<doc>/<file> (ROUND 2 below) and begins
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
-- ROUND 2 (adversarial review of #249) — the shape, not just the prefix
-- ---------------------------------------------------------------------------
-- A first-segment test is bypassable: Storage is reached by URL, and a URL
-- resolves dot segments, so "OPEN/../SEALED/doc/file" starts with OPEN and
-- names SEALED's object ("OPEN/../../discovery-files/…" even changes
-- bucket; "%2e%2e" and "..\" do the same). So the CHECK requires the exact
-- shape "<the row's matter uuid>/<segment>/<segment>" — three segments, none
-- empty, none "." or "..", no "%", no backslash. Case-sensitive, as uuid::text
-- is lower case. lib/storage-path.mjs asks the same, and refuses anything a
-- URL parser would rewrite besides.
--
-- The same class of hole in Discovery: production_items.native_storage_path
-- and display_storage_path are member-writable while a production is a draft
-- (030), and the worker reads them with the service role when it stamps and
-- packages. Their CHECK: "<the row's matter>/<the row's production>/…", same
-- segment rules. (Production objects are deeper than three segments:
-- <matter>/<production>/<item>/native/<file>.)
--
-- Production audit (read-only, 2026-09-26, round 2): ALL 46,496 documents
-- rows with a path are exactly <matter-uuid>/<doc>/<file> — 0 dot segments,
-- 0 '%', 0 backslashes, 0 empty segments, max length 282. production_items
-- has 0 rows. So the strict rule has no exceptions; if that has changed by
-- the time this is pasted, the ALTER fails whole and names the constraint.
--
-- Re-runnable. Needs 002 and 030.
-- ⚠ After pasting, run:  notify pgrst, 'reload schema';  (last statement here.)

alter table public.documents drop constraint if exists documents_storage_path_in_matter;
alter table public.documents add constraint documents_storage_path_in_matter
  check (
    storage_path is null or (
      storage_path ~ ('^' || matterspace_id::text || '/[^/]+/[^/]+$')
      and storage_path !~ '(^|/)\.{1,2}(/|$)'
      and position('%' in storage_path) = 0
      and position(chr(92) in storage_path) = 0
    )
  );

comment on constraint documents_storage_path_in_matter on public.documents is
  'A stored file lives under its document''s own matter, exactly <matter>/<doc>/<file>: '
  'no dot segments, no %, no backslash. Refuses a row pointing at another matter''s '
  'object, directly or by traversal. Migration 097; lib/storage-path.mjs.';

do $pi$
begin
  if to_regclass('public.production_items') is null then
    raise notice '097: public.production_items is absent (030 not applied) — its constraints skipped.';
    return;
  end if;

  execute $sql$
    alter table public.production_items drop constraint if exists production_items_paths_in_production
  $sql$;
  execute $sql$
    alter table public.production_items add constraint production_items_paths_in_production
      check (
        (native_storage_path is null or (
          native_storage_path ~ ('^' || matterspace_id::text || '/' || production_id::text || '/[^/]+(/[^/]+)*$')
          and native_storage_path !~ '(^|/)\.{1,2}(/|$)'
          and position('%' in native_storage_path) = 0
          and position(chr(92) in native_storage_path) = 0))
        and
        (display_storage_path is null or (
          display_storage_path ~ ('^' || matterspace_id::text || '/' || production_id::text || '/[^/]+(/[^/]+)*$')
          and display_storage_path !~ '(^|/)\.{1,2}(/|$)'
          and position('%' in display_storage_path) = 0
          and position(chr(92) in display_storage_path) = 0))
      )
  $sql$;
end $pi$;

notify pgrst, 'reload schema';
