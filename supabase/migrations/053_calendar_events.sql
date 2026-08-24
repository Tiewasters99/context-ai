-- 053_calendar_events.sql — the Contextspaces calendar
--
-- Until now the only calendar store was `matter_events` (025): every row
-- belongs to exactly one matter, carries a single date + optional time,
-- has no end, and has nowhere to record where an imported event came
-- from. That shape cannot hold (a) an appointment that belongs to no
-- matter, (b) an event with a real start and end, or (c) an event pulled
-- in from Google Calendar. So this migration adds a second table rather
-- than contorting the first.
--
-- Division of labour, deliberately:
--   matter_events    — matter DEADLINES. Untouched. Still drives the
--                      Practice Docket, the Dashboard's "Upcoming
--                      deadlines", and the activity_feed branch added
--                      by 025. The calendar reads and edits them.
--   calendar_events  — everything else the calendar owns: appointments,
--                      meetings, blocks of time, and imported Google
--                      events. `matterspace_id` is OPTIONAL.
--   list item `due`  — stays in content_items.content JSON. The calendar
--                      shows those dates read-only and links back to the
--                      list; it never copies them.
--
-- Dates are stored as `date` + optional `time`, not `timestamptz`, for
-- the same reason 025 did it: a calendar grid is drawn in the reader's
-- local days, and a timestamptz round-trip silently shifts an event
-- across midnight. Imported Google events are converted to the user's
-- IANA zone at import time (api/calendar-import.mjs sends the zone).
--
-- RLS follows the house pattern (048 / 051): an explicit owner clause so
-- INSERT..RETURNING passes the SELECT policy (the 047 lesson), and matter
-- visibility delegated to the SECURITY INVOKER wrapper from 022.
--
-- Apply order: after 051. Safe to re-run.

create table if not exists public.calendar_events (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null default auth.uid()
                         references auth.users(id) on delete cascade,

  -- Optional matter. Null = a personal entry that belongs to no matter.
  matterspace_id       uuid references public.matterspaces(id) on delete set null,

  title                text not null check (length(trim(title)) > 0),
  notes                text,
  location             text,

  -- start_time null  = all-day
  -- end_date   null  = same day as start
  start_date           date not null,
  start_time           time,
  end_date             date,
  end_time             time,

  event_type           text not null default 'event'
                         check (event_type in
                           ('event', 'deadline', 'hearing', 'filing',
                            'meeting', 'reminder', 'other')),

  -- Provenance. 'contextspaces' rows are user-authored and fully
  -- editable; imported rows are replaced wholesale on the next import.
  source               text not null default 'contextspaces'
                         check (source in ('contextspaces', 'google', 'outlook')),
  external_id          text,
  external_calendar_id text,
  external_link        text,
  external_tz          text,
  last_synced_at       timestamptz,

  completed_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists calendar_events_owner_date_idx
  on public.calendar_events (owner_id, start_date);
create index if not exists calendar_events_matter_idx
  on public.calendar_events (matterspace_id, start_date);

-- One row per imported external event, per owner. Import upserts on this
-- key, so re-importing updates in place instead of duplicating.
create unique index if not exists calendar_events_external_uniq
  on public.calendar_events (owner_id, source, external_calendar_id, external_id)
  where external_id is not null;

alter table public.calendar_events enable row level security;

-- SELECT: your own entries, plus entries other members filed against a
-- matter you can see. Matter visibility goes through the 022 INVOKER
-- wrapper, so it is evaluated as the calling user.
drop policy if exists "Calendar entries visible to owner or matter members"
  on public.calendar_events;
create policy "Calendar entries visible to owner or matter members"
on public.calendar_events for select
using (
  owner_id = auth.uid()
  or (
    matterspace_id is not null
    and exists (
      select 1 from public.matterspaces m
      where m.id = matterspace_id
        and public._mtspc_select_check(m.id, m.serverspace_id, m.parent_matterspace_id)
    )
  )
);

-- INSERT: always as yourself; if you attach a matter it must be one you
-- can see. The explicit owner clause is what lets INSERT..RETURNING work.
drop policy if exists "Users create their own calendar entries"
  on public.calendar_events;
create policy "Users create their own calendar entries"
on public.calendar_events for insert
with check (
  owner_id = auth.uid()
  and (
    matterspace_id is null
    or exists (
      select 1 from public.matterspaces m
      where m.id = matterspace_id
        and public._mtspc_select_check(m.id, m.serverspace_id, m.parent_matterspace_id)
    )
  )
);

-- UPDATE / DELETE: owner only. Seeing a colleague's matter entry does not
-- give you the right to move or delete it.
drop policy if exists "Owners update their calendar entries"
  on public.calendar_events;
create policy "Owners update their calendar entries"
on public.calendar_events for update
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists "Owners delete their calendar entries"
  on public.calendar_events;
create policy "Owners delete their calendar entries"
on public.calendar_events for delete
using (owner_id = auth.uid());

notify pgrst, 'reload schema';
