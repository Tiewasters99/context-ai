// Prove the AI pause: migration 070 in a real Postgres, and every AI path in
// this repo refusing a paused matter with ZERO provider requests.
//
// Why this exists
// ---------------------------------------------------------------------------
// "A user can pause all AI on a matter from the UI and an in-flight run stops"
// is item 7 of the SecureSpace Definition of Done (audit 2026-09-19). A switch
// like that is worth exactly what can be demonstrated about it, and the thing
// to demonstrate is negative: that NOTHING went out. So every model-facing
// case here runs with global fetch replaced by a witness that records every
// request, and asserts the witness saw none.
//
// There is no local Postgres and no Docker on the dev machine, so Part A runs
// the REAL migration files inside PGlite (Postgres compiled to WebAssembly:
// real plpgsql, real roles, real RLS, real triggers). Two databases are built,
// because 064–069 belong to other lanes and 070 must not depend on them:
//
//   DB1  the full chain + 064 (the Record) + 060 (the 'held' status)
//   DB2  the same chain with NEITHER — 070 applied to a bare database
//
// and 070 is applied TWICE to each, because production drifts from this
// folder and the file has to be re-runnable.
//
// Part C is the negative control: the same Part B scenarios against the BASE
// branch's lib/, where the witness MUST fire. It runs two ways — one that
// needs nothing (the not-deployed schema, which is the pre-070 world reached
// through today's code) and one that fetches the base branch with git when
// the ref is reachable. A shallow CI checkout simply skips the second and
// says so.
//
//   npm i --no-save @electric-sql/pglite     # once; not a repo dependency
//   node scripts/_verify-ai-pause.mjs
//
// Touches nothing outside this process. No .env, no network, no production.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

let PGlite, uuid_ossp;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
} catch {
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const migration = (name) => fs.readFileSync(path.join(REPO, 'supabase', 'migrations', name), 'utf8');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

// ===========================================================================
// PART A — the database
// ===========================================================================

const SUPABASE_STUBS = `
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

  -- The two tables 070 touches when a resume releases held work, with the
  -- columns the release statement names. Created before the chain because 005
  -- rewrites policies on them.
  create table public.documents (
    id uuid primary key default gen_random_uuid(),
    matterspace_id uuid,
    created_by uuid,
    title text,
    metadata jsonb not null default '{}'::jsonb,
    processing_status text not null default 'pending'
      check (processing_status in ('pending','extracting','chunking','embedding','ready','error')),
    processing_error text
  );
  create table public.passages (
    id uuid primary key default gen_random_uuid(), matterspace_id uuid);
  create table storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  create or replace function storage.foldername(p_name text)
  returns text[] language sql immutable as $$ select string_to_array(p_name, '/') $$;

  grant usage on schema public, auth, storage to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

// The job queue, as migration 030 leaves it — enough of it for 060 to widen
// and for 070's release to move rows.
const JOB_QUEUE_STUB = `
  do $$ begin
    create type public.discovery_job_status as enum ('queued','running','done','error');
  exception when duplicate_object then null; end $$;
  create table if not exists public.processing_jobs (
    id uuid primary key default gen_random_uuid(),
    matterspace_id uuid not null,
    status public.discovery_job_status not null default 'queued',
    error text, claimed_by text, claimed_at timestamptz, finished_at timestamptz,
    created_at timestamptz not null default now()
  );
`;

async function buildDb({ withNeighbours }) {
  const db = new PGlite({ extensions: { uuid_ossp } });
  await db.exec(SUPABASE_STUBS);
  if (withNeighbours) await db.exec(JOB_QUEUE_STUB);
  await db.exec(migration('001_initial_schema.sql'));
  await db.exec(migration('005_fix_rls_recursion.sql'));
  await db.exec(migration('008_submatters.sql'));
  await db.exec(migration('016_matterspace_members.sql'));
  await db.exec(migration('022_matterspaces_rls_invoker_wrappers.sql'));
  // 023 is the rule 070 reuses: who may change the seal.
  await db.exec(migration('023_matterspaces_update_invoker_wrapper.sql'));
  await db.exec(migration('051_securespace.sql'));
  if (withNeighbours) {
    await db.exec(migration('060_held_sealed_status.sql'));
    await db.exec(migration('064_events_ledger.sql'));
  }
  await db.exec(`
    grant select, insert, update, delete on all tables in schema public
      to anon, authenticated, service_role;
  `);
  return db;
}

console.log('\n=== PART A — migration 070 in PGlite ============================');
console.log('\n--- DB1: the full chain, 060 + 064 present ----------------------');
const db = await buildDb({ withNeighbours: true });
const q = async (sql, params) => (await db.query(sql, params)).rows;
const attempt = async (sql, params) => {
  try { await db.query(sql, params); return null; } catch (err) { return err; }
};
const asUser = async (uid) => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: uid, role: 'authenticated' }),
  ]);
  await db.exec('set role authenticated');
};
const asService = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  await db.exec('set role service_role');
};
const asSuperuser = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
};

await db.exec(migration('070_ai_pause.sql'));
await db.exec(migration('070_ai_pause.sql'));
check(true, '070 applies, and applies again over itself (drift-safe)');

{
  const cols = await q(`
    select column_name from information_schema.columns
     where table_schema='public' and table_name='matterspaces'
       and column_name like 'ai_pause%'`);
  check(cols.length === 5, 'five pause columns on matterspaces', cols.map((c) => c.column_name).join(', '));
}

// ---------------------------------------------------------------------------
// A firm: a serverspace owner, a matter admin, a matter member, a stranger.
// ---------------------------------------------------------------------------
console.log('\n--- a firm ------------------------------------------------------');
await asSuperuser();
// 001's handle_new_user trigger creates the profile and the clientspace.
const signup = async (email, name) => {
  const [row] = await q(
    `insert into auth.users (email, raw_user_meta_data)
     values ($1, jsonb_build_object('display_name', $2::text)) returning id`, [email, name]);
  await q(`update public.profiles set display_name = $2 where id = $1`, [row.id, name]);
  return row.id;
};
const ADA = await signup('ada@example.test', 'Ada Quainton');   // serverspace owner
const BEN = await signup('ben@example.test', 'Ben Rowe');       // matter admin
const CAI = await signup('cai@example.test', 'Cai Mistry');     // matter member (plain)
const DEE = await signup('dee@example.test', 'Dee Okafor');     // stranger

const [ss] = await q(
  `insert into public.serverspaces (clientspace_id, name)
   select id, 'Quainton Law' from public.clientspaces where user_id = $1 returning id`, [ADA]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role)
         values ($1,$2,'owner') on conflict do nothing`, [ss.id, ADA]);

const [matter] = await q(
  `insert into public.matterspaces (serverspace_id, name)
   values ($1, 'Calder v. Atlas Freight') returning id`, [ss.id]);
const [sub] = await q(
  `insert into public.matterspaces (serverspace_id, parent_matterspace_id, name)
   values ($1, $2, 'Depositions') returning id`, [ss.id, matter.id]);
const [other] = await q(
  `insert into public.matterspaces (serverspace_id, name)
   values ($1, 'Unrelated matter') returning id`, [ss.id]);

await q(`insert into public.matterspace_members (matterspace_id, user_id, role)
         values ($1,$2,'admin'), ($1,$3,'member')`, [matter.id, BEN, CAI]);
check(true, 'owner, matter admin, matter member, stranger; a matter, a sub-matter, an unrelated matter');

// ---------------------------------------------------------------------------
// Who may pause
// ---------------------------------------------------------------------------
console.log('\n--- who may pause -----------------------------------------------');
const setPause = async (uid, matterId, paused, note = null) => {
  await asUser(uid);
  return attempt(`select public.matter_set_ai_pause($1,$2,$3)`, [matterId, paused, note]);
};

check((await setPause(DEE, matter.id, true)) !== null,
  'a stranger cannot pause a matter they cannot see');
check((await setPause(CAI, matter.id, true)) !== null,
  'a plain MEMBER cannot pause — the rule is the seal\'s rule, not "anyone on the matter"');
check((await setPause(BEN, matter.id, true, 'client call pending')) === null,
  'a matter ADMIN can pause (the same people who may change ai_tier)');

await asSuperuser();
{
  const [row] = await q(
    `select ai_paused, ai_paused_by, ai_paused_by_name, ai_pause_note, ai_paused_at
       from public.matterspaces where id = $1`, [matter.id]);
  check(row.ai_paused === true, 'the matter is paused');
  check(row.ai_paused_by === BEN, 'the byline is auth.uid(), stamped by the database');
  check(row.ai_paused_by_name === 'Ben Rowe', 'with the display name snapshotted');
  check(row.ai_pause_note === 'client call pending', 'and the note kept');
  check(row.ai_paused_at !== null, 'and a timestamp');
}

// ---------------------------------------------------------------------------
// The byline cannot be typed
// ---------------------------------------------------------------------------
console.log('\n--- the byline cannot be forged ---------------------------------');
{
  await asUser(ADA);   // the serverspace owner: allowed to pause, via the RPC
  const direct = await attempt(
    `update public.matterspaces set ai_paused_by_name = 'Someone Else' where id = $1`, [matter.id]);
  check(direct !== null && direct.code === '42501',
    'even an owner cannot UPDATE the pause columns directly — only the RPC may',
    direct?.code ?? 'no error thrown');

  const rename = await attempt(
    `update public.matterspaces set name = 'Calder v. Atlas' where id = $1`, [matter.id]);
  check(rename === null, 'and every OTHER update to the matter is untouched by the guard');

  await asService();
  const asRole = await attempt(
    `update public.matterspaces set ai_paused = false where id = $1`, [matter.id]);
  check(asRole !== null, 'service_role cannot either — it is a trigger, not a grant', asRole?.code ?? 'no error');

  await asSuperuser();
  const asSuper = await attempt(
    `update public.matterspaces set ai_paused = false where id = $1`, [matter.id]);
  check(asSuper !== null, 'nor can a superuser', asSuper?.code ?? 'no error');

  const born = await attempt(
    `insert into public.matterspaces (serverspace_id, name, ai_paused, ai_paused_by_name)
     values ($1, 'Born paused', true, 'Nobody')`, [ss.id]);
  const [bornRow] = await q(`select ai_paused, ai_paused_by_name from public.matterspaces where name='Born paused'`);
  check(born === null && bornRow.ai_paused === false && bornRow.ai_paused_by_name === null,
    'a matter cannot be born paused: the INSERT succeeds and the columns are reset');
}

// ---------------------------------------------------------------------------
// Inheritance — the seal's own rule
// ---------------------------------------------------------------------------
console.log('\n--- inheritance -------------------------------------------------');
const readPause = async (uid, matterId) => {
  await asUser(uid);
  const [row] = await q(`select * from public.matter_ai_pause($1)`, [matterId]);
  return row;
};
{
  const onSub = await readPause(BEN, sub.id);
  check(onSub.paused === true, 'a sub-matter of a paused matter is paused');
  check(onSub.inherited === true && onSub.paused_matter === matter.id,
    'and says which matter it was paused on');
  check(onSub.paused_by_name === 'Ben Rowe', 'carrying the byline down');

  const onOther = await readPause(BEN, other.id);
  check(onOther.paused === false, 'an unrelated matter in the same serverspace is NOT paused');

  const onSelf = await readPause(BEN, matter.id);
  check(onSelf.paused === true && onSelf.inherited === false, 'the paused matter itself reports inherited=false');
}

// ---------------------------------------------------------------------------
// Held work, and its release
// ---------------------------------------------------------------------------
console.log('\n--- held work is released on resume -----------------------------');
const PAUSE_REASON =
  'AI is paused on this matter by Ben Rowe since 2026-09-20. Nothing is being sent to any model.';
const SEAL_REASON =
  'Reading this scan (OCR) would send content to an outside provider, and "Calder" is sealed.';
await asSuperuser();
await q(`insert into public.documents (matterspace_id, title, processing_status, processing_error)
         values ($1,'Held by the pause','held',$2),
                ($3,'Held by the pause, in the sub-matter','held',$2),
                ($1,'Held by the SEAL','held',$4),
                ($5,'Held elsewhere','held',$2)`,
  [matter.id, PAUSE_REASON, sub.id, SEAL_REASON, other.id]);
await q(`insert into public.processing_jobs (matterspace_id, status, error, finished_at, claimed_by)
         values ($1,'held',$2, now(), 'worker-1'),
                ($1,'held',$3, now(), 'worker-1')`, [matter.id, PAUSE_REASON, SEAL_REASON]);

check((await setPause(BEN, matter.id, false)) === null, 'the matter admin resumes');
await asSuperuser();
{
  const rows = await q(
    `select title, processing_status, processing_error from public.documents order by title`);
  const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));
  check(byTitle['Held by the pause'].processing_status === 'pending'
     && byTitle['Held by the pause'].processing_error === null,
    'a document held by the pause goes back to pending, reason cleared');
  check(byTitle['Held by the pause, in the sub-matter'].processing_status === 'pending',
    'including one in a sub-matter — the release walks the tree the pause did');
  check(byTitle['Held by the SEAL'].processing_status === 'held',
    'a document held by the SEAL does NOT move: it is still waiting for a sealed route');
  check(byTitle['Held elsewhere'].processing_status === 'held',
    'and an unrelated matter\'s held document is untouched');

  const jobs = await q(`select status::text as status, error, finished_at, claimed_by
                          from public.processing_jobs order by error`);
  const pausedJob = jobs.find((j) => j.error === null);
  check(pausedJob && pausedJob.status === 'queued',
    'the pause-held JOB is requeued with its error, claim and finish time cleared');
  check(pausedJob && pausedJob.claimed_by === null && pausedJob.finished_at === null,
    'so claim_discovery_job can pick it up again');
  check(jobs.some((j) => j.status === 'held' && j.error === SEAL_REASON),
    'the seal-held job stays held');

  const [row] = await q(`select ai_paused, ai_paused_by, ai_pause_note from public.matterspaces where id=$1`, [matter.id]);
  check(row.ai_paused === false && row.ai_paused_by === null && row.ai_pause_note === null,
    'and the pause record is cleared, not left as a ghost byline');
}

// ---------------------------------------------------------------------------
// The Record
// ---------------------------------------------------------------------------
console.log('\n--- the Record (064 present) ------------------------------------');
{
  await asSuperuser();
  const [kinds] = await q(`
    select pg_get_constraintdef(c.oid) as def from pg_constraint c
     join pg_class rel on rel.oid = c.conrelid
    where rel.relname = 'events' and c.conname = 'events_kind_check'`);
  check(/ai\.paused/.test(kinds.def) && /ai\.resumed/.test(kinds.def) && /run\.aborted/.test(kinds.def),
    'events already accepts ai.paused / ai.resumed / run.aborted — 070 reopens nothing');

  await asUser(BEN);
  const wrote = await attempt(
    `select public.ledger_append('ai.paused', $1, null, null, 'user', $2, 'Ben Rowe', '{"note":{"chars":19}}'::jsonb)`,
    [matter.id, BEN]);
  check(wrote === null, 'and an ai.paused row can be appended by the person who paused it');
}

// ---------------------------------------------------------------------------
// DB2 — 070 with no neighbours at all
// ---------------------------------------------------------------------------
console.log('\n--- DB2: 070 alone, no 060, no 064 ------------------------------');
{
  const bare = await buildDb({ withNeighbours: false });
  const bq = async (sql, params) => (await bare.query(sql, params)).rows;
  let err = null;
  try {
    await bare.exec(migration('070_ai_pause.sql'));
    await bare.exec(migration('070_ai_pause.sql'));
  } catch (e) { err = e; }
  check(err === null, '070 applies TWICE to a database with neither 060 nor 064', err?.message ?? '');

  const [u] = await bq(
    `insert into auth.users (email) values ('solo@example.test') returning id`);
  const [s] = await bq(`insert into public.serverspaces (clientspace_id, name)
                        select id, 'Solo' from public.clientspaces where user_id = $1 returning id`, [u.id]);
  await bq(`insert into public.serverspace_members (serverspace_id, user_id, role)
            values ($1,$2,'owner') on conflict do nothing`, [s.id, u.id]);
  const [m] = await bq(`insert into public.matterspaces (serverspace_id, name)
                        values ($1,'Solo matter') returning id`, [s.id]);
  await bare.exec('reset role');
  await bare.query(`select set_config('request.jwt.claims', $1, false)`,
    [JSON.stringify({ sub: u.id, role: 'authenticated' })]);
  await bare.exec('set role authenticated');
  let pauseErr = null;
  try { await bare.query(`select public.matter_set_ai_pause($1, true, null)`, [m.id]); }
  catch (e) { pauseErr = e; }
  check(pauseErr === null, 'pausing works with no ledger and no processing_jobs enum', pauseErr?.message ?? '');
  let resumeErr = null;
  try { await bare.query(`select public.matter_set_ai_pause($1, false, null)`, [m.id]); }
  catch (e) { resumeErr = e; }
  check(resumeErr === null, 'and so does resuming — the release probes for what is not there',
    resumeErr?.message ?? '');
  await bare.close?.();
}

// ===========================================================================
// PART B — every AI path, offline, with an egress witness
// ===========================================================================
console.log('\n=== PART B — the paths, with a fetch witness =====================');

const PAUSED_ROW = {
  id: 'm-1', parent_matterspace_id: null, name: 'Calder v. Atlas Freight',
  ai_tier: 'A',
  ai_paused: true,
  ai_paused_at: '2026-09-20T09:15:00.000Z',
  ai_paused_by: 'u-ben',
  ai_paused_by_name: 'Ben Rowe',
  ai_pause_note: 'client call pending',
};
const EXPECTED_SENTENCE =
  'AI is paused on this matter by Ben Rowe since 2026-09-20. Nothing is being sent to any model.';

/**
 * Enough supabase-js for matterTierWithClient, matterPauseWithClient,
 * pausedMatterIds, ai_sessions/ai_messages and the tool handlers.
 *
 * `schema: 'pre070'` answers every pause question the way a database without
 * migration 070 does: 42703, undefined_column. That is not a stub of a
 * failure — it is the exact code PostgREST returns today, and Part C uses the
 * same switch as its portable negative control.
 */
function stubSupabase({ tier = 'A', paused = true, schema = 'deployed', rows = {} } = {}) {
  const notDeployed = { code: '42703', message: 'column matterspaces.ai_paused does not exist' };
  const matterRow = { ...PAUSED_ROW, ai_tier: tier, ai_paused: paused, ...rows };
  const state = { pausedNow: paused };
  const api = {
    state,
    from(name) {
      const ctx = { table: name, selectedPause: false, eqPaused: false };
      const t = {
        select(cols) {
          ctx.selectedPause = typeof cols === 'string' && cols.includes('ai_paused');
          return t;
        },
        eq(col, val) { if (col === 'ai_paused' && val === true) ctx.eqPaused = true; return t; },
        in() { return t; },
        order() { return t; },
        not() { return t; },
        limit: () => Promise.resolve({ data: [], error: null }),
        maybeSingle() {
          if (ctx.table !== 'matterspaces') return Promise.resolve({ data: null, error: null });
          if (ctx.selectedPause && schema === 'pre070') {
            return Promise.resolve({ data: null, error: notDeployed });
          }
          return Promise.resolve({
            data: { ...matterRow, ai_paused: state.pausedNow },
            error: null,
          });
        },
        single: () => Promise.resolve({ data: null, error: { message: 'stub' } }),
        insert() {
          const ins = {
            select: () => ins,
            single: () => (ctx.table === 'ai_sessions'
              ? Promise.resolve({ data: { id: 'sess-1', matterspace_id: 'm-1', tier, status: 'open' }, error: null })
              : Promise.resolve({ data: null, error: { message: 'stub' } })),
            then: (r) => Promise.resolve({ data: null, error: null }).then(r),
          };
          return ins;
        },
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        // pausedMatterIds awaits the builder directly.
        then(resolve) {
          if (ctx.table === 'matterspaces' && ctx.eqPaused) {
            if (schema === 'pre070') return Promise.resolve({ data: null, error: notDeployed }).then(resolve);
            return Promise.resolve({
              data: state.pausedNow ? [{ id: 'm-1' }] : [], error: null,
            }).then(resolve);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      return t;
    },
    rpc: async (fn, args) => {
      if (fn === 'matterspace_descendants') {
        return { data: [{ id: args?.p_root ?? 'm-1' }], error: null };
      }
      return { data: null, error: null };
    },
  };
  return api;
}

// --- the witness ------------------------------------------------------------
const realFetch = globalThis.fetch;
let witnessed = [];
const witness = (responder) => {
  witnessed = [];
  globalThis.fetch = async (url, init) => {
    witnessed.push({ url: String(url), body: init?.body ?? null });
    return responder(String(url), init);
  };
};
const unwitness = () => { globalThis.fetch = realFetch; };
/** Requests that actually reached a model, as opposed to the database. */
const providerCalls = () => witnessed.filter((r) => !/\/rest\/v1\/|\/auth\/v1\//.test(r.url));

const policy = await import('../lib/ai-tier-policy.mjs');

console.log('\n--- the sentence ------------------------------------------------');
{
  const s = policy.aiPausedMessage({ byName: 'Ben Rowe', at: PAUSED_ROW.ai_paused_at });
  check(s === EXPECTED_SENTENCE, 'one plain sentence, server-side', JSON.stringify(s));
  const client = fs.readFileSync(path.join(REPO, 'src', 'lib', 'ai-pause.ts'), 'utf8');
  check(client.includes('AI is paused on this matter by ${who} since ${when}. Nothing is being sent to any model.'),
    'and the browser says exactly the same words (src/lib/ai-pause.ts)');
  const seal = await import('../lib/seal-pipes.mjs');
  const heldMsg = new seal.AiPausedError({ byName: 'Ben Rowe', at: PAUSED_ROW.ai_paused_at }).message;
  check(heldMsg.startsWith('AI is paused on this matter'),
    'and a held row\'s reason starts with the prefix migration 070 matches on resume');
  const sql = migration('070_ai_pause.sql');
  check(sql.includes(`'AI is paused on this matter%'`),
    'which is the literal in 070 _ai_pause_release — the two are in step');
  check(seal.isSealedPipeError(new seal.AiPausedError({})),
    'a pause is a POLICY HOLD, so every existing held-parking call site inherits it unchanged');
}

console.log('\n--- the control never hides itself on a read error --------------');
{
  // The switch is worth what it shows. Until 2026-09-20 the component's
  // initial state carried notDeployed:true and a failed read kept the
  // previous state, so the FIRST unreadable answer of a session left that
  // flag standing and `if (state.notDeployed) return null` removed the
  // emergency stop from the screen — silently, and precisely when something
  // was wrong. src/lib/ai-pause-state.ts is import-free so the rule can be
  // run here rather than argued about in a comment.
  const { nextPauseState, isPauseUnknown, NOT_PAUSED: NP, PAUSE_UNKNOWN_SENTENCE } =
    await import('../src/lib/ai-pause-state.ts');

  const PAUSED = { paused: true, notDeployed: false, byName: 'Ben Rowe', at: PAUSED_ROW.ai_paused_at };
  const ERR = { paused: false, notDeployed: false, error: 'network' };
  const ABSENT = { paused: false, notDeployed: true };

  const firstReadFailed = nextPauseState(NP, ERR);
  check(firstReadFailed.notDeployed === false,
    'a read error is NEVER mistaken for "migration 070 is absent"', JSON.stringify(firstReadFailed));
  check(isPauseUnknown(firstReadFailed),
    'so the control stays on screen in the "could not check" state');
  check(PAUSE_UNKNOWN_SENTENCE === 'Could not check whether AI is paused — retry',
    'and says so in one sentence that claims nothing either way', PAUSE_UNKNOWN_SENTENCE);

  const afterKnownPause = nextPauseState(PAUSED, ERR);
  check(afterKnownPause.paused === true && !afterKnownPause.error,
    'FAIL CLOSED: an error on a matter already known to be paused still reads "AI paused"');
  check(!isPauseUnknown(afterKnownPause),
    'and that is not the unknown state — it is the last trusted answer, standing');

  check(nextPauseState(NP, ABSENT).notDeployed === true && !isPauseUnknown(nextPauseState(NP, ABSENT)),
    'only a genuine not-deployed answer hides the control');
  check(nextPauseState(PAUSED, NP).paused === false,
    'and a good read that says "not paused" is believed, even over a remembered pause');

  const src = fs.readFileSync(path.join(REPO, 'src', 'components', 'matter', 'AiPauseControl.tsx'), 'utf8');
  check(/useState<AiPauseState>\(\{ \.\.\.NOT_PAUSED, notDeployed: true \}\)/.test(src)
    && src.includes('setState(nextPauseState(known.current, next))'),
    'the component still starts hidden, but every later state comes from that one rule');
  check(src.includes('isPauseUnknown(state)') && src.includes('PAUSE_UNKNOWN_SENTENCE'),
    'and it renders the unknown state rather than the "Pause AI" face, which would claim AI is running');
}

console.log('\n--- inheritance, in the JS walk every server path uses ----------');
{
  // Part A proved it in SQL. This is walkEffectivePause, which is what
  // gateLlmRequest, the assistant, callTool, meetings and the pipeline
  // actually call — and it must agree with the database.
  const tree = {
    'child': { id: 'child', parent_matterspace_id: 'parent', name: 'Depositions', ai_paused: false },
    'parent': {
      id: 'parent', parent_matterspace_id: null, name: 'Calder v. Atlas Freight',
      ai_paused: true, ai_paused_at: PAUSED_ROW.ai_paused_at, ai_paused_by_name: 'Ben Rowe',
      ai_pause_note: 'client call pending',
    },
    'elsewhere': { id: 'elsewhere', parent_matterspace_id: null, name: 'Unrelated', ai_paused: false },
  };
  const fetchRow = async (id) => tree[id] ?? null;
  const onChild = await policy.walkEffectivePause(fetchRow, 'child');
  check(onChild.paused === true && onChild.inherited === true && onChild.matterId === 'parent',
    'a sub-matter of a paused matter is paused, and names the ancestor that carries it');
  check(policy.aiPausedMessage(onChild) === EXPECTED_SENTENCE,
    'so the sentence a sub-matter shows names the person who paused the parent');
  const onParent = await policy.walkEffectivePause(fetchRow, 'parent');
  check(onParent.paused === true && onParent.inherited === false, 'the parent itself is not "inherited"');
  const onOther = await policy.walkEffectivePause(fetchRow, 'elsewhere');
  check(onOther.paused === false, 'and an unrelated matter is untouched');
  const orphan = await policy.walkEffectivePause(async (id) => (id === 'child' ? tree.child : null), 'child');
  check(orphan.paused === false,
    'a chain through a parent this caller cannot SEE stops there — it does not leak the parent\'s existence');
}

console.log('\n--- a paused CHILD inside a running parent ----------------------');
{
  // The hole this lane found in the seal as well as the pause: callTool's
  // gate is keyed to the matter NAMED, and a parent-scoped search then
  // expands to descendants that were never asked about.
  const { handleSearch, handleGrep } = await import('../lib/mcp-core.mjs');
  const rpcSeen = [];
  const inCalls = [];
  const scopeStub = {
    from() {
      const t = new Proxy({
        in(col, ids) { if (col === 'matterspace_id') inCalls.push(ids); return t; },
        limit: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: () => Promise.resolve({
          data: { id: 'parent', name: 'Calder v. Atlas Freight', short_code: 'calder' }, error: null }),
        then: (r) => Promise.resolve({ data: [], error: null }).then(r),
      }, {
        // Every other PostgREST builder method is a no-op that keeps the chain.
        get: (target, prop) => (prop in target ? target[prop] : () => t),
      });
      return t;
    },
    rpc: async (fn, args) => {
      rpcSeen.push({ fn, args });
      if (fn === 'matterspace_descendants') {
        return { data: [{ id: 'parent' }, { id: 'child' }], error: null };
      }
      return { data: [], error: null };
    },
  };
  const exclude = new Set(['child']);
  await handleSearch(scopeStub, { q: 'indemnity', matter: 'parent' }, { excludeMatterIds: exclude })
    .catch(() => {});
  const searched = rpcSeen.find((c) => c.fn === 'search_passages');
  check(!searched || !(searched.args.p_matterspace_ids ?? []).includes('child'),
    'a parent-scoped SEARCH does not read the excluded child\'s passages',
    JSON.stringify(searched?.args?.p_matterspace_ids ?? 'no search issued'));

  inCalls.length = 0;
  const grep = await handleGrep(scopeStub, { pattern: 'indemnity', matter: 'parent' },
    { excludeMatterIds: exclude }).catch((e) => ({ error: e.message }));
  check(grep && !grep.error && inCalls.length > 0 && !inCalls.some((ids) => ids.includes('child')),
    'and neither does GREP — both branches now filter, as the all-matters branch always did',
    grep?.error ? grep.error : JSON.stringify(inCalls[0] ?? []));
  // Whole scope excluded ⇒ an empty answer, not an unfiltered one.
  const allGone = await handleSearch(scopeStub, { q: 'x', matter: 'parent' },
    { excludeMatterIds: new Set(['parent', 'child']) }).catch(() => null);
  check(allGone && allGone.result_count === 0,
    'a scope that is entirely excluded answers empty rather than falling back to everything');
}

console.log('\n--- /api/llm — gateLlmRequest -----------------------------------');
for (const tier of ['A', 'B', 'C']) {
  const restResponder = (url) => {
    if (url.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: 'u-1' }), { status: 200 });
    if (url.includes('select=id,parent_matterspace_id,ai_tier')) {
      return new Response(JSON.stringify([{ id: 'm-1', parent_matterspace_id: null, ai_tier: tier }]), { status: 200 });
    }
    return new Response(JSON.stringify([PAUSED_ROW]), { status: 200 });
  };
  witness(restResponder);
  const gate = await policy.gateLlmRequest({
    supabaseUrl: 'https://db.test', anonKey: 'anon', serviceKey: 'svc',
    bearer: 'Bearer t', provider: 'anthropic', matterId: 'm-1',
  });
  unwitness();
  check(gate.ok === false && gate.error === 'ai_paused',
    `Tier ${tier}: a paused matter is refused by the gate`, gate.error);
  check(gate.message === EXPECTED_SENTENCE, `Tier ${tier}: with the sentence, ready for /api/llm to forward`);
  check(providerCalls().length === 0, `Tier ${tier}: zero provider requests`, `${providerCalls().length}`);
}
{
  // And that /api/llm does forward it. Until 2026-09-20 the refusal carried
  // {error, tier, provider} only, so the browser had nothing but the code
  // `ai_paused` to render — src/lib/llm/refusals.ts prefers a server message
  // and there was none. Refusing was never in doubt; being understood was.
  const src = fs.readFileSync(path.join(REPO, 'api', 'llm.mjs'), 'utf8');
  check(/if \(!sealed && !gate\.ok\) return refuse\(gate\.status, \{[^}]*message: gate\.message[^}]*\}\)/.test(src),
    'api/llm.mjs forwards gate.message on the gate refusal');
  check(src.indexOf('const sealed = sealedRouteFor(') < src.indexOf('if (!sealed && !gate.ok) return refuse('),
    'and the seal is still asked before the gate refusal is sent — the order is untouched');
}
{
  // The ORDER is the point: a paused Tier-B matter must NOT be refused as a
  // tier violation, or lib/llm-sealed-route.mjs would substitute the sealed
  // pen and answer it.
  const { sealedRouteFor } = await import('../lib/llm-sealed-route.mjs');
  witness((url) => {
    if (url.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: 'u-1' }), { status: 200 });
    if (url.includes('select=id,parent_matterspace_id,ai_tier')) {
      return new Response(JSON.stringify([{ id: 'm-1', parent_matterspace_id: null, ai_tier: 'B' }]), { status: 200 });
    }
    return new Response(JSON.stringify([PAUSED_ROW]), { status: 200 });
  });
  const gate = await policy.gateLlmRequest({
    supabaseUrl: 'https://db.test', anonKey: 'anon', serviceKey: 'svc',
    bearer: 'Bearer t', provider: 'anthropic', matterId: 'm-1',
  });
  unwitness();
  const substituted = sealedRouteFor({
    gate, provider: 'anthropic', model: 'claude-opus-4-8',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }),
    env: { BEDROCK_AWS_ACCESS_KEY_ID: 'AKIDTEST', BEDROCK_AWS_SECRET_ACCESS_KEY: 'sec' },
  });
  check(substituted === null,
    'the sealed route does NOT substitute a pen for a paused matter (the refusal passes through)',
    substituted ? JSON.stringify(Object.keys(substituted)) : 'null');
}
{
  // A read that FAILS (not "not deployed") is not an open door.
  witness((url) => {
    if (url.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: 'u-1' }), { status: 200 });
    if (url.includes('select=id,parent_matterspace_id,ai_tier')) {
      return new Response(JSON.stringify([{ id: 'm-1', parent_matterspace_id: null, ai_tier: 'A' }]), { status: 200 });
    }
    return new Response('boom', { status: 500 });
  });
  const gate = await policy.gateLlmRequest({
    supabaseUrl: 'https://db.test', anonKey: 'anon', serviceKey: 'svc',
    bearer: 'Bearer t', provider: 'anthropic', matterId: 'm-1',
  });
  unwitness();
  check(gate.ok === false && gate.error === 'ai_pause_unknown',
    'an unreadable pause fails CLOSED', gate.error);
}
{
  // NOT DEPLOYED behaves exactly as today.
  witness((url) => {
    if (url.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: 'u-1' }), { status: 200 });
    if (url.includes('select=id,parent_matterspace_id,ai_tier')) {
      return new Response(JSON.stringify([{ id: 'm-1', parent_matterspace_id: null, ai_tier: 'A' }]), { status: 200 });
    }
    return new Response(
      JSON.stringify({ code: '42703', message: 'column matterspaces.ai_paused does not exist' }),
      { status: 400 });
  });
  const gate = await policy.gateLlmRequest({
    supabaseUrl: 'https://db.test', anonKey: 'anon', serviceKey: 'svc',
    bearer: 'Bearer t', provider: 'anthropic', matterId: 'm-1',
  });
  unwitness();
  check(gate.ok === true, 'a database without 070 behaves exactly as it does today (42703 ⇒ not deployed)',
    JSON.stringify(gate).slice(0, 90));
  check(policy.isPauseNotDeployed({ code: '42703' }) && policy.isPauseNotDeployed({ code: 'PGRST202' })
     && !policy.isPauseNotDeployed({ code: '42501', message: 'permission denied' }),
    'and a permission refusal is NOT mistaken for "not deployed"');
}

console.log('\n--- the assistant loop ------------------------------------------');
const { runAssistantStream, bedrockCredsFromEnv, LEAVES_THE_MATTER } = await import('../lib/assistant-core.mjs');
const CREDS = bedrockCredsFromEnv({
  BEDROCK_AWS_ACCESS_KEY_ID: 'AKIDTEST', BEDROCK_AWS_SECRET_ACCESS_KEY: 'testsecret',
});
const sse = (evts) => evts.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\ndata: [DONE]\n\n';
const CHAT_ANSWER = sse([
  { choices: [{ index: 0, delta: { role: 'assistant', content: 'THE ANSWER TEXT' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } },
]);
const CHAT_TOOL_CALL = sse([
  { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"indemnity"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } },
]);
const ANTHROPIC_ANSWER = [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9, output_tokens: 0 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'THE ANSWER TEXT' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
  ['message_stop', { type: 'message_stop' }],
].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}`).join('\n\n') + '\n\n';

const runLoop = async ({ supabase, tier, bodies = [], toolNames, onRound }) => {
  let round = 0;
  witness(() => {
    const payload = bodies[Math.min(round, bodies.length - 1)]
      ?? (tier === 'A' ? ANTHROPIC_ANSWER : CHAT_ANSWER);
    round += 1;
    onRound?.(round);
    return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  const events = [];
  try {
    await runAssistantStream({
      supabase, anthropicKey: 'ak', bedrockCreds: CREDS, openaiApiKey: 'ok',
      messages: [{ role: 'user', content: 'What does the indemnity say?' }],
      matterId: 'm-1', emit: (ev) => events.push(ev), toolNames,
    });
  } finally { unwitness(); }
  return {
    events,
    text: events.filter((e) => e.type === 'text').map((e) => e.text).join(''),
    err: events.find((e) => e.type === 'error'),
    rounds: round,
  };
};

for (const tier of ['A', 'B', 'C']) {
  const r = await runLoop({ supabase: stubSupabase({ tier, paused: true }), tier });
  check(r.err?.code === 'ai_paused', `Tier ${tier}: chat refuses`, r.err?.code ?? 'no error');
  check(r.err?.message === EXPECTED_SENTENCE, `Tier ${tier}: with the same sentence`);
  check(providerCalls().length === 0 && r.rounds === 0,
    `Tier ${tier}: zero provider requests — the refusal is before the pen is chosen`,
    `${providerCalls().length} request(s)`);
  check(r.text === '', `Tier ${tier}: and nothing is streamed to the user`);
}
{
  const r = await runLoop({ supabase: stubSupabase({ tier: 'A', paused: false }), tier: 'A' });
  check(r.text.includes('THE ANSWER TEXT') && !r.err,
    'an UNPAUSED matter answers exactly as before (the gate is not a general brake)');
}
{
  const r = await runLoop({ supabase: stubSupabase({ tier: 'A', paused: true, schema: 'pre070' }), tier: 'A' });
  check(r.text.includes('THE ANSWER TEXT') && !r.err,
    'and a database without 070 answers too — merging before pasting changes nothing');
}

console.log('\n--- an in-flight run stops --------------------------------------');
{
  // Round 1 asks for a tool. The pause is set while that round is in flight.
  const supabase = stubSupabase({ tier: 'B', paused: false });
  const r = await runLoop({
    supabase, tier: 'B',
    bodies: [CHAT_TOOL_CALL, CHAT_ANSWER],
    onRound: (n) => { if (n === 1) supabase.state.pausedNow = true; },
  });
  check(r.rounds === 1,
    'exactly ONE provider round happened — the round already in flight, and no more',
    `${r.rounds} round(s)`);
  check(r.err?.code === 'ai_paused', 'the turn ends with the pause refusal', r.err?.code ?? 'no error');
  check(!r.events.some((e) => e.type === 'tool'),
    'and the tool call the model asked for was never run — the check is BEFORE the tool, not after');
}
{
  // Same, but the pause lands between rounds rather than before a tool.
  const supabase = stubSupabase({ tier: 'A', paused: false });
  const r = await runLoop({
    supabase, tier: 'A',
    bodies: [ANTHROPIC_ANSWER],
    onRound: () => { supabase.state.pausedNow = true; },
  });
  check(r.rounds === 1 && !r.err,
    'a single-round answer that finishes before the pause lands is delivered — the window is one round',
    `${r.rounds} round(s)`);
}

console.log('\n--- the sealed tool allow-list (5b) -----------------------------');
{
  check(LEAVES_THE_MATTER.has('relay_feedback') && LEAVES_THE_MATTER.has('move_document'),
    'relay_feedback and move_document are the tools whose effect leaves the matter');
  const toolsOffered = async (tier, toolNames) => {
    const r = await runLoop({ supabase: stubSupabase({ tier, paused: false }), tier, toolNames });
    void r;
    const body = providerCalls()[0]?.body;
    const parsed = body ? JSON.parse(String(body)) : {};
    const list = parsed.tools ?? [];
    return list.map((t) => t.function?.name ?? t.name);
  };
  const sealed = await toolsOffered('B');
  check(!sealed.includes('relay_feedback'),
    'a SEALED chat is never offered relay_feedback — it is not in the request body at all');
  check(!sealed.includes('move_document'), 'nor move_document');
  check(sealed.includes('search') && sealed.includes('get_passage') && sealed.includes('create_sub_matter'),
    'the read tools and the in-matter write stay', sealed.length + ' tools');

  const narrowed = await toolsOffered('B', ['search', 'get_passage', 'relay_feedback']);
  check(narrowed.length === 2 && !narrowed.includes('relay_feedback'),
    'toolNames narrows, and cannot re-add a tool the seal removed',
    narrowed.join(','));
}

console.log('\n--- connectors ---------------------------------------------------');
{
  const { callTool, AiPausedMatterError } = await import('../lib/mcp-core.mjs');
  const supabase = stubSupabase({ tier: 'A', paused: true });
  witness(() => new Response('{}', { status: 200 }));
  let err = null;
  try {
    await callTool(supabase, 'search', { q: 'indemnity', matter: 'm-1' }, { sealConnector: true, matterId: 'm-1' });
  } catch (e) { err = e; }
  unwitness();
  check(err instanceof AiPausedMatterError && err.code === 'ai_paused',
    'a connector tool call keyed to a paused matter is refused', err?.code ?? 'no error');
  check(err?.message === EXPECTED_SENTENCE, 'with the same sentence a connected assistant can relay');
  check(providerCalls().length === 0, 'and nothing was embedded or sent', `${providerCalls().length}`);

  let readErr = null;
  try {
    await callTool(supabase, 'get_passage', { id: '11111111-1111-1111-1111-111111111111' },
      { sealConnector: true, matterId: 'm-1' });
  } catch (e) { readErr = e; }
  check(readErr?.code === 'ai_paused',
    'READS are refused too — a tool result goes straight into an outside model\'s context');

  const inApp = await (async () => {
    try {
      await callTool(supabase, 'search', { q: 'x', matter: 'm-1' }, { matterId: 'm-1' });
      return null;
    } catch (e) { return e; }
  })();
  check(inApp?.code === 'ai_paused',
    'and the in-app path hits the SAME gate — the check lives in callTool, so a new surface inherits it');
}

console.log('\n--- meetings ----------------------------------------------------');
{
  const { meetingModelDecision } = await import('../lib/meeting-seal.mjs');
  const supabase = stubSupabase({ tier: 'A', paused: true });
  // The meetings lookup is the same maybeSingle shape; give it a bound meeting.
  const withMeeting = {
    ...supabase,
    from(name) {
      if (name !== 'meetings') return supabase.from(name);
      const t = {
        select: () => t, eq: () => t,
        maybeSingle: () => Promise.resolve({ data: { matterspace_id: 'm-1' }, error: null }),
      };
      return t;
    },
  };
  witness(() => new Response('{}', { status: 200 }));
  const d = await meetingModelDecision(withMeeting, 'meet-1', { provider: 'anthropic' });
  unwitness();
  check(d.ok === false && d.code === 'ai_paused', 'a meeting on a paused matter refuses', d.code);
  check(String(d.message).startsWith(EXPECTED_SENTENCE),
    'with the sentence, plus what keeps running');
  check(d.paused === true,
    'and flags `paused` so a sealed meeting arm does not treat it as a plain tier refusal');
  check(providerCalls().length === 0, 'zero provider requests', `${providerCalls().length}`);
}

console.log('\n--- the pipeline -------------------------------------------------');
{
  const seal = await import('../lib/seal-pipes.mjs');
  const supabase = stubSupabase({ tier: 'A', paused: true });
  const info = await seal.matterSeal(supabase, 'm-1');
  check(info.pause?.paused === true, 'matterSeal reports the pause alongside the tier');
  let err = null;
  try { await seal.assertAiNotPaused(supabase, 'm-1', { pipe: 'embeddings' }); }
  catch (e) { err = e; }
  check(seal.isAiPausedError(err), 'a new upload is refused', err?.code ?? 'no error');
  check(seal.isSealedPipeError(err),
    'and it is a POLICY HOLD, so api/ingest.mjs and the worker park it as `held` with no code change');
  check(seal.heldReason(err).startsWith('AI is paused on this matter'),
    'the held reason is the sentence — which is what 070 matches on resume');

  const open = await seal.assertAiNotPaused(stubSupabase({ paused: false }), 'm-1', { pipe: 'embeddings' });
  check(open !== undefined, 'an unpaused matter ingests as before');
  const undeployed = await seal.assertAiNotPaused(
    stubSupabase({ paused: true, schema: 'pre070' }), 'm-1', { pipe: 'embeddings' });
  check(undeployed?.notDeployed === true, 'and a database without 070 ingests as before too');

  const src = fs.readFileSync(path.join(REPO, 'lib', 'ingest-core.mjs'), 'utf8');
  check(src.includes('assertAiNotPaused(supabase, matterspace_id'),
    'the ingest pipeline calls it, once, beside the seal lookup it already made');
}

console.log('\n--- vercel.json (5a) --------------------------------------------');
{
  const vc = JSON.parse(fs.readFileSync(path.join(REPO, 'vercel.json'), 'utf8'));
  check(vc.functions['api/meeting-chat.mjs'].maxDuration === vc.functions['api/assistant.mjs'].maxDuration,
    'a sealed meeting answer gets the same wall clock as sealed chat',
    `meeting-chat ${vc.functions['api/meeting-chat.mjs'].maxDuration}s, assistant ${vc.functions['api/assistant.mjs'].maxDuration}s`);
}

console.log('\n--- the sealed pen has a declared size (5c) ---------------------');
{
  const { PENS } = await import('../lib/assistant-core.mjs');
  const providers = fs.readFileSync(path.join(REPO, 'src', 'lib', 'llm', 'providers.ts'), 'utf8');
  const cited = /kimi-k2\.6'[^\n]*contextWindow:\s*(\d+)/.exec(providers);
  check(Boolean(cited), 'src/lib/llm/providers.ts still states a Kimi K2-series context window');
  check(PENS.bedrockOpen.contextWindow === Number(cited?.[1]),
    'and the sealed pen carries that exact figure — nothing invented',
    `${PENS.bedrockOpen.contextWindow} vs ${cited?.[1]}`);
}

// ===========================================================================
// PART C — the negative control
// ===========================================================================
console.log('\n=== PART C — the negative control ===============================');
console.log('\n--- the pre-070 world, through today\'s code ---------------------');
{
  // Same scenario, same modules, a schema with no pause columns. If the gate
  // were doing nothing, THIS is what every case above would look like.
  const r = await runLoop({ supabase: stubSupabase({ tier: 'A', paused: true, schema: 'pre070' }), tier: 'A' });
  check(providerCalls().length === 1 && r.text.includes('THE ANSWER TEXT'),
    'the witness FIRES when the pause is not in the schema — the assertions above are not vacuous',
    `${providerCalls().length} provider request(s)`);
}

console.log('\n--- the base branch, if git can reach it ------------------------');
{
  const BASE_REF = process.env.CS_PAUSE_BASE_REF || 'origin/feat/w1-ledger-064';
  // CS_PAUSE_BASE_DIR lets a caller hand over a directory that already holds
  // the base branch's lib/ (materialised with `git archive`, say). It must sit
  // inside the repo so node resolves the repo's own node_modules from it.
  const preset = process.env.CS_PAUSE_BASE_DIR;
  const baseDir = preset
    ? path.resolve(REPO, preset)
    : path.join(REPO, 'node_modules', '.cs-ai-pause-base');
  let ready = Boolean(preset) && fs.existsSync(path.join(baseDir, 'lib', 'ai-tier-policy.mjs'));
  let why = preset ? `CS_PAUSE_BASE_DIR=${preset} has no lib/ai-tier-policy.mjs` : '';
  try {
    if (ready) throw new Error('already have it');
    const names = execFileSync('git', ['ls-tree', '-r', '--name-only', BASE_REF, 'lib'],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.mjs'));
    if (names.length) {
      fs.rmSync(baseDir, { recursive: true, force: true });
      fs.mkdirSync(path.join(baseDir, 'lib'), { recursive: true });
      for (const n of names) {
        const buf = execFileSync('git', ['show', `${BASE_REF}:${n}`],
          { cwd: REPO, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
        const dest = path.join(baseDir, n);
        fs.mkdirSync(path.dirname(dest), { recursive: true });   // lib/ has sub-folders
        fs.writeFileSync(dest, buf);
      }
      ready = true;
    } else {
      why = `git ls-tree listed no lib/*.mjs at ${BASE_REF}`;
    }
  } catch (e) {
    if (!ready) why = String(e?.message ?? e).split('\n')[0].slice(0, 160);
  }

  if (!ready) {
    console.log(`  SKIP  could not materialise ${BASE_REF}: ${why}`);
    console.log('        (a shallow CI clone, a merged-and-deleted branch, or a sandbox that does not');
    console.log('        allow git from a subprocess). The pre-070 control above covers the same ground;');
    console.log('        pass CS_PAUSE_BASE_DIR=<dir with lib/> to run this one anyway.');
  } else {
    const baseUrl = (f) => pathToFileURL(path.join(baseDir, 'lib', f)).href;
    const basePolicy = await import(baseUrl('ai-tier-policy.mjs'));
    witness((url) => {
      if (url.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: 'u-1' }), { status: 200 });
      return new Response(JSON.stringify([{ id: 'm-1', parent_matterspace_id: null, ai_tier: 'A' }]), { status: 200 });
    });
    const gate = await basePolicy.gateLlmRequest({
      supabaseUrl: 'https://db.test', anonKey: 'anon', serviceKey: 'svc',
      bearer: 'Bearer t', provider: 'anthropic', matterId: 'm-1',
    });
    unwitness();
    check(gate.ok === true,
      `on ${BASE_REF} the same paused matter passes the gate — the guard is genuinely new`,
      JSON.stringify(gate).slice(0, 80));

    const baseSeal = await import(baseUrl('seal-pipes.mjs'));
    check(typeof baseSeal.assertAiNotPaused === 'undefined',
      'and the base has no pipeline pause at all');
    if (!preset) fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

await db.close?.();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
