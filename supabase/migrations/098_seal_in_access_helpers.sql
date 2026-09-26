-- 098_seal_in_access_helpers.sql — S1b: the seal is checked wherever a
-- matter's rows are read or moved, not only at the matter's front door
--
-- docs/specs/SECURITY-BUILD-2026-09-26.md §S1 and §4. Migration 094 put a
-- second-factor gate on the matterspaces SELECT policy and in the search
-- functions' scope. The adversarial review of #245 showed that a gate at the
-- door is not a gate: documents, passages, comments, conversations and the
-- activity feed are read BY ID or BY MATTER ID through 016's helpers, which
-- never looked at the seal; an aal1 session could move a sealed matter's rows
-- into an open matter (and the seal was gone for everyone); and any browser
-- session could mint a connector token whose JWT 094 exempts. This file
-- closes those, in eleven parts:
--
--   1. matterspaces.sealed_effective — "this matter or an ancestor is Tier B
--      or C", stored on the row and kept true by two triggers (§1). The seal
--      becomes ONE COLUMN, so it can be asked per row.
--   2. stepup_internal.effective_tier_is_sealed() reads that column. The
--      ancestry walk survives as stepup_internal.effective_tier_walk(), used
--      by the backfill and by the harness to prove the column never drifts.
--   3. sealed_entry_allowed(): the grace has a hard end, and the sign-in time
--      it compares is the LATEST amr entry, not the earliest (HIGH-5).
--   4. THE HELPERS. matter_role / can_access_matter / can_write_matter /
--      can_manage_matter become INVOKER wrappers over one definer core that
--      asks membership (016's rule, unchanged) and then the seal. Every
--      policy that calls them — documents, passages, storage.objects,
--      matter_comments (via 091), content_items (via can_access_space),
--      meetings, matterspace_members — now refuses a sealed matter to a
--      session that may not enter one.
--   5. matter_entry() is re-based on membership alone (it must still say
--      'stepup' to a member the helpers now refuse), and document_entry()
--      asks the same question of a document id, for the Reader.
--   6. The matterspaces SELECT policy reads the column instead of walking.
--   7. conversations_internal.user_matter_role() — 091's own copy of the role
--      rule, used by every conversation policy and list function — applies
--      the seal when the user it is asked about is the session's own user.
--   8. documents and passages: explicit WITH CHECK on INSERT and UPDATE, and
--      a trigger that refuses to move a row OUT of a sealed matter unless the
--      session has confirmed a second factor (CRITICAL-2).
--   9. connector_tokens: no direct INSERT from the browser; a definer RPC
--      connector_token_create() that asks for the second factor when the
--      person has one; UPDATE narrowed to the columns the app writes, so a
--      token cannot be minted by overwriting token_hash either (CRITICAL-1).
--  10. account_session_revoke() takes the caller's aal and refuses a person
--      with a factor who has not confirmed it (MEDIUM-7).
--  11. notify pgrst.
--
-- WHY PER ROW IS NOW AFFORDABLE (and 078's objection does not apply)
-- ---------------------------------------------------------------------------
-- 078 moved search's access check from per ROW to per MATTER because the
-- per-row policy, can_access_matter(matterspace_id), cost ~0.05 ms and ~6
-- buffers per call and a connector search evaluated it 16,704 times. 094
-- then refused to add the seal to that policy, because the seal was an
-- ancestry walk (a recursive CTE per call) and would have multiplied the cost
-- 078 had just removed. With sealed_effective the seal is one column of the
-- same matterspaces row the membership check already reads, and the core
-- below asks it only AFTER membership has said yes. For a session at aal2 it
-- never goes further than that column and the `aal` claim — auth.mfa_factors
-- is not read. Only a sealed row at aal1 pays the factor lookup, and that is
-- the row being refused. search_passages / search_documents are untouched in
-- shape: their definer cores still bypass the per-row policy and authorise
-- once per matter exactly as 078 arranged; scripts/_verify-seal-in-access.mjs
-- times both that path and a direct per-row read before and after this file.
-- In PGlite (WASM, one process — a smoke check of the shape, not a production
-- figure), 2,501 passages per matter, four runs: search_passages 1.1–1.6× on
-- a ~5 ms call (a few more function calls per MATTER, nothing per row); a
-- direct read of an open matter 1.3–1.7× 095's per-row cost; of a sealed
-- matter at aal2 1.7–2.1× (the JWT is parsed per sealed row). The per-row cost
-- that 078 removed from search stays removed. After pasting, run in the SQL editor
--   explain analyze select count(*) from passages where matterspace_id = '<a big matter>';
-- as an aal2 session to see production's number.
--
-- WHO THE GATE IS FOR — unchanged from 094
-- ---------------------------------------------------------------------------
-- Browser sessions. The service role (the worker) bypasses RLS and every
-- helper here answers for auth.uid(), which it does not have. Tokens our own
-- server mints for api/mcp.mjs and the stdio server carry cs_via:'connector'
-- and stay exempt, because the seal governs them in lib/mcp-core.mjs with a
-- sentence and a tool.invoked {refused:'sealed'} row. The /api/ext/* routes
-- mint the same kind of token; this PR makes them refuse sealed matters in
-- code the way mcp-core does (api/ext/*.mjs), rather than narrowing the
-- exemption, which would turn mcp-core's refusal back into "not found".
--
-- WHAT THIS STILL DOES NOT COVER (said here and in the PR)
-- ---------------------------------------------------------------------------
--   * A grace session (no factor, signed in before the date) passes the
--     helpers, as 094 intends. It cannot MOVE a row out of a sealed matter
--     (§8 wants aal2), but it can read and edit inside one until the grace
--     ends.
--   * The leaving-the-seal trigger is on documents and passages only. Other
--     tables that carry a matter id (content_items.space_id, matter_comments,
--     meetings, …) are covered by the helpers on BOTH rows — USING on the old
--     row, and USING-as-CHECK or WITH CHECK on the new one — so an aal1
--     session cannot move them; a grace session could.
--   * storage.objects cannot carry a trigger of ours. Its UPDATE policy (049)
--     already asks can_write_matter of the old and the new path, so it obeys
--     the helpers; api/move-document.mjs asks seal_leave_allowed() before it
--     renames anything.
--   * meetings / can_access_meeting keep `or created_by = auth.uid()`: the
--     person who started a meeting in a sealed matter still sees that meeting
--     row at aal1.
--   * api/office.mjs serves a published Office item's passages with the
--     service role. Publishing a sealed matter's document to the public Office
--     is the owner's own act and is not refused here.
--   * OAuth consent (api/oauth-approve.mjs → 087's oauth_grant_approve, as the
--     service role) is not asked for a second factor. What it creates is an
--     MCP connection, which the seal already refuses sealed matters to.
--
-- DEPLOY ORDER: deploy the code first, then paste this file.
--   Code before paste: every new RPC the app calls (connector_token_create,
--   document_entry, seal_leave_allowed, the 3-argument
--   account_session_revoke) answers PGRST202, and the code falls back to what
--   it did before (a direct token insert; the old error page; no precheck;
--   the 2-argument revoke). Nothing opens that is closed today.
--   Paste before code: the browser's direct token insert is refused (the
--   policy is gone) — "Generate token" and "New agent" fail until the deploy
--   lands — and "Sign out that device" answers 503 (the 2-argument function
--   is gone). Nothing opens either way.
--
-- House rules: SECURITY DEFINER bodies live in stepup_internal (094's schema,
-- not exposed by PostgREST) and are reached through SECURITY INVOKER plpgsql
-- that captures auth.uid() at entry (feedback_rls_security_invoker_wrappers,
-- 022). Every wrapper answers an anonymous caller before touching
-- stepup_internal, whose USAGE anon does not have — an anon read of a table
-- whose policy calls a helper must stay "no rows", not "permission denied".
--
-- Apply order: after 094 and 095 (097 and 099 are independent). Needs 016,
-- 051, 085, 088, 091 and 094 — asserted in §0. Re-runnable; executed twice
-- end-to-end by scripts/_verify-seal-in-access.mjs.
--
-- ROLLBACK (in this order; each line restores the pre-098 behaviour of its
-- part, and none of them widens anything beyond what 094 allowed):
--   drop trigger if exists documents_refuse_leaving_seal on public.documents;
--   drop trigger if exists passages_refuse_leaving_seal on public.passages;
--   drop trigger if exists matterspaces_sealed_effective on public.matterspaces;
--   drop trigger if exists matterspaces_sealed_effective_cascade on public.matterspaces;
--   -- then re-run 016's four helper definitions, 091 §4's user_matter_role,
--   -- 094 §3 (effective_tier_is_sealed, sealed_entry_allowed, matter_entry)
--   -- and 094 §4 / §5 (the matterspaces policy, account_session_revoke), and
--   -- 003's INSERT policy + `grant insert, update on public.connector_tokens
--   -- to authenticated`. The column may stay: nothing reads it after that.
--   drop function if exists public.connector_token_create(text, text, text, text, text, uuid[], boolean);
--   drop function if exists public.document_entry(uuid);
--   drop function if exists public.seal_leave_allowed(uuid, uuid);
--
-- ⚠ After pasting this file, run:  notify pgrst, 'reload schema';
--   (it is the last statement here.)


-- ============================================================================
-- 0. Prerequisites — refuse to install on a database that is missing a layer
-- ============================================================================
do $migration$
declare
  v_missing text[] := '{}';
  v_fn text;
begin
  foreach v_fn in array array[
    'public.matter_ancestry(uuid)',                       -- 016
    'public.sealed_entry_allowed()',                      -- 094
    'public.matter_entry(uuid)',                          -- 094
    'stepup_internal.has_verified_factor(uuid)',          -- 094
    'public.account_sessions(uuid)',                      -- 094
    'conversations_internal.user_matter_role(uuid,uuid)'  -- 091
  ] loop
    if to_regprocedure(v_fn) is null then v_missing := v_missing || v_fn; end if;
  end loop;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'matterspaces' and column_name = 'ai_tier') then
    v_missing := v_missing || 'matterspaces.ai_tier (051)'::text;
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'connector_tokens' and column_name = 'scope_all') then
    v_missing := v_missing || 'connector_tokens.kind/matter_scope/scope_all (085, 088)'::text;
  end if;
  if cardinality(v_missing) > 0 then
    raise exception '098 needs: %. Paste those migrations first; nothing was changed.',
      array_to_string(v_missing, ', ');
  end if;
end $migration$;


-- ============================================================================
-- 1. matterspaces.sealed_effective, and the two triggers that keep it true
-- ============================================================================
alter table public.matterspaces
  add column if not exists sealed_effective boolean not null default false;

comment on column public.matterspaces.sealed_effective is
  'True when this matter or any ancestor is Tier B or C (the seal is inherited). '
  'Maintained by triggers (migration 098); a direct write is overwritten. Read by '
  'every access helper, so the seal is one column test per row.';

-- The walk, kept: 094's definition, for the backfill and for the harness's
-- "the column equals the walk" check. Never called from a policy.
create or replace function stepup_internal.effective_tier_walk(p_matter uuid)
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
revoke all on function stepup_internal.effective_tier_walk(uuid) from public;
grant execute on function stepup_internal.effective_tier_walk(uuid) to service_role;

-- BEFORE INSERT OR UPDATE, on EVERY update: the value is always recomputed
-- from the row's own tier and its parent's stored value, so a matter admin
-- who writes `sealed_effective = false` (023's UPDATE policy has no column
-- list) gets the true value back. DEFINER because a sub-matter's parent can be
-- invisible to the person creating the sub-matter (a matter-level admin under
-- a sealed root).
--
-- The parent row is locked FOR SHARE only when this row is being ATTACHED to
-- it — an insert, or a change of parent. Those are the two cases a concurrent
-- change of the parent's tier could otherwise miss (its cascade would not yet
-- see the new child): with the lock, one waits for the other and reads its
-- result. An ordinary update of a child (a rename, a pause, its own tier) does
-- not lock the parent: taking it there would deadlock against the parent's
-- cascade, which holds the parent and waits for the child. Without the lock
-- that case still converges — the cascade's UPDATE re-reads the child after
-- the child's transaction commits and re-applies the parent's value. What
-- remains is a rare deadlock between an attach and a re-tier of the same
-- parent: loud and retryable (40P01), never a silent wrong value.
create or replace function stepup_internal.sealed_effective_compute()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent boolean := false;
begin
  if new.parent_matterspace_id is not null then
    if tg_op = 'INSERT' or new.parent_matterspace_id is distinct from old.parent_matterspace_id then
      select m.sealed_effective
        into v_parent
        from public.matterspaces m
       where m.id = new.parent_matterspace_id
         for share;
    else
      select m.sealed_effective
        into v_parent
        from public.matterspaces m
       where m.id = new.parent_matterspace_id;
    end if;
  end if;
  new.sealed_effective := coalesce(new.ai_tier in ('B', 'C'), false) or coalesce(v_parent, false);
  return new;
end $$;

-- AFTER UPDATE, only when the value changed: hand the new value to the
-- children whose own value would change. Each child's update fires this
-- trigger again, so the change walks down the tree one level per call, and a
-- level where nothing changes stops it. Children whose value is unchanged are
-- not touched (their updated_at stays theirs). DEFINER: the caller may not see
-- — and 023 may not let them update — the sub-matters an inherited seal
-- reaches.
create or replace function stepup_internal.sealed_effective_cascade()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_eff boolean;
begin
  -- The row's value NOW, not NEW's: when one statement changes a parent and
  -- its descendant, the descendant's queued event may run after the parent's
  -- cascade has already corrected it, and must not hand down a stale value.
  select m.sealed_effective into v_eff from public.matterspaces m where m.id = new.id;
  if v_eff is null then return null; end if;
  update public.matterspaces c
     set sealed_effective = (coalesce(c.ai_tier in ('B', 'C'), false) or v_eff)
   where c.parent_matterspace_id = new.id
     and c.sealed_effective is distinct from
         (coalesce(c.ai_tier in ('B', 'C'), false) or v_eff);
  return null;
end $$;

revoke all on function stepup_internal.sealed_effective_compute() from public, anon, authenticated;
revoke all on function stepup_internal.sealed_effective_cascade() from public, anon, authenticated;

-- Backfill with the triggers out of the way, top-down in one statement, so a
-- deep tree cannot be computed from a parent's not-yet-updated value. Only
-- rows whose value changes are written — on the first paste, every sealed
-- matter and everything under one — and 001's updated_at trigger stamps them
-- now(), so those matters sort as "recently updated" once.
drop trigger if exists matterspaces_sealed_effective on public.matterspaces;
drop trigger if exists matterspaces_sealed_effective_cascade on public.matterspaces;

with recursive tree(id, eff, depth) as (
  select m.id, coalesce(m.ai_tier in ('B', 'C'), false), 0
    from public.matterspaces m
   where m.parent_matterspace_id is null
  union all
  select c.id, coalesce(c.ai_tier in ('B', 'C'), false) or t.eff, t.depth + 1
    from public.matterspaces c
    join tree t on c.parent_matterspace_id = t.id
   where t.depth < 64
)
update public.matterspaces m
   set sealed_effective = t.eff
  from tree t
 where m.id = t.id
   and m.sealed_effective is distinct from t.eff;

create trigger matterspaces_sealed_effective
  before insert or update on public.matterspaces
  for each row execute function stepup_internal.sealed_effective_compute();

create trigger matterspaces_sealed_effective_cascade
  after update on public.matterspaces
  for each row when (old.sealed_effective is distinct from new.sealed_effective)
  execute function stepup_internal.sealed_effective_cascade();

do $migration$
declare
  v_drift int;
begin
  select count(*) into v_drift
    from public.matterspaces m
   where m.sealed_effective is distinct from stepup_internal.effective_tier_walk(m.id);
  if v_drift > 0 then
    raise exception '098: sealed_effective disagrees with the ancestry walk on % matter(s); nothing was changed.', v_drift;
  end if;
  raise notice '098: sealed_effective backfilled and equal to the walk on every matter.';
end $migration$;


-- ============================================================================
-- 2. effective_tier_is_sealed() — one column read
-- ============================================================================
-- Same names, same grants as 094; public.effective_tier_is_sealed (INVOKER)
-- still calls this one, so S4a's storage clause and 094's search wrappers get
-- the column without an edit. A matter that does not exist is not sealed.
create or replace function stepup_internal.effective_tier_is_sealed(p_matter uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select m.sealed_effective from public.matterspaces m where m.id = p_matter), false)
$$;


-- ============================================================================
-- 3. The grace: a hard end, and the latest sign-in
-- ============================================================================
-- 094 compared the EARLIEST amr timestamp with the date and never looked at
-- the clock. A refresh keeps amr, so a session signed in before the date was
-- ungated for as long as it kept refreshing — and min() kept the oldest entry
-- even after the person signed in again. Now: the latest entry decides
-- (a fresh sign-in after the date ends the grace for that session), and the
-- grace ends for everybody seven days after the date whatever the token says
-- — E3's timebox made the same promise, but the gate should not depend on a
-- dashboard setting being flipped.
create or replace function public.sealed_entry_allowed()
returns boolean
language plpgsql
stable
security invoker
as $$
declare
  v_uid       uuid  := auth.uid();
  v_claims    jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_from      timestamptz := public.second_factor_required_from();
  v_signed_in timestamptz;
begin
  if v_uid is null then return false; end if;

  -- A session that has confirmed its second factor.
  if coalesce(v_claims ->> 'aal', '') = 'aal2' then return true; end if;

  -- A token our own server minted for a connector: the seal governs it (094).
  if coalesce(v_claims ->> 'cs_via', '') = 'connector' then return true; end if;

  -- Someone with a factor steps up. Always.
  if stepup_internal.has_verified_factor(v_uid) then return false; end if;

  -- Someone without one: the grace, which has a hard end …
  if now() >= v_from + interval '7 days' then return false; end if;

  -- … and before that, covers sessions whose LATEST sign-in predates the
  -- date. A token without amr is treated as signed in now (fails closed).
  if jsonb_typeof(v_claims -> 'amr') = 'array' then
    select to_timestamp(max((a ->> 'timestamp')::double precision))
      into v_signed_in
      from jsonb_array_elements(v_claims -> 'amr') a
     where jsonb_typeof(a -> 'timestamp') = 'number';
  end if;
  return coalesce(v_signed_in, now()) < v_from;
end $$;


-- ============================================================================
-- 4. The helpers: membership, then the seal
-- ============================================================================
-- ONE definer core, so a policy pays one definer call per row (016 paid one;
-- a three-call version of this measured about twice the per-row cost in the
-- harness). It answers 016's rule word for word — the best role across
-- direct, ancestor and serverspace membership — and then, when p_apply_seal
-- is true, asks the seal: the column of the matterspaces row it has already
-- read, and the session question only when that column is true.
-- matter_entry / document_entry call it with p_apply_seal = false: they must
-- know "a member" even when the seal says no.
create or replace function stepup_internal.matter_role_core(p_matter_id uuid, p_apply_seal boolean)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid      uuid := auth.uid();
  v_ss     uuid;
  v_sealed boolean;
  best     text;
begin
  if uid is null or p_matter_id is null then return null; end if;

  select m.serverspace_id, m.sealed_effective
    into v_ss, v_sealed
    from public.matterspaces m
   where m.id = p_matter_id;
  if not found then return null; end if;

  select role into best
  from (
    select mm.role
      from public.matterspace_members mm
      where mm.user_id = uid
        and mm.matterspace_id in (select id from public.matter_ancestry(p_matter_id))
    union all
    select sm.role
      from public.serverspace_members sm
      where sm.serverspace_id = v_ss and sm.user_id = uid
  ) r
  order by case role
    when 'owner'  then 4
    when 'admin'  then 3
    when 'member' then 2
    when 'viewer' then 1
    else 0
  end desc
  limit 1;

  if best is null then return null; end if;
  if p_apply_seal and coalesce(v_sealed, false) and not public.sealed_entry_allowed() then
    return null;
  end if;
  return best;
end $$;

-- May THIS session be in THIS matter as far as the seal is concerned?
-- (091's conversation helpers ask this for the session's own user.)
create or replace function stepup_internal.seal_allows(p_matter_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sealed boolean;
begin
  select m.sealed_effective into v_sealed from public.matterspaces m where m.id = p_matter_id;
  if not coalesce(v_sealed, false) then return true; end if;
  return public.sealed_entry_allowed();
end $$;

revoke all on function stepup_internal.matter_role_core(uuid, boolean) from public;
revoke all on function stepup_internal.seal_allows(uuid) from public;
grant execute on function stepup_internal.matter_role_core(uuid, boolean) to authenticated, service_role;
grant execute on function stepup_internal.seal_allows(uuid) to authenticated, service_role;

-- The four public names every policy already calls, now INVOKER wrappers
-- (they were 016's SECURITY DEFINER sql). Same names, same arguments, same
-- answers for an open matter; for a sealed one, the answer a session that may
-- not enter gets is "no role". The anonymous answer comes first: anon has no
-- USAGE on stepup_internal.
create or replace function public.matter_role(p_matter_id uuid)
returns text
language plpgsql
stable
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_matter_id is null then return null; end if;
  return stepup_internal.matter_role_core(p_matter_id, true);
end $$;

create or replace function public.can_access_matter(p_matter_id uuid)
returns boolean
language plpgsql
stable
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_matter_id is null then return false; end if;
  return stepup_internal.matter_role_core(p_matter_id, true) is not null;
end $$;

create or replace function public.can_write_matter(p_matter_id uuid)
returns boolean
language plpgsql
stable
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_matter_id is null then return false; end if;
  return coalesce(stepup_internal.matter_role_core(p_matter_id, true) in ('owner', 'admin', 'member'), false);
end $$;

create or replace function public.can_manage_matter(p_matter_id uuid)
returns boolean
language plpgsql
stable
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_matter_id is null then return false; end if;
  return coalesce(stepup_internal.matter_role_core(p_matter_id, true) in ('owner', 'admin'), false);
end $$;

grant execute on function public.matter_role(uuid) to authenticated, service_role;
grant execute on function public.can_access_matter(uuid) to authenticated, service_role;
grant execute on function public.can_write_matter(uuid) to authenticated, service_role;
grant execute on function public.can_manage_matter(uuid) to authenticated, service_role;


-- ============================================================================
-- 5. The app's probes: matter_entry on membership, and document_entry
-- ============================================================================
-- 094's matter_entry asked can_access_matter first. That now says no to a
-- member of a sealed matter at aal1, which would turn 'stepup' into 'none'
-- and the factor prompt into "not found". It asks membership instead; the
-- answer to a non-member is still 'none' for every matter, so it is still not
-- an oracle for which matters are sealed.
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
  if stepup_internal.matter_role_core(p_matter, false) is null then return 'none'; end if;
  if not stepup_internal.effective_tier_is_sealed(p_matter) then return 'open'; end if;
  if public.sealed_entry_allowed() then return 'open'; end if;
  if stepup_internal.has_verified_factor(v_uid) then return 'stepup'; end if;
  return 'enrol';
end $$;

-- The Reader opens a document by id (history, bookmarks, canvas cards, thread
-- links) without entering its matter. With the helpers above, a sealed
-- document at aal1 reads as nothing; this says whether that nothing is
-- "confirm it's you". The document's matter is looked up as the owner and
-- never returned; to a non-member the answer is 'none', as for a missing id.
create or replace function stepup_internal.document_matter(p_document uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$ select d.matterspace_id from public.documents d where d.id = p_document $$;
revoke all on function stepup_internal.document_matter(uuid) from public;
grant execute on function stepup_internal.document_matter(uuid) to authenticated, service_role;

create or replace function public.document_entry(p_document uuid)
returns text
language plpgsql
stable
security invoker
as $$
declare
  v_uid    uuid := auth.uid();
  v_matter uuid;
begin
  if v_uid is null or p_document is null then return 'none'; end if;
  v_matter := stepup_internal.document_matter(p_document);
  if v_matter is null then return 'none'; end if;
  return public.matter_entry(v_matter);
end $$;

revoke all on function public.document_entry(uuid) from public, anon;
grant execute on function public.document_entry(uuid) to authenticated, service_role;


-- ============================================================================
-- 6. The matterspaces SELECT policy reads the column
-- ============================================================================
-- 094's policy, with the walk replaced by the column. The initplan
-- `(select sealed_entry_allowed())` is still asked once per statement.
drop policy if exists "Members can view matterspaces" on public.matterspaces;
create policy "Members can view matterspaces"
  on public.matterspaces for select
  using (
    public._mtspc_select_check(id, serverspace_id, parent_matterspace_id)
    and (not sealed_effective or (select public.sealed_entry_allowed()))
  );


-- ============================================================================
-- 7. Conversations: 091's copy of the role rule obeys the seal for the session
-- ============================================================================
-- user_matter_role(p_uid, p_matter) is asked about the session's own user
-- (every policy wrapper passes auth.uid(); list_matter_conversations /
-- list_matter_messages do the same) AND about other people (who else is in
-- this conversation's audience). The seal is a fact about THIS session, so it
-- applies only when p_uid is the session's user; the audience of a sealed
-- conversation, read at aal2, still lists its people. The service role has no
-- auth.uid() and is never gated here, as everywhere else.
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
     and (p_uid is distinct from auth.uid() or stepup_internal.seal_allows(p_matter))
   order by case r.role
     when 'owner'  then 4
     when 'admin'  then 3
     when 'member' then 2
     when 'viewer' then 1
     else 0 end desc
   limit 1
$$;


-- ============================================================================
-- 8. documents and passages: both rows checked, and no quiet exit from a seal
-- ============================================================================
-- The UPDATE policies had no WITH CHECK, so Postgres used USING for the new
-- row too. With the helpers above that already refuses the reviewer's move at
-- aal1 (the OLD sealed row fails USING, so no row is updated). The WITH CHECK
-- is written out so the rule reads where it applies: the old matter and the
-- new matter must both pass the same helper.
drop policy if exists "Members can insert documents in their matterspaces" on public.documents;
create policy "Members can insert documents in their matterspaces"
  on public.documents for insert
  with check (created_by = auth.uid() and public.can_write_matter(matterspace_id));

drop policy if exists "Members can update documents in their matterspaces" on public.documents;
create policy "Members can update documents in their matterspaces"
  on public.documents for update
  using (public.can_write_matter(matterspace_id))
  with check (public.can_write_matter(matterspace_id));

drop policy if exists "Members can insert passages in their matterspaces" on public.passages;
create policy "Members can insert passages in their matterspaces"
  on public.passages for insert
  with check (public.can_write_matter(matterspace_id));

drop policy if exists "Members can update passages in their matterspaces" on public.passages;
create policy "Members can update passages in their matterspaces"
  on public.passages for update
  using (public.can_write_matter(matterspace_id))
  with check (public.can_write_matter(matterspace_id));

-- Moving a row OUT of a sealed matter (into one that is not sealed) takes the
-- seal off it for everyone who can see the destination. That is refused
-- unless the session has confirmed a second factor — stricter than the
-- helpers, which also let a grace session in. Between two sealed matters the
-- row stays sealed and the helpers decide. The worker and the server (no
-- auth.uid()) are not browser sessions and are not asked.
-- S7 may refuse leaving a sealed container outright, or ask for a named
-- confirmation recorded as file.gate; this is the floor it would build on.
create or replace function stepup_internal.leave_allowed(p_from uuid, p_to uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return true; end if;
  if p_from is not distinct from p_to then return true; end if;
  if not stepup_internal.effective_tier_is_sealed(p_from) then return true; end if;
  if stepup_internal.effective_tier_is_sealed(p_to) then return true; end if;
  return public.auth_is_aal2();
end $$;
revoke all on function stepup_internal.leave_allowed(uuid, uuid) from public;
grant execute on function stepup_internal.leave_allowed(uuid, uuid) to authenticated, service_role;

-- The question api/move-document.mjs asks before it renames the stored file,
-- so a refusal comes before any step rather than halfway through.
create or replace function public.seal_leave_allowed(p_from uuid, p_to uuid)
returns boolean
language plpgsql
stable
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return false; end if;
  return stepup_internal.leave_allowed(p_from, p_to);
end $$;
revoke all on function public.seal_leave_allowed(uuid, uuid) from public, anon;
grant execute on function public.seal_leave_allowed(uuid, uuid) to authenticated, service_role;

create or replace function stepup_internal.refuse_leaving_seal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not stepup_internal.leave_allowed(old.matterspace_id, new.matterspace_id) then
    raise exception 'step_up_required'
      using errcode = '42501',
            detail = 'Moving this out of a sealed matter takes it out of the seal.',
            hint = 'Confirm your second factor, then move it again.';
  end if;
  return new;
end $$;
revoke all on function stepup_internal.refuse_leaving_seal() from public, anon, authenticated;

drop trigger if exists documents_refuse_leaving_seal on public.documents;
create trigger documents_refuse_leaving_seal
  before update of matterspace_id on public.documents
  for each row when (old.matterspace_id is distinct from new.matterspace_id)
  execute function stepup_internal.refuse_leaving_seal();

drop trigger if exists passages_refuse_leaving_seal on public.passages;
create trigger passages_refuse_leaving_seal
  before update of matterspace_id on public.passages
  for each row when (old.matterspace_id is distinct from new.matterspace_id)
  execute function stepup_internal.refuse_leaving_seal();


-- ============================================================================
-- 9. connector_tokens: minted through one door, which asks for the factor
-- ============================================================================
-- A csp_ token is a password that never expires and that the seal's
-- step-up does not see (its JWT carries cs_via:'connector'). Until now any
-- browser session could write one (003's INSERT policy), or turn an old row
-- into one by overwriting token_hash (003's UPDATE policy has no column
-- list). Both doors close; the one that replaces them asks the same question
-- the seal asks: a person who has a second factor confirms it first.
-- A person without one is not asked (they have nothing to confirm with, and
-- E2 does not require one of everybody); after the grace they cannot enter a
-- sealed matter, and /api/ext and MCP refuse sealed matters to any token.
--
-- 099 adds a BEFORE UPDATE trigger on this table; nothing here adds a
-- trigger, so the two do not meet. 095's AFTER INSERT trigger
-- (account.unlocked) fires on the insert below exactly as on the old one.
drop policy if exists "Users can insert their own connector tokens" on public.connector_tokens;
revoke insert on table public.connector_tokens from anon, authenticated;

-- UPDATE: exactly the columns the app writes (revoke, rename, an agent's
-- matters and "all my matters").
revoke update on table public.connector_tokens from anon, authenticated;
do $migration$
declare
  v_col text;
begin
  foreach v_col in array array['name', 'revoked_at', 'matter_scope', 'scope_all', 'agent_provider'] loop
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'connector_tokens' and column_name = v_col) then
      execute format('grant update (%I) on table public.connector_tokens to authenticated', v_col);
    end if;
  end loop;
end $migration$;

create or replace function stepup_internal.connector_token_create(
  p_token_hash text,
  p_token_prefix text,
  p_name text,
  p_kind text,
  p_agent_provider text,
  p_matter_scope uuid[],
  p_scope_all boolean
) returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid    uuid  := auth.uid();
  v_claims jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_kind   text  := coalesce(nullif(p_kind, ''), 'user');
  v_id     uuid;
begin
  if v_uid is null then
    raise exception 'connector_token_create requires a signed-in person' using errcode = '42501';
  end if;
  -- A connection does not make connections.
  if coalesce(v_claims ->> 'cs_via', '') = 'connector' then
    raise exception 'a connector token cannot create another' using errcode = '42501';
  end if;
  if coalesce(v_claims ->> 'aal', '') <> 'aal2' and stepup_internal.has_verified_factor(v_uid) then
    raise exception 'step_up_required'
      using errcode = '42501',
            hint = 'Confirm your second factor, then create the connection again.';
  end if;

  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'connector_token_create: token hash must be 64 hex characters' using errcode = '22023';
  end if;
  if coalesce(p_token_prefix, '') !~ '^csp_[A-Za-z0-9_-]{1,28}$' then
    raise exception 'connector_token_create: malformed token prefix' using errcode = '22023';
  end if;
  if v_kind not in ('user', 'agent') then
    raise exception 'connector_token_create: kind must be user or agent' using errcode = '22023';
  end if;

  insert into public.connector_tokens
    (user_id, token_hash, token_prefix, name, kind, agent_provider, matter_scope, scope_all)
  values (
    v_uid,
    p_token_hash,
    p_token_prefix,
    left(nullif(btrim(coalesce(p_name, '')), ''), 120),
    v_kind,
    case when v_kind = 'agent' then p_agent_provider end,
    case when v_kind = 'agent'
         then coalesce((select array_agg(distinct s) from unnest(p_matter_scope) s where s is not null), '{}'::uuid[])
         else '{}'::uuid[] end,
    v_kind = 'agent' and coalesce(p_scope_all, false)
  )
  returning id into v_id;
  return v_id;
end $$;

revoke all on function stepup_internal.connector_token_create(text, text, text, text, text, uuid[], boolean) from public;
grant execute on function stepup_internal.connector_token_create(text, text, text, text, text, uuid[], boolean)
  to authenticated;

create or replace function public.connector_token_create(
  p_token_hash text,
  p_token_prefix text,
  p_name text default null,
  p_kind text default 'user',
  p_agent_provider text default null,
  p_matter_scope uuid[] default null,
  p_scope_all boolean default false
) returns uuid
language plpgsql
volatile
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'connector_token_create requires a signed-in person' using errcode = '42501';
  end if;
  return stepup_internal.connector_token_create(
    p_token_hash, p_token_prefix, p_name, p_kind, p_agent_provider, p_matter_scope, p_scope_all);
end $$;

revoke all on function public.connector_token_create(text, text, text, text, text, uuid[], boolean) from public, anon;
grant execute on function public.connector_token_create(text, text, text, text, text, uuid[], boolean)
  to authenticated;


-- ============================================================================
-- 10. Signing out a device asks for the factor
-- ============================================================================
-- 094's function, with the caller's aal passed in by api/account-sessions.mjs
-- (read from the bearer Supabase Auth has just verified). A person with a
-- verified factor who has not confirmed it in THIS session cannot sign other
-- devices out: otherwise a stolen password signs the owner out of every
-- device they would use to notice. The 2-argument form is dropped so
-- PostgREST has one function to call; a missing p_aal counts as not confirmed.
drop function if exists public.account_session_revoke(uuid, uuid);
create or replace function public.account_session_revoke(p_user uuid, p_session uuid, p_aal text default null)
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
  if coalesce(p_aal, '') <> 'aal2' and stepup_internal.has_verified_factor(p_user) then
    raise exception 'step_up_required'
      using errcode = '42501',
            hint = 'Confirm your second factor, then sign the device out again.';
  end if;
  delete from auth.sessions s where s.id = p_session and s.user_id = p_user;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;

revoke all on function public.account_session_revoke(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.account_session_revoke(uuid, uuid, text) to service_role;


notify pgrst, 'reload schema';
