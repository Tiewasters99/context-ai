-- Context.ai Migration 004: RLS policies on matterspaces
--
-- Migration 001 enabled row level security on public.matterspaces but
-- never added any policies. With RLS on and zero policies, Postgres
-- denies every row to anyone except service_role. This was invisible
-- while every query went through service_role (local stdio MCP, CLI
-- scripts) and also invisible in the web UI because the web UI has
-- not yet tried to read matterspaces through the authenticated user
-- client. The moment the hosted HTTP MCP (api/mcp.mjs) minted a
-- user JWT and queried matterspaces as that user, the bug surfaced:
-- list_matters returned [] instead of the user's actual matters.
--
-- Policies mirror the existing serverspaces pattern from migration
-- 001: membership in the parent serverspace drives visibility, and
-- role gates mutation.

-- SELECT: any member of the parent serverspace
create policy "Members can view matterspaces"
  on public.matterspaces for select
  using (
    exists (
      select 1 from public.serverspace_members sm
      where sm.serverspace_id = matterspaces.serverspace_id
        and sm.user_id = auth.uid()
    )
  );

-- INSERT: owners and admins of the parent serverspace
create policy "Admins can insert matterspaces"
  on public.matterspaces for insert
  with check (
    exists (
      select 1 from public.serverspace_members sm
      where sm.serverspace_id = matterspaces.serverspace_id
        and sm.user_id = auth.uid()
        and sm.role in ('owner','admin')
    )
  );

-- UPDATE: owners and admins of the parent serverspace
create policy "Admins can update matterspaces"
  on public.matterspaces for update
  using (
    exists (
      select 1 from public.serverspace_members sm
      where sm.serverspace_id = matterspaces.serverspace_id
        and sm.user_id = auth.uid()
        and sm.role in ('owner','admin')
    )
  );

-- DELETE: only owners of the parent serverspace
create policy "Owners can delete matterspaces"
  on public.matterspaces for delete
  using (
    exists (
      select 1 from public.serverspace_members sm
      where sm.serverspace_id = matterspaces.serverspace_id
        and sm.user_id = auth.uid()
        and sm.role = 'owner'
    )
  );
