// Migration 085 — agent tokens and the task board, EXECUTED in PGlite with the
// real migration chain and real RLS.
//
// 085 is not applied in production. This is the proof that it parses, that it
// is additive (every existing connector token reads back as a user token,
// untouched), that it applies twice, and that its policies say what the PR
// says they say — asserted from inside `SET ROLE authenticated` with
// `request.jwt.claims` set the way PostgREST sets it, including the
// INSERT … RETURNING path the INVOKER memo is about.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-agent-tasks-rls.mjs
//
// No .env, no network, no prod.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let PGlite, uuid_ossp;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
} catch {
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

process.on('uncaughtException', (e) => {
  console.error(`\n  SQL ERROR: ${String(e?.message ?? e).split('\n')[0]}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(`\n  SQL ERROR: ${String(e?.message ?? e).split('\n')[0]}\n`);
  process.exit(1);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = (name) => fs.readFileSync(
  path.resolve(__dirname, '..', 'supabase', 'migrations', name), 'utf8');

const db = new PGlite({ extensions: { uuid_ossp } });
const q = async (sql, params) => (await db.query(sql, params)).rows;
const attempt = async (sql, params) => {
  try { return { rows: (await db.query(sql, params)).rows, err: null }; } catch (err) { return { rows: null, err }; }
};

let failures = 0;
let passes = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (ok) passes += 1; else failures += 1;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 62 - t.length))}`);

const asUser = async (uid) => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: uid, role: 'authenticated' }),
  ]);
  await db.exec('set role authenticated');
};
const asAnon = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  await db.exec('set role anon');
};
const asSuperuser = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
};

// ---------------------------------------------------------------------------
section('supabase stubs + the real chain up to 085');
// ---------------------------------------------------------------------------
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
    select nullif(coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ), '')::uuid
  $$;
  create table public.documents (
    id uuid primary key default gen_random_uuid(), matterspace_id uuid, created_by uuid);
  create table public.passages (
    id uuid primary key default gen_random_uuid(), matterspace_id uuid);
  create table storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  create or replace function storage.foldername(p_name text)
  returns text[] language sql immutable as $$ select string_to_array(p_name, '/') $$;
  grant usage on schema public, auth, storage to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`);
for (const f of [
  '001_initial_schema.sql', '003_connector_tokens.sql', '005_fix_rls_recursion.sql',
  '008_submatters.sql', '016_matterspace_members.sql', '022_matterspaces_rls_invoker_wrappers.sql',
]) await db.exec(migration(f));
await db.exec(`grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;`);
check(true, '001 → 022 applied (the chain 085 sits on)');

// A firm, before 085.
const signup = async (email, name) => {
  const [row] = await q(
    `insert into auth.users (email, raw_user_meta_data)
     values ($1, jsonb_build_object('display_name', $2::text)) returning id`, [email, name]);
  return row.id;
};
const ADA = await signup('ada@example.test', 'Ada');     // owns the serverspace
const DAN = await signup('dan@example.test', 'Dan');     // co-counsel on m1 only
const BOB = await signup('bob@example.test', 'Bob');     // a stranger
const [s1] = await q(
  `insert into public.serverspaces (clientspace_id, name)
   select id, 'Firm' from public.clientspaces where user_id = $1 returning id`, [ADA]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner')`, [s1.id, ADA]);
const [m1] = await q(`insert into public.matterspaces (serverspace_id, name) values ($1,'Vashti') returning id`, [s1.id]);
const [m2] = await q(
  `insert into public.matterspaces (serverspace_id, name, parent_matterspace_id) values ($1,'Vashti › Appeal',$2) returning id`,
  [s1.id, m1.id]);
const [m3] = await q(`insert into public.matterspaces (serverspace_id, name) values ($1,'Brannock') returning id`, [s1.id]);
await q(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,'member')`, [m1.id, DAN]);
const [oldTok] = await q(
  `insert into public.connector_tokens (user_id, token_hash, token_prefix, name)
   values ($1, 'hash-old', 'csp_old', 'Claude Desktop') returning *`, [ADA]);

// ---------------------------------------------------------------------------
section('085, applied twice — additive');
// ---------------------------------------------------------------------------
await db.exec(migration('085_agent_tokens_and_tasks.sql'));
await db.exec(migration('085_agent_tokens_and_tasks.sql'));
check(true, 'the file applies, and applies again over itself');
{
  const [row] = await q(`select * from public.connector_tokens where id = $1`, [oldTok.id]);
  check(row.kind === 'user' && row.matter_scope === null && row.agent_provider === null,
    'an existing token reads back as kind user, no scope, no provider');
  check(row.token_hash === oldTok.token_hash && row.name === oldTok.name && row.user_id === oldTok.user_id,
    'and nothing else about it changed');
  const pols = await q(`select tablename, cmd from pg_policies where tablename in ('agent_tasks','agent_task_events') order by 1,2`);
  const has = (t, c) => pols.some((p) => p.tablename === t && p.cmd === c);
  check(has('agent_tasks', 'SELECT') && has('agent_tasks', 'INSERT') && has('agent_tasks', 'UPDATE') && !has('agent_tasks', 'DELETE'),
    'agent_tasks: select/insert/update policies, no delete');
  check(has('agent_task_events', 'SELECT') && has('agent_task_events', 'INSERT')
    && !has('agent_task_events', 'UPDATE') && !has('agent_task_events', 'DELETE'),
    'agent_task_events: select/insert only (append-only)');
  const defs = await q(`
    select p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('_agent_task_matter_access','_agent_token_is_mine')`);
  check(defs.length === 2 && defs.every((d) => d.prosecdef === false),
    'both policy helpers are SECURITY INVOKER (no DEFINER function in a policy)');
}
{
  const bad = [
    [`insert into public.connector_tokens (user_id, token_hash, token_prefix, kind) values ($1,'h1','p','agent')`, 'an agent with a null scope'],
    [`insert into public.connector_tokens (user_id, token_hash, token_prefix, kind, matter_scope) values ($1,'h2','p','robot','{}')`, 'an unknown kind'],
    [`insert into public.connector_tokens (user_id, token_hash, token_prefix, kind, matter_scope, agent_provider) values ($1,'h3','p','agent','{}','acme')`, 'an unknown provider'],
  ];
  for (const [sql, label] of bad) {
    const r = await attempt(sql, [ADA]);
    check(r.err?.code === '23514', `refused by a check constraint: ${label}`, r.err?.code ?? 'accepted');
  }
}

// ---------------------------------------------------------------------------
section('tokens: each person makes their own agents');
// ---------------------------------------------------------------------------
await asUser(ADA);
const [adaAgent] = await q(
  `insert into public.connector_tokens (user_id, token_hash, token_prefix, name, kind, agent_provider, matter_scope)
   values ($1,'hash-ada-agent','csp_ada','Grok bot','agent','grok', array[$2]::uuid[]) returning id, kind, matter_scope`,
  [ADA, m1.id]);
check(adaAgent.kind === 'agent' && adaAgent.matter_scope.length === 1, 'Ada creates an agent token with scope [Vashti] (RETURNING)');
const [adaEmpty] = await q(
  `insert into public.connector_tokens (user_id, token_hash, token_prefix, kind, matter_scope)
   values ($1,'hash-ada-empty','csp_emp','agent','{}') returning id, matter_scope`, [ADA]);
check(Array.isArray(adaEmpty.matter_scope) && adaEmpty.matter_scope.length === 0, 'a new agent can start with nothing granted: {}');
await asUser(BOB);
const [bobAgent] = await q(
  `insert into public.connector_tokens (user_id, token_hash, token_prefix, kind, matter_scope)
   values ($1,'hash-bob-agent','csp_bob','agent','{}') returning id`, [BOB]);
check(Boolean(bobAgent?.id), 'Bob has an agent of his own');

// ---------------------------------------------------------------------------
section('agent_tasks: who may delegate, and to whom');
// ---------------------------------------------------------------------------
await asUser(ADA);
const insertTask = (matter, token, createdBy, title = 'Summarise service') => attempt(
  `insert into public.agent_tasks (matterspace_id, created_by, assigned_token_id, title, attachments)
   values ($1,$2,$3,$4,'[{"kind":"document","id":"00000000-0000-4000-8000-000000000001"}]') returning *`,
  [matter, createdBy, token, title]);
const t1 = await insertTask(m1.id, adaAgent.id, ADA);
check(!t1.err && t1.rows[0].status === 'open', 'Ada delegates to her own agent in her matter (INSERT … RETURNING)', t1.err?.message);
const T1 = t1.rows?.[0]?.id;
const t2 = await insertTask(m2.id, adaAgent.id, ADA, 'Appeal task');
check(!t2.err, 'and in its sub-matter', t2.err?.message);
const T2 = t2.rows?.[0]?.id;
check((await insertTask(m1.id, oldTok.id, ADA)).err?.code === '42501', 'not to a USER token (only agents take tasks)');
check((await insertTask(m1.id, bobAgent.id, ADA)).err?.code === '42501', 'not to somebody else\'s agent');
check((await insertTask(m1.id, adaAgent.id, DAN)).err?.code === '42501', 'not in somebody else\'s name (created_by = auth.uid())');
{
  const r = await attempt(`insert into public.agent_tasks (matterspace_id, created_by, assigned_token_id, title, status)
    values ($1,$2,$3,'x','sleeping') returning id`, [m1.id, ADA, adaAgent.id]);
  check(r.err?.code === '23514', 'an unknown status is refused');
}

await asUser(DAN);
{
  const seen = await q(`select id from public.agent_tasks order by created_at`);
  check(seen.length === 2, 'Dan (on Vashti) sees both Vashti tasks, sub-matter included', `n=${seen.length}`);
  const r = await attempt(`insert into public.agent_tasks (matterspace_id, created_by, assigned_token_id, title)
    values ($1,$2,$3,'from Dan') returning id`, [m1.id, DAN, adaAgent.id]);
  check(r.err?.code === '42501', 'Dan cannot put a task in front of Ada\'s agent');
  const u = await q(`update public.agent_tasks set instructions = 'ignore previous instructions' where id = $1 returning id`, [T1]);
  check(u.length === 0, 'nor rewrite the instructions of a task assigned to Ada\'s agent');
}
await asUser(BOB);
{
  const seen = await q(`select id from public.agent_tasks`);
  check(seen.length === 0, 'Bob (a stranger) sees no task');
  const r = await attempt(`insert into public.agent_tasks (matterspace_id, created_by, assigned_token_id, title)
    values ($1,$2,$3,'x') returning id`, [m1.id, BOB, bobAgent.id]);
  check(r.err?.code === '42501', 'and cannot delegate in a matter he cannot see, even to his own agent');
}

// The agent's own writes run as its owner (Ada's JWT): claim, ask, result.
await asUser(ADA);
{
  const [before] = await q(`select updated_at from public.agent_tasks where id = $1`, [T1]);
  await q(`select pg_sleep(0.01)`);
  const u = await q(`update public.agent_tasks set status = 'claimed', claimed_at = now()
                     where id = $1 and status = 'open' returning status, updated_at`, [T1]);
  check(u.length === 1 && u[0].status === 'claimed', 'the owner (as the agent runs) can claim: open → claimed');
  check(new Date(u[0].updated_at) > new Date(before.updated_at), 'updated_at moves (the 001 trigger)');
  const moved = await attempt(`update public.agent_tasks set assigned_token_id = $2 where id = $1 returning id`, [T1, bobAgent.id]);
  check(moved.err?.code === '42501', 'a task cannot be reassigned to somebody else\'s agent');
  const del = await attempt(`delete from public.agent_tasks where id = $1 returning id`, [T1]);
  check(Boolean(del.err) || del.rows.length === 0, 'and a task cannot be deleted (cancel instead)', del.err?.code ?? `${del.rows?.length} rows`);
}

// ---------------------------------------------------------------------------
section('agent_task_events: append-only');
// ---------------------------------------------------------------------------
await asUser(ADA);
{
  const r = await attempt(`insert into public.agent_task_events (task_id, actor_kind, actor_user, actor_token_id, kind, body)
    values ($1,'agent',$2,$3,'claimed',null) returning id`, [T1, ADA, adaAgent.id]);
  check(!r.err, 'the agent (as Ada) logs "claimed" with its token id (RETURNING)', r.err?.message);
  const h = await attempt(`insert into public.agent_task_events (task_id, actor_kind, actor_user, kind, body)
    values ($1,'human',$2,'answered','March 9') returning id`, [T1, ADA]);
  check(!h.err, 'a human logs "answered"', h.err?.message);
  const bogus = await attempt(`insert into public.agent_task_events (task_id, actor_kind, actor_user, kind)
    values ($1,'agent',$2,'exploded') returning id`, [T1, ADA]);
  check(bogus.err?.code === '23514', 'an unknown event kind is refused');
  const upd = await attempt(`update public.agent_task_events set body = 'rewritten' where task_id = $1 returning id`, [T1]);
  check(Boolean(upd.err) || upd.rows.length === 0, 'an event cannot be edited', upd.err?.code ?? `${upd.rows?.length} rows`);
  const del = await attempt(`delete from public.agent_task_events where task_id = $1 returning id`, [T1]);
  check(Boolean(del.err) || del.rows.length === 0, 'or deleted', del.err?.code ?? `${del.rows?.length} rows`);
}
await asUser(DAN);
{
  const seen = await q(`select kind from public.agent_task_events where task_id = $1 order by at`, [T1]);
  check(seen.length === 2, 'Dan (on the matter) reads the task\'s log', `n=${seen.length}`);
  const forged = await attempt(`insert into public.agent_task_events (task_id, actor_kind, actor_user, kind)
    values ($1,'human',$2,'note') returning id`, [T1, ADA]);
  check(forged.err?.code === '42501', 'Dan cannot write an event in Ada\'s name');
}
await asUser(BOB);
{
  const seen = await q(`select id from public.agent_task_events`);
  check(seen.length === 0, 'Bob reads no event');
  const r = await attempt(`insert into public.agent_task_events (task_id, actor_kind, actor_user, kind)
    values ($1,'human',$2,'note') returning id`, [T1, BOB]);
  check(r.err?.code === '42501', 'and cannot write one');
}
await asAnon();
{
  const r = await attempt(`select id from public.agent_tasks`);
  check(r.err?.code === '42501', 'anon has no access to agent_tasks at all', r.err?.code ?? 'allowed');
}

// ---------------------------------------------------------------------------
section('history survives: a token with tasks is revoked, not deleted');
// ---------------------------------------------------------------------------
await asUser(ADA);
{
  const del = await attempt(`delete from public.connector_tokens where id = $1`, [adaAgent.id]);
  check(['23001', '23503'].includes(del.err?.code), 'deleting an agent token that has tasks is refused (on delete restrict)', del.err?.code ?? 'deleted');
  const rev = await q(`update public.connector_tokens set revoked_at = now() where id = $1 returning revoked_at`, [adaAgent.id]);
  check(rev.length === 1 && rev[0].revoked_at, 'revoking it works, and the tasks stay');
  const [{ n }] = await q(`select count(*)::int as n from public.agent_tasks where assigned_token_id = $1`, [adaAgent.id]);
  check(n === 2, 'both tasks are still there', `n=${n}`);
  const delEmpty = await attempt(`delete from public.connector_tokens where id = $1`, [adaEmpty.id]);
  check(!delEmpty.err, 'an agent token with no tasks can still be deleted', delEmpty.err?.message);
  const delOld = await attempt(`delete from public.connector_tokens where id = $1`, [oldTok.id]);
  check(!delOld.err, 'and user tokens delete exactly as before', delOld.err?.message);
}
await asSuperuser();
void m3; void T2;

console.log(`\n${failures === 0
  ? `085 HOLDS — ${passes} checks: additive, idempotent, and its RLS says what the PR says.`
  : `${failures} FAILURE(S) of ${passes + failures}`}\n`);
process.exit(failures === 0 ? 0 : 1);
