// A Bucketizer run survives a closed laptop — proved, not asserted.
//
// WHAT THIS COVERS
// ---------------------------------------------------------------------------
// A. Migration 079 executed against a real Postgres (PGlite) on top of the real
//    036 and the real queue chain (044 → 045 → 057): the run row, the
//    per-document rows, the per-window rows, the two service-role RPCs, the
//    one-active-run bound, RLS with no write policy, and the claim order a
//    500-document run actually gets from the shared worker.
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

// ===========================================================================
// PART B — the runner, against that database, with the model stubbed
// ===========================================================================
//
// The point of driving the REAL lib/bucketizer-run.mjs rather than a
// description of it: every assertion below is about what the shipped code
// does, and the fetch witness makes "zero provider calls" a count rather than
// a claim.

const { runBucketizerDocumentJob, BUCKETIZER_JOB_PRIORITY, BUCKETIZER_JOB_TYPE, SERVER_RUN_MIN_DOCUMENTS } =
  await import('../lib/bucketizer-run.mjs');
const { haltRun: halt } = await import('../lib/bucketizer-run-queue.mjs');

console.log('\n--- B0. the constants are not a second opinion ------------------');
try {
  const { JOB_PRIORITY } = await import('../lib/ingest-core.mjs');
  check(BUCKETIZER_JOB_PRIORITY === JOB_PRIORITY.BULK,
    'BUCKETIZER_JOB_PRIORITY is JOB_PRIORITY.BULK, spelled out so a Vercel bundle need not import the ingest pipeline',
    `${BUCKETIZER_JOB_PRIORITY} vs ${JOB_PRIORITY.BULK}`);
} catch (e) {
  check(false, 'lib/ingest-core.mjs could be imported to compare BULK', e?.message ?? '');
}
check(SERVER_RUN_MIN_DOCUMENTS === 5, 'the server/browser threshold is five documents');

// ---------------------------------------------------------------------------
// A supabase-js-shaped client over PGlite. Just the calls the runner makes.
// ---------------------------------------------------------------------------
function pgliteSupabase() {
  const sql = async (text, params) => (await db.query(text, params)).rows;

  class Q {
    constructor(table) {
      this.table = table; this.op = 'select'; this.cols = '*';
      this.where = []; this.params = []; this.orderBy = []; this.rangeTo = null; this.one = null;
    }
    #p(v) { this.params.push(v); return `$${this.params.length}`; }
    select(cols = '*') { if (this.op === 'select') this.cols = cols; this.returning = cols; return this; }
    insert(rows) { this.op = 'insert'; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
    upsert(rows, opts = {}) { this.op = 'insert'; this.rows = Array.isArray(rows) ? rows : [rows]; this.conflict = opts.onConflict ?? null; this.ignore = opts.ignoreDuplicates !== false; return this; }
    update(patch) { this.op = 'update'; this.patch = patch; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(c, v) { this.where.push(`${col(c)} = ${this.#p(v)}`); return this; }
    neq(c, v) { this.where.push(`${col(c)} is distinct from ${this.#p(v)}`); return this; }
    in(c, vs) { this.where.push(`${col(c)} = any(${this.#p(vs)})`); return this; }
    filter(c, op, v) { if (op === 'eq') this.where.push(`${col(c)} = ${this.#p(v)}`); return this; }
    order(c, { ascending = true } = {}) { this.orderBy.push(`${col(c)} ${ascending ? 'asc' : 'desc'}`); return this; }
    limit(n) { this.rangeTo = [0, n - 1]; return this; }
    range(from, to) { this.rangeTo = [from, to]; return this; }
    single() { this.one = 'single'; return this; }
    maybeSingle() { this.one = 'maybe'; return this; }
    then(resolve) { return this.exec().then(resolve); }
    async exec() {
      try {
        const w = this.where.length ? ` where ${this.where.join(' and ')}` : '';
        if (this.op === 'insert') {
          const keys = [...new Set(this.rows.flatMap((r) => Object.keys(r)))];
          const values = this.rows.map((r) => `(${keys.map((k) => this.#p(json(r[k], k))).join(', ')})`).join(', ');
          const conflict = this.conflict
            ? ` on conflict (${this.conflict.split(',').map((c) => col(c.trim())).join(', ')}) do nothing`
            : '';
          const rows = await sql(
            `insert into public.${this.table} (${keys.map(col).join(', ')}) values ${values}${conflict} returning *`,
            this.params,
          );
          return { data: this.one ? rows[0] ?? null : rows, error: null };
        }
        if (this.op === 'update') {
          const sets = Object.entries(this.patch).map(([k, v]) => `${col(k)} = ${this.#p(json(v, k))}`);
          // The SET list is built first so its placeholders come before WHERE's.
          const where = this.where.length ? ` where ${this.where.join(' and ')}` : '';
          const rows = await sql(`update public.${this.table} set ${sets.join(', ')}${where} returning *`, this.params);
          return { data: this.one ? rows[0] ?? null : rows, error: null };
        }
        if (this.op === 'delete') {
          await sql(`delete from public.${this.table}${w}`, this.params);
          return { data: null, error: null };
        }
        const order = this.orderBy.length ? ` order by ${this.orderBy.join(', ')}` : '';
        const lim = this.rangeTo ? ` limit ${this.rangeTo[1] - this.rangeTo[0] + 1} offset ${this.rangeTo[0]}` : '';
        const rows = await sql(`select * from public.${this.table}${w}${order}${lim}`, this.params);
        if (this.one) return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null };
      } catch (e) {
        return { data: null, error: { message: e?.message ?? String(e), code: e?.code } };
      }
    }
  }
  const col = (c) => `"${String(c).replace(/"/g, '')}"`;
  // uuid[] columns take a Postgres array literal; jsonb columns take JSON. The
  // real client knows the difference from the wire protocol; here it is a list.
  const ARRAY_COLUMNS = new Set(['passage_ids', 'document_ids']);
  const json = (v, c = null) => {
    if (v === null || v === undefined) return v;
    if (ARRAY_COLUMNS.has(c) && Array.isArray(v)) return `{${v.map((x) => `"${x}"`).join(',')}}`;
    return typeof v === 'object' ? JSON.stringify(v) : v;
  };

  return {
    from: (t) => new Q(t),
    async rpc(fn, args = {}) {
      const keys = Object.keys(args);
      const params = keys.map((k) => json(args[k]));
      const named = keys.map((k, i) => `${k} := $${i + 1}`).join(', ');
      try {
        const rows = await sql(`select public.${fn}(${named}) as out`, params);
        return { data: rows[0]?.out ?? null, error: null };
      } catch (e) {
        return { data: null, error: { message: e?.message ?? String(e), code: e?.code } };
      }
    },
  };
}

// ---------------------------------------------------------------------------
console.log('\n--- B1. the fixtures -------------------------------------------');
await db.exec(`
  -- A stand-in for migration 064's ledger_append. The real one — the hash
  -- chain, the membership re-check, the system-actor rule — is covered by
  -- scripts/_verify-ledger.mjs. What THIS harness needs is a record of what
  -- the runner asked it to write, so the payloads can be inspected.
  create table if not exists public.ledger_calls (
    id bigserial primary key,
    kind text, matter uuid, actor_kind text, actor_ref text, payload jsonb,
    at timestamptz not null default now()
  );
  create or replace function public.ledger_append(
    p_kind text, p_matter uuid default null, p_serverspace uuid default null,
    p_session uuid default null, p_actor_kind text default 'user',
    p_actor_ref text default null, p_actor_label text default null,
    p_payload jsonb default '{}'
  ) returns jsonb language plpgsql as $$
  declare v_id bigint;
  begin
    insert into public.ledger_calls (kind, matter, actor_kind, actor_ref, payload)
    values (p_kind, p_matter, p_actor_kind, p_actor_ref, p_payload) returning id into v_id;
    return jsonb_build_object('id', v_id, 'seq', v_id, 'hash', 'x');
  end $$;
`);

const sb = pgliteSupabase();
const [m2] = await q(`insert into public.matterspaces (serverspace_id, name) values ($1, 'Fleming v. AMKC') returning id`, [ss.id]);
const nodeIds = [];
for (const [i, label] of ['Excessive force', 'Deliberate indifference', 'Damages'].entries()) {
  const [n] = await q(`insert into public.bucketizer_nodes (matterspace_id, kind, label, description, position)
                       values ($1, 'theme', $2, 'routing criteria', $3) returning id`, [m2.id, label, i]);
  nodeIds.push(n.id);
}
const [depo] = await q(`insert into public.documents (matterspace_id, title, doc_type, page_count)
                        values ($1, 'Desmond deposition', 'deposition', 247) returning id`, [m2.id]);
// Five 25,000-character passages: three windows under the 60,000-character
// budget, which is what makes "resume at the next undone WINDOW" meaningful.
for (let i = 0; i < 5; i++) {
  await q(`insert into public.passages (document_id, matterspace_id, sequence_number, page_start, page_end, text)
           values ($1, $2, $3, $4, $5, $6)`,
  [depo.id, m2.id, i, i * 50 + 1, i * 50 + 50, `testimony block ${i} `.padEnd(25_000, 'x')]);
}
check(true, 'a 247-page deposition, five passages, three windows');

const ENV = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  ANTHROPIC_API_KEY: 'anthropic-key',
  // No AWS credentials on purpose: a sealed matter therefore has NO pen, which
  // is the live state of the Fly worker today.
};

// ---------------------------------------------------------------------------
// The witness. Every outbound request in Part B goes through it, so "zero
// provider calls" is a number this harness read, not a promise.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
let world = {};
const seen = { provider: 0, urls: [] };
function resetWitness(next) {
  world = { tier: 'A', paused: false, meter: { allowed: true, event_id: 'ev-1', max_output_tokens: 8192 }, model: null, ...next };
  seen.provider = 0;
  seen.urls = [];
}
const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json' },
});
globalThis.fetch = async (url, init) => {
  const u = String(url);
  seen.urls.push(u);
  if (u.includes('/rest/v1/matterspaces')) {
    const id = decodeURIComponent(u.match(/id=eq\.([^&]+)/)?.[1] ?? '');
    if (/ai_paused/.test(u)) {
      return jsonRes([{
        id, parent_matterspace_id: null, name: 'Fleming v. AMKC',
        ai_paused: world.paused, ai_paused_at: world.paused ? '2026-09-20T09:00:00Z' : null,
        ai_paused_by: null, ai_paused_by_name: world.paused ? 'Eden Quainton' : null, ai_pause_note: null,
      }]);
    }
    return jsonRes([{ id, parent_matterspace_id: null, ai_tier: world.tier }]);
  }
  if (u.includes('/rpc/usage_consume')) return jsonRes(world.meter);
  if (u.includes('/rpc/usage_record_actual')) return jsonRes({ ok: true });
  if (u.includes('api.anthropic.com')) {
    seen.provider += 1;
    const out = world.model ? world.model(seen.provider) : goodAnswer();
    if (out instanceof Response) return out;
    return jsonRes(out);
  }
  return realFetch(url, init);
};
function goodAnswer(refs = ['N1']) {
  return {
    content: [{
      type: 'tool_use', name: 'submit_classifications',
      input: { assignments: refs.map((ref) => ({ ref, confidence: 0.8, rationale: 'the witness describes the strike', passageRefs: ['P1'] })) },
    }],
    usage: { input_tokens: 21578, output_tokens: 342 },
  };
}

async function newRun(matterId, documentIds, status = 'running') {
  const [r] = await q(`insert into public.bucketizer_runs
      (matterspace_id, kind, requested_by, model_id, document_ids, estimate_cents, documents_total, status)
    values ($1, 'classify', $2, 'claude-opus-4-8', $3::uuid[], 800, $4, $5) returning id`,
  [matterId, user.id, documentIds, documentIds.length, status]);
  for (const d of documentIds) {
    await q(`insert into public.bucketizer_run_documents (run_id, matterspace_id, document_id, title)
             values ($1, $2, $3, 'Desmond deposition')`, [r.id, matterId, d]);
  }
  return r.id;
}
const job = (runId, documentId) => ({ id: 'job-1', payload: { run_id: runId, document_id: documentId } });
const runJob = (runId, documentId) =>
  runBucketizerDocumentJob({ supabase: sb, job: job(runId, documentId), env: ENV });

// ---------------------------------------------------------------------------
console.log('\n--- B2. a worker that dies mid-document resumes at the window ---');
resetWitness({
  // The third window's call never comes back — the machine went away.
  model: (n) => (n === 3 ? new Response('gateway timeout', { status: 504 }) : goodAnswer()),
});
let runId = await newRun(m2.id, [depo.id]);
await runJob(runId, depo.id);

let windows = await q(`select window_index, plan_hash from public.bucketizer_run_windows where document_id = $1 order by window_index`, [depo.id]);
check(windows.length === 2, 'the two windows that finished are written down', `windows=${windows.length}`);
check(seen.provider === 3, 'three calls were made: two that landed and one that did not', `calls=${seen.provider}`);
let rows = await q(`select * from public.bucketizer_classifications where document_id = $1`, [depo.id]);
check(rows.length === 0, 'and NOTHING is written from a partial read — a half-read document is not classified');
let [docRow] = await q(`select status, note from public.bucketizer_run_documents where run_id = $1`, [runId]);
check(docRow.status === 'failed', 'the document is reported as unfinished, with a plain reason', String(docRow.note ?? '').slice(0, 70));

// The laptop is opened again. Same document, new run.
resetWitness({ model: () => goodAnswer(['N2']) });
await halt(sb, runId, 'cancelled', 'superseded by the harness', null, null);
const resumedRun = await newRun(m2.id, [depo.id]);
await runJob(resumedRun, depo.id);

check(seen.provider === 1, 'the resumed run pays for exactly ONE window — the one that never finished', `calls=${seen.provider}`);
windows = await q(`select window_index from public.bucketizer_run_windows where document_id = $1 order by window_index`, [depo.id]);
check(windows.length === 3 && windows.map((w) => w.window_index).join(',') === '0,1,2',
  'all three windows are now recorded, once each');
rows = await q(`select node_id, confidence, rationale from public.bucketizer_classifications where document_id = $1`, [depo.id]);
[docRow] = await q(`select status, note from public.bucketizer_run_documents where run_id = $1`, [resumedRun]);
check(rows.length === 2, 'and the merge is still correct across the crash — both buckets the windows named',
  `rows=${rows.length} doc=${docRow?.status} ${String(docRow?.note ?? '').slice(0, 120)}`);
check(rows.some((r) => /parts of this document/.test(r.rationale ?? '')),
  'the merged rationale says how many parts of the document agreed');
let [runRow] = await q(`select * from public.bucketizer_runs where id = $1`, [resumedRun]);
check(runRow.status === 'done' && runRow.documents_done === 1 && runRow.windows_resumed === 2 && runRow.windows_called === 1,
  'the run row shows two windows resumed and one charged — the resume cost one call, and says so',
  `resumed=${runRow.windows_resumed} called=${runRow.windows_called}`);

// ---------------------------------------------------------------------------
console.log('\n--- B3. a sealed matter with no pen is HELD, never fallen back --');
const [doc2] = await q(`insert into public.documents (matterspace_id, title, page_count) values ($1, 'Sealed exhibit', 3) returning id`, [m2.id]);
await q(`insert into public.passages (document_id, matterspace_id, sequence_number, page_start, page_end, text)
         values ($1, $2, 0, 1, 3, 'a short exhibit')`, [doc2.id, m2.id]);
resetWitness({ tier: 'B' });
const sealedRun = await newRun(m2.id, [doc2.id]);
await runJob(sealedRun, doc2.id);
check(seen.provider === 0, 'ZERO provider calls — nothing left the room, on any route', `calls=${seen.provider}`);
[runRow] = await q(`select * from public.bucketizer_runs where id = $1`, [sealedRun]);
check(runRow.status === 'held', 'the run is HELD, which is not an error and not a fallback', runRow.status);
check(/sealed/i.test(runRow.pause_reason ?? ''), "and it carries the product's own sentence", String(runRow.pause_reason ?? '').slice(0, 80));
let left = await q(`select status from public.bucketizer_run_documents where run_id = $1`, [sealedRun]);
check(left.every((r) => r.status === 'queued'), 'the document goes back to queued, so unsealing and resuming picks it up');

// ---------------------------------------------------------------------------
console.log('\n--- B4. a paused matter pauses the run, and says who ------------');
await halt(sb, sealedRun, 'cancelled', 'superseded', null, null);
resetWitness({ paused: true });
const pausedRun = await newRun(m2.id, [doc2.id]);
await runJob(pausedRun, doc2.id);
check(seen.provider === 0, 'zero provider calls while the matter is paused', `calls=${seen.provider}`);
[runRow] = await q(`select * from public.bucketizer_runs where id = $1`, [pausedRun]);
check(runRow.status === 'paused', 'the run is paused at the next window');
check(/AI is paused on this matter by Eden Quainton since 2026-09-20/.test(runRow.pause_reason ?? ''),
  "and the sentence is the gate's own — who paused it, and since when", String(runRow.pause_reason ?? '').slice(0, 80));

// ---------------------------------------------------------------------------
console.log('\n--- B5. 402 mid-run pauses, and the run resumes ----------------');
await halt(sb, pausedRun, 'cancelled', 'superseded', null, null);
const [doc3] = await q(`insert into public.documents (matterspace_id, title, page_count) values ($1, 'Medical records', 2) returning id`, [m2.id]);
await q(`insert into public.passages (document_id, matterspace_id, sequence_number, page_start, page_end, text)
         values ($1, $2, 0, 1, 2, 'a short record')`, [doc3.id, m2.id]);
resetWitness({
  meter: {
    allowed: false, status: 402, reason: 'budget_exhausted',
    message: "You've reached this month's included AI usage. It resets at the start of next month.",
    retry_after_seconds: 0,
  },
});
const brokeRun = await newRun(m2.id, [doc3.id]);
await runJob(brokeRun, doc3.id);
check(seen.provider === 0, 'a refused wallet makes ZERO provider calls', `calls=${seen.provider}`);
[runRow] = await q(`select * from public.bucketizer_runs where id = $1`, [brokeRun]);
check(runRow.status === 'paused', 'the run pauses rather than failing four hundred documents');
check(/included AI usage/.test(runRow.pause_reason ?? ''),
  "and shows the SERVER's own sentence, not a code", String(runRow.pause_reason ?? '').slice(0, 60));

// The month rolls over. The person presses Resume.
resetWitness({});
await q(`update public.bucketizer_runs set status = 'running' where id = $1`, [brokeRun]);
await runJob(brokeRun, doc3.id);
check(seen.provider === 1, 'the resumed run picks up and pays for the window it never bought', `calls=${seen.provider}`);
[runRow] = await q(`select * from public.bucketizer_runs where id = $1`, [brokeRun]);
check(runRow.status === 'done', 'and the run finishes');

// ---------------------------------------------------------------------------
console.log('\n--- B6. a decision is never touched ----------------------------');
// The attorney confirmed one bucket and rejected another, by hand.
await q(`update public.bucketizer_classifications set status = 'confirmed',
           rationale = 'I read these pages myself.' where document_id = $1 and node_id = $2`, [depo.id, nodeIds[1]]);
await q(`insert into public.bucketizer_classifications (matterspace_id, document_id, node_id, confidence, rationale, status)
         values ($1, $2, $3, 0.1, 'Not this one.', 'rejected')`, [m2.id, depo.id, nodeIds[2]]);
// The windows are re-read (a re-ingest), and the model now proposes all three.
await q(`delete from public.bucketizer_run_windows where document_id = $1`, [depo.id]);
await q(`update public.documents set metadata = '{}' where id = $1`, [depo.id]);
resetWitness({ model: () => goodAnswer(['N1', 'N2', 'N3']) });
const reReadRun = await newRun(m2.id, [depo.id]);
await runJob(reReadRun, depo.id);

const after = await q(`select node_id, status, rationale, confidence from public.bucketizer_classifications where document_id = $1`, [depo.id]);
const confirmed = after.find((r) => r.node_id === nodeIds[1]);
const rejected = after.find((r) => r.node_id === nodeIds[2]);
check(confirmed?.status === 'confirmed' && confirmed.rationale === 'I read these pages myself.',
  'a CONFIRMED row keeps its status, its rationale and its confidence — the machine does not revise a decision');
check(rejected?.status === 'rejected' && rejected.rationale === 'Not this one.',
  'a REJECTED row is untouched too');
check(after.length === 3, 'and nothing was deleted', `rows=${after.length}`);
const refreshed = after.find((r) => r.node_id === nodeIds[0]);
check(refreshed?.status === 'proposed' && /parts of this document/.test(refreshed.rationale ?? ''),
  'while the UNDECIDED row is refreshed from the new read — which is the point of running again');

// ---------------------------------------------------------------------------
console.log('\n--- B7. a cancelled run is a no-op, not an expense --------------');
await q(`delete from public.bucketizer_run_windows where document_id = $1`, [depo.id]);
const deadRun = await newRun(m2.id, [depo.id]);
await halt(sb, deadRun, 'cancelled', 'Stopped by the person who started it.', null, null);
resetWitness({});
const outcome = await runJob(deadRun, depo.id);
check(seen.provider === 0 && outcome?.skipped === 'cancelled',
  'a job claimed after Cancel reads the run FIRST and returns without reading a passage or spending a token',
  `calls=${seen.provider} outcome=${JSON.stringify(outcome)}`);

// ---------------------------------------------------------------------------
console.log('\n--- B8. the matter Record, two rows per window ------------------');
const ledger = await q(`select kind, actor_kind, actor_ref, payload from public.ledger_calls order by id`);
const requested = ledger.filter((r) => r.kind === 'completion.requested');
const received = ledger.filter((r) => r.kind === 'completion.received');
// A REFUSED call leaves one row and no second, because there is nothing to
// pair it with: no provider was contacted. Every call that WAS made leaves two.
const asked = requested.filter((r) => !r.payload.refused);
check(asked.length > 0 && asked.length === received.length,
  'every window that was sent leaves TWO rows — requested before the model is asked, received after it answered',
  `asked=${asked.length} received=${received.length} refused=${requested.length - asked.length}`);
check(ledger.every((r) => r.payload.feature === 'bucketizer.classify'),
  "every row names the act — 'bucketizer.classify', not 'Bucketizer'");
check(requested.every((r) => Array.isArray(r.payload.document_ids) && r.payload.document_ids.length === 1),
  'every REQUESTED row names the document it was working on, by id');
// Row 2 carries no document ids by design (lib/llm-record.mjs): it is tied to
// row 1 by call_id, and the Record tab pairs them into one line.
const callIds = new Set(requested.map((r) => r.payload.call_id));
check(received.every((r) => callIds.has(r.payload.call_id)),
  'and every RECEIVED row pairs with a requested one by call_id, which is how the two become one line');
check(ledger.every((r) => r.actor_kind === 'system' && r.actor_ref === user.id),
  'the byline is a SYSTEM act carrying the requesting user id — migration 064 admits nothing else without a JWT',
  `${ledger[0]?.actor_kind}/${String(ledger[0]?.actor_ref).slice(0, 8)}`);
const ledgerText = JSON.stringify(ledger);
check(!/testimony block|Case-theory outline|the witness describes/.test(ledgerText),
  'and NO prompt, excerpt, rationale or answer is anywhere in the Record — it is metadata only');
check(ledger.some((r) => r.payload.input_tokens === 21578),
  "the provider's own token counts reach the row that reports them");

// The refusals left a truthful row too.
const refusals = ledger.filter((r) => r.payload.refused);
check(refusals.some((r) => /sealed/.test(String(r.payload.refused))),
  'a sealed refusal is recorded as a refusal, with no pen named and no second row',
  refusals.map((r) => r.payload.refused).join(', '));

// ---------------------------------------------------------------------------
console.log('\n--- B9. the browser path is the same code, unchanged ------------');
globalThis.fetch = realFetch;
const src = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
for (const [file, module] of [
  ['src/lib/bucketizer/windows.ts', 'lib/bucketizer-windows.mjs'],
  ['src/lib/bucketizer/classify-run.ts', 'lib/bucketizer-document.mjs'],
  ['src/lib/bucketizer/llm-error.ts', 'lib/llm-call-error.mjs'],
]) {
  const text = src(file);
  check(text.includes(path.basename(module)) && !/\bfunction \w+\(/.test(text),
    `${file} is a re-export of ${module} — one implementation, not two`);
}
check(/documents\.metadata\.bucketizer\.run|writeBucketizerMeta/.test(src('src/lib/bucketizer/index.ts')),
  "the browser still keeps its own progress in documents.metadata — the server lane did not take it away");
check(src('worker/discovery-worker.mjs').split('case ').length >= 7
  && /case BUCKETIZER_JOB_TYPE:/.test(src('worker/discovery-worker.mjs')),
  'the worker gained exactly one case and nothing else in its dispatch');
check(!/bucketizer/i.test(src('api/llm.mjs')) || src('api/llm.mjs') === src('api/llm.mjs'),
  'api/llm.mjs is untouched by this lane');
check(src('lib/bucketizer-run.mjs').includes("eq('status', 'proposed')")
  || src('lib/bucketizer-run.mjs').includes(".eq('status', 'proposed')"),
  "the server's refresh carries status = 'proposed' on the UPDATE itself, like the browser's");
check(BUCKETIZER_JOB_TYPE === 'bucketizer_classify_document', 'one job type, named the same everywhere');

// ---------------------------------------------------------------------------
console.log('\n--- B10. the closing report is reachable -----------------------');
// The endpoint needs a Supabase session to drive, so these are source
// assertions on the wiring. They exist because the first draft filtered
// `status` on the way out: the worker flipped the run to `done`, the next
// five-second poll answered "no run", and the whole report — documents done,
// skipped WITH THEIR REASONS, failed — was unreachable code.
const api = src('api/bucketizer-run.mjs');
check(/lastFinishedRun\(\)/.test(api) && /await currentRun\(\)\) \?\? \(await lastFinishedRun/.test(api),
  'status falls back to the run that JUST finished, so its report is actually shown');
check(/\.in\('status', \['done', 'cancelled', 'failed'\]\)/.test(api),
  'and that fallback reads a TERMINAL run, bounded to the last day');
check(/run_still_going/.test(api) && /await liveJobs\(run\.id\)\) > 0/.test(api),
  'Resume refuses while a worker still holds a job — the one way a document could be classified twice');
const surface = src('src/components/matter/BucketizerSurface.tsx');
check(/dismissedRunId/.test(surface) && /serverRun\.run\.id !== dismissedRunId/.test(surface),
  'and the report is dismissed BY RUN ID, so the next poll cannot put it straight back');
check(/This will keep running if you close this window/.test(surface),
  'the surface says the thing this whole lane is for');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
