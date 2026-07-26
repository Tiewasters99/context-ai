-- Contextspaces Mediation Center — cases, parties, scheduling, messages, offers.
-- Ported from Grapheon Mediation (grapheon-ai migrations 0003 + 0004, merged).
--
-- Access model: party-facing CRUD rides each user's own JWT-scoped client +
-- RLS (anon key). The AI mediator must read BOTH parties' confidential
-- material, which RLS forbids for either session — mediator paths therefore
-- use the service-role client (api/mediation.mjs), server-side only.
-- The fee is PER PARTY from day one (each side pays its own registration fee).
-- Apply once in the Contextspaces Supabase project. Idempotent: safe to re-run.

-- ── Cases ───────────────────────────────────────────────────────────────────
create table if not exists public.mediation_cases (
  id                     uuid primary key default gen_random_uuid(),
  created_by             uuid not null references auth.users(id) on delete cascade,
  title                  text not null,
  invite_code            text not null unique,
  status                 text not null default 'awaiting_party' check (status in (
                           'awaiting_party',   -- creator registered, other side not yet joined
                           'intake',           -- both in: 500-word summaries + fees + model choice
                           'scheduling',       -- calendar rounds until a day matches
                           'position_papers',  -- day set: 5-page summaries + demands
                           'framework',        -- mediator drafting the legal-framework synthesis
                           'analysis',         -- framework issued: 10-page analyses
                           'pre_mediation',    -- confidential strengths/weaknesses chats
                           'mediation_day',    -- breakout caucuses + shuttle diplomacy
                           'settlement_draft', -- agreement reached, draft in progress
                           'attorney_review',  -- human panel attorney documenting
                           'settled',
                           'unresolved',
                           'closed'
                         )),
  mediator_model         text not null default 'claude-opus-4-8',
  scheduled_date         date,
  scheduling_round       int not null default 1,
  legal_framework        text,   -- mediator's synthesis of governing law; visible to both parties
  settlement_draft       text,
  attorney_review_status text check (attorney_review_status in ('requested','in_review','approved','signed')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- ── Parties (two per case; each pays its own registration fee) ──────────────
create table if not exists public.mediation_parties (
  id                uuid primary key default gen_random_uuid(),
  case_id           uuid not null references public.mediation_cases(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  label             text not null check (label in ('A','B')),
  display_name      text not null,
  fee_paid          boolean not null default false,
  -- Confidential submissions: each visible ONLY to its author (and to the
  -- mediator via the service client). Never exposed to the other party.
  intake_summary    text,   -- ≤ 500 words
  position_paper    text,   -- ≤ 5 pages (≈ 2,500 words)
  demand            text,
  analysis          text,   -- ≤ 10 pages (≈ 5,000 words)
  caucus_started_at timestamptz,  -- mediation-day 30-minute caucus clock
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (case_id, user_id),
  unique (case_id, label)
);

create index if not exists mediation_parties_case_idx on public.mediation_parties (case_id);
create index if not exists mediation_parties_user_idx on public.mediation_parties (user_id);

-- ── Calendar proposals (3 days per party per round; blind until matched) ────
create table if not exists public.mediation_date_proposals (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid not null references public.mediation_cases(id) on delete cascade,
  party_id   uuid not null references public.mediation_parties(id) on delete cascade,
  round      int not null,
  dates      date[] not null,
  created_at timestamptz not null default now(),
  unique (case_id, party_id, round)
);

create index if not exists mediation_dates_case_idx on public.mediation_date_proposals (case_id, round);

-- ── Messages (common room + per-party confidential channels) ────────────────
create table if not exists public.mediation_messages (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid not null references public.mediation_cases(id) on delete cascade,
  -- party_id NULL  → common-room message (both parties see it)
  -- party_id set   → confidential channel of that party (breakout / pre-mediation)
  party_id   uuid references public.mediation_parties(id) on delete cascade,
  channel    text not null check (channel in ('common','assessment','caucus')),
  sender     text not null check (sender in ('party','mediator','system')),
  content    text not null,
  created_at timestamptz not null default now()
);

create index if not exists mediation_messages_case_idx on public.mediation_messages (case_id, created_at);

-- ── Settlement offers (relayed by the mediator only with consent) ───────────
create table if not exists public.mediation_offers (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references public.mediation_cases(id) on delete cascade,
  from_party  uuid not null references public.mediation_parties(id) on delete cascade,
  terms       text not null,
  shared      boolean not null default false,  -- party consented to relay to the other side
  status      text not null default 'open' check (status in ('open','withdrawn','accepted','rejected')),
  created_at  timestamptz not null default now()
);

create index if not exists mediation_offers_case_idx on public.mediation_offers (case_id, created_at);

-- ── Membership helper ────────────────────────────────────────────────────────
-- Inner fn is SECURITY DEFINER (bypasses RLS to avoid policy recursion between
-- cases ↔ parties); policies call only the SECURITY INVOKER wrapper — the
-- house rule for SECURITY DEFINER helpers in this schema (see 022/023).
create or replace function public.mediation_is_member_definer(p_case_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.mediation_parties
    where case_id = p_case_id and user_id = auth.uid()
  );
$$;

create or replace function public.mediation_is_member(p_case_id uuid)
returns boolean
language plpgsql stable security invoker set search_path = public as $$
begin
  return public.mediation_is_member_definer(p_case_id);
end;
$$;

revoke all on function public.mediation_is_member_definer(uuid) from anon;
grant execute on function public.mediation_is_member_definer(uuid) to authenticated;
grant execute on function public.mediation_is_member(uuid) to authenticated;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.mediation_cases          enable row level security;
alter table public.mediation_parties        enable row level security;
alter table public.mediation_date_proposals enable row level security;
alter table public.mediation_messages       enable row level security;
alter table public.mediation_offers         enable row level security;

-- Cases: members read; creator inserts; members may update (API constrains
-- what actually changes; mediator writes use the service client anyway).
drop policy if exists "med_cases_select_member"  on public.mediation_cases;
drop policy if exists "med_cases_insert_creator" on public.mediation_cases;
drop policy if exists "med_cases_update_member"  on public.mediation_cases;
create policy "med_cases_select_member" on public.mediation_cases
  for select using (created_by = auth.uid() or public.mediation_is_member(id));
create policy "med_cases_insert_creator" on public.mediation_cases
  for insert with check (created_by = auth.uid());
create policy "med_cases_update_member" on public.mediation_cases
  for update using (created_by = auth.uid() or public.mediation_is_member(id))
  with check (created_by = auth.uid() or public.mediation_is_member(id));

-- Parties: STRICT — each user sees only their OWN party row. The other side's
-- display name / progress flags are served, sanitized, by the API via the
-- service client. Submissions never cross this line.
drop policy if exists "med_parties_select_own" on public.mediation_parties;
drop policy if exists "med_parties_insert_own" on public.mediation_parties;
drop policy if exists "med_parties_update_own" on public.mediation_parties;
create policy "med_parties_select_own" on public.mediation_parties
  for select using (user_id = auth.uid());
create policy "med_parties_insert_own" on public.mediation_parties
  for insert with check (user_id = auth.uid());
create policy "med_parties_update_own" on public.mediation_parties
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Date proposals: blind — only the proposing party sees its own picks.
-- Matching runs server-side with the service client.
drop policy if exists "med_dates_select_own" on public.mediation_date_proposals;
drop policy if exists "med_dates_insert_own" on public.mediation_date_proposals;
create policy "med_dates_select_own" on public.mediation_date_proposals
  for select using (exists (
    select 1 from public.mediation_parties p
    where p.id = party_id and p.user_id = auth.uid()
  ));
create policy "med_dates_insert_own" on public.mediation_date_proposals
  for insert with check (exists (
    select 1 from public.mediation_parties p
    where p.id = party_id and p.user_id = auth.uid()
  ));

-- Messages: common-room messages visible to all case members; channel
-- messages ONLY to the owning party. Parties insert into their own channels;
-- mediator/system rows are inserted by the service client.
drop policy if exists "med_msgs_select" on public.mediation_messages;
drop policy if exists "med_msgs_insert_own" on public.mediation_messages;
create policy "med_msgs_select" on public.mediation_messages
  for select using (
    (party_id is null and public.mediation_is_member(case_id))
    or exists (
      select 1 from public.mediation_parties p
      where p.id = party_id and p.user_id = auth.uid()
    )
  );
create policy "med_msgs_insert_own" on public.mediation_messages
  for insert with check (
    sender = 'party' and exists (
      select 1 from public.mediation_parties p
      where p.id = party_id and p.user_id = auth.uid()
    )
  );

-- Offers: a party sees its own offers; opposing offers are relayed by the
-- mediator (service client) only when shared = true.
drop policy if exists "med_offers_select_own" on public.mediation_offers;
drop policy if exists "med_offers_insert_own" on public.mediation_offers;
drop policy if exists "med_offers_update_own" on public.mediation_offers;
create policy "med_offers_select_own" on public.mediation_offers
  for select using (exists (
    select 1 from public.mediation_parties p
    where p.id = from_party and p.user_id = auth.uid()
  ));
create policy "med_offers_insert_own" on public.mediation_offers
  for insert with check (exists (
    select 1 from public.mediation_parties p
    where p.id = from_party and p.user_id = auth.uid()
  ));
create policy "med_offers_update_own" on public.mediation_offers
  for update using (exists (
    select 1 from public.mediation_parties p
    where p.id = from_party and p.user_id = auth.uid()
  ));

-- ── keep updated_at fresh (self-contained, like 019/030) ─────────────────────
create or replace function public.set_mediation_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists mediation_cases_touch on public.mediation_cases;
create trigger mediation_cases_touch before update on public.mediation_cases
  for each row execute function public.set_mediation_updated_at();

drop trigger if exists mediation_parties_touch on public.mediation_parties;
create trigger mediation_parties_touch before update on public.mediation_parties
  for each row execute function public.set_mediation_updated_at();
