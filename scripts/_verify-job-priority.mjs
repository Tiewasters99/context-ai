// Execute migration 057 against a real Postgres and prove the claim order.
//
// Why this exists
// ---------------------------------------------------------------------------
// There is no local Postgres on the dev machine and no Docker, so migrations
// have shipped parse-checked only. That was tolerable for a search function.
// It is not tolerable for claim_discovery_job: every job in the system passes
// through it, and a mistake there stops all ingestion for every tenant.
//
// PGlite is Postgres compiled to WebAssembly — real plpgsql, real enums, real
// FOR UPDATE SKIP LOCKED — running inside this Node process. This script builds
// the handful of tables the queue migrations touch, then runs the ACTUAL
// migration files from supabase/migrations — 044, its 045 hotfix, and 057, in
// the order production received them — verbatim, and checks what the claim
// function does.
//
// It has already paid for itself once. The first draft of 057 restated the
// claim function from 044 instead of 045, and this script failed on the exact
// 42804 that 045 exists to fix. A parse check would have passed it.
//
// What it cannot prove: PGlite is single-connection, so two workers claiming
// at once is not exercised here. That path is unchanged from 044 and is the
// one part of this function that has been running in production.
//
//   npm i --no-save @electric-sql/pglite     # once; not a repo dependency
//   node scripts/_verify-job-priority.mjs
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
const migration = (name) => {
  const p = path.resolve(__dirname, '..', 'supabase', 'migrations', name);
  console.log(`  executing ${path.relative(process.cwd(), p)}`);
  return fs.readFileSync(p, 'utf8');
};

const db = new PGlite();
const q = async (sql, params) => (await db.query(sql, params)).rows;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------------------
// 1. The schema the migrations depend on. processing_jobs is exactly as
//    migration 030 created it; the rest are the minimum 044/057 reference.
// ---------------------------------------------------------------------------
console.log('\n--- schema ---------------------------------------------------');
await db.exec(`
  do $$ begin create role anon;         exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role;  exception when duplicate_object then null; end $$;

  create table public.serverspaces (id uuid primary key default gen_random_uuid(), name text);
  create table public.matterspaces (
    id uuid primary key default gen_random_uuid(),
    serverspace_id uuid not null references public.serverspaces(id),
    name text
  );
  create table public.profiles (id uuid primary key default gen_random_uuid());
  create table public.productions (id uuid primary key default gen_random_uuid(), matterspace_id uuid, status text);
  create table public.documents (
    id uuid primary key default gen_random_uuid(),
    matterspace_id uuid,
    processing_status text not null default 'pending',
    processing_error text,
    storage_path text,
    created_at timestamptz not null default now()
  );

  create type discovery_job_status as enum ('queued', 'running', 'done', 'error');
  create table public.processing_jobs (
    id uuid primary key default gen_random_uuid(),
    matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
    production_id uuid references public.productions(id) on delete cascade,
    job_type text not null,
    payload jsonb not null default '{}',
    status discovery_job_status not null default 'queued',
    progress int not null default 0,
    progress_note text,
    claimed_by text,
    claimed_at timestamptz,
    finished_at timestamptz,
    error text,
    created_by uuid references public.profiles(id),
    created_at timestamptz not null default now()
  );
  create index idx_processing_jobs_status on public.processing_jobs (status, created_at);

  grant usage on schema public to anon, authenticated, service_role;
  grant all on all tables in schema public to authenticated, service_role;
`);
console.log('  stub schema built');

await db.exec(migration('044_ingest_reliability.sql'));
await db.exec(migration('045_fix_claim_job_enum_cast.sql'));
await db.exec(migration('057_processing_jobs_priority.sql'));

// ---------------------------------------------------------------------------
// 2. Two tenants, one matter each.
// ---------------------------------------------------------------------------
const [t1] = await q(`insert into public.serverspaces (name) values ('Tenant One') returning id`);
const [t2] = await q(`insert into public.serverspaces (name) values ('Tenant Two') returning id`);
const [mA] = await q(`insert into public.matterspaces (serverspace_id, name) values ($1, 'A: production') returning id`, [t1.id]);
const [mB] = await q(`insert into public.matterspaces (serverspace_id, name) values ($1, 'B: one deposition') returning id`, [t2.id]);

// created_at is set explicitly so ordering is deterministic and the test does
// not depend on the clock resolution of a WASM runtime.
const base = Date.parse('2026-08-23T00:00:00Z');
const at = (i) => new Date(base + i * 1000).toISOString();
const enqueue = (matter, i, extra = '') =>
  q(`insert into public.processing_jobs (matterspace_id, job_type, payload, created_at ${extra ? ', priority' : ''})
     values ($1, 'ingest_document', jsonb_build_object('n', $2::int), $3 ${extra ? ', ' + extra : ''})
     returning id, priority, serverspace_id`, [matter, i, at(i)]);

// ---------------------------------------------------------------------------
// 3. Tenant One dumps a production: 30 heavy files, one at a time, through an
//    interactive path that never mentions priority.
// ---------------------------------------------------------------------------
console.log('\n--- burst demotion --------------------------------------------');
const aRows = [];
for (let i = 0; i < 30; i++) aRows.push((await enqueue(mA.id, i))[0]);
const normal = aRows.filter((r) => r.priority === 0).length;
const bulk = aRows.filter((r) => r.priority === -10).length;
check(normal === 10 && bulk === 20, 'first 10 stay normal, the next 20 self-demote to bulk', `normal=${normal} bulk=${bulk}`);
check(aRows.every((r) => r.serverspace_id === t1.id), 'serverspace_id stamped on every job from the matter');

// Tenant Two uploads one deposition, AFTER all thirty.
const [bRow] = await enqueue(mB.id, 40);
check(bRow.priority === 0, "Tenant Two's single upload is normal priority");
check(bRow.serverspace_id === t2.id, "Tenant Two's job carries Tenant Two's serverspace_id");

// ---------------------------------------------------------------------------
// 4. Claim everything and record the order.
// ---------------------------------------------------------------------------
console.log('\n--- claim order ------------------------------------------------');
const order = [];
for (;;) {
  const rows = await q(`select * from public.claim_discovery_job('test-worker')`);
  if (!rows.length) break;
  const j = rows[0];
  order.push({ matter: j.matterspace_id === mA.id ? 'A' : 'B', n: j.payload.n, priority: j.priority });
}
const expected = [
  ...Array.from({ length: 10 }, (_, i) => `A${i}`),
  'B40',
  ...Array.from({ length: 20 }, (_, i) => `A${i + 10}`),
];
const got = order.map((o) => `${o.matter}${o.n}`);
check(got.length === 31, 'all 31 jobs were claimed', `claimed=${got.length}`);
check(JSON.stringify(got) === JSON.stringify(expected),
  "A's first ten, then B's single upload, then A's remaining twenty — oldest first within each tier");
console.log(`        ${got.slice(0, 12).join(' ')} … ${got.slice(-3).join(' ')}`);

// ---------------------------------------------------------------------------
// 5. The clamp. authenticated cannot raise priority; the service role can.
// ---------------------------------------------------------------------------
console.log('\n--- priority clamp ---------------------------------------------');
await db.exec('set role authenticated');
const [asUser] = await enqueue(mB.id, 50, '50');
const [asUserLow] = await enqueue(mB.id, 51, '-10');
await db.exec('reset role');
check(asUser.priority === 0, 'authenticated asking for +50 is written as 0');
check(asUserLow.priority === -10, 'authenticated may still LOWER its own priority');

await db.exec('set role service_role');
const [asService] = await enqueue(mB.id, 52, '50');
await db.exec('reset role');
check(asService.priority === 50, 'service_role asking for +50 keeps +50');

const [next] = await q(`select payload->>'n' as n from public.claim_discovery_job('test-worker')`);
check(next?.n === '52', 'the +50 job is claimed ahead of the two normal jobs enqueued before it');

// ---------------------------------------------------------------------------
// 6. Structure.
// ---------------------------------------------------------------------------
console.log('\n--- structure --------------------------------------------------');
const idx = await q(`select indexname from pg_indexes where tablename = 'processing_jobs' and indexname like 'processing_jobs_queued_%' order by 1`);
check(idx.length === 2, 'both partial indexes exist', idx.map((r) => r.indexname).join(', '));
const overloads = await q(`select count(*)::int as n from pg_proc where proname = 'claim_discovery_job'`);
check(overloads[0].n === 1, 'exactly one claim_discovery_job overload (PostgREST cannot choose between two)');
const trg = await q(`select tgname from pg_trigger where tgname = 'processing_jobs_before_insert'`);
check(trg.length === 1, 'insert trigger is installed');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
