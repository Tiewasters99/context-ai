// Execute migration 058 against a real Postgres at PRODUCTION SCALE and prove
// the recovery sweep finishes.
//
// Why this exists
// ---------------------------------------------------------------------------
// 055's recovery function timed out on its very first production sweep: its
// failure_count subquery ran once per joined job row instead of once per
// document, and its uuid-cast probes could not use the text-expression index
// 055 itself created. The pathological input was exactly the input 055 was
// written for — two documents carrying 1,641 error jobs each.
//
// The original harness missed it because it seeded a handful of jobs. This one
// seeds the real shape: 1,641 error jobs per victim plus ~900 noise rows, runs
// the ACTUAL migration files in production order (044 → 045 → 055 → 057 → 058;
// 056 touches only search and needs pgvector, so it is skipped), executes one
// sweep, and asserts every branch:
//
//   * both scale victims land terminal ('error', readable message, job parked,
//     NO new job rows minted)
//   * a document with no job at all gets a fresh queued job (the 044 case)
//   * a document with attempts left is requeued BY REUSING its job row
//   * the sweep's return value counts only the requeues
//   * and the whole sweep finishes in a bounded wall time.
//
//   npm i --no-save @electric-sql/pglite     # once; not a repo dependency
//   node scripts/_verify-recovery-sweep.mjs
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
// 1. Stub schema (identical to _verify-job-priority.mjs) + migrations in the
//    order production received them.
// ---------------------------------------------------------------------------
console.log('\n--- schema ---------------------------------------------------');
await db.exec(`
  do $$ begin create role anon;          exception when duplicate_object then null; end $$;
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
await db.exec(migration('055_bounded_document_recovery.sql'));
await db.exec(migration('057_processing_jobs_priority.sql'));
await db.exec(migration('058_recovery_sweep_scale.sql'));

// ---------------------------------------------------------------------------
// 2. Seed at production scale.
// ---------------------------------------------------------------------------
console.log('\n--- seed -----------------------------------------------------');
const [t1] = await q(`insert into public.serverspaces (name) values ('Tenant') returning id`);
const [mA] = await q(`insert into public.matterspaces (serverspace_id, name) values ($1, 'decamara') returning id`, [t1.id]);

const doc = (status, path_) =>
  q(`insert into public.documents (matterspace_id, processing_status, storage_path, created_at)
     values ($1, $2, $3, now() - interval '20 days') returning id`, [mA.id, status, path_]);

// The two scale victims: stuck in 'embedding', 1,641 error jobs each.
const [victim1] = await doc('embedding', 'a/loop1.js');
const [victim2] = await doc('embedding', 'a/loop2.rtf');
for (const v of [victim1, victim2]) {
  await q(
    `insert into public.processing_jobs (matterspace_id, job_type, payload, status, attempts, created_at)
     select $1, 'ingest_document', jsonb_build_object('document_id', $2::uuid), 'error', 1,
            now() - interval '20 days' + (i || ' minutes')::interval
       from generate_series(1, 1641) i`, [mA.id, v.id]);
}
// Noise: ~900 done jobs for unrelated healthy documents.
await q(
  `insert into public.processing_jobs (matterspace_id, job_type, payload, status, created_at)
   select $1, 'ingest_document', jsonb_build_object('document_id', gen_random_uuid()), 'done',
          now() - interval '10 days'
     from generate_series(1, 900)`, [mA.id]);

// Branch 2a: stranded with NO job at all (the killed-serverless case).
const [orphan] = await doc('extracting', 'a/orphan.pdf');
// Branch 2c: budget left — one old error job, attempts 1 of 3.
const [retryable] = await doc('chunking', 'a/retry.pdf');
const [rjob] = await q(
  `insert into public.processing_jobs (matterspace_id, job_type, payload, status, attempts, created_at, finished_at)
   values ($1, 'ingest_document', jsonb_build_object('document_id', $2::uuid), 'error', 1,
           now() - interval '2 hours', now() - interval '2 hours') returning id`, [mA.id, retryable.id]);
// Control: recent job — must be left alone.
const [fresh] = await doc('embedding', 'a/fresh.pdf');
await q(
  `insert into public.processing_jobs (matterspace_id, job_type, payload, status, attempts, created_at, finished_at)
   values ($1, 'ingest_document', jsonb_build_object('document_id', $2::uuid), 'error', 1, now(), now())`,
  [mA.id, fresh.id]);

const [{ n: totalJobs }] = await q(`select count(*)::int as n from public.processing_jobs`);
console.log(`  seeded: 2 victims x 1641 error jobs, 900 noise, 3 branch docs — ${totalJobs} jobs total`);

// ---------------------------------------------------------------------------
// 3. One sweep, timed. The statement timeout in production is 8s; WASM is
//    slower than a real server, so the bound here is generous — 055's version
//    against this seed does not finish in minutes.
// ---------------------------------------------------------------------------
console.log('\n--- sweep ----------------------------------------------------');
const t0 = Date.now();
const [{ recover_stranded_documents: requeued }] =
  await q(`select public.recover_stranded_documents(1, 5)`);
const ms = Date.now() - t0;
check(ms < 5000, `sweep finished in bounded time`, `${ms} ms (victims carry 1,641 failures each)`);
check(requeued === 2, 'return value counts only the requeues (orphan + retryable)', `got ${requeued}`);

// ---------------------------------------------------------------------------
// 4. Every branch landed where it should.
// ---------------------------------------------------------------------------
console.log('\n--- outcomes -------------------------------------------------');
for (const [v, name] of [[victim1, 'victim 1'], [victim2, 'victim 2']]) {
  const [d] = await q(`select processing_status, processing_error from public.documents where id = $1`, [v.id]);
  check(d.processing_status === 'error' && /will not be retried/.test(d.processing_error || ''),
    `${name} is terminal and visible`, `${d.processing_status}`);
  const [{ n }] = await q(
    `select count(*)::int as n from public.processing_jobs
      where payload->>'document_id' = $1 and status <> 'error'`, [v.id + '']);
  check(n === 0, `${name}: every job parked in 'error', none minted`);
  const [{ n: total }] = await q(
    `select count(*)::int as n from public.processing_jobs where payload->>'document_id' = $1`, [v.id + '']);
  check(total === 1641, `${name}: job count unchanged (no fresh rows)`, `${total}`);
}

const [od] = await q(`select processing_status from public.documents where id = $1`, [orphan.id]);
const [{ n: oj }] = await q(
  `select count(*)::int as n from public.processing_jobs
    where payload->>'document_id' = $1 and status = 'queued'`, [orphan.id + '']);
check(od.processing_status === 'pending' && oj === 1, 'orphan (no job) got exactly one fresh queued job');

const [rj] = await q(`select id, status, attempts from public.processing_jobs where id = $1`, [rjob.id]);
check(rj.status === 'queued' && rj.attempts === 1, 'retryable doc reuses ITS OWN job row, attempts intact',
  `job ${String(rj.id).slice(0, 8)} status=${rj.status} attempts=${rj.attempts}`);

const [fd] = await q(`select processing_status from public.documents where id = $1`, [fresh.id]);
check(fd.processing_status === 'embedding', 'recent-failure doc left alone (inside the backoff window)');

// A second sweep must be idempotent: victims stay terminal, nothing new.
const [{ recover_stranded_documents: again }] = await q(`select public.recover_stranded_documents(1, 5)`);
check(again === 0, 'second sweep finds nothing to do (terminal states stick)', `got ${again}`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
