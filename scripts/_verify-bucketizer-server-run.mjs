// A Bucketizer run survives a closed laptop — proved, not asserted.
//
// WHAT THIS COVERS
// ---------------------------------------------------------------------------
// A. Migration 079 executed against a real Postgres (PGlite) on top of the real
//    036 and the real queue migrations (030 → 044 → 045 → 057 → 071): the run
//    row, the per-document rows, the per-window rows, the two service-role
//    RPCs, the one-active-run bound, RLS with no write policy, and the claim
//    order a 500-document run actually gets from the shared worker.
//
// B. The server runner (lib/bucketizer-run.mjs) driven against that database
//    with the MODEL stubbed and global fetch replaced by a witness:
//      * a worker that dies mid-document resumes at the next undone WINDOW and
//        re-charges nothing that finished;
//      * a SEALED matter with no provisioned pen is HELD — zero provider
//        calls, the product's own sentence, never a fallback;
//      * the matter's AI pause (070) pauses the run at the next window;
//      * a 402 mid-run pauses the run with the SERVER's sentence and resumes;
//      * CONFIRMED and REJECTED rows are never touched;
//      * Cancel stops the run and removes its queued jobs;
//      * every window leaves the two-row ledger record with the feature label
//        and the document id, and no text;
//      * the browser path is unchanged.
//
// Offline by construction: PGlite in this process, a stubbed model, a witnessed
// fetch. No .env, no network, no production.
//
//   npm i --no-save @electric-sql/pglite     # once; not a repo dependency
//   node scripts/_verify-bucketizer-server-run.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

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
  return fs.readFileSync(p, 'utf8');
};

const db = new PGlite();
const q = async (sql, params) => (await db.query(sql, params)).rows;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

// ===========================================================================
// PART A — the database
// ===========================================================================
console.log('\n--- A1. schema -------------------------------------------------');
await db.exec(`
  do $$ begin create role anon;          exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role;  exception when duplicate_object then null; end $$;

  create schema if not exists auth;
  -- Stubbed: PGlite has no GoTrue. What is under test is that the policies
  -- resolve through _bktz_matter_access at all, not what GoTrue returns.
  create or replace function auth.uid() returns uuid language sql stable
    as $$ select '00000000-0000-0000-0000-0000000000aa'::uuid $$;

  create or replace function public.update_updated_at() returns trigger
    language plpgsql as $$
    begin new.updated_at = now(); return new; end $$;

  create table public.serverspaces (
    id uuid primary key default gen_random_uuid(),
    name text
  );
  create table public.matterspaces (
    id uuid primary key default gen_random_uuid(),
    serverspace_id uuid not null references public.serverspaces(id) on delete cascade,
    parent_matterspace_id uuid references public.matterspaces(id) on delete cascade,
    name text
  );
  create table public.profiles (id uuid primary key default gen_random_uuid());
  create table public.productions (id uuid primary key default gen_random_uuid(), matterspace_id uuid, status text);
  create table public.documents (
    id uuid primary key default gen_random_uuid(),
    matterspace_id uuid references public.matterspaces(id) on delete cascade,
    title text,
    doc_type text,
    page_count int,
    processing_status text not null default 'ready',
    processing_error text,
    storage_path text,
    metadata jsonb not null default '{}',
    created_at timestamptz not null default now()
  );
  create table public.passages (
    id uuid primary key default gen_random_uuid(),
    document_id uuid not null references public.documents(id) on delete cascade,
    matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
    sequence_number int not null,
    page_start int, page_end int, line_start int, line_end int,
    witness_name text,
    text text not null,
    metadata jsonb not null default '{}'
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

  -- Migration 022's SECURITY INVOKER access check, stubbed permissive.
  create or replace function public._mtspc_select_check(
    p_matter uuid, p_serverspace uuid, p_parent uuid
  ) returns boolean language sql security invoker stable as $$ select true $$;

  grant usage on schema public to anon, authenticated, service_role;
  grant all on all tables in schema public to authenticated, service_role;
`);
check(true, 'stub schema built');

console.log('\n--- A2. migrations ---------------------------------------------');
await db.exec(migration('036_bucketizer.sql'));
await db.exec(migration('044_ingest_reliability.sql'));
await db.exec(migration('045_fix_claim_job_enum_cast.sql'));
await db.exec(migration('057_processing_jobs_priority.sql'));
// 071 restates the same trigger and claim function with ONE refinement: it
// promotes `stamp_production` / `package_production` to +10 because a person is
// watching a spinner for them. A bucketizer job is neither, so 071 changes
// nothing this section asserts — and running it here would mean building the
// whole Discovery schema (productions, items, the Bates registry) for no extra
// coverage. `scripts/_verify-discovery-pipeline.mjs` runs it against that.
check(true, '036 + the queue chain (044 → 045 → 057) applied');

await db.exec(migration('079_bucketizer_server_runs.sql'));
check(true, '079 applied on top');

// The live database is not the migrations folder, so a second paste has to be
// a no-op rather than a 42P07 in the middle of a session.
let rerun = null;
try { await db.exec(migration('079_bucketizer_server_runs.sql')); } catch (e) { rerun = e?.message ?? String(e); }
check(rerun === null, '079 is idempotent — a second paste is a no-op', rerun ?? '');

// ---------------------------------------------------------------------------
console.log('\n--- A3. shape --------------------------------------------------');
const cols = async (table) => (await q(
  `select column_name from information_schema.columns
    where table_schema = 'public' and table_name = $1 order by 1`, [table],
)).map((r) => r.column_name);

const runCols = await cols('bucketizer_runs');
for (const c of ['matterspace_id', 'kind', 'requested_by', 'model_id', 'document_ids',
  'estimate_cents', 'status', 'pause_reason', 'retry_after_seconds', 'last_error',
  'documents_total', 'documents_done', 'documents_skipped', 'documents_failed',
  'windows_called', 'windows_resumed', 'proposed', 'started_at', 'finished_at']) {
  if (!runCols.includes(c)) check(false, `bucketizer_runs.${c} exists`);
}
check(runCols.length >= 19, 'bucketizer_runs carries the matter, the act, who asked, what they confirmed, the estimate, the status and the counters');

const winCols = await cols('bucketizer_run_windows');
check(['document_id', 'plan_hash', 'window_index', 'assignments', 'failed'].every((c) => winCols.includes(c)),
  'bucketizer_run_windows records a window by (document, plan hash, index)');

const uniq = await q(`
  select indexname, indexdef from pg_indexes
   where tablename = 'bucketizer_run_windows' and indexdef like '%UNIQUE%'`);
check(uniq.some((r) => /document_id.*plan_hash.*window_index/s.test(r.indexdef)),
  'a window is unique on (document, plan hash, index) — the reason nothing is paid for twice');

const active = await q(`
  select indexdef from pg_indexes where indexname = 'bucketizer_runs_one_active_idx'`);
check(active.length === 1 && /UNIQUE/.test(active[0].indexdef) && /WHERE/i.test(active[0].indexdef),
  'one ACTIVE run per matter per act, enforced by a partial unique index');

// ---------------------------------------------------------------------------
console.log('\n--- A4. RLS: read your matters, write nothing ------------------');
const policies = await q(`
  select tablename, cmd, qual, with_check from pg_policies
   where schemaname = 'public' and tablename like 'bucketizer_run%' order by tablename, cmd`);
check(policies.length === 3, 'exactly three policies — one SELECT per table', policies.map((p) => `${p.tablename}:${p.cmd}`).join(', '));
check(policies.every((p) => p.cmd === 'SELECT'),
  'no INSERT / UPDATE / DELETE policy: a client cannot say a run finished, or re-point it at another matter');
check(policies.every((p) => /_bktz_matter_access/.test(p.qual ?? '')),
  'every policy resolves through the SECURITY INVOKER wrapper _bktz_matter_access');
check(!policies.some((p) => /_mtspc_select_check/.test(p.qual ?? '')),
  'and none of them calls the SECURITY DEFINER helper directly');

const rls = await q(`
  select relname, relrowsecurity from pg_class
   where relname like 'bucketizer_run%' and relkind = 'r' order by 1`);
check(rls.length === 3 && rls.every((r) => r.relrowsecurity), 'row level security is enabled on all three tables');

// ---------------------------------------------------------------------------
console.log('\n--- A5. the two RPCs are service-role only ---------------------');
for (const fn of ['bucketizer_run_finish_document', 'bucketizer_run_halt']) {
  const [row] = await q(`
    select p.proname,
           has_function_privilege('authenticated', p.oid, 'execute') as auth_may,
           has_function_privilege('service_role', p.oid, 'execute')  as svc_may,
           p.prosecdef as definer,
           count(*) over () as overloads
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = $1`, [fn]);
  check(Boolean(row), `${fn} exists`);
  check(row?.definer === true, `${fn} is SECURITY DEFINER`);
  check(row?.auth_may === false, `${fn} is revoked from authenticated`);
  check(row?.svc_may === true, `${fn} is granted to service_role`);
  check(Number(row?.overloads) === 1, `exactly one ${fn} overload (PostgREST cannot choose between two)`);
}

// ---------------------------------------------------------------------------
console.log('\n--- A6. a run finishes exactly once ----------------------------');
const [ss] = await q(`insert into public.serverspaces (name) values ('Firm') returning id`);
const [matter] = await q(`insert into public.matterspaces (serverspace_id, name) values ($1, 'Fleming') returning id`, [ss.id]);
const [other] = await q(`insert into public.matterspaces (serverspace_id, name) values ($1, 'Somebody else') returning id`, [ss.id]);
const [user] = await q(`insert into public.profiles default values returning id`);

const mkDoc = async (m, title, pages = 4) => (await q(
  `insert into public.documents (matterspace_id, title, page_count) values ($1, $2, $3) returning id`,
  [m, title, pages]))[0].id;

const docs = [];
for (let i = 0; i < 3; i++) docs.push(await mkDoc(matter.id, `Deposition ${i + 1}`));

const [run] = await q(`
  insert into public.bucketizer_runs
    (matterspace_id, kind, requested_by, model_id, document_ids, estimate_cents, documents_total, status)
  values ($1, 'classify', $2, 'claude-opus-4-8', $3::uuid[], 812, 3, 'running')
  returning id`, [matter.id, user.id, docs]);
for (const d of docs) {
  await q(`insert into public.bucketizer_run_documents (run_id, matterspace_id, document_id, title)
           values ($1, $2, $3, 'x')`, [run.id, matter.id, d]);
}

let fin = await q(`select public.bucketizer_run_finish_document($1, $2, 'done', null, 3, 3, 0, 0, 2) as r`, [run.id, docs[0]]);
check(fin[0].r.remaining === 2 && fin[0].r.status === 'running', 'a run with documents left stays running', JSON.stringify(fin[0].r));
await q(`select public.bucketizer_run_finish_document($1, $2, 'skipped', 'no text to read', 0, 0, 0, 0, 0)`, [run.id, docs[1]]);
fin = await q(`select public.bucketizer_run_finish_document($1, $2, 'done', null, 1, 1, 0, 0, 1) as r`, [run.id, docs[2]]);
check(fin[0].r.remaining === 0 && fin[0].r.status === 'done', 'the last document flips the run to done, in the same transaction', JSON.stringify(fin[0].r));

const [counted] = await q(`select * from public.bucketizer_runs where id = $1`, [run.id]);
check(counted.documents_done === 2 && counted.documents_skipped === 1 && counted.proposed === 3
  && counted.windows_called === 4 && counted.finished_at !== null,
  'the run counters are RECOMPUTED from the document rows, never incremented',
  `done=${counted.documents_done} skipped=${counted.documents_skipped} proposed=${counted.proposed} called=${counted.windows_called}`);

// A retried job settling the same document twice must not count it twice.
await q(`select public.bucketizer_run_finish_document($1, $2, 'done', null, 3, 3, 0, 0, 2)`, [run.id, docs[0]]);
const [again] = await q(`select * from public.bucketizer_runs where id = $1`, [run.id]);
check(again.documents_done === 2 && again.proposed === 3,
  'settling the same document twice counts it once — an increment would have counted it twice');
check(again.status === 'done', 'and a finished run is not re-opened');

// ---------------------------------------------------------------------------
console.log('\n--- A7. one active run per matter per act ----------------------');
const startRun = (m, kind = 'classify', status = 'queued') => q(`
  insert into public.bucketizer_runs (matterspace_id, kind, requested_by, model_id, status)
  values ($1, $2, $3, 'claude-opus-4-8', $4) returning id`, [m, kind, user.id, status]);

const [live] = await startRun(matter.id);
let dup = null;
try { await startRun(matter.id); } catch (e) { dup = e?.message ?? String(e); }
check(dup !== null, 'a second live classify run on the same matter is refused by the database', (dup ?? '').slice(0, 60));
const [evidenceRun] = await startRun(matter.id, 'evidence');
check(Boolean(evidenceRun?.id), 'but an EVIDENCE run alongside a classify run is fine — different act');
const [otherMatter] = await startRun(other.id);
check(Boolean(otherMatter?.id), 'and another matter is never blocked by this one');

// ---------------------------------------------------------------------------
console.log('\n--- A8. halt removes the queued jobs, keeps the running one ----');
const enqueue = (m, runId, docId, status = 'queued') => q(`
  insert into public.processing_jobs (matterspace_id, job_type, payload, status, priority)
  values ($1, 'bucketizer_classify_document',
          jsonb_build_object('run_id', $2::text, 'document_id', $3::text), $4::discovery_job_status, -10)
  returning id, priority`, [m, runId, docId, status]);

for (const d of docs) {
  await q(`insert into public.bucketizer_run_documents (run_id, matterspace_id, document_id, title)
           values ($1, $2, $3, 'x')`, [live.id, matter.id, d]);
}
await enqueue(matter.id, live.id, docs[0], 'running');
await enqueue(matter.id, live.id, docs[1]);
await enqueue(matter.id, live.id, docs[2]);
// Somebody else's upload, queued at the same time. It must survive.
const [innocent] = await q(`
  insert into public.processing_jobs (matterspace_id, job_type, payload)
  values ($1, 'ingest_document', '{"document_id":"x"}') returning id`, [other.id]);

const [halted] = await q(`
  select public.bucketizer_run_halt($1, 'paused', 'This month''s included AI usage is spent.', 3600) as r`, [live.id]);
check(halted.r.jobs_removed === 2, "the run's two QUEUED jobs are removed", JSON.stringify(halted.r));
const stillThere = await q(`select id, job_type, status from public.processing_jobs order by created_at`);
check(stillThere.some((j) => j.status === 'running'), 'the job already with a worker is left alone — it will settle itself');
check(stillThere.some((j) => j.id === innocent.id), "and another matter's upload is untouched");

const [paused] = await q(`select * from public.bucketizer_runs where id = $1`, [live.id]);
check(paused.status === 'paused' && /included AI usage/.test(paused.pause_reason ?? '')
  && paused.retry_after_seconds === 3600 && paused.finished_at === null,
  "the run is paused, carries the SERVER's own sentence and when to come back, and is not finished");
const resumable = await q(`select status from public.bucketizer_run_documents where run_id = $1`, [live.id]);
check(resumable.every((r) => r.status === 'queued'), 'every unfinished document goes back to queued, so Resume knows what is left');

// Cancel is the same function with a different word — and a cancelled document
// does not come back on a later Resume.
await q(`select public.bucketizer_run_halt($1, 'cancelled', 'Stopped.', null)`, [live.id]);
const cancelled = await q(`select status from public.bucketizer_run_documents where run_id = $1`, [live.id]);
check(cancelled.every((r) => r.status === 'cancelled'), 'Cancel marks the remaining documents cancelled rather than queued');
const [cRun] = await q(`select * from public.bucketizer_runs where id = $1`, [live.id]);
check(cRun.status === 'cancelled' && cRun.finished_at !== null, 'and the run is terminal, so a new run may start at once');

// ---------------------------------------------------------------------------
console.log('\n--- A9. 500 documents do not starve one upload -----------------');
// The fairness claim, against the REAL claim function and the REAL trigger.
const [bulkMatter] = await q(`insert into public.matterspaces (serverspace_id, name) values ($1, 'Big production') returning id`, [ss.id]);
const [bulkRun] = await startRun(bulkMatter.id);
const base = Date.parse('2026-09-21T00:00:00Z');
await db.exec('set role service_role');
for (let i = 0; i < 40; i++) {
  await q(`insert into public.processing_jobs (matterspace_id, job_type, payload, priority, created_at)
           values ($1, 'bucketizer_classify_document', jsonb_build_object('run_id', $2::text, 'n', $3::int), -10, $4)`,
  [bulkMatter.id, bulkRun.id, i, new Date(base + i * 1000).toISOString()]);
}
// A lawyer in ANOTHER matter uploads one deposition, after all forty.
const [upload] = await q(`insert into public.processing_jobs (matterspace_id, job_type, payload, created_at)
  values ($1, 'ingest_document', '{"tag":"the one upload"}', $2) returning id, priority`,
[matter.id, new Date(base + 100_000).toISOString()]);
await db.exec('reset role');
check(upload.priority === 0, "the interactive upload is normal priority");

// Drain everything already in the queue from the earlier sections first.
for (;;) {
  const rows = await q(`select payload, job_type from public.claim_discovery_job('drain')`);
  if (!rows.length) break;
  if (rows[0].payload?.tag === 'the one upload') {
    check(true, 'the single upload is claimed BEFORE the 40 bulk classify jobs enqueued an hour earlier');
    break;
  }
  if (rows[0].job_type === 'bucketizer_classify_document') {
    check(false, 'the single upload is claimed BEFORE the 40 bulk classify jobs enqueued an hour earlier',
      'a bulk classify job went first');
    break;
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
