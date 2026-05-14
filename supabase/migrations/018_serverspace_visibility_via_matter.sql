-- Context.ai Migration 018: surface serverspaces to matter-only members
--
-- Migration 016 introduced matter-level membership so an outside co-counsel
-- could be added to one matter without seeing the rest of the serverspace.
-- But the serverspaces SELECT policy (migration 005) still required the
-- user to be a direct serverspace member to see the serverspace at all.
-- For a matter-only member that meant the sidebar's `serverspaces` query
-- returned 0 rows, and the matter tree couldn't render — they'd land on
-- contextspaces.ai with a blank sidebar even though their matter was
-- technically accessible.
--
-- This migration relaxes the policy: a user can see a serverspace if they
-- are a direct member OR if they have access to any matter under it (via
-- can_access_matter, which walks direct + ancestor + parent-serverspace
-- membership). The serverspace name + id are surfaced; matters inside
-- continue to be filtered by the existing matter RLS, so the user only
-- sees the matters they were actually shared.
--
-- Apply order: after 016.

drop policy if exists "Members can view serverspaces" on public.serverspaces;

create policy "Members can view serverspaces"
  on public.serverspaces for select
  using (
    public.is_serverspace_member(id)
    or exists (
      select 1 from public.matterspaces m
      where m.serverspace_id = serverspaces.id
        and public.can_access_matter(m.id)
    )
  );
