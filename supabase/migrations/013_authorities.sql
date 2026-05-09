-- Contextspaces Migration 013: Authorities (cite-check + concordance)
--
-- Five tables that together back the cite-check pipeline and the per-matter
-- Authorities tab. Designed for the hybrid model: each authority is a
-- user-level library record; matters link to authorities through a join
-- table that carries matter-specific editorial context. Sharing primitives
-- (visibility = private | matter | community) are baked in from day 1 so
-- the eventual community pool needs no schema migration — only an app-
-- level switch on the visibility default.
--
-- Tables:
--   authorities                — the verified record (citation, full text, summary, ...)
--   authority_propositions     — array-style: {pin_cite, proposition_text} per authority
--   authority_editorial_notes  — lawyer notes; can be matter-scoped, private, or community
--   matter_authorities         — join: which authorities are linked to which matter
--   authority_verifications    — append-only log of verification events
--
-- RLS: a user sees their own authorities and the community pool; matter-
-- scoped notes are visible to anyone in the matter's serverspace. Writes
-- and updates are restricted to the contributor.

-- =============================================================================
-- authorities
-- =============================================================================
create table if not exists public.authorities (
  id uuid primary key default gen_random_uuid(),
  -- Bluebook canonical citation, e.g. "Matter of Parkview Assoc. v. City of New York, 71 N.Y.2d 274 (1988)"
  citation_bluebook text not null,
  -- Short form for re-cites within a brief, e.g. "Parkview, 71 N.Y.2d at 282"
  citation_short text,
  case_name text,
  court text,
  year int,
  jurisdiction text,
  authority_type text not null check (authority_type in (
    'statute', 'regulation', 'case', 'treatise', 'rule', 'other'
  )),
  -- Tags for cross-cutting filters: 'consumer protection', 'bankruptcy', etc.
  doctrinal_subject text[] default '{}',
  -- Full opinion or statutory text — public domain only. NEVER store West
  -- editorial content (headnotes, Key Numbers, summaries) per ROSS lesson.
  full_text text,
  -- Lawyer-authored summary, 1-3 sentences distilling holding.
  holding_summary text,
  -- Where the verification text came from. Examples:
  --   'Cornell LII https://www.law.cornell.edu/uscode/text/11/523'
  --   'CourtListener https://...'
  --   'Westlaw paste 2026-05-09'
  --   'Secondary attestation (3+ appellate cites)'
  --   'Model recall — UNVERIFIED'
  source_provenance text,
  verification_status text not null default 'unverified' check (verification_status in (
    'verified', 'verified-by-attestation', 'partial', 'unverified', 'flagged'
  )),
  confidence_rating text check (confidence_rating in ('high', 'medium', 'low', 'unknown')),
  -- Sharing scope: private = only contributor sees it; community = pool.
  -- (matter-level visibility lives on editorial_notes / matter_authorities,
  -- not on the authority record itself — the underlying record is shared.)
  visibility text not null default 'private' check (visibility in ('private', 'community')),
  contributor_user_id uuid references auth.users(id) on delete set null,
  -- KeyCite / Shepard's snapshot if pulled from Westlaw. Never store the
  -- citator analysis text itself — only the colored signal.
  key_cite_status text check (key_cite_status in ('green', 'yellow', 'red', 'unknown')),
  last_validity_check timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_authorities_contributor
  on public.authorities (contributor_user_id);
create index if not exists idx_authorities_visibility
  on public.authorities (visibility);
create index if not exists idx_authorities_citation
  on public.authorities (citation_bluebook);
create index if not exists idx_authorities_doctrinal
  on public.authorities using gin (doctrinal_subject);

alter table public.authorities enable row level security;

drop policy if exists "Users read own authorities and community pool" on public.authorities;
drop policy if exists "Users create authorities they contribute" on public.authorities;
drop policy if exists "Users update only their own authorities" on public.authorities;
drop policy if exists "Users delete only their own private authorities" on public.authorities;

create policy "Users read own authorities and community pool"
  on public.authorities for select
  using (
    contributor_user_id = auth.uid()
    or visibility = 'community'
  );

create policy "Users create authorities they contribute"
  on public.authorities for insert
  with check (contributor_user_id = auth.uid());

create policy "Users update only their own authorities"
  on public.authorities for update
  using (contributor_user_id = auth.uid())
  with check (contributor_user_id = auth.uid());

create policy "Users delete only their own private authorities"
  on public.authorities for delete
  using (contributor_user_id = auth.uid() and visibility = 'private');


-- =============================================================================
-- authority_propositions
-- One authority can stand for many propositions, each with its own pin cite
-- and signal. Broken out (rather than JSON-arrayed on the parent) so the
-- cite-check pipeline can do indexed lookups by pin.
-- =============================================================================
create table if not exists public.authority_propositions (
  id uuid primary key default gen_random_uuid(),
  authority_id uuid not null references public.authorities(id) on delete cascade,
  proposition_text text not null,
  pin_cite text,                          -- e.g. "282", "44", "486-87"
  signal text,                            -- 'see', 'accord', 'cf.', 'but see', etc.
  author_user_id uuid references auth.users(id) on delete set null,
  visibility text not null default 'private' check (visibility in ('private', 'community')),
  created_at timestamptz default now()
);

create index if not exists idx_propositions_authority
  on public.authority_propositions (authority_id);
create index if not exists idx_propositions_author
  on public.authority_propositions (author_user_id);

alter table public.authority_propositions enable row level security;

drop policy if exists "Read own or community propositions" on public.authority_propositions;
drop policy if exists "Write own propositions" on public.authority_propositions;
drop policy if exists "Update own propositions" on public.authority_propositions;
drop policy if exists "Delete own propositions" on public.authority_propositions;

create policy "Read own or community propositions"
  on public.authority_propositions for select
  using (author_user_id = auth.uid() or visibility = 'community');

create policy "Write own propositions"
  on public.authority_propositions for insert
  with check (author_user_id = auth.uid());

create policy "Update own propositions"
  on public.authority_propositions for update
  using (author_user_id = auth.uid())
  with check (author_user_id = auth.uid());

create policy "Delete own propositions"
  on public.authority_propositions for delete
  using (author_user_id = auth.uid());


-- =============================================================================
-- authority_editorial_notes
-- Free-form notes attached to an authority. Three flavors via visibility:
--   - 'private'   : only the author sees it. Default.
--   - 'matter'    : visible to members of a specific matter. Requires matter_id.
--   - 'community' : visible to everyone using Contextspaces. Disallows matter_id
--                   to prevent leaking matter-specific strategy.
-- =============================================================================
create table if not exists public.authority_editorial_notes (
  id uuid primary key default gen_random_uuid(),
  authority_id uuid not null references public.authorities(id) on delete cascade,
  matter_id uuid references public.matterspaces(id) on delete cascade,
  note_text text not null,
  author_user_id uuid references auth.users(id) on delete set null,
  visibility text not null default 'private' check (visibility in ('private', 'matter', 'community')),
  created_at timestamptz default now(),
  -- Consistency: matter-scoped notes must have a matter_id; community/private must NOT.
  constraint matter_visibility_consistent check (
    (matter_id is null and visibility in ('private', 'community')) or
    (matter_id is not null and visibility = 'matter')
  )
);

create index if not exists idx_editorial_notes_authority
  on public.authority_editorial_notes (authority_id);
create index if not exists idx_editorial_notes_matter
  on public.authority_editorial_notes (matter_id);
create index if not exists idx_editorial_notes_author
  on public.authority_editorial_notes (author_user_id);

alter table public.authority_editorial_notes enable row level security;

drop policy if exists "Read editorial notes per visibility" on public.authority_editorial_notes;
drop policy if exists "Write own editorial notes" on public.authority_editorial_notes;
drop policy if exists "Update own editorial notes" on public.authority_editorial_notes;
drop policy if exists "Delete own editorial notes" on public.authority_editorial_notes;

create policy "Read editorial notes per visibility"
  on public.authority_editorial_notes for select
  using (
    author_user_id = auth.uid()
    or visibility = 'community'
    or (
      visibility = 'matter'
      and matter_id in (
        select m.id from public.matterspaces m
        where public.is_serverspace_member(m.serverspace_id)
      )
    )
  );

create policy "Write own editorial notes"
  on public.authority_editorial_notes for insert
  with check (author_user_id = auth.uid());

create policy "Update own editorial notes"
  on public.authority_editorial_notes for update
  using (author_user_id = auth.uid())
  with check (author_user_id = auth.uid());

create policy "Delete own editorial notes"
  on public.authority_editorial_notes for delete
  using (author_user_id = auth.uid());


-- =============================================================================
-- matter_authorities
-- Join between a matter and the authorities relied on within it. Carries
-- matter-specific blurb and a list of brief-document ids where the
-- authority is cited. Unique per (matter, authority) pair so a "link"
-- isn't accidentally duplicated.
-- =============================================================================
create table if not exists public.matter_authorities (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.matterspaces(id) on delete cascade,
  authority_id uuid not null references public.authorities(id) on delete cascade,
  added_by_user_id uuid references auth.users(id) on delete set null,
  notes text,                              -- short matter-specific blurb
  cited_in_briefs text[] default '{}',     -- doc ids or filenames where this authority is cited
  added_at timestamptz default now(),
  unique (matter_id, authority_id)
);

create index if not exists idx_matter_authorities_matter
  on public.matter_authorities (matter_id);
create index if not exists idx_matter_authorities_authority
  on public.matter_authorities (authority_id);

alter table public.matter_authorities enable row level security;

drop policy if exists "See matter authorities for own matters" on public.matter_authorities;
drop policy if exists "Add authorities to matters with member access" on public.matter_authorities;
drop policy if exists "Update matter authorities with member access" on public.matter_authorities;
drop policy if exists "Remove matter authorities with admin access" on public.matter_authorities;

create policy "See matter authorities for own matters"
  on public.matter_authorities for select
  using (
    matter_id in (
      select m.id from public.matterspaces m
      where public.is_serverspace_member(m.serverspace_id)
    )
  );

create policy "Add authorities to matters with member access"
  on public.matter_authorities for insert
  with check (
    matter_id in (
      select m.id from public.matterspaces m
      where public.has_serverspace_role(m.serverspace_id, array['owner','admin','member'])
    )
  );

create policy "Update matter authorities with member access"
  on public.matter_authorities for update
  using (
    matter_id in (
      select m.id from public.matterspaces m
      where public.has_serverspace_role(m.serverspace_id, array['owner','admin','member'])
    )
  );

create policy "Remove matter authorities with admin access"
  on public.matter_authorities for delete
  using (
    matter_id in (
      select m.id from public.matterspaces m
      where public.has_serverspace_role(m.serverspace_id, array['owner','admin'])
    )
  );


-- =============================================================================
-- authority_verifications
-- Append-only log of "user X verified authority Y on date Z from source S".
-- Powers the eventual reputation layer ("checked by N lawyers"). Visible
-- whenever the underlying authority is visible.
-- =============================================================================
create table if not exists public.authority_verifications (
  id uuid primary key default gen_random_uuid(),
  authority_id uuid not null references public.authorities(id) on delete cascade,
  verifier_user_id uuid references auth.users(id) on delete set null,
  source text not null,
  notes text,
  verified_at timestamptz default now()
);

create index if not exists idx_verifications_authority
  on public.authority_verifications (authority_id);

alter table public.authority_verifications enable row level security;

drop policy if exists "Read verifications for visible authorities" on public.authority_verifications;
drop policy if exists "Write own verifications" on public.authority_verifications;

create policy "Read verifications for visible authorities"
  on public.authority_verifications for select
  using (
    authority_id in (
      select a.id from public.authorities a
      where a.contributor_user_id = auth.uid() or a.visibility = 'community'
    )
  );

create policy "Write own verifications"
  on public.authority_verifications for insert
  with check (verifier_user_id = auth.uid());


-- =============================================================================
-- updated_at trigger for authorities (other tables don't need it; they're
-- effectively append-only or change rarely).
-- =============================================================================
create or replace function public.touch_authorities_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_authorities_updated_at on public.authorities;
create trigger trg_authorities_updated_at
  before update on public.authorities
  for each row execute function public.touch_authorities_updated_at();
