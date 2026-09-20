-- 072_account_chain_and_session_immutability.sql
--
-- Two holes that migration 064 declared in its own PR, closed.
--
--   1. A CROSS-MATTER TOOL CALL RECORDED NOTHING. 064 keeps one hash chain
--      per matter, so a connected assistant calling `search` with `matter`
--      omitted — the broadest read a connector can make, and the one the
--      MCP docs advertise ("search works matter-scoped or, with matter
--      omitted, across every matter at once") — left no trace anywhere.
--      Neither did `list_matters`. "Every AI action is recorded" was
--      therefore not true.
--
--      This file gives every ACCOUNT its own chain in the same table, and
--      the application (lib/ledger.mjs) writes two things for one
--      cross-matter call: one row on the account chain carrying COUNTS
--      only, and one row in EACH matter the call actually read from,
--      carrying that matter's own count and nothing about any other
--      matter. A reader of one matter's Record learns that a connected
--      assistant read from it. They learn nothing about the existence of
--      any other matter. That is the whole design constraint.
--
--   2. ai_sessions COULD STILL BE EDITED BY ITS OWNER. 064 closed DELETE
--      and the cascades but left 051's "Owners update their sessions"
--      policy alone, so the durable AI record's tier, matter, owner and
--      snapshots were all rewritable by the person the record is about.
--      Closed here: the session row is immutable except for `updated_at`
--      and `title`, which move only through a SECURITY DEFINER function;
--      ai_messages become wholly immutable after insert.
--
-- Apply order: AFTER 064. If 064 has not been applied, this file does
-- NOTHING and says so — see the guard at the top of §0. It is re-runnable:
-- every object is create-or-replace or drop-then-create, and the file has
-- been executed TWICE end-to-end in PGlite by
-- scripts/_verify-ledger-account.mjs.
--
-- ⚠ After pasting this file, run:  notify pgrst, 'reload schema';
--   (it is the last statement here, but a paste that stops early will not
--   have run it, and ledger_append_account stays invisible to PostgREST
--   until it does. lib/ledger.mjs treats that as NOT-DEPLOYED: the fan-out
--   rows into each matter are ordinary 064 rows and keep being written, so
--   every matter's own Record stays true; only the account-level roll-up
--   is missing until the paste. Merging the code before pasting is safe.)
--
-- ⚠ Do NOT re-paste 064 after this file. 064 §9 contains a plain UPDATE on
--   public.ai_sessions (the snapshot backfill), which §3 below refuses for
--   everybody including a superuser. In practice that UPDATE touches zero
--   rows on a second run — but a zero-row UPDATE still fires no trigger and
--   succeeds, while a non-zero one would now fail loudly. If 064 ever has
--   to be re-pasted, paste 072 again straight afterwards: 064 replaces
--   _ledger_write with its own inline body, which is still correct for
--   matter rows, and the account lane keeps working because it calls
--   _ledger_write_scoped directly.

-- ============================================================================
-- 0. The guard — one outer block, so "064 is absent" is a clean no-op
-- ============================================================================
-- Everything in this file lives inside this DO block and runs through
-- EXECUTE. A `return` in a plpgsql block exits only that block, so a guard
-- at the top of a file whose statements are top-level would stop nothing:
-- the `alter table public.events`, the `create trigger ... on public.events`
-- and the `drop policy ... on public.ai_sessions` below would all still run,
-- and all three would fail hard against a database that has never seen 064.
-- One block is the only construction in which "no-op" is true.
--
-- Dollar-quote tags in here are nested three deep and every level has its
-- own tag: $migration$ (this block) › $sql$ (a statement being executed) ›
-- $fn$ (a function body inside that statement).

do $migration$
begin

if to_regclass('public.events') is null
   or to_regprocedure('public.ledger_append(text,uuid,uuid,uuid,text,text,text,jsonb)') is null
then
  raise notice '072: public.events / ledger_append is absent — migration 064 has not been applied.';
  raise notice '072: nothing was changed. Paste 064_events_ledger.sql first, then paste this file again.';
  return;
end if;

raise notice '072: 064 is present — applying the account chain and the ai_sessions repair.';


-- ==========================================================================
-- 1. The vocabulary gains connector.connected
-- ==========================================================================
-- 064 already has connector.registered / connector.revoked. W2 (PR #166)
-- owns the OAuth grant lane and will want to say "this assistant was
-- connected", which is not the same act as "this client registered": a
-- registration happens once per client, a connection happens once per
-- grant. Defined here so #166 need not reopen a migration; NOT wired here.
execute $sql$
  alter table public.events drop constraint if exists events_kind_check
$sql$;
execute $sql$
  alter table public.events add constraint events_kind_check check (kind in (
    'tool.invoked',
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
    'run.aborted'
  ))
$sql$;


-- ==========================================================================
-- 2. The account chain
-- ==========================================================================
-- Same table, not a sibling. The decision turns on two lines of 064 that
-- already exist:
--
--   * RLS. 064's _ledger_visible(matter, serverspace, actor_user) answers
--     TRUE on its very first rule when actor_user = auth.uid(), and when
--     BOTH matterspace_id and serverspace_id are null there is no second or
--     third rule to reach. So a row with (matter null, serverspace null,
--     actor_user = me) is readable by me and by nobody else — including a
--     colleague in my own serverspace — with no policy change whatsoever.
--     A sibling table would need its own policy set, its own grants and its
--     own proof.
--
--   * verify_chain. It is SECURITY INVOKER and keyed on chain_key alone. A
--     chain whose every row is visible to exactly one person verifies
--     whole for that person and reports checked = 0 for everyone else —
--     which is precisely the account-chain contract. A sibling table would
--     need a second verifier, and two verifiers drift.
--
-- The chain key of an account chain is the account's own user id. It comes
-- from auth.uid() inside a DEFINER function, never from a parameter, so it
-- cannot be aimed at somebody else's chain.

-- 2a. account_chain_key() — so the app and the Record tab never hard-code
--     the derivation. If the chain key ever has to become a derived uuid,
--     this is the one place it changes.
execute $sql$
  create or replace function public.account_chain_key() returns uuid
  language sql
  security invoker
  stable
  as $fn$ select auth.uid() $fn$
$sql$;
execute $sql$ revoke all on function public.account_chain_key() from public $sql$;
execute $sql$ revoke all on function public.account_chain_key() from anon $sql$;
execute $sql$
  grant execute on function public.account_chain_key() to authenticated, service_role
$sql$;

-- 2b. _ledger_write_scoped — 064's writer body, with the chain key made
--     explicit instead of derived from the matter alone.
--
--     Why a NEW name rather than a tenth parameter on _ledger_write:
--     `create or replace function` with a different argument list makes an
--     OVERLOAD, not a replacement, and 064's own trigger functions call
--     _ledger_write with nine positional arguments. Two candidates, one of
--     them with a default, is an ambiguous call — and an ambiguous call
--     inside the acl.changed trigger would block every membership change in
--     the product. A new name has no such failure mode, and it also means a
--     later re-paste of 064 cannot break the account lane: 064 replaces
--     _ledger_write and never mentions _ledger_write_scoped.
execute $sql$
  create or replace function public._ledger_write_scoped(
    p_kind text,
    p_matter uuid,
    p_serverspace uuid,
    p_session uuid,
    p_actor_kind text,
    p_actor_ref text,
    p_actor_label text,
    p_payload jsonb,
    p_actor_user uuid,
    p_chain uuid default null
  ) returns jsonb
  language plpgsql
  security definer
  set search_path = public
  as $fn$
  declare
    v_nil     constant uuid := '00000000-0000-0000-0000-000000000000';
    v_chain   uuid;
    v_ts      timestamptz := clock_timestamp();
    v_seq     bigint;
    v_prev    text;
    v_name    text;
    v_ss      uuid := p_serverspace;
    v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
    v_kind    text := coalesce(p_kind, '');
    v_akind   text := coalesce(nullif(p_actor_kind, ''), 'user');
    v_aref    text := coalesce(nullif(p_actor_ref, ''), coalesce(p_actor_user::text, 'unknown'));
    v_hash    text;
    v_id      uuid;
  begin
    -- An explicit chain key may only ever be the matter's own key, or the
    -- WRITER'S OWN ACCOUNT. Nothing may aim a row at a third chain: that is
    -- what would let one account write into another's record, or a row be
    -- hidden in a chain nobody reads. The same invariant is re-asserted by
    -- a BEFORE INSERT trigger below, because a trigger is what a future
    -- writer cannot route around.
    if p_chain is not null
       and p_chain is distinct from p_matter
       and not (p_matter is null and p_serverspace is null and p_chain = p_actor_user)
    then
      raise exception 'ledger: a chain key may only be the matter, or the writer''s own account'
        using errcode = '42501';
    end if;

    v_chain := coalesce(p_chain, p_matter, v_nil);

    perform pg_advisory_xact_lock(hashtext(v_chain::text));

    if p_matter is not null then
      select m.name, m.serverspace_id into v_name, v_ss
        from public.matterspaces m where m.id = p_matter;
      if v_ss is null then v_ss := p_serverspace; end if;
    end if;

    if octet_length(v_payload::text) > 8192 then
      v_payload := jsonb_build_object(
        'truncated', true,
        'original_bytes', octet_length(v_payload::text),
        'keys', case when jsonb_typeof(v_payload) = 'object'
                     then (select coalesce(jsonb_agg(k order by k), '[]'::jsonb)
                             from jsonb_object_keys(v_payload) k)
                     else '[]'::jsonb end
      );
    end if;

    select e.seq, e.hash into v_seq, v_prev
      from public.events e
     where e.chain_key = v_chain
     order by e.seq desc
     limit 1;
    v_seq  := coalesce(v_seq, 0) + 1;
    v_prev := coalesce(v_prev, '');

    v_hash := public._ledger_hash(v_prev, v_seq, v_ts, v_kind, p_matter, v_name,
                                  v_akind, v_aref, p_actor_user, p_session, v_payload);

    perform set_config('contextspaces.ledger_writing', 'on', true);
    insert into public.events (
      ts, chain_key, seq, kind, matterspace_id, matter_name, serverspace_id,
      session_id, actor_kind, actor_ref, actor_user_id, actor_label,
      payload, prev_hash, hash
    ) values (
      v_ts, v_chain, v_seq, v_kind, p_matter, v_name, v_ss,
      p_session, v_akind, v_aref, p_actor_user, p_actor_label,
      v_payload, v_prev, v_hash
    ) returning id into v_id;
    perform set_config('contextspaces.ledger_writing', '', true);

    return jsonb_build_object(
      'id', v_id, 'seq', v_seq, 'hash', v_hash, 'ts', v_ts, 'chain_key', v_chain);
  end $fn$
$sql$;

execute $sql$ revoke all on function public._ledger_write_scoped(text, uuid, uuid, uuid, text, text, text, jsonb, uuid, uuid) from public $sql$;
execute $sql$ revoke all on function public._ledger_write_scoped(text, uuid, uuid, uuid, text, text, text, jsonb, uuid, uuid) from anon $sql$;
execute $sql$ revoke all on function public._ledger_write_scoped(text, uuid, uuid, uuid, text, text, text, jsonb, uuid, uuid) from authenticated $sql$;
execute $sql$ revoke all on function public._ledger_write_scoped(text, uuid, uuid, uuid, text, text, text, jsonb, uuid, uuid) from service_role $sql$;

-- 2c. _ledger_write keeps its exact 064 signature and becomes a delegate,
--     so there is ONE implementation of the lock / seq / prev_hash / hash /
--     insert sequence and the two chains can never drift apart.
execute $sql$
  create or replace function public._ledger_write(
    p_kind text,
    p_matter uuid,
    p_serverspace uuid,
    p_session uuid,
    p_actor_kind text,
    p_actor_ref text,
    p_actor_label text,
    p_payload jsonb,
    p_actor_user uuid
  ) returns jsonb
  language plpgsql
  security definer
  set search_path = public
  as $fn$
  begin
    -- 072: the body moved verbatim into _ledger_write_scoped, which takes
    -- the chain key as an argument. Passing null keeps 064's rule exactly:
    -- the chain is the matter, or the nil chain when there is no matter.
    return public._ledger_write_scoped(
      p_kind, p_matter, p_serverspace, p_session,
      p_actor_kind, p_actor_ref, p_actor_label, p_payload, p_actor_user, null);
  end $fn$
$sql$;

execute $sql$ revoke all on function public._ledger_write(text, uuid, uuid, uuid, text, text, text, jsonb, uuid) from public $sql$;
execute $sql$ revoke all on function public._ledger_write(text, uuid, uuid, uuid, text, text, text, jsonb, uuid) from anon $sql$;
execute $sql$ revoke all on function public._ledger_write(text, uuid, uuid, uuid, text, text, text, jsonb, uuid) from authenticated $sql$;
execute $sql$ revoke all on function public._ledger_write(text, uuid, uuid, uuid, text, text, text, jsonb, uuid) from service_role $sql$;

-- 2d. The chain-key invariant, as a trigger.
--     A second BEFORE INSERT trigger rather than a replacement of 064's
--     _events_insert_guard: both fire (Postgres runs BEFORE triggers in
--     name order), and re-pasting 064 cannot silently remove this one.
--
--     Three shapes are legal and no fourth is:
--       matter row    chain_key = matterspace_id
--       account row   matterspace_id null, serverspace_id null,
--                     chain_key = actor_user_id  (and not the nil uuid)
--       nil-chain row matterspace_id null, chain_key = nil
--                     (064 writes serverspace acl.changed rows there)
execute $sql$
  create or replace function public._events_chain_key_invariant() returns trigger
  language plpgsql
  as $fn$
  declare
    v_nil constant uuid := '00000000-0000-0000-0000-000000000000';
  begin
    if new.matterspace_id is not null then
      if new.chain_key is distinct from new.matterspace_id then
        raise exception 'ledger: a matter row must sit on its own matter''s chain'
          using errcode = '42501';
      end if;
      return new;
    end if;

    if new.chain_key = v_nil then
      return new;                            -- 064's chain for serverspace-wide acts
    end if;

    if new.serverspace_id is null and new.chain_key = new.actor_user_id then
      return new;                            -- an account chain: one person's own
    end if;

    raise exception
      'ledger: chain_key % is neither a matter, the nil chain, nor the writer''s own account',
      new.chain_key using errcode = '42501';
  end $fn$
$sql$;

execute $sql$ drop trigger if exists events_chain_key_invariant on public.events $sql$;
execute $sql$
  create trigger events_chain_key_invariant
    before insert on public.events
    for each row execute function public._events_chain_key_invariant()
$sql$;

-- 2e. The append path: INVOKER wrapper › DEFINER worker › writer.
--     feedback_rls_security_invoker_wrappers, and 064's own three layers.
--     _ledger_append_account_checked reads auth.uid() ITSELF and uses it
--     for both the byline and the chain key: there is no uid parameter to
--     forge and no chain parameter to aim.
--
--     Account-legal kinds are a short list on purpose. completion.received,
--     acl.changed and seal.changed are matter-bound by definition and have
--     no meaning on an account chain; refusing them here stops a future
--     caller quietly moving a matter's provenance somewhere a matter's
--     Record will never look.
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
      'connector.revoked', 'ai.paused', 'ai.resumed'
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

execute $sql$ revoke all on function public._ledger_append_account_checked(text, uuid, text, text, text, jsonb) from public $sql$;
execute $sql$ revoke all on function public._ledger_append_account_checked(text, uuid, text, text, text, jsonb) from anon $sql$;
execute $sql$
  grant execute on function public._ledger_append_account_checked(text, uuid, text, text, text, jsonb)
    to authenticated, service_role
$sql$;

execute $sql$
  create or replace function public.ledger_append_account(
    p_kind text,
    p_session uuid default null,
    p_actor_kind text default 'user',
    p_actor_ref text default null,
    p_actor_label text default null,
    p_payload jsonb default '{}'::jsonb
  ) returns jsonb
  language plpgsql
  security invoker
  as $fn$
  declare
    v_uid uuid := auth.uid();
  begin
    if v_uid is null then
      raise exception 'ledger_append_account requires an authenticated caller'
        using errcode = '42501';
    end if;
    return public._ledger_append_account_checked(
      p_kind, p_session, p_actor_kind, p_actor_ref, p_actor_label, p_payload);
  end $fn$
$sql$;

execute $sql$ revoke all on function public.ledger_append_account(text, uuid, text, text, text, jsonb) from public $sql$;
execute $sql$ revoke all on function public.ledger_append_account(text, uuid, text, text, text, jsonb) from anon $sql$;
execute $sql$
  grant execute on function public.ledger_append_account(text, uuid, text, text, text, jsonb)
    to authenticated, service_role
$sql$;

-- 2f. verify_account_chain() — verify_chain aimed at your own chain, so a
--     caller never has to know that the chain key is their user id.
execute $sql$
  create or replace function public.verify_account_chain()
  returns table (ok boolean, checked bigint, first_bad_seq bigint)
  language plpgsql
  security invoker
  stable
  as $fn$
  declare
    v_uid uuid := auth.uid();
  begin
    if v_uid is null then
      ok := false; checked := 0; first_bad_seq := null; return next; return;
    end if;
    return query select * from public.verify_chain(v_uid);
  end $fn$
$sql$;

execute $sql$ revoke all on function public.verify_account_chain() from public $sql$;
execute $sql$ revoke all on function public.verify_account_chain() from anon $sql$;
execute $sql$
  grant execute on function public.verify_account_chain() to authenticated, service_role
$sql$;

execute $sql$
  create index if not exists events_account_scope_idx
    on public.events (chain_key, ts desc)
    where matterspace_id is null
$sql$;

-- The fan-out rows the Record tab counts: matter rows whose payload says
-- they came from an account-wide call. Partial index so the count is cheap
-- on a matter with a long Record.
execute $sql$
  create index if not exists events_fanout_idx
    on public.events (matterspace_id, ts desc)
    where (payload ->> 'via') = 'account-wide search'
$sql$;


-- ==========================================================================
-- 3. The AI session record becomes uneditable
-- ==========================================================================
-- 051 gave the owner a blanket UPDATE policy on ai_sessions. Everything on
-- that row except its title is provenance: which matter, whose account,
-- which TIER governed the session (stamped at creation precisely so a later
-- re-tiering cannot rewrite history), and 064's matter_name / owner_email /
-- serverspace_id snapshots. A record whose subject can edit it is not a
-- record.
--
-- The narrowest thing the application actually does with these tables was
-- established by reading every write of them in the repo:
--
--   lib/assistant-core.mjs:833   update({updated_at}) on ai_sessions
--   lib/assistant-core.mjs:839   insert into ai_sessions
--   lib/assistant-core.mjs:879   insert into ai_messages
--   src/                          no writes at all (Assistant.tsx only holds the id)
--
-- So: exactly one column is updated by the product, `updated_at`. `title`
-- is allowed alongside it because the insert already sets one and a rename
-- is a label the owner chose, not a record of what an AI did — but it moves
-- through the function like everything else. `status`, `tier`,
-- `matterspace_id`, `owner_id`, `created_at` and the three snapshots are
-- immutable. If the product ever needs to close a session, widen the
-- function by one line; never the policy.
--
-- Two layers, as 062 did for profiles.pricing_tier:
--   * the POLICY and the grants stop a signed-in user;
--   * a BEFORE UPDATE trigger stops everybody else — service_role, which
--     has BYPASSRLS, and a superuser, which a grant cannot stop either.
--     The trigger refuses unless a transaction-local flag is up, and only
--     _ai_session_touch raises that flag, for the length of its own UPDATE.
--     That is 064's own idiom for public.events, applied one table over.

if to_regclass('public.ai_sessions') is not null then

  execute $sql$
    create or replace function public._ai_sessions_immutable() returns trigger
    language plpgsql
    as $fn$
    begin
      if coalesce(current_setting('contextspaces.ai_session_touching', true), '') <> 'on' then
        raise exception
          'public.ai_sessions is the AI record: it is not edited after it is written'
          using errcode = '42501',
                hint = 'ai_session_touch(session_id, title) moves updated_at and title. Nothing moves the rest.';
      end if;
      -- Belt to that brace: even with the flag up, only these two columns
      -- may differ. If the flag ever leaked into another statement, the
      -- provenance would still be safe.
      if new.id             is distinct from old.id
         or new.matterspace_id is distinct from old.matterspace_id
         or new.owner_id      is distinct from old.owner_id
         or new.tier          is distinct from old.tier
         or new.status        is distinct from old.status
         or new.created_at    is distinct from old.created_at
         or new.matter_name   is distinct from old.matter_name
         or new.owner_email   is distinct from old.owner_email
         or new.serverspace_id is distinct from old.serverspace_id
      then
        raise exception
          'public.ai_sessions: only title and updated_at may change after insert'
          using errcode = '42501';
      end if;
      return new;
    end $fn$
  $sql$;

  execute $sql$ drop trigger if exists ai_sessions_immutable on public.ai_sessions $sql$;
  execute $sql$
    create trigger ai_sessions_immutable
      before update on public.ai_sessions
      for each row execute function public._ai_sessions_immutable()
  $sql$;

  -- The one door. DEFINER so it can raise the flag; it re-checks ownership
  -- itself, without RLS, from auth.uid() — never from a parameter.
  execute $sql$
    create or replace function public._ai_session_touch_checked(
      p_session uuid,
      p_title text
    ) returns boolean
    language plpgsql
    security definer
    set search_path = public
    as $fn$
    declare
      v_uid   uuid := auth.uid();
      v_owner uuid;
    begin
      if v_uid is null then
        raise exception 'ai_session_touch requires an authenticated caller'
          using errcode = '42501';
      end if;
      select s.owner_id into v_owner from public.ai_sessions s where s.id = p_session;
      if v_owner is null or v_owner <> v_uid then
        raise exception 'session % is not yours', p_session using errcode = '42501';
      end if;

      perform set_config('contextspaces.ai_session_touching', 'on', true);
      update public.ai_sessions
         set updated_at = now(),
             title = case
                       when p_title is null or btrim(p_title) = '' then title
                       else left(btrim(p_title), 120)
                     end
       where id = p_session;
      perform set_config('contextspaces.ai_session_touching', '', true);
      return true;
    end $fn$
  $sql$;

  execute $sql$ revoke all on function public._ai_session_touch_checked(uuid, text) from public $sql$;
  execute $sql$ revoke all on function public._ai_session_touch_checked(uuid, text) from anon $sql$;
  execute $sql$
    grant execute on function public._ai_session_touch_checked(uuid, text)
      to authenticated, service_role
  $sql$;

  execute $sql$
    create or replace function public.ai_session_touch(
      p_session uuid,
      p_title text default null
    ) returns boolean
    language plpgsql
    security invoker
    as $fn$
    declare
      v_uid uuid := auth.uid();
    begin
      if v_uid is null then
        raise exception 'ai_session_touch requires an authenticated caller'
          using errcode = '42501';
      end if;
      return public._ai_session_touch_checked(p_session, p_title);
    end $fn$
  $sql$;

  execute $sql$ revoke all on function public.ai_session_touch(uuid, text) from public $sql$;
  execute $sql$ revoke all on function public.ai_session_touch(uuid, text) from anon $sql$;
  execute $sql$
    grant execute on function public.ai_session_touch(uuid, text)
      to authenticated, service_role
  $sql$;

  -- The policy and the grants: a signed-in user has no UPDATE path at all.
  execute $sql$ drop policy if exists "Owners update their sessions" on public.ai_sessions $sql$;
  execute $sql$ drop policy if exists "Owners update their session titles" on public.ai_sessions $sql$;
  execute $sql$ revoke update on public.ai_sessions from anon $sql$;
  execute $sql$ revoke update on public.ai_sessions from authenticated $sql$;

end if;

-- ai_messages: the turn itself — role, content, model, provider, tokens,
-- cost, within_policy. 051 gave it no UPDATE policy, which stops a
-- signed-in user and stops neither service_role nor a superuser. Nothing in
-- the product updates a message, so nothing needs a door: the trigger
-- refuses every UPDATE, full stop.
if to_regclass('public.ai_messages') is not null then

  execute $sql$
    create or replace function public._ai_messages_immutable() returns trigger
    language plpgsql
    as $fn$
    begin
      raise exception
        'public.ai_messages is the AI record: a turn is never rewritten (% refused)', tg_op
        using errcode = '42501',
              hint = 'Corrections are appended as new messages, and the act is recorded in public.events.';
      return null;
    end $fn$
  $sql$;

  execute $sql$ drop trigger if exists ai_messages_immutable on public.ai_messages $sql$;
  execute $sql$
    create trigger ai_messages_immutable
      before update on public.ai_messages
      for each row execute function public._ai_messages_immutable()
  $sql$;

  execute $sql$ drop policy if exists "Session owners update messages" on public.ai_messages $sql$;
  execute $sql$ revoke update on public.ai_messages from anon $sql$;
  execute $sql$ revoke update on public.ai_messages from authenticated $sql$;

end if;


-- ==========================================================================
-- 4. Tell PostgREST
-- ==========================================================================
perform pg_notify('pgrst', 'reload schema');
raise notice '072: applied.';

end $migration$;

notify pgrst, 'reload schema';
