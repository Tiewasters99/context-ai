-- Serverspace creation fails with "new row violates row-level security
-- policy for table serverspaces" (2026-08-13).
--
-- Root cause: NewServerspaceModal inserts with .select('id') — i.e.
-- INSERT ... RETURNING. Postgres requires rows surfaced by RETURNING to
-- pass a SELECT policy, and the live SELECT policy only granted
-- is_serverspace_member(id). Owner membership is added by the AFTER
-- INSERT trigger (006), which is too late for the RETURNING check, so
-- the whole insert is rejected even though the INSERT policy passes.
--
-- Note on drift: the live SELECT policy was found in its migration-005
-- form — migration 018's shared-matter visibility clause had been lost
-- (an old saved query re-applied 005 at some point). This migration
-- restores 018's clause AND adds the clientspace-owner clause.
--
-- The owner clause is also correct product behaviour on its own: the
-- owner of a clientspace always sees the serverspaces inside it,
-- membership row or not.
--
-- Apply order: after 018 (supersedes its SELECT policy).

drop policy if exists "Members can view serverspaces" on public.serverspaces;

create policy "Members can view serverspaces"
  on public.serverspaces for select
  using (
    public.is_serverspace_member(id)
    or exists (
      select 1 from public.clientspaces c
      where c.id = serverspaces.clientspace_id
        and c.user_id = auth.uid()
    )
    or exists (
      select 1 from public.matterspaces m
      where m.serverspace_id = serverspaces.id
        and public.can_access_matter(m.id)
    )
  );
