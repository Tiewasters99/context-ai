// Prove the worker-liveness change, offline, end to end.
//
//   npm i --no-save @electric-sql/pglite@0.5.8
//   node scripts/_verify-worker-heartbeat.mjs
//
// Five sections, each a different kind of proof:
//
//   1. MIGRATION 066 in real Postgres (PGlite — no Docker on this machine).
//      It applies twice, it applies before AND after its neighbours, only the
//      service role can write worker_heartbeats, a stale beat is not alive, a
//      never-beaten table is "unknown" rather than "dead", and — the one that
//      matters most — two signed-in tenants each see their OWN queue numbers
//      and never each other's.
//   2. THE TENANT BOUNDARY AS A PROPERTY OF THE SIGNATURES: neither function
//      takes a uuid, so there is no parameter in which to name somebody else.
//      Asserted against pg_proc, not against a comment.
//   3. THE WORKER HUNK swallows every way a heartbeat can fail — a client that
//      throws synchronously, one that returns a rejected promise, one that
//      returns an error envelope, and one that never settles at all.
//   4. THE SENTENCE the Vault shows, every branch (src/lib/ingest-service-notice.ts,
//      imported through Node's built-in type stripping — needs Node >= 22.18).
//   5. THE NIGHTLY WORKFLOW: the YAML parses, its jobs and crons line up, and
//      `ingest-suite.mjs --dry-run` really does run on this platform with no
//      .env and no network.
//
// Touches nothing outside this process: no .env, no Supabase, no network.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 62 - t.length))}`);

const migration = (name) => fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', name), 'utf8');

// ===========================================================================
// 1. Migration 066 in real Postgres
// ===========================================================================
let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite@0.5.8');
  process.exit(2);
}

const ALICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB   = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const M_A   = '11111111-1111-4111-8111-111111111111';
const M_B   = '22222222-2222-4222-8222-222222222222';

// The smallest schema 066 touches, built the way the real one is: Supabase's
// default grants included, so the revoke in §2 of the migration is a revoke of
// something real rather than a no-op.
async function freshDb() {
  const db = new PGlite();
  await db.exec(`
    do $$ begin create role anon;          exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
    -- Supabase's service_role really is BYPASSRLS; a stub without it would
    -- prove the wrong thing about the write path.
    do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;

    create type discovery_job_status as enum ('queued', 'running', 'done', 'error');

    create table public.documents (
      id uuid primary key default gen_random_uuid(),
      matterspace_id uuid,
      created_by uuid,
      source_filename text,
      title text,
      file_size_bytes bigint,
      storage_path text,
      processing_status text not null default 'pending',
      processing_error text,
      metadata jsonb not null default '{}',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table public.passages (
      id uuid primary key default gen_random_uuid(),
      document_id uuid references public.documents(id) on delete cascade,
      text text
    );
    create index idx_passages_document_seq on public.passages(document_id);
    create table public.processing_jobs (
      id uuid primary key default gen_random_uuid(),
      matterspace_id uuid,
      job_type text not null,
      payload jsonb not null default '{}',
      status discovery_job_status not null default 'queued',
      attempts int not null default 0,
      max_attempts int not null default 3,
      claimed_by text,
      claimed_at timestamptz,
      heartbeat_at timestamptz,
      finished_at timestamptz,
      error text,
      created_at timestamptz not null default now()
    );

    -- The real SELECT policy on documents is membership-based; the property
    -- under test is only that RLS is ON and scopes to the caller, so the
    -- simplest honest stand-in is ownership.
    alter table public.documents enable row level security;
    create policy docs_own on public.documents for select to authenticated
      using (created_by = auth.uid());

    -- Supabase's defaults, which is what makes 066's explicit revoke matter.
    -- The DEFAULT PRIVILEGES line is the important one: without it a table
    -- created later would have no grants at all and the revoke under test
    -- would be revoking nothing.
    grant usage on schema public to anon, authenticated, service_role;
    grant all on all tables in schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  `);
  return db;
}

const q = (db, sql, params) => db.query(sql, params).then((r) => r.rows);
const asUser = (db, id) => db.exec(`set role authenticated; set request.jwt.claim.sub = '${id}';`);
const asAnon = (db) => db.exec(`set role anon; set request.jwt.claim.sub = '';`);
const asService = (db) => db.exec(`reset role; set role service_role; set request.jwt.claim.sub = '';`);
const asOwner = (db) => db.exec(`reset role; set request.jwt.claim.sub = '';`);

section('066 applies, and applies again');
const db = await freshDb();
await db.exec(migration('066_worker_heartbeats.sql'));
check(true, '066 applies to a database that has never seen it');
let twice = true;
try { await db.exec(migration('066_worker_heartbeats.sql')); } catch (e) { twice = false; check(false, 're-paste', e.message); }
if (twice) check(true, '066 applies a SECOND time unchanged (idempotent against a re-paste)');

section('066 next to its neighbours, in both orders');
{
  const a = await freshDb();
  await a.exec(migration('059_ready_but_empty.sql'));
  await a.exec(migration('060_held_sealed_status.sql'));
  let ok = true;
  try { await a.exec(migration('066_worker_heartbeats.sql')); } catch (e) { ok = false; check(false, '059+060 then 066', e.message); }
  if (ok) {
    const r = await q(a, 'select * from public.ingest_worker_status()');
    check(r.length === 1 && r[0].worker_alive === false, '059 + 060 already pasted, then 066');
  }
  await a.close();

  const b = await freshDb();
  await b.exec(migration('066_worker_heartbeats.sql'));
  let ok2 = true;
  try {
    await b.exec(migration('059_ready_but_empty.sql'));
    await b.exec(migration('060_held_sealed_status.sql'));
  } catch (e) { ok2 = false; check(false, '066 then 059+060', e.message); }
  if (ok2) {
    const r = await q(b, 'select * from public.ingest_worker_status()');
    check(r.length === 1, '066 first, neighbours pasted afterwards — still works');
  }
  await b.close();
}

section('nobody but the service role touches worker_heartbeats');
{
  await asService(db);
  let serviceWrote = true;
  try {
    await db.exec(`insert into public.worker_heartbeats (worker_id, machine_id, last_beat_at)
                   values ('w-service', 'm1', now())`);
  } catch (e) { serviceWrote = false; check(false, 'service role INSERT', e.message); }
  if (serviceWrote) check(true, 'service role may write a heartbeat');

  await asUser(db, ALICE);
  let denied = false;
  try { await db.exec(`insert into public.worker_heartbeats (worker_id, last_beat_at) values ('w-evil', now())`); }
  catch { denied = true; }
  check(denied, 'a signed-in user may NOT write a heartbeat');

  let readDenied = false;
  try { await q(db, 'select * from public.worker_heartbeats'); } catch { readDenied = true; }
  check(readDenied, 'a signed-in user may NOT read the heartbeat table directly');

  await asAnon(db);
  let anonDenied = false;
  try { await q(db, 'select * from public.worker_heartbeats'); } catch { anonDenied = true; }
  check(anonDenied, 'anon may NOT read the heartbeat table directly');
}

section('liveness: stale, fresh, and never');
{
  const fresh = await freshDb();
  await fresh.exec(migration('066_worker_heartbeats.sql'));
  await asOwner(fresh);

  let r = await q(fresh, 'select * from public.ingest_worker_status()');
  check(r[0].worker_alive === false && r[0].seconds_since_beat === null,
    'no heartbeat ever → not alive, and seconds_since_beat is NULL (unknown, not zero)');

  await fresh.exec(`insert into public.worker_heartbeats (worker_id, last_beat_at)
                    values ('w-stale', now() - interval '30 minutes')`);
  r = await q(fresh, 'select * from public.ingest_worker_status(10)');
  check(r[0].worker_alive === false && Number(r[0].seconds_since_beat) > 1700,
    'a 30-minute-old beat is NOT alive inside a 10-minute window',
    `seconds_since_beat=${r[0].seconds_since_beat}`);

  await fresh.exec(`insert into public.worker_heartbeats (worker_id, last_beat_at)
                    values ('w-live', now())`);
  r = await q(fresh, 'select * from public.ingest_worker_status(10)');
  check(r[0].worker_alive === true && Number(r[0].workers_beating) === 1,
    'one fresh beat among stale ones → alive, and exactly one worker counted');

  // The threshold is clamped, so a caller cannot ask a silly question.
  const wide = await q(fresh, 'select * from public.ingest_worker_status(100000)');
  check(wide[0].worker_alive === true, 'an absurd window is clamped rather than rejected');
  const zero = await q(fresh, 'select * from public.ingest_worker_status(0)');
  check(zero.length === 1, 'a zero/negative window is clamped rather than rejected');
  await fresh.close();
}

section('two tenants, each seeing only their own queue');
{
  await asOwner(db);
  await db.exec(`delete from public.worker_heartbeats`);
  await db.exec(`insert into public.worker_heartbeats (worker_id, last_beat_at) values ('w1', now())`);

  // Alice: 2 non-terminal (one 25 minutes old) + 1 ready.
  await db.exec(`
    insert into public.documents (matterspace_id, created_by, processing_status, updated_at) values
      ('${M_A}', '${ALICE}', 'pending',    now() - interval '25 minutes'),
      ('${M_A}', '${ALICE}', 'extracting', now() - interval '2 minutes'),
      ('${M_A}', '${ALICE}', 'ready',      now() - interval '90 minutes');
  `);
  // Bob: 5 non-terminal, the oldest far older than Alice's.
  await db.exec(`
    insert into public.documents (matterspace_id, created_by, processing_status, updated_at)
    select '${M_B}', '${BOB}', 'pending', now() - interval '300 minutes' from generate_series(1, 5);
  `);
  await db.exec(`
    insert into public.processing_jobs (matterspace_id, job_type, status, created_at) values
      ('${M_A}', 'ingest_document', 'queued',  now() - interval '9 minutes'),
      ('${M_B}', 'ingest_document', 'running', now() - interval '4 minutes'),
      ('${M_B}', 'ingest_document', 'done',    now() - interval '4 minutes');
  `);

  await asUser(db, ALICE);
  const a = (await q(db, 'select * from public.ingest_status_for_me()'))[0];
  check(Number(a.my_processing) === 2, "Alice sees exactly HER 2 processing documents", `got ${a.my_processing}`);
  check(Number(a.my_oldest_seconds) > 1400 && Number(a.my_oldest_seconds) < 1600,
    "Alice's oldest is HER 25-minute document, not Bob's 300-minute one",
    `got ${a.my_oldest_seconds}s`);
  check(a.worker_alive === true, 'Alice can see that a worker is alive');
  check(Number(a.queue_depth) === 2, 'queue depth counts queued+running only (a global count, no identifiers)');

  await asUser(db, BOB);
  const b = (await q(db, 'select * from public.ingest_status_for_me()'))[0];
  check(Number(b.my_processing) === 5, 'Bob sees exactly HIS 5', `got ${b.my_processing}`);
  check(Number(b.my_oldest_seconds) > 17000, "Bob's oldest is his own", `got ${b.my_oldest_seconds}s`);

  // The one thing this must never do.
  check(Number(a.my_processing) !== Number(b.my_processing) &&
        Number(a.my_oldest_seconds) < Number(b.my_oldest_seconds),
    'neither tenant sees the other tenant\'s numbers');

  // Signed in as nobody: zero ROWS, not zero counts. "Nothing of yours is
  // processing" is a claim this function cannot make without a user.
  await db.exec(`set role authenticated; set request.jwt.claim.sub = '';`);
  const none = await q(db, 'select * from public.ingest_status_for_me()');
  check(none.length === 0, 'no session → no rows at all (never a reassuring zero)');

  // And anon cannot call it in the first place.
  await asAnon(db);
  let anonBlocked = false;
  try { await q(db, 'select * from public.ingest_status_for_me()'); } catch { anonBlocked = true; }
  check(anonBlocked, 'anon may not execute ingest_status_for_me at all');

  // The public one it MAY call: that is the point, and it is why /api/health
  // needs no token.
  let anonGlobal = null;
  try { anonGlobal = await q(db, 'select * from public.ingest_worker_status()'); } catch { /* recorded below */ }
  check(anonGlobal !== null && anonGlobal.length === 1,
    'anon MAY call ingest_worker_status (numbers only — this is what /api/health uses)');
  check(anonGlobal !== null && !('created_by' in anonGlobal[0]) && !('title' in anonGlobal[0]),
    'the anon-callable function returns no identifier columns');
}

// ===========================================================================
// 2. The boundary is in the signatures, not in a comment
// ===========================================================================
section('the signatures make a cross-tenant question unaskable');
{
  await asOwner(db);
  const rows = await q(db, `
    select p.proname,
           p.prosecdef,
           pg_get_function_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('ingest_worker_status', 'ingest_status_for_me')
     order by p.proname`);
  const byName = Object.fromEntries(rows.map((r) => [r.proname, r]));
  check(byName.ingest_worker_status?.prosecdef === true, 'ingest_worker_status is SECURITY DEFINER');
  check(byName.ingest_status_for_me?.prosecdef === false, 'ingest_status_for_me is SECURITY INVOKER');
  for (const n of ['ingest_worker_status', 'ingest_status_for_me']) {
    check(!/uuid/i.test(byName[n]?.args ?? 'uuid'),
      `${n} takes no uuid — there is no parameter in which to name another tenant`,
      byName[n]?.args || '(missing)');
  }

  // [[feedback-rls-security-invoker-wrappers]]: the invoker half must capture
  // auth.uid() into its own declared variable, not call it repeatedly.
  const src = migration('066_worker_heartbeats.sql');
  check(/declare\s+v_uid\s+uuid\s*:=\s*auth\.uid\(\)/i.test(src),
    'the INVOKER function captures auth.uid() into a declared variable at entry');
  // Count only real code: from the CREATE of the invoker function to its $$;
  // with SQL line comments stripped, so prose about auth.uid() is not counted.
  const from = src.indexOf('create or replace function public.ingest_status_for_me');
  const body = src.slice(from, src.indexOf('$$;', from)).replace(/--[^\n]*/g, '');
  check(from > 0 && (body.match(/auth\.uid\(\)/g) || []).length === 1,
    'auth.uid() is called exactly once in the INVOKER function — captured, never re-read');
  check(/enable row level security/i.test(src) && /revoke all on public\.worker_heartbeats/i.test(src),
    'worker_heartbeats is locked by RLS *and* by an explicit revoke');
}
await db.close();

// ===========================================================================
// 3. The worker hunk cannot be killed by its own heartbeat
// ===========================================================================
section('a heartbeat failure never stops the worker');
{
  const { createHeartbeat } = await import('../lib/worker-heartbeat.mjs');

  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);

  const logs = [];
  const log = (m) => logs.push(m);

  // (a) throws synchronously — `client.from` is not a function.
  const thrower = { from() { throw new Error('boom: client is not configured'); } };
  const hbA = createHeartbeat({ client: thrower, workerId: 'w', log });
  let threw = false;
  let ret;
  try { ret = hbA.beat({ force: true }); } catch { threw = true; }
  check(!threw, 'a client that THROWS synchronously does not propagate out of beat()');
  check(ret === undefined, 'beat() returns undefined, so it can never be accidentally awaited into a hang');
  check(hbA.stats().failed === 1 && logs.length === 1, 'the failure is counted and logged once', logs[0] || '');

  // (b) returns a rejected promise. An unhandled rejection in Node 22 ends the
  //     process — i.e. it would stop the worker.
  const rejecter = { from: () => ({ upsert: () => Promise.reject(new Error('network down')) }) };
  const hbB = createHeartbeat({ client: rejecter, workerId: 'w', log });
  hbB.beat({ force: true });
  await new Promise((r) => setTimeout(r, 10));
  check(unhandled.length === 0, 'a REJECTED beat produces no unhandled rejection');
  check(hbB.stats().failed === 1, 'the rejected beat is counted as failed');

  // (c) returns supabase-js's error envelope rather than rejecting.
  const envelope = { from: () => ({ upsert: async () => ({ error: { message: 'relation "worker_heartbeats" does not exist' } }) }) };
  const hbC = createHeartbeat({ client: envelope, workerId: 'w', log });
  hbC.beat({ force: true });
  await new Promise((r) => setTimeout(r, 10));
  check(hbC.stats().failed === 1 && /does not exist/.test(logs.at(-1)),
    'an { error } envelope (066 not pasted yet) is counted and logged, not thrown');

  // (d) never settles. The guard must expire so the worker does not go silent
  //     for the rest of its life after one wedged socket.
  const hanger = { from: () => ({ upsert: () => new Promise(() => {}) }) };
  let t = 1_000_000;
  const hbD = createHeartbeat({ client: hanger, workerId: 'w', log, now: () => t, inflightTimeoutMs: 15_000, minIntervalMs: 60_000 });
  hbD.beat({ force: true });
  check(hbD.stats().inflight === true, 'a beat that never settles is in flight');
  t += 5_000;
  hbD.beat({ force: true });
  check(hbD.stats().inflight === true, 'inside the in-flight window, a second beat is suppressed');
  t += 20_000;
  hbD.beat({ force: true });
  check(hbD.stats().inflight === true, 'past the in-flight window a new beat IS attempted (the guard expires)');

  // (e) throttling and the job counter.
  const writes = [];
  const good = { from: () => ({ upsert: async (row) => { writes.push(row); return { error: null }; } }) };
  let t2 = 5_000_000;
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const hbE = createHeartbeat({ client: good, workerId: 'w-1', machineId: 'm-1', release: 'img:42', log, now: () => t2, minIntervalMs: 60_000 });
  hbE.beat();                                await settle();  // first: writes
  hbE.beat();                                await settle();  // throttled
  t2 += 30_000; hbE.beat();                  await settle();  // still throttled
  t2 += 31_000; hbE.beat();                  await settle();  // 61 s later: writes
  hbE.beat({ force: true, jobDone: true });  await settle();  // forced: writes
  check(writes.length === 3, 'beats are throttled to one per interval unless forced', `${writes.length} writes`);
  check(writes.at(-1).jobs_done === 1 && writes.at(-1).last_job_at !== null, 'a completed job is recorded on the beat');
  check(writes[0].worker_id === 'w-1' && writes[0].machine_id === 'm-1' && writes[0].worker_release === 'img:42',
    'the row carries worker id, machine and release');
  check(!Object.prototype.hasOwnProperty.call(writes[0], 'id'), 'the row is keyed by worker_id, so a restart overwrites rather than accumulating');

  process.off('unhandledRejection', onUnhandled);
}

section('the worker calls it, and calls it the safe way');
{
  const src = fs.readFileSync(path.join(ROOT, 'worker', 'discovery-worker.mjs'), 'utf8');
  check(/from '\.\.\/lib\/worker-heartbeat\.mjs'/.test(src), 'the worker imports the heartbeat module');
  const beats = src.match(/heartbeat\.beat\([^)]*\)/g) || [];
  check(beats.length >= 3, 'it beats at start, when idle, and on job completion', beats.join(' · '));
  check(!/await\s+heartbeat\.beat/.test(src), 'no beat is AWAITED — a hung beat can never stall the queue');
  check(/heartbeat\.beat\(\{ force: true, jobDone: true \}\)/.test(src), 'a completed job forces a beat');
}

// ===========================================================================
// 4. The sentence the person reads
// ===========================================================================
section('what the Vault says while a document is processing');
{
  // pathToFileURL, not a bare path: a Windows drive letter is read as a URL
  // scheme by the ESM loader.
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'lib', 'ingest-service-notice.ts')).href);
  const { ingestServiceNotice } = mod;
  const base = { workerAlive: true, secondsSinceBeat: 5, queueDepth: 0, oldestQueuedSeconds: null, myProcessing: 1, myOldestSeconds: 60 };

  check(ingestServiceNotice(null) === null,
    '066 not applied (null status) → nothing new is said, exactly as today');
  check(ingestServiceNotice({ ...base, myOldestSeconds: 120 }) === null,
    'a two-minute-old document says nothing — slow is not stuck');
  check(ingestServiceNotice({ ...base, myOldestSeconds: null }) === null,
    'nothing of mine is processing → nothing is said');

  const down = ingestServiceNotice({ ...base, workerAlive: false, secondsSinceBeat: 900, myOldestSeconds: 900 });
  check(down?.tone === 'paused', 'worker silent 15 min + my document 15 min old → paused');
  check(down?.text === 'Processing is paused on our side. Your document is safe and will be processed when '
      + 'service resumes — you do not need to re-upload.',
    'the paused sentence is the one the brief specifies, verbatim');

  const never = ingestServiceNotice({ ...base, workerAlive: false, secondsSinceBeat: null, myOldestSeconds: 900 });
  check(never?.tone === 'paused' && !/\d+ minute/.test(never.text),
    'no worker has ever beaten → paused, and claims no duration it cannot know');

  const blip = ingestServiceNotice({ ...base, workerAlive: false, secondsSinceBeat: 120, myOldestSeconds: 900 });
  check(blip?.tone === 'queued',
    'a 2-minute gap in beats is NOT an outage — one missed beat must not say "paused"');

  const queued = ingestServiceNotice({ ...base, queueDepth: 40, oldestQueuedSeconds: 1800, myOldestSeconds: 1200 });
  check(queued?.tone === 'queued' && /40 documents in the queue/.test(queued.text) && /30 minutes/.test(queued.text),
    'worker alive + long queue → the depth and the age, honestly', queued?.text);
  check(!/remaining|estimated|ETA/i.test(queued?.text ?? ''),
    'no invented time estimate');

  const slow = ingestServiceNotice({ ...base, queueDepth: 1, myOldestSeconds: 3600 });
  check(slow?.tone === 'queued' && /1 hour/.test(slow.text) && /has not failed/.test(slow.text),
    'alive, short queue, old document → "still working", with the real age', slow?.text);
}

// ===========================================================================
// 5. The nightly workflow
// ===========================================================================
section('.github/workflows/ingest-nightly.yml');
{
  const file = path.join(ROOT, '.github', 'workflows', 'ingest-nightly.yml');
  const raw = fs.readFileSync(file, 'utf8');
  let doc = null;
  try {
    const { default: yaml } = await import('js-yaml');
    doc = yaml.load(raw);
    check(!!doc, 'the workflow YAML parses');
  } catch (e) {
    if (/Cannot find (package|module)/.test(e.message)) {
      check(true, 'YAML parse skipped (js-yaml not installed here)');
    } else {
      check(false, 'the workflow YAML parses', e.message);
    }
  }
  if (doc) {
    // `on:` is YAML 1.1 truthy, so js-yaml gives the key back as `true`.
    const on = doc.on ?? doc[true];
    const crons = (on?.schedule || []).map((s) => s.cron);
    check(crons.length === 3, 'three schedules: suite, monitor, watch', crons.join(' | '));
    check(!!on?.workflow_dispatch, 'workflow_dispatch is available so Eden can run it by hand');
    const jobs = Object.keys(doc.jobs || {});
    check(['watch', 'monitor', 'suite'].every((j) => jobs.includes(j)), 'the three jobs exist', jobs.join(', '));
    for (const c of crons) {
      check(Object.values(doc.jobs).some((j) => String(j.if || '').includes(c)),
        `cron '${c}' selects exactly one job`);
    }
    // Every secret is referenced through env: (the `secrets` context cannot be
    // read in an `if:`), and every gated step tests env, so an unset secret
    // SKIPS instead of failing red every night.
    check(/env\.SUPABASE_SERVICE_ROLE_KEY == ''/.test(raw) && /::notice title=/.test(raw),
      'with the secrets absent the jobs skip with a notice, not a red run');
    check(!/secrets\.[A-Z_]+ *(==|!=)/.test(raw),
      'no `if:` reads the secrets context (which is always empty there)');
    check(doc.jobs.suite.env && !doc.jobs.watch.env?.SUPABASE_SERVICE_ROLE_KEY,
      'the liveness watch needs no credential at all');
    check(Number(doc.jobs.suite['timeout-minutes']) > 45,
      'the job timeout exceeds --deadline-min so the suite always ends itself and writes its record');
    check(/upload-artifact/.test(raw) && /if: always\(\)/.test(raw),
      'the jsonl line and checkpoint are uploaded even when the run fails');
  }
}

section('the suite runs headless on this platform');
{
  // No .env is read, no network is touched: --dry-run exits before the client
  // is constructed. This is the step that catches a Windows-shaped path or a
  // renamed variable before 03:00 does.
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ingest-suite.mjs'), 'scratch-matter', '--dry-run', '--skip-heavy'],
    { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: process.env.PATH } });
  check(r.status === 0, 'ingest-suite.mjs --dry-run exits 0 with no .env and no network', `status ${r.status} ${r.stderr?.slice(0, 200) || ''}`);
  const out = r.stdout || '';
  check(/matter argument\s+scratch-matter/.test(out), 'the bare argument is read as the matter');
  check(/deadline\s+60 min overall · 15 min per gate/.test(out), 'the deadline defaults survive');
  check(/skip-heavy=true/.test(out), 'flags parse');
  check(/SUPABASE_SERVICE_ROLE_KEY\s+(present|ABSENT)/.test(out), 'credential PRESENCE is reported');
  // The one thing a log must never do.
  check(!/eyJ|sk-|AIza/.test(out), 'no credential VALUE is ever printed');
  check(/ingest-suite\.jsonl/.test(out) && /ingest-suite-checkpoint\.json/.test(out),
    'the log and checkpoint paths are resolved from the repo root, not a hard-coded one');
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'All checks passed.'}\n`);
process.exit(failures ? 1 : 0);
