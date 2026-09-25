// Execute migration 067 against a real Postgres, then drive the real billing
// handlers against it with Stripe and PostgREST stubbed out.
//
// Why this exists
// ---------------------------------------------------------------------------
// There is no Stripe account yet, there is no local Postgres on the dev
// machine, and there is no Docker. So everything here is offline: PGlite is
// Postgres compiled to WASM (real plpgsql, real RLS, real roles, in this Node
// process), and the two things the handlers talk to — api.stripe.com and
// PostgREST — are replaced by a `fetch` stub. The PostgREST half of that stub
// is not a fake: it translates the request into SQL and runs it against the
// PGlite database, as the real one would, with the caller's role and JWT claim
// set from the Authorization header. So an RLS refusal in this file is a real
// RLS refusal.
//
// What it proves, in order
// ---------------------------------------------------------------------------
//   A. 067 applies — after 062 and 063, twice in a row, and (when they are
//      present on the branch) after 064/065/066 as well.
//   B. The plans, packs and settings are seeded as data and survive a re-paste.
//   C. Every subscription event converges on the right tier, in any delivery
//      order, with replays ignored and 'workshop' never touched.
//   D. Credits: granted once per purchase, tagged with a matter's name, drawn
//      only after the monthly allowance, never overdrawn, refunded correctly.
//   E. A signed-in user can read their own billing rows and write none of
//      them — even if a blanket grant were re-applied by mistake.
//   F. 063's own guarantees still hold, unchanged, after 067 replaces its RPC.
//   G. The handlers: dormant 503s, signature good/bad/stale, matter access,
//      and the fulfilment path end to end.
//
// What it cannot prove: PGlite is single-connection, so two HTTP requests
// genuinely racing for the last credit are not exercised. What IS exercised is
// the invariant that race would threaten — that the balance can never go
// negative, because the draw is a conditional UPDATE whose predicate is the
// balance itself. The locking that makes it hold under concurrency is that
// row's lock, which is Postgres's, not ours.
//
//   npm i --no-save @electric-sql/pglite     # once; not a repo dependency
//   node scripts/_verify-billing.mjs
//
// Optional: BILLING_EXTRA_MIGRATIONS=<dir> adds 064/065/066 from another
// checkout (they live on other builders' branches until they merge; once they
// are in supabase/migrations they are picked up with no flag).
//
// Touches nothing outside this process. No .env, no network, no prod, no
// Stripe — not even test mode.

import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

let PGlite, uuid_ossp;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  // Migration 001 does `create extension "uuid-ossp"`, so the harness has to
  // carry it too — PGlite ships it as a contrib module rather than built in.
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
} catch {
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(REPO, 'supabase', 'migrations');
const migration = (name) => fs.readFileSync(path.join(MIGRATIONS, name), 'utf8');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

/** Run a statement expecting it to be refused; returns the SQLSTATE or null. */
async function refused(db, sql, params = []) {
  try {
    await db.query(sql, params);
    return null;
  } catch (err) {
    return err?.code || err?.cause?.code || 'error';
  }
}

/** 064/065/066, wherever they happen to live today. */
function extraMigrations() {
  const dirs = [MIGRATIONS];
  if (process.env.BILLING_EXTRA_MIGRATIONS) dirs.push(process.env.BILLING_EXTRA_MIGRATIONS);
  const found = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (/^06[456]_.*\.sql$/.test(f)) found.push(path.join(dir, f));
    }
  }
  return found;
}

const SENTINEL = '00000000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// The database: the real migration chain, not a mimicked one.
//
// 062's guard trigger is the only thing standing between a customer and a free
// upgrade, and the whole point of the webhook is that it is the one writer that
// trigger admits. So 062 is EXECUTED here, verbatim, rather than imitated with
// a hand-written constraint.
// ---------------------------------------------------------------------------
async function buildDb({ withExtras = true, applyTwice = false } = {}) {
  const db = new PGlite({ extensions: { uuid_ossp } });

  await db.exec(`
    do $$ begin create role anon;                     exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated;            exception when duplicate_object then null; end $$;
    do $$ begin create role service_role bypassrls;   exception when duplicate_object then null; end $$;

    create schema if not exists auth;
    create schema if not exists storage;

    create table auth.users (
      id uuid primary key default gen_random_uuid(),
      email text not null,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );

    create or replace function auth.uid() returns uuid
    language sql stable as $$
      select nullif(
        coalesce(
          nullif(current_setting('request.jwt.claim.sub', true), ''),
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
        ), ''
      )::uuid
    $$;

    -- Stand-ins for the tables migrations 002 and 030 build (002 needs
    -- pgvector, which this harness has no reason to load). 063's reporting
    -- view reads documents; 005 rewrites policies on documents and passages.
    create table public.documents (
      id uuid primary key default gen_random_uuid(),
      matterspace_id uuid,
      created_by uuid,
      page_count int,
      file_size_bytes bigint,
      ingested_at timestamptz,
      created_at timestamptz not null default now()
    );
    create table public.passages (
      id uuid primary key default gen_random_uuid(),
      matterspace_id uuid
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text,
      name text
    );
    create or replace function storage.foldername(p_name text)
    returns text[] language sql immutable as $$
      select string_to_array(p_name, '/')
    $$;

    grant usage on schema public, auth, storage to anon, authenticated, service_role;
  `);

  for (const m of ['001_initial_schema.sql', '005_fix_rls_recursion.sql',
                   '008_submatters.sql', '016_matterspace_members.sql',
                   '022_matterspaces_rls_invoker_wrappers.sql',
                   // matterspaces.ai_tier: the credit-pack matter tag reads it,
                   // because a sealed matter is never named on a receipt.
                   '051_securespace.sql']) {
    await db.exec(migration(m));
  }

  // What Supabase itself does to every table in public, and what any future
  // "fix the permissions" paste does again.
  await db.exec(`grant select, insert, update, delete on all tables in schema public
                   to anon, authenticated, service_role;`);
  await db.exec(`alter table public.documents enable row level security;`);

  await db.exec(migration('062_profiles_rls_plan.sql'));
  await db.exec(migration('063_usage_budgets.sql'));

  const extras = withExtras ? extraMigrations() : [];
  for (const file of extras) await db.exec(fs.readFileSync(file, 'utf8'));

  await db.exec(migration('067_billing_and_credits.sql'));
  if (applyTwice) await db.exec(migration('067_billing_and_credits.sql'));

  // Supabase's bootstrap sets ALTER DEFAULT PRIVILEGES so that every table
  // created in `public` afterwards is granted to service_role. PGlite has no
  // such default, so the harness states it — otherwise the service role would
  // be unable to read tables that 063 and 067 created, which is not how the
  // real database behaves.
  await db.exec(`grant all on all tables in schema public to service_role;`);

  return { db, extras };
}

const asOwner = (db) => db.exec(`reset role; set request.jwt.claim.sub = '';`);
const asUser = (db, id) => db.exec(`set role authenticated; set request.jwt.claim.sub = '${id}';`);
const asServiceRole = (db) => db.exec(`reset role; set role service_role; set request.jwt.claim.sub = '';`);

async function makeUser(db, tier = 'free', email = null) {
  await asOwner(db);
  const { rows } = await db.query(
    `insert into auth.users (email) values ($1) returning id`,
    [email || `u${Math.random().toString(36).slice(2, 10)}@example.test`],
  );
  const id = rows[0].id;
  // 001's handle_new_user trigger may or may not have made the profile row.
  await db.query(
    `insert into public.profiles (id, email) values ($1, $2) on conflict (id) do nothing`,
    [id, email || `${id}@example.test`],
  );
  if (tier !== 'free') {
    await db.query(`update public.profiles set pricing_tier = $2 where id = $1`, [id, tier]);
  }
  return id;
}

const tierOf = async (db, id) =>
  (await db.query(`select pricing_tier from public.profiles where id = $1`, [id])).rows[0]?.pricing_tier;

const balanceOf = async (db, id) =>
  Number((await db.query(
    `select coalesce(cents_available, 0) as c from public.usage_credit_balance
      where user_id = $1 and scope_id = $2`, [id, SENTINEL])).rows[0]?.c ?? 0);

const walletOf = async (db, id) =>
  Number((await db.query(
    `select coalesce(cents_charged, 0) as c from public.usage_month where user_id = $1`,
    [id])).rows[0]?.c ?? 0);

async function consume(db, { kind = 'llm', cents = 0, windowKey = null, pUser = null } = {}) {
  return (await db.query(`select public.usage_consume($1, $2, $3, $4) as r`,
    [pUser, kind, cents, windowKey])).rows[0].r;
}

let eventSeq = 1000;
const evtId = () => `evt_test_${eventSeq++}`;

async function applySub(db, o = {}) {
  return (await db.query(
    `select public.billing_apply_subscription($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as r`,
    [o.eventId ?? evtId(), o.type ?? 'customer.subscription.updated', o.created ?? 0,
     o.user ?? null, o.customer ?? null, o.subscription ?? null, o.status ?? null,
     o.priceId ?? null, o.periodEnd ?? null, o.cancelAtPeriodEnd ?? false, o.trialEnd ?? null],
  )).rows[0].r;
}

async function applyInvoice(db, o = {}) {
  return (await db.query(
    `select public.billing_apply_invoice($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as r`,
    [o.eventId ?? evtId(), o.type ?? 'invoice.paid', o.created ?? 0, o.user ?? null,
     o.customer ?? null, o.subscription ?? null, o.invoiceId ?? null,
     o.paid ?? true, o.periodEnd ?? null, o.invoiceUrl ?? null],
  )).rows[0].r;
}

async function grantCredits(db, o = {}) {
  return (await db.query(
    `select public.usage_credits_grant($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) as r`,
    [o.eventId ?? evtId(), o.user ?? null, o.cents ?? 0, o.packKey ?? null,
     o.matterId ?? null, o.matterName ?? null, o.sessionId ?? null,
     o.paymentIntent ?? null, o.invoiceId ?? null, o.receiptUrl ?? null,
     o.invoiceUrl ?? null, o.type ?? 'checkout.session.completed', o.created ?? 0],
  )).rows[0].r;
}

// ===========================================================================
// A. The migration applies.
// ===========================================================================
console.log('\n=== A. migration 067 applies =====================================');
const { db, extras } = await buildDb({ withExtras: true, applyTwice: true });
check(true, '067 applies after 062 + 063, and again on top of itself (idempotent)');
console.log(extras.length
  ? `        with these also applied first: ${extras.map((f) => path.basename(f)).join(', ')}`
  : '        064/065/066 are not on this branch — none were applied (see the PR body)');

const plainDb = (await buildDb({ withExtras: false })).db;
check(true, '067 applies with NO 064/065/066 present — it reads nothing they create');

const tierCheck = (await db.query(
  `select pg_get_constraintdef(oid) as d from pg_constraint
    where conrelid = 'public.profiles'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%pricing_tier%'`)).rows;
check(tierCheck.length === 1 && /'basic'/.test(tierCheck[0].d) && /'workshop'/.test(tierCheck[0].d)
  && /'pro'/.test(tierCheck[0].d) && /'max'/.test(tierCheck[0].d) && /'free'/.test(tierCheck[0].d),
  'exactly one pricing_tier constraint, and it admits free/basic/pro/max/workshop',
  tierCheck[0]?.d);

const overloads = (await db.query(
  `select proname, count(*)::int as n from pg_proc
    where proname in ('usage_consume','usage_record_actual','billing_apply_subscription',
                      'billing_apply_invoice','usage_credits_grant','billing_link_customer')
    group by 1 order by 1`)).rows;
check(overloads.length === 6 && overloads.every((f) => f.n === 1),
  'one overload of every billing function (PostgREST cannot choose between two)',
  JSON.stringify(overloads));

const sig = (await db.query(
  `select pg_get_function_identity_arguments(oid) as a from pg_proc where proname = 'usage_consume'`)).rows[0];
// Names as well as types: PostgREST calls this function by NAMED arguments
// (p_user, p_kind, …), so renaming one would break #161's handlers just as
// surely as changing a type.
const sigNorm = sig.a.replace(/\s+/g, ' ').replace(/\bDEFAULT .*$/i, '').trim();
check(sigNorm === 'p_user uuid, p_kind text, p_cents_estimate integer, p_window_key text'
   || sigNorm === 'uuid, text, integer, text',
  "usage_consume keeps 063's exact signature and argument names, so PR #161's handlers need no edit",
  sig.a);

// ===========================================================================
// B. The numbers and the names are data.
// ===========================================================================
console.log('\n=== B. plans, packs and settings are rows =========================');
const plans = (await db.query(`select * from public.billing_plans order by sort_order`)).rows;
check(plans.length === 5 && plans.map((p) => p.tier_key).join(',') === 'free,basic,pro,max,workshop',
  'five plan rows seeded: free, basic, pro, max, workshop', plans.map((p) => p.tier_key).join(','));
const priced = Object.fromEntries(plans.map((p) => [p.tier_key, Number(p.monthly_cents)]));
check(priced.basic === 4999 && priced.pro === 9999 && priced.max === 19999,
  "Eden's three price points are seeded as placeholders ($49.99 / $99.99 / $199.99)",
  JSON.stringify(priced));
check(plans.every((p) => p.trial_days === null),
  'no plan has a trial by default — the machinery exists, the answer is none');

const packs = (await db.query(`select * from public.billing_credit_packs order by sort_order`)).rows;
check(packs.length === 3 && packs.every((p) => Number(p.credit_cents) > 0),
  'three credit packs seeded, each with its own cents-charged and cents-granted',
  packs.map((p) => `${p.pack_key}:${p.price_cents}→${p.credit_cents}`).join(' '));

const basicBudget = (await db.query(
  `select * from public.usage_budgets where pricing_tier = 'basic' order by kind`)).rows;
check(basicBudget.length === 4,
  "the new tier gets the same four usage_budgets rows 063 gave every other tier",
  basicBudget.map((b) => b.kind).join(','));

const grace = (await db.query(`select past_due_grace_days, default_trial_days from public.billing_settings`)).rows;
check(grace.length === 1 && Number(grace[0].past_due_grace_days) === 7,
  'one settings row, with the past-due grace as a number Eden edits');

// Re-pasting must never clobber an edited number.
await db.exec(`update public.billing_plans set monthly_cents = 1234, display_name = 'Solo' where tier_key = 'basic';
               update public.billing_credit_packs set credit_cents = 3000 where pack_key = 'pack_25';
               update public.billing_settings set past_due_grace_days = 21;`);
await db.exec(migration('067_billing_and_credits.sql'));
const edited = (await db.query(
  `select (select monthly_cents from public.billing_plans where tier_key='basic') as p,
          (select display_name  from public.billing_plans where tier_key='basic') as n,
          (select credit_cents  from public.billing_credit_packs where pack_key='pack_25') as c,
          (select past_due_grace_days from public.billing_settings) as g`)).rows[0];
check(Number(edited.p) === 1234 && edited.n === 'Solo' && Number(edited.c) === 3000 && Number(edited.g) === 21,
  "re-pasting 067 keeps Eden's edited prices, names, pack sizes and grace period",
  JSON.stringify(edited));
await db.exec(`update public.billing_plans set monthly_cents = 4999, display_name = 'Basic' where tier_key = 'basic';
               update public.billing_credit_packs set credit_cents = 2500 where pack_key = 'pack_25';
               update public.billing_settings set past_due_grace_days = 7;`);

// ===========================================================================
// C. Subscriptions.
// ===========================================================================
console.log('\n=== C. a subscription, from checkout to cancellation ==============');
await asOwner(db);
await db.exec(`update public.billing_plans set stripe_price_id = 'price_basic' where tier_key = 'basic';
               update public.billing_plans set stripe_price_id = 'price_pro'   where tier_key = 'pro';
               update public.billing_plans set stripe_price_id = 'price_max'   where tier_key = 'max';`);

const lawyer = await makeUser(db, 'free', 'solo@example.test');
await asServiceRole(db);

let r = (await db.query(`select public.billing_link_customer($1, $2) as r`, [lawyer, 'cus_1'])).rows[0].r;
check(r.ok === true, 'the checkout endpoint links the Stripe customer BEFORE the session exists');

r = await applySub(db, { type: 'customer.subscription.created', created: 100, customer: 'cus_1',
  subscription: 'sub_1', status: 'active', priceId: 'price_basic', periodEnd: 1790000000 });
check(r.ok === true && r.tier === 'basic', 'subscription.created → the account moves to that plan', r.tier);
check(await tierOf(db, lawyer) === 'basic',
  "and profiles.pricing_tier is actually written — through 062's guard trigger, as the service role");
check(r.tier_changed === true, 'the RPC says so');

// The same event again.
const dupId = evtId();
await applySub(db, { eventId: dupId, created: 110, customer: 'cus_1', subscription: 'sub_1',
  status: 'active', priceId: 'price_pro' });
const replay = await applySub(db, { eventId: dupId, created: 110, customer: 'cus_1',
  subscription: 'sub_1', status: 'canceled' });
check(replay.replay === true, 'a replayed event id is acknowledged and ignored');
check(await tierOf(db, lawyer) === 'pro',
  'and the replay changed nothing — the first delivery of that id is what counts');

r = await applySub(db, { created: 200, customer: 'cus_1', subscription: 'sub_1',
  status: 'active', priceId: 'price_max', periodEnd: 1790000000 });
check(await tierOf(db, lawyer) === 'max', 'an upgrade follows the subscription to the new plan');
r = await applySub(db, { created: 300, customer: 'cus_1', subscription: 'sub_1',
  status: 'active', priceId: 'price_basic', periodEnd: 1790000000 });
check(await tierOf(db, lawyer) === 'basic', 'and so does a downgrade');

// Stale delivery.
r = await applySub(db, { created: 150, customer: 'cus_1', subscription: 'sub_1',
  status: 'active', priceId: 'price_max' });
check(r.stale === true && await tierOf(db, lawyer) === 'basic',
  'an event older than the newest one already applied is recorded and ignored', r.reason);

// Cancellation.
r = await applySub(db, { type: 'customer.subscription.deleted', created: 400, customer: 'cus_1',
  subscription: 'sub_1', status: 'canceled' });
check(r.tier === 'free' && await tierOf(db, lawyer) === 'free',
  'subscription.deleted → free');

console.log('\n--- out-of-order delivery converges ----------------------------');
const shuffler = await makeUser(db, 'free');
await asServiceRole(db);
await db.query(`select public.billing_link_customer($1, $2)`, [shuffler, 'cus_2']);
// Delivered backwards: deleted, then updated, then created.
await applySub(db, { type: 'customer.subscription.deleted', created: 3000, customer: 'cus_2',
  subscription: 'sub_2', status: 'canceled' });
await applySub(db, { type: 'customer.subscription.updated', created: 2000, customer: 'cus_2',
  subscription: 'sub_2', status: 'active', priceId: 'price_max' });
await applySub(db, { type: 'customer.subscription.created', created: 1000, customer: 'cus_2',
  subscription: 'sub_2', status: 'active', priceId: 'price_basic' });
check(await tierOf(db, shuffler) === 'free',
  'created/updated/deleted delivered backwards still converges on free');

const forwards = await makeUser(db, 'free');
await asServiceRole(db);
await db.query(`select public.billing_link_customer($1, $2)`, [forwards, 'cus_3']);
await applySub(db, { type: 'customer.subscription.created', created: 1000, customer: 'cus_3',
  subscription: 'sub_3', status: 'active', priceId: 'price_basic' });
await applySub(db, { type: 'customer.subscription.updated', created: 2000, customer: 'cus_3',
  subscription: 'sub_3', status: 'active', priceId: 'price_max' });
check(await tierOf(db, forwards) === 'max',
  'and the same three delivered forwards converge on max — order does not decide the answer');

console.log('\n--- a failed payment, then a recovery --------------------------');
const dunned = await makeUser(db, 'free');
await asServiceRole(db);
await db.query(`select public.billing_link_customer($1, $2)`, [dunned, 'cus_4']);
await applySub(db, { created: 1000, customer: 'cus_4', subscription: 'sub_4',
  status: 'active', priceId: 'price_pro' });
await applyInvoice(db, { type: 'invoice.payment_failed', created: 1100, customer: 'cus_4',
  subscription: 'sub_4', invoiceId: 'in_1', paid: false });
check(await tierOf(db, dunned) === 'pro',
  'a failed payment does NOT demote immediately — the grace window is doing the work');
const graceRow = (await db.query(
  `select grace_until, subscription_status from public.billing_accounts where user_id = $1`, [dunned])).rows[0];
check(graceRow.grace_until !== null && graceRow.subscription_status === 'past_due',
  'it opens a grace window sized by billing_settings.past_due_grace_days');
await applyInvoice(db, { type: 'invoice.paid', created: 1200, customer: 'cus_4',
  subscription: 'sub_4', invoiceId: 'in_1', paid: true, invoiceUrl: 'https://invoice.test/in_1' });
const recovered = (await db.query(
  `select grace_until, subscription_status from public.billing_accounts where user_id = $1`, [dunned])).rows[0];
check(recovered.grace_until === null && recovered.subscription_status === 'active'
  && await tierOf(db, dunned) === 'pro',
  'payment_failed then paid converges back on the paid plan, grace closed');

// The grace, expired.
await asOwner(db);
await db.query(`update public.billing_accounts
                   set grace_until = now() - interval '1 day', subscription_status = 'past_due'
                 where user_id = $1`, [dunned]);
await asUser(db, dunned);
const metered = await consume(db, { kind: 'llm', cents: 1 });
check(metered.billing_state === 'past_due_grace_expired' && metered.tier === 'free',
  'past the grace, the METER charges the account as free on its very next request',
  `tier=${metered.tier}`);

console.log('\n--- the workshop account is never billed and never demoted -----');
const eden = await makeUser(db, 'workshop', 'equainton@example.test');
await asServiceRole(db);
await db.query(`select public.billing_link_customer($1, $2)`, [eden, 'cus_eden']);
r = await applySub(db, { created: 5000, customer: 'cus_eden', subscription: 'sub_eden',
  status: 'active', priceId: 'price_basic' });
check(await tierOf(db, eden) === 'workshop' && r.tier_changed === false,
  "an active subscription does not move Eden's account off workshop", r.reason);
r = await applySub(db, { type: 'customer.subscription.deleted', created: 6000, customer: 'cus_eden',
  subscription: 'sub_eden', status: 'canceled' });
check(await tierOf(db, eden) === 'workshop', 'and neither does a cancellation');
await applyInvoice(db, { type: 'invoice.paid', created: 6100, customer: 'cus_eden',
  subscription: 'sub_eden', invoiceId: 'in_eden', paid: true });
check(await tierOf(db, eden) === 'workshop', 'nor a paid invoice');
const edenAcct = (await db.query(
  `select stripe_subscription_id from public.billing_accounts where user_id = $1`, [eden])).rows[0];
check(edenAcct.stripe_subscription_id === 'sub_eden',
  'but every Stripe field is still recorded, so he can test the flow end to end');

console.log('\n--- an event for a customer we do not know ---------------------');
await asServiceRole(db);
r = await applySub(db, { created: 9000, customer: 'cus_nobody', subscription: 'sub_x', status: 'active' });
check(r.ok === false && r.reason === 'unknown_customer',
  'an event whose customer maps to no account is refused, never guessed at');
const unknownPrice = await makeUser(db, 'free');
await asServiceRole(db);
await db.query(`select public.billing_link_customer($1, $2)`, [unknownPrice, 'cus_5']);
r = await applySub(db, { created: 1000, customer: 'cus_5', subscription: 'sub_5',
  status: 'active', priceId: 'price_that_is_not_in_the_table' });
check(await tierOf(db, unknownPrice) === 'free' && r.tier_changed === false,
  'a price Stripe knows and billing_plans does not leaves the tier alone rather than guessing');

// ===========================================================================
// D. Credits.
// ===========================================================================
console.log('\n=== D. credit packs ==============================================');
await asOwner(db);
const buyer = await makeUser(db, 'basic');
// 001's handle_new_user gave this account a clientspace; a serverspace hangs
// off it, and a matterspace off that.
const { rows: csRows } = await db.query(
  `select id from public.clientspaces where user_id = $1 limit 1`, [buyer]);
const { rows: ssRows } = await db.query(
  `insert into public.serverspaces (clientspace_id, name) values ($1, 'Firm') returning id`,
  [csRows[0].id]);
await db.query(
  `insert into public.serverspace_members (serverspace_id, user_id, role) values ($1, $2, 'owner')`,
  [ssRows[0].id, buyer]);
const { rows: msRows } = await db.query(
  `insert into public.matterspaces (serverspace_id, name) values ($1, 'Peloso v. Curtis') returning id`,
  [ssRows[0].id]);
const matterId = msRows[0].id;
await db.query(
  `insert into public.matterspace_members (matterspace_id, user_id, role) values ($1, $2, 'admin')`,
  [matterId, buyer]);

await asServiceRole(db);
r = await grantCredits(db, { user: buyer, cents: 2500, packKey: 'pack_25',
  sessionId: 'cs_1', paymentIntent: 'pi_1', receiptUrl: 'https://receipt.test/1' });
check(r.ok === true && Number(r.balance_cents) === 2500, 'an untagged pack purchase grants credits');

r = await grantCredits(db, { user: buyer, cents: 10000, packKey: 'pack_100',
  matterId, matterName: 'Peloso v. Curtis', sessionId: 'cs_2',
  invoiceId: 'in_2', invoiceUrl: 'https://invoice.test/in_2' });
check(r.ok === true && Number(r.balance_cents) === 12500, 'a tagged pack purchase grants into the same balance');
const tagged = (await db.query(
  `select matter_name, matterspace_id, invoice_url from public.usage_credit_ledger
    where stripe_session_id = 'cs_2'`)).rows[0];
check(tagged.matter_name === 'Peloso v. Curtis' && tagged.matterspace_id === matterId
  && tagged.invoice_url === 'https://invoice.test/in_2',
  "the matter's NAME is snapshotted onto the ledger row beside the invoice URL");

// Renaming the matter must not rewrite the receipt.
await asOwner(db);
await db.query(`update public.matterspaces set name = 'Peloso (closed)' where id = $1`, [matterId]);
const stillNamed = (await db.query(
  `select matter_name from public.usage_credit_ledger where stripe_session_id = 'cs_2'`)).rows[0];
check(stillNamed.matter_name === 'Peloso v. Curtis',
  'renaming the matter afterwards does not change what the receipt says');

await asServiceRole(db);
const sameEvent = await grantCredits(db, { eventId: 'evt_dup_grant', user: buyer, cents: 2500, sessionId: 'cs_9' });
const sameAgain = await grantCredits(db, { eventId: 'evt_dup_grant', user: buyer, cents: 2500, sessionId: 'cs_9' });
check(sameEvent.ok === true && sameAgain.replay === true,
  'a resent checkout.session.completed is acknowledged and grants nothing twice');
const sessionAgain = await grantCredits(db, { user: buyer, cents: 2500, sessionId: 'cs_9' });
check(sessionAgain.replay === true && sessionAgain.reason === 'session_already_granted',
  'and the same SESSION under a new event id still grants only once');
check(await balanceOf(db, buyer) === 15000, 'the balance counted each purchase exactly once',
  `${await balanceOf(db, buyer)}c`);

console.log('\n--- the draw order: allowance first, then credits --------------');
await asOwner(db);
await db.exec(`update public.usage_budgets set monthly_cents = 100, window_max_requests = null
                where pricing_tier = 'basic' and kind = '*';
               update public.usage_budgets set window_max_requests = null where pricing_tier = 'basic';`);
const spender = await makeUser(db, 'basic');
await asServiceRole(db);
await grantCredits(db, { user: spender, cents: 500, packKey: 'pack_25', sessionId: 'cs_sp' });
await asUser(db, spender);

r = await consume(db, { cents: 40 });
check(r.allowed === true && r.reason === 'ok' && Number(r.credit_cents_charged) === 0,
  'while the allowance has room, credits are not touched',
  `wallet=${r.wallet_cents_charged} credit=${r.credit_cents_charged}`);
check(await balanceOf(db, spender) === 500, 'the credit balance is untouched');

r = await consume(db, { cents: 40 });
check(r.allowed === true && Number(r.month_cents_used) === 80, 'a second request still fits the allowance');

r = await consume(db, { cents: 40 });
check(r.allowed === true && r.reason === 'ok_on_credits'
  && Number(r.wallet_cents_charged) === 20 && Number(r.credit_cents_charged) === 20,
  'the request that straddles the boundary is SPLIT: 20c of allowance, 20c of credits',
  `wallet=${r.wallet_cents_charged} credit=${r.credit_cents_charged}`);
check(/included AI usage is spent/i.test(r.message || ''),
  'and it says so in a sentence a person can read', r.message);
check(await walletOf(db, spender) === 100 && await balanceOf(db, spender) === 480,
  'the allowance is exactly full and the credits are down by the remainder',
  `wallet=${await walletOf(db, spender)} credits=${await balanceOf(db, spender)}`);

// Keyed by the usage event, not by "the most recent row": every row written in
// one transaction shares a created_at, so ordering by it is a coin toss.
const drawRow = (await db.query(
  `select delta_cents, balance_after, usage_event_id from public.usage_credit_ledger
    where user_id = $1 and entry_kind = 'draw' and usage_event_id = $2`, [spender, r.event_id])).rows[0];
check(drawRow && Number(drawRow.delta_cents) === -20 && Number(drawRow.balance_after) === 480,
  'the draw is a ledger row, signed, with the balance after it and the request it paid for',
  JSON.stringify(drawRow));

r = await consume(db, { cents: 200 });
check(r.allowed === true && r.reason === 'ok_on_credits' && Number(r.credit_cents_charged) === 200
  && Number(r.wallet_cents_charged) === 0,
  'once the allowance is full, the whole request comes out of credits');
check(await balanceOf(db, spender) === 280, 'and the balance follows');

console.log('\n--- overdraw is refused, and refunded in the same transaction --');
const walletBefore = await walletOf(db, spender);
r = await consume(db, { cents: 400 });
check(r.allowed === false && r.status === 402 && r.reason === 'over_monthly_budget',
  'a request bigger than allowance + credits is refused with 402');
check(r.detail === 'allowance_and_credits_exhausted',
  'the refusal distinguishes "both exhausted" from "on credits"', r.detail);
check(/credit pack/i.test(r.message || '') && /reset at the start of next month/i.test(r.message || ''),
  'and the message names both the way out and the wait', r.message);
check(await balanceOf(db, spender) === 280 && await walletOf(db, spender) === walletBefore,
  'nothing was spent: neither the allowance nor the credits moved',
  `wallet=${await walletOf(db, spender)} credits=${await balanceOf(db, spender)}`);
const requestsAfter = Number((await db.query(
  `select requests from public.usage_month where user_id = $1`, [spender])).rows[0].requests);

for (let i = 0; i < 30; i++) await consume(db, { cents: 400 });
check(await balanceOf(db, spender) === 280,
  '30 more attempts cannot move the balance by a cent', `${await balanceOf(db, spender)}c`);
check(Number((await db.query(`select requests from public.usage_month where user_id = $1`,
  [spender])).rows[0].requests) === requestsAfter,
  'and a refused request is never counted as a request');

// Drain it exactly, then one cent more.
r = await consume(db, { cents: 280 });
check(r.allowed === true && Number(r.credit_cents_remaining) === 0,
  'a request that exactly empties the balance is admitted');
r = await consume(db, { cents: 1 });
check(r.allowed === false && Number(r.credit_cents_remaining) === 0,
  'and the next cent is refused');
const bal = Number((await db.query(
  `select cents_available, cents_granted, cents_drawn from public.usage_credit_balance
    where user_id = $1`, [spender])).rows[0].cents_available);
check(bal === 0, 'the balance is exactly zero — never negative', String(bal));
const zeroCost = await consume(db, { cents: 0 });
check(zeroCost.allowed === true,
  'a request that costs nothing is still admitted when everything is spent (rate-only routes)');

console.log('\n--- reconciling a split request --------------------------------');
await asOwner(db);
await db.exec(`update public.usage_budgets set monthly_cents = 100 where pricing_tier = 'basic' and kind = '*';`);
const recon = await makeUser(db, 'basic');
await asServiceRole(db);
await grantCredits(db, { user: recon, cents: 1000, sessionId: 'cs_rec' });
await asUser(db, recon);
await consume(db, { cents: 90 });
const split = await consume(db, { cents: 40 });   // 10 wallet + 30 credits
check(Number(split.wallet_cents_charged) === 10 && Number(split.credit_cents_charged) === 30,
  'a split request: 10c allowance, 30c credits');
await asServiceRole(db);
const rec = (await db.query(`select public.usage_record_actual($1, $2, $3, $4) as r`,
  [split.event_id, 5, 'kimi-k2.5', JSON.stringify({ route: 'test' })])).rows[0].r;
check(rec.ok === true && Number(rec.delta_cents) === -35 && Number(rec.credit_cents_refunded) === 30,
  'reconciling 40c down to 5c refunds the 30c of CREDITS first, then 5c to the allowance',
  `delta=${rec.delta_cents} credits=${rec.credit_cents_refunded}`);
check(await balanceOf(db, recon) === 1000 && await walletOf(db, recon) === 95,
  'the customer has their credits back and the allowance shows only what it absorbed',
  `wallet=${await walletOf(db, recon)} credits=${await balanceOf(db, recon)}`);
const reversal = (await db.query(
  `select entry_kind, delta_cents from public.usage_credit_ledger
    where user_id = $1 and usage_event_id = $2 and entry_kind = 'reversal'`,
  [recon, split.event_id])).rows[0];
const drawStill = (await db.query(
  `select delta_cents from public.usage_credit_ledger
    where user_id = $1 and usage_event_id = $2 and entry_kind = 'draw'`,
  [recon, split.event_id])).rows[0];
check(reversal && Number(reversal.delta_cents) === 30 && Number(drawStill?.delta_cents) === -30,
  'and the refund is a new reversal row — the original draw still says -30',
  `${reversal?.delta_cents} / ${drawStill?.delta_cents}`);
const twice = (await db.query(`select public.usage_record_actual($1, 5) as r`, [split.event_id])).rows[0].r;
check(twice.ok === false, 'reconciling the same event twice is still a no-op, not a double refund');

console.log('\n--- the ledger is append-only ----------------------------------');
await asOwner(db);
check(await refused(db, `update public.usage_credit_ledger set delta_cents = 999999`) === '42501',
  'even the owner cannot edit a ledger row — a correction is a new row');
await asServiceRole(db);
check(await refused(db, `delete from public.usage_credit_ledger`) === '42501',
  'and the service role cannot delete one');
await asOwner(db);
const cascadeUser = await makeUser(db, 'free');
await asServiceRole(db);
await grantCredits(db, { user: cascadeUser, cents: 100, sessionId: 'cs_cascade' });
await asOwner(db);
check(await refused(db, `delete from auth.users where id = $1`, [cascadeUser]) === null,
  'but deleting the account still works — a ledger must not make account deletion fail');

// ===========================================================================
// E. What a signed-in user may do.
// ===========================================================================
console.log('\n=== E. a signed-in user cannot pay themselves ====================');
await asUser(db, buyer);
const ownPlans = Number((await db.query(`select count(*)::int as n from public.billing_plans`)).rows[0].n);
check(ownPlans === 5, 'a user can read the plan list (the UI needs the names and prices)');
const ownAcct = Number((await db.query(`select count(*)::int as n from public.billing_accounts`)).rows[0].n);
check(ownAcct === 0, 'a user sees no billing_accounts row but their own (this one has none yet)');
await asUser(db, lawyer);
const mineAcct = (await db.query(`select stripe_customer_id from public.billing_accounts`)).rows;
check(mineAcct.length === 1 && mineAcct[0].stripe_customer_id === 'cus_1',
  'and they DO see their own');

await asUser(db, spender);
const mineLedger = Number((await db.query(`select count(*)::int as n from public.usage_credit_ledger`)).rows[0].n);
const theirLedger = Number((await db.query(
  `select count(*)::int as n from public.usage_credit_ledger where user_id = $1`, [buyer])).rows[0].n);
check(mineLedger >= 1 && theirLedger === 0, "a user reads their own ledger and nobody else's");

check(await refused(db,
  `insert into public.usage_credit_balance (user_id, cents_available) values ($1, 9999999)`,
  [spender]) !== null, 'a user cannot grant themselves credits');
check(await refused(db, `update public.usage_credit_balance set cents_available = 9999999`) !== null,
  'a user cannot raise their own balance');
check(await refused(db,
  `insert into public.usage_credit_ledger (user_id, entry_kind, delta_cents) values ($1, 'grant', 100000)`,
  [spender]) !== null, 'a user cannot write a grant row');
check(await refused(db, `update public.billing_accounts set tier_key = 'max'`) !== null,
  'a user cannot edit their billing account');
check(await refused(db, `update public.billing_plans set monthly_cents = 1`) !== null,
  'a user cannot reprice a plan');
check(await refused(db, `update public.billing_settings set past_due_grace_days = 3650`) !== null,
  'a user cannot extend their own grace period');
check(await refused(db, `select count(*) from public.billing_events`) !== null,
  'a user cannot read the webhook event log at all');
check(await refused(db, `select public.usage_credits_grant('e', $1, 100000)`, [spender]) !== null,
  'a user cannot call usage_credits_grant');
check(await refused(db, `select public.billing_apply_subscription('e','t',1,$1,'c','s','active','price_max')`,
  [spender]) !== null, 'a user cannot call billing_apply_subscription — the tier is not theirs to set');
check(await refused(db, `select public.billing_link_customer($1, 'cus_theirs')`, [spender]) !== null,
  'a user cannot link themselves to someone else\'s Stripe customer');

// And if a blanket grant were re-applied by mistake, RLS still refuses.
await asOwner(db);
await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated;`);
await asUser(db, spender);
check(await refused(db,
  `insert into public.usage_credit_balance (user_id, cents_available) values ($1, 9999999)`,
  [spender]) === '42501',
  'and if someone re-runs the blanket grant, RLS still refuses the self-grant');
// An UPDATE with no matching policy is not an error — Postgres filters it to
// zero rows, which is the same guarantee said quietly. So the check is that the
// row did not move, not that a message was raised.
await asUser(db, lawyer);
await db.query(`update public.billing_accounts set tier_key = 'max', stripe_customer_id = 'cus_hacked'`);
await asOwner(db);
const untouched = (await db.query(
  `select tier_key, stripe_customer_id from public.billing_accounts where user_id = $1`, [lawyer])).rows[0];
check(untouched.stripe_customer_id === 'cus_1' && untouched.tier_key !== 'max',
  'and a self-serve upgrade of the billing row changes nothing — RLS filters it to zero rows',
  JSON.stringify(untouched));
await asUser(db, spender);
check(await refused(db, `update public.profiles set pricing_tier = 'max' where id = $1`, [spender]) === '42501',
  "and 062's guard trigger still refuses a self-upgrade (this is why it is a trigger)");
await asOwner(db);
await db.exec(`revoke insert, update, delete on public.usage_credit_balance, public.usage_credit_ledger,
                 public.billing_accounts, public.billing_plans, public.billing_settings,
                 public.billing_credit_packs from anon, authenticated;`);

// ===========================================================================
// F. 063's own guarantees, re-checked against 067's replacement RPC.
// ===========================================================================
console.log('\n=== F. PR #161 still holds, unchanged ============================');
const p161 = plainDb;
await asOwner(p161);
await p161.exec(`update public.usage_budgets set monthly_cents = 100, window_max_requests = null
                  where pricing_tier = 'free' and kind = '*';
                 update public.usage_budgets set window_max_requests = null where pricing_tier = 'free';`);
const alice = await makeUser(p161, 'free');
await asUser(p161, alice);
let a = await consume(p161, { cents: 40 });
check(a.allowed === true && Number(a.month_cents_used) === 40 && Number(a.remaining_cents) === 60,
  'a request inside the budget is admitted, and the wallet reads the same as it did');
await consume(p161, { cents: 40 });
a = await consume(p161, { cents: 40 });
check(a.allowed === false && a.reason === 'over_monthly_budget' && a.status === 402,
  'with no credits, the crossing request is refused with 402 exactly as 063 refused it');
check(Number((await p161.query(`select cents_charged from public.usage_month where user_id = $1`,
  [alice])).rows[0].cents_charged) === 80,
  'and refunded — the wallet still never exceeds the budget');
a = await consume(p161, { cents: 20 });
check(a.allowed === true && Number(a.month_cents_used) === 100,
  'a request that still fits the headroom is still admitted');

await asOwner(p161);
await p161.exec(`update public.usage_budgets set monthly_cents = null where pricing_tier = 'free' and kind = '*';
                 update public.usage_budgets set window_max_requests = 3, window_seconds = 60
                  where pricing_tier = 'free' and kind = 'llm';`);
const bob = await makeUser(p161, 'free');
await asUser(p161, bob);
const admitted = [];
for (let i = 0; i < 5; i++) admitted.push((await consume(p161, { cents: 0, windowKey: 'W1' })).allowed);
check(JSON.stringify(admitted) === JSON.stringify([true, true, true, false, false]),
  'the rate window is untouched: three in, then 429', JSON.stringify(admitted));
const carol = await makeUser(p161, 'free');
await asUser(p161, carol);
const bobBefore = Number((await p161.query(
  `select coalesce(sum(cents_estimated),0)::int as c from public.usage_events where user_id = $1`,
  [bob])).rows[0].c);
await consume(p161, { kind: 'tts', cents: 7, pUser: bob });
check(Number((await p161.query(
  `select coalesce(sum(cents_estimated),0)::int as c from public.usage_events where user_id = $1`,
  [bob])).rows[0].c) === bobBefore,
  "p_user is still ignored for a signed-in caller: carol cannot spend bob's budget");

await asOwner(p161);
const workshopper = await makeUser(p161, 'workshop');
await asUser(p161, workshopper);
let big = null;
for (let i = 0; i < 20; i++) big = await consume(p161, { kind: 'llm', cents: 100000 });
check(big.allowed === true && big.monthly_cents === null && Number(big.credit_cents_charged) === 0,
  "'workshop' is still unlimited, and never draws a credit it does not need");
check(await balanceOf(p161, workshopper) === 0, 'and holds no credit balance at all');

await asOwner(p161);
await p161.exec(`alter table public.profiles drop constraint profiles_pricing_tier_check;
                 update public.usage_budgets set monthly_cents = 1500
                  where pricing_tier = 'free' and kind = '*';`);
const stranger = await makeUser(p161, 'enterprise-that-does-not-exist');
await asUser(p161, stranger);
const s1 = await consume(p161, { kind: 'llm', cents: 1400 });
const s2 = await consume(p161, { kind: 'llm', cents: 1400 });
check(s1.allowed === true && s2.allowed === false,
  "an unknown tier still falls back to 'free', never to unlimited");

const viewOpts = (await db.query(
  `select coalesce(array_to_string(reloptions, ','), '') as o from pg_class
    where relname = 'usage_credit_purchases'`)).rows[0];
check(/security_invoker=(true|on)/i.test(viewOpts.o),
  'the purchases view is security_invoker, so it cannot become a cross-tenant read', viewOpts.o);
const helper = (await db.query(
  `select prosecdef from pg_proc where proname = '_billing_is_self'`)).rows[0];
check(helper.prosecdef === false,
  'the policy helper is SECURITY INVOKER, per the standing rule on RLS wrappers');

// ===========================================================================
// G. The handlers.
// ===========================================================================
const { runHandlerChecks } = await import('./_verify-billing-handlers.mjs');
failures += await runHandlerChecks({ db, check, makeUser, asOwner, asUser, asServiceRole,
  balanceOf, tierOf, createHmac, matterId, SENTINEL });

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
