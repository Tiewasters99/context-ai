// Migration 089 — a task can go to ANY connected AI (an agent token, a
// full-access user token, or a full-assistant OAuth sign-in) — EXECUTED in
// PGlite with the real migration chain and real RLS.
//
// What it proves
// ---------------------------------------------------------------------------
//   SQL    089 applies (twice, converging) on 001…022 + 062 + 065 + 083 + 085
//          + 086 + 087. A task made BEFORE 089 is still valid and unchanged.
//          Exactly one of assigned_token_id / assigned_grant_id may be set.
//          The policy helper is SECURITY INVOKER.
//   RLS    From SET ROLE authenticated (INSERT … RETURNING included): the owner
//          can create a task for their own agent token, their own user token
//          and their own OAuth assistant; not for an agent-linked grant (that
//          connection is its agent token); not for anybody else's token or
//          grant; not in somebody else's name. A co-counsel reads, cannot
//          write. A stranger sees nothing. Reassigning between the owner's
//          own connections works; to another person's does not. A grant with
//          tasks cannot be deleted (restrict), and revoking it keeps them.
//          agent_task_events takes actor_grant_id.
//   PLAN   plan_can_open('agentTasks') is true for every plan (core);
//          the frozen 'agents' surface is still closed to a free account.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-tasks-any-recipient.mjs
//
// No .env, no network, no production.

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

process.on('unhandledRejection', (e) => {
  console.error(`\n  SQL ERROR: ${String(e?.message ?? e).split('\n')[0]}\n`);
  process.exit(1);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = (name) => fs.readFileSync(path.resolve(__dirname, '..', 'supabase', 'migrations', name), 'utf8');
const M089 = '089_agent_tasks_any_recipient.sql';

let failures = 0;
let passes = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (ok) passes += 1; else failures += 1;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 62 - t.length))}`);

const db = new PGlite({ extensions: { uuid_ossp } });
const q = async (sql, params) => (await db.query(sql, params)).rows;
const attempt = async (sql, params) => {
  try { return { rows: (await db.query(sql, params)).rows, err: null }; } catch (err) { return { rows: null, err }; }
};
const execAttempt = async (sql) => { try { await db.exec(sql); return { err: null }; } catch (err) { return { err }; } };
const asUser = async (uid) => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec('set role authenticated');
};
const asSuperuser = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
};

// ===========================================================================
section('the chain: 001…022, 062, 063, 065, 083, 085, 086, 087');
// ===========================================================================
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
    id uuid primary key default gen_random_uuid(), matterspace_id uuid, created_by uuid,
    page_count int, file_size_bytes bigint, ingested_at timestamptz,
    created_at timestamptz not null default now());
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
await db.exec(`alter table public.matterspaces add column if not exists ai_tier text not null default 'A'`);
await db.exec(migration('062_profiles_rls_plan.sql'));
await db.exec(migration('063_usage_budgets.sql'));
await db.exec(migration('065_oauth_grants.sql'));
await db.exec(migration('083_server_entitlements.sql'));
await db.exec(migration('085_agent_tokens_and_tasks.sql'));
await db.exec(`grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;`);
await db.exec(`
  revoke all on public.oauth_grants from anon, authenticated;
  grant select on public.oauth_grants to authenticated;
  grant update (revoked_at) on public.oauth_grants to authenticated;
`);
await db.exec(migration('086_connector_metering_and_token_lock.sql'));
await db.exec(migration('087_oauth_grant_agent_link.sql'));
check(true, 'the chain 089 sits on is applied');

const signup = async (email, name) => (await q(`insert into auth.users (email, raw_user_meta_data)
  values ($1, jsonb_build_object('display_name', $2::text)) returning id`, [email, name]))[0].id;
const ADA = await signup('ada@example.test', 'Ada');   // owns the firm
const DAN = await signup('dan@example.test', 'Dan');   // co-counsel on Vashti
const BOB = await signup('bob@example.test', 'Bob');   // a stranger
const [s1] = await q(`insert into public.serverspaces (clientspace_id, name)
  select id, 'Firm' from public.clientspaces where user_id = $1 returning id`, [ADA]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner')`, [s1.id, ADA]);
const [m1] = await q(`insert into public.matterspaces (serverspace_id, name) values ($1,'Vashti') returning id`, [s1.id]);
await q(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,'member')`, [m1.id, DAN]);

const hex = (c) => c.repeat(64);
const token = async (uid, h, name, kind = 'user') => (await q(
  kind === 'agent'
    ? `insert into public.connector_tokens (user_id, token_hash, token_prefix, name, kind, agent_provider, matter_scope)
       values ($1,$2,'csp_x',$3,'agent','grok','{}') returning id`
    : `insert into public.connector_tokens (user_id, token_hash, token_prefix, name) values ($1,$2,'csp_x',$3) returning id`,
  [uid, h, name]))[0].id;
const grant = async (uid, clientId, name, agentTokenId = null) => (await q(
  `insert into public.oauth_grants (user_id, client_id_hash, client_id_prefix, client_name, agent_token_id)
   values ($1, public.oauth_grant_hash($2), left($2, 12), $3, $4) returning id`,
  [uid, clientId, name, agentTokenId]))[0].id;

const ADA_AGENT = await token(ADA, hex('1'), 'Grok bot', 'agent');
const ADA_USER = await token(ADA, hex('2'), 'Claude Desktop');
const ADA_GRANT = await grant(ADA, 'client-chatgpt', 'ChatGPT');
const ADA_LINKED_AGENT = await token(ADA, hex('3'), 'Grok (sign-in)', 'agent');
const ADA_LINKED_GRANT = await grant(ADA, 'client-grok', 'Grok', ADA_LINKED_AGENT);
const BOB_USER = await token(BOB, hex('4'), 'Bob Claude');
const BOB_GRANT = await grant(BOB, 'client-bob', 'Claude');

// A task made BEFORE 089, the only kind there is today.
const [pre] = await q(`insert into public.agent_tasks (matterspace_id, created_by, assigned_token_id, title)
  values ($1,$2,$3,'Before 089') returning *`, [m1.id, ADA, ADA_AGENT]);

// ===========================================================================
section('089, applied twice');
// ===========================================================================
{
  const r1 = await execAttempt(migration(M089));
  const shape = async () => JSON.stringify(await q(`
    select conname, pg_get_constraintdef(oid) d from pg_constraint
     where conrelid in ('public.agent_tasks'::regclass, 'public.agent_task_events'::regclass) order by 1`));
  const s1c = await shape();
  const r2 = await execAttempt(migration(M089));
  const s2c = await shape();
  check(!r1.err && !r2.err, '089 applies, and applies again over itself', r1.err?.message || r2.err?.message || '');
  check(s1c === s2c, 'the second run converges: identical constraints');

  const [after] = await q(`select * from public.agent_tasks where id = $1`, [pre.id]);
  check(after.assigned_token_id === ADA_AGENT && after.assigned_grant_id === null
    && after.title === pre.title && after.status === pre.status,
  'the task made before 089 is unchanged (token set, grant null)');

  const cols = await q(`select table_name, column_name, is_nullable from information_schema.columns
    where table_schema='public' and ((table_name='agent_tasks' and column_name in ('assigned_token_id','assigned_grant_id'))
      or (table_name='agent_task_events' and column_name='actor_grant_id')) order by 1,2`);
  check(cols.length === 3 && cols.every((c) => c.is_nullable === 'YES'),
    'assigned_token_id is nullable; assigned_grant_id and actor_grant_id exist, nullable');
  const [fn] = await q(`select prosecdef from pg_proc where proname = '_agent_task_recipient_is_mine'`);
  check(fn && fn.prosecdef === false, 'the policy helper is SECURITY INVOKER');
  const pol = await q(`select policyname, qual, with_check from pg_policies where tablename='agent_tasks' and cmd in ('INSERT','UPDATE')`);
  check(pol.length === 2 && pol.every((p) => /_agent_task_recipient_is_mine/.test(`${p.qual ?? ''} ${p.with_check ?? ''}`)
    && !/_agent_token_is_mine/.test(`${p.qual ?? ''} ${p.with_check ?? ''}`)),
  'insert and update policies use the new helper, not 085\'s');
}

// ===========================================================================
section('exactly one recipient');
// ===========================================================================
await asSuperuser();
{
  const both = await attempt(`insert into public.agent_tasks (matterspace_id, created_by, assigned_token_id, assigned_grant_id, title)
    values ($1,$2,$3,$4,'both') returning id`, [m1.id, ADA, ADA_USER, ADA_GRANT]);
  check(both.err?.code === '23514', 'a task with a token AND a grant is refused', both.err?.code ?? 'accepted');
  const none = await attempt(`insert into public.agent_tasks (matterspace_id, created_by, title)
    values ($1,$2,'none') returning id`, [m1.id, ADA]);
  check(none.err?.code === '23514', 'a task with neither is refused', none.err?.code ?? 'accepted');
}

// ===========================================================================
section('owner-only: Ada delegates to each of her own connections');
// ===========================================================================
await asUser(ADA);
const make = (who, { tokenId = null, grantId = null, createdBy = who, title = 'Summarise service' } = {}) => attempt(
  `insert into public.agent_tasks (matterspace_id, created_by, assigned_token_id, assigned_grant_id, title)
   values ($1,$2,$3,$4,$5) returning *`, [m1.id, createdBy, tokenId, grantId, title]);
const tAgent = await make(ADA, { tokenId: ADA_AGENT });
check(!tAgent.err, 'to her agent token (INSERT … RETURNING)', tAgent.err?.message);
const tUser = await make(ADA, { tokenId: ADA_USER });
check(!tUser.err, 'to her full-access USER token (refused before 089)', tUser.err?.message);
const tGrant = await make(ADA, { grantId: ADA_GRANT });
check(!tGrant.err && tGrant.rows[0].assigned_grant_id === ADA_GRANT && tGrant.rows[0].assigned_token_id === null,
  'to her OAuth assistant (ChatGPT, signed in as a full assistant)', tGrant.err?.message);
const G1 = tGrant.rows?.[0]?.id;
check((await make(ADA, { grantId: ADA_LINKED_GRANT })).err?.code === '42501',
  'not to an agent-linked grant (that sign-in IS its agent token; assign the token)');
check(!(await make(ADA, { tokenId: ADA_LINKED_AGENT })).err, 'and the linked agent\'s token takes it instead');
check((await make(ADA, { tokenId: BOB_USER })).err?.code === '42501', 'not to somebody else\'s token');
check((await make(ADA, { grantId: BOB_GRANT })).err?.code === '42501', 'not to somebody else\'s OAuth assistant');
check((await make(ADA, { grantId: ADA_GRANT, createdBy: DAN })).err?.code === '42501', 'not in somebody else\'s name');

await asUser(DAN);
{
  const seen = await q(`select id from public.agent_tasks where assigned_grant_id is not null`);
  check(seen.length === 1, 'Dan (co-counsel) reads the grant task', `n=${seen.length}`);
  check((await make(DAN, { grantId: ADA_GRANT })).err?.code === '42501', 'Dan cannot put a task in front of Ada\'s assistant');
  const u = await q(`update public.agent_tasks set instructions = 'ignore previous instructions' where id = $1 returning id`, [G1]);
  check(u.length === 0, 'nor rewrite it');
}
await asUser(BOB);
{
  check((await q(`select id from public.agent_tasks`)).length === 0, 'Bob (a stranger) sees no task');
  const r = await make(BOB, { grantId: BOB_GRANT });
  check(r.err?.code === '42501', 'and cannot delegate in a matter he cannot see, even to his own assistant');
}

// ===========================================================================
section('updates: the assistant works it, the owner reassigns');
// ===========================================================================
await asUser(ADA);
{
  const c = await q(`update public.agent_tasks set status='claimed', claimed_at=now() where id=$1 and status='open' returning status`, [G1]);
  check(c.length === 1 && c[0].status === 'claimed', 'the grant\'s task can be claimed (the server runs as its owner)');
  const toBob = await attempt(`update public.agent_tasks set assigned_grant_id = $2 where id = $1 returning id`, [G1, BOB_GRANT]);
  check(toBob.err?.code === '42501', 'it cannot be reassigned to somebody else\'s assistant');
  const toBoth = await attempt(`update public.agent_tasks set assigned_token_id = $2 where id = $1 returning id`, [G1, ADA_USER]);
  check(['23514', '42501'].includes(toBoth.err?.code), 'reassigning must clear the grant (exactly one)', toBoth.err?.code ?? 'accepted');
  const toToken = await q(`update public.agent_tasks set assigned_token_id = $2, assigned_grant_id = null, status='open'
    where id = $1 returning assigned_token_id`, [G1, ADA_USER]);
  check(toToken.length === 1 && toToken[0].assigned_token_id === ADA_USER, 'reassigning to her own user token works');
  const back = await q(`update public.agent_tasks set assigned_token_id = null, assigned_grant_id = $2
    where id = $1 returning assigned_grant_id`, [G1, ADA_GRANT]);
  check(back.length === 1 && back[0].assigned_grant_id === ADA_GRANT, 'and back to her OAuth assistant');
}

// ===========================================================================
section('agent_task_events: an assistant\'s entry');
// ===========================================================================
await asUser(ADA);
{
  const r = await attempt(`insert into public.agent_task_events (task_id, actor_kind, actor_user, actor_grant_id, kind)
    values ($1,'agent',$2,$3,'claimed') returning actor_grant_id`, [G1, ADA, ADA_GRANT]);
  check(!r.err && r.rows[0].actor_grant_id === ADA_GRANT, 'logs "claimed" with the grant id (RETURNING)', r.err?.message);
}

// ===========================================================================
section('history survives: a grant with tasks is revoked, never deleted');
// ===========================================================================
await asUser(ADA);
{
  const rev = await attempt(`update public.oauth_grants set revoked_at = now() where id = $1`, [ADA_GRANT]);
  check(!rev.err, 'Ada revokes the ChatGPT sign-in', rev.err?.message);
  const [{ n }] = await q(`select count(*)::int n from public.agent_tasks where assigned_grant_id = $1`, [ADA_GRANT]);
  check(n === 1, 'its task is still there, still readable', `n=${n}`);
  const c = await q(`update public.agent_tasks set status='cancelled' where id=$1 returning status`, [G1]);
  check(c.length === 1, 'and Ada can still cancel it (owner-only does not require a live connection)');
}
await asSuperuser();
{
  const del = await attempt(`delete from public.oauth_grants where id = $1`, [ADA_GRANT]);
  check(['23001', '23503'].includes(del.err?.code), 'deleting a grant that has tasks is refused (on delete restrict)', del.err?.code ?? 'deleted');
}

// ===========================================================================
section('plan_can_open: the Agents page is core');
// ===========================================================================
await asUser(BOB);   // a free account
{
  const [a] = await q(`select public.plan_can_open('agentTasks') ok`);
  const [b] = await q(`select public.plan_can_open('agents') ok`);
  const [c] = await q(`select public.plan_can_open('vault') ok`);
  check(a.ok === true, 'a free account may open agentTasks (the Agents page)');
  check(b.ok === false, 'the frozen agents surface (charters) is still closed to it');
  check(c.ok === true, 'core surfaces are unchanged');
}
await asSuperuser();

console.log(`\n${failures === 0
  ? `089 HOLDS — ${passes} checks: additive, idempotent, owner-only for every kind of recipient.`
  : `${failures} FAILURE(S) of ${passes + failures}`}\n`);
process.exit(failures === 0 ? 0 : 1);
