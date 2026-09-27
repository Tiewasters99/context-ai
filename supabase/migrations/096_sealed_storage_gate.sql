-- 096_sealed_storage_gate.sql — S4a: the bytes of a sealed matter leave only
-- through a door that writes it down
--
-- docs/specs/SECURITY-BUILD-2026-09-26.md §S4a. Until this file, the browser
-- minted signed storage URLs for itself (src/lib/pdf-source.ts, the Reader's
-- Download, document-animations.ts, discovery.ts), so nothing in a matter's
-- Record could say that a sealed document had been opened or taken away (W6
-- §2 names this as the v2 gap). From this file on, for an object whose
-- matter's EFFECTIVE tier is sealed (B or C, on the matter or any ancestor —
-- 094's effective_tier_is_sealed), the bucket refuses a signed-in user and
-- api/document-url.mjs is the only way to its bytes: it checks the step-up
-- gate, mints a 900-second URL with the service role, and writes
-- `file.opened` (and, for a download, `file.exported`) to the matter's
-- Record. A URL whose Record row did not land is never handed out.
--
-- WHAT A SIGNED-IN USER CAN NO LONGER DO, on a sealed matter
-- ---------------------------------------------------------------------------
--   * fetch an object's bytes directly — `storage.from('vault-documents')
--     .download()` / `.createSignedUrl()` from a browser or from any server
--     path that forwards the user's own JWT. The storage API answers
--     "Object not found" (it reports a row RLS hides as a 404);
--   * the same for `discovery-files` (production display PDFs, natives,
--     packages), whose first path segment is the matter too;
--   * OVERWRITE an existing object (`upload(..., { upsert: true })` onto a
--     path that exists — an INSERT … ON CONFLICT DO UPDATE, which Postgres
--     checks against the SELECT policy on the existing row). The Vault's
--     plain-text editor (saveVaultDocumentText) is refused on sealed
--     matters from this file on;
--   * MOVE or COPY an object with the user's JWT — `storage.move()` is an
--     UPDATE … WHERE name = …, and a row the SELECT policy hides matches
--     nothing; copy reads the source. api/move-document.mjs now moves with
--     the service role after checking can_write_matter on both sides as the
--     user (the predicate 049's policy used), so a move keeps working. The
--     Workbench's server-side tools that pass the user's JWT to storage
--     (lib/mcp-core.mjs copy_document / move_document / assemble_documents /
--     edit_pdf / send_to_sandbox via api/sandbox.mjs, and the parent move in
--     lib/container-unpack.mjs) are refused at the bucket on a sealed matter.
--     They fail closed and say so; routing them is a follow-up (S7 decides
--     what may cross a sealed container's edge);
--   * DELETE an object — `storage.remove()` is a DELETE … WHERE name = …,
--     and Postgres applies the SELECT policy to the rows a DELETE reads, so
--     it matches nothing and Storage reports success. The Vault's "delete
--     document" in a sealed matter (vault-persist.ts deleteVaultDocument)
--     removes the documents row and LEAVES THE BYTES in the bucket, reachable
--     by the service role only. That is an orphan, not an opening (no row, no
--     policy, points at it any more) — and the same thing already happens
--     today when a plain member (not owner/admin: 016's DELETE policy)
--     deletes a document. A service-role sweep of objects with no documents
--     row is the follow-up.
--
-- WHAT STILL WORKS
-- ---------------------------------------------------------------------------
--   * everything on an unsealed (Tier A) matter, unchanged;
--   * the service role — the worker, api/ingest.mjs's download (now service
--     role after the caller's RLS lookup), the export routes (#167),
--     api/document-url.mjs — bypasses RLS and is untouched;
--   * UPLOADING a new file into a sealed matter. Supabase Storage writes the
--     objects row with INSERT … RETURNING (or an upsert), and Postgres checks
--     the returned row against the SELECT policy — so a plain "not sealed"
--     clause would refuse every upload into a sealed matter. The clause
--     therefore admits the row THIS TRANSACTION is writing: `created_at =
--     now()` (the column's default, and now() is the transaction's start).
--     No pre-existing object can pass it: changing created_at is an UPDATE,
--     and an UPDATE cannot reach a row the SELECT policy hides.
--     ⚠ This rests on Storage not setting created_at itself. Verified here
--     against Postgres's semantics only (scripts/_verify-sealed-download.mjs
--     part B). After pasting, upload one file into a sealed matter from the
--     Vault; if it fails with a row-level security error, this is why.
--
-- THE UPDATE POLICY. Migration 049 added "Members can move vault-documents
-- files within their matterspaces" (UPDATE, can_write_matter on both paths)
-- — spec §1's "no UPDATE policy on vault-documents" predates it and is out of
-- date. This file adds no UPDATE policy and does not change 049's. On a
-- sealed matter 049's policy is moot for a user session (above).
--
-- WHAT THIS DOES NOT COVER (said here and in the PR)
-- ---------------------------------------------------------------------------
-- The ROWS. `documents` and `passages` are still decided by
-- can_access_matter alone (094's header says why). A member can read a
-- sealed matter's extracted text through PostgREST; this file closes the
-- original bytes. And a URL, once handed out, is a bearer credential for its
-- 900 seconds — the Record says who asked for it and when, not who used it.
--
-- Apply order: after 094 (effective_tier_is_sealed). Refuses to run without
-- it: a storage gate that silently did nothing would be worse than none.
-- Re-runnable; executed twice by scripts/_verify-sealed-download.mjs.
--
-- ⚠ DEPLOY ORDER: 094 pasted, then the code deployed, then this file. With
--   the code live and 094 NOT pasted, the Reader's Download on a sealed
--   matter is refused (503 record_failed: 064's events do not yet admit
--   `file.opened`, and a sealed copy does not leave unrecorded) — correct,
--   fail-closed, and a surprise if nobody said so.
--   Deploy the code before pasting this file. Pasted first,
--   sealed documents stop opening in the Reader (the old code mints directly
--   and is refused) until the deploy lands. Nothing opens that should not.
--   The code merged before the paste is inert: the app asks the endpoint only
--   for a sealed matter, and the endpoint is correct with or without 096.


do $guard$
begin
  if to_regprocedure('public.effective_tier_is_sealed(uuid)') is null
     or to_regprocedure('stepup_internal.effective_tier_is_sealed(uuid)') is null then
    raise exception '096 needs migration 094 (effective_tier_is_sealed). Paste 094 first.';
  end if;
end $guard$;


-- ============================================================================
-- 1. The matter an object belongs to
-- ============================================================================
-- Every object in both buckets lives at "<matter_id>/…" (016's convention,
-- and 030's for discovery-files). The spec calls this matterspace_of(name).
-- NULL when the first segment is not uuid-shaped, so the cast can never throw
-- inside a policy (016 relies on AND order for that; this does not).
create or replace function public.storage_matter_of(p_name text)
returns uuid
language sql
immutable
as $$
  select case
    when split_part(coalesce(p_name, ''), '/', 1)
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(p_name, '/', 1)::uuid
  end
$$;

grant execute on function public.storage_matter_of(text) to authenticated, service_role;


-- ============================================================================
-- 1b. "Is this matter sealed?" answers only about matters you can open
-- ============================================================================
-- 094 granted public.effective_tier_is_sealed(uuid) to every signed-in user
-- (and, by Postgres's default, to PUBLIC — so anon too) and it answered for
-- ANY uuid: an oracle for which matters, anywhere, are sealed. From here the
-- public function answers NULL ("not yours to ask") for a matter the caller
-- cannot open; a caller with no JWT (the service role: the endpoint, the
-- worker) still gets the plain answer, and anon cannot call it at all.
--
-- NULL, not false: false would say "not sealed", and anything that trusted
-- it would fail OPEN. Which is also why no POLICY calls the public function
-- any more — the matterspaces policy (094) and the two storage policies below
-- call stepup_internal.effective_tier_is_sealed, the unwrapped definer walk,
-- which PostgREST does not expose. The search wrappers (094 §4b) keep the
-- public name: each asks can_access_matter first, so for them the answer is
-- unchanged.
create or replace function public.effective_tier_is_sealed(p_matter uuid)
returns boolean
language plpgsql
stable
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if p_matter is null then return false; end if;
  if v_uid is not null and not public.can_access_matter(p_matter) then return null; end if;
  return stepup_internal.effective_tier_is_sealed(p_matter);
end $$;

revoke all on function public.effective_tier_is_sealed(uuid) from public, anon;
grant execute on function public.effective_tier_is_sealed(uuid) to authenticated, service_role;

-- 094's matterspaces SELECT policy, word for word, but for the walk it calls.
drop policy if exists "Members can view matterspaces" on public.matterspaces;
create policy "Members can view matterspaces"
  on public.matterspaces for select
  using (
    public._mtspc_select_check(id, serverspace_id, parent_matterspace_id)
    and ((select public.sealed_entry_allowed()) or not stepup_internal.effective_tier_is_sealed(id))
  );


-- ============================================================================
-- 2. vault-documents — 016's SELECT policy, plus the seal
-- ============================================================================
-- `to authenticated`: the spec's words, and it keeps anon (which never had a
-- reason to be here — no anon policy exists on this bucket) from evaluating a
-- function it cannot execute.
drop policy if exists "Members can read vault-documents files in their matterspaces"
  on storage.objects;

create policy "Members can read vault-documents files in their matterspaces"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'vault-documents'
    and public.storage_matter_of(name) is not null
    and public.can_access_matter(public.storage_matter_of(name))
    and (
      not stepup_internal.effective_tier_is_sealed(public.storage_matter_of(name))
      -- the row this transaction is writing (an upload's RETURNING); see the header
      or created_at = now()
    )
  );


-- ============================================================================
-- 3. discovery-files — 030's SELECT policy, plus the seal
-- ============================================================================
-- Same rule, same reason: a production's display PDFs, natives and packages
-- in a sealed matter are that matter's bytes. 030's membership test
-- (serverspace members) is kept exactly.
drop policy if exists "Members read discovery files in their matterspaces"
  on storage.objects;

create policy "Members read discovery files in their matterspaces"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'discovery-files'
    and exists (
      select 1
      from public.matterspaces m
      join public.serverspaces s on s.id = m.serverspace_id
      join public.serverspace_members sm on sm.serverspace_id = s.id
      where m.id::text = (storage.foldername(storage.objects.name))[1]
        and sm.user_id = auth.uid()
    )
    and (
      not stepup_internal.effective_tier_is_sealed(public.storage_matter_of(name))
      or created_at = now()
    )
  );


notify pgrst, 'reload schema';
