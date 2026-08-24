// Execute migration 060 against a real Postgres and prove that 'held' is inert.
//
// Why this exists
// ---------------------------------------------------------------------------
// 060's entire value is a negative claim: a held row is picked up by NOTHING.
// Not by claim_discovery_job, not by the recovery sweep. A negative claim is
// exactly what a parse check cannot test, and getting it wrong reproduces the
// twenty-day retry loop the seal is supposed to end — this time on documents
// that will be refused identically every single time.
//
// So: build the stub schema 030 left behind, run the REAL migration files in
// the order production received them (044 → 045 → 055 → 057 → 058 → 060), and
// then try to get a held row to move.
//
//   npm i --no-save @electric-sql/pglite     # once; not a repo dependency
//   node scripts/_verify-held-status.mjs
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
// 1. The schema the migrations expect. documents carries 002's real CHECK
//    constraint — the thing 060 has to replace — and an implicit name, exactly
//    as production has it.
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
    source_filename text,
    processing_status text not null default 'pending'
      check (processing_status in (
        'pending','extracting','chunking','embedding','ready','error'
      )),
    processing_error text,
    storage_path text,
    created_at timestamptz not null default now()
  );
  create table public.passages (
    id uuid primary key default gen_random_uuid(),
    document_id uuid references public.documents(id) on delete cascade,
    matterspace_id uuid,
    sequence_number int
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
await db.exec(migration('060_held_sealed_status.sql'));

// ---------------------------------------------------------------------------
// 2. The constraint swap actually happened, and still constrains.
// ---------------------------------------------------------------------------
console.log('\n--- documents.processing_status vocabulary ---------------------');
const [t] = await q(`insert into public.serverspaces (name) values ('Fiction') returning id`);
const [m] = await q(`insert into public.matterspaces (serverspace_id, name) values ($1, 'Vashti v. Ormsby') returning id`, [t.id]);

const [held] = await q(
  `insert into public.documents (matterspace_id, source_filename, processing_status, processing_error, storage_path)
   values ($1, 'scan.tif', 'held', 'Held by the SecureSpace seal.', 'x/y.tif') returning id`, [m.id]);
check(Boolean(held?.id), "'held' is now an accepted processing_status");

let rejected = false;
try {
  await q(`insert into public.documents (matterspace_id, processing_status) values ($1, 'nonsense')`, [m.id]);
} catch { rejected = true; }
check(rejected, 'the CHECK constraint still rejects an unknown status');

const cons = await q(`
  select con.conname from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
   where rel.relname = 'documents' and con.contype = 'c'
     and pg_get_constraintdef(con.oid) ilike '%processing_status%'`);
check(cons.length === 1, 'exactly one processing_status CHECK remains (the old one was dropped)',
  cons.map((c) => c.conname).join(', '));

// ---------------------------------------------------------------------------
// 3. A held JOB is claimed by nobody. This is the whole point.
// ---------------------------------------------------------------------------
console.log('\n--- a held job is inert ---------------------------------------');
await q(`insert into public.processing_jobs (matterspace_id, job_type, payload, status)
         values ($1, 'ingest_document', jsonb_build_object('document_id', $2::uuid), 'held')`, [m.id, held.id]);

const claimed = await q(`select * from public.claim_discovery_job('test-worker')`);
check(claimed.length === 0, 'claim_discovery_job will not claim a held job',
  `claimed=${claimed.length}`);

// And a queued job beside it still claims normally — proof the queue is not
// simply broken.
await q(`insert into public.processing_jobs (matterspace_id, job_type, status)
         values ($1, 'ingest_document', 'queued')`, [m.id]);
const claimed2 = await q(`select * from public.claim_discovery_job('test-worker')`);
check(claimed2.length === 1, 'a queued job beside it still claims normally');

// ---------------------------------------------------------------------------
// 4. A held DOCUMENT is not stranded. The sweep that resurrected two documents
//    1,641 times each must walk straight past this one.
// ---------------------------------------------------------------------------
console.log('\n--- the recovery sweep walks past held ------------------------');
await q(`update public.documents set created_at = now() - interval '30 days' where id = $1`, [held.id]);

const before = (await q(`select status from public.processing_jobs where payload->>'document_id' = $1`, [held.id]))
  .map((r) => r.status);
const sweep = await q(`select * from public.recover_stranded_documents(15, 5)`);
const after = await q(`select processing_status, processing_error from public.documents where id = $1`, [held.id]);
const jobsAfter = (await q(`select status from public.processing_jobs where payload->>'document_id' = $1`, [held.id]))
  .map((r) => r.status);

check(after[0].processing_status === 'held', 'the held document was not touched by the sweep',
  after[0].processing_status);
check(JSON.stringify(before) === JSON.stringify(jobsAfter),
  'the held job was not requeued and no new job was minted for it',
  `${before.join(',')} -> ${jobsAfter.join(',')}`);
check(after[0].processing_error === 'Held by the SecureSpace seal.',
  'the plain-English reason survived the sweep');
console.log(`        sweep returned: ${JSON.stringify(sweep[0] ?? {})}`);

// ---------------------------------------------------------------------------
// 5. Phase B's release statements work as written in 060's header.
// ---------------------------------------------------------------------------
console.log('\n--- phase B release ------------------------------------------');
await q(`update public.processing_jobs set status = 'queued' where status = 'held'`);
await q(`update public.documents set processing_status = 'pending', processing_error = null
          where processing_status = 'held'`);
const released = await q(`select * from public.claim_discovery_job('test-worker')`);
check(released.length === 1, 'released work is claimable again', `claimed=${released.length}`);

console.log(`\n${failures === 0 ? "060 verified: 'held' is terminal." : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
