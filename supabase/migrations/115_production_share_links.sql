-- 115_production_share_links.sql
--
-- Discovery: send a packaged production by link (Eden, 2026-10-13).
--
-- Until now "Email link" in a production's delivery step only WROTE a line in
-- the delivery log; nothing was sent. This adds real links, shared the way
-- OneDrive shares a file:
--
--   production_share_links   one link to ONE production's package ZIP.
--     audience 'anyone'  anyone holding the link may download it;
--     audience 'people'  only the addresses in allowed_emails, each proving
--                        it with a one-time code sent to that address;
--     password_hash      optional on either (scrypt; never the password);
--     expires_at         always set; revoked_at turns a link off early.
--     sealed             whether the matter was sealed when the link was
--                        made; a sealed link must name its people (CHECK).
--     token_hash         sha256 of the link's secret token; the token itself
--                        is never stored, so a reader of this table cannot
--                        rebuild a working link.
--   production_share_codes   the emailed codes, salted-hashed, ten minutes.
--   production_share_events  every download and every refused attempt.
--
-- Who touches what:
--   * Matter members SEE their matter's links and events (030's
--     _disc_matter_access, SECURITY INVOKER — the migration-022 rule). The
--     hash columns are not granted to them at all.
--   * Nobody writes these tables through PostgREST. Links are made, revoked
--     and opened only by api/production-share.mjs with the service role,
--     after it has checked the caller (membership, the step-up gate, the
--     seal). That is what keeps a member from widening a sealed link by
--     editing its row.
--   * anon gets nothing; the recipient page talks only to the API.
--
-- No SECURITY DEFINER function. Idempotent: safe to paste twice. Additive
-- only. Needs 030 (productions, deliveries, _disc_matter_access).
-- ⚠ After pasting, run:  notify pgrst, 'reload schema';  (last statement here.)

do $pre$
begin
  if to_regclass('public.deliveries') is null
     or to_regprocedure('public._disc_matter_access(uuid)') is null then
    raise exception '115 needs migration 030 (Discovery productions) — it is missing.';
  end if;
end $pre$;

-- 1. Links -------------------------------------------------------------------

create table if not exists public.production_share_links (
  id                  uuid primary key default gen_random_uuid(),
  matterspace_id      uuid not null references public.matterspaces(id) on delete cascade,
  production_id       uuid not null references public.productions(id) on delete cascade,
  delivery_id         uuid references public.deliveries(id) on delete set null,
  token_hash          text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  audience            text not null check (audience in ('anyone', 'people')),
  allowed_emails      text[] not null default '{}',
  password_hash       text,
  has_password        boolean generated always as (password_hash is not null) stored,
  sealed              boolean not null default false,
  recipient_name      text check (recipient_name is null or length(recipient_name) <= 200),
  expires_at          timestamptz not null,
  revoked_at          timestamptz,
  revoked_by          uuid references public.profiles(id) on delete set null,
  first_downloaded_at timestamptz,
  download_count      int not null default 0,
  created_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  constraint production_share_links_people_named
    check (audience <> 'people' or cardinality(allowed_emails) between 1 and 20),
  constraint production_share_links_sealed_names_people
    check (not sealed or audience = 'people')
);

create index if not exists production_share_links_production_idx
  on public.production_share_links (production_id, created_at desc);
create index if not exists production_share_links_creator_idx
  on public.production_share_links (created_by, created_at desc);

comment on table public.production_share_links is
  'Links that send one packaged production. Made, revoked and opened only through /api/production-share (service role); members read their matter''s links.';

alter table public.production_share_links enable row level security;

drop policy if exists "Matter members see share links" on public.production_share_links;
create policy "Matter members see share links" on public.production_share_links
  for select
  using (public._disc_matter_access(matterspace_id));

revoke all on public.production_share_links from anon, authenticated;
-- Every column but the two hashes.
grant select (id, matterspace_id, production_id, delivery_id, audience, allowed_emails,
              has_password, sealed, recipient_name, expires_at, revoked_at, revoked_by,
              first_downloaded_at, download_count, created_by, created_at)
  on public.production_share_links to authenticated;
grant all on public.production_share_links to service_role;

-- 2. Codes (service role only) -----------------------------------------------

create table if not exists public.production_share_codes (
  id         uuid primary key default gen_random_uuid(),
  link_id    uuid not null references public.production_share_links(id) on delete cascade,
  email      text not null,
  code_hash  text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  attempts   int not null default 0,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists production_share_codes_lookup_idx
  on public.production_share_codes (link_id, email, created_at desc);

alter table public.production_share_codes enable row level security;
revoke all on public.production_share_codes from anon, authenticated;
grant all on public.production_share_codes to service_role;

-- 3. Events ------------------------------------------------------------------

create table if not exists public.production_share_events (
  id             uuid primary key default gen_random_uuid(),
  link_id        uuid not null references public.production_share_links(id) on delete cascade,
  matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
  kind           text not null check (kind in (
                   'created', 'emailed', 'code_sent', 'downloaded', 'revoked',
                   'refused_not_allowed', 'refused_code', 'refused_password',
                   'refused_expired', 'refused_revoked', 'refused_throttled')),
  email          text,
  ip             text,
  user_agent     text,
  detail         text check (detail is null or length(detail) <= 500),
  created_at     timestamptz not null default now()
);

create index if not exists production_share_events_link_idx
  on public.production_share_events (link_id, created_at desc);

alter table public.production_share_events enable row level security;

drop policy if exists "Matter members see share events" on public.production_share_events;
create policy "Matter members see share events" on public.production_share_events
  for select
  using (public._disc_matter_access(matterspace_id));

revoke all on public.production_share_events from anon, authenticated;
grant select on public.production_share_events to authenticated;
grant all on public.production_share_events to service_role;

notify pgrst, 'reload schema';
