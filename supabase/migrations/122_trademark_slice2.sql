-- 122_trademark_slice2.sql — Trademark Clearance, slice 2: the one-box start,
-- the TSDR deep check (stage 6) and the application draft (stage 9).
--
-- Spec: docs/specs/TRADEMARK-CLEARANCE-2026-10-18.md (slice 2 sections) and
-- the slice-2 build brief of 2026-10-21.
--
-- WHY
-- Slice 1 kept every judgment with the reviewer and every step in the Record.
-- Slice 2 collapses clicks, not judgment: a person types the marks and one
-- sentence, and the recipe runs to the first human step. That needs three
-- things stored that slice 1 held only in the browser, and two rules made
-- harder than a missing button:
--   * the model's proposals, saved PROPOSED (not confirmed) on the clearance,
--     so the review screen survives a reload and a bot's proposals are the
--     same ones the reviewer sees;
--   * the official status of each flagged hit, as the TSDR API returned it;
--   * the application answers (filing basis per class, dates of use, the
--     specimen, the bona-fide-intent evidence, the entity and transfer plan).
--   * A CONNECTED ASSISTANT CANNOT SIGN. A token our own server minted for a
--     connector carries cs_via:'connector' (lib/supabase-user-jwt.mjs; 094,
--     098 key on the same claim). Slice 1 kept the sign-off out of reach by
--     giving the connector no tool for it; from here the database refuses it
--     too: no stage sign-off and no bin decision under a connector's JWT.
--   * The docket gains its slice-2 prerequisites: stage 6 (deep check) is
--     signed after stage 5 (triage); stage 9 (application draft) after stage
--     8 (the knockout report) and after stage 6 is signed or skipped, and only
--     with the reviewed document attached.
--
-- WHAT (additive only; no existing row or column changes)
--   tm_clearances.proposals    {classes?: {search, filing, model, at},
--                               decompose?: {opening, hinge, ending, reason,
--                               foreign, model, at}} — PROPOSED, never the
--                               confirmed value (search_classes,
--                               filing_classes, decomposition stay that).
--   tm_clearances.application  the stage-9 answers (lib/trademark/application.mjs
--                               normalizes them): {classes: [{code,
--                               identification, id_source, basis, in_use,
--                               first_use_anywhere, first_use_in_commerce,
--                               specimen: {...}, intent_evidence: [...]}],
--                               transfer: {...}, updated_at}
--   tm_hits.deep_check         the reviewer asked for this hit's official
--                               status even though it is not flagged.
--   tm_hits.tsdr               the TSDR status as fetched: {status_code,
--                               status_text, live, registration_number,
--                               registration_date, filing_date, owner,
--                               classes, events: [...], fetched_at, source}
--   tm_hits.tsdr_checked_at    when it was fetched
--   tm_hits.tsdr_document_id   the status record filed in the matter
--
-- The Record (events, 064): six matter-bound kinds, re-declaring
-- events_kind_check with the UNION (064 … 121 + these), in 121's guarded
-- pattern. Metadata only: ids, serials, counts, codes, hashes, field names.
--   tm.proposal.saved        {clearance_id, step, model}
--   tm.deep_check.run        {clearance_id, checked, live, dead, failed, filed, configured}
--   tm.hit.status            {clearance_id, serial, live, status_code, document_id}
--   tm.application.answered  {clearance_id, fields}
--   tm.application.drafted   {clearance_id, document_id, annex_document_id, sha256, bases}
--   tm.application.reviewed  {clearance_id, document_id, sha256, initials}
--
-- RLS: unchanged — the new columns ride on 121's policies (read through
-- can_access_matter, write through can_write_matter). Every function here is
-- SECURITY INVOKER (house rule; no SECURITY DEFINER in this file).
--
-- Needs: 121. Re-runnable: executed twice in PGlite by
-- scripts/_verify-trademark-122.mjs.
--
-- ⚠ NOT APPLIED until Eden approves this file by name.
-- ⚠ After pasting, run:  notify pgrst, 'reload schema';  (last statement here.)

do $pre$
begin
  if to_regclass('public.tm_clearances') is null or to_regclass('public.tm_hits') is null
     or to_regclass('public.tm_stages') is null then
    raise exception '122 needs migration 121 (Trademark Clearance, slice 1) — paste 121 first.';
  end if;
  if to_regprocedure('auth.jwt()') is null then
    raise exception '122 needs auth.jwt() (Supabase auth schema).';
  end if;
end $pre$;

-- ============================================================================
-- 1. New columns
-- ============================================================================
alter table public.tm_clearances
  add column if not exists proposals   jsonb not null default '{}'::jsonb,
  add column if not exists application jsonb not null default '{}'::jsonb;

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'tm_clearances_proposals_object') then
    alter table public.tm_clearances add constraint tm_clearances_proposals_object
      check (jsonb_typeof(proposals) = 'object' and pg_column_size(proposals) <= 200000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tm_clearances_application_object') then
    alter table public.tm_clearances add constraint tm_clearances_application_object
      check (jsonb_typeof(application) = 'object' and pg_column_size(application) <= 200000);
  end if;
end $c$;

alter table public.tm_hits
  add column if not exists deep_check       boolean not null default false,
  add column if not exists tsdr             jsonb,
  add column if not exists tsdr_checked_at  timestamptz,
  add column if not exists tsdr_document_id uuid references public.documents(id) on delete set null;

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'tm_hits_tsdr_object') then
    alter table public.tm_hits add constraint tm_hits_tsdr_object
      check (tsdr is null or (jsonb_typeof(tsdr) = 'object' and pg_column_size(tsdr) <= 100000));
  end if;
end $c$;

comment on column public.tm_clearances.proposals is
  'Trademark Clearance: the model''s proposals, saved PROPOSED. Never the confirmed value.';
comment on column public.tm_clearances.application is
  'Trademark Clearance: the stage-9 answers (basis per class, dates of use, specimen, intent evidence, transfer plan).';
comment on column public.tm_hits.tsdr is
  'Trademark Clearance: the official status of this record as the TSDR API returned it (stage 6). Dead records are noted, not dropped.';

-- ============================================================================
-- 2. A connected assistant cannot sign: the claim our server puts on a
--    connector's JWT (cs_via = 'connector'), as 094 / 098 read it.
-- ============================================================================
create or replace function public._tm_via_connector()
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(coalesce(auth.jwt(), '{}'::jsonb) ->> 'cs_via', '') = 'connector'
$$;

-- The stage sign-off, slice 2. Runs AFTER 121's tm_stages_guard (triggers
-- fire in name order), so status / initials are already normalized here.
create or replace function public._tm_stages_guard_122()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_s5 text;
  v_s6 text;
  v_s8 text;
begin
  if tg_op <> 'UPDATE' then return new; end if;

  if new.status in ('done', 'skipped')
     and (new.status is distinct from old.status or new.initials is distinct from old.initials) then
    if public._tm_via_connector() then
      raise exception 'stage %: a connected assistant cannot sign a stage off; the reviewer signs it in the matter''s Trademark tab', new.stage
        using errcode = '42501';
    end if;
  end if;

  if new.status = 'done' and new.status is distinct from old.status then
    if new.stage = 6 then
      select status into v_s5 from public.tm_stages where clearance_id = new.clearance_id and stage = 5;
      if coalesce(v_s5, '') <> 'done' then
        raise exception 'stage 6: stage 5 must be done first' using errcode = '23514';
      end if;
    elsif new.stage = 9 then
      select status into v_s8 from public.tm_stages where clearance_id = new.clearance_id and stage = 8;
      select status into v_s6 from public.tm_stages where clearance_id = new.clearance_id and stage = 6;
      if coalesce(v_s8, '') <> 'done' then
        raise exception 'stage 9: stage 8 must be done first' using errcode = '23514';
      end if;
      if coalesce(v_s6, '') not in ('done', 'skipped') then
        raise exception 'stage 9: stage 6 (deep check) must be done or skipped first' using errcode = '23514';
      end if;
      if new.output_document_id is null then
        raise exception 'stage 9: signing the application draft off needs the reviewed document' using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists tm_stages_guard_122 on public.tm_stages;
create trigger tm_stages_guard_122
  before update on public.tm_stages
  for each row execute function public._tm_stages_guard_122();

-- A bin is the reviewer's decision (121). Under a connector's JWT no decision
-- is made at all, whatever the client sends.
create or replace function public._tm_hits_guard_122()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if not public._tm_via_connector() then return new; end if;
  if tg_op = 'INSERT' then
    if new.bin is not null or new.initials is not null or new.bin_reason is not null then
      raise exception 'hit %: a connected assistant cannot decide a bin', new.serial using errcode = '42501';
    end if;
  elsif new.bin is distinct from old.bin or new.initials is distinct from old.initials
        or new.bin_reason is distinct from old.bin_reason then
    raise exception 'hit %: a connected assistant cannot decide a bin', new.serial using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists tm_hits_guard_122 on public.tm_hits;
create trigger tm_hits_guard_122
  before insert or update on public.tm_hits
  for each row execute function public._tm_hits_guard_122();

-- ============================================================================
-- 3. The vocabulary — 121's guarded pattern, the UNION of every legal kind
-- ============================================================================
do $migration$
begin

if to_regclass('public.events') is null then
  raise notice '122: public.events is absent — migration 064 has not been applied; kinds skipped.';
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
    -- 094: the security build
    'auth.factor_enrolled',
    'auth.factor_unenrolled',
    'auth.stepup',
    'auth.new_device',
    'account.locked',
    'account.unlocked',
    'matter.disconnected',
    'file.filed',
    'file.integrity',
    'file.opened',
    'file.flagged',
    'share.expired',
    'share.reviewed',
    'tripwire.tripped',
    'tripwire.cleared',
    -- 100: the Brief Desk
    'draft.snapshot',
    'cite.checked',
    'draft.exported',
    -- 120: the Model Comparator
    'comparison.created',
    'comparison.candidate',
    'comparison.graded',
    'comparison.assembled',
    'comparison.revealed',
    -- 121: Trademark Clearance
    'tm.clearance.created',
    'tm.intake.updated',
    'tm.classes.set',
    'tm.queries.generated',
    'tm.query.run',
    'tm.hit.proposed',
    'tm.hit.decided',
    'tm.stage.done',
    'tm.report.filed',
    -- 122: Trademark Clearance, slice 2
    'tm.proposal.saved',
    'tm.deep_check.run',
    'tm.hit.status',
    'tm.application.answered',
    'tm.application.drafted',
    'tm.application.reviewed'
  ))
$sql$;

raise notice '122: events_kind_check widened by six tm.* kinds.';

end $migration$;

notify pgrst, 'reload schema';
