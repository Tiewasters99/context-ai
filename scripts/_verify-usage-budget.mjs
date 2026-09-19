// Execute migration 063 against a real Postgres and prove the spend cap.
//
// Why this exists
// ---------------------------------------------------------------------------
// There is no local Postgres on the dev machine and no Docker, so migrations
// have shipped parse-checked only — which is how 044 shipped a CASE-to-enum
// bug that stopped the whole queue. PGlite is Postgres compiled to WASM: real
// plpgsql, real RLS, real roles, in this Node process. This script builds the
// handful of tables 063 references, runs the ACTUAL migration file, and then
// tries to break it.
//
// It runs the migration TWICE, in two separate databases:
//   A. without migration 062 — profiles.pricing_tier still checks
//      ('free','pro','max'), which is what production has today;
//   B. with 062's constraint — ('free','pro','max','workshop').
// 063 must apply cleanly either way, because 062 belongs to another builder
// and neither of us controls the paste order.
//
// What it cannot prove: PGlite is single-connection, so two HTTP requests
// racing for the last cent is not exercised here. What IS exercised is the
// invariant that race would threaten — that the recorded spend never exceeds
// the budget, because the crossing request is refunded inside the same
// transaction. The locking that makes it hold under concurrency is
// INSERT … ON CONFLICT DO UPDATE's row lock, which is Postgres's, not ours.
//
//   npm i --no-save @electric-sql/pglite     # once; not a repo dependency
//   node scripts/_verify-usage-budget.mjs
//
// Touches nothing outside this process. No .env, no network, no prod.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationSql = (name) => {
  const p = path.resolve(__dirname, '..', 'supabase', 'migrations', name);
  return fs.readFileSync(p, 'utf8');
};

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

/** Run a statement expecting it to be refused; returns the SQLSTATE or null. */
async function refused(db, sql) {
  try {
    await db.exec(sql);
    return null;
  } catch (err) {
    return err?.code || err?.cause?.code || 'error';
  }
}

/**
 * A database with the stub schema 063 references, plus 063 itself.
 * `with062` decides whether profiles.pricing_tier already accepts 'workshop'.
 */
async function buildDb({ with062 }) {
  const db = new PGlite();
  const tiers = with062
    ? `'free', 'pro', 'max', 'workshop'`
    : `'free', 'pro', 'max'`;

  await db.exec(`
    do $$ begin create role anon;          exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role;  exception when duplicate_object then null; end $$;

    -- Supabase's auth schema, reduced to what 063 touches: the users table it
    -- keys foreign keys to, and auth.uid(), which reads the request's JWT
    -- claim exactly as it does on the real database.
    create schema if not exists auth;
    create table auth.users (id uuid primary key default gen_random_uuid());
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated, service_role;

    create table public.profiles (
      id uuid primary key references auth.users(id) on delete cascade,
      email text not null default '',
      pricing_tier text not null default 'free' check (pricing_tier in (${tiers}))
    );

    create table public.matterspaces (id uuid primary key default gen_random_uuid());
    create table public.documents (
      id uuid primary key default gen_random_uuid(),
      matterspace_id uuid references public.matterspaces(id),
      page_count int,
      file_size_bytes bigint,
      ingested_at timestamptz,
      created_by uuid references public.profiles(id),
      created_at timestamptz not null default now()
    );
    alter table public.documents enable row level security;

    grant usage on schema public to anon, authenticated, service_role;
    grant all on all tables in schema public to service_role;
    grant select on public.documents, public.profiles to authenticated;
  `);

  await db.exec(migrationSql('063_usage_budgets.sql'));
  return db;
}

/** Make a user with a tier, and return its id. Always runs as the owner. */
async function makeUser(db, tier) {
  await db.exec(`reset role; set request.jwt.claim.sub = '';`);
  const { rows } = await db.query(`insert into auth.users default values returning id`);
  const id = rows[0].id;
  await db.query(`insert into public.profiles (id, email, pricing_tier) values ($1, $2, $3)`, [id, `${id}@example.test`, tier]);
  return id;
}

const asUser = (db, id) => db.exec(`set role authenticated; set request.jwt.claim.sub = '${id}';`);
const asService = (db) => db.exec(`reset role; set request.jwt.claim.sub = '';`);

async function consume(db, { kind = 'llm', cents = 0, windowKey = null, pUser = null }) {
  const { rows } = await db.query(
    `select public.usage_consume($1, $2, $3, $4) as r`,
    [pUser, kind, cents, windowKey],
  );
  return rows[0].r;
}

// ===========================================================================
// A. Production as it is today: 062 not applied.
// ===========================================================================
console.log('\n=== A. migration 063 WITHOUT 062 =================================');
const dbA = await buildDb({ with062: false });
check(true, '063 applies to a database whose pricing_tier check is (free, pro, max)');

const seeds = (await dbA.query(`select pricing_tier, kind, monthly_cents from public.usage_budgets order by 1, 2`)).rows;
check(seeds.length >= 14, 'the placeholder budget rows are seeded', `${seeds.length} rows`);
const workshopRow = seeds.find((r) => r.pricing_tier === 'workshop' && r.kind === '*');
check(workshopRow && workshopRow.monthly_cents === null,
  "the 'workshop' row exists and is unlimited even though this database cannot yet hold that tier");

// Re-running the file must not clobber edited numbers.
await dbA.exec(`update public.usage_budgets set monthly_cents = 12345 where pricing_tier = 'free' and kind = '*'`);
await dbA.exec(migrationSql('063_usage_budgets.sql'));
const edited = (await dbA.query(`select monthly_cents from public.usage_budgets where pricing_tier='free' and kind='*'`)).rows[0];
check(Number(edited.monthly_cents) === 12345, 're-pasting 063 keeps Eden\'s edited numbers (on conflict do nothing)');
await dbA.exec(`update public.usage_budgets set monthly_cents = 1500 where pricing_tier = 'free' and kind = '*'`);

// --- the budget -------------------------------------------------------------
console.log('\n--- the monthly budget -----------------------------------------');
// A tier with a small, knowable wallet: 100 cents, no rate limit in the way.
await dbA.exec(`
  update public.usage_budgets
     set monthly_cents = 100, window_max_requests = null
   where pricing_tier = 'free' and kind = '*';
  update public.usage_budgets
     set window_max_requests = null
   where pricing_tier = 'free';
`);

const alice = await makeUser(dbA, 'free');
await asUser(dbA, alice);

let r = await consume(dbA, { cents: 40 });
check(r.allowed === true && r.reason === 'ok', 'a request inside the budget is admitted');
check(Number(r.month_cents_used) === 40 && Number(r.remaining_cents) === 60,
  'the wallet shows what was spent and what is left', `used=${r.month_cents_used} left=${r.remaining_cents}`);
const firstEvent = r.event_id;

r = await consume(dbA, { cents: 40 });
check(r.allowed === true && Number(r.month_cents_used) === 80, 'a second request inside the budget is admitted');

r = await consume(dbA, { cents: 40 });
check(r.allowed === false && r.reason === 'over_monthly_budget' && r.status === 402,
  'the request that would cross the budget is REFUSED with 402');
check(/reached this month/i.test(r.message || ''), 'the refusal carries a sentence a person can read', r.message);

const wallet = (await dbA.query(`select cents_charged, requests from public.usage_month where user_id = $1`, [alice])).rows[0];
check(Number(wallet.cents_charged) === 80,
  'the refused request was refunded: the wallet never exceeds the budget', `charged=${wallet.cents_charged}`);
check(Number(wallet.requests) === 2, 'and the refused request is not counted as a request', `requests=${wallet.requests}`);

// The concurrency invariant, hammered serially: whatever order these arrive
// in, the recorded spend cannot pass the budget, and at most one request can
// be in flight past the last cent (the one the estimate admitted).
for (let i = 0; i < 25; i++) await consume(dbA, { cents: 40 });
const after = (await dbA.query(`select cents_charged from public.usage_month where user_id = $1`, [alice])).rows[0];
check(Number(after.cents_charged) <= 100,
  '25 more attempts cannot push the wallet past the budget', `charged=${after.cents_charged}`);

// A small request still fits in the remaining headroom — the cap refuses the
// request that does not fit, not the user.
r = await consume(dbA, { cents: 20 });
check(r.allowed === true && Number(r.month_cents_used) === 100,
  'a request that still FITS in the headroom is admitted');

// --- reconciliation ---------------------------------------------------------
console.log('\n--- reconciling the estimate to the actual ---------------------');
await asService(dbA);
let rec = (await dbA.query(`select public.usage_record_actual($1, $2, $3, $4) as r`,
  [firstEvent, 5, 'claude-opus-4-8', JSON.stringify({ route: 'test' })])).rows[0].r;
check(rec.ok === true && Number(rec.delta_cents) === -35, 'an actual of 5c against an estimate of 40c refunds 35c', `delta=${rec.delta_cents}`);
const reconciled = (await dbA.query(`select cents_charged from public.usage_month where user_id = $1`, [alice])).rows[0];
check(Number(reconciled.cents_charged) === 65, 'the wallet reflects the correction', `charged=${reconciled.cents_charged}`);
rec = (await dbA.query(`select public.usage_record_actual($1, $2, null, '{}'::jsonb) as r`, [firstEvent, 5])).rows[0].r;
check(rec.ok === false, 'reconciling the same event twice is a no-op, not a double refund');

// --- the rate window --------------------------------------------------------
console.log('\n--- the rate window --------------------------------------------');
await dbA.exec(`
  update public.usage_budgets set monthly_cents = null where pricing_tier = 'free' and kind = '*';
  update public.usage_budgets set window_max_requests = 3, window_seconds = 60
   where pricing_tier = 'free' and kind = 'llm';
`);
const bob = await makeUser(dbA, 'free');
await asUser(dbA, bob);

const w1 = 'WINDOW-ONE';
const admitted = [];
for (let i = 0; i < 5; i++) admitted.push((await consume(dbA, { cents: 0, windowKey: w1 })).allowed);
check(JSON.stringify(admitted) === JSON.stringify([true, true, true, false, false]),
  'three requests admitted in the window, the fourth and fifth refused', JSON.stringify(admitted));
const refusal = await consume(dbA, { cents: 0, windowKey: w1 });
check(refusal.status === 429 && refusal.reason === 'over_rate_limit', 'the rate refusal is a 429');
check(Number(refusal.retry_after_seconds) === 60, 'and it says when to come back', `retry_after=${refusal.retry_after_seconds}`);

const next = await consume(dbA, { cents: 0, windowKey: 'WINDOW-TWO' });
check(next.allowed === true, 'the next window admits again — the limit recovers');

const auto = await consume(dbA, { kind: 'tts', cents: 0 });
check(auto.allowed === true && typeof auto.window_key === 'string' && auto.window_key.length > 0,
  'with no window key supplied the RPC derives one from the clock', auto.window_key);

// --- whose budget -----------------------------------------------------------
console.log('\n--- whose budget is charged ------------------------------------');
const carol = await makeUser(dbA, 'free');
await asUser(dbA, carol);
const before = (await dbA.query(`select coalesce(sum(cents_estimated),0)::int as c from public.usage_events where user_id = $1`, [bob])).rows[0].c;
await consume(dbA, { kind: 'tts', cents: 7, pUser: bob });   // carol claims to be bob
const bobAfter = (await dbA.query(`select coalesce(sum(cents_estimated),0)::int as c from public.usage_events where user_id = $1`, [bob])).rows[0].c;
const carolAfter = (await dbA.query(`select coalesce(sum(cents_estimated),0)::int as c from public.usage_events where user_id = $1`, [carol])).rows[0].c;
check(Number(bobAfter) === Number(before) && Number(carolAfter) >= 7,
  "p_user is ignored for a signed-in caller: carol cannot spend bob's budget",
  `bob ${before}→${bobAfter}, carol=${carolAfter}`);

const neg = await consume(dbA, { kind: 'tts', cents: -500 });
const carolWallet = (await dbA.query(`select cents_charged from public.usage_month where user_id = $1`, [carol])).rows[0];
check(neg.allowed === true && Number(carolWallet.cents_charged) >= 7,
  'a negative estimate cannot be used to refund yourself', `charged=${carolWallet.cents_charged}`);

// --- RLS --------------------------------------------------------------------
console.log('\n--- what a signed-in user may do to the meter ------------------');
await asUser(dbA, carol);
const mine = (await dbA.query(`select count(*)::int as n from public.usage_events`)).rows[0].n;
check(Number(mine) >= 1, 'a user can read their own usage events', `${mine} rows`);
const theirs = (await dbA.query(`select count(*)::int as n from public.usage_events where user_id = $1`, [bob])).rows[0].n;
check(Number(theirs) === 0, "a user cannot read another user's usage events");

check(await refused(dbA, `insert into public.usage_month (user_id, month_key, cents_charged) values ('${carol}', '2026-09', 0)`) !== null,
  'a user cannot INSERT a usage_month row');
check(await refused(dbA, `update public.usage_month set cents_charged = 0`) !== null,
  'a user cannot UPDATE their own usage_month row to zero');
check(await refused(dbA, `delete from public.usage_events`) !== null,
  'a user cannot DELETE their usage events');
check(await refused(dbA, `update public.usage_budgets set monthly_cents = 999999`) !== null,
  'a user cannot raise their own budget');
check(await refused(dbA, `select public.usage_record_actual('${firstEvent}'::uuid, 0)`) !== null,
  'a user cannot call usage_record_actual (it would be a self-refund button)');
check(await refused(dbA, `select public.usage_consume_ip('1.2.3.4')`) !== null,
  'a user cannot call the IP limiter');

// Even with the table privilege granted by mistake, RLS still refuses: there
// is no INSERT policy on any of these tables, by design.
await asService(dbA);
await dbA.exec(`grant insert, update on public.usage_month to authenticated`);
await asUser(dbA, carol);
const rlsCode = await refused(dbA, `insert into public.usage_month (user_id, month_key, cents_charged) values ('${carol}', '2026-10', 0)`);
check(rlsCode === '42501', 'and if the privilege were granted by mistake, RLS still refuses the insert', `sqlstate=${rlsCode}`);
await asService(dbA);
await dbA.exec(`revoke insert, update on public.usage_month from authenticated`);

// --- the unauthenticated limiter -------------------------------------------
console.log('\n--- the IP limiter for /api/oauth-register ---------------------');
await asService(dbA);
const ipResults = [];
for (let i = 0; i < 22; i++) {
  ipResults.push((await dbA.query(`select public.usage_consume_ip($1, 'oauth_register', 'IPWIN') as r`, ['203.0.113.7'])).rows[0].r.allowed);
}
check(ipResults.filter(Boolean).length === 20, 'exactly 20 registrations per IP per window are admitted', `${ipResults.filter(Boolean).length} admitted`);
const otherIp = (await dbA.query(`select public.usage_consume_ip($1, 'oauth_register', 'IPWIN') as r`, ['198.51.100.1'])).rows[0].r;
check(otherIp.allowed === true, 'a different IP is unaffected');

// --- the reporting view -----------------------------------------------------
console.log('\n--- usage_monthly_pages ----------------------------------------');
await asService(dbA);
const { rows: mrows } = await dbA.query(`insert into public.matterspaces default values returning id`);
await dbA.query(
  `insert into public.documents (matterspace_id, page_count, file_size_bytes, ingested_at, created_by)
   values ($1, 120, 900000, now(), $2), ($1, 30, 100000, now(), $2)`,
  [mrows[0].id, alice],
);
const pages = (await dbA.query(`select * from public.usage_monthly_pages where user_id = $1`, [alice])).rows[0];
check(pages && Number(pages.pages) === 150 && Number(pages.documents) === 2,
  'the view derives monthly pages per user from documents.page_count', `pages=${pages?.pages}`);
const viewOpts = (await dbA.query(
  `select coalesce(array_to_string(reloptions, ','), '') as o from pg_class where relname = 'usage_monthly_pages'`)).rows[0];
check(/security_invoker=(true|on)/i.test(viewOpts.o),
  'the view is security_invoker, so it cannot become a cross-tenant read', viewOpts.o);

// --- structure --------------------------------------------------------------
console.log('\n--- structure --------------------------------------------------');
const fns = (await dbA.query(
  `select proname, count(*)::int as n from pg_proc
    where proname in ('usage_consume','usage_record_actual','usage_consume_ip','_usage_is_self')
    group by 1 order by 1`)).rows;
check(fns.length === 4 && fns.every((f) => f.n === 1),
  'one overload of each function (PostgREST cannot choose between two)', JSON.stringify(fns));
const wrapper = (await dbA.query(
  `select prosecdef from pg_proc where proname = '_usage_is_self'`)).rows[0];
check(wrapper.prosecdef === false,
  'the policy helper is SECURITY INVOKER, per the standing rule on RLS wrappers');
const definer = (await dbA.query(`select prosecdef from pg_proc where proname = 'usage_consume'`)).rows[0];
check(definer.prosecdef === true, 'usage_consume is SECURITY DEFINER, so the counters have exactly one door');

// ===========================================================================
// B. The same file against a database where 062 has already landed.
// ===========================================================================
console.log('\n=== B. migration 063 WITH 062 ====================================');
const dbB = await buildDb({ with062: true });
check(true, "063 applies to a database whose pricing_tier check already includes 'workshop'");

const eden = await makeUser(dbB, 'workshop');
await asUser(dbB, eden);
let big = null;
for (let i = 0; i < 40; i++) big = await consume(dbB, { kind: 'llm', cents: 100000 });
check(big.allowed === true && big.monthly_cents === null && big.remaining_cents === null,
  "the 'workshop' account is unlimited: 40 requests at $1,000 each, all admitted");
const edenWallet = (await dbB.query(`select cents_charged from public.usage_month where user_id = $1`, [eden])).rows[0];
check(Number(edenWallet.cents_charged) === 4000000, 'and every one of them is still RECORDED', `charged=${edenWallet.cents_charged}`);

// An unknown tier must never mean unlimited.
await asService(dbB);
await dbB.exec(`alter table public.profiles drop constraint profiles_pricing_tier_check`);
const stranger = await makeUser(dbB, 'enterprise-that-does-not-exist');
await asUser(dbB, stranger);
const s1 = await consume(dbB, { kind: 'llm', cents: 1400 });
const s2 = await consume(dbB, { kind: 'llm', cents: 1400 });
check(s1.allowed === true && s2.allowed === false && s2.reason === 'over_monthly_budget',
  "an unknown tier falls back to 'free', never to unlimited", `${s1.allowed}/${s2.allowed}`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
