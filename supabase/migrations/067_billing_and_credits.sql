-- Contextspaces Migration 067: subscriptions, credit packs, and the credit
-- half of the meter.
--
-- What this is for
-- ---------------------------------------------------------------------------
-- Migration 063 built the monthly wallet: one allowance per account per month,
-- sized by `profiles.pricing_tier`, spent through `usage_consume`. It has no
-- notion of money coming IN. This file adds that half:
--
--   * the PLANS, as rows rather than code — internal tier key, Stripe price id,
--     display name, price for display, sort order, active flag;
--   * the CREDIT PACKS, likewise — cents charged → credit cents granted;
--   * `billing_accounts`, the Stripe customer / subscription / status / period
--     for each user, kept OFF `public.profiles` on purpose (062's SELECT policy
--     exposes a profiles row to every co-member of every shared space, and a
--     subscription id is nobody's business but the account holder's);
--   * `billing_events`, the event-id ledger that makes the webhook idempotent;
--   * `usage_credit_balance` + `usage_credit_ledger`, a durable, append-only
--     record of every cent granted and every cent drawn;
--   * a credit-aware `usage_consume` and `usage_record_actual`, both REPLACED
--     at their existing signatures so every handler merged in PR #161 keeps
--     working with no edit at all.
--
-- Eden's decisions, and where each one lives
-- ---------------------------------------------------------------------------
-- Nothing below is a price Eden has agreed to. Every number and every name is
-- a row he edits in the Supabase SQL editor; no redeploy, no code change.
--
--   what                          where
--   ----------------------------  ------------------------------------------
--   plan names                    billing_plans.display_name
--   plan prices (display)         billing_plans.monthly_cents
--   which Stripe price is which   billing_plans.stripe_price_id
--   monthly allowance per tier    usage_budgets.monthly_cents   (from 063)
--   pack sizes and what they buy  billing_credit_packs
--   past-due grace                billing_settings.past_due_grace_days
--   free trial length             billing_plans.trial_days / billing_settings
--   currency, return paths        billing_settings
--
-- The seeds use `on conflict do nothing`, so re-pasting this file never
-- clobbers a number Eden has edited. The seeded display names are placeholders
-- ("Basic", "Pro", "Max") — his to rename.
--
-- Why a new tier key rather than a rename
-- ---------------------------------------------------------------------------
-- Eden's instinct is three paid price points. 062 gave the constraint
-- ('free','pro','max','workshop') — two paid tiers. Renaming 'pro' to mean
-- something else would silently move every account already on it, so this file
-- ADDS one neutral internal key, 'basic', and leaves 'pro' and 'max' where they
-- are. Internal keys are not customer-facing; the customer-facing name is
-- billing_plans.display_name.
--
-- ⚠ PASTE ORDER. 062 drops whatever check constraint mentions pricing_tier and
-- re-adds ('free','pro','max','workshop') — WITHOUT 'basic'. So the order is
-- 062 → 063 → 067, and 062 must never be re-pasted after 067 (it would delete
-- 'basic' from the vocabulary, and fail outright if any account is on it). This
-- file is safe to paste twice, and safe to paste whether or not 064/065/066
-- have been applied: it reads nothing they create.
--
-- No annual prices, by decision
-- ---------------------------------------------------------------------------
-- Eden once bought a $300/month discovery tool on a one-year commitment, could
-- pass the cost to clients only in the months a matter used it, and took a
-- loss. There is no annual interval anywhere in this file or in the handlers,
-- and a purchase can carry a matter's NAME onto the invoice so the document
-- supports passing that month's cost to that client.
--
-- One shared balance, and how to make it matter-locked later
-- ---------------------------------------------------------------------------
-- Credits are ONE balance per account. A pack purchase may carry a matter tag,
-- which is snapshotted onto the receipt and the ledger row for reporting and
-- for the client pass-through — but the credits themselves are not locked to
-- that matter. That is an assumption, flagged as cheap to change, and the
-- schema is shaped so changing it is data plus one overload:
--
--   usage_credit_balance and usage_credit_ledger are already keyed by
--   (user_id, scope_id). Today every row carries the sentinel scope
--   00000000-0000-0000-0000-000000000000, meaning "the account". To switch on
--   matter-locked credits: grant tagged packs into scope_id = the matterspace
--   id, add a 5-argument usage_consume(..., p_matter uuid) that draws the
--   matter scope first and the account scope second, and keep today's
--   4-argument function as a wrapper that passes null. No table is rewritten
--   and no handler that does not care about matters has to change.
--
-- Seats are NOT in scope. When they arrive they attach to serverspaces (the
-- existing team unit, serverspace_members), not to this table — a seat is a
-- membership that is billed, and billing_accounts is keyed by one user.
--
-- Verified by scripts/_verify-billing.mjs, which EXECUTES 062, 063 and this
-- file against a real Postgres (PGlite, no Docker), twice, and then tries to
-- break every guarantee written above.

-- ===========================================================================
-- 1. The tier vocabulary gains one neutral internal key.
--
-- Dropped by catalog lookup rather than by an assumed name, because prod is
-- known to drift from this folder and 001 created the constraint inline (so it
-- is system-named there) while 062 names it.
-- ===========================================================================
do $$
declare
  c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.profiles'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%pricing_tier%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.profiles
  add constraint profiles_pricing_tier_check
  check (pricing_tier in ('free', 'basic', 'pro', 'max', 'workshop'));


-- ===========================================================================
-- 2. Account-wide knobs. One row, because these are not per-plan.
-- ===========================================================================
create table if not exists public.billing_settings (
  id                         boolean primary key default true check (id),
  -- How long a past_due subscription keeps its paid allowance. Set this to at
  -- most the dunning window configured in Stripe: past the grace the meter
  -- charges the account as 'free' on its very next request, without waiting
  -- for Stripe to send another event.
  past_due_grace_days        integer not null default 7,
  -- Trials are supported and OFF. A plan row may override with its own
  -- trial_days; null there means "use this number".
  default_trial_days         integer not null default 0,
  currency                   text    not null default 'usd',
  -- Stripe issues a real invoice for a one-time credit pack only when
  -- invoice_creation is enabled on the Checkout Session. That invoice is the
  -- document a client pass-through rests on, so it defaults ON.
  pack_invoice_creation      boolean not null default true,
  allow_promotion_codes      boolean not null default true,
  billing_return_path        text    not null default '/app/settings',
  checkout_success_path      text    not null default '/app/settings?billing=success',
  checkout_cancel_path       text    not null default '/app/settings?billing=cancelled',
  note                       text    not null default '',
  updated_at                 timestamptz not null default now(),
  constraint billing_settings_sane check (
    past_due_grace_days between 0 and 180
    and default_trial_days between 0 and 365
    and length(currency) = 3
  )
);

insert into public.billing_settings (id, note)
values (true, 'PLACEHOLDER 2026-09-20 — 7-day past-due grace, no trial. Eden''s to edit.')
on conflict (id) do nothing;


-- ===========================================================================
-- 3. The plans.
--
-- `tier_key` is the value written into profiles.pricing_tier. `stripe_price_id`
-- is filled in once the Stripe account exists; until then the handlers fall
-- back to an env var (STRIPE_PRICE_BASIC / _PRO / _MAX) so Eden can choose
-- either place, and neither is a code change.
--
-- monthly_cents is for DISPLAY only. Stripe is the source of truth for what a
-- card is actually charged; this column is what the Settings page prints, and
-- if the two ever disagree the price in Stripe wins and this row is stale.
-- ===========================================================================
create table if not exists public.billing_plans (
  tier_key          text primary key,
  display_name      text    not null,
  -- Shown under the name. One short line; NOT a feature list — what each plan
  -- includes is Eden's copy to write, and this migration invents none of it.
  tagline           text    not null default '',
  monthly_cents     integer not null default 0,
  stripe_price_id   text,
  stripe_product_id text,
  -- null = fall back to billing_settings.default_trial_days.
  trial_days        integer,
  sort_order        integer not null default 0,
  -- active = offered to a buyer today. Inactive rows still resolve for an
  -- account already on them, which is how a price is retired without
  -- disturbing the people paying it.
  active            boolean not null default true,
  -- false for 'free' and 'workshop': they exist so the UI can name the plan an
  -- account is on, but nobody buys them.
  purchasable       boolean not null default true,
  note              text    not null default '',
  updated_at        timestamptz not null default now(),
  constraint billing_plans_sane check (
    monthly_cents >= 0
    and (trial_days is null or trial_days between 0 and 365)
  )
);

-- One price id maps to exactly one plan; the webhook resolves the tier from the
-- subscription's price, so an ambiguous mapping would be a silent mis-billing.
create unique index if not exists billing_plans_price_idx
  on public.billing_plans (stripe_price_id)
  where stripe_price_id is not null;

insert into public.billing_plans
  (tier_key, display_name, tagline, monthly_cents, sort_order, active, purchasable, note)
values
  ('free',     'Free',     '', 0,     0, true,  false,
   'Not sold. The plan a new account is handed.'),
  ('basic',    'Basic',    '', 4999,  1, true,  true,
   'PLACEHOLDER NAME AND PRICE 2026-09-20 — $49.99/mo, monthly only. Eden renames and reprices this row.'),
  ('pro',      'Pro',      '', 9999,  2, true,  true,
   'PLACEHOLDER NAME AND PRICE 2026-09-20 — $99.99/mo, monthly only.'),
  ('max',      'Max',      '', 19999, 3, true,  true,
   'PLACEHOLDER NAME AND PRICE 2026-09-20 — $199.99/mo, monthly only.'),
  ('workshop', 'Workshop', '', 0,     9, false, false,
   'Eden''s own account. Never billed, never demoted by this migration''s webhook.')
on conflict (tier_key) do nothing;


-- ===========================================================================
-- 4. The credit packs.
--
-- price_cents is what the card is charged; credit_cents is what lands in the
-- balance. They are two columns rather than one because the day Eden wants
-- "$500 buys $550 of usage" must be a row edit, not a deploy.
-- ===========================================================================
create table if not exists public.billing_credit_packs (
  pack_key        text primary key,
  display_name    text not null,
  price_cents     integer not null,
  credit_cents    integer not null,
  stripe_price_id text,
  sort_order      integer not null default 0,
  active          boolean not null default true,
  note            text not null default '',
  updated_at      timestamptz not null default now(),
  constraint billing_credit_packs_sane check (price_cents > 0 and credit_cents > 0)
);

create unique index if not exists billing_credit_packs_price_idx
  on public.billing_credit_packs (stripe_price_id)
  where stripe_price_id is not null;

insert into public.billing_credit_packs
  (pack_key, display_name, price_cents, credit_cents, sort_order, note)
values
  ('pack_25',  'Credit pack — $25',  2500,  2500,  1,
   'PLACEHOLDER 2026-09-20 — 1:1. Credits do not expire.'),
  ('pack_100', 'Credit pack — $100', 10000, 10000, 2,
   'PLACEHOLDER 2026-09-20 — 1:1.'),
  ('pack_500', 'Credit pack — $500', 50000, 50000, 3,
   'PLACEHOLDER 2026-09-20 — 1:1. A volume bonus is an edit to credit_cents.')
on conflict (pack_key) do nothing;


-- ===========================================================================
-- 5. The allowance row for the new tier.
--
-- 063 seeded free / pro / max / workshop. 'basic' gets the same four rows every
-- other tier has, interpolated between free and pro so the shape is consistent.
--
-- ⚠ Read this before setting the real numbers. 063's wallets were chosen before
-- any price existed: pro = $50 of allowance, max = $200. Eden's price points
-- are $99.99 and $199.99. At 'max' the allowance equals the price, which leaves
-- no margin at all, and PR #161's own note says a streamed turn is charged its
-- full output allowance, so a wallet is worth roughly a third of its face value
-- in real provider spend. Both numbers are Eden's; they live in usage_budgets,
-- not here.
-- ===========================================================================
insert into public.usage_budgets
  (pricing_tier, kind, monthly_cents, window_seconds, window_max_requests,
   max_output_tokens, max_request_bytes, note)
values
  ('basic', '*',       3000, 60,   45,   12288, 2097152,
   'PLACEHOLDER 2026-09-20 — $30/mo allowance, 45 req/min, 12K max_tokens, 2 MB body. Interpolated between 063''s free and pro; Eden sets the real number.'),
  ('basic', 'llm',     null, 60,   40,   12288, 2097152, 'PLACEHOLDER — inherits the basic wallet'),
  ('basic', 'ingest',  null, 3600, 300,  null,  null,    'PLACEHOLDER — 300 documents/hour'),
  ('basic', 'meeting', null, 60,   40,   null,  null,    'PLACEHOLDER')
on conflict (pricing_tier, kind) do nothing;


-- ===========================================================================
-- 6. billing_accounts — the Stripe side of one user.
--
-- Not on public.profiles, deliberately. 062's co-worker SELECT policy hands a
-- profiles row to everyone who shares a serverspace or a matter with you; a
-- customer id, a subscription id and a renewal date are not co-worker
-- business. Here the only SELECT policy is your own row.
--
-- last_sub_event_at is the ORDERING CLOCK. Stripe delivers webhooks at least
-- once and in no guaranteed order: an `updated` can land before the `created`
-- that preceded it, and a retry can arrive days later. State is therefore
-- derived from the event's own subscription object and its `created` stamp,
-- never from arrival order — an event older than the newest one already applied
-- is recorded and ignored, so any delivery order converges on the same answer.
-- ===========================================================================
create table if not exists public.billing_accounts (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id     text unique,
  stripe_subscription_id text,
  -- Stripe's own vocabulary, stored verbatim: trialing, active, past_due,
  -- canceled, unpaid, incomplete, incomplete_expired, paused.
  subscription_status    text,
  -- The plan this subscription maps to, resolved from its price id.
  tier_key               text,
  stripe_price_id        text,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  trial_end              timestamptz,
  -- Set when a payment fails; past it the meter treats the account as free.
  grace_until            timestamptz,
  last_invoice_status    text,
  last_invoice_id        text,
  -- Stripe event.created (unix seconds) of the newest subscription-shaped
  -- event applied to this row. 0 = nothing applied yet.
  last_sub_event_at      bigint not null default 0,
  last_event_id          text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists billing_accounts_customer_idx
  on public.billing_accounts (stripe_customer_id);


-- ===========================================================================
-- 7. billing_events — the replay guard.
--
-- Stripe guarantees at-least-once delivery, which means duplicates are normal,
-- not exceptional: a slow 200, a redeploy mid-request, a manual resend from the
-- dashboard. Without this table a resent checkout.session.completed grants the
-- credits twice.
--
-- The insert happens INSIDE the same transaction as the work it guards. A
-- separate "have I seen this?" call that returns true and is then followed by a
-- failed write would mark the event handled and lose it forever; here, if the
-- work raises, the event row rolls back with it and Stripe's retry does the
-- job.
-- ===========================================================================
create table if not exists public.billing_events (
  event_id          text primary key,
  type              text not null default '',
  -- Stripe event.created, unix seconds.
  stripe_created_at bigint,
  received_at       timestamptz not null default now(),
  outcome           jsonb not null default '{}'
);

create index if not exists billing_events_received_idx
  on public.billing_events (received_at desc);


-- ===========================================================================
-- 8. The credit balance and its ledger.
--
-- Two objects rather than one: the BALANCE is the row a request locks and
-- decrements (one row per account, so a draw is a single row lock exactly like
-- 063's wallet); the LEDGER is the append-only story of how it got that way,
-- which is what a receipt, a client pass-through and an audit all read.
--
-- scope_id is the switch described at the top of this file. Today it is always
-- the sentinel — one balance per account. It is in the primary key now so that
-- matter-locked credits are a data change later rather than a rewrite.
--
-- No foreign key on matterspace_id, on purpose: the matter's NAME is
-- snapshotted onto the row at purchase and the receipt has to survive the
-- matter being renamed, archived or deleted. A receipt that changes when a
-- folder is renamed is not a receipt.
-- ===========================================================================
create table if not exists public.usage_credit_balance (
  user_id         uuid   not null references auth.users(id) on delete cascade,
  scope_id        uuid   not null default '00000000-0000-0000-0000-000000000000',
  cents_available bigint not null default 0,
  cents_granted   bigint not null default 0,
  cents_drawn     bigint not null default 0,
  updated_at      timestamptz not null default now(),
  primary key (user_id, scope_id),
  -- The hard invariant. A draw is a conditional UPDATE, so this should never
  -- fire; it is here so that if one ever did, the transaction dies loudly
  -- instead of quietly going negative.
  constraint usage_credit_balance_nonneg check (cents_available >= 0)
);

create table if not exists public.usage_credit_ledger (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users(id) on delete cascade,
  scope_id                  uuid not null default '00000000-0000-0000-0000-000000000000',
  -- grant     = a pack was bought
  -- draw      = a request spent credits after the monthly allowance ran out
  -- reversal  = a draw corrected downward once the provider reported actuals
  -- adjustment= a manual correction by the service role (a refund, a goodwill
  --             credit). Never an edit to an existing row.
  entry_kind                text not null check (entry_kind in ('grant', 'draw', 'reversal', 'adjustment')),
  -- Signed: positive adds to the balance, negative spends it.
  delta_cents               bigint not null,
  balance_after             bigint,
  pack_key                  text,
  -- The matter tag. Reporting and the receipt only — credits are not locked to
  -- it today. No FK: see the note above.
  matterspace_id            uuid,
  matter_name               text,
  stripe_session_id         text,
  stripe_payment_intent_id  text,
  stripe_invoice_id         text,
  receipt_url               text,
  invoice_url               text,
  -- The usage_events row a draw or reversal belongs to.
  usage_event_id            uuid,
  note                      text not null default '',
  created_at                timestamptz not null default now()
);

-- The second half of the webhook's idempotency: even if the billing_events
-- guard were bypassed, one Checkout Session can grant credits exactly once.
create unique index if not exists usage_credit_ledger_grant_session_idx
  on public.usage_credit_ledger (stripe_session_id)
  where entry_kind = 'grant' and stripe_session_id is not null;

create index if not exists usage_credit_ledger_user_idx
  on public.usage_credit_ledger (user_id, created_at desc);

create index if not exists usage_credit_ledger_matter_idx
  on public.usage_credit_ledger (matterspace_id)
  where matterspace_id is not null;

-- Append-only, enforced in the database rather than by convention.
--
-- UPDATE is refused for every role including the service role: a correction is
-- a new 'reversal' or 'adjustment' row, which is the whole point of a ledger.
-- DELETE is refused for every role EXCEPT the ones that own account deletion —
-- auth.users cascades a DELETE down here when an account is removed, and a
-- ledger that makes account deletion fail is a worse bug than one that can be
-- cascaded away.
create or replace function public.usage_credit_ledger_append_only()
returns trigger
language plpgsql
security invoker
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception
      'usage_credit_ledger is append-only: write a reversal or adjustment row instead of editing %',
      old.id using errcode = '42501';
  end if;
  if tg_op = 'DELETE'
     and current_user not in ('postgres', 'supabase_admin', 'supabase_auth_admin')
  then
    raise exception
      'usage_credit_ledger is append-only: % may not delete ledger rows', current_user
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists usage_credit_ledger_append_only on public.usage_credit_ledger;
create trigger usage_credit_ledger_append_only
  before update or delete on public.usage_credit_ledger
  for each row execute function public.usage_credit_ledger_append_only();


-- ===========================================================================
-- 9. RLS.
--
-- A user READS: the plan list, the pack list, the settings row, their own
-- billing account, their own credit balance, their own ledger. A user WRITES
-- NOTHING here — no INSERT/UPDATE/DELETE policy exists on any of these tables,
-- and the privileges are revoked on top of that, so the only door is a
-- SECURITY DEFINER RPC that only the service role may call.
--
-- The policy helper is SECURITY INVOKER plpgsql that captures auth.uid() into
-- its own variable, per the standing rule in this project (migrations 022, 023,
-- 062, 063): a SECURITY DEFINER + STABLE SQL function called from a policy
-- expression sees an auth.uid() that does not match what it returns elsewhere.
-- ===========================================================================
create or replace function public._billing_is_self(p_user uuid)
returns boolean
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  return v_me is not null and v_me = p_user;
end $$;

grant execute on function public._billing_is_self(uuid) to authenticated, service_role;

alter table public.billing_settings      enable row level security;
alter table public.billing_plans         enable row level security;
alter table public.billing_credit_packs  enable row level security;
alter table public.billing_accounts      enable row level security;
alter table public.billing_events        enable row level security;
alter table public.usage_credit_balance  enable row level security;
alter table public.usage_credit_ledger   enable row level security;

drop policy if exists "Billing settings are readable by signed-in users" on public.billing_settings;
create policy "Billing settings are readable by signed-in users"
  on public.billing_settings for select to authenticated using (true);

drop policy if exists "Plans are readable by signed-in users" on public.billing_plans;
create policy "Plans are readable by signed-in users"
  on public.billing_plans for select to authenticated using (true);

drop policy if exists "Packs are readable by signed-in users" on public.billing_credit_packs;
create policy "Packs are readable by signed-in users"
  on public.billing_credit_packs for select to authenticated using (true);

drop policy if exists "Users read their own billing account" on public.billing_accounts;
create policy "Users read their own billing account"
  on public.billing_accounts for select to authenticated
  using (public._billing_is_self(user_id));

drop policy if exists "Users read their own credit balance" on public.usage_credit_balance;
create policy "Users read their own credit balance"
  on public.usage_credit_balance for select to authenticated
  using (public._billing_is_self(user_id));

drop policy if exists "Users read their own credit ledger" on public.usage_credit_ledger;
create policy "Users read their own credit ledger"
  on public.usage_credit_ledger for select to authenticated
  using (public._billing_is_self(user_id));

-- billing_events gets no policy at all: service role only, and the service role
-- bypasses RLS. Nothing a user could learn from it is theirs.

grant select on public.billing_settings, public.billing_plans,
                public.billing_credit_packs, public.billing_accounts,
                public.usage_credit_balance, public.usage_credit_ledger
  to authenticated;

-- Supabase's bootstrap sets ALTER DEFAULT PRIVILEGES so that a new table in
-- `public` is granted to service_role automatically. Stated here anyway,
-- because this file has to apply to a database that may have drifted from that
-- default, and the webhook is useless if the service role cannot write.
grant all on public.billing_settings, public.billing_plans,
              public.billing_credit_packs, public.billing_accounts,
              public.billing_events, public.usage_credit_balance,
              public.usage_credit_ledger
  to service_role;

revoke insert, update, delete on public.billing_settings     from anon, authenticated;
revoke insert, update, delete on public.billing_plans        from anon, authenticated;
revoke insert, update, delete on public.billing_credit_packs from anon, authenticated;
revoke insert, update, delete on public.billing_accounts     from anon, authenticated;
revoke insert, update, delete on public.usage_credit_balance from anon, authenticated;
revoke insert, update, delete on public.usage_credit_ledger  from anon, authenticated;
revoke all on public.billing_events                          from anon, authenticated;


-- ===========================================================================
-- 10. billing_link_customer — called by /api/billing-checkout BEFORE the
-- Checkout Session is created.
--
-- This is not bookkeeping, it is the thing that makes the webhook able to find
-- the user at all. `customer.subscription.created` routinely arrives before
-- `checkout.session.completed`, and it identifies the account only by Stripe
-- customer id. If that mapping is not already in the database when the first
-- event lands, there is nothing to resolve it against.
-- ===========================================================================
create or replace function public.billing_link_customer(
  p_user     uuid,
  p_customer text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer text := nullif(trim(coalesce(p_customer, '')), '');
begin
  if p_user is null or v_customer is null then
    return jsonb_build_object('ok', false, 'reason', 'missing_argument');
  end if;

  insert into public.billing_accounts (user_id, stripe_customer_id)
  values (p_user, v_customer)
  on conflict (user_id) do update
    set stripe_customer_id = coalesce(public.billing_accounts.stripe_customer_id, excluded.stripe_customer_id),
        updated_at         = now();

  return jsonb_build_object(
    'ok', true,
    'stripe_customer_id',
      (select stripe_customer_id from public.billing_accounts where user_id = p_user));
end $$;

revoke all on function public.billing_link_customer(uuid, text) from public, anon, authenticated;
grant execute on function public.billing_link_customer(uuid, text) to service_role;


-- ===========================================================================
-- 11. billing_apply_subscription — the webhook's one door for every
-- subscription-shaped event.
--
-- Handles checkout.session.completed (subscription mode) and
-- customer.subscription.created / updated / deleted, because all four say the
-- same thing in the end: this customer, this subscription, this status, this
-- price, this period end. Deriving the answer from the OBJECT rather than from
-- the event TYPE is what makes out-of-order delivery converge.
--
-- Tier rules, in order:
--   trialing / active                    → the plan the price maps to
--   past_due                             → keep the plan, set grace_until;
--                                          past the grace the meter charges as
--                                          free without waiting for Stripe
--   canceled / unpaid / incomplete_expired
--   / paused                             → free, immediately
--   anything else (incomplete)           → leave the tier alone
--
-- 'workshop' is NEVER written and never demoted. Eden's own account can buy a
-- subscription to test the flow end to end and this function will record every
-- Stripe field for it while leaving profiles.pricing_tier exactly as it is.
-- ===========================================================================
create or replace function public.billing_apply_subscription(
  p_event_id     text,
  p_event_type   text    default 'customer.subscription.updated',
  p_event_created bigint default 0,
  p_user         uuid    default null,
  p_customer     text    default null,
  p_subscription text    default null,
  p_status       text    default null,
  p_price_id     text    default null,
  p_period_end   bigint  default null,
  p_cancel_at_period_end boolean default false,
  p_trial_end    bigint  default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event    text := nullif(trim(coalesce(p_event_id, '')), '');
  v_customer text := nullif(trim(coalesce(p_customer, '')), '');
  v_sub      text := nullif(trim(coalesce(p_subscription, '')), '');
  v_status   text := lower(nullif(trim(coalesce(p_status, '')), ''));
  v_price    text := nullif(trim(coalesce(p_price_id, '')), '');
  v_user     uuid;
  v_acct     public.billing_accounts%rowtype;
  v_plan     public.billing_plans%rowtype;
  v_tier     text;
  v_current  text;
  v_grace    integer;
  v_grace_until timestamptz;
  v_period   timestamptz := case when p_period_end is null or p_period_end <= 0
                                 then null else to_timestamp(p_period_end) end;
  v_trial    timestamptz := case when p_trial_end is null or p_trial_end <= 0
                                 then null else to_timestamp(p_trial_end) end;
  v_created  bigint := greatest(coalesce(p_event_created, 0), 0);
  v_applied  boolean := false;
  v_result   jsonb;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'reason', 'missing_event_id');
  end if;

  -- ---- idempotency, inside this transaction -------------------------------
  insert into public.billing_events (event_id, type, stripe_created_at)
  values (v_event, coalesce(p_event_type, ''), nullif(v_created, 0))
  on conflict (event_id) do nothing;
  if not found then
    return jsonb_build_object('ok', true, 'replay', true, 'event_id', v_event);
  end if;

  -- ---- whose account ------------------------------------------------------
  v_user := p_user;
  if v_user is null and v_customer is not null then
    select b.user_id into v_user from public.billing_accounts b
     where b.stripe_customer_id = v_customer;
  end if;
  if v_user is null then
    v_result := jsonb_build_object('ok', false, 'reason', 'unknown_customer',
      'stripe_customer_id', v_customer, 'event_id', v_event);
    update public.billing_events set outcome = v_result where event_id = v_event;
    return v_result;
  end if;

  select * into v_acct from public.billing_accounts b where b.user_id = v_user;

  -- ---- the ordering guard -------------------------------------------------
  -- An event older than the newest one already applied is recorded and
  -- ignored, so any delivery order converges on the same final state. A
  -- DIFFERENT subscription id with an equal timestamp is also treated as
  -- stale: the one already applied wins, and Stripe will re-state the truth on
  -- the next event for the live subscription.
  if v_acct.user_id is not null and v_acct.stripe_subscription_id is not null then
    if v_sub is not distinct from v_acct.stripe_subscription_id then
      if v_created < v_acct.last_sub_event_at then
        v_result := jsonb_build_object('ok', true, 'stale', true, 'event_id', v_event,
          'reason', 'older_than_applied', 'applied_at', v_acct.last_sub_event_at);
        update public.billing_events set outcome = v_result where event_id = v_event;
        return v_result;
      end if;
    elsif v_created <= v_acct.last_sub_event_at then
      v_result := jsonb_build_object('ok', true, 'stale', true, 'event_id', v_event,
        'reason', 'older_subscription', 'applied_at', v_acct.last_sub_event_at);
      update public.billing_events set outcome = v_result where event_id = v_event;
      return v_result;
    end if;
  end if;

  -- ---- which plan ---------------------------------------------------------
  if v_price is not null then
    select * into v_plan from public.billing_plans p where p.stripe_price_id = v_price;
  end if;
  -- A price Stripe knows and this table does not is a configuration mistake,
  -- not a reason to guess a tier. The row is recorded; the plan is left alone.
  v_tier := v_plan.tier_key;

  select bs.past_due_grace_days into v_grace from public.billing_settings bs where bs.id;
  v_grace := coalesce(v_grace, 7);

  -- ---- the row ------------------------------------------------------------
  insert into public.billing_accounts (
    user_id, stripe_customer_id, stripe_subscription_id, subscription_status,
    tier_key, stripe_price_id, current_period_end, cancel_at_period_end,
    trial_end, last_sub_event_at, last_event_id, updated_at)
  values (
    v_user, v_customer, v_sub, v_status,
    v_tier, v_price, v_period, coalesce(p_cancel_at_period_end, false),
    v_trial, v_created, v_event, now())
  on conflict (user_id) do update set
    stripe_customer_id     = coalesce(excluded.stripe_customer_id, public.billing_accounts.stripe_customer_id),
    stripe_subscription_id = coalesce(excluded.stripe_subscription_id, public.billing_accounts.stripe_subscription_id),
    subscription_status    = coalesce(excluded.subscription_status, public.billing_accounts.subscription_status),
    tier_key               = coalesce(excluded.tier_key, public.billing_accounts.tier_key),
    stripe_price_id        = coalesce(excluded.stripe_price_id, public.billing_accounts.stripe_price_id),
    current_period_end     = coalesce(excluded.current_period_end, public.billing_accounts.current_period_end),
    cancel_at_period_end   = excluded.cancel_at_period_end,
    trial_end              = coalesce(excluded.trial_end, public.billing_accounts.trial_end),
    last_sub_event_at      = greatest(excluded.last_sub_event_at, public.billing_accounts.last_sub_event_at),
    last_event_id          = excluded.last_event_id,
    updated_at             = now();

  -- ---- grace --------------------------------------------------------------
  if v_status = 'past_due' then
    update public.billing_accounts
       set grace_until = coalesce(grace_until, now() + make_interval(days => v_grace))
     where user_id = v_user;
  elsif v_status in ('active', 'trialing') then
    update public.billing_accounts set grace_until = null where user_id = v_user;
  end if;

  -- ---- the tier -----------------------------------------------------------
  select p.pricing_tier into v_current from public.profiles p where p.id = v_user;

  if v_current = 'workshop' then
    v_result := jsonb_build_object('ok', true, 'event_id', v_event, 'user_id', v_user,
      'tier', 'workshop', 'tier_changed', false, 'reason', 'workshop_never_billed',
      'status', v_status);
  else
    if v_status in ('active', 'trialing') and v_tier is not null then
      update public.profiles set pricing_tier = v_tier where id = v_user and pricing_tier <> 'workshop';
      v_applied := true;
    elsif v_status in ('canceled', 'unpaid', 'incomplete_expired', 'paused') then
      update public.profiles set pricing_tier = 'free' where id = v_user and pricing_tier <> 'workshop';
      v_tier := 'free';
      v_applied := true;
      update public.billing_accounts set grace_until = null where user_id = v_user;
    else
      -- past_due keeps the plan (the grace window is doing the work);
      -- incomplete has not been paid yet, so nothing is granted.
      v_tier := v_current;
    end if;

    v_result := jsonb_build_object('ok', true, 'event_id', v_event, 'user_id', v_user,
      'tier', v_tier, 'tier_changed', v_applied, 'status', v_status,
      'stripe_subscription_id', v_sub);
  end if;

  update public.billing_events set outcome = v_result where event_id = v_event;
  return v_result;
end $$;

revoke all on function public.billing_apply_subscription(text, text, bigint, uuid, text, text, text, text, bigint, boolean, bigint)
  from public, anon, authenticated;
grant execute on function public.billing_apply_subscription(text, text, bigint, uuid, text, text, text, text, bigint, boolean, bigint)
  to service_role;


-- ===========================================================================
-- 12. billing_apply_invoice — invoice.paid and invoice.payment_failed.
--
-- Stripe normally follows a failed payment with a customer.subscription.updated
-- carrying status past_due, and a recovered one with another carrying active.
-- But the invoice events arrive first and sometimes alone, so they are applied
-- here too: a failure opens the grace window immediately, and a payment closes
-- it and restores the plan. That is what makes "payment_failed then paid"
-- converge no matter which of the four events actually show up.
-- ===========================================================================
create or replace function public.billing_apply_invoice(
  p_event_id      text,
  p_event_type    text   default 'invoice.paid',
  p_event_created bigint default 0,
  p_user          uuid   default null,
  p_customer      text   default null,
  p_subscription  text   default null,
  p_invoice_id    text   default null,
  p_paid          boolean default true,
  p_period_end    bigint default null,
  p_invoice_url   text   default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event    text := nullif(trim(coalesce(p_event_id, '')), '');
  v_customer text := nullif(trim(coalesce(p_customer, '')), '');
  v_user     uuid;
  v_acct     public.billing_accounts%rowtype;
  v_grace    integer;
  v_current  text;
  v_tier     text;
  v_created  bigint := greatest(coalesce(p_event_created, 0), 0);
  v_period   timestamptz := case when p_period_end is null or p_period_end <= 0
                                 then null else to_timestamp(p_period_end) end;
  v_result   jsonb;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'reason', 'missing_event_id');
  end if;

  insert into public.billing_events (event_id, type, stripe_created_at)
  values (v_event, coalesce(p_event_type, ''), nullif(v_created, 0))
  on conflict (event_id) do nothing;
  if not found then
    return jsonb_build_object('ok', true, 'replay', true, 'event_id', v_event);
  end if;

  v_user := p_user;
  if v_user is null and v_customer is not null then
    select b.user_id into v_user from public.billing_accounts b
     where b.stripe_customer_id = v_customer;
  end if;
  if v_user is null then
    v_result := jsonb_build_object('ok', false, 'reason', 'unknown_customer', 'event_id', v_event);
    update public.billing_events set outcome = v_result where event_id = v_event;
    return v_result;
  end if;

  select * into v_acct from public.billing_accounts b where b.user_id = v_user;

  -- Same ordering clock as the subscription events: an invoice event older than
  -- the newest applied state does not get to re-open a grace window that a
  -- later event already closed.
  if v_acct.user_id is not null and v_created < v_acct.last_sub_event_at then
    v_result := jsonb_build_object('ok', true, 'stale', true, 'event_id', v_event,
      'reason', 'older_than_applied');
    update public.billing_events set outcome = v_result where event_id = v_event;
    return v_result;
  end if;

  select bs.past_due_grace_days into v_grace from public.billing_settings bs where bs.id;
  v_grace := coalesce(v_grace, 7);

  insert into public.billing_accounts (
    user_id, stripe_customer_id, stripe_subscription_id, last_invoice_id,
    last_invoice_status, current_period_end, last_sub_event_at, last_event_id, updated_at)
  values (
    v_user, v_customer, nullif(trim(coalesce(p_subscription, '')), ''), nullif(trim(coalesce(p_invoice_id, '')), ''),
    case when p_paid then 'paid' else 'payment_failed' end,
    v_period, v_created, v_event, now())
  on conflict (user_id) do update set
    stripe_customer_id     = coalesce(excluded.stripe_customer_id, public.billing_accounts.stripe_customer_id),
    stripe_subscription_id = coalesce(excluded.stripe_subscription_id, public.billing_accounts.stripe_subscription_id),
    last_invoice_id        = coalesce(excluded.last_invoice_id, public.billing_accounts.last_invoice_id),
    last_invoice_status    = excluded.last_invoice_status,
    current_period_end     = coalesce(excluded.current_period_end, public.billing_accounts.current_period_end),
    last_sub_event_at      = greatest(excluded.last_sub_event_at, public.billing_accounts.last_sub_event_at),
    last_event_id          = excluded.last_event_id,
    updated_at             = now();

  select p.pricing_tier into v_current from public.profiles p where p.id = v_user;
  select b.tier_key into v_tier from public.billing_accounts b where b.user_id = v_user;

  if p_paid then
    update public.billing_accounts
       set grace_until         = null,
           subscription_status = case when subscription_status in ('past_due', 'unpaid')
                                      then 'active' else subscription_status end
     where user_id = v_user;
    -- A recovered payment restores the plan the subscription is for, unless
    -- this is Eden's workshop account, which is never written.
    if v_tier is not null and v_current is distinct from 'workshop' then
      update public.profiles set pricing_tier = v_tier where id = v_user and pricing_tier <> 'workshop';
    end if;
  else
    update public.billing_accounts
       set grace_until         = coalesce(grace_until, now() + make_interval(days => v_grace)),
           subscription_status = case when subscription_status in ('canceled', 'unpaid')
                                      then subscription_status else 'past_due' end
     where user_id = v_user;
  end if;

  v_result := jsonb_build_object('ok', true, 'event_id', v_event, 'user_id', v_user,
    'paid', p_paid, 'invoice_url', p_invoice_url,
    'tier', coalesce((select pricing_tier from public.profiles where id = v_user), 'free'));
  update public.billing_events set outcome = v_result where event_id = v_event;
  return v_result;
end $$;

revoke all on function public.billing_apply_invoice(text, text, bigint, uuid, text, text, text, boolean, bigint, text)
  from public, anon, authenticated;
grant execute on function public.billing_apply_invoice(text, text, bigint, uuid, text, text, text, boolean, bigint, text)
  to service_role;


-- ===========================================================================
-- 13. usage_credits_grant — a pack purchase lands in the balance.
--
-- Three separate reasons this cannot double-grant: the billing_events insert at
-- the top of this function, the unique index on (stripe_session_id) for grant
-- rows, and the explicit check below that returns the existing grant rather
-- than raising. Stripe resends events; a receipt that says $100 twice is a
-- refund request and a lost customer.
--
-- The matter tag is a SNAPSHOT. The name that was on the invoice is the name
-- that stays on the ledger row, because the invoice is the document a client
-- pass-through rests on and it cannot change when a folder is renamed. Whether
-- the buyer may actually see that matter was checked with the buyer's OWN token
-- before the Checkout Session was created — by the time this runs, the money
-- has moved and refusing would be the wrong answer.
-- ===========================================================================
create or replace function public.usage_credits_grant(
  p_event_id       text,
  p_user           uuid,
  p_credit_cents   bigint,
  p_pack_key       text    default null,
  p_matter_id      uuid    default null,
  p_matter_name    text    default null,
  p_session_id     text    default null,
  p_payment_intent text    default null,
  p_invoice_id     text    default null,
  p_receipt_url    text    default null,
  p_invoice_url    text    default null,
  p_event_type     text    default 'checkout.session.completed',
  p_event_created  bigint  default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scope    constant uuid := '00000000-0000-0000-0000-000000000000';
  v_event    text   := nullif(trim(coalesce(p_event_id, '')), '');
  v_session  text   := nullif(trim(coalesce(p_session_id, '')), '');
  v_cents    bigint := least(greatest(coalesce(p_credit_cents, 0), 0), 100000000);
  v_existing public.usage_credit_ledger%rowtype;
  v_balance  bigint;
  v_id       uuid;
  v_result   jsonb;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'reason', 'missing_event_id');
  end if;

  insert into public.billing_events (event_id, type, stripe_created_at)
  values (v_event, coalesce(p_event_type, ''), nullif(greatest(coalesce(p_event_created, 0), 0), 0))
  on conflict (event_id) do nothing;
  if not found then
    return jsonb_build_object('ok', true, 'replay', true, 'event_id', v_event);
  end if;

  if p_user is null then
    v_result := jsonb_build_object('ok', false, 'reason', 'unknown_user', 'event_id', v_event);
    update public.billing_events set outcome = v_result where event_id = v_event;
    return v_result;
  end if;
  if v_cents <= 0 then
    v_result := jsonb_build_object('ok', false, 'reason', 'nothing_to_grant', 'event_id', v_event);
    update public.billing_events set outcome = v_result where event_id = v_event;
    return v_result;
  end if;

  -- The same session arriving under a different event id (a resend that Stripe
  -- re-stamped, a manual replay) still grants once.
  if v_session is not null then
    select * into v_existing from public.usage_credit_ledger l
     where l.entry_kind = 'grant' and l.stripe_session_id = v_session;
    if found then
      v_result := jsonb_build_object('ok', true, 'replay', true, 'reason', 'session_already_granted',
        'event_id', v_event, 'ledger_id', v_existing.id,
        'credit_cents', v_existing.delta_cents);
      update public.billing_events set outcome = v_result where event_id = v_event;
      return v_result;
    end if;
  end if;

  insert into public.usage_credit_balance (user_id, scope_id, cents_available, cents_granted)
  values (p_user, v_scope, v_cents, v_cents)
  on conflict (user_id, scope_id) do update
    set cents_available = public.usage_credit_balance.cents_available + excluded.cents_available,
        cents_granted   = public.usage_credit_balance.cents_granted + excluded.cents_granted,
        updated_at      = now()
  returning cents_available into v_balance;

  insert into public.usage_credit_ledger (
    user_id, scope_id, entry_kind, delta_cents, balance_after, pack_key,
    matterspace_id, matter_name, stripe_session_id, stripe_payment_intent_id,
    stripe_invoice_id, receipt_url, invoice_url, note)
  values (
    p_user, v_scope, 'grant', v_cents, v_balance, nullif(trim(coalesce(p_pack_key, '')), ''),
    p_matter_id, nullif(trim(coalesce(p_matter_name, '')), ''), v_session,
    nullif(trim(coalesce(p_payment_intent, '')), ''), nullif(trim(coalesce(p_invoice_id, '')), ''),
    nullif(trim(coalesce(p_receipt_url, '')), ''), nullif(trim(coalesce(p_invoice_url, '')), ''),
    'Credit pack purchase')
  returning id into v_id;

  v_result := jsonb_build_object('ok', true, 'event_id', v_event, 'user_id', p_user,
    'credit_cents', v_cents, 'balance_cents', v_balance, 'ledger_id', v_id,
    'matter_name', p_matter_name);
  update public.billing_events set outcome = v_result where event_id = v_event;
  return v_result;
end $$;

revoke all on function public.usage_credits_grant(text, uuid, bigint, text, uuid, text, text, text, text, text, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.usage_credits_grant(text, uuid, bigint, text, uuid, text, text, text, text, text, text, text, bigint)
  to service_role;


-- ===========================================================================
-- 14. usage_consume — REPLACED, same four arguments.
--
-- PR #161's handlers call public.usage_consume(p_user, p_kind,
-- p_cents_estimate, p_window_key) and read the same jsonb back. That contract
-- does not change: the signature is identical, every field 063 returned is
-- still returned, and a request that 063 would have admitted is still admitted
-- for the same reason. What is new is what happens at the edge of the wallet.
--
-- The draw order
-- ---------------------------------------------------------------------------
--   1. the rate window          — unchanged
--   2. the per-kind sub-cap     — moved AHEAD of the wallet write, so that a
--                                 sub-cap refusal has nothing to refund. It
--                                 reads the same sum of usage_events it always
--                                 did, which never included the current
--                                 request, so the answer is identical.
--   3. the monthly wallet       — charged first, for as much as fits
--   4. the credit balance       — charged for the remainder, if any
--
-- A request that straddles the boundary is SPLIT: 10c of wallet headroom and a
-- 40c request means 10c to the wallet and 30c to credits, both inside one
-- transaction. If the credits cannot cover the remainder, the wallet portion is
-- refunded too and the whole request is refused — the account is never left
-- having paid for half a call.
--
-- Atomicity is the same mechanism 063 used and for the same reason: every
-- counter is moved with a single statement that takes that row's lock
-- (INSERT … ON CONFLICT DO UPDATE for the wallet, a conditional UPDATE for the
-- balance), so two requests arriving together serialise and the second sees the
-- first. The credit draw's `where cents_available >= v_need` is what makes an
-- overdraw impossible rather than merely unlikely: the losing request updates
-- no row, finds nothing, refunds and refuses.
--
-- Past-due grace
-- ---------------------------------------------------------------------------
-- A subscription whose payment failed keeps its allowance until
-- billing_settings.past_due_grace_days has run out. Past that the METER charges
-- the account as 'free' on its very next request, without waiting for Stripe to
-- send another event. profiles.pricing_tier still says the paid tier until a
-- Stripe event demotes it — feature gating and metering therefore disagree for
-- that window, deliberately: the cheap half fails closed, the visible half
-- waits for the payment processor to be sure.
-- ===========================================================================
create or replace function public.usage_consume(
  p_user           uuid    default null,
  p_kind           text    default 'llm',
  p_cents_estimate integer default 0,
  p_window_key     text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scope     constant uuid := '00000000-0000-0000-0000-000000000000';
  v_user        uuid;
  v_kind        text := coalesce(nullif(trim(p_kind), ''), 'llm');
  v_cents       integer := least(greatest(coalesce(p_cents_estimate, 0), 0), 1000000);
  v_tier        text;
  v_billing     text := null;
  v_month       text := to_char(now() at time zone 'utc', 'YYYY-MM');
  v_row         public.usage_budgets%rowtype;
  v_star        public.usage_budgets%rowtype;
  v_win_secs    integer;
  v_win_max     integer;
  v_wallet      integer;
  v_sub_cap     integer;
  v_max_tokens  integer;
  v_max_bytes   integer;
  v_window_key  text;
  v_window_reqs integer;
  v_spent       bigint;
  v_prior       bigint;
  v_fits        integer := 0;
  v_need        integer := 0;
  v_credit_left bigint := 0;
  v_credit_have bigint := 0;
  v_event       uuid;
  v_grace_until timestamptz;
  v_status      text;
begin
  v_user := coalesce(auth.uid(), p_user);
  if v_user is null then
    return jsonb_build_object(
      'allowed', false, 'reason', 'unauthenticated', 'status', 401,
      'message', 'Sign in to use this feature.');
  end if;

  select p.pricing_tier into v_tier from public.profiles p where p.id = v_user;
  v_tier := coalesce(nullif(trim(v_tier), ''), 'free');

  -- Past-due past its grace meters as free. 'workshop' is never demoted.
  if v_tier <> 'workshop' then
    select b.grace_until, b.subscription_status into v_grace_until, v_status
      from public.billing_accounts b where b.user_id = v_user;
    if v_grace_until is not null and v_grace_until < now()
       and coalesce(v_status, '') in ('past_due', 'unpaid', 'incomplete')
    then
      v_billing := 'past_due_grace_expired';
      v_tier := 'free';
    end if;
  end if;

  select * into v_star from public.usage_budgets
   where pricing_tier = v_tier and kind = '*';
  if not found then
    select * into v_star from public.usage_budgets
     where pricing_tier = 'free' and kind = '*';
  end if;
  select * into v_row from public.usage_budgets
   where pricing_tier = v_tier and kind = v_kind;

  if v_star.pricing_tier is null and v_row.pricing_tier is null then
    return jsonb_build_object(
      'allowed', true, 'reason', 'unconfigured', 'status', 200,
      'tier', v_tier, 'kind', v_kind, 'month_key', v_month);
  end if;

  v_wallet     := v_star.monthly_cents;
  v_sub_cap    := v_row.monthly_cents;
  v_win_secs   := coalesce(v_row.window_seconds, v_star.window_seconds, 60);
  v_win_max    := coalesce(v_row.window_max_requests, v_star.window_max_requests);
  v_max_tokens := coalesce(v_row.max_output_tokens, v_star.max_output_tokens);
  v_max_bytes  := coalesce(v_row.max_request_bytes, v_star.max_request_bytes);

  delete from public.usage_windows w
   where w.user_id = v_user and w.expires_at < now() - interval '1 hour';

  -- ---- the rate window -----------------------------------------------------
  v_window_key := coalesce(nullif(trim(coalesce(p_window_key, '')), ''),
    to_char(
      to_timestamp(floor(extract(epoch from now()) / v_win_secs) * v_win_secs)
        at time zone 'utc',
      'YYYYMMDD"T"HH24MISS'));

  if v_win_max is not null then
    insert into public.usage_windows (user_id, kind, window_key, requests, expires_at)
    values (v_user, v_kind, v_window_key, 1, now() + make_interval(secs => v_win_secs * 2))
    on conflict (user_id, kind, window_key) do update
      set requests = public.usage_windows.requests + 1
    returning requests into v_window_reqs;

    if v_window_reqs > v_win_max then
      return jsonb_build_object(
        'allowed', false, 'reason', 'over_rate_limit', 'status', 429,
        'message', 'Too many requests in a row. Give it a moment and try again.',
        'tier', v_tier, 'kind', v_kind, 'window_key', v_window_key,
        'window_seconds', v_win_secs, 'window_max_requests', v_win_max,
        'window_requests', v_window_reqs, 'retry_after_seconds', v_win_secs,
        'max_output_tokens', v_max_tokens, 'max_request_bytes', v_max_bytes,
        'billing_state', v_billing);
    end if;
  end if;

  -- ---- the per-kind sub-cap, before anything is charged ---------------------
  if v_sub_cap is not null then
    select coalesce(sum(e.cents_estimated), 0) into v_spent
      from public.usage_events e
     where e.user_id = v_user and e.month_key = v_month and e.kind = v_kind;
    if v_spent + v_cents > v_sub_cap then
      return jsonb_build_object(
        'allowed', false, 'reason', 'over_kind_budget', 'status', 402,
        'message',
          'You have reached this month''s included usage for this feature. It resets at '
          || 'the start of next month.',
        'tier', v_tier, 'kind', v_kind, 'month_key', v_month,
        'monthly_cents', v_sub_cap, 'month_cents_used', v_spent,
        'max_output_tokens', v_max_tokens, 'max_request_bytes', v_max_bytes,
        'billing_state', v_billing);
    end if;
  end if;

  -- ---- the wallet, then the credits ----------------------------------------
  insert into public.usage_month (user_id, month_key, cents_charged, requests)
  values (v_user, v_month, v_cents, 1)
  on conflict (user_id, month_key) do update
    set cents_charged = public.usage_month.cents_charged + excluded.cents_charged,
        requests      = public.usage_month.requests + 1,
        updated_at    = now()
  returning cents_charged into v_spent;

  if v_wallet is not null then
    v_prior := v_spent - v_cents;
    v_fits  := greatest(least(v_cents, (v_wallet - v_prior)::bigint), 0)::integer;
    v_need  := v_cents - v_fits;

    if v_need > 0 then
      -- Take the overflow back out of the wallet; the wallet must never record
      -- money it did not absorb.
      update public.usage_month
         set cents_charged = cents_charged - v_need, updated_at = now()
       where user_id = v_user and month_key = v_month;

      -- One conditional UPDATE. The row lock serialises concurrent draws, and
      -- the predicate is what refuses the one that would overdraw.
      update public.usage_credit_balance
         set cents_available = cents_available - v_need,
             cents_drawn     = cents_drawn + v_need,
             updated_at      = now()
       where user_id = v_user and scope_id = v_scope and cents_available >= v_need
      returning cents_available into v_credit_left;

      if not found then
        -- Allowance and credits both exhausted: refund the wallet portion too,
        -- so the account has not paid for half a call, and refuse.
        update public.usage_month
           set cents_charged = cents_charged - v_fits,
               requests      = greatest(requests - 1, 0),
               updated_at    = now()
         where user_id = v_user and month_key = v_month;

        select coalesce(b.cents_available, 0) into v_credit_have
          from public.usage_credit_balance b
         where b.user_id = v_user and b.scope_id = v_scope;
        v_credit_have := coalesce(v_credit_have, 0);

        return jsonb_build_object(
          'allowed', false, 'reason', 'over_monthly_budget', 'status', 402,
          -- The reason string is unchanged so every handler and test written
          -- against #161 keeps working; `detail` is what distinguishes the two
          -- states, and the message is what a person actually reads.
          'detail', 'allowance_and_credits_exhausted',
          'message',
            'You have used this month''s included AI usage and your usage credits are '
            || 'spent. Buy a credit pack in Settings → Billing to continue now, or wait '
            || 'for the allowance to reset at the start of next month.',
          'tier', v_tier, 'kind', v_kind, 'month_key', v_month,
          'monthly_cents', v_wallet, 'month_cents_used', v_prior,
          'remaining_cents', greatest(v_wallet - v_prior, 0),
          'credit_cents_remaining', v_credit_have,
          'max_output_tokens', v_max_tokens, 'max_request_bytes', v_max_bytes,
          'billing_state', v_billing);
      end if;

    end if;
  end if;

  insert into public.usage_events (user_id, kind, month_key, pricing_tier, cents_estimated, meta)
  values (v_user, v_kind, v_month, v_tier, v_cents,
          jsonb_build_object('wallet_cents', v_fits, 'credit_cents', v_need))
  returning id into v_event;

  -- The draw row is written AFTER the event it paid for, so it can carry that
  -- event's id. The ledger is append-only, so it cannot be written first and
  -- back-filled later — the order is the only way to tie the two together.
  if v_need > 0 then
    insert into public.usage_credit_ledger (
      user_id, scope_id, entry_kind, delta_cents, balance_after, usage_event_id, note)
    values (v_user, v_scope, 'draw', -v_need, v_credit_left, v_event,
            'Usage beyond the monthly allowance (' || v_kind || ')');
  end if;

  select cents_charged into v_spent
    from public.usage_month where user_id = v_user and month_key = v_month;

  if v_need > 0 then
    return jsonb_build_object(
      'allowed', true, 'reason', 'ok_on_credits', 'status', 200,
      'message',
        'This month''s included AI usage is spent, so this is being charged to your '
        || 'usage credits.',
      'event_id', v_event, 'tier', v_tier, 'kind', v_kind, 'month_key', v_month,
      'monthly_cents', v_wallet, 'month_cents_used', v_spent,
      'remaining_cents', 0,
      'wallet_cents_charged', v_fits, 'credit_cents_charged', v_need,
      'credit_cents_remaining', v_credit_left,
      'window_key', v_window_key, 'window_seconds', v_win_secs,
      'window_max_requests', v_win_max, 'window_requests', v_window_reqs,
      'max_output_tokens', v_max_tokens, 'max_request_bytes', v_max_bytes,
      'billing_state', v_billing);
  end if;

  select coalesce(b.cents_available, 0) into v_credit_have
    from public.usage_credit_balance b
   where b.user_id = v_user and b.scope_id = v_scope;

  return jsonb_build_object(
    'allowed', true, 'reason', 'ok', 'status', 200,
    'event_id', v_event, 'tier', v_tier, 'kind', v_kind, 'month_key', v_month,
    'monthly_cents', v_wallet, 'month_cents_used', v_spent,
    'remaining_cents', case when v_wallet is null then null
                            else greatest(v_wallet - v_spent, 0) end,
    'wallet_cents_charged', v_fits, 'credit_cents_charged', 0,
    'credit_cents_remaining', coalesce(v_credit_have, 0),
    'window_key', v_window_key, 'window_seconds', v_win_secs,
    'window_max_requests', v_win_max, 'window_requests', v_window_reqs,
    'max_output_tokens', v_max_tokens, 'max_request_bytes', v_max_bytes,
    'billing_state', v_billing);
end $$;

revoke all on function public.usage_consume(uuid, text, integer, text) from public, anon;
grant execute on function public.usage_consume(uuid, text, integer, text)
  to authenticated, service_role;


-- ===========================================================================
-- 15. usage_record_actual — REPLACED, same four arguments, now credit-aware.
--
-- Why it had to change. 063 subtracts the whole correction from
-- usage_month.cents_charged. After a split that is simply wrong: a request that
-- took 10c of wallet and 30c of credits, reconciled from 40c down to 5c, would
-- have 35c removed from a wallet that only ever held 10c — the wallet goes
-- negative-ish (it is floored at 0, so the account silently gains 25c of
-- allowance) and the 30c of CREDITS the customer paid for is never returned.
--
-- Streamed turns are charged their full output allowance and reconciled
-- downward afterwards, so this is not an edge case: it is the ordinary path for
-- anyone spending credits.
--
-- The rule: a refund goes to CREDITS first, up to what this request drew from
-- them, and the remainder to the wallet. A correction UPWARD goes to the wallet
-- (which may push the month past its budget — the next request is then refused,
-- which is the honest outcome and what 063 already did). The ledger gets a
-- 'reversal' row; nothing is ever edited.
-- ===========================================================================
create or replace function public.usage_record_actual(
  p_event_id     uuid,
  p_cents_actual integer,
  p_model        text  default null,
  p_meta         jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scope    constant uuid := '00000000-0000-0000-0000-000000000000';
  v_actual   integer := least(greatest(coalesce(p_cents_actual, 0), 0), 1000000);
  v_ev       public.usage_events%rowtype;
  v_delta    integer;
  v_refund   integer;
  v_credit   integer;
  v_to_cred  integer := 0;
  v_to_wall  integer;
  v_balance  bigint;
begin
  update public.usage_events
     set cents_actual = v_actual,
         model        = coalesce(p_model, model),
         meta         = meta || coalesce(p_meta, '{}'::jsonb)
   where id = p_event_id
     and cents_actual is null
  returning * into v_ev;

  if v_ev.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found_or_already_recorded');
  end if;

  v_delta  := v_actual - v_ev.cents_estimated;
  v_credit := greatest(coalesce((v_ev.meta ->> 'credit_cents')::integer, 0), 0);

  if v_delta < 0 then
    v_refund  := -v_delta;
    v_to_cred := least(v_refund, v_credit);
    v_to_wall := v_refund - v_to_cred;

    if v_to_cred > 0 then
      update public.usage_credit_balance
         set cents_available = cents_available + v_to_cred,
             cents_drawn     = greatest(cents_drawn - v_to_cred, 0),
             updated_at      = now()
       where user_id = v_ev.user_id and scope_id = v_scope
      returning cents_available into v_balance;

      insert into public.usage_credit_ledger (
        user_id, scope_id, entry_kind, delta_cents, balance_after, usage_event_id, note)
      values (v_ev.user_id, v_scope, 'reversal', v_to_cred, v_balance, v_ev.id,
              'Estimate corrected down to the provider''s actual');
    end if;

    if v_to_wall > 0 then
      update public.usage_month
         set cents_charged = greatest(cents_charged - v_to_wall, 0),
             updated_at    = now()
       where user_id = v_ev.user_id and month_key = v_ev.month_key;
    end if;
  elsif v_delta > 0 then
    update public.usage_month
       set cents_charged = cents_charged + v_delta,
           updated_at    = now()
     where user_id = v_ev.user_id and month_key = v_ev.month_key;
  end if;

  -- Keep the event's own split honest, so a second reader (or a later
  -- reconciliation that this function refuses anyway) is never misled.
  update public.usage_events
     set meta = meta || jsonb_build_object(
                  'credit_cents', greatest(v_credit - v_to_cred, 0),
                  'wallet_cents', greatest(v_actual - greatest(v_credit - v_to_cred, 0), 0))
   where id = v_ev.id;

  return jsonb_build_object('ok', true, 'delta_cents', v_delta,
    'credit_cents_refunded', v_to_cred);
end $$;

revoke all on function public.usage_record_actual(uuid, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.usage_record_actual(uuid, integer, text, jsonb)
  to service_role;


-- ===========================================================================
-- 16. A reporting view: what an account has bought, with its matter tag.
--
-- security_invoker so it obeys the querying user's RLS on the ledger rather
-- than the view owner's. Without it a view over a ledger is a cross-tenant
-- read of everybody's purchases.
-- ===========================================================================
drop view if exists public.usage_credit_purchases;
create view public.usage_credit_purchases
  with (security_invoker = true)
as
  select
    l.id,
    l.user_id,
    l.created_at,
    l.pack_key,
    l.delta_cents      as credit_cents,
    l.matterspace_id,
    l.matter_name,
    l.stripe_session_id,
    l.stripe_invoice_id,
    coalesce(l.invoice_url, l.receipt_url) as document_url
  from public.usage_credit_ledger l
 where l.entry_kind = 'grant';

grant select on public.usage_credit_purchases to authenticated, service_role;


-- Drop PostgREST's cached prepared statements so the new tables, policies and
-- functions take effect on the next request.
notify pgrst, 'reload schema';
