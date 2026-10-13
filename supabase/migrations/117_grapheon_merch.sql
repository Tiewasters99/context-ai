-- Grapheon Reader, Phase 2b: merchandise (docs/specs/GRAPHEON-READER-2026-10-10.md,
-- "Merchandise (Phase 2b)"; decisions D8–D12 taken 2026-10-13).
--
-- A reader takes a picture from the bench — a public-domain plate snipped
-- from the page, or a still they brought in themselves — and buys it on a
-- tee, a tote or a print. Three tables:
--
--   merch_blueprints  the curated products (Printify blueprint + provider,
--                     flat US shipping, an estimate for "from $X"). Eden
--                     edits these rows by hand; no deploy needed.
--   merch_products    one row per product made at Printify from a bench
--                     picture: its variants with cost and price, its mockups.
--   merch_orders      one row per purchase: Stripe session, Printify order,
--                     status. The shipping address stays in Stripe and
--                     Printify, never here.
--
-- Writes are the service role's alone (api/merch.mjs makes products and
-- opens Checkout; api/grapheon-webhook.mjs records the payment and places
-- the Printify order). Readers see the blueprints, their own products and
-- their own orders. Policies compare auth.uid() directly; no cross-table
-- membership checks here, so no SECURITY DEFINER wrappers are involved.
--
-- D11: a publisher's illustration in a bought edition is not offered at all
-- in 2b. `editions.merch_allowed` is added here, false everywhere, so the
-- gate exists before the agreement path (Phase 4) ever turns it on.
--
-- NUMBERING: 117 was the next free number on 2026-10-13 after `git fetch`
-- and `gh pr list` (main ends at 114; open PRs hold 046, 082, 115 and 116).
-- Check again on the day this is applied, and ask Eden before applying.

-- ============================================================================
-- editions.merch_allowed (D11)
-- ============================================================================

alter table public.editions
  add column if not exists merch_allowed boolean not null default false;

comment on column public.editions.merch_allowed is
  'Grapheon Reader: may readers put this edition''s own (in-copyright) illustrations on merchandise? False until the publisher turns it on AND a merch agreement with Grapheon.ai LLC fixing the publisher''s share is on file (Phase 4). Public-domain plates never need it.';

-- ============================================================================
-- merch_blueprints — the curated products
-- ============================================================================

create table if not exists public.merch_blueprints (
  -- 'tee', 'tote', 'print': what the sheet calls it and what api/merch.mjs is asked for.
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  kind text not null check (kind in ('tee', 'tote', 'print', 'mug')),
  label text not null,
  -- Printify catalog ids: the blueprint and the print provider that makes it.
  blueprint_id integer not null,
  provider_id integer not null,
  -- The print area the picture goes on.
  position text not null default 'front',
  -- How much of the print area the picture fills by default (Printify scale, 0–1).
  default_scale numeric(4,3) not null default 0.850 check (default_scale > 0 and default_scale <= 1),
  -- "from $X" before the product is made (the real cost comes back with the product).
  estimate_cents integer check (estimate_cents >= 0),
  -- D9: shipping is its own flat line. US first; the provider's first-item
  -- and additional-item rates from its shipping profile.
  shipping_first_cents integer not null check (shipping_first_cents >= 0),
  shipping_additional_cents integer not null default 0 check (shipping_additional_cents >= 0),
  -- Where Checkout may ship to. US only in 2b.
  countries text[] not null default '{US}',
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.merch_blueprints is
  'Grapheon Reader merch: the curated products (Printify blueprint + provider, flat shipping). Edited by hand; readers see enabled rows.';

-- D8: tee, tote, print. Printify Choice (provider 99) for all three: it
-- carries every colour and size of the crew tee and ships in the US.
-- Costs and shipping from the catalog on 2026-10-13.
insert into public.merch_blueprints
  (key, kind, label, blueprint_id, provider_id, position, default_scale, estimate_cents, shipping_first_cents, shipping_additional_cents, sort_order)
values
  ('tee',   'tee',   'Unisex cotton tee',        5,   99, 'front', 0.850, 2799, 495, 240, 1),
  ('tote',  'tote',  'Organic canvas tote',      609, 99, 'front', 0.850, 2499, 495, 240, 2),
  ('print', 'print', 'Fine art print, matte',    804, 99, 'front', 1.000, 2999, 789, 300, 3)
on conflict (key) do nothing;

-- ============================================================================
-- merch_products — a product made from a bench picture
-- ============================================================================

create table if not exists public.merch_products (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  -- Where the picture came from: a Library book in Contextspaces, or an edition.
  source_kind text not null check (source_kind in ('document', 'edition')),
  source_id uuid not null,
  -- The bench item (document_workshop_items or edition_bench_items) it was made from.
  bench_item_id uuid,
  blueprint_key text not null references public.merch_blueprints(key) on delete restrict,
  title text not null,
  -- The picture as sent to Printify: a public URL under cover-images/<owner>/prints/.
  image_url text not null,
  printify_image_id text,
  printify_product_id text unique,
  -- Printify's option lists for the product (colours with their hex, sizes).
  options jsonb not null default '[]'::jsonb,
  -- [{ id, title, color, size, cost_cents, price_cents, available }]: the price is
  -- D9 (cost + 40%, to .99) and is what Checkout charges.
  variants jsonb not null default '[]'::jsonb,
  -- [{ src, variant_ids, position, is_default }] once Printify has drawn them.
  mockups jsonb not null default '[]'::jsonb,
  -- { scale, fill } as sent.
  placement jsonb not null default '{}'::jsonb,
  status text not null default 'rendering' check (status in ('rendering', 'ready', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.merch_products is
  'Grapheon Reader merch: a Printify product made from a bench picture, with its priced variants and mockups. Written by api/merch.mjs (service role); the owner reads it.';

create index if not exists merch_products_owner_idx on public.merch_products (owner_user_id, created_at desc);
create index if not exists merch_products_source_idx on public.merch_products (source_kind, source_id, bench_item_id);

-- ============================================================================
-- merch_orders — a purchase
-- ============================================================================

create table if not exists public.merch_orders (
  id uuid primary key default gen_random_uuid(),
  buyer_user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.merch_products(id) on delete restrict,
  variant_id integer not null,
  variant_title text,
  quantity integer not null check (quantity between 1 and 10),
  currency text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  item_cents integer not null check (item_cents >= 0),
  shipping_cents integer not null check (shipping_cents >= 0),
  tax_cents integer not null default 0 check (tax_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  stripe_session_id text unique,
  stripe_payment_intent text,
  -- The buyer's email as Stripe collected it; the address stays in Stripe and Printify.
  email text,
  printify_order_id text unique,
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'placed', 'in_production', 'shipped', 'delivered', 'canceled', 'refunded', 'failed')),
  -- The webhook's claim while it places the Printify order (so a retried
  -- event cannot place it twice); cleared on failure so a retry may try again.
  placing_at timestamptz,
  placed_at timestamptz,
  sent_to_production_at timestamptz,
  shipped_at timestamptz,
  -- [{ carrier, number, url }] from Printify.
  tracking jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.merch_orders is
  'Grapheon Reader merch: one purchase — Stripe Checkout session, Printify order, status. Written by api/merch.mjs and api/grapheon-webhook.mjs (service role); the buyer reads it.';

create index if not exists merch_orders_buyer_idx on public.merch_orders (buyer_user_id, created_at desc);
create index if not exists merch_orders_status_idx on public.merch_orders (status, updated_at);

-- ============================================================================
-- updated_at, kept by the schema's own trigger function (001)
-- ============================================================================

drop trigger if exists update_merch_blueprints_updated_at on public.merch_blueprints;
create trigger update_merch_blueprints_updated_at
  before update on public.merch_blueprints
  for each row execute function public.update_updated_at();

drop trigger if exists update_merch_products_updated_at on public.merch_products;
create trigger update_merch_products_updated_at
  before update on public.merch_products
  for each row execute function public.update_updated_at();

drop trigger if exists update_merch_orders_updated_at on public.merch_orders;
create trigger update_merch_orders_updated_at
  before update on public.merch_orders
  for each row execute function public.update_updated_at();

-- ============================================================================
-- RLS: readers see the catalogue, their products, their orders. No client writes.
-- ============================================================================

alter table public.merch_blueprints enable row level security;
alter table public.merch_products enable row level security;
alter table public.merch_orders enable row level security;

drop policy if exists merch_blueprints_read on public.merch_blueprints;
create policy merch_blueprints_read on public.merch_blueprints
  for select to authenticated using (enabled);

drop policy if exists merch_products_owner_read on public.merch_products;
create policy merch_products_owner_read on public.merch_products
  for select to authenticated using (owner_user_id = auth.uid());

drop policy if exists merch_orders_buyer_read on public.merch_orders;
create policy merch_orders_buyer_read on public.merch_orders
  for select to authenticated using (buyer_user_id = auth.uid());

grant select on public.merch_blueprints to authenticated;
grant select on public.merch_products to authenticated;
grant select on public.merch_orders to authenticated;
grant all on public.merch_blueprints, public.merch_products, public.merch_orders to service_role;
