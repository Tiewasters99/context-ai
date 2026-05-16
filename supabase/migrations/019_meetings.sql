-- Context.ai Migration 019: Meetings (Grapheon Connect integration)
--
-- Live meeting transcription + Claude advisor, integrated as a matter feature.
-- Ported from the standalone Grapheon Connect app — see
-- docs/CONNECT_INTEGRATION.md for the full spec.
--
-- A meeting is a recording session: live transcript chunks captured from a
-- phone-on-table mic via Deepgram, plus user↔assistant chat messages and
-- proactive "watchpoint" flags raised by Claude scanning the transcript.
--
-- Linkage to matter is OPTIONAL. A meeting can be created standalone (e.g.
-- "+ New meeting" from the global shell) and linked to a matter later via
-- "Save to matter." Unlinked meetings are owner-only; linked meetings
-- follow the matter's access rules.
--
-- RLS:
--   read   → matter member (if linked) OR creator (if unlinked)
--   insert → creator = auth.uid()
--   update → matter manager (if linked) OR creator
--   delete → matter manager (if linked) OR creator
--
-- The same access rule applies transitively to meeting_chunks and
-- meeting_messages via the security-definer helper can_access_meeting().

-- ============================================================================
-- Tables
-- ============================================================================

create table if not exists public.meetings (
  id uuid primary key default uuid_generate_v4(),
  matterspace_id uuid references public.matterspaces(id) on delete set null,
  created_by uuid references public.profiles(id) on delete cascade not null,
  title text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'active' check (status in ('active', 'ended', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_meetings_matterspace
  on public.meetings(matterspace_id)
  where matterspace_id is not null;
create index if not exists idx_meetings_created_by
  on public.meetings(created_by, started_at desc);

create table if not exists public.meeting_chunks (
  id uuid primary key default uuid_generate_v4(),
  meeting_id uuid references public.meetings(id) on delete cascade not null,
  text text not null,
  speaker int,
  start_seconds double precision not null,
  end_seconds double precision not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_meeting_chunks_meeting
  on public.meeting_chunks(meeting_id, start_seconds);

create table if not exists public.meeting_messages (
  id uuid primary key default uuid_generate_v4(),
  meeting_id uuid references public.meetings(id) on delete cascade not null,
  role text not null check (role in ('user', 'assistant', 'flag')),
  flag_type text check (flag_type in ('contradiction', 'factual_error', 'commitment', 'opportunity', 'risk')),
  content text not null,
  anchor text,
  created_at timestamptz not null default now(),
  -- A flag row must carry its flag_type; a chat row must not.
  constraint flag_type_matches_role check (
    (role = 'flag' and flag_type is not null)
    or (role in ('user', 'assistant') and flag_type is null)
  )
);

create index if not exists idx_meeting_messages_meeting
  on public.meeting_messages(meeting_id, created_at);


-- ============================================================================
-- Access helper
-- ============================================================================
-- Centralizes the "can the current user see/touch this meeting?" rule so RLS
-- on chunks and messages stays a one-liner. Security definer so RLS on
-- public.meetings doesn't infinite-recurse when checking child tables.

create or replace function public.can_access_meeting(p_meeting_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.meetings m
    where m.id = p_meeting_id
      and (
        (m.matterspace_id is not null and public.can_access_matter(m.matterspace_id))
        or m.created_by = auth.uid()
      )
  );
$$;

create or replace function public.can_manage_meeting(p_meeting_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.meetings m
    where m.id = p_meeting_id
      and (
        (m.matterspace_id is not null and public.can_manage_matter(m.matterspace_id))
        or m.created_by = auth.uid()
      )
  );
$$;


-- ============================================================================
-- RLS
-- ============================================================================

alter table public.meetings enable row level security;
alter table public.meeting_chunks enable row level security;
alter table public.meeting_messages enable row level security;

-- meetings ----------------------------------------------------------------

drop policy if exists "Members or creator can read meetings" on public.meetings;
drop policy if exists "Creator can insert meetings" on public.meetings;
drop policy if exists "Manager or creator can update meetings" on public.meetings;
drop policy if exists "Manager or creator can delete meetings" on public.meetings;

create policy "Members or creator can read meetings"
  on public.meetings for select
  using (
    (matterspace_id is not null and public.can_access_matter(matterspace_id))
    or created_by = auth.uid()
  );

create policy "Creator can insert meetings"
  on public.meetings for insert
  with check (
    created_by = auth.uid()
    and (matterspace_id is null or public.can_access_matter(matterspace_id))
  );

create policy "Manager or creator can update meetings"
  on public.meetings for update
  using (
    created_by = auth.uid()
    or (matterspace_id is not null and public.can_manage_matter(matterspace_id))
  )
  with check (
    -- After update: if the user is moving the meeting to a different matter,
    -- they need access to the destination matter.
    matterspace_id is null
    or public.can_access_matter(matterspace_id)
  );

create policy "Manager or creator can delete meetings"
  on public.meetings for delete
  using (
    created_by = auth.uid()
    or (matterspace_id is not null and public.can_manage_matter(matterspace_id))
  );

-- meeting_chunks ----------------------------------------------------------

drop policy if exists "Read chunks via meeting access" on public.meeting_chunks;
drop policy if exists "Write chunks via meeting access" on public.meeting_chunks;
drop policy if exists "Delete chunks via meeting management" on public.meeting_chunks;

create policy "Read chunks via meeting access"
  on public.meeting_chunks for select
  using (public.can_access_meeting(meeting_id));

create policy "Write chunks via meeting access"
  on public.meeting_chunks for insert
  with check (public.can_access_meeting(meeting_id));

create policy "Delete chunks via meeting management"
  on public.meeting_chunks for delete
  using (public.can_manage_meeting(meeting_id));

-- meeting_messages --------------------------------------------------------

drop policy if exists "Read messages via meeting access" on public.meeting_messages;
drop policy if exists "Write messages via meeting access" on public.meeting_messages;
drop policy if exists "Delete messages via meeting management" on public.meeting_messages;

create policy "Read messages via meeting access"
  on public.meeting_messages for select
  using (public.can_access_meeting(meeting_id));

create policy "Write messages via meeting access"
  on public.meeting_messages for insert
  with check (public.can_access_meeting(meeting_id));

create policy "Delete messages via meeting management"
  on public.meeting_messages for delete
  using (public.can_manage_meeting(meeting_id));


-- ============================================================================
-- updated_at trigger on meetings
-- ============================================================================

create or replace function public.set_meetings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_meetings_updated_at on public.meetings;
create trigger trg_meetings_updated_at
  before update on public.meetings
  for each row execute function public.set_meetings_updated_at();
