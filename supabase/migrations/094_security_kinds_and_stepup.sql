-- 094_security_kinds_and_stepup.sql — S1: a second factor at the door of a
-- sealed matter, and the Record's vocabulary for the whole security build
--
-- docs/specs/SECURITY-BUILD-2026-09-26.md §3 and §S1. Six things, in order:
--
--   1. The Record's vocabulary gains every kind the security build will write
--      — all fifteen, now, in the first migration of the build, so no later
--      slice has to reopen events_kind_check (064's own lesson).
--   2. The account chain (072) admits the kinds that belong to a person
--      rather than a matter: the auth.* rows this slice writes, and the
--      account.* / tripwire.* / share.reviewed rows S2, S4c and S5 will.
--   3. auth_is_aal2(), effective_tier_is_sealed(), sealed_entry_allowed() —
--      the three questions the gate asks — and matter_entry() /
--      second_factor_status(), which let the app ask them out loud.
--   4. THE GATE. The matterspaces SELECT policy gains: a sealed matter (its
--      own tier or any ancestor's is B or C) is visible only to a session
--      that has confirmed a second factor. Applied at MATTER ENTRY and in the
--      search functions' scope check — never per row on passages (074/078's
--      search path is the performance-sensitive one; the matter gate is
--      enough there because every passage search is scoped by matter).
--   5. Devices: two service-role-only functions over auth.sessions, which
--      PostgREST does not expose. api/account-sessions.mjs is the only caller.
--   6. index events (actor_ref, ts desc), which S5's tripwires count on.
--
-- WHO THE GATE IS FOR
-- ---------------------------------------------------------------------------
-- Browser sessions: a Supabase Auth access token, which always carries `aal`.
-- NOT connectors, agents or the worker. The worker uses the service role
-- (BYPASSRLS; untouched). The MCP server and the connector-token endpoints
-- (api/mcp.mjs, lib/connector-token-auth.mjs) mint their own short-lived user
-- JWT, and the seal already governs those callers — it refuses a sealed matter
-- with a sentence and writes `tool.invoked {refused:'sealed'}`, which S5
-- watches. Hiding the matter from them here would replace that sentence and
-- that row with "not found". So lib/supabase-user-jwt.mjs now stamps its
-- tokens `cs_via: 'connector'`, and only a token carrying that claim is
-- exempt. It fails CLOSED: a token with neither aal2 nor the stamp is gated.
-- The stamp cannot be forged without the signing key that already lets its
-- holder mint any user's token.
--
-- THE GRACE (Eden's E2)
-- ---------------------------------------------------------------------------
-- The second factor is required from 2026-10-15 (second_factor_required_from
-- below — the ONE place that date lives; the app reads it from
-- second_factor_status()). Until then, a person with NO verified factor is
-- not gated, because there is nothing for them to step up with and pasting
-- this file must not lock anyone out of their own sealed matter. A person who
-- HAS a factor steps up from the day this lands. After the date the grace
-- ends only for sessions SIGNED IN after it (the JWT's `amr` timestamps): an
-- existing session is never shut out of a matter mid-work — and with E3's
-- seven-day timebox none outlives the date by more than a week.
--
-- WHAT THE GATE DOES NOT COVER (said here and in the PR)
-- ---------------------------------------------------------------------------
-- A direct PostgREST read of `documents` or `passages` BY MATTER ID is still
-- decided by can_access_matter alone: the spec's stated choice (§S1: "the
-- matter gate is enough"), because putting an ancestry walk into the per-row
-- policy on passages is the cost 078 exists to avoid. The app never reaches a
-- sealed matter's documents without entering the matter first; a person
-- holding a password and a matter's uuid, and nothing else, could. S4a's
-- storage clause closes the bytes; the rows are a follow-up.
--
-- House rules followed: SECURITY DEFINER bodies live in a schema PostgREST
-- does not expose (`stepup_internal`, like search_internal / vault_internal)
-- and are reached through SECURITY INVOKER plpgsql that captures auth.uid()
-- into a declared variable at entry (feedback_rls_security_invoker_wrappers,
-- migration 022). The ancestry walk MUST be definer: from inside the
-- matterspaces policy an invoker read of matterspaces would re-enter the
-- policy being defined, and at aal1 a sealed parent is invisible, so an
-- inherited seal would read as open.
--
-- Apply order: after 093. Needs 016 (can_access_matter, matter_ancestry), 022
-- (_mtspc_select_check) and 051 (ai_tier). The ledger parts need 064 and 072
-- and are skipped with a notice without them; the search wrappers are
-- replaced only where 078 / 081 / 091 already put them. Re-runnable, and
-- executed twice end-to-end by scripts/_verify-stepup-seal.mjs.
--
-- ⚠ After pasting this file, run:  notify pgrst, 'reload schema';
--   (it is the last statement here.)
--
-- ⚠ DEPLOY ORDER: deploy the code first, then paste this file. Pasted first,
--   the connector stamp does not exist yet, so sealed matters vanish from
--   connected assistants (already refused; the refusal reads "not found"
--   instead of the seal's sentence) until the deploy lands. Nothing opens.
--   The code merged before the paste is inert: the app's probes fall back to
--   today's behaviour when these functions are absent.


-- ============================================================================
-- 1. The vocabulary — 073's guarded pattern, the UNION of every legal kind
-- ============================================================================
do $migration$
begin

if to_regclass('public.events') is null then
  raise notice '094: public.events is absent — migration 064 has not been applied; kinds and index skipped.';
  return;
end if;

execute $sql$
  alter table public.events drop constraint if exists events_kind_check
$sql$;
execute $sql$
  alter table public.events add constraint events_kind_check check (kind in (
    'tool.invoked',
    'completion.requested',
    'completion.received',
    'file.exported',
    'file.sent',
    'file.delivered',
    'file.gate',
    'citation.verified',
    'acl.changed',
    'seal.changed',
    'connector.registered',
    'connector.connected',
    'connector.revoked',
    'ai.paused',
    'ai.resumed',
    'run.aborted',
    -- 094: the security build (spec §3). Defined for every slice now; only
    -- the three auth.* rows marked S1 are written by this PR.
    'auth.factor_enrolled',     -- S1
    'auth.factor_unenrolled',   -- S1
    'auth.stepup',              -- S1
    'auth.new_device',          -- S5
    'account.locked',           -- S2
    'account.unlocked',         -- S2
    'matter.disconnected',      -- S2
    'file.filed',               -- S3
    'file.integrity',           -- S3
    'file.opened',              -- S4a
    'file.flagged',             -- S6
    'share.expired',            -- S4b
    'share.reviewed',           -- S4c
    'tripwire.tripped',         -- S5
    'tripwire.cleared'          -- S5
  ))
$sql$;

-- S5 counts one actor's acts over the last hour; this is what it counts on.
execute $sql$
  create index if not exists events_actor_ref_ts_idx on public.events (actor_ref, ts desc)
$sql$;

raise notice '094: events_kind_check widened by fifteen kinds; events_actor_ref_ts_idx present.';

end $migration$;


-- ============================================================================
-- 2. The account chain admits the kinds that belong to a person
-- ============================================================================
-- 072's list, widened. A factor, a step-up, a new device, a lockdown, a
-- tripwire and a monthly sharing review are facts about an ACCOUNT; none of
-- them happened "in" a matter. matter.disconnected, file.* and share.expired
-- stay matter-bound and are refused here, exactly as completion.received is.
-- Same signature, same grants; the body is 072's with the longer list.
do $migration$
begin

if to_regprocedure('public._ledger_append_account_checked(text,uuid,text,text,text,jsonb)') is null then
  raise notice '094: 072 is absent — the account chain is not widened. Paste 072, then this file again.';
  return;
end if;

execute $sql$
  create or replace function public._ledger_append_account_checked(
    p_kind text,
    p_session uuid,
    p_actor_kind text,
    p_actor_ref text,
    p_actor_label text,
    p_payload jsonb
  ) returns jsonb
  language plpgsql
  security definer
  set search_path = public
  as $fn$
  declare
    v_uid uuid := auth.uid();
  begin
    if v_uid is null then
      raise exception 'ledger_append_account requires an authenticated caller'
        using errcode = '42501';
    end if;
    if coalesce(p_kind, '') not in (
      'tool.invoked', 'connector.registered', 'connector.connected',
      'connector.revoked', 'ai.paused', 'ai.resumed',
      -- 094
      'auth.factor_enrolled', 'auth.factor_unenrolled', 'auth.stepup',
      'auth.new_device', 'account.locked', 'account.unlocked',
      'tripwire.tripped', 'tripwire.cleared', 'share.reviewed'
    ) then
      raise exception '% does not belong on an account chain', coalesce(p_kind, '(null)')
        using errcode = '22023',
              hint = 'Matter-bound kinds go through ledger_append with a matter.';
    end if;

    return public._ledger_write_scoped(
      p_kind, null, null, p_session,
      coalesce(p_actor_kind, 'user'), p_actor_ref, p_actor_label,
      p_payload, v_uid, v_uid);
  end $fn$
$sql$;

raise notice '094: the account chain admits the auth.*, account.*, tripwire.* and share.reviewed kinds.';

end $migration$;


-- ============================================================================
-- 3. The questions the gate asks
-- ============================================================================
create schema if not exists stepup_internal;
revoke all on schema stepup_internal from public;
grant usage on schema stepup_internal to authenticated, service_role;

comment on schema stepup_internal is
  'SECURITY DEFINER helpers for migration 094''s sealed-matter gate. Reached only '
  'through the public INVOKER wrappers. Do not add to PostgREST''s exposed schemas.';

-- The one date. Everything that needs "from when is a second factor
-- required" reads it here — the gate below and, through
-- second_factor_status(), the app. If this ships after 2026-10-01, move it to
-- the ship date + 14 days (Eden's E2: whichever is later).
create or replace function public.second_factor_required_from()
returns timestamptz
language sql
immutable
as $$ select timestamptz '2026-10-15 00:00:00-04' $$;

-- Spec §S1, verbatim but for the coalesce: a missing claim is "no", not NULL,
-- so an expression built on it can never evaluate to unknown.
create or replace function public.auth_is_aal2()
returns boolean
language sql
stable
security invoker
as $$ select coalesce(auth.jwt() ->> 'aal', '') = 'aal2' $$;

-- Effective tier sealed = B or C on the matter or on ANY ancestor (the seal is
-- inherited — lib/ai-tier-policy.mjs walkEffectiveTier). matter_ancestry is
-- 016's definer walk; the join to ai_tier runs as the owner, so no policy on
-- matterspaces is re-entered and an ancestor this caller cannot see still
-- counts.
create or replace function stepup_internal.effective_tier_is_sealed(p_matter uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.matter_ancestry(p_matter) a
      join public.matterspaces m on m.id = a.id
     where m.ai_tier in ('B', 'C')
  )
$$;

create or replace function stepup_internal.has_verified_factor(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from auth.mfa_factors f
     where f.user_id = p_uid and f.status::text = 'verified'
  )
$$;

-- Does this person reach any sealed matter at all — as a member of its
-- serverspace, or of it, an ancestor or a descendant? This is E2's "anyone
-- who opens a sealed matter", and it has to be asked as the owner: at aal1
-- the sealed matters are exactly the ones this caller cannot see.
create or replace function stepup_internal.reaches_sealed(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.matterspaces s
     where s.ai_tier in ('B', 'C')
       and (
         exists (select 1 from public.serverspace_members sm
                  where sm.serverspace_id = s.serverspace_id and sm.user_id = p_uid)
         or exists (
           select 1 from public.matterspace_members mm
            where mm.user_id = p_uid
              and (mm.matterspace_id in (select a.id from public.matter_ancestry(s.id) a)
                   or s.id in (select a.id from public.matter_ancestry(mm.matterspace_id) a)))
       )
  )
$$;

create or replace function stepup_internal.runs_a_serverspace(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.serverspace_members sm
     where sm.user_id = p_uid and sm.role in ('owner', 'admin')
  )
$$;

revoke all on function stepup_internal.effective_tier_is_sealed(uuid) from public;
revoke all on function stepup_internal.has_verified_factor(uuid) from public;
revoke all on function stepup_internal.reaches_sealed(uuid) from public;
revoke all on function stepup_internal.runs_a_serverspace(uuid) from public;
grant execute on function stepup_internal.effective_tier_is_sealed(uuid) to authenticated, service_role;
grant execute on function stepup_internal.has_verified_factor(uuid) to authenticated, service_role;
grant execute on function stepup_internal.reaches_sealed(uuid) to authenticated, service_role;
grant execute on function stepup_internal.runs_a_serverspace(uuid) to authenticated, service_role;

-- The public name the spec gives it, so S4a's storage clause can say the same
-- words. INVOKER over the definer walk.
create or replace function public.effective_tier_is_sealed(p_matter uuid)
returns boolean
language plpgsql
stable
security invoker
as $$
begin
  if p_matter is null then return false; end if;
  return stepup_internal.effective_tier_is_sealed(p_matter);
end $$;

-- May THIS session enter a sealed matter? (Whether it may enter this
-- particular matter at all is the membership check's question, asked
-- separately; this answers only the second-factor half.)
create or replace function public.sealed_entry_allowed()
returns boolean
language plpgsql
stable
security invoker
as $$
declare
  v_uid       uuid  := auth.uid();
  v_claims    jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_signed_in timestamptz;
begin
  if v_uid is null then return false; end if;

  -- A session that has confirmed its second factor.
  if coalesce(v_claims ->> 'aal', '') = 'aal2' then return true; end if;

  -- A token our own server minted for a connector: the seal governs it, not
  -- this gate (see the header). Fails closed — no stamp, no exemption.
  if coalesce(v_claims ->> 'cs_via', '') = 'connector' then return true; end if;

  -- Someone with a factor steps up. Always, from the day this lands.
  if stepup_internal.has_verified_factor(v_uid) then return false; end if;

  -- Someone without one: the grace, for sessions signed in before the date.
  -- `amr` carries the sign-in time; a token without it is treated as signed in
  -- now, so after the date an unreadable token is gated rather than waved on.
  if jsonb_typeof(v_claims -> 'amr') = 'array' then
    select to_timestamp(min((a ->> 'timestamp')::double precision))
      into v_signed_in
      from jsonb_array_elements(v_claims -> 'amr') a
     where jsonb_typeof(a -> 'timestamp') = 'number';
  end if;
  return coalesce(v_signed_in, now()) < public.second_factor_required_from();
end $$;

-- The app's probe. A row the SELECT policy hides comes back as nothing — no
-- error, no 42501 — so "not found" and "sealed, confirm it's you" would look
-- the same to the matter page. This tells them apart, and says 'stepup' or
-- 'enrol' ONLY to someone who is already a member: to anyone else every
-- matter is 'none', so it is not an oracle for which matters are sealed.
--
--   'open'   enter
--   'stepup' sealed; this session must confirm its second factor
--   'enrol'  sealed; this person has no second factor to confirm with
--   'none'   no such matter, or not yours
create or replace function public.matter_entry(p_matter uuid)
returns text
language plpgsql
stable
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_matter is null then return 'none'; end if;
  if not public.can_access_matter(p_matter) then return 'none'; end if;
  if not stepup_internal.effective_tier_is_sealed(p_matter) then return 'open'; end if;
  if public.sealed_entry_allowed() then return 'open'; end if;
  if stepup_internal.has_verified_factor(v_uid) then return 'stepup'; end if;
  return 'enrol';
end $$;

-- Everything the enrolment banner and the sign-in route need, in one call.
--   required        E2: runs a serverspace, or reaches a sealed matter
--   required_from   the date above
--   in_force        the date has passed (the database's clock, not the browser's)
--   has_factor      a verified factor exists
--   sealed_waiting  sealed matters exist for this person that THIS session
--                   cannot enter yet (the sidebar is silent about them at
--                   aal1, so the app says so once, without naming any)
create or replace function public.second_factor_status()
returns jsonb
language plpgsql
stable
security invoker
as $$
declare
  v_uid     uuid := auth.uid();
  v_reaches boolean;
begin
  if v_uid is null then return null; end if;
  v_reaches := stepup_internal.reaches_sealed(v_uid);
  return jsonb_build_object(
    'required', stepup_internal.runs_a_serverspace(v_uid) or v_reaches,
    'required_from', public.second_factor_required_from(),
    'in_force', now() >= public.second_factor_required_from(),
    'has_factor', stepup_internal.has_verified_factor(v_uid),
    'aal2', public.auth_is_aal2(),
    'sealed_waiting', v_reaches and not public.sealed_entry_allowed()
  );
end $$;

revoke all on function public.matter_entry(uuid) from public, anon;
revoke all on function public.second_factor_status() from public, anon;
grant execute on function public.auth_is_aal2() to authenticated, service_role;
grant execute on function public.effective_tier_is_sealed(uuid) to authenticated, service_role;
grant execute on function public.sealed_entry_allowed() to authenticated, service_role;
grant execute on function public.matter_entry(uuid) to authenticated, service_role;
grant execute on function public.second_factor_status() to authenticated, service_role;
grant execute on function public.second_factor_required_from() to authenticated, service_role;


-- ============================================================================
-- 4. The gate — at matter entry
-- ============================================================================
-- 022's policy, plus one clause. `(select public.sealed_entry_allowed())` is
-- an initplan: asked once per statement, not once per matter row. The
-- ancestry walk runs only for rows the membership check has already let
-- through, and only when the session has not stepped up.
drop policy if exists "Members can view matterspaces" on public.matterspaces;
create policy "Members can view matterspaces"
  on public.matterspaces for select
  using (
    public._mtspc_select_check(id, serverspace_id, parent_matterspace_id)
    and ((select public.sealed_entry_allowed()) or not public.effective_tier_is_sealed(id))
  );


-- ============================================================================
-- 4b. The gate — in the search functions' scope check
-- ============================================================================
-- Each wrapper already decides, once per MATTER, which of the requested
-- matters the caller may read, and hands only those to its definer core.
-- That is where the same rule goes: a sealed matter drops out of the scope at
-- aal1. Nothing is added per row. Callers that bypass RLS (service_role) keep
-- bypassing it, exactly as 078/081 arranged.
do $migration$
begin

-- 078's public.search_passages
if to_regtype('vector') is not null and exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'search_internal' and p.proname = 'search_passages_core')
then
  execute $sql$
    create or replace function public.search_passages(
      p_matterspace_ids uuid[],
      p_query_text text,
      p_query_embedding vector(1024),
      p_doc_types text[] default null,
      p_witness_names text[] default null,
      p_document_ids uuid[] default null,
      p_summary_level int default 0,
      p_limit int default 20,
      p_embedding_model text default 'text-embedding-3-small',
      p_embedding_version int default 1
    )
    returns table (
      passage_id uuid,
      document_id uuid,
      document_title text,
      doc_type text,
      page_start int,
      page_end int,
      line_start int,
      line_end int,
      witness_name text,
      examination_type text,
      passage_type text,
      text text,
      hybrid_score real,
      text_rank real,
      vector_score real
    )
    language plpgsql
    stable
    as $fn$
    #variable_conflict use_column
    declare
      v_uid     uuid    := auth.uid();
      v_rls     boolean := row_security_active('public.passages');
      v_allowed uuid[];
      v_open    boolean;
    begin
      if not v_rls then
        v_allowed := p_matterspace_ids;
      elsif v_uid is null then
        return;
      else
        -- 094: asked once for the whole call; a sealed matter stays in scope
        -- only for a session that may enter one.
        v_open := public.sealed_entry_allowed();
        select coalesce(array_agg(m.id), '{}'::uuid[])
          into v_allowed
          from unnest(coalesce(p_matterspace_ids, '{}'::uuid[])) as m(id)
         where public.can_access_matter(m.id)
           and (v_open or not public.effective_tier_is_sealed(m.id));
      end if;

      if v_allowed is null or cardinality(v_allowed) = 0 then
        return;
      end if;

      return query
      select *
        from search_internal.search_passages_core(
          v_allowed,
          p_query_text,
          p_query_embedding,
          p_doc_types,
          p_witness_names,
          p_document_ids,
          p_summary_level,
          p_limit,
          p_embedding_model,
          p_embedding_version);
    end $fn$
  $sql$;
  raise notice '094: search_passages scope obeys the sealed-matter gate.';
else
  raise notice '094: search_internal.search_passages_core is absent (078 not applied) — search_passages left alone.';
end if;

-- 081's public.search_documents
if exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'vault_internal' and p.proname = 'search_documents_core')
then
  execute $sql$
    create or replace function public.search_documents(
      p_query text,
      p_matterspace_ids uuid[] default null,
      p_categories text[] default null,
      p_from timestamptz default null,
      p_to timestamptz default null,
      p_limit int default 20,
      p_offset int default 0
    )
    returns table (
      document_id uuid,
      title text,
      source_filename text,
      matterspace_id uuid,
      matterspace_name text,
      category text,
      doc_type text,
      processing_status text,
      page_count int,
      file_size_bytes bigint,
      created_at timestamptz,
      updated_at timestamptz,
      sealed boolean,
      rank real
    )
    language plpgsql
    stable
    security invoker
    as $fn$
    #variable_conflict use_column
    declare
      v_uid     uuid    := auth.uid();
      v_rls     boolean := row_security_active('public.documents');
      v_allowed uuid[];
      v_open    boolean;
    begin
      if not v_rls then
        if p_matterspace_ids is null then
          raise exception
            'search_documents: p_matterspace_ids is required for a caller that bypasses RLS'
            using errcode = '22023';
        end if;
        v_allowed := p_matterspace_ids;
      elsif v_uid is null then
        return;
      elsif p_matterspace_ids is null then
        -- matterspaces' own policy already leaves a sealed matter out at aal1.
        select coalesce(array_agg(m.id), '{}'::uuid[])
          into v_allowed
          from public.matterspaces m
         where public.can_access_matter(m.id);
      else
        v_open := public.sealed_entry_allowed();
        select coalesce(array_agg(m.id), '{}'::uuid[])
          into v_allowed
          from unnest(p_matterspace_ids) as m(id)
         where public.can_access_matter(m.id)
           and (v_open or not public.effective_tier_is_sealed(m.id));
      end if;

      if v_allowed is null or cardinality(v_allowed) = 0 then
        return;
      end if;

      return query
      select * from vault_internal.search_documents_core(
        v_allowed, p_query, p_categories, p_from, p_to, p_limit, p_offset);
    end $fn$
  $sql$;
  raise notice '094: search_documents scope obeys the sealed-matter gate.';
else
  raise notice '094: vault_internal.search_documents_core is absent (081 not applied) — search_documents left alone.';
end if;

-- 091's public.search_conversations (the person's Thread / Vault search; the
-- _for_ai variants already exclude every sealed matter, for every caller).
-- It was a one-line SQL wrapper over a definer core that checks access per
-- message; the scope is now resolved first, under matterspaces' own policy.
if exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'conversations_internal' and p.proname = 'search_core')
then
  execute $sql$
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
    language plpgsql
    stable
    security invoker
    as $fn$
    #variable_conflict use_column
    declare
      v_ids uuid[] := p_matterspace_ids;
    begin
      if row_security_active('public.matterspaces') and not public.sealed_entry_allowed() then
        select coalesce(array_agg(m.id), '{}'::uuid[])
          into v_ids
          from public.matterspaces m            -- the gate above applies here
         where p_matterspace_ids is null or m.id = any(p_matterspace_ids);
      end if;
      return query
      select * from conversations_internal.search_core(
        v_ids, p_query, p_limit, false, null, null, null);
    end $fn$
  $sql$;
  raise notice '094: search_conversations scope obeys the sealed-matter gate.';
else
  raise notice '094: conversations_internal.search_core is absent (091 not applied) — search_conversations left alone.';
end if;

end $migration$;


-- ============================================================================
-- 5. Devices — this account's sessions, for the service role only
-- ============================================================================
-- auth.sessions is not exposed by PostgREST and must not be readable by a
-- browser. api/account-sessions.mjs verifies the bearer, then calls these with
-- the service key and the VERIFIED user id; there is no path by which one
-- person names another's sessions. Definer because the service role cannot
-- reach the auth schema through PostgREST either; no INVOKER wrapper, because
-- nothing here reads auth.uid() — the id is an argument the endpoint proved.
--
-- Revoking deletes the session row. Its refresh tokens go with it (FK
-- cascade), so that device cannot renew; the access token it already holds
-- stays valid until it expires (the project's JWT expiry, an hour by default).
create or replace function public.account_sessions(p_user uuid)
returns table (
  id uuid,
  created_at timestamptz,
  refreshed_at timestamptz,
  not_after timestamptz,
  aal text,
  user_agent text,
  ip text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_user is null then return; end if;
  return query
  select s.id,
         s.created_at,
         coalesce(s.refreshed_at at time zone 'UTC', s.updated_at, s.created_at),
         s.not_after,
         s.aal::text,
         s.user_agent,
         host(s.ip)
    from auth.sessions s
   where s.user_id = p_user
   order by coalesce(s.refreshed_at at time zone 'UTC', s.updated_at, s.created_at) desc
   limit 50;
end $$;

create or replace function public.account_session_revoke(p_user uuid, p_session uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  if p_user is null or p_session is null then return false; end if;
  delete from auth.sessions s where s.id = p_session and s.user_id = p_user;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

revoke all on function public.account_sessions(uuid) from public, anon, authenticated;
revoke all on function public.account_session_revoke(uuid, uuid) from public, anon, authenticated;
grant execute on function public.account_sessions(uuid) to service_role;
grant execute on function public.account_session_revoke(uuid, uuid) to service_role;


notify pgrst, 'reload schema';
