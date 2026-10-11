-- Contextspaces Migration 107: volume limits — a fair-use meter on SCANNED
-- pages, OCR packs, and a storage ceiling.
--
-- What Eden decided (2026-10-09 → 10-11)
-- ---------------------------------------------------------------------------
-- The tiers differ by VOLUME only, and pages are not a headline number. The
-- pricing page sells "unlimited documents" plus the monthly AI credit (063's
-- wallet: $10 / $25 / $60). What protects the margin is quieter:
--
--   * SCANNED pages — the only pages that cost real money (OCR, ~$0.002 a
--     page on the Gemini route, $0.0015 on the sealed Textract route) — have
--     a monthly fair-use allowance per tier. A Westlaw opinion, a Word file,
--     an e-filed PDF or an email has a text layer and never touches the
--     meter. Ordinary practice should never see it.
--   * When the allowance runs out the upload still succeeds: the file is
--     stored and viewable, the typed pages are indexed, and the scanned
--     pages wait (documents.metadata.ocr_pending.over_allowance) with a
--     sentence that offers an OCR PACK — a one-time purchase that does not
--     expire, exactly like 067's credit packs. Buying one wakes the waiting
--     documents; so does the 1st of the month.
--   * STORAGE has a ceiling per tier that exists only to stop abuse (storage
--     costs ~2¢ a GB a month). It is never shown on the pricing page.
--
-- Every number is a ROW, not code — Eden edits volume_limits and
-- billing_ocr_packs in the SQL editor and nothing redeploys. Seeds use
-- `on conflict do nothing`, so re-pasting this file never clobbers an edit.
--
--   tier      scanned pages / month   storage ceiling
--   free           500                   5 GB
--   basic       10,000                  50 GB
--   pro         30,000                 250 GB
--   max         75,000                   1 TB
--   workshop   unlimited             unlimited     (Eden's own account)
--
-- The OCR pack ships INACTIVE ('ocr_10k', 10,000 pages, proposed $25): the
-- Settings page does not offer it until Eden sets the price he wants and
-- flips `active`. No Stripe object is needed first — the checkout sends
-- inline price_data, as 067's credit packs do.
--
-- Where the meter sits, and why there
-- ---------------------------------------------------------------------------
-- OCR is spent in exactly two places, both in lib/ingest-core.mjs: the
-- scanned-page branch of the PDF path and the OCR-able image path. Every
-- surface that ingests (the Vault via /api/ingest, the Fly worker, the MCP
-- file_document tool, the OCR retry sweep) runs through them. Just before
-- each OCR call the pipeline asks ocr_pages_reserve(document, pages) — the
-- one RPC below — through an injected hook (lib/ocr-allowance.mjs), with the
-- service role. No hook (a test, a CLI) means no meter.
--
-- Charges are keyed by DOCUMENT: a retry of the same scan (the sweep, a
-- person's Re-run) charges only the pages it has not already been charged
-- for, so a flaky OCR provider never bills a page twice. Pages are not
-- refunded when a document is deleted — the processing already happened.
--
-- The page is charged to the document's UPLOADER (documents.created_by),
-- whoever later presses Re-run.
--
-- Overshoot is bounded by one document: a document that starts while any
-- allowance or pack balance remains is read in full, and the remainder is
-- recorded as `pages_over` against the month. A pack balance never goes
-- negative (the same invariant 067 keeps on credits).
--
-- Failure policy: if the RPC is missing or errors, the pipeline ALLOWS the OCR
-- and logs — availability over strictness, as 063's meter does. A scan read
-- for free during an outage costs a fifth of a cent a page; a lawyer's
-- production refused by a database blip costs a customer.
--
-- The storage ceiling is a BEFORE INSERT trigger on documents. The Vault
-- inserts the row (with file_size_bytes) BEFORE it uploads the bytes, so a
-- refusal there costs nothing and leaves nothing in the bucket. The running
-- total lives in storage_usage, kept by triggers, so the check is one row
-- read rather than a sum over every document the account owns — a 50,000-
-- file production must not do 50,000 aggregates.
--
-- Verified by scripts/_verify-volume-limits.mjs (PGlite, executes this file
-- twice on top of 062/063/067).

-- ===========================================================================
-- 1. The knobs.
-- ===========================================================================
create table if not exists public.volume_limits (
  pricing_tier       text primary key,
  -- Scanned (OCR) pages per calendar month, UTC. null = unlimited.
  monthly_ocr_pages  integer,
  -- Total bytes of documents this account has uploaded. null = unlimited.
  storage_bytes      bigint,
  note               text not null default '',
  updated_at         timestamptz not null default now(),
  constraint volume_limits_sane check (
    (monthly_ocr_pages is null or monthly_ocr_pages >= 0)
    and (storage_bytes is null or storage_bytes >= 0)
  )
);

insert into public.volume_limits (pricing_tier, monthly_ocr_pages, storage_bytes, note) values
  ('free',        500,     5::bigint * 1024 * 1024 * 1024, 'Eden 2026-10-11 — fair use, not on the pricing page.'),
  ('basic',     10000,    50::bigint * 1024 * 1024 * 1024, 'Eden 2026-10-11 — fair use, not on the pricing page.'),
  ('pro',       30000,   250::bigint * 1024 * 1024 * 1024, 'Eden 2026-10-11 — fair use, not on the pricing page.'),
  ('max',       75000,  1024::bigint * 1024 * 1024 * 1024, 'Eden 2026-10-11 — fair use, not on the pricing page.'),
  ('workshop',   null,   null,                             'Eden''s own account: unlimited.')
on conflict (pricing_tier) do nothing;

create table if not exists public.billing_ocr_packs (
  pack_key        text primary key,
  display_name    text not null,
  price_cents     integer not null,
  pages           integer not null,
  stripe_price_id text,
  sort_order      integer not null default 0,
  -- Off until Eden sets the price. The Settings page lists active packs only,
  -- and the checkout refuses an inactive one.
  active          boolean not null default false,
  note            text not null default '',
  updated_at      timestamptz not null default now(),
  constraint billing_ocr_packs_sane check (price_cents > 0 and pages > 0)
);

insert into public.billing_ocr_packs (pack_key, display_name, price_cents, pages, sort_order, active, note) values
  ('ocr_10k', 'OCR pack — 10,000 scanned pages', 2500, 10000, 1, false,
   'PROPOSED 2026-10-11 — ~$20 of OCR at the Gemini rate. Eden sets price_cents, then active = true.')
on conflict (pack_key) do nothing;

-- ===========================================================================
-- 2. The counters.
-- ===========================================================================

-- Scanned pages per account per month. pages_over is the one-document
-- overshoot past allowance + packs; it counts against the allowance.
create table if not exists public.ocr_month (
  user_id               uuid   not null references auth.users(id) on delete cascade,
  month_key             text   not null,                    -- 'YYYY-MM', UTC
  pages_from_allowance  bigint not null default 0,
  pages_from_packs      bigint not null default 0,
  pages_over            bigint not null default 0,
  updated_at            timestamptz not null default now(),
  primary key (user_id, month_key)
);

create table if not exists public.ocr_pack_balance (
  user_id          uuid   primary key references auth.users(id) on delete cascade,
  pages_available  bigint not null default 0,
  pages_granted    bigint not null default 0,
  pages_drawn      bigint not null default 0,
  updated_at       timestamptz not null default now(),
  constraint ocr_pack_balance_nonneg check (pages_available >= 0)
);

create table if not exists public.ocr_page_ledger (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users(id) on delete cascade,
  -- grant = a pack was bought; draw = a document's scanned pages came out of
  -- the pack; adjustment = a manual correction by the service role.
  entry_kind                text not null check (entry_kind in ('grant', 'draw', 'adjustment')),
  delta_pages               bigint not null,
  balance_after             bigint,
  pack_key                  text,
  document_id               uuid,
  stripe_session_id         text,
  stripe_payment_intent_id  text,
  stripe_invoice_id         text,
  receipt_url               text,
  invoice_url               text,
  note                      text not null default '',
  created_at                timestamptz not null default now()
);

create unique index if not exists ocr_page_ledger_grant_session_idx
  on public.ocr_page_ledger (stripe_session_id)
  where entry_kind = 'grant' and stripe_session_id is not null;

create index if not exists ocr_page_ledger_user_idx
  on public.ocr_page_ledger (user_id, created_at desc);

-- Same append-only rule as 067's credit ledger.
create or replace function public.ocr_page_ledger_append_only()
returns trigger
language plpgsql
security invoker
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception
      'ocr_page_ledger is append-only: write an adjustment row instead of editing %',
      old.id using errcode = '42501';
  end if;
  if tg_op = 'DELETE'
     and current_user not in ('postgres', 'supabase_admin', 'supabase_auth_admin')
  then
    raise exception
      'ocr_page_ledger is append-only: % may not delete ledger rows', current_user
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists ocr_page_ledger_append_only on public.ocr_page_ledger;
create trigger ocr_page_ledger_append_only
  before update or delete on public.ocr_page_ledger
  for each row execute function public.ocr_page_ledger_append_only();

-- Pages already charged, per document — what makes a retry free. No FK on
-- purpose: a deleted document's charge stays spent, and this table must never
-- be the reason a document cannot be deleted.
create table if not exists public.ocr_document_charges (
  document_id    uuid primary key,
  user_id        uuid not null,
  pages_charged  bigint not null default 0,
  updated_at     timestamptz not null default now()
);

-- Bytes uploaded per account, maintained by the triggers in section 4.
create table if not exists public.storage_usage (
  user_id     uuid primary key,
  bytes       bigint not null default 0,
  updated_at  timestamptz not null default now()
);

-- ===========================================================================
-- 3. Which limits apply to an account. An unknown tier resolves to 'free' —
-- never to unlimited. No rows at all (table emptied by hand) = no limit,
-- which is the meter's fail-open policy, not a tier.
-- ===========================================================================
create or replace function public._volume_limits_for(p_user uuid)
returns public.volume_limits
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tier text;
  v_row  public.volume_limits%rowtype;
begin
  select coalesce(nullif(trim(pricing_tier), ''), 'free') into v_tier
    from public.profiles where id = p_user;
  v_tier := coalesce(v_tier, 'free');
  select * into v_row from public.volume_limits where pricing_tier = v_tier;
  if not found then
    select * into v_row from public.volume_limits where pricing_tier = 'free';
  end if;
  if not found then
    v_row.pricing_tier := v_tier;   -- other columns stay null: no limit
  end if;
  return v_row;
end $$;

revoke all on function public._volume_limits_for(uuid) from public, anon, authenticated;
grant execute on function public._volume_limits_for(uuid) to service_role;

-- ===========================================================================
-- 4. Storage: the running total and the ceiling.
-- ===========================================================================
create or replace function public._storage_usage_track()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.created_by is not null
     and coalesce(old.file_size_bytes, 0) <> 0 then
    update public.storage_usage
       set bytes = greatest(bytes - old.file_size_bytes, 0), updated_at = now()
     where user_id = old.created_by;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.created_by is not null
     and coalesce(new.file_size_bytes, 0) <> 0 then
    insert into public.storage_usage (user_id, bytes) values (new.created_by, new.file_size_bytes)
    on conflict (user_id) do update
      set bytes = public.storage_usage.bytes + excluded.bytes, updated_at = now();
  end if;
  return null;
end $$;

drop trigger if exists documents_storage_usage_track on public.documents;
create trigger documents_storage_usage_track
  after insert or delete or update of file_size_bytes, created_by on public.documents
  for each row execute function public._storage_usage_track();

create or replace function public._storage_ceiling_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limits public.volume_limits%rowtype;
  v_used   bigint;
begin
  if new.created_by is null or coalesce(new.file_size_bytes, 0) <= 0 then
    return new;
  end if;
  v_limits := public._volume_limits_for(new.created_by);
  if v_limits.storage_bytes is null then
    return new;
  end if;
  select coalesce(bytes, 0) into v_used from public.storage_usage where user_id = new.created_by;
  v_used := coalesce(v_used, 0);
  if v_used + new.file_size_bytes > v_limits.storage_bytes then
    -- 53400 configuration_limit_exceeded. The message is read by a person:
    -- the Vault shows it as the reason the file was not uploaded.
    raise exception 'This upload would take your account past its storage limit (% GB). Delete files you no longer need, or contact support to raise the limit.',
      round(v_limits.storage_bytes / 1073741824.0)
      using errcode = '53400';
  end if;
  return new;
end $$;

drop trigger if exists documents_storage_ceiling on public.documents;
create trigger documents_storage_ceiling
  before insert on public.documents
  for each row execute function public._storage_ceiling_check();

-- Backfill (and re-paste repair): recompute every account's total exactly.
insert into public.storage_usage (user_id, bytes)
select created_by, coalesce(sum(file_size_bytes), 0)
  from public.documents
 where created_by is not null
 group by created_by
on conflict (user_id) do update set bytes = excluded.bytes, updated_at = now();

-- ===========================================================================
-- 5. ocr_pages_reserve — the one call the pipeline makes before OCR.
--
-- Returns {allowed, charged, from_allowance, from_pack, over, ...}. Service
-- role only: the pipeline calls it with the service key, and nothing a
-- signed-in user can reach may spend another account's allowance.
-- ===========================================================================
create or replace function public.ocr_pages_reserve(p_document uuid, p_pages integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pages   bigint := least(greatest(coalesce(p_pages, 0), 0), 1000000);
  v_user    uuid;
  v_already bigint;
  v_need    bigint;
  v_limits  public.volume_limits%rowtype;
  v_month   text := to_char(now() at time zone 'utc', 'YYYY-MM');
  v_m       public.ocr_month%rowtype;
  v_left    bigint;
  v_pack    bigint;
  v_allow   bigint := 0;
  v_frompk  bigint := 0;
  v_over    bigint := 0;
  v_balance bigint;
begin
  select created_by into v_user from public.documents where id = p_document;
  if v_user is null then
    return jsonb_build_object('allowed', true, 'charged', 0, 'reason', 'no_owner');
  end if;

  -- Lock this document's charge row first, so two runs of the same document
  -- cannot both decide "not yet charged".
  insert into public.ocr_document_charges (document_id, user_id) values (p_document, v_user)
  on conflict (document_id) do nothing;
  select pages_charged into v_already from public.ocr_document_charges
   where document_id = p_document for update;
  v_need := greatest(v_pages - coalesce(v_already, 0), 0);
  if v_need = 0 then
    return jsonb_build_object('allowed', true, 'charged', 0, 'reason', 'already_charged', 'user_id', v_user);
  end if;

  v_limits := public._volume_limits_for(v_user);

  insert into public.ocr_month (user_id, month_key) values (v_user, v_month)
  on conflict (user_id, month_key) do nothing;
  select * into v_m from public.ocr_month where user_id = v_user and month_key = v_month for update;

  if v_limits.monthly_ocr_pages is null then
    v_allow := v_need;
  else
    v_left := greatest(v_limits.monthly_ocr_pages - v_m.pages_from_allowance - v_m.pages_over, 0);
    select pages_available into v_pack from public.ocr_pack_balance where user_id = v_user for update;
    v_pack := coalesce(v_pack, 0);
    if v_left + v_pack <= 0 then
      return jsonb_build_object(
        'allowed', false, 'reason', 'ocr_allowance_exhausted', 'user_id', v_user,
        'need', v_need, 'month_key', v_month, 'tier', v_limits.pricing_tier,
        'monthly_ocr_pages', v_limits.monthly_ocr_pages,
        'used', v_m.pages_from_allowance + v_m.pages_over, 'pack_pages', 0);
    end if;
    v_allow  := least(v_need, v_left);
    v_frompk := least(v_need - v_allow, v_pack);
    v_over   := v_need - v_allow - v_frompk;
  end if;

  update public.ocr_month
     set pages_from_allowance = pages_from_allowance + v_allow,
         pages_from_packs     = pages_from_packs + v_frompk,
         pages_over           = pages_over + v_over,
         updated_at           = now()
   where user_id = v_user and month_key = v_month;

  if v_frompk > 0 then
    update public.ocr_pack_balance
       set pages_available = pages_available - v_frompk,
           pages_drawn     = pages_drawn + v_frompk,
           updated_at      = now()
     where user_id = v_user
    returning pages_available into v_balance;
    insert into public.ocr_page_ledger (user_id, entry_kind, delta_pages, balance_after, document_id, note)
    values (v_user, 'draw', -v_frompk, v_balance, p_document, 'Scanned pages past the monthly allowance');
  end if;

  update public.ocr_document_charges
     set pages_charged = pages_charged + v_need, updated_at = now()
   where document_id = p_document;

  return jsonb_build_object(
    'allowed', true, 'charged', v_need, 'user_id', v_user,
    'from_allowance', v_allow, 'from_pack', v_frompk, 'over', v_over,
    'month_key', v_month, 'tier', v_limits.pricing_tier);
end $$;

revoke all on function public.ocr_pages_reserve(uuid, integer) from public, anon, authenticated;
grant execute on function public.ocr_pages_reserve(uuid, integer) to service_role;

-- ===========================================================================
-- 6. ocr_pack_grant — a paid OCR pack lands in the balance. Same three
-- idempotency guards as 067's usage_credits_grant: the billing_events insert,
-- the unique index on the grant's session, and the explicit session check.
--
-- And it WAKES the account's documents that were waiting on the allowance:
-- their ocr_pending.next_retry_at becomes now, which is exactly what the
-- worker's OCR sweep looks for.
-- ===========================================================================
create or replace function public.ocr_pack_grant(
  p_event_id       text,
  p_user           uuid,
  p_pages          bigint,
  p_pack_key       text    default null,
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
  v_event    text   := nullif(trim(coalesce(p_event_id, '')), '');
  v_session  text   := nullif(trim(coalesce(p_session_id, '')), '');
  v_pages    bigint := least(greatest(coalesce(p_pages, 0), 0), 100000000);
  v_existing public.ocr_page_ledger%rowtype;
  v_balance  bigint;
  v_id       uuid;
  v_woken    integer := 0;
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
  if v_pages <= 0 then
    v_result := jsonb_build_object('ok', false, 'reason', 'nothing_to_grant', 'event_id', v_event);
    update public.billing_events set outcome = v_result where event_id = v_event;
    return v_result;
  end if;

  if v_session is not null then
    select * into v_existing from public.ocr_page_ledger l
     where l.entry_kind = 'grant' and l.stripe_session_id = v_session;
    if found then
      v_result := jsonb_build_object('ok', true, 'replay', true, 'reason', 'session_already_granted',
        'event_id', v_event, 'ledger_id', v_existing.id, 'pages', v_existing.delta_pages);
      update public.billing_events set outcome = v_result where event_id = v_event;
      return v_result;
    end if;
  end if;

  insert into public.ocr_pack_balance (user_id, pages_available, pages_granted)
  values (p_user, v_pages, v_pages)
  on conflict (user_id) do update
    set pages_available = public.ocr_pack_balance.pages_available + excluded.pages_available,
        pages_granted   = public.ocr_pack_balance.pages_granted + excluded.pages_granted,
        updated_at      = now()
  returning pages_available into v_balance;

  insert into public.ocr_page_ledger (
    user_id, entry_kind, delta_pages, balance_after, pack_key, stripe_session_id,
    stripe_payment_intent_id, stripe_invoice_id, receipt_url, invoice_url, note)
  values (
    p_user, 'grant', v_pages, v_balance, nullif(trim(coalesce(p_pack_key, '')), ''), v_session,
    nullif(trim(coalesce(p_payment_intent, '')), ''), nullif(trim(coalesce(p_invoice_id, '')), ''),
    nullif(trim(coalesce(p_receipt_url, '')), ''), nullif(trim(coalesce(p_invoice_url, '')), ''),
    'OCR pack purchase')
  returning id into v_id;

  update public.documents
     set metadata = jsonb_set(metadata, '{ocr_pending,next_retry_at}', to_jsonb(now()))
   where created_by = p_user
     and metadata -> 'ocr_pending' ->> 'over_allowance' = 'true';
  get diagnostics v_woken = row_count;

  v_result := jsonb_build_object('ok', true, 'event_id', v_event, 'user_id', p_user,
    'pages', v_pages, 'balance_pages', v_balance, 'ledger_id', v_id, 'documents_woken', v_woken);
  update public.billing_events set outcome = v_result where event_id = v_event;
  return v_result;
end $$;

revoke all on function public.ocr_pack_grant(text, uuid, bigint, text, text, text, text, text, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.ocr_pack_grant(text, uuid, bigint, text, text, text, text, text, text, text, bigint)
  to service_role;

-- ===========================================================================
-- 7. volume_status — what Settings › Billing shows the signed-in account.
-- An RPC (not a policy), so reading auth.uid() here is safe.
-- ===========================================================================
create or replace function public.volume_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me     uuid := auth.uid();
  v_limits public.volume_limits%rowtype;
  v_month  text := to_char(now() at time zone 'utc', 'YYYY-MM');
  v_used   bigint;
  v_pack   bigint;
  v_bytes  bigint;
begin
  if v_me is null then
    return null;
  end if;
  v_limits := public._volume_limits_for(v_me);
  select pages_from_allowance + pages_over into v_used
    from public.ocr_month where user_id = v_me and month_key = v_month;
  select pages_available into v_pack from public.ocr_pack_balance where user_id = v_me;
  select bytes into v_bytes from public.storage_usage where user_id = v_me;
  return jsonb_build_object(
    'tier', v_limits.pricing_tier,
    'month_key', v_month,
    'monthly_ocr_pages', v_limits.monthly_ocr_pages,
    'ocr_pages_used', coalesce(v_used, 0),
    'ocr_pack_pages', coalesce(v_pack, 0),
    'storage_bytes_limit', v_limits.storage_bytes,
    'storage_bytes_used', coalesce(v_bytes, 0));
end $$;

revoke all on function public.volume_status() from public, anon;
grant execute on function public.volume_status() to authenticated, service_role;

-- ===========================================================================
-- 8. RLS and privileges — read your own rows, write none. Same shape as 067.
-- ===========================================================================
alter table public.volume_limits        enable row level security;
alter table public.billing_ocr_packs    enable row level security;
alter table public.ocr_month            enable row level security;
alter table public.ocr_pack_balance     enable row level security;
alter table public.ocr_page_ledger      enable row level security;
alter table public.ocr_document_charges enable row level security;
alter table public.storage_usage        enable row level security;

drop policy if exists "Volume limits are readable by signed-in users" on public.volume_limits;
create policy "Volume limits are readable by signed-in users"
  on public.volume_limits for select to authenticated using (true);

drop policy if exists "OCR packs are readable by signed-in users" on public.billing_ocr_packs;
create policy "OCR packs are readable by signed-in users"
  on public.billing_ocr_packs for select to authenticated using (true);

drop policy if exists "Users read their own OCR month" on public.ocr_month;
create policy "Users read their own OCR month"
  on public.ocr_month for select to authenticated
  using (public._billing_is_self(user_id));

drop policy if exists "Users read their own OCR pack balance" on public.ocr_pack_balance;
create policy "Users read their own OCR pack balance"
  on public.ocr_pack_balance for select to authenticated
  using (public._billing_is_self(user_id));

drop policy if exists "Users read their own OCR ledger" on public.ocr_page_ledger;
create policy "Users read their own OCR ledger"
  on public.ocr_page_ledger for select to authenticated
  using (public._billing_is_self(user_id));

drop policy if exists "Users read their own storage usage" on public.storage_usage;
create policy "Users read their own storage usage"
  on public.storage_usage for select to authenticated
  using (public._billing_is_self(user_id));

-- ocr_document_charges: no policy — service role only.

grant select on public.volume_limits, public.billing_ocr_packs, public.ocr_month,
                public.ocr_pack_balance, public.ocr_page_ledger, public.storage_usage
  to authenticated;

grant all on public.volume_limits, public.billing_ocr_packs, public.ocr_month,
              public.ocr_pack_balance, public.ocr_page_ledger,
              public.ocr_document_charges, public.storage_usage
  to service_role;

revoke insert, update, delete on public.volume_limits     from anon, authenticated;
revoke insert, update, delete on public.billing_ocr_packs from anon, authenticated;
revoke insert, update, delete on public.ocr_month         from anon, authenticated;
revoke insert, update, delete on public.ocr_pack_balance  from anon, authenticated;
revoke insert, update, delete on public.ocr_page_ledger   from anon, authenticated;
revoke insert, update, delete on public.storage_usage     from anon, authenticated;
revoke all on public.ocr_document_charges                 from anon, authenticated;
