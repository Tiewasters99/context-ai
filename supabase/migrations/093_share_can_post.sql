-- Contextspaces Migration 093: a per-person "Can post messages" switch on
-- matter shares, OFF for people shared into a matter from now on.
--
-- What changes for a person
-- ---------------------------------------------------------------------------
-- Until now (091) anyone who could open a matter could post in its
-- conversations for everyone and start new ones. Eden, 2026-09-25: people you
-- share a matter or folder with should be able to READ its Thread, and WRITE
-- in it only once the matter's owners or admins turn that on for them.
--
--   * matterspace_members gains can_post (boolean). Every share that exists
--     when this is pasted is set to TRUE, so nobody who can post today loses
--     it. Every share made afterwards starts FALSE.
--   * Who may post in matter M (a message, a reply, a pasted email, Moot
--     Bench's "share to Thread", the old one-thread screen) or start a
--     conversation in it:
--       - the matter's owners and admins, always (the effective role exactly
--         as can_manage_matter decides it, ancestors included);
--       - members of M's serverspace, as today (they see the whole
--         serverspace);
--       - a person shared in through matterspace_members, when SOME share
--         that gives them M (the row for M itself or for an ancestor of M)
--         has can_post = true.
--   * Reading is untouched: message_access (091), which every SELECT policy
--     uses, is not changed by this file.
--   * The one setting (ONE line below):
--       conversations_internal.setting_private_members_may_post() = true
--       Someone an owner or admin has put on a private conversation's member
--       list may post in THAT conversation even with can_post off: being
--       added to it is the authorisation for it. false = the switch governs
--       private conversations too. src/lib/conversations.ts mirrors it;
--       scripts/_verify-can-post.mjs fails if they disagree.
--   * Owners and admins can turn can_post on or off for other people's
--     shares on matters they manage (a new UPDATE policy; 016 had none).
--     Nobody can flip their own. can_post is the ONLY column the app may
--     update on matterspace_members (column-level grant).
--
-- Where the rule lives
-- ---------------------------------------------------------------------------
-- 091 routes every posting path through two policy helpers:
--   matter_comments INSERT      -> public._mconv_can_post
--   matter_conversations INSERT -> public._mconv_can_start
--                                  (create_matter_conversation is INVOKER, so
--                                  it goes through this policy too)
-- A comment inserted without a conversation (Moot Bench, the legacy screen)
-- is filed into General by a BEFORE trigger, and the INSERT policy is checked
-- after it, so it meets the same gate. ensure_general_conversation may still
-- CREATE General for anyone who can open the matter; posting into it is gated.
-- No SECURITY DEFINER function inserts comments on a person's behalf.
--
-- RLS shape: unchanged from 091 — every policy calls a public SECURITY
-- INVOKER wrapper that reads auth.uid() once and hands it to a SECURITY
-- DEFINER helper in conversations_internal.
--
-- Also recorded: 064's ACL trigger on matterspace_members fires on the
-- can_post update, so each switch is written to the matter's Record as an
-- acl.changed event (its payload names the role, which does not change).
--
-- Additive and idempotent. The column is added with DEFAULT TRUE (which fills
-- the rows that exist at that moment) and the default is then set to FALSE,
-- so a second paste changes nothing and never switches anyone back on.
-- NOT applied by the PR that adds it.
--
-- Rollback: at the bottom, commented out.
--
-- Verified by execution in PGlite on 001…022 + 017 + 021 + 062 + 042 + 091 +
-- 092 with real RLS from SET ROLE authenticated:
--   node scripts/_verify-can-post.mjs


-- ============================================================================
-- 1. The column
-- ============================================================================
alter table public.matterspace_members
  add column if not exists can_post boolean not null default true;
alter table public.matterspace_members
  alter column can_post set default false;

comment on column public.matterspace_members.can_post is
  'May this person post in the matter''s Thread (messages, pasted emails, new '
  'conversations)? Off for new shares; owners/admins turn it on. Owners and '
  'admins always post regardless (093).';


-- ============================================================================
-- 2. The setting, and the rule (DEFINER, explicit user id, never auth.uid())
-- ============================================================================
create or replace function conversations_internal.setting_private_members_may_post()
returns boolean language sql immutable as $$ select true $$;

-- May p_uid post in (or start a conversation in) matter p_matter, as a
-- matter-wide right?
create or replace function conversations_internal.user_can_post_in_matter(p_uid uuid, p_matter uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    p_uid is not null and p_matter is not null and (
      conversations_internal.user_can_manage_matter(p_uid, p_matter)
      or exists (
        select 1
          from public.matterspaces m
          join public.serverspace_members sm on sm.serverspace_id = m.serverspace_id
         where m.id = p_matter and sm.user_id = p_uid)
      or exists (
        select 1
          from public.matterspace_members mm
         where mm.user_id = p_uid
           and mm.can_post
           and mm.matterspace_id in (select id from public.matter_ancestry(p_matter)))
    ), false)
$$;

-- May p_uid post a message in conversation p_conv of matter p_matter?
-- p_conv null = the General thread. The whole posting rule, once.
create or replace function conversations_internal.message_post(p_uid uuid, p_conv uuid, p_matter uuid)
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
  if p_uid is null then return false; end if;
  if p_conv is null then
    return p_matter is not null
       and conversations_internal.message_access(p_uid, null, p_matter, null)
       and conversations_internal.user_can_post_in_matter(p_uid, p_matter);
  end if;

  select c.matterspace_id, c.audience, c.archived_at
    into v_matter, v_audience, v_archived
    from public.matter_conversations c
   where c.id = p_conv;
  if v_matter is null then return false; end if;
  if v_archived is not null then return false; end if;          -- archived = read-only (091)
  -- First: can they read it at all? (091's rule, unchanged; it also refuses a
  -- message naming one matter and another matter's conversation.)
  if not conversations_internal.message_access(p_uid, p_conv, p_matter, null) then return false; end if;

  if conversations_internal.user_can_post_in_matter(p_uid, v_matter) then return true; end if;

  -- Put on a private conversation's list by its starter (an owner or admin):
  -- that is authorisation for this conversation.
  if v_audience = 'members'
     and conversations_internal.setting_private_members_may_post()
     and exists (select 1 from public.matter_conversation_members cm
                  where cm.conversation_id = p_conv and cm.user_id = p_uid) then
    return true;
  end if;
  return false;
end $$;

-- 091's conversation_start, with one added line: starting any conversation
-- needs the matter-wide posting right.
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
  if coalesce(p_is_general, false) then return false; end if;
  if not conversations_internal.user_can_open_matter(p_uid, p_matter) then return false; end if;
  if not conversations_internal.user_can_post_in_matter(p_uid, p_matter) then return false; end if;   -- 093
  if p_audience = 'members'
     and conversations_internal.setting_private_started_by() = 'managers'
     and not conversations_internal.user_can_manage_matter(p_uid, p_matter) then
    return false;
  end if;
  return true;
end $$;

revoke all on function conversations_internal.setting_private_members_may_post() from public;
revoke all on function conversations_internal.user_can_post_in_matter(uuid, uuid) from public;
revoke all on function conversations_internal.message_post(uuid, uuid, uuid) from public;
revoke all on function conversations_internal.conversation_start(uuid, uuid, text, boolean) from public;
grant execute on function conversations_internal.setting_private_members_may_post() to authenticated, service_role;
grant execute on function conversations_internal.user_can_post_in_matter(uuid, uuid) to authenticated, service_role;
grant execute on function conversations_internal.message_post(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function conversations_internal.conversation_start(uuid, uuid, text, boolean) to authenticated, service_role;


-- ============================================================================
-- 3. The posting wrapper the matter_comments INSERT policy already calls
-- ============================================================================
-- Same name and signature as 091, so the policy picks it up unchanged. The
-- Thread tab also calls it (and _mconv_can_start) to decide whether to show
-- the composer, so what the screen offers is exactly what the database allows.
create or replace function public._mconv_can_post(p_conv uuid, p_matter uuid)
returns boolean
language plpgsql stable security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  return conversations_internal.message_post(v_uid, p_conv, p_matter);
end $$;


-- ============================================================================
-- 4. Owners and admins set the switch on other people's shares
-- ============================================================================
create or replace function public._mmem_can_set_post(p_matter uuid, p_user uuid)
returns boolean
language plpgsql stable security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_matter is null or p_user is null then return false; end if;
  if p_user = v_uid then return false; end if;        -- nobody flips their own
  return conversations_internal.user_can_manage_matter(v_uid, p_matter);
end $$;

-- The 092 lesson: Supabase's default privileges grant a new public function
-- to anon directly, and a revoke FROM PUBLIC does not remove that.
revoke all on function public._mmem_can_set_post(uuid, uuid) from public;
revoke all on function public._mmem_can_set_post(uuid, uuid) from anon;
grant execute on function public._mmem_can_set_post(uuid, uuid) to authenticated, service_role;

drop policy if exists "Admins of the matter set who can post" on public.matterspace_members;
create policy "Admins of the matter set who can post"
  on public.matterspace_members for update
  using (public._mmem_can_set_post(matterspace_id, user_id))
  with check (public._mmem_can_set_post(matterspace_id, user_id));

-- can_post is the only column the app may change on a share. (No UPDATE
-- policy existed before this file, so no app update ever succeeded; role
-- changes stay remove-and-re-add, as the Share dialog does them.)
revoke update on public.matterspace_members from public, anon, authenticated;
grant update (can_post) on public.matterspace_members to authenticated;
grant all on public.matterspace_members to service_role;

notify pgrst, 'reload schema';


-- ============================================================================
-- ROLLBACK (do not run unless you mean it)
-- ============================================================================
-- After a rollback everyone who can open a matter can post in it again, as
-- under 091. The can_post values are lost (export them first if wanted:
--   select matterspace_id, user_id, can_post from public.matterspace_members;).
--
-- begin;
--   drop policy if exists "Admins of the matter set who can post" on public.matterspace_members;
--   drop function if exists public._mmem_can_set_post(uuid, uuid);
--   grant update on public.matterspace_members to authenticated;
--   -- 091's _mconv_can_post, verbatim:
--   create or replace function public._mconv_can_post(p_conv uuid, p_matter uuid)
--   returns boolean language plpgsql stable security invoker as $f$
--   declare v_uid uuid := auth.uid();
--   begin
--     if v_uid is null then return false; end if;
--     if p_conv is not null and exists (
--       select 1 from public.matter_conversations c where c.id = p_conv and c.archived_at is not null
--     ) then return false; end if;
--     return conversations_internal.message_access(v_uid, p_conv, p_matter, null);
--   end $f$;
--   -- 091's conversation_start, verbatim (without the 093 line):
--   create or replace function conversations_internal.conversation_start(
--     p_uid uuid, p_matter uuid, p_audience text, p_is_general boolean
--   ) returns boolean language plpgsql stable security definer set search_path = public as $f$
--   begin
--     if p_uid is null or p_matter is null then return false; end if;
--     if coalesce(p_is_general, false) then return false; end if;
--     if not conversations_internal.user_can_open_matter(p_uid, p_matter) then return false; end if;
--     if p_audience = 'members'
--        and conversations_internal.setting_private_started_by() = 'managers'
--        and not conversations_internal.user_can_manage_matter(p_uid, p_matter) then
--       return false;
--     end if;
--     return true;
--   end $f$;
--   drop function if exists conversations_internal.message_post(uuid, uuid, uuid);
--   drop function if exists conversations_internal.user_can_post_in_matter(uuid, uuid);
--   drop function if exists conversations_internal.setting_private_members_may_post();
--   alter table public.matterspace_members drop column if exists can_post;
--   notify pgrst, 'reload schema';
-- commit;
