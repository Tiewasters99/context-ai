-- Context.ai Migration 024: activity_feed view — internal activity aggregation
--
-- Build #1 of the "what's happening" work. A single read-only view that
-- UNIONs every internal activity source into one shape, so the per-matter
-- Updates tab and the Dashboard activity feed can both render from one
-- query. No new tables, no triggers, no backfill — the view is always
-- consistent with the source tables by construction.
--
-- security_invoker = true: the view runs with the querying user's
-- privileges, so each underlying table's existing RLS naturally filters
-- the feed to matters / documents / etc. the user is allowed to see. No
-- separate RLS on the view is needed (and views can't carry RLS policies
-- anyway). Without security_invoker the view would run as its owner and
-- bypass RLS — so this flag is load-bearing, not optional.
--
-- When build #2 adds external events (Gmail etc.) and we want read/unread
-- state + notifications, this view can be promoted to a materialized
-- activity_events table. Not before.
--
-- Output columns:
--   matter_id    uuid         the matter the event belongs to
--   event_type   text         document_uploaded | page_created |
--                             list_created | table_created |
--                             comment_posted | cite_check_completed |
--                             meeting_started | meeting_ended
--   actor_id     uuid         the user who did it (profiles.id /
--                             auth.users.id — same value), nullable
--   occurred_at  timestamptz  when it happened
--   ref_id       uuid         id of the underlying row, for navigation
--   title        text         short human-readable summary
--
-- Apply order: after 023.

create or replace view public.activity_feed
with (security_invoker = true)
as
  -- Documents uploaded to the Vault
  select
    d.matterspace_id              as matter_id,
    'document_uploaded'::text     as event_type,
    d.created_by                  as actor_id,
    d.created_at                  as occurred_at,
    d.id                          as ref_id,
    d.title                       as title
  from public.documents d

  union all

  -- Pages / lists / tables created within a matter
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

  -- Comments posted to a matter thread (soft-deleted excluded)
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

  -- Cite-check runs that completed
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

  -- Meetings started (matter-linked only)
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

  -- Meetings ended (matter-linked only)
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
;

grant select on public.activity_feed to authenticated, service_role;

notify pgrst, 'reload schema';
