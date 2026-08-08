-- 046: The Courtroom â€” AI mock-jury rehearsal (Phase 1: Quick Panel).
--
-- Spec: docs/MOCK_TRIAL_SPEC_2026-08-07.md (Â§8 data model). Seven tables, all
-- matter-scoped. Everything stays in the matter (spec Â§2.4): inputs and
-- outputs are rows under existing RLS, and the Rehearsal Report is ALSO filed
-- into the matter as a real document (mock_trial_reports.document_id).
--
--   * mock_trials            â€” one rehearsal session: venue mix, sampler seed,
--                              model, status, and per-session usage metering
--                              (spec Â§12.2: build meters per-session cost).
--   * mock_trial_jurors      â€” the empaneled panel; profile jsonb is the
--                              two-layer juror model of spec Â§4 exactly.
--   * mock_trial_segments    â€” units of advocacy (opening/direct/cross/closing/
--                              exhibit), tagged ours|theirs.
--   * mock_trial_events      â€” objections/rulings/strikes are Phase 2, but the
--                              table ships now for schema stability; Phase 1
--                              writes deliberation turns as type 'note'.
--   * mock_trial_reactions   â€” per-juror per-segment private reactions.
--   * mock_trial_ballots     â€” leaning + conviction(1-7) + reasons, per round.
--   * mock_trial_reports     â€” the Rehearsal Report markdown + the document it
--                              was filed as.
--
-- RLS follows the migration-036/030/022 pattern: one SECURITY INVOKER wrapper
-- per feature (_ctrm_matter_access) delegating to _mtspc_select_check â€” never
-- call SECURITY DEFINER helpers directly from policy expressions.
--
-- Numbered 045 (not 042): 042/043 are applied in production (knowledge map)
-- and 044 is pending on fix/ingestion-unified. â›” Eden applies migrations.
--
-- Apply order: after 041 (and after 042-044 if/when those land â€” no
-- dependencies on them).

-- ============================================================================
-- Tables
-- ============================================================================

create table public.mock_trials (
  id uuid primary key default gen_random_uuid(),
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  -- Pitch-agnostic: names the rehearsal, not the product ("Anlauf v. UKC â€”
  -- opening + cross rehearsal").
  title text not null,
  mode text not null default 'quick' check (mode in ('quick', 'full')),
  status text not null default 'empanel'
    check (status in ('empanel', 'segments', 'running', 'complete', 'error')),
  -- Manual venue-mix sliders (spec Â§12.3) + panel size. The deterministic
  -- sampler input; same seed + same mix = same panel.
  venue_mix jsonb not null default '{}'::jsonb,
  seed integer not null default 0,
  model_id text not null default 'claude-fable-5',
  -- Token/cost metering accumulated per session (estimates are labeled as
  -- estimates inside the blob). Feeds the pricing math of spec Â§12.2.
  usage jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index mock_trials_matter_idx on public.mock_trials (matterspace_id);

create trigger mock_trials_updated_at
  before update on public.mock_trials
  for each row execute function public.update_updated_at();

create table public.mock_trial_jurors (
  id uuid primary key default gen_random_uuid(),
  trial_id uuid not null references public.mock_trials(id) on delete cascade,
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  seat integer not null,
  -- The spec-Â§4 juror object: composition layer (who is in the box) and
  -- reasoning layer (why they decide). Every field is lawyer-editable before
  -- empanelment; this row stores the approved version.
  profile jsonb not null,
  -- Rendered one-paragraph persona sheet (voice.backstory + register).
  persona_sheet text,
  created_at timestamptz not null default now(),
  unique (trial_id, seat)
);

create index mock_trial_jurors_trial_idx on public.mock_trial_jurors (trial_id);
create index mock_trial_jurors_matter_idx on public.mock_trial_jurors (matterspace_id);

create table public.mock_trial_segments (
  id uuid primary key default gen_random_uuid(),
  trial_id uuid not null references public.mock_trials(id) on delete cascade,
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  kind text not null check (kind in ('opening', 'direct', 'cross', 'closing', 'exhibit')),
  side text not null check (side in ('ours', 'theirs')),
  -- When the segment text came from a matter document rather than paste.
  source_document_id uuid references public.documents(id) on delete set null,
  transcript text not null,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create index mock_trial_segments_trial_idx on public.mock_trial_segments (trial_id, position);
create index mock_trial_segments_matter_idx on public.mock_trial_segments (matterspace_id);

-- Phase 2 will write objection/ruling/strike here; Phase 1 writes deliberation
-- turns as type 'note' (actor = 'juror:<seat>' | 'foreman:<seat>').
create table public.mock_trial_events (
  id uuid primary key default gen_random_uuid(),
  trial_id uuid not null references public.mock_trials(id) on delete cascade,
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  segment_id uuid references public.mock_trial_segments(id) on delete cascade,
  type text not null check (type in ('objection', 'ruling', 'strike', 'note')),
  actor text not null,
  payload jsonb not null default '{}'::jsonb,
  span_start integer,
  span_end integer,
  created_at timestamptz not null default now()
);

create index mock_trial_events_trial_idx on public.mock_trial_events (trial_id, created_at);
create index mock_trial_events_matter_idx on public.mock_trial_events (matterspace_id);

create table public.mock_trial_reactions (
  id uuid primary key default gen_random_uuid(),
  trial_id uuid not null references public.mock_trials(id) on delete cascade,
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  juror_id uuid not null references public.mock_trial_jurors(id) on delete cascade,
  segment_id uuid not null references public.mock_trial_segments(id) on delete cascade,
  -- Structured private reaction: salience list (3-5 moments w/ record cites),
  -- confusion points, credibility impressions, one-line gut response (Â§5).
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (juror_id, segment_id)
);

create index mock_trial_reactions_trial_idx on public.mock_trial_reactions (trial_id);
create index mock_trial_reactions_matter_idx on public.mock_trial_reactions (matterspace_id);

create table public.mock_trial_ballots (
  id uuid primary key default gen_random_uuid(),
  trial_id uuid not null references public.mock_trials(id) on delete cascade,
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  juror_id uuid not null references public.mock_trial_jurors(id) on delete cascade,
  -- Round 0 is the secret first ballot cast before any discussion (Â§6.1).
  round integer not null,
  leaning text not null check (leaning in ('ours', 'theirs', 'undecided')),
  conviction integer not null check (conviction between 1 and 7),
  -- Three reasons, each with a record cite (quote + locator).
  reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (juror_id, round)
);

create index mock_trial_ballots_trial_idx on public.mock_trial_ballots (trial_id, round);
create index mock_trial_ballots_matter_idx on public.mock_trial_ballots (matterspace_id);

create table public.mock_trial_reports (
  id uuid primary key default gen_random_uuid(),
  trial_id uuid not null references public.mock_trials(id) on delete cascade,
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  -- The report is ALSO filed into the matter through the normal upload path so
  -- it becomes searchable record (Â§9); this links the resulting document.
  document_id uuid references public.documents(id) on delete set null,
  markdown text not null,
  created_at timestamptz not null default now(),
  unique (trial_id)
);

create index mock_trial_reports_matter_idx on public.mock_trial_reports (matterspace_id);

-- ============================================================================
-- RLS â€” single SECURITY INVOKER access wrapper (migration-036/030/022 pattern)
-- ============================================================================

create or replace function public._ctrm_matter_access(p_matter uuid)
returns boolean
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
  v_ss uuid;
  v_parent uuid;
begin
  if v_uid is null then return false; end if;
  select serverspace_id, parent_matterspace_id
    into v_ss, v_parent
    from public.matterspaces where id = p_matter;
  if v_ss is null then return false; end if;
  return public._mtspc_select_check(p_matter, v_ss, v_parent);
end;
$$;

-- One policy quartet per table; all delegate to the wrapper on the row's own
-- matterspace_id (every table carries it precisely so policies never join).

alter table public.mock_trials enable row level security;
create policy mock_trials_select on public.mock_trials
  for select to authenticated using (public._ctrm_matter_access(matterspace_id));
create policy mock_trials_insert on public.mock_trials
  for insert to authenticated with check (public._ctrm_matter_access(matterspace_id));
create policy mock_trials_update on public.mock_trials
  for update to authenticated
  using (public._ctrm_matter_access(matterspace_id))
  with check (public._ctrm_matter_access(matterspace_id));
create policy mock_trials_delete on public.mock_trials
  for delete to authenticated using (public._ctrm_matter_access(matterspace_id));

alter table public.mock_trial_jurors enable row level security;
create policy mock_trial_jurors_select on public.mock_trial_jurors
  for select to authenticated using (public._ctrm_matter_access(matterspace_id));
create policy mock_trial_jurors_insert on public.mock_trial_jurors
  for insert to authenticated with check (public._ctrm_matter_access(matterspace_id));
create policy mock_trial_jurors_update on public.mock_trial_jurors
  for update to authenticated
  using (public._ctrm_matter_access(matterspace_id))
  with check (public._ctrm_matter_access(matterspace_id));
create policy mock_trial_jurors_delete on public.mock_trial_jurors
  for delete to authenticated using (public._ctrm_matter_access(matterspace_id));

alter table public.mock_trial_segments enable row level security;
create policy mock_trial_segments_select on public.mock_trial_segments
  for select to authenticated using (public._ctrm_matter_access(matterspace_id));
create policy mock_trial_segments_insert on public.mock_trial_segments
  for insert to authenticated with check (public._ctrm_matter_access(matterspace_id));
create policy mock_trial_segments_update on public.mock_trial_segments
  for update to authenticated
  using (public._ctrm_matter_access(matterspace_id))
  with check (public._ctrm_matter_access(matterspace_id));
create policy mock_trial_segments_delete on public.mock_trial_segments
  for delete to authenticated using (public._ctrm_matter_access(matterspace_id));

alter table public.mock_trial_events enable row level security;
create policy mock_trial_events_select on public.mock_trial_events
  for select to authenticated using (public._ctrm_matter_access(matterspace_id));
create policy mock_trial_events_insert on public.mock_trial_events
  for insert to authenticated with check (public._ctrm_matter_access(matterspace_id));
create policy mock_trial_events_update on public.mock_trial_events
  for update to authenticated
  using (public._ctrm_matter_access(matterspace_id))
  with check (public._ctrm_matter_access(matterspace_id));
create policy mock_trial_events_delete on public.mock_trial_events
  for delete to authenticated using (public._ctrm_matter_access(matterspace_id));

alter table public.mock_trial_reactions enable row level security;
create policy mock_trial_reactions_select on public.mock_trial_reactions
  for select to authenticated using (public._ctrm_matter_access(matterspace_id));
create policy mock_trial_reactions_insert on public.mock_trial_reactions
  for insert to authenticated with check (public._ctrm_matter_access(matterspace_id));
create policy mock_trial_reactions_update on public.mock_trial_reactions
  for update to authenticated
  using (public._ctrm_matter_access(matterspace_id))
  with check (public._ctrm_matter_access(matterspace_id));
create policy mock_trial_reactions_delete on public.mock_trial_reactions
  for delete to authenticated using (public._ctrm_matter_access(matterspace_id));

alter table public.mock_trial_ballots enable row level security;
create policy mock_trial_ballots_select on public.mock_trial_ballots
  for select to authenticated using (public._ctrm_matter_access(matterspace_id));
create policy mock_trial_ballots_insert on public.mock_trial_ballots
  for insert to authenticated with check (public._ctrm_matter_access(matterspace_id));
create policy mock_trial_ballots_update on public.mock_trial_ballots
  for update to authenticated
  using (public._ctrm_matter_access(matterspace_id))
  with check (public._ctrm_matter_access(matterspace_id));
create policy mock_trial_ballots_delete on public.mock_trial_ballots
  for delete to authenticated using (public._ctrm_matter_access(matterspace_id));

alter table public.mock_trial_reports enable row level security;
create policy mock_trial_reports_select on public.mock_trial_reports
  for select to authenticated using (public._ctrm_matter_access(matterspace_id));
create policy mock_trial_reports_insert on public.mock_trial_reports
  for insert to authenticated with check (public._ctrm_matter_access(matterspace_id));
create policy mock_trial_reports_update on public.mock_trial_reports
  for update to authenticated
  using (public._ctrm_matter_access(matterspace_id))
  with check (public._ctrm_matter_access(matterspace_id));
create policy mock_trial_reports_delete on public.mock_trial_reports
  for delete to authenticated using (public._ctrm_matter_access(matterspace_id));
