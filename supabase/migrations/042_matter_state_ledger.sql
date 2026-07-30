-- Context.ai Migration 042: matter_state ledger + Knowledge Map RPCs
--
-- Backbone for two features. Read visually, this state layer drives the
-- Knowledge Map (the new login-landing surface: the whole practice as one
-- zoomable circle-packed field). Read as a diff, it will drive the future
-- Briefing Engine (morning briefs generated against structured state,
-- never by re-reading prose history). Designed for both from day one.
--
-- Three deliberate deviations from the original build spec, agreed with
-- Eden 2026-07-30 (rationale in DISCOVERY.md at the repo root):
--
--   1. The append-only log is named matter_state_events, because
--      matter_events (migration 025) already exists as the CALENDAR.
--   2. next_deadline is NOT stored here. It is derived from the calendar
--      (earliest future uncompleted matter_events row), so the map, the
--      Calendar tab, and the Dashboard widget can never disagree. The
--      ledger's manual fields are status / headline / next_action only.
--   3. Document-ingest events are NOT logged here. Six independent code
--      paths insert documents; the activity_feed view (024) already sees
--      all of them, history included, consistent by construction. Heat
--      is computed from that view. matter_state_events records only what
--      no source table shows: state edits, deadline_passed, briefing_run,
--      note, and time_note (reserved now for a future Timekeeper feature
--      so it never needs a migration).
--
-- There is no cron infrastructure yet, and none is added: "overdue" is
-- computed at read time by get_matter_map(). When the Briefing Engine
-- needs durable deadline_passed rows, a pg_cron sweep can write them —
-- the event_type is already legal.
--
-- RLS uses the SECURITY INVOKER wrapper pattern (the migration 022
-- lesson, same shape as 025's _matter_events_access): visibility
-- delegates to matterspaces RLS, so you can read/write a matter's state
-- exactly when you can see the matter. Co-counsel scoped to one subtree
-- therefore get a Knowledge Map of exactly their slice, for free.
--
-- Apply order: after 041.

-- ============================================================================
-- 1. matter_state — one row per matter; absent row = implicit 'active'
-- ============================================================================
create table if not exists public.matter_state (
  matterspace_id uuid primary key
    references public.matterspaces(id) on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'urgent', 'waiting', 'dormant', 'archived')),
  headline text,           -- "Horski deposition 7/31 — outline in progress"
  next_action text,
  next_action_owner text,  -- 'you', 'agent', or a person's name — free text
  updated_at timestamptz not null default now(),
  updated_by text not null default 'human'
    check (updated_by in ('human', 'system', 'agent'))
);

alter table public.matter_state enable row level security;

-- ============================================================================
-- 2. matter_state_events — append-only ledger log (the Briefing Engine diffs
--    against this). No update/delete policies: rows are never rewritten.
-- ============================================================================
create table if not exists public.matter_state_events (
  id uuid primary key default gen_random_uuid(),
  matterspace_id uuid not null
    references public.matterspaces(id) on delete cascade,
  event_type text not null
    check (event_type in
      ('state_change', 'deadline_passed', 'briefing_run', 'note', 'time_note')),
  payload jsonb not null default '{}'::jsonb,
  actor_id uuid references public.profiles(id),  -- null = system/service
  created_at timestamptz not null default now()
);

create index if not exists idx_matter_state_events_matter_time
  on public.matter_state_events(matterspace_id, created_at desc);
create index if not exists idx_matter_state_events_time
  on public.matter_state_events(created_at desc);

alter table public.matter_state_events enable row level security;

-- ============================================================================
-- 3. SECURITY INVOKER access wrapper — delegates to matterspaces RLS
-- ============================================================================
create or replace function public._matter_state_access(p_matter_id uuid)
returns boolean
language plpgsql
security invoker
as $$
begin
  return exists (select 1 from public.matterspaces where id = p_matter_id);
end $$;

grant execute on function public._matter_state_access(uuid)
  to authenticated, service_role;

drop policy if exists "View matter state" on public.matter_state;
create policy "View matter state"
  on public.matter_state for select
  using (public._matter_state_access(matterspace_id));

drop policy if exists "Insert matter state" on public.matter_state;
create policy "Insert matter state"
  on public.matter_state for insert
  with check (public._matter_state_access(matterspace_id));

drop policy if exists "Update matter state" on public.matter_state;
create policy "Update matter state"
  on public.matter_state for update
  using (public._matter_state_access(matterspace_id));

drop policy if exists "View matter state events" on public.matter_state_events;
create policy "View matter state events"
  on public.matter_state_events for select
  using (public._matter_state_access(matterspace_id));

drop policy if exists "Insert matter state events" on public.matter_state_events;
create policy "Insert matter state events"
  on public.matter_state_events for insert
  with check (public._matter_state_access(matterspace_id));

-- ============================================================================
-- 4. set_matter_state — THE write path for state edits (map UI and MCP both
--    call this), so every edit is guaranteed to leave a ledger event. Only
--    non-null arguments change fields; pass '' (empty string) to clear a
--    text field. Returns the resulting state row as jsonb.
-- ============================================================================
create or replace function public.set_matter_state(
  p_matter uuid,
  p_status text default null,
  p_headline text default null,
  p_next_action text default null,
  p_next_action_owner text default null,
  p_updated_by text default 'human'
)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_old public.matter_state%rowtype;
  v_new public.matter_state%rowtype;
  v_changes jsonb;
begin
  -- RLS-checked visibility gate (runs as the caller).
  if not exists (select 1 from public.matterspaces where id = p_matter) then
    raise exception 'matter % not found or not accessible', p_matter;
  end if;

  select * into v_old from public.matter_state where matterspace_id = p_matter;

  insert into public.matter_state as ms
    (matterspace_id, status, headline, next_action, next_action_owner,
     updated_at, updated_by)
  values
    (p_matter,
     coalesce(p_status, 'active'),
     nullif(p_headline, ''),
     nullif(p_next_action, ''),
     nullif(p_next_action_owner, ''),
     now(),
     p_updated_by)
  on conflict (matterspace_id) do update set
    status            = coalesce(p_status, ms.status),
    headline          = case when p_headline is null
                             then ms.headline else nullif(p_headline, '') end,
    next_action       = case when p_next_action is null
                             then ms.next_action else nullif(p_next_action, '') end,
    next_action_owner = case when p_next_action_owner is null
                             then ms.next_action_owner
                             else nullif(p_next_action_owner, '') end,
    updated_at        = now(),
    updated_by        = p_updated_by
  returning * into v_new;

  -- Ledger event: record what was set (only the supplied fields), plus the
  -- prior values so the Briefing Engine can diff without a second lookup.
  v_changes := jsonb_strip_nulls(jsonb_build_object(
    'status',            p_status,
    'headline',          p_headline,
    'next_action',       p_next_action,
    'next_action_owner', p_next_action_owner
  ));
  insert into public.matter_state_events
    (matterspace_id, event_type, payload, actor_id)
  values
    (p_matter, 'state_change',
     jsonb_build_object(
       'set', v_changes,
       'previous', jsonb_strip_nulls(jsonb_build_object(
         'status',      v_old.status,
         'headline',    v_old.headline,
         'next_action', v_old.next_action)),
       'updated_by', p_updated_by),
     auth.uid());

  return to_jsonb(v_new);
end $$;

grant execute on function
  public.set_matter_state(uuid, text, text, text, text, text)
  to authenticated, service_role;

-- ============================================================================
-- 5. get_matter_map — one call returns every visible matter with the three
--    encodings' raw ingredients. SECURITY INVOKER end to end: matterspaces,
--    documents, matter_events, matter_state, and the activity_feed view all
--    RLS-filter as the caller, so the result IS the caller's map. Scale note:
--    ~130 matters today, lateral subqueries per row are fine to 500+; if the
--    activity aggregate ever shows up in timings, materialize per-matter
--    last_activity into matter_state via trigger — not before.
-- ============================================================================
create or replace function public.get_matter_map()
returns table (
  id uuid,
  name text,
  short_code text,
  parent_matterspace_id uuid,
  serverspace_id uuid,
  serverspace_name text,
  doc_count bigint,
  last_activity_at timestamptz,
  next_deadline date,
  next_deadline_label text,
  overdue_count bigint,
  status text,
  headline text,
  next_action text,
  next_action_owner text,
  state_updated_at timestamptz
)
language sql
security invoker
stable
as $$
  select
    m.id,
    m.name,
    m.short_code,
    m.parent_matterspace_id,
    m.serverspace_id,
    s.name as serverspace_name,
    coalesce(d.cnt, 0) as doc_count,
    act.last_activity_at,
    nd.event_date as next_deadline,
    nd.title as next_deadline_label,
    coalesce(od.cnt, 0) as overdue_count,
    coalesce(st.status, 'active') as status,
    st.headline,
    st.next_action,
    st.next_action_owner,
    st.updated_at as state_updated_at
  from public.matterspaces m
  join public.serverspaces s on s.id = m.serverspace_id
  left join public.matter_state st on st.matterspace_id = m.id
  left join lateral (
    select count(*) as cnt
    from public.documents doc
    where doc.matterspace_id = m.id
  ) d on true
  left join lateral (
    select max(af.occurred_at) as last_activity_at
    from public.activity_feed af
    where af.matter_id = m.id
  ) act on true
  left join lateral (
    select e.event_date, e.title
    from public.matter_events e
    where e.matterspace_id = m.id
      and e.completed_at is null
      and e.event_date >= current_date
    order by e.event_date asc, e.event_time asc nulls last
    limit 1
  ) nd on true
  left join lateral (
    select count(*) as cnt
    from public.matter_events e
    where e.matterspace_id = m.id
      and e.completed_at is null
      and e.event_date < current_date
  ) od on true
$$;

grant execute on function public.get_matter_map()
  to authenticated, service_role;

-- ============================================================================
-- 6. get_briefing_delta — Phase 4 stub for the Briefing Engine: everything
--    that happened since a timestamp, one row per event, newest last. Unions
--    the ledger log with the activity view; grouping by matter is the
--    caller's job. Exposed over HTTP as GET /api/briefing/delta?since=…
-- ============================================================================
create or replace function public.get_briefing_delta(p_since timestamptz)
returns table (
  matter_id uuid,
  source text,          -- 'ledger' | 'activity'
  event_type text,
  occurred_at timestamptz,
  detail jsonb
)
language sql
security invoker
stable
as $$
  select
    e.matterspace_id as matter_id,
    'ledger'::text as source,
    e.event_type,
    e.created_at as occurred_at,
    e.payload as detail
  from public.matter_state_events e
  where e.created_at > p_since
  union all
  select
    af.matter_id,
    'activity'::text as source,
    af.event_type,
    af.occurred_at,
    jsonb_build_object('title', af.title, 'ref_id', af.ref_id) as detail
  from public.activity_feed af
  where af.occurred_at > p_since
  order by occurred_at asc
$$;

grant execute on function public.get_briefing_delta(timestamptz)
  to authenticated, service_role;

notify pgrst, 'reload schema';
