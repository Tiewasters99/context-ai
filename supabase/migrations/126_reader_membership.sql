-- Grapheon Reader, Phase 2S: the Library membership — entitlement
-- (docs/specs/GRAPHEON-READER-2026-10-10.md, "The Library membership (Phase
-- 2S)", "Entitlement — the one thing that must be right"; decisions D13–D20
-- taken 2026-10-28).
--
-- One membership, $9.99 a month, cancel any time, gates reading past the
-- sample of every Library edition. This migration is the gate and nothing
-- else: no Stripe, no mail, no Store. Three changes:
--
--   editions.access          'free' | 'paid' | 'library' — how a published
--                            edition is read. Until now 112's _edition_can_read
--                            inferred "free" from price_cents = 0; a Library
--                            book at price 0 would have been free to anyone
--                            signed in. Access is now explicit.
--   editions.collection_key, volume, release_on
--                            metadata for the mirrored Library (a volume set
--                            shows as one card) and the release queue.
--   edition_assets.kind      gains 'sample' (the first N pages as a PDF); the
--                            public bucket edition-samples holds those files.
--   reader_subscriptions     one row per member, written only by the Stripe
--                            webhook (service role), readable by its owner.
--   _reader_is_member(uuid)  the membership question, SECURITY INVOKER.
--   _edition_can_read(uuid)  gains the library clause; the free clause now
--                            needs access = 'free', not price 0.
--
-- Two refinements of the spec's sketch, both on the safe side (recorded in
-- the spec's Entitlement section and the PR):
--
--   1. For an edition that is NOT in the Library, access FOLLOWS PRICE
--      (0 → 'free', more → 'paid') through a trigger, on insert and on every
--      change of price_cents or access. The Reader's publish dialog (#413)
--      says "0 is free" and creates drafts without an access value; a fixed
--      default of 'paid' would have made every new $0 edition unreadable.
--      A Library edition is never derived: it is 'library' because the
--      mirror script said so.
--   2. Only the service role may put an edition INTO the Library (set
--      access = 'library'). 112's update policy lets a publisher change any
--      column of their own row; without this guard a third-party publisher
--      could place their book inside the membership (against D15 and the
--      rule that Grapheon never takes the whole margin on someone else's
--      work). The mirror script runs with the service role.
--
-- Lapse (D16): when _reader_is_member turns false the Reader stops serving
-- Library books; edition_marks and edition_progress stay (their SELECT
-- policies are owner-only and do not ask _edition_can_read), new marks are
-- refused until the member returns. Nothing is deleted on lapse.
--
-- NUMBERING: 126 was the next free number on 2026-10-29 after `git fetch`
-- (main ends at 125) and `gh pr list` (open PRs hold 046, 082 and 123).
-- Check again on the day this is applied, and ask Eden before applying.

-- ============================================================================
-- editions: access, the volume set, the release date
-- ============================================================================

alter table public.editions
  add column if not exists access text not null default 'paid'
    check (access in ('free', 'paid', 'library'));
alter table public.editions
  add column if not exists collection_key text;
alter table public.editions
  add column if not exists volume smallint check (volume is null or volume >= 1);
alter table public.editions
  add column if not exists release_on date;

comment on column public.editions.access is
  'How a published edition is read: free (anyone signed in), paid (an unrefunded purchase), library (a Grapheon Reader + Library member). free/paid follow price_cents for non-Library editions (editions_access_sync); library is set only with the service role.';
comment on column public.editions.collection_key is
  'Phase 2S: the volume set this edition belongs to ("Leaves of Grass" for Vol I and Vol II); null for a single book. The Store shows a set as one card.';
comment on column public.editions.volume is
  'Phase 2S: this edition''s place in its volume set, 1-based; null for a single book.';
comment on column public.editions.release_on is
  'Phase 2S: the day the release job may publish this draft (up to 3 a day, oldest first). Null = not queued. Eden may set it by hand to hold or hurry a book.';

-- Rows that exist before this migration: free when priced at 0, paid
-- otherwise. Library rows do not exist yet; on a re-run they are left alone.
update public.editions
   set access = case when price_cents = 0 then 'free' else 'paid' end
 where access <> 'library'
   and access is distinct from (case when price_cents = 0 then 'free' else 'paid' end);

create index if not exists editions_access_status_idx on public.editions (access, status);
create index if not exists editions_release_queue_idx on public.editions (release_on, created_at)
  where status = 'draft' and release_on is not null;
create index if not exists editions_collection_idx on public.editions (collection_key, volume)
  where collection_key is not null;

-- Refinements 1 and 2, in one trigger.
create or replace function public.editions_access_sync()
returns trigger
language plpgsql
security invoker
as $$
begin
  if new.access = 'library' then
    -- Into the Library only with the service role (or the database owner in
    -- the SQL editor). A publisher cannot put their own book inside the
    -- membership, and the Reader's dialog never sends this value.
    if (tg_op = 'INSERT' or old.access is distinct from 'library')
       and current_user in ('anon', 'authenticated') then
      raise exception 'Only the Library mirror can place an edition in the Library.' using errcode = '42501';
    end if;
    return new;
  end if;
  -- Not in the Library: access follows the price, as the publish dialog says.
  new.access := case when new.price_cents = 0 then 'free' else 'paid' end;
  return new;
end $$;

drop trigger if exists editions_access_sync on public.editions;
create trigger editions_access_sync
  before insert or update of price_cents, access on public.editions
  for each row execute function public.editions_access_sync();

-- ============================================================================
-- The sample: a fourth asset kind and a public bucket
-- ============================================================================

-- At publish the server cuts the first N pages (10%, floor 8, ceiling 30 —
-- D13) into a second PDF and stores it as kind 'sample' in the PUBLIC bucket
-- edition-samples/<edition id>/<version>.pdf, cacheable at the edge. The row
-- lives in edition_assets like the others (its storage_path is still
-- <edition id>/<file>; which bucket is implied by the kind). One sample per
-- edition: a Publish update replaces it.
alter table public.edition_assets drop constraint if exists edition_assets_kind_check;
alter table public.edition_assets drop constraint if exists edition_assets_kind_check_2s;
alter table public.edition_assets
  add constraint edition_assets_kind_check_2s check (kind in ('book', 'media', 'cover', 'sample'));

create unique index if not exists edition_assets_one_sample_idx
  on public.edition_assets (edition_id) where kind = 'sample';

comment on column public.edition_assets.kind is
  'book (the PDF, private bucket editions), media (a clip), cover, sample (the first N pages as a PDF in the PUBLIC bucket edition-samples — the only file of an edition anyone may fetch without the gate).';

-- Public: anyone may read; nothing is written but with the service role
-- (no storage policy grants a signed-in user anything here).
insert into storage.buckets (id, name, public)
values ('edition-samples', 'edition-samples', true)
on conflict (id) do nothing;

-- ============================================================================
-- reader_subscriptions — one row per member; the Stripe webhook writes it
-- ============================================================================

create table if not exists public.reader_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null,
  stripe_subscription_id text not null unique,
  -- Stripe's own words for the subscription's state.
  status text not null
    check (status in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  -- The price the member consented to (Stripe price id). A price change is a
  -- new consent (Terms T13).
  price_id text not null,
  -- The Checkout Session that carried the consent checkbox: the proof of
  -- express consent California keeps for three years (AB 2863) and the
  -- acknowledgment New York wants the member to be able to keep.
  consent_session_id text,
  consented_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.reader_subscriptions is
  'Grapheon Reader + Library membership (Phase 2S): one row per member, mirrored from Stripe by api/grapheon-webhook.mjs with the service role. The owner reads their own row (Member until …); nobody else writes it.';
comment on column public.reader_subscriptions.consent_session_id is
  'The Stripe Checkout Session id that carried the terms-of-service consent: the proof of consent (Cal. Bus. & Prof. Code § 17600 et seq.; N.Y. GBL § 527-a).';

create index if not exists reader_subscriptions_customer_idx on public.reader_subscriptions (stripe_customer_id);
create index if not exists reader_subscriptions_period_end_idx on public.reader_subscriptions (current_period_end);

drop trigger if exists update_reader_subscriptions_updated_at on public.reader_subscriptions;
create trigger update_reader_subscriptions_updated_at
  before update on public.reader_subscriptions
  for each row execute function public.update_updated_at();

alter table public.reader_subscriptions enable row level security;

-- The owner sees their own row. No insert, update or delete policy for
-- anyone: the webhook writes with the service role, which bypasses RLS.
drop policy if exists "Members see their own membership" on public.reader_subscriptions;
create policy "Members see their own membership"
  on public.reader_subscriptions for select
  using (user_id = auth.uid());

-- ============================================================================
-- _reader_is_member — the membership question (D16 grace)
-- ============================================================================

-- SECURITY INVOKER: asked by a member about themselves it reads their own
-- row under RLS; asked about anyone else it sees no row and says false,
-- which is the right answer. The service role (webhook, crons) sees all.
--
--   active or trialing, and the paid-for period has not ended      → member
--   past_due, within 7 days of the period end (Stripe is retrying) → member
--   anything else (canceled, unpaid, incomplete, paused, lapsed)   → not
--
-- cancel_at_period_end does not end the membership early: a member who has
-- cancelled reads until the period they paid for runs out.
create or replace function public._reader_is_member(p_user uuid)
returns boolean
language plpgsql
security invoker
as $$
begin
  if p_user is null then return false; end if;
  return exists (
    select 1 from public.reader_subscriptions s
    where s.user_id = p_user
      and (
        (s.status in ('active', 'trialing') and s.current_period_end > now())
        or (s.status = 'past_due' and s.current_period_end + interval '7 days' > now())
      )
  );
end $$;

grant execute on function public._reader_is_member(uuid) to authenticated, service_role;

-- ============================================================================
-- _edition_can_read — the one gate, with the library clause
-- ============================================================================

-- May the caller read the edition's book:
--   its publisher                                         → always
--   access = 'library'  published, and the caller a member → yes
--                       withdrawn                           → no (the book has left
--                                                             the Library; the Terms
--                                                             say the catalogue changes)
--   access = 'free'     published, anyone signed in        → yes
--   access = 'paid'     published or withdrawn, an unrefunded purchase → yes
--   anything else                                          → no
-- Price alone no longer opens a book: a 'paid' edition priced at 0 (which the
-- trigger prevents for non-Library rows) would read only to its owners.
create or replace function public._edition_can_read(p_edition uuid)
returns boolean
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
  v_pub uuid;
  v_status text;
  v_access text;
begin
  if v_uid is null or p_edition is null then return false; end if;
  select e.publisher_user_id, e.status, e.access
    into v_pub, v_status, v_access
    from public.editions e where e.id = p_edition;
  if v_pub is null then return false; end if;
  if v_pub = v_uid then return true; end if;
  if v_access = 'library' then
    return v_status = 'published' and public._reader_is_member(v_uid);
  end if;
  if v_access = 'free' and v_status = 'published' then return true; end if;
  if v_status in ('published', 'withdrawn') then
    return exists (
      select 1 from public.edition_purchases p
      where p.edition_id = p_edition and p.user_id = v_uid and p.refunded_at is null
    );
  end if;
  return false;
end $$;

grant execute on function public._edition_can_read(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
