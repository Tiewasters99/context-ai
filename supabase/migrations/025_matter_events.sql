-- Context.ai Migration 025: matter_events — the internal calendar
--
-- Matter-scoped deadlines and events, native to Contextspaces, no
-- external integration. A lawyer adds what's due (filing deadlines,
-- hearings, statute-of-limitations dates, reminders) to a matter; it
-- surfaces in the matter's Calendar tab, on the Dashboard's "Upcoming
-- deadlines", and in the activity feed. When Google Calendar is wired
-- later, it syncs INTO this table rather than replacing it.
--
-- RLS uses the SECURITY INVOKER pattern from the start (the migration
-- 022 lesson, applied proactively to a new table). Visibility delegates
-- to matterspaces RLS: you can see/manage a matter's events exactly
-- when you can see the matter itself.
--
-- Apply order: after 024.

create table if not exists public.matter_events (
  id uuid primary key default gen_random_uuid(),
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  event_date date not null,
  event_time time,                          -- null = all-day
  event_type text not null default 'deadline'
    check (event_type in ('deadline', 'hearing', 'filing', 'reminder', 'other')),
  notes text,
  completed_at timestamptz,                 -- non-null = checked off
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_matter_events_matter
  on public.matter_events(matterspace_id);
create index if not exists idx_matter_events_date
  on public.matter_events(event_date);

alter table public.matter_events enable row level security;

-- SECURITY INVOKER access check — delegates to matterspaces RLS. The
-- inner SELECT is RLS-checked as the calling user, so this returns true
-- exactly when the caller can see the matter.
create or replace function public._matter_events_access(p_matter_id uuid)
returns boolean
language plpgsql
security invoker
as $$
begin
  return exists (select 1 from public.matterspaces where id = p_matter_id);
end $$;

grant execute on function public._matter_events_access(uuid)
  to authenticated, service_role;

drop policy if exists "View matter events" on public.matter_events;
create policy "View matter events"
  on public.matter_events for select
  using (public._matter_events_access(matterspace_id));

drop policy if exists "Insert matter events" on public.matter_events;
create policy "Insert matter events"
  on public.matter_events for insert
  with check (public._matter_events_access(matterspace_id));

drop policy if exists "Update matter events" on public.matter_events;
create policy "Update matter events"
  on public.matter_events for update
  using (public._matter_events_access(matterspace_id));

drop policy if exists "Delete matter events" on public.matter_events;
create policy "Delete matter events"
  on public.matter_events for delete
  using (public._matter_events_access(matterspace_id));


-- ============================================================================
-- Extend the activity_feed view (migration 024) with a matter_events branch,
-- so adding a calendar event shows up in the Updates tab and Dashboard feed.
-- ============================================================================
create or replace view public.activity_feed
with (security_invoker = true)
as
  select
    d.matterspace_id              as matter_id,
    'document_uploaded'::text     as event_type,
    d.created_by                  as actor_id,
    d.created_at                  as occurred_at,
    d.id                          as ref_id,
    d.title                       as title
  from public.documents d
  union all
  select
    ci.space_id                   as matter_id,
    case ci.content_type
      when 'page'     then 'page_created'
      when 'list'     then 'list_created'
      when 'database' then 'table_created'
    end                           as event_type,
    ci.created_by                 as actor_id,
    ci.created_at                 as occurred_at,
    ci.id                         as ref_id,
    coalesce(nullif(trim(ci.title), ''), 'Untitled') as title
  from public.content_items ci
  where ci.space_type = 'matterspace'
    and ci.content_type in ('page', 'list', 'database')
  union all
  select
    mc.matterspace_id             as matter_id,
    'comment_posted'::text        as event_type,
    mc.user_id                    as actor_id,
    mc.created_at                 as occurred_at,
    mc.id                         as ref_id,
    left(regexp_replace(mc.body, '\s+', ' ', 'g'), 80) as title
  from public.matter_comments mc
  where mc.deleted_at is null
  union all
  select
    cr.matterspace_id             as matter_id,
    'cite_check_completed'::text  as event_type,
    cr.created_by                 as actor_id,
    cr.completed_at               as occurred_at,
    cr.id                         as ref_id,
    cr.source_label               as title
  from public.cite_check_runs cr
  where cr.status = 'complete'
    and cr.completed_at is not null
  union all
  select
    m.matterspace_id              as matter_id,
    'meeting_started'::text       as event_type,
    m.created_by                  as actor_id,
    m.started_at                  as occurred_at,
    m.id                          as ref_id,
    coalesce(nullif(trim(m.title), ''), 'Untitled meeting') as title
  from public.meetings m
  where m.matterspace_id is not null
  union all
  select
    m.matterspace_id              as matter_id,
    'meeting_ended'::text         as event_type,
    m.created_by                  as actor_id,
    m.ended_at                    as occurred_at,
    m.id                          as ref_id,
    coalesce(nullif(trim(m.title), ''), 'Untitled meeting') as title
  from public.meetings m
  where m.matterspace_id is not null
    and m.ended_at is not null
  union all
  -- Calendar events / deadlines added to a matter
  select
    me.matterspace_id             as matter_id,
    'event_added'::text           as event_type,
    me.created_by                 as actor_id,
    me.created_at                 as occurred_at,
    me.id                         as ref_id,
    me.title                      as title
  from public.matter_events me
;

grant select on public.activity_feed to authenticated, service_role;

notify pgrst, 'reload schema';
