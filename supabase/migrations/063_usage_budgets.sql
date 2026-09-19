-- Contextspaces Migration 063: per-user spend caps and HTTP rate limits.
--
-- The problem
-- ---------------------------------------------------------------------------
-- Every paid endpoint requires a Supabase JWT, and not one of them has a
-- quota. `/api/llm` is a verbatim passthrough to Anthropic / OpenAI / Google /
-- xAI / Moonshot / Fireworks on OUR server keys, with a caller-supplied body
-- and maxDuration 300; `/api/assistant`, `/api/tts`, `/api/ingest`,
-- `/api/student-hub-ocr`, `/api/deepgram-token`, `/api/meeting-*` and
-- `/api/sandbox` are the same story with smaller bodies. `lib/rate-limit.mjs`
-- is a single-process token bucket for OpenAI embeddings only — on Vercel that
-- is one bucket per invocation, which is not a limit at all. Sign-up is open.
-- One stranger with a free account can therefore spend unbounded money.
--
-- Counters have to live in Postgres: serverless has no shared memory, and the
-- one thing every instance already talks to is this database.
--
-- What this migration installs
-- ---------------------------------------------------------------------------
--   * public.usage_budgets   — the knobs. One row per (pricing_tier, kind).
--                              PLACEHOLDER numbers; pricing is not decided.
--   * public.usage_month     — one row per (user, month): the wallet.
--   * public.usage_windows   — one row per (user, kind, window): the rate.
--   * public.usage_events    — one row per admitted request: the audit trail.
--   * public.usage_ip_windows— the same rate mechanism keyed by IP, for the
--                              ONE unauthenticated endpoint (oauth-register).
--   * usage_consume(...)     — the single atomic RPC the handlers call.
--   * usage_record_actual()  — reconciles the estimate to the provider's real
--                              token counts. service_role only.
--   * usage_consume_ip()     — the unauthenticated limiter. service_role only.
--   * usage_monthly_pages    — a reporting view: pages ingested per user per
--                              month, derived from documents.page_count.
--
-- Pricing is NOT decided (2026-09-19)
-- ---------------------------------------------------------------------------
-- Every number in the seeds below is a PLACEHOLDER chosen to be generous
-- enough that normal work never notices it and a runaway still stops. They are
-- data, not code: Eden edits the rows, nothing redeploys. The seeds use
-- `on conflict do nothing`, so re-pasting this file never clobbers edited
-- numbers.
--
-- 'workshop' (Eden's own account) is seeded unlimited: null budget, null rate.
--
-- Relationship to migration 062 (another builder, same week)
-- ---------------------------------------------------------------------------
-- 062 adds 'workshop' to the profiles.pricing_tier check constraint and fixes
-- the profiles UPDATE policy. This file does not touch public.profiles at all
-- and applies cleanly with or without it — usage_budgets.pricing_tier is plain
-- text with no foreign key, so the 'workshop' row exists here whether or not a
-- profile may yet carry that value. Stated plainly: a spend cap is only as
-- honest as profiles.pricing_tier, and 062 is what stops a signed-in stranger
-- from self-upgrading their own tier.
--
-- Failure policy, which lives in the handlers not here
-- ---------------------------------------------------------------------------
-- Over budget or over rate → the RPC returns allowed=false with a plain
-- message; the handler answers 402/429. If the RPC itself is missing or errors,
-- the handler ALLOWS the request and logs loudly (availability over
-- strictness) — which is also why this file is safe to paste before or after
-- the code merges. The single exception is /api/oauth-register, which is
-- unauthenticated and fails closed.
--
-- Verified by scripts/_verify-usage-budget.mjs, which EXECUTES this file
-- against a real Postgres (PGlite, no Docker) twice — with and without 062's
-- constraint — and checks the budget, the window, the refund, the clamp and
-- that a user cannot write a usage row.

-- ---------------------------------------------------------------------------
-- 1. The knobs.
--
-- Keyed by (pricing_tier, kind). kind '*' is the tier's default row and is
-- where the WALLET lives (monthly_cents): one budget across every kind of
-- spend, because it is one bill. A kind row overrides the window limits for
-- that kind and may carry its own optional sub-cap.
--
-- A tier with no rows at all resolves to 'free' — an unknown tier must never
-- mean unlimited.
-- ---------------------------------------------------------------------------
create table if not exists public.usage_budgets (
  pricing_tier        text    not null,
  -- '*' = the tier's defaults. Otherwise the meter `kind` the handler passes:
  -- llm, assistant, tts, ingest, ocr, meeting, sandbox, transcribe.
  kind                text    not null default '*',
  -- The month's spend ceiling in CENTS. null = unlimited.
  monthly_cents       integer,
  -- The rate window: at most window_max_requests requests per window_seconds.
  window_seconds      integer not null default 60,
  window_max_requests integer,
  -- Server-side ceiling clamped onto /api/llm's caller-supplied max_tokens
  -- (and injected when the body omits it). null = no clamp.
  max_output_tokens   integer,
  -- Largest request body /api/llm will forward, in bytes. null = no cap.
  max_request_bytes   integer,
  note                text    not null default '',
  updated_at          timestamptz not null default now(),
  primary key (pricing_tier, kind),
  constraint usage_budgets_sane check (
    window_seconds between 1 and 2678400
    and (monthly_cents       is null or monthly_cents       >= 0)
    and (window_max_requests is null or window_max_requests >= 0)
    and (max_output_tokens   is null or max_output_tokens   >  0)
    and (max_request_bytes   is null or max_request_bytes   >  0)
  )
);

-- ---------------------------------------------------------------------------
-- 2. The counters.
--
-- usage_month.cents_charged is the number checked against the budget: the sum
-- of conservative pre-estimates, corrected downward (or up) by
-- usage_record_actual once a provider reports real token counts.
-- ---------------------------------------------------------------------------
create table if not exists public.usage_month (
  user_id       uuid   not null references auth.users(id) on delete cascade,
  month_key     text   not null,                 -- 'YYYY-MM', UTC
  cents_charged bigint not null default 0,
  requests      bigint not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (user_id, month_key)
);

create table if not exists public.usage_windows (
  user_id    uuid    not null references auth.users(id) on delete cascade,
  kind       text    not null,
  window_key text    not null,
  requests   integer not null default 0,
  expires_at timestamptz not null,
  primary key (user_id, kind, window_key)
);

create index if not exists usage_windows_expiry_idx
  on public.usage_windows (expires_at);

create table if not exists public.usage_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  kind            text not null,
  month_key       text not null,
  pricing_tier    text not null default 'free',
  cents_estimated integer not null default 0,
  -- null until usage_record_actual reconciles it (or forever, for a route
  -- whose provider reports nothing usable — a streamed passthrough).
  cents_actual    integer,
  model           text,
  meta            jsonb not null default '{}',
  created_at      timestamptz not null default now()
);

create index if not exists usage_events_user_month_idx
  on public.usage_events (user_id, month_key, created_at desc);

-- The one unauthenticated limiter. No user to key on, so it is keyed by the
-- caller's IP and swept by expiry.
create table if not exists public.usage_ip_windows (
  ip         text    not null,
  kind       text    not null,
  window_key text    not null,
  requests   integer not null default 0,
  expires_at timestamptz not null,
  primary key (ip, kind, window_key)
);

create index if not exists usage_ip_windows_expiry_idx
  on public.usage_ip_windows (expires_at);

-- ---------------------------------------------------------------------------
-- 3. PLACEHOLDER numbers. Eden edits these rows; nothing redeploys.
--
-- Sizing note, so the numbers are readable rather than magic:
--   * $25/month of provider spend is roughly 5M input + 200K output tokens on
--     Opus-class pricing, or ~12,000 OCR pages on Gemini Flash. A working
--     lawyer using the Assistant all day does not approach it.
--   * The windows are anti-runaway, not anti-use: 60 LLM calls a minute is
--     faster than a person can read, and the Assistant's own loop is capped at
--     6 tool rounds per turn.
-- ---------------------------------------------------------------------------
insert into public.usage_budgets
  (pricing_tier, kind, monthly_cents, window_seconds, window_max_requests, max_output_tokens, max_request_bytes, note)
values
  -- free: generous enough to evaluate the product, small enough that a
  -- stranger with a throwaway signup cannot run up a bill.
  ('free',     '*',  1500, 60,  30,   8192,  1048576, 'PLACEHOLDER 2026-09-19 — $15/mo, 30 req/min, 8K max_tokens, 1 MB body'),
  ('free',     'llm',   null, 60,  20,   8192,  1048576, 'PLACEHOLDER — inherits the free wallet'),
  ('free',     'ingest',null, 3600, 120, null,  null,    'PLACEHOLDER — 120 documents/hour'),
  ('free',     'meeting',null, 60,  20,  null,  null,    'PLACEHOLDER — meeting-flag runs on a timer'),

  ('pro',      '*',  5000, 60,  60,  16384,  4194304, 'PLACEHOLDER 2026-09-19 — $50/mo, 60 req/min, 16K max_tokens, 4 MB body'),
  ('pro',      'llm',   null, 60,  60,  16384,  4194304, 'PLACEHOLDER'),
  ('pro',      'ingest',null, 3600, 600, null,  null,    'PLACEHOLDER — 600 documents/hour'),
  ('pro',      'meeting',null, 60,  60,  null,  null,    'PLACEHOLDER'),

  ('max',      '*', 20000, 60, 120,  32768, 16777216, 'PLACEHOLDER 2026-09-19 — $200/mo, 120 req/min, 32K max_tokens, 16 MB body'),
  ('max',      'llm',   null, 60, 120,  32768, 16777216, 'PLACEHOLDER'),
  ('max',      'ingest',null, 3600, 2000, null, null,    'PLACEHOLDER — 2000 documents/hour'),
  ('max',      'meeting',null, 60, 120,  null,  null,    'PLACEHOLDER'),

  -- workshop = Eden's own account. Effectively unlimited by design: null
  -- wallet, null rate. The row still exists so the meter records his events.
  ('workshop', '*',  null, 60, null, null, 33554432, 'Eden''s own account — unlimited by design; only an absurd body size is refused'),

  -- The pseudo-tier for the unauthenticated endpoint. Not a plan anyone can
  -- hold; usage_consume_ip reads this row and nothing else does.
  ('_anon', 'oauth_register', null, 3600, 20, null, 65536, 'PLACEHOLDER — 20 dynamic client registrations per IP per hour')
on conflict (pricing_tier, kind) do nothing;

-- ---------------------------------------------------------------------------
-- 4. RLS.
--
-- A user may READ their own usage and the budget table (so the UI can say what
-- the allowance is). A user may write NOTHING here: there is no INSERT, UPDATE
-- or DELETE policy on any of these tables, and the privileges are revoked on
-- top of that, so the only door is the SECURITY DEFINER RPC below.
--
-- The SELECT policies call a SECURITY INVOKER plpgsql wrapper that captures
-- auth.uid() into its own variable, per the standing rule in this project: a
-- SECURITY DEFINER + STABLE SQL function invoked from a policy expression sees
-- an auth.uid() that does not match what it returns anywhere else (see
-- supabase/migrations/022 and 023). The check itself is trivial; the wrapper is
-- the shape, so nobody later "optimises" it into the broken form.
-- ---------------------------------------------------------------------------
create or replace function public._usage_is_self(p_user uuid)
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

grant execute on function public._usage_is_self(uuid) to authenticated, service_role;

alter table public.usage_budgets    enable row level security;
alter table public.usage_month      enable row level security;
alter table public.usage_windows    enable row level security;
alter table public.usage_events     enable row level security;
alter table public.usage_ip_windows enable row level security;

drop policy if exists "Budgets are readable by signed-in users" on public.usage_budgets;
create policy "Budgets are readable by signed-in users"
  on public.usage_budgets for select
  to authenticated
  using (true);

drop policy if exists "Users read their own month" on public.usage_month;
create policy "Users read their own month"
  on public.usage_month for select
  to authenticated
  using (public._usage_is_self(user_id));

drop policy if exists "Users read their own windows" on public.usage_windows;
create policy "Users read their own windows"
  on public.usage_windows for select
  to authenticated
  using (public._usage_is_self(user_id));

drop policy if exists "Users read their own events" on public.usage_events;
create policy "Users read their own events"
  on public.usage_events for select
  to authenticated
  using (public._usage_is_self(user_id));

-- usage_ip_windows gets no policy at all: service_role only, and service_role
-- bypasses RLS.

grant select on public.usage_budgets, public.usage_month,
                public.usage_windows, public.usage_events to authenticated;
revoke insert, update, delete on public.usage_budgets    from anon, authenticated;
revoke insert, update, delete on public.usage_month      from anon, authenticated;
revoke insert, update, delete on public.usage_windows    from anon, authenticated;
revoke insert, update, delete on public.usage_events     from anon, authenticated;
revoke all on public.usage_ip_windows                    from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. usage_consume — the whole check, in one transaction.
--
-- Returns jsonb rather than raising, because a refusal is an ordinary answer
-- the handler turns into a 402/429 with a sentence a person can read.
--
-- WHOSE budget: auth.uid() wins, always. p_user is only consulted when
-- auth.uid() is null, which on this database means the caller is the service
-- role (execute is revoked from anon and public). Reading the caller from
-- p_user would let any signed-in user drain any other user's wallet with one
-- curl. Note that `current_user` CANNOT be used for this test — inside a
-- SECURITY DEFINER function it is the owner's role, so every caller would look
-- like the service role (the same trap migration 057's trigger documents).
--
-- Atomicity: the counters are incremented with INSERT … ON CONFLICT DO UPDATE,
-- which takes the row lock, so two concurrent requests serialise and the
-- second sees the first's increment. A request that would cross the wallet is
-- refunded inside the same transaction, so the recorded spend never exceeds
-- the budget at all.
-- ---------------------------------------------------------------------------
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
  v_user        uuid;
  v_kind        text := coalesce(nullif(trim(p_kind), ''), 'llm');
  -- A caller must not refund itself with a negative estimate, nor book a
  -- number so large it wraps. One month's worth of any plausible plan is the
  -- ceiling for a single request's estimate.
  v_cents       integer := least(greatest(coalesce(p_cents_estimate, 0), 0), 1000000);
  v_tier        text;
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
  v_event       uuid;
begin
  v_user := coalesce(auth.uid(), p_user);
  if v_user is null then
    return jsonb_build_object(
      'allowed', false, 'reason', 'unauthenticated', 'status', 401,
      'message', 'Sign in to use this feature.');
  end if;

  -- The tier. An unreadable or unknown tier is 'free' — never unlimited.
  select p.pricing_tier into v_tier from public.profiles p where p.id = v_user;
  v_tier := coalesce(nullif(trim(v_tier), ''), 'free');

  select * into v_star from public.usage_budgets
   where pricing_tier = v_tier and kind = '*';
  if not found then
    select * into v_star from public.usage_budgets
     where pricing_tier = 'free' and kind = '*';
  end if;
  select * into v_row from public.usage_budgets
   where pricing_tier = v_tier and kind = v_kind;

  -- A tier nobody seeded and no 'free' row either: the meter has nothing to
  -- say, so it says yes. Stated here so it is a decision, not an accident.
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

  -- Housekeeping, bounded to this caller's own rows.
  delete from public.usage_windows w
   where w.user_id = v_user and w.expires_at < now() - interval '1 hour';

  -- ---- the rate window -----------------------------------------------------
  -- Deterministic bucket id: the window's start instant. Two requests in the
  -- same window land on the same row on any instance, with no shared clock
  -- beyond the database's own.
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
      -- The attempt still counts: hammering a closed door should not reset
      -- the clock. Nothing is charged to the wallet.
      return jsonb_build_object(
        'allowed', false, 'reason', 'over_rate_limit', 'status', 429,
        'message', 'Too many requests in a row. Give it a moment and try again.',
        'tier', v_tier, 'kind', v_kind, 'window_key', v_window_key,
        'window_seconds', v_win_secs, 'window_max_requests', v_win_max,
        'window_requests', v_window_reqs, 'retry_after_seconds', v_win_secs,
        'max_output_tokens', v_max_tokens, 'max_request_bytes', v_max_bytes);
    end if;
  end if;

  -- ---- the wallet ----------------------------------------------------------
  insert into public.usage_month (user_id, month_key, cents_charged, requests)
  values (v_user, v_month, v_cents, 1)
  on conflict (user_id, month_key) do update
    set cents_charged = public.usage_month.cents_charged + excluded.cents_charged,
        requests      = public.usage_month.requests + 1,
        updated_at    = now()
  returning cents_charged into v_spent;

  if v_wallet is not null and v_spent > v_wallet then
    -- Refund inside the same transaction: the money was never spent, so the
    -- ledger must not say it was.
    update public.usage_month
       set cents_charged = cents_charged - v_cents,
           requests      = greatest(requests - 1, 0)
     where user_id = v_user and month_key = v_month;
    return jsonb_build_object(
      'allowed', false, 'reason', 'over_monthly_budget', 'status', 402,
      'message',
        'You have reached this month''s included AI usage. It resets at the start of '
        || 'next month — or upgrade your plan to continue now.',
      'tier', v_tier, 'kind', v_kind, 'month_key', v_month,
      'monthly_cents', v_wallet, 'month_cents_used', v_spent - v_cents,
      'remaining_cents', greatest(v_wallet - (v_spent - v_cents), 0),
      'max_output_tokens', v_max_tokens, 'max_request_bytes', v_max_bytes);
  end if;

  -- An optional per-kind sub-cap, for the day one route needs its own ceiling
  -- inside the shared wallet. Unseeded today; the machinery is here so the
  -- answer is a row, not a deploy.
  if v_sub_cap is not null then
    select coalesce(sum(e.cents_estimated), 0) into v_spent
      from public.usage_events e
     where e.user_id = v_user and e.month_key = v_month and e.kind = v_kind;
    if v_spent + v_cents > v_sub_cap then
      update public.usage_month
         set cents_charged = cents_charged - v_cents,
             requests      = greatest(requests - 1, 0)
       where user_id = v_user and month_key = v_month;
      return jsonb_build_object(
        'allowed', false, 'reason', 'over_kind_budget', 'status', 402,
        'message',
          'You have reached this month''s included usage for this feature. It resets at '
          || 'the start of next month.',
        'tier', v_tier, 'kind', v_kind, 'month_key', v_month,
        'monthly_cents', v_sub_cap, 'month_cents_used', v_spent,
        'max_output_tokens', v_max_tokens, 'max_request_bytes', v_max_bytes);
    end if;
  end if;

  insert into public.usage_events (user_id, kind, month_key, pricing_tier, cents_estimated)
  values (v_user, v_kind, v_month, v_tier, v_cents)
  returning id into v_event;

  select cents_charged into v_spent
    from public.usage_month where user_id = v_user and month_key = v_month;

  return jsonb_build_object(
    'allowed', true, 'reason', 'ok', 'status', 200,
    'event_id', v_event, 'tier', v_tier, 'kind', v_kind, 'month_key', v_month,
    'monthly_cents', v_wallet, 'month_cents_used', v_spent,
    'remaining_cents', case when v_wallet is null then null
                            else greatest(v_wallet - v_spent, 0) end,
    'window_key', v_window_key, 'window_seconds', v_win_secs,
    'window_max_requests', v_win_max, 'window_requests', v_window_reqs,
    'max_output_tokens', v_max_tokens, 'max_request_bytes', v_max_bytes);
end $$;

revoke all on function public.usage_consume(uuid, text, integer, text) from public, anon;
grant execute on function public.usage_consume(uuid, text, integer, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. usage_record_actual — correct the estimate once the provider has told us
-- what the call really cost.
--
-- service_role ONLY. Granted to `authenticated` it would be a self-refund
-- button: the owner of an event calls it with 0 and the wallet forgets. The
-- handlers call it with SUPABASE_SERVICE_ROLE_KEY; where that key is absent
-- the conservative pre-estimate simply stands, which is the safe direction.
-- ---------------------------------------------------------------------------
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
  v_actual integer := least(greatest(coalesce(p_cents_actual, 0), 0), 1000000);
  v_ev     public.usage_events%rowtype;
  v_delta  integer;
begin
  update public.usage_events
     set cents_actual = v_actual,
         model        = coalesce(p_model, model),
         meta         = meta || coalesce(p_meta, '{}'::jsonb)
   where id = p_event_id
     -- Reconcile once. A second call with a different number would double the
     -- correction, and a retried handler is not a second API call.
     and cents_actual is null
  returning * into v_ev;

  if v_ev.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found_or_already_recorded');
  end if;

  v_delta := v_actual - v_ev.cents_estimated;
  update public.usage_month
     set cents_charged = greatest(cents_charged + v_delta, 0),
         updated_at    = now()
   where user_id = v_ev.user_id and month_key = v_ev.month_key;

  return jsonb_build_object('ok', true, 'delta_cents', v_delta);
end $$;

revoke all on function public.usage_record_actual(uuid, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.usage_record_actual(uuid, integer, text, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7. usage_consume_ip — the limiter for the one endpoint with no user.
--
-- /api/oauth-register is unauthenticated Dynamic Client Registration: anyone
-- on the internet can POST it, and each call signs a client_id that never
-- expires. It is cheap per call and unbounded in aggregate, so this one fails
-- CLOSED in the handler when the meter errors.
--
-- Limits come from the usage_budgets row ('_anon', <kind>) so they are edited
-- like every other number here.
-- ---------------------------------------------------------------------------
create or replace function public.usage_consume_ip(
  p_ip         text,
  p_kind       text default 'oauth_register',
  p_window_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ip        text := left(coalesce(nullif(trim(p_ip), ''), 'unknown'), 64);
  v_kind      text := coalesce(nullif(trim(p_kind), ''), 'oauth_register');
  v_row       public.usage_budgets%rowtype;
  v_win_secs  integer;
  v_win_max   integer;
  v_key       text;
  v_reqs      integer;
begin
  select * into v_row from public.usage_budgets
   where pricing_tier = '_anon' and kind = v_kind;
  if not found then
    return jsonb_build_object('allowed', true, 'reason', 'unconfigured', 'status', 200);
  end if;
  v_win_secs := coalesce(v_row.window_seconds, 3600);
  v_win_max  := v_row.window_max_requests;

  delete from public.usage_ip_windows w
   where w.kind = v_kind and w.expires_at < now() - interval '1 hour';

  if v_win_max is null then
    return jsonb_build_object('allowed', true, 'reason', 'unlimited', 'status', 200,
      'max_request_bytes', v_row.max_request_bytes);
  end if;

  v_key := coalesce(nullif(trim(coalesce(p_window_key, '')), ''),
    to_char(
      to_timestamp(floor(extract(epoch from now()) / v_win_secs) * v_win_secs)
        at time zone 'utc',
      'YYYYMMDD"T"HH24MISS'));

  insert into public.usage_ip_windows (ip, kind, window_key, requests, expires_at)
  values (v_ip, v_kind, v_key, 1, now() + make_interval(secs => v_win_secs * 2))
  on conflict (ip, kind, window_key) do update
    set requests = public.usage_ip_windows.requests + 1
  returning requests into v_reqs;

  if v_reqs > v_win_max then
    return jsonb_build_object(
      'allowed', false, 'reason', 'over_rate_limit', 'status', 429,
      'message', 'Too many registration requests from this address. Try again later.',
      'retry_after_seconds', v_win_secs, 'window_requests', v_reqs,
      'window_max_requests', v_win_max, 'max_request_bytes', v_row.max_request_bytes);
  end if;

  return jsonb_build_object('allowed', true, 'reason', 'ok', 'status', 200,
    'window_requests', v_reqs, 'window_max_requests', v_win_max,
    'max_request_bytes', v_row.max_request_bytes);
end $$;

revoke all on function public.usage_consume_ip(text, text, text)
  from public, anon, authenticated;
grant execute on function public.usage_consume_ip(text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Reporting: pages ingested per user per month.
--
-- Ingestion's real cost is per PAGE (OCR) and per MINUTE (A/V), and both are
-- known only inside the worker, which this migration deliberately does not
-- touch (PR #153 is open on it). What IS knowable from the database is what
-- was actually read: documents.page_count, once ingestion has filled it in.
-- This view is the reporting half of the answer — "how many pages did this
-- account put through in September" — while the handler-side cap at
-- /api/ingest holds the line on request rate and declared file size.
--
-- security_invoker so the view obeys the querying user's RLS on documents
-- instead of the view owner's. Without it a view over documents is a
-- cross-tenant read.
-- ---------------------------------------------------------------------------
drop view if exists public.usage_monthly_pages;
create view public.usage_monthly_pages
  with (security_invoker = true)
as
  select
    d.created_by                                                         as user_id,
    to_char(coalesce(d.ingested_at, d.created_at) at time zone 'utc', 'YYYY-MM') as month_key,
    count(*)                                                             as documents,
    coalesce(sum(d.page_count), 0)                                       as pages,
    coalesce(sum(d.file_size_bytes), 0)                                  as bytes
  from public.documents d
  group by 1, 2;

grant select on public.usage_monthly_pages to authenticated, service_role;
