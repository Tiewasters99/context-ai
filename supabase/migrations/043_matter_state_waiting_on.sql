-- Context.ai Migration 043: waiting_on — the fifth docket column
--
-- The Knowledge Map's circle-packed UI was retired 2026-07-30 (too
-- gimmicky for a working surface) in favor of the Practice Docket: a
-- linear, docket-sheet view of every active thread. The 042 ledger
-- backbone carries it unchanged; the docket's columns are
--   thread · where it stands · next step (owner) · due · waiting on
-- and only "waiting on" (whose court is the ball in — a client, opposing
-- counsel, a vendor) had no home in matter_state. Added here.
--
-- Postgres requires DROP (not CREATE OR REPLACE) when a function's
-- return type or signature changes, hence the two drops.
--
-- Apply order: after 042.

alter table public.matter_state
  add column if not exists waiting_on text;

-- ── set_matter_state: add p_waiting_on (same semantics: null = leave
--    unchanged, '' = clear) ─────────────────────────────────────────────
drop function if exists public.set_matter_state(uuid, text, text, text, text, text);

create or replace function public.set_matter_state(
  p_matter uuid,
  p_status text default null,
  p_headline text default null,
  p_next_action text default null,
  p_next_action_owner text default null,
  p_waiting_on text default null,
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
  if not exists (select 1 from public.matterspaces where id = p_matter) then
    raise exception 'matter % not found or not accessible', p_matter;
  end if;

  select * into v_old from public.matter_state where matterspace_id = p_matter;

  insert into public.matter_state as ms
    (matterspace_id, status, headline, next_action, next_action_owner,
     waiting_on, updated_at, updated_by)
  values
    (p_matter,
     coalesce(p_status, 'active'),
     nullif(p_headline, ''),
     nullif(p_next_action, ''),
     nullif(p_next_action_owner, ''),
     nullif(p_waiting_on, ''),
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
    waiting_on        = case when p_waiting_on is null
                             then ms.waiting_on else nullif(p_waiting_on, '') end,
    updated_at        = now(),
    updated_by        = p_updated_by
  returning * into v_new;

  v_changes := jsonb_strip_nulls(jsonb_build_object(
    'status',            p_status,
    'headline',          p_headline,
    'next_action',       p_next_action,
    'next_action_owner', p_next_action_owner,
    'waiting_on',        p_waiting_on
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
         'next_action', v_old.next_action,
         'waiting_on',  v_old.waiting_on)),
       'updated_by', p_updated_by),
     auth.uid());

  return to_jsonb(v_new);
end $$;

grant execute on function
  public.set_matter_state(uuid, text, text, text, text, text, text)
  to authenticated, service_role;

-- ── get_matter_map: expose waiting_on ─────────────────────────────────
drop function if exists public.get_matter_map();

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
  waiting_on text,
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
    st.waiting_on,
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

notify pgrst, 'reload schema';
