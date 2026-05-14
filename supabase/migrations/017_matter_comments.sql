-- Context.ai Migration 017: Matter-level comment thread
--
-- A shared conversation per matter. Not anchored to specific text (inline
-- annotation is a separate feature). Use case: co-counsel review, partner
-- sign-off, status updates, "did anyone check X" questions — the kind of
-- back-and-forth that today happens in email or Slack and gets lost.
--
-- One row per comment. Threading is one level deep via parent_id (a reply
-- can have a parent, but a reply-to-a-reply collapses to the same level).
-- Soft delete via deleted_at so an admin's audit trail is preserved if a
-- comment is removed.
--
-- RLS:
--   read   → can_access_matter (any role, including viewer)
--   insert → can_access_matter + user_id = auth.uid()
--   update → user_id = auth.uid() (own comments only)
--   delete → user_id = auth.uid() OR can_manage_matter (admins can remove)
--
-- Viewers can post comments by design. Comments are a communication
-- mechanism, not a modification of the matter content — restricting them
-- to edit-rights would break the "client-as-viewer" case.

-- ============================================================================
-- Table
-- ============================================================================

create table if not exists public.matter_comments (
  id uuid primary key default uuid_generate_v4(),
  matterspace_id uuid references public.matterspaces(id) on delete cascade not null,
  user_id uuid references public.profiles(id) on delete cascade not null,
  parent_id uuid references public.matter_comments(id) on delete cascade,
  body text not null check (length(trim(body)) > 0 and length(body) <= 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  deleted_at timestamptz
);

create index if not exists idx_matter_comments_matter_created
  on public.matter_comments(matterspace_id, created_at)
  where deleted_at is null;
create index if not exists idx_matter_comments_parent
  on public.matter_comments(parent_id)
  where parent_id is not null;
create index if not exists idx_matter_comments_user
  on public.matter_comments(user_id);

alter table public.matter_comments enable row level security;


-- ============================================================================
-- RLS
-- ============================================================================

drop policy if exists "Members can read matter comments" on public.matter_comments;
drop policy if exists "Members can post matter comments" on public.matter_comments;
drop policy if exists "Authors can edit their own comments" on public.matter_comments;
drop policy if exists "Authors or admins can delete comments" on public.matter_comments;

create policy "Members can read matter comments"
  on public.matter_comments for select
  using (public.can_access_matter(matterspace_id));

create policy "Members can post matter comments"
  on public.matter_comments for insert
  with check (
    user_id = auth.uid()
    and public.can_access_matter(matterspace_id)
  );

create policy "Authors can edit their own comments"
  on public.matter_comments for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Hard delete intentionally restricted — for soft-delete (mark deleted_at)
-- we use UPDATE under the "Authors can edit" policy. This DELETE policy
-- is here for true row removal (admin pruning).
create policy "Authors or admins can delete comments"
  on public.matter_comments for delete
  using (
    user_id = auth.uid()
    or public.can_manage_matter(matterspace_id)
  );


-- ============================================================================
-- Realtime
-- ============================================================================
-- Surface inserts/updates/deletes to subscribed clients. RLS still applies
-- on the receive side, so a subscriber only gets payloads for matters they
-- have access to.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'matter_comments'
  ) then
    execute 'alter publication supabase_realtime add table public.matter_comments';
  end if;
end $$;
