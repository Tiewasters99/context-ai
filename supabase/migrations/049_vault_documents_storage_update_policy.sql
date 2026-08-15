-- 049_vault_documents_storage_update_policy.sql
--
-- Fixes: move_document fails for every non-service-role caller with the
-- misleading error "storage move: Object not found".
--
-- Cause: Supabase Storage implements move()/rename as an UPDATE of the
-- storage.objects row (the object's `name` column is rewritten). Migration
-- 016 replaced the vault-documents policies for SELECT, INSERT and DELETE
-- but never created one for UPDATE. With RLS enabled and no UPDATE policy,
-- the rename is denied, and the storage API reports a denied object as
-- 404 "Object not found" rather than 403 — so the failure looks like a
-- missing file even though the object is present.
--
-- Verified 2026-08-14: a service-role audit of all 118 documents in the
-- "CLE Presentations" serverspace found 118/118 storage objects present,
-- while api/move-document.mjs failed on whichever document was first in
-- the batch.
--
-- Paths are "<matter_id>/<doc_id>/<filename>", same convention as 016.
-- USING gates the source row, WITH CHECK gates the destination row, so a
-- move is permitted only when the caller can write BOTH the source and the
-- destination matter. can_write_matter() honours matter-level membership
-- and falls back to serverspace membership (see matter_role in 016).
--
-- Idempotent: safe to re-run.

drop policy if exists "Members can move vault-documents files within their matterspaces"
  on storage.objects;

create policy "Members can move vault-documents files within their matterspaces"
  on storage.objects for update
  using (
    bucket_id = 'vault-documents'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.can_write_matter(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id = 'vault-documents'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.can_write_matter(((storage.foldername(name))[1])::uuid)
  );
