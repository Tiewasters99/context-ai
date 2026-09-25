-- Contextspaces Migration 091: matter conversations — named, private-or-shared,
-- searchable, and able to hold a pasted email.
--
-- What changes for a person
-- ---------------------------------------------------------------------------
-- Until now a matter had ONE thread (017), and everyone who could open the
-- matter read every message in it. From 091 the Thread tab holds named
-- conversations. Each is set, when it is started, to one of two audiences:
--
--   'matter'   "Everyone on this matter" — exactly today's thread.
--   'members'  "Only these people" — the person who started it plus the
--              people they chose, each of whom must already be able to open
--              the matter.
--
-- A private conversation is invisible to everyone else: not its messages, not
-- its title, not the fact that it exists. That is enforced HERE, by row-level
-- security, and therefore holds for every path that reads the tables — the
-- Thread tab, search, the activity feed, the realtime channel, the Updates
-- tab, the briefing endpoint, the MCP connector and the in-app assistant,
-- all of which run as the signed-in person.
--
-- A second, separate rule governs AI. Each conversation carries ai_readable.
-- The search functions an assistant, connector or agent uses
-- (search_conversations_for_ai, grep_conversations_for_ai) return ONLY
-- messages from conversations whose ai_readable is true, and never from a
-- sealed (ai_tier B/C) or AI-paused matter or a matter beneath one — even
-- when the person asking is in the conversation. The column defaults to FALSE
-- (fail closed); the app sends true for "Everyone on this matter" unless the
-- person turns it off, and false for "Only these people" unless they turn it
-- on. The backfilled "General" conversation is true, because that is what the
-- one thread has always been.
--
-- The existing thread
-- ---------------------------------------------------------------------------
-- Every matter that has comments gets one conversation titled "General",
-- audience 'matter', ai_readable true, holding all of its existing comments.
-- conversation_id stays NULLABLE: src/lib/moot.ts (Moot Bench) and the copy
-- of the app still deployed when this is pasted insert comments without it.
-- A BEFORE INSERT trigger files such a comment into the matter's General
-- conversation (creating it if needed), so in practice no null survives; the
-- policies still treat a null as General, audience 'matter', so a comment
-- that somehow keeps one is never more hidden OR more exposed than today.
--
-- The two open questions (Eden has not ruled; each is ONE line below)
-- ---------------------------------------------------------------------------
--   conversations_internal.setting_private_started_by()  = 'anyone_on_matter'
--       Anyone who can open the matter may start a private conversation, and
--       only with people who can open the matter. The alternative value
--       'managers' limits starting one to the matter's owners and admins.
--   conversations_internal.setting_new_members_see_history() = true
--       Someone added to a private conversation later reads its earlier
--       messages (the co-counsel norm). false = they read only from the
--       moment they were added.
-- src/lib/conversations.ts mirrors both as constants for the wording the UI
-- shows; scripts/_verify-matter-conversations.mjs fails if they disagree.
--
-- RLS shape (the 022 / 062 rule)
-- ---------------------------------------------------------------------------
-- Every policy calls a SECURITY INVOKER plpgsql wrapper in public that reads
-- auth.uid() ONCE into a variable at entry and hands it, explicitly, to a
-- SECURITY DEFINER helper in conversations_internal that never calls
-- auth.uid() itself. No policy calls a SECURITY DEFINER function directly.
-- The DEFINER helpers are what break the recursion between conversations,
-- their member list and their messages (each policy needs to read the
-- others). conversations_internal is not a PostgREST-exposed schema.
--
-- What else is in here
-- ---------------------------------------------------------------------------
--   * matter_comments gains kind ('message' | 'email'), the email header
--     fields, email_quoted (the quoted history a pasted email carried, kept
--     but shown collapsed), and a generated english tsv with a GIN index.
--   * matter_conversation_reads: last_read_at per person, for unread counts.
--   * activity_feed (042's definition) is re-created with ONE change: a
--     message's feed title is its first 80 characters only when its
--     conversation is shared with the whole matter AND readable by AI. A
--     private conversation's message reads "Message in a private
--     conversation"; a shared one closed to AI reads "Message in <title>".
--     RLS already keeps the row itself from non-members; this keeps message
--     text out of the feed for the AI-facing readers of it (the briefing
--     endpoint runs as the person and returns feed titles).
--   * conversation_id, matterspace_id and user_id on a comment can no longer
--     be changed by an UPDATE from the app (an author could otherwise move a
--     message out of a private conversation), and a conversation's audience,
--     matter and General flag are fixed at creation.
--
-- Additive and idempotent: create-if-not-exists / create-or-replace
-- throughout, constraints added by name only when absent, the backfill only
-- touches rows that still have no conversation. Pasting it twice changes
-- nothing. NOT applied by the PR that adds it.
--
-- Rollback: at the bottom of this file, commented out. READ ITS FIRST LINE —
-- rolling back returns every message to the one shared thread, so it removes
-- private conversations' messages first rather than expose them.
--
-- Verified by execution in PGlite with the real 001 → 022 chain, 017, 021,
-- 062, 042's view and real RLS from SET ROLE authenticated:
--   node scripts/_verify-matter-conversations.mjs


-- ============================================================================
-- 0. A schema PostgREST does not serve
-- ============================================================================
create schema if not exists conversations_internal;
revoke all on schema conversations_internal from public;
grant usage on schema conversations_internal to authenticated, service_role;

comment on schema conversations_internal is
  'Private helpers for matter conversations (091). NOT a PostgREST-exposed '
  'schema and must never be added to one: the DEFINER functions here take a '
  'user id as an argument and trust it.';


-- ============================================================================
-- 1. The two open questions, one line each
-- ============================================================================
create or replace function conversations_internal.setting_private_started_by()
returns text language sql immutable as $$ select 'anyone_on_matter'::text $$;

create or replace function conversations_internal.setting_new_members_see_history()
returns boolean language sql immutable as $$ select true $$;


-- ============================================================================
-- 2. Tables
-- ============================================================================
create table if not exists public.matter_conversations (
  id              uuid primary key default gen_random_uuid(),
  matterspace_id  uuid not null references public.matterspaces(id) on delete cascade,
  title           text not null,
  -- Fail closed: a row inserted without an audience is private.
  audience        text not null default 'members',
  -- Fail closed: a row inserted without a choice is not readable by AI.
  ai_readable     boolean not null default false,
  is_general      boolean not null default false,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz,
  archived_at     timestamptz
);

create table if not exists public.matter_conversation_members (
  conversation_id uuid not null references public.matter_conversations(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  added_by        uuid references public.profiles(id) on delete set null,
  added_at        timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table if not exists public.matter_conversation_reads (
  conversation_id uuid not null references public.matter_conversations(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  last_read_at    timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'matter_conversations_audience_check') then
    alter table public.matter_conversations
      add constraint matter_conversations_audience_check check (audience in ('matter', 'members'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'matter_conversations_title_check') then
    alter table public.matter_conversations
      add constraint matter_conversations_title_check check (length(btrim(title)) between 1 and 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'matter_conversations_general_is_shared') then
    alter table public.matter_conversations
      add constraint matter_conversations_general_is_shared check (not is_general or audience = 'matter');
  end if;
  -- The target of the composite foreign key below: a message and its
  -- conversation can never disagree about which matter they are in.
  if not exists (select 1 from pg_constraint where conname = 'matter_conversations_id_matter_key') then
    alter table public.matter_conversations
      add constraint matter_conversations_id_matter_key unique (id, matterspace_id);
  end if;
end $$;

create unique index if not exists matter_conversations_one_general
  on public.matter_conversations (matterspace_id) where is_general;
create index if not exists matter_conversations_matter_recent
  on public.matter_conversations (matterspace_id, last_message_at desc nulls last);
create index if not exists matter_conversation_members_user
  on public.matter_conversation_members (user_id);

alter table public.matter_conversations        enable row level security;
alter table public.matter_conversation_members enable row level security;
alter table public.matter_conversation_reads   enable row level security;


-- ============================================================================
-- 3. matter_comments: conversation, kind, email header, search vector
-- ============================================================================
alter table public.matter_comments add column if not exists conversation_id uuid;
alter table public.matter_comments add column if not exists kind          text not null default 'message';
alter table public.matter_comments add column if not exists email_from    text;
alter table public.matter_comments add column if not exists email_to      text;
alter table public.matter_comments add column if not exists email_cc      text;
alter table public.matter_comments add column if not exists email_date    timestamptz;
alter table public.matter_comments add column if not exists email_subject text;
alter table public.matter_comments add column if not exists email_quoted  text;

do $$
declare
  c record;
begin
  if not exists (select 1 from pg_constraint where conname = 'matter_comments_conversation_fk') then
    alter table public.matter_comments
      add constraint matter_comments_conversation_fk
      foreign key (conversation_id, matterspace_id)
      references public.matter_conversations (id, matterspace_id)
      on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'matter_comments_kind_check') then
    alter table public.matter_comments
      add constraint matter_comments_kind_check check (kind in ('message', 'email'));
  end if;
  -- 017's inline body check (system-named) capped every message at 10,000
  -- characters. A pasted email is longer than that often enough to matter, so
  -- the cap becomes 10,000 for a message and 200,000 for an email. Dropped by
  -- catalog lookup, not by an assumed name.
  for c in
    select conname from pg_constraint
     where conrelid = 'public.matter_comments'::regclass
       and contype = 'c'
       and conname <> 'matter_comments_body_check_091'
       and pg_get_constraintdef(oid) ilike '%length(body)%'
  loop
    execute format('alter table public.matter_comments drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'matter_comments_body_check_091') then
    alter table public.matter_comments
      add constraint matter_comments_body_check_091 check (
        length(btrim(body)) > 0
        and length(body) <= case when kind = 'email' then 200000 else 10000 end
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'matter_comments_email_fields_check') then
    alter table public.matter_comments
      add constraint matter_comments_email_fields_check check (
        coalesce(length(email_from), 0)    <= 2000
        and coalesce(length(email_to), 0)      <= 20000
        and coalesce(length(email_cc), 0)      <= 20000
        and coalesce(length(email_subject), 0) <= 2000
        and coalesce(length(email_quoted), 0)  <= 400000
      );
  end if;
end $$;

-- The quoted history is deliberately NOT in the vector: search finds what a
-- message says, not every earlier email it happened to carry below the line.
alter table public.matter_comments
  add column if not exists tsv tsvector
  generated always as (
    to_tsvector('english'::regconfig,
      coalesce(email_subject, '') || ' ' ||
      coalesce(email_from, '')    || ' ' ||
      coalesce(email_to, '')      || ' ' ||
      coalesce(email_cc, '')      || ' ' ||
      coalesce(body, ''))
  ) stored;

create index if not exists idx_matter_comments_tsv
  on public.matter_comments using gin (tsv);
create index if not exists idx_matter_comments_conversation_created
  on public.matter_comments (conversation_id, created_at)
  where deleted_at is null;


-- ============================================================================
-- 4. DEFINER helpers (explicit user id; never auth.uid())
-- ============================================================================

-- The caller's best role on a matter — 016's matter_role with the user passed
-- in rather than read from the JWT. Membership on the matter or any ancestor,
-- or on the matter's serverspace. The harness asserts it agrees with
-- can_access_matter / can_manage_matter for every user and matter it builds.
create or replace function conversations_internal.user_matter_role(p_uid uuid, p_matter uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select r.role
    from (
      select mm.role
        from public.matterspace_members mm
       where mm.user_id = p_uid
         and mm.matterspace_id in (select id from public.matter_ancestry(p_matter))
      union all
      select sm.role
        from public.matterspaces m
        join public.serverspace_members sm on sm.serverspace_id = m.serverspace_id
       where m.id = p_matter and sm.user_id = p_uid
    ) r
   where p_uid is not null and p_matter is not null
   order by case r.role
     when 'owner'  then 4
     when 'admin'  then 3
     when 'member' then 2
     when 'viewer' then 1
     else 0 end desc
   limit 1
$$;

create or replace function conversations_internal.user_can_open_matter(p_uid uuid, p_matter uuid)
returns boolean
language sql stable security definer set search_path = public
as $$ select conversations_internal.user_matter_role(p_uid, p_matter) is not null $$;

create or replace function conversations_internal.user_can_manage_matter(p_uid uuid, p_matter uuid)
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce(conversations_internal.user_matter_role(p_uid, p_matter) in ('owner', 'admin'), false) $$;

-- May p_uid read a message posted at p_at in conversation p_conv of matter
-- p_matter? p_conv null = the General thread (audience 'matter'). p_at null =
-- "any message" (the conversation itself). The whole rule lives here, once.
create or replace function conversations_internal.message_access(
  p_uid uuid, p_conv uuid, p_matter uuid, p_at timestamptz
) returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_matter   uuid;
  v_audience text;
  v_creator  uuid;
  v_added    timestamptz;
begin
  if p_uid is null then return false; end if;
  if p_conv is null then
    return p_matter is not null
       and conversations_internal.user_can_open_matter(p_uid, p_matter);
  end if;

  select c.matterspace_id, c.audience, c.created_by
    into v_matter, v_audience, v_creator
    from public.matter_conversations c
   where c.id = p_conv;
  if v_matter is null then return false; end if;
  -- A message row names its matter too; the foreign key keeps the two equal,
  -- and this refuses rather than trusts if they ever are not.
  if p_matter is not null and p_matter <> v_matter then return false; end if;
  if not conversations_internal.user_can_open_matter(p_uid, v_matter) then return false; end if;

  if v_audience = 'matter' then return true; end if;
  if v_creator = p_uid then return true; end if;

  select m.added_at into v_added
    from public.matter_conversation_members m
   where m.conversation_id = p_conv and m.user_id = p_uid;
  if v_added is null then return false; end if;
  if p_at is null or conversations_internal.setting_new_members_see_history() then return true; end if;
  return p_at >= v_added;
end $$;

-- Rename, archive, switch AI on or off, remove someone: the person who
-- started it, or an owner/admin of the matter who can already read it.
create or replace function conversations_internal.conversation_manage(p_uid uuid, p_conv uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_matter  uuid;
  v_creator uuid;
begin
  if p_uid is null or p_conv is null then return false; end if;
  select c.matterspace_id, c.created_by into v_matter, v_creator
    from public.matter_conversations c where c.id = p_conv;
  if v_matter is null then return false; end if;
  if not conversations_internal.message_access(p_uid, p_conv, v_matter, null) then return false; end if;
  return v_creator = p_uid or conversations_internal.user_can_manage_matter(p_uid, v_matter);
end $$;

-- Add someone to a private conversation: anyone already in it.
create or replace function conversations_internal.conversation_add_member(p_uid uuid, p_conv uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_matter   uuid;
  v_audience text;
  v_archived timestamptz;
begin
  if p_uid is null or p_conv is null then return false; end if;
  select c.matterspace_id, c.audience, c.archived_at into v_matter, v_audience, v_archived
    from public.matter_conversations c where c.id = p_conv;
  if v_matter is null or v_audience <> 'members' or v_archived is not null then return false; end if;
  return conversations_internal.message_access(p_uid, p_conv, v_matter, null);
end $$;

-- Start a conversation in a matter.
create or replace function conversations_internal.conversation_start(
  p_uid uuid, p_matter uuid, p_audience text, p_is_general boolean
) returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_uid is null or p_matter is null then return false; end if;
  -- The General conversation is made by the system (trigger / RPC below),
  -- never inserted from the app.
  if coalesce(p_is_general, false) then return false; end if;
  if not conversations_internal.user_can_open_matter(p_uid, p_matter) then return false; end if;
  if p_audience = 'members'
     and conversations_internal.setting_private_started_by() = 'managers'
     and not conversations_internal.user_can_manage_matter(p_uid, p_matter) then
    return false;
  end if;
  return true;
end $$;

-- The matter's General conversation, made on first need.
create or replace function conversations_internal.general_for(p_matter uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.matter_conversations
   where matterspace_id = p_matter and is_general;
  if v_id is not null then return v_id; end if;
  insert into public.matter_conversations (matterspace_id, title, audience, ai_readable, is_general)
  values (p_matter, 'General', 'matter', true, true)
  on conflict (matterspace_id) where is_general do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.matter_conversations
     where matterspace_id = p_matter and is_general;
  end if;
  return v_id;
end $$;

-- Everyone who can open the matter, for the "Only these people" picker.
create or replace function conversations_internal.matter_people(p_matter uuid)
returns table (user_id uuid, display_name text, email text, role text)
language sql
stable
security definer
set search_path = public
as $$
  with candidates as (
    select mm.user_id
      from public.matterspace_members mm
     where mm.matterspace_id in (select id from public.matter_ancestry(p_matter))
    union
    select sm.user_id
      from public.matterspaces m
      join public.serverspace_members sm on sm.serverspace_id = m.serverspace_id
     where m.id = p_matter
  )
  select p.id, p.display_name, p.email,
         conversations_internal.user_matter_role(p.id, p_matter)
    from candidates c
    join public.profiles p on p.id = c.user_id
   order by lower(coalesce(nullif(btrim(p.display_name), ''), p.email))
$$;

revoke all on all functions in schema conversations_internal from public;
grant execute on all functions in schema conversations_internal to authenticated, service_role;


-- ============================================================================
-- 5. INVOKER wrappers — the only functions the policies call
-- ============================================================================
create or replace function public._mconv_message_visible(p_conv uuid, p_matter uuid, p_at timestamptz)
returns boolean
language plpgsql stable security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  return conversations_internal.message_access(v_uid, p_conv, p_matter, p_at);
end $$;

create or replace function public._mconv_can_post(p_conv uuid, p_matter uuid)
returns boolean
language plpgsql stable security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  if p_conv is not null and exists (
    select 1 from public.matter_conversations c where c.id = p_conv and c.archived_at is not null
  ) then
    return false;   -- archived = read-only
  end if;
  return conversations_internal.message_access(v_uid, p_conv, p_matter, null);
end $$;

create or replace function public._mconv_can_delete_message(p_conv uuid, p_matter uuid, p_author uuid, p_at timestamptz)
returns boolean
language plpgsql stable security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  if not conversations_internal.message_access(v_uid, p_conv, p_matter, p_at) then return false; end if;
  return p_author = v_uid or conversations_internal.user_can_manage_matter(v_uid, p_matter);
end $$;

create or replace function public._mconv_conversation_visible(p_conv uuid)
returns boolean
language plpgsql stable security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  return conversations_internal.message_access(v_uid, p_conv, null, null);
end $$;

create or replace function public._mconv_can_open_matter(p_matter uuid)
returns boolean
language plpgsql stable security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  return conversations_internal.user_can_open_matter(v_uid, p_matter);
end $$;

create or replace function public._mconv_can_start(p_matter uuid, p_audience text, p_is_general boolean)
returns boolean
language plpgsql stable security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  return conversations_internal.conversation_start(v_uid, p_matter, p_audience, p_is_general);
end $$;

create or replace function public._mconv_can_manage(p_conv uuid)
returns boolean
language plpgsql stable security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  return conversations_internal.conversation_manage(v_uid, p_conv);
end $$;

create or replace function public._mconv_can_add_member(p_conv uuid)
returns boolean
language plpgsql stable security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  return conversations_internal.conversation_add_member(v_uid, p_conv);
end $$;

grant execute on function public._mconv_message_visible(uuid, uuid, timestamptz)       to anon, authenticated, service_role;
grant execute on function public._mconv_can_post(uuid, uuid)                           to anon, authenticated, service_role;
grant execute on function public._mconv_can_delete_message(uuid, uuid, uuid, timestamptz) to anon, authenticated, service_role;
grant execute on function public._mconv_conversation_visible(uuid)                     to anon, authenticated, service_role;
grant execute on function public._mconv_can_open_matter(uuid)                          to anon, authenticated, service_role;
grant execute on function public._mconv_can_start(uuid, text, boolean)                 to anon, authenticated, service_role;
grant execute on function public._mconv_can_manage(uuid)                               to anon, authenticated, service_role;
grant execute on function public._mconv_can_add_member(uuid)                           to anon, authenticated, service_role;


-- ============================================================================
-- 6. Triggers
-- ============================================================================

-- Roles allowed to move rows between conversations: the SQL editor and the
-- service role (this migration's own backfill runs as postgres).
create or replace function conversations_internal.is_privileged()
returns boolean language sql stable
as $$ select current_user in ('postgres', 'service_role', 'supabase_admin') $$;
grant execute on function conversations_internal.is_privileged() to authenticated, service_role;

-- 6a. A comment inserted without a conversation goes to General.
create or replace function conversations_internal.comment_fill_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.conversation_id is null and new.matterspace_id is not null then
    new.conversation_id := conversations_internal.general_for(new.matterspace_id);
  end if;
  return new;
end $$;

drop trigger if exists matter_comments_fill_conversation on public.matter_comments;
create trigger matter_comments_fill_conversation
  before insert on public.matter_comments
  for each row execute function conversations_internal.comment_fill_conversation();

-- 6b. What a message says may be edited by its author; where it lives may not.
create or replace function conversations_internal.comment_guard_update()
returns trigger
language plpgsql
security invoker
as $$
begin
  if conversations_internal.is_privileged() then return new; end if;
  if new.conversation_id is distinct from old.conversation_id
     or new.matterspace_id is distinct from old.matterspace_id
     or new.user_id is distinct from old.user_id
     or new.created_at is distinct from old.created_at then
    raise exception 'A message cannot be moved to another conversation, matter or author.'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists matter_comments_guard_update on public.matter_comments;
create trigger matter_comments_guard_update
  before update on public.matter_comments
  for each row execute function conversations_internal.comment_guard_update();

-- 6c. Newest activity first needs last_message_at.
create or replace function conversations_internal.comment_touch_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.conversation_id is not null then
    update public.matter_conversations
       set last_message_at = greatest(coalesce(last_message_at, new.created_at), new.created_at)
     where id = new.conversation_id;
  end if;
  return null;
end $$;

drop trigger if exists matter_comments_touch_conversation on public.matter_comments;
create trigger matter_comments_touch_conversation
  after insert on public.matter_comments
  for each row execute function conversations_internal.comment_touch_conversation();

-- 6d. Audience, matter, General-ness and author are fixed at creation.
create or replace function conversations_internal.conversation_guard_update()
returns trigger
language plpgsql
security invoker
as $$
begin
  if conversations_internal.is_privileged() then return new; end if;
  if new.audience is distinct from old.audience
     or new.matterspace_id is distinct from old.matterspace_id
     or new.is_general is distinct from old.is_general
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'A conversation''s audience, matter and author are set when it is started and cannot be changed.'
      using errcode = '42501';
  end if;
  if new.is_general and new.archived_at is not null then
    raise exception 'The General conversation cannot be archived.' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists matter_conversations_guard_update on public.matter_conversations;
create trigger matter_conversations_guard_update
  before update on public.matter_conversations
  for each row execute function conversations_internal.conversation_guard_update();

-- 6e. Whoever starts a private conversation is in it.
create or replace function conversations_internal.conversation_add_creator()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.audience = 'members' and new.created_by is not null then
    insert into public.matter_conversation_members (conversation_id, user_id, added_by)
    values (new.id, new.created_by, new.created_by)
    on conflict do nothing;
  end if;
  return null;
end $$;

drop trigger if exists matter_conversations_add_creator on public.matter_conversations;
create trigger matter_conversations_add_creator
  after insert on public.matter_conversations
  for each row execute function conversations_internal.conversation_add_creator();

-- 6f. Only people who can open the matter can be in one of its conversations,
--     and only a private conversation has a member list. Enforced for every
--     role, service role included.
create or replace function conversations_internal.member_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_matter   uuid;
  v_audience text;
begin
  select c.matterspace_id, c.audience into v_matter, v_audience
    from public.matter_conversations c where c.id = new.conversation_id;
  if v_matter is null then
    raise exception 'No such conversation.' using errcode = '23503';
  end if;
  if v_audience <> 'members' then
    raise exception 'A conversation for everyone on the matter has no member list.' using errcode = '22023';
  end if;
  if not conversations_internal.user_can_open_matter(new.user_id, v_matter) then
    raise exception 'Only people who can open this matter can be added to its conversations.'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists matter_conversation_members_check on public.matter_conversation_members;
create trigger matter_conversation_members_check
  before insert or update on public.matter_conversation_members
  for each row execute function conversations_internal.member_check();


-- ============================================================================
-- 7. Backfill: one General per matter that has comments, holding all of them
-- ============================================================================
insert into public.matter_conversations
  (matterspace_id, title, audience, ai_readable, is_general, created_by, created_at, last_message_at)
select mc.matterspace_id, 'General', 'matter', true, true, null,
       min(mc.created_at),
       max(mc.created_at) filter (where mc.deleted_at is null)
  from public.matter_comments mc
 where not exists (
         select 1 from public.matter_conversations g
          where g.matterspace_id = mc.matterspace_id and g.is_general)
 group by mc.matterspace_id
on conflict (matterspace_id) where is_general do nothing;

update public.matter_comments mc
   set conversation_id = g.id
  from public.matter_conversations g
 where g.matterspace_id = mc.matterspace_id
   and g.is_general
   and mc.conversation_id is null;


-- ============================================================================
-- 8. Policies
-- ============================================================================

-- 8a. messages (replacing 017's four)
drop policy if exists "Members can read matter comments"      on public.matter_comments;
drop policy if exists "Members can post matter comments"      on public.matter_comments;
drop policy if exists "Authors can edit their own comments"   on public.matter_comments;
drop policy if exists "Authors or admins can delete comments" on public.matter_comments;
drop policy if exists "Conversation audience reads messages"   on public.matter_comments;
drop policy if exists "Conversation audience posts messages"   on public.matter_comments;
drop policy if exists "Authors edit their own messages"        on public.matter_comments;
drop policy if exists "Authors or admins delete messages"      on public.matter_comments;

create policy "Conversation audience reads messages"
  on public.matter_comments for select
  using (public._mconv_message_visible(conversation_id, matterspace_id, created_at));

create policy "Conversation audience posts messages"
  on public.matter_comments for insert
  with check (
    user_id = auth.uid()
    and public._mconv_can_post(conversation_id, matterspace_id)
  );

create policy "Authors edit their own messages"
  on public.matter_comments for update
  using (
    user_id = auth.uid()
    and public._mconv_message_visible(conversation_id, matterspace_id, created_at)
  )
  with check (
    user_id = auth.uid()
    and public._mconv_message_visible(conversation_id, matterspace_id, created_at)
  );

create policy "Authors or admins delete messages"
  on public.matter_comments for delete
  using (public._mconv_can_delete_message(conversation_id, matterspace_id, user_id, created_at));

-- 8b. conversations
drop policy if exists "Audience reads conversations"      on public.matter_conversations;
drop policy if exists "People on the matter start conversations" on public.matter_conversations;
drop policy if exists "Starter or admins manage conversations"   on public.matter_conversations;

-- The first clause reads the NEW row's own columns. It is what lets INSERT …
-- RETURNING (create_matter_conversation) pass: a STABLE function called from
-- the policy runs on the statement's snapshot and cannot see the row that
-- statement is inserting (the 047 lesson). It admits only the person who
-- started the conversation, and only while they can open the matter.
create policy "Audience reads conversations"
  on public.matter_conversations for select
  using (
    (created_by = auth.uid() and public._mconv_can_open_matter(matterspace_id))
    or public._mconv_conversation_visible(id)
  );

create policy "People on the matter start conversations"
  on public.matter_conversations for insert
  with check (
    created_by = auth.uid()
    and public._mconv_can_start(matterspace_id, audience, is_general)
  );

create policy "Starter or admins manage conversations"
  on public.matter_conversations for update
  using (public._mconv_can_manage(id))
  with check (public._mconv_can_manage(id));
-- No DELETE policy: a conversation is archived, not deleted, from the app.

-- 8c. member lists
drop policy if exists "Conversation members read the member list" on public.matter_conversation_members;
drop policy if exists "Conversation members add people"           on public.matter_conversation_members;
drop policy if exists "Leave, or be removed by the starter"       on public.matter_conversation_members;

create policy "Conversation members read the member list"
  on public.matter_conversation_members for select
  using (public._mconv_conversation_visible(conversation_id));

create policy "Conversation members add people"
  on public.matter_conversation_members for insert
  with check (
    added_by = auth.uid()
    and public._mconv_can_add_member(conversation_id)
  );

create policy "Leave, or be removed by the starter"
  on public.matter_conversation_members for delete
  using (
    user_id = auth.uid()
    or public._mconv_can_manage(conversation_id)
  );

-- 8d. read markers: your own, on conversations you can read
drop policy if exists "Own read markers" on public.matter_conversation_reads;
create policy "Own read markers"
  on public.matter_conversation_reads for all
  using (user_id = auth.uid() and public._mconv_conversation_visible(conversation_id))
  with check (user_id = auth.uid() and public._mconv_conversation_visible(conversation_id));

grant select, insert, update on public.matter_conversations to authenticated;
grant select, insert, delete on public.matter_conversation_members to authenticated;
grant select, insert, update, delete on public.matter_conversation_reads to authenticated;
grant all on public.matter_conversations, public.matter_conversation_members,
             public.matter_conversation_reads to service_role;


-- ============================================================================
-- 9. RPCs (all SECURITY INVOKER: RLS decides, every time)
-- ============================================================================

-- 9a. The conversation list for a matter, newest activity first, with counts.
create or replace function public.list_matter_conversations(p_matter uuid)
returns table (
  id uuid,
  matterspace_id uuid,
  title text,
  audience text,
  ai_readable boolean,
  is_general boolean,
  created_by uuid,
  created_at timestamptz,
  last_message_at timestamptz,
  archived_at timestamptz,
  message_count bigint,
  unread_count bigint,
  member_ids uuid[]
)
language plpgsql
stable
security invoker
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_matter is null then return; end if;
  return query
  select c.id, c.matterspace_id, c.title, c.audience, c.ai_readable, c.is_general,
         c.created_by, c.created_at, c.last_message_at, c.archived_at,
         (select count(*) from public.matter_comments m
           where m.conversation_id = c.id and m.deleted_at is null),
         (select count(*) from public.matter_comments m
           where m.conversation_id = c.id and m.deleted_at is null
             and m.user_id <> v_uid
             and m.created_at > coalesce(
               (select r.last_read_at from public.matter_conversation_reads r
                 where r.conversation_id = c.id and r.user_id = v_uid),
               '-infinity'::timestamptz)),
         case when c.audience = 'members' then
           coalesce((select array_agg(mm.user_id order by mm.added_at)
                       from public.matter_conversation_members mm
                      where mm.conversation_id = c.id), '{}'::uuid[])
         else '{}'::uuid[] end
    from public.matter_conversations c
   where c.matterspace_id = p_matter
   order by c.is_general desc,
            coalesce(c.last_message_at, c.created_at) desc,
            c.id;
end $$;

-- 9b. Make sure the matter's General conversation exists (the Thread tab
--     calls this on open). Returns its id, or null if the caller cannot open
--     the matter.
create or replace function public.ensure_general_conversation(p_matter uuid)
returns uuid
language plpgsql
volatile
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_matter is null then return null; end if;
  if not conversations_internal.user_can_open_matter(v_uid, p_matter) then return null; end if;
  return conversations_internal.general_for(p_matter);
end $$;

-- 9c. Start a conversation and set its people in one call. Runs as the
--     caller: the INSERT policies decide, and the member trigger refuses
--     anyone who cannot open the matter.
create or replace function public.create_matter_conversation(
  p_matter uuid,
  p_title text,
  p_audience text,
  p_ai_readable boolean,
  p_member_ids uuid[] default '{}'
) returns uuid
language plpgsql
volatile
security invoker
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
  v_member uuid;
begin
  if v_uid is null then
    raise exception 'Sign in to start a conversation.' using errcode = '42501';
  end if;
  if p_audience not in ('matter', 'members') then
    raise exception 'Audience must be matter or members.' using errcode = '22023';
  end if;
  insert into public.matter_conversations (matterspace_id, title, audience, ai_readable, created_by)
  values (p_matter, btrim(p_title), p_audience, coalesce(p_ai_readable, false), v_uid)
  returning id into v_id;
  if p_audience = 'members' then
    foreach v_member in array coalesce(p_member_ids, '{}'::uuid[]) loop
      if v_member is distinct from v_uid then
        insert into public.matter_conversation_members (conversation_id, user_id, added_by)
        values (v_id, v_member, v_uid)
        on conflict do nothing;
      end if;
    end loop;
  end if;
  return v_id;
end $$;

-- 9d. The people the picker may offer: everyone who can open the matter.
create or replace function public.matter_conversation_people(p_matter uuid)
returns table (user_id uuid, display_name text, email text, role text)
language plpgsql
stable
security invoker
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_matter is null then return; end if;
  if not conversations_internal.user_can_open_matter(v_uid, p_matter) then return; end if;
  return query select * from conversations_internal.matter_people(p_matter);
end $$;

-- 9e. Search. ONE core, SECURITY INVOKER, so the table policies above filter
--     every row it reads; it applies the audience rule a second time itself
--     (belt and braces against a policy that drifts), and, for AI, the
--     ai_readable switch and the seal/pause on the matter and its ancestors.
--     The core lives in conversations_internal so nobody can call it with
--     p_for_ai = false over HTTP by accident; the two public doors fix it.
create or replace function conversations_internal.matter_ai_closed(p_matter uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.matterspaces m
     where m.id in (select id from public.matter_ancestry(p_matter))
       and (coalesce(m.ai_tier, 'A') <> 'A' or coalesce(m.ai_paused, false))
  )
$$;
revoke all on function conversations_internal.matter_ai_closed(uuid) from public;
grant execute on function conversations_internal.matter_ai_closed(uuid) to authenticated, service_role;

create or replace function conversations_internal.search_core(
  p_matterspace_ids uuid[],
  p_query text,
  p_limit int,
  p_for_ai boolean,
  p_grep_pattern text,
  p_grep_regex boolean,
  p_grep_case_sensitive boolean
)
returns table (
  comment_id uuid,
  conversation_id uuid,
  conversation_title text,
  matterspace_id uuid,
  matter_name text,
  audience text,
  ai_readable boolean,
  kind text,
  author_id uuid,
  author_name text,
  created_at timestamptz,
  email_from text,
  email_to text,
  email_cc text,
  email_subject text,
  email_date timestamptz,
  body text,
  snippet text,
  rank real
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_uid   uuid := auth.uid();
  v_limit int  := least(greatest(coalesce(p_limit, 20), 1), 200);
  v_tsq   tsquery;
begin
  if v_uid is null then return; end if;
  if p_grep_pattern is null then
    v_tsq := websearch_to_tsquery('english', coalesce(p_query, ''));
    if v_tsq is null or numnode(v_tsq) = 0 then return; end if;
  elsif length(p_grep_pattern) = 0 then
    return;
  end if;

  return query
  select mc.id, c.id, c.title, mc.matterspace_id, ms.name, c.audience, c.ai_readable,
         mc.kind, mc.user_id,
         coalesce(nullif(btrim(pr.display_name), ''), pr.email, 'Unknown'),
         mc.created_at, mc.email_from, mc.email_to, mc.email_cc, mc.email_subject, mc.email_date,
         mc.body,
         case when p_grep_pattern is null
              then ts_headline('english', mc.body, v_tsq,
                     'MaxWords=30, MinWords=12, MaxFragments=2, StartSel=«, StopSel=»')
              else null end,
         (case when p_grep_pattern is null then ts_rank(mc.tsv, v_tsq) else 0 end)::real
    from public.matter_comments mc
    join public.matter_conversations c
      on c.id = mc.conversation_id and c.matterspace_id = mc.matterspace_id
    left join public.matterspaces ms on ms.id = mc.matterspace_id
    left join public.profiles pr on pr.id = mc.user_id
   where mc.deleted_at is null
     and (p_matterspace_ids is null or mc.matterspace_id = any(p_matterspace_ids))
     -- the audience rule, again, here
     and conversations_internal.message_access(v_uid, mc.conversation_id, mc.matterspace_id, mc.created_at)
     -- the AI rule
     and (not p_for_ai or (c.ai_readable and not conversations_internal.matter_ai_closed(mc.matterspace_id)))
     and (
       case
         when p_grep_pattern is null then mc.tsv @@ v_tsq
         when coalesce(p_grep_regex, false) and coalesce(p_grep_case_sensitive, false)
           then (coalesce(mc.email_subject, '') || E'\n' || mc.body) ~ p_grep_pattern
         when coalesce(p_grep_regex, false)
           then (coalesce(mc.email_subject, '') || E'\n' || mc.body) ~* p_grep_pattern
         when coalesce(p_grep_case_sensitive, false)
           then strpos(coalesce(mc.email_subject, '') || E'\n' || mc.body, p_grep_pattern) > 0
         else strpos(lower(coalesce(mc.email_subject, '') || E'\n' || mc.body), lower(p_grep_pattern)) > 0
       end
     )
   order by 19 desc, mc.created_at desc, mc.id
   limit v_limit;
end $$;

revoke all on function conversations_internal.search_core(uuid[], text, int, boolean, text, boolean, boolean) from public;
grant execute on function conversations_internal.search_core(uuid[], text, int, boolean, text, boolean, boolean)
  to authenticated, service_role;

-- For the PERSON: every conversation they can read (Thread tab, Vault search).
create or replace function public.search_conversations(
  p_matterspace_ids uuid[] default null,
  p_query text default '',
  p_limit int default 20
)
returns table (
  comment_id uuid, conversation_id uuid, conversation_title text, matterspace_id uuid,
  matter_name text, audience text, ai_readable boolean, kind text, author_id uuid,
  author_name text, created_at timestamptz, email_from text, email_to text, email_cc text,
  email_subject text, email_date timestamptz, body text, snippet text, rank real
)
language sql
stable
security invoker
as $$
  select * from conversations_internal.search_core(
    p_matterspace_ids, p_query, p_limit, false, null, null, null)
$$;

-- For ANY AI, connector or agent: ai_readable conversations only, never a
-- sealed or paused matter. lib/mcp-core.mjs calls this and nothing else.
create or replace function public.search_conversations_for_ai(
  p_matterspace_ids uuid[],
  p_query text,
  p_limit int default 10
)
returns table (
  comment_id uuid, conversation_id uuid, conversation_title text, matterspace_id uuid,
  matter_name text, audience text, ai_readable boolean, kind text, author_id uuid,
  author_name text, created_at timestamptz, email_from text, email_to text, email_cc text,
  email_subject text, email_date timestamptz, body text, snippet text, rank real
)
language sql
stable
security invoker
as $$
  select * from conversations_internal.search_core(
    p_matterspace_ids, p_query, p_limit, true, null, null, null)
$$;

create or replace function public.grep_conversations_for_ai(
  p_matterspace_ids uuid[],
  p_pattern text,
  p_regex boolean default false,
  p_case_sensitive boolean default false,
  p_limit int default 200
)
returns table (
  comment_id uuid, conversation_id uuid, conversation_title text, matterspace_id uuid,
  matter_name text, audience text, ai_readable boolean, kind text, author_id uuid,
  author_name text, created_at timestamptz, email_from text, email_to text, email_cc text,
  email_subject text, email_date timestamptz, body text, snippet text, rank real
)
language sql
stable
security invoker
as $$
  select * from conversations_internal.search_core(
    p_matterspace_ids, null, p_limit, true, p_pattern, p_regex, p_case_sensitive)
$$;

revoke all on function public.list_matter_conversations(uuid) from public;
revoke all on function public.ensure_general_conversation(uuid) from public;
revoke all on function public.create_matter_conversation(uuid, text, text, boolean, uuid[]) from public;
revoke all on function public.matter_conversation_people(uuid) from public;
revoke all on function public.search_conversations(uuid[], text, int) from public;
revoke all on function public.search_conversations_for_ai(uuid[], text, int) from public;
revoke all on function public.grep_conversations_for_ai(uuid[], text, boolean, boolean, int) from public;
grant execute on function public.list_matter_conversations(uuid) to authenticated, service_role;
grant execute on function public.ensure_general_conversation(uuid) to authenticated, service_role;
grant execute on function public.create_matter_conversation(uuid, text, text, boolean, uuid[]) to authenticated, service_role;
grant execute on function public.matter_conversation_people(uuid) to authenticated, service_role;
grant execute on function public.search_conversations(uuid[], text, int) to authenticated, service_role;
grant execute on function public.search_conversations_for_ai(uuid[], text, int) to authenticated, service_role;
grant execute on function public.grep_conversations_for_ai(uuid[], text, boolean, boolean, int) to authenticated, service_role;


-- ============================================================================
-- 10. activity_feed: 042's definition, with the message title rule above
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
    case
      when cv.id is null or (cv.audience = 'matter' and cv.ai_readable)
        then left(regexp_replace(mc.body, '\s+', ' ', 'g'), 80)
      when cv.audience = 'members'
        then 'Message in a private conversation'
      else left('Message in ' || cv.title, 80)
    end                           as title
  from public.matter_comments mc
  left join public.matter_conversations cv on cv.id = mc.conversation_id
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


-- ============================================================================
-- 11. Realtime for the new tables (RLS applies on the receive side, as 017)
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public'
         and tablename = 'matter_conversations'
    ) then
      execute 'alter publication supabase_realtime add table public.matter_conversations';
    end if;
    -- So a conversation someone is added to appears in their open Thread tab.
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public'
         and tablename = 'matter_conversation_members'
    ) then
      execute 'alter publication supabase_realtime add table public.matter_conversation_members';
    end if;
  end if;
end $$;

notify pgrst, 'reload schema';


-- ============================================================================
-- ROLLBACK (do not run unless you mean it)
-- ============================================================================
-- FIRST LINE THAT MATTERS: after a rollback every message is back in the one
-- thread that everyone on the matter reads. So the rollback DELETES the
-- messages of private conversations first. Export them before running it if
-- they are wanted:
--   select c.matterspace_id, c.title, mc.* from public.matter_comments mc
--     join public.matter_conversations c on c.id = mc.conversation_id
--    where c.audience = 'members';
--
-- begin;
--   delete from public.matter_comments mc
--    using public.matter_conversations c
--    where c.id = mc.conversation_id and c.audience = 'members';
--   -- 042's view, verbatim (the comment branch without the join):
--   create or replace view public.activity_feed with (security_invoker = true) as
--     ... paste section 0 of 042_matter_state_ledger.sql from "select" to ";" ...
--   drop function if exists public.search_conversations(uuid[], text, int);
--   drop function if exists public.search_conversations_for_ai(uuid[], text, int);
--   drop function if exists public.grep_conversations_for_ai(uuid[], text, boolean, boolean, int);
--   drop function if exists public.list_matter_conversations(uuid);
--   drop function if exists public.ensure_general_conversation(uuid);
--   drop function if exists public.create_matter_conversation(uuid, text, text, boolean, uuid[]);
--   drop function if exists public.matter_conversation_people(uuid);
--   drop policy if exists "Conversation audience reads messages" on public.matter_comments;
--   drop policy if exists "Conversation audience posts messages" on public.matter_comments;
--   drop policy if exists "Authors edit their own messages"      on public.matter_comments;
--   drop policy if exists "Authors or admins delete messages"    on public.matter_comments;
--   create policy "Members can read matter comments" on public.matter_comments for select
--     using (public.can_access_matter(matterspace_id));
--   create policy "Members can post matter comments" on public.matter_comments for insert
--     with check (user_id = auth.uid() and public.can_access_matter(matterspace_id));
--   create policy "Authors can edit their own comments" on public.matter_comments for update
--     using (user_id = auth.uid()) with check (user_id = auth.uid());
--   create policy "Authors or admins can delete comments" on public.matter_comments for delete
--     using (user_id = auth.uid() or public.can_manage_matter(matterspace_id));
--   drop trigger if exists matter_comments_fill_conversation  on public.matter_comments;
--   drop trigger if exists matter_comments_guard_update       on public.matter_comments;
--   drop trigger if exists matter_comments_touch_conversation on public.matter_comments;
--   drop index if exists public.idx_matter_comments_tsv;
--   drop index if exists public.idx_matter_comments_conversation_created;
--   alter table public.matter_comments drop constraint if exists matter_comments_conversation_fk;
--   alter table public.matter_comments drop constraint if exists matter_comments_kind_check;
--   alter table public.matter_comments drop constraint if exists matter_comments_email_fields_check;
--   delete from public.matter_comments where length(body) > 10000;   -- only pasted emails can be this long
--   alter table public.matter_comments drop constraint if exists matter_comments_body_check_091;
--   alter table public.matter_comments add constraint matter_comments_body_check
--     check (length(trim(body)) > 0 and length(body) <= 10000);
--   alter table public.matter_comments
--     drop column if exists tsv, drop column if exists conversation_id, drop column if exists kind,
--     drop column if exists email_from, drop column if exists email_to, drop column if exists email_cc,
--     drop column if exists email_date, drop column if exists email_subject, drop column if exists email_quoted;
--   drop table if exists public.matter_conversation_reads;
--   drop table if exists public.matter_conversation_members;
--   drop table if exists public.matter_conversations;
--   drop function if exists public._mconv_message_visible(uuid, uuid, timestamptz);
--   drop function if exists public._mconv_can_post(uuid, uuid);
--   drop function if exists public._mconv_can_delete_message(uuid, uuid, uuid, timestamptz);
--   drop function if exists public._mconv_conversation_visible(uuid);
--   drop function if exists public._mconv_can_open_matter(uuid);
--   drop function if exists public._mconv_can_start(uuid, text, boolean);
--   drop function if exists public._mconv_can_manage(uuid);
--   drop function if exists public._mconv_can_add_member(uuid);
--   drop schema if exists conversations_internal cascade;
--   notify pgrst, 'reload schema';
-- commit;
