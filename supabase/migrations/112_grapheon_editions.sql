-- Grapheon Reader, Phase 1 step 2: the editions (docs/specs/GRAPHEON-READER-2026-10-10.md, "The edition").
--
-- An edition is the working object and the sold object: a draft while its
-- maker benches it, a frozen version once published; buyers get later
-- versions free. These tables are the Reader's own, outside the matter
-- world: no matterspace, no serverspace, no Vault. The bench tables mirror
-- the Contextspaces ones (106 document_workshop_items, 062 document_animations)
-- keyed by edition instead of document, so the same WorkshopPanel and
-- AnimationLayer speak to either through PdfBook's BenchStore.
--
-- Access, in one paragraph. An edition row is public once published and the
-- publisher's always. The bench and a draft's illustrations are the
-- publisher's alone. Files live in the private `editions` bucket under
-- <edition_id>/<file>; the publisher writes there, nobody reads there
-- directly — api/editions.mjs serves short-lived signed URLs after the
-- ownership check below (a free edition needs sign-in, not a purchase).
-- Marks and progress are the reader's own. Purchases are written only by the
-- Stripe webhook (service role). Policy expressions call SECURITY INVOKER
-- plpgsql wrappers that capture auth.uid() first (the standing rule, 022).
--
-- NUMBERING: 112 was the next free number on 2026-10-12 after `git fetch`
-- and `gh pr list` (main ends at 111; open PRs hold 046 and 082). Check
-- again on the day this is applied, and ask Eden before applying.

-- ============================================================================
-- editions
-- ============================================================================

create table if not exists public.editions (
  id uuid primary key default gen_random_uuid(),
  -- The store address: read.grapheon.ai/<slug>. Lower-case words and digits
  -- joined by single hyphens.
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 80),
  title text not null check (length(title) between 1 and 200),
  author text,
  description text,
  -- The cover's object in the editions bucket (an edition_assets row of kind
  -- 'cover' points at the same path); null until one is set.
  cover_path text,
  -- Who is making, or has published, it. Grapheon's own user for the library.
  publisher_user_id uuid not null references auth.users(id) on delete restrict,
  -- The Contextspaces document it was bridged from, if any. Usually null.
  source_document_id uuid references public.documents(id) on delete set null,
  price_cents integer not null default 0 check (price_cents >= 0),
  currency text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  status text not null default 'draft'
    check (status in ('draft', 'review', 'published', 'withdrawn')),
  -- The rights attestation (Phase 4 shows it on the edition page; Phase 1
  -- records it). Required to publish — see editions_publish_guard.
  rights text check (rights in ('public_domain', 'own', 'licensed')),
  rights_note text,
  -- 0 = never published. publish_edition() raises it by one.
  version integer not null default 0 check (version >= 0),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.editions is
  'Grapheon Reader: one row per edition — a draft while benched, a frozen version once published (spec GRAPHEON-READER-2026-10-10).';
comment on column public.editions.version is
  '0 = never published. publish_edition() raises it and stamps the files and illustrations that first ship in that version.';

create index if not exists editions_publisher_idx on public.editions (publisher_user_id);
create index if not exists editions_status_idx on public.editions (status, published_at desc);

-- ============================================================================
-- edition_assets — one row per file in the editions bucket
-- ============================================================================

create table if not exists public.edition_assets (
  id uuid primary key default gen_random_uuid(),
  edition_id uuid not null references public.editions(id) on delete cascade,
  kind text not null check (kind in ('book', 'media', 'cover')),
  -- Object path in the `editions` bucket: <edition_id>/<file>. Enforced
  -- below so a row can never point at another edition's folder.
  storage_path text not null unique,
  bytes bigint check (bytes >= 0),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  mime text,
  -- The version this file first shipped in. Null while the edition it
  -- belongs to has not been published since the file arrived; publishing
  -- stamps it (freezes; never copies). A reader of version N may be served
  -- files with version_from <= N.
  version_from integer check (version_from >= 1),
  created_at timestamptz not null default now(),
  constraint edition_assets_path_in_own_folder check (position(edition_id::text || '/' in storage_path) = 1)
);

comment on table public.edition_assets is
  'Grapheon Reader: files of an edition in the private `editions` bucket. Never read directly by a client; api/editions.mjs signs URLs after the ownership check.';

create index if not exists edition_assets_edition_idx on public.edition_assets (edition_id, kind);

-- One book per edition.
create unique index if not exists edition_assets_one_book_idx
  on public.edition_assets (edition_id) where kind = 'book';

-- ============================================================================
-- edition_bench_items — the Workshop bench, 106's shape keyed by edition
-- ============================================================================

create table if not exists public.edition_bench_items (
  id uuid primary key default gen_random_uuid(),
  edition_id uuid not null references public.editions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  page integer not null check (page > 0),
  kind text not null check (kind in ('snip', 'snippet', 'media')),
  -- snip: {"x":0.12,"y":0.08,"w":0.76,"h":0.62} — fractions of the page box.
  rect jsonb,
  -- Clockwise degrees that make the plate upright (snip; copied onto the
  -- illustration when a media item is laid on the page).
  turn smallint not null default 0 check (turn in (0, 90, 180, 270)),
  -- snippet: the text.
  text text,
  -- media: the file, an asset of this edition (kind 'media').
  asset_id uuid references public.edition_assets(id) on delete cascade,
  -- media: the snip or snippet it was made from.
  parent_id uuid references public.edition_bench_items(id) on delete cascade,
  label text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint edition_bench_items_shape check (
    (kind = 'snip' and rect is not null and asset_id is null)
    or (kind = 'snippet' and text is not null and asset_id is null)
    or (kind = 'media' and asset_id is not null)
  )
);

comment on table public.edition_bench_items is
  'Grapheon Reader: the Workshop bench of an edition (snips, snippets, media), migration 106''s shape keyed by edition.';

create index if not exists edition_bench_items_edition_page_idx
  on public.edition_bench_items (edition_id, page);
create index if not exists edition_bench_items_parent_idx
  on public.edition_bench_items (parent_id);
create index if not exists edition_bench_items_asset_idx
  on public.edition_bench_items (asset_id);

-- ============================================================================
-- edition_illustrations — what is laid on the page, 062's shape keyed by edition
-- ============================================================================

create table if not exists public.edition_illustrations (
  id uuid primary key default gen_random_uuid(),
  edition_id uuid not null references public.editions(id) on delete cascade,
  -- The clip or picture that plays on the page: an asset of this edition.
  asset_id uuid not null references public.edition_assets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  page integer not null check (page > 0),
  -- {"x":0.12,"y":0.08,"w":0.76,"h":0.62} — fractions of the page box.
  rect jsonb not null,
  -- Clockwise degrees that make the illustration upright.
  turn smallint not null default 0 check (turn in (0, 90, 180, 270)),
  loops boolean not null default true,
  label text,
  -- Null on a draft; publish_edition() stamps the version it first ships in.
  -- A published version N serves the rows with version_from <= N.
  version_from integer check (version_from >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.edition_illustrations is
  'Grapheon Reader: illustrations laid on an edition''s pages, migration 062''s shape keyed by edition; edited live on a draft, frozen by version once published.';

create index if not exists edition_illustrations_edition_page_idx
  on public.edition_illustrations (edition_id, page);
create index if not exists edition_illustrations_asset_idx
  on public.edition_illustrations (asset_id);

-- ============================================================================
-- edition_purchases — ownership (written by the Stripe webhook only)
-- ============================================================================

create table if not exists public.edition_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  edition_id uuid not null references public.editions(id) on delete cascade,
  stripe_session_id text unique,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  created_at timestamptz not null default now(),
  refunded_at timestamptz
);

comment on table public.edition_purchases is
  'Grapheon Reader: who owns which edition. Written by the Stripe webhook with the service role; a refund sets refunded_at and the files stop being served.';

create index if not exists edition_purchases_user_idx on public.edition_purchases (user_id, edition_id);

-- ============================================================================
-- edition_marks — the reader's own highlights and notes (020's shape, no matters)
-- ============================================================================

create table if not exists public.edition_marks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  edition_id uuid not null references public.editions(id) on delete cascade,
  page integer not null check (page > 0),
  -- [{"x","y","w","h"}, …] fractions of the page box, as document_annotations.rects.
  rects jsonb not null,
  color text not null default 'gold' check (color in ('gold', 'green', 'pink', 'blue')),
  anchor_text text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.edition_marks is
  'Grapheon Reader: a reader''s highlights and margin notes on an edition. Owner-only; the document_annotations shape without matters or links.';

create index if not exists edition_marks_user_edition_page_idx
  on public.edition_marks (user_id, edition_id, page);

-- ============================================================================
-- edition_progress — where they are
-- ============================================================================

create table if not exists public.edition_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  edition_id uuid not null references public.editions(id) on delete cascade,
  page integer not null check (page > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, edition_id)
);

comment on table public.edition_progress is 'Grapheon Reader: the page a reader is on, per edition. Owner-only.';

-- ============================================================================
-- publisher_accounts — who may publish (Phase 1: rows made by Eden); payouts (Phase 4)
-- ============================================================================

create table if not exists public.publisher_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_connect_account_id text unique,
  status text not null default 'invited'
    check (status in ('invited', 'active', 'paused', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.publisher_accounts is
  'Grapheon Reader: who may publish to the store (D5: Eden''s account only until Phase 4 opens it) and, in Phase 4, their Stripe Connect account. Rows are made with the service role.';

-- ============================================================================
-- updated_at, kept by the schema's own trigger function (001)
-- ============================================================================

drop trigger if exists update_editions_updated_at on public.editions;
create trigger update_editions_updated_at
  before update on public.editions
  for each row execute function public.update_updated_at();

drop trigger if exists update_edition_bench_items_updated_at on public.edition_bench_items;
create trigger update_edition_bench_items_updated_at
  before update on public.edition_bench_items
  for each row execute function public.update_updated_at();

drop trigger if exists update_edition_illustrations_updated_at on public.edition_illustrations;
create trigger update_edition_illustrations_updated_at
  before update on public.edition_illustrations
  for each row execute function public.update_updated_at();

drop trigger if exists update_edition_marks_updated_at on public.edition_marks;
create trigger update_edition_marks_updated_at
  before update on public.edition_marks
  for each row execute function public.update_updated_at();

drop trigger if exists update_edition_progress_updated_at on public.edition_progress;
create trigger update_edition_progress_updated_at
  before update on public.edition_progress
  for each row execute function public.update_updated_at();

drop trigger if exists update_publisher_accounts_updated_at on public.publisher_accounts;
create trigger update_publisher_accounts_updated_at
  before update on public.publisher_accounts
  for each row execute function public.update_updated_at();

-- ============================================================================
-- SECURITY INVOKER access wrappers (the standing rule: capture auth.uid() first)
-- ============================================================================

-- Is the caller the edition's publisher?
create or replace function public._edition_is_publisher(p_edition uuid)
returns boolean
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_edition is null then return false; end if;
  return exists (
    select 1 from public.editions e
    where e.id = p_edition and e.publisher_user_id = v_uid
  );
end $$;

-- Does the caller own the edition: an unrefunded purchase. Read under the
-- caller's own RLS on edition_purchases (owner-only), so it never sees
-- anyone else's rows.
create or replace function public._edition_owned(p_edition uuid)
returns boolean
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_edition is null then return false; end if;
  return exists (
    select 1 from public.edition_purchases p
    where p.edition_id = p_edition and p.user_id = v_uid and p.refunded_at is null
  );
end $$;

-- May the caller read the edition's book: its publisher; or, once it is
-- published, anyone signed in when it is free, and an owner (an unrefunded
-- purchase) when it is not. A withdrawn edition stays readable to its owners.
create or replace function public._edition_can_read(p_edition uuid)
returns boolean
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
  v_pub uuid;
  v_status text;
  v_price integer;
begin
  if v_uid is null or p_edition is null then return false; end if;
  select e.publisher_user_id, e.status, e.price_cents
    into v_pub, v_status, v_price
    from public.editions e where e.id = p_edition;
  if v_pub is null then return false; end if;
  if v_pub = v_uid then return true; end if;
  if v_status = 'published' and v_price = 0 then return true; end if;
  if v_status in ('published', 'withdrawn') then
    return exists (
      select 1 from public.edition_purchases p
      where p.edition_id = p_edition and p.user_id = v_uid and p.refunded_at is null
    );
  end if;
  return false;
end $$;

-- Is this object path (<edition_id>/<file>) in a folder the caller publishes?
create or replace function public._edition_folder_is_mine(p_name text)
returns boolean
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
  v_folder text;
  v_edition uuid;
begin
  if v_uid is null or p_name is null then return false; end if;
  v_folder := split_part(p_name, '/', 1);
  if v_folder !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  v_edition := v_folder::uuid;
  return exists (
    select 1 from public.editions e
    where e.id = v_edition and e.publisher_user_id = v_uid
  );
end $$;

grant execute on function public._edition_is_publisher(uuid) to authenticated, service_role;
grant execute on function public._edition_owned(uuid) to authenticated, service_role;
grant execute on function public._edition_can_read(uuid) to authenticated, service_role;
grant execute on function public._edition_folder_is_mine(text) to authenticated, service_role;

-- ============================================================================
-- Publishing: a guard, and the one function that freezes a version
-- ============================================================================

-- D5: publishing to the store is Eden's account only until Phase 4 opens it.
-- A draft is anyone's; the step to 'published' needs an active
-- publisher_accounts row and a rights attestation.
create or replace function public.editions_publish_guard()
returns trigger
language plpgsql
security invoker
as $$
begin
  if new.status = 'published' and (old.status is distinct from 'published') then
    if not exists (
      select 1 from public.publisher_accounts a
      where a.user_id = new.publisher_user_id and a.status = 'active'
    ) then
      raise exception 'This account cannot publish to the store yet.' using errcode = '42501';
    end if;
    if new.rights is null then
      raise exception 'Say what the rights are (public domain, your own, or licensed) before publishing.' using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.edition_assets a where a.edition_id = new.id and a.kind = 'book'
    ) then
      raise exception 'An edition needs its book before it is published.' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists editions_publish_guard on public.editions;
create trigger editions_publish_guard
  before insert or update of status on public.editions
  for each row execute function public.editions_publish_guard();

-- Publish, or publish again: version + 1, published_at now, status
-- 'published', and every file and illustration that has not shipped yet is
-- stamped with the new version. Nothing is copied; a reader of version N
-- is served what has version_from <= N. Runs as the caller, so RLS decides
-- who may (the publisher). Returns the new version.
create or replace function public.publish_edition(p_edition uuid)
returns integer
language plpgsql
security invoker
as $$
declare
  v_uid uuid := auth.uid();
  v_version integer;
begin
  if v_uid is null then
    raise exception 'Sign in to publish.' using errcode = '42501';
  end if;
  if not public._edition_is_publisher(p_edition) then
    raise exception 'Only the edition''s publisher can publish it.' using errcode = '42501';
  end if;
  update public.editions
     set version = version + 1,
         status = 'published',
         published_at = now()
   where id = p_edition
   returning version into v_version;
  update public.edition_assets
     set version_from = v_version
   where edition_id = p_edition and version_from is null;
  update public.edition_illustrations
     set version_from = v_version
   where edition_id = p_edition and version_from is null;
  return v_version;
end $$;

grant execute on function public.publish_edition(uuid) to authenticated, service_role;

-- ============================================================================
-- Row-level security
-- ============================================================================

alter table public.editions enable row level security;
alter table public.edition_assets enable row level security;
alter table public.edition_bench_items enable row level security;
alter table public.edition_illustrations enable row level security;
alter table public.edition_purchases enable row level security;
alter table public.edition_marks enable row level security;
alter table public.edition_progress enable row level security;
alter table public.publisher_accounts enable row level security;

-- editions: public when published; the publisher's always; an owner's even
-- after withdrawal (owners keep what they bought — My Library still lists it).
drop policy if exists "Editions readable when published or mine" on public.editions;
drop policy if exists "Editions readable when published, mine or owned" on public.editions;
create policy "Editions readable when published, mine or owned"
  on public.editions for select
  using (
    status = 'published'
    or publisher_user_id = auth.uid()
    or (status = 'withdrawn' and public._edition_owned(id))
  );

drop policy if exists "Anyone signed in can start an edition" on public.editions;
create policy "Anyone signed in can start an edition"
  on public.editions for insert
  with check (publisher_user_id = auth.uid());

drop policy if exists "Publishers can change their editions" on public.editions;
create policy "Publishers can change their editions"
  on public.editions for update
  using (publisher_user_id = auth.uid())
  with check (publisher_user_id = auth.uid());

drop policy if exists "Publishers can delete their editions" on public.editions;
create policy "Publishers can delete their editions"
  on public.editions for delete
  using (publisher_user_id = auth.uid());

-- edition_assets: the publisher's to list and manage; never a reader's
-- (the API signs URLs with the service role after _edition_can_read).
drop policy if exists "Publishers see their edition files" on public.edition_assets;
create policy "Publishers see their edition files"
  on public.edition_assets for select
  using (public._edition_is_publisher(edition_id));

drop policy if exists "Publishers add edition files" on public.edition_assets;
create policy "Publishers add edition files"
  on public.edition_assets for insert
  with check (public._edition_is_publisher(edition_id));

drop policy if exists "Publishers change edition files" on public.edition_assets;
create policy "Publishers change edition files"
  on public.edition_assets for update
  using (public._edition_is_publisher(edition_id))
  with check (public._edition_is_publisher(edition_id));

drop policy if exists "Publishers remove edition files" on public.edition_assets;
create policy "Publishers remove edition files"
  on public.edition_assets for delete
  using (public._edition_is_publisher(edition_id));

-- edition_bench_items: the publisher's alone.
drop policy if exists "Publishers see their bench" on public.edition_bench_items;
create policy "Publishers see their bench"
  on public.edition_bench_items for select
  using (public._edition_is_publisher(edition_id));

drop policy if exists "Publishers add to their bench" on public.edition_bench_items;
create policy "Publishers add to their bench"
  on public.edition_bench_items for insert
  with check (user_id = auth.uid() and public._edition_is_publisher(edition_id));

drop policy if exists "Publishers change their bench" on public.edition_bench_items;
create policy "Publishers change their bench"
  on public.edition_bench_items for update
  using (public._edition_is_publisher(edition_id))
  with check (public._edition_is_publisher(edition_id));

drop policy if exists "Publishers clear their bench" on public.edition_bench_items;
create policy "Publishers clear their bench"
  on public.edition_bench_items for delete
  using (public._edition_is_publisher(edition_id));

-- edition_illustrations: the publisher sees all; a reader of a published
-- edition sees the rows that have shipped in a version they can read.
drop policy if exists "Illustrations readable by publisher or reader" on public.edition_illustrations;
create policy "Illustrations readable by publisher or reader"
  on public.edition_illustrations for select
  using (
    public._edition_is_publisher(edition_id)
    or (
      version_from is not null
      and public._edition_can_read(edition_id)
      and exists (
        select 1 from public.editions e
        where e.id = edition_illustrations.edition_id
          and e.status in ('published', 'withdrawn')
          and e.version >= edition_illustrations.version_from
      )
    )
  );

drop policy if exists "Publishers lay illustrations" on public.edition_illustrations;
create policy "Publishers lay illustrations"
  on public.edition_illustrations for insert
  with check (user_id = auth.uid() and public._edition_is_publisher(edition_id));

drop policy if exists "Publishers move illustrations" on public.edition_illustrations;
create policy "Publishers move illustrations"
  on public.edition_illustrations for update
  using (public._edition_is_publisher(edition_id))
  with check (public._edition_is_publisher(edition_id));

drop policy if exists "Publishers lift illustrations" on public.edition_illustrations;
create policy "Publishers lift illustrations"
  on public.edition_illustrations for delete
  using (public._edition_is_publisher(edition_id));

-- edition_purchases: owner reads; nobody writes but the webhook (service role).
drop policy if exists "Readers see their own purchases" on public.edition_purchases;
create policy "Readers see their own purchases"
  on public.edition_purchases for select
  using (user_id = auth.uid());

-- edition_marks: owner-only, and only on a book the reader can read.
drop policy if exists "Readers see their own marks" on public.edition_marks;
create policy "Readers see their own marks"
  on public.edition_marks for select
  using (user_id = auth.uid());

drop policy if exists "Readers mark books they can read" on public.edition_marks;
create policy "Readers mark books they can read"
  on public.edition_marks for insert
  with check (user_id = auth.uid() and public._edition_can_read(edition_id));

drop policy if exists "Readers change their own marks" on public.edition_marks;
create policy "Readers change their own marks"
  on public.edition_marks for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Readers remove their own marks" on public.edition_marks;
create policy "Readers remove their own marks"
  on public.edition_marks for delete
  using (user_id = auth.uid());

-- edition_progress: owner-only.
drop policy if exists "Readers see their own progress" on public.edition_progress;
create policy "Readers see their own progress"
  on public.edition_progress for select
  using (user_id = auth.uid());

drop policy if exists "Readers keep their own progress" on public.edition_progress;
create policy "Readers keep their own progress"
  on public.edition_progress for insert
  with check (user_id = auth.uid() and public._edition_can_read(edition_id));

drop policy if exists "Readers move their own progress" on public.edition_progress;
create policy "Readers move their own progress"
  on public.edition_progress for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Readers forget their own progress" on public.edition_progress;
create policy "Readers forget their own progress"
  on public.edition_progress for delete
  using (user_id = auth.uid());

-- publisher_accounts: a publisher sees their own row; rows are made and
-- changed with the service role (Eden, then Stripe Connect onboarding).
drop policy if exists "Publishers see their own account" on public.publisher_accounts;
create policy "Publishers see their own account"
  on public.publisher_accounts for select
  using (user_id = auth.uid());

-- ============================================================================
-- The `editions` bucket — private; the publisher writes under their edition's
-- folder; nobody reads directly (api/editions.mjs signs URLs).
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('editions', 'editions', false)
on conflict (id) do nothing;

drop policy if exists "editions_publisher_select" on storage.objects;
create policy "editions_publisher_select" on storage.objects
  for select using (
    bucket_id = 'editions'
    and public._edition_folder_is_mine(name));

drop policy if exists "editions_publisher_insert" on storage.objects;
create policy "editions_publisher_insert" on storage.objects
  for insert with check (
    bucket_id = 'editions'
    and public._edition_folder_is_mine(name));

drop policy if exists "editions_publisher_update" on storage.objects;
create policy "editions_publisher_update" on storage.objects
  for update using (
    bucket_id = 'editions'
    and public._edition_folder_is_mine(name));

drop policy if exists "editions_publisher_delete" on storage.objects;
create policy "editions_publisher_delete" on storage.objects
  for delete using (
    bucket_id = 'editions'
    and public._edition_folder_is_mine(name));

notify pgrst, 'reload schema';
