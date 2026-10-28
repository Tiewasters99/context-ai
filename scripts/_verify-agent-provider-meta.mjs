// Migration 118 — 'meta' is an agent provider — EXECUTED in PGlite on the
// real migration chain.
//
// What it proves
// ---------------------------------------------------------------------------
//   SQL   118 applies on 001…022 + 062 + 063 + 065 + 085 + 086 + 087 + 088,
//         and again over itself (the second run is a no-op). The column rule
//         takes 'meta', still refuses a provider nobody listed, and existing
//         rows are untouched.
//   FUNC  oauth_grant_approve keeps one signature and stays service-role only
//         after the in-place patch; a consent "as an agent" with provider
//         'meta' stores 'meta' (before 118 it was turned into 'other'), and an
//         unknown provider still becomes 'other'.
//   STOP  If the provider list is not where 118 expects it, 118 raises and the
//         function is left exactly as it was.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-agent-provider-meta.mjs
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = (name) => fs.readFileSync(path.resolve(__dirname, '..', 'supabase', 'migrations', name), 'utf8');
const M118 = '118_agent_provider_meta.sql';

let failures = 0;
let passes = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (ok) passes += 1; else failures += 1;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 62 - t.length))}`);

const db = new PGlite({ extensions: { uuid_ossp } });
const q = async (sql, params) => (await db.query(sql, params)).rows;
const execAttempt = async (sql) => { try { await db.exec(sql); return { err: null }; } catch (err) { return { err }; } };
const asService = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  await db.exec('set role service_role');
};
const asSuperuser = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
};

section('the chain: 001…022, 062, 063, 065, 085, 086, 087, 088');
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
await db.exec(migration('085_agent_tokens_and_tasks.sql'));
await db.exec(`grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;`);
await db.exec(`
  revoke all on public.oauth_grants from anon, authenticated;
  grant select on public.oauth_grants to authenticated;
  grant update (revoked_at) on public.oauth_grants to authenticated;
`);
await db.exec(migration('086_connector_metering_and_token_lock.sql'));
await db.exec(migration('087_oauth_grant_agent_link.sql'));
await db.exec(migration('088_agent_scope_all.sql'));

const [{ id: ADA }] = await q(`insert into auth.users (email) values ('ada@example.test') returning id`);
const hex = (c) => c.repeat(64);
const [pre] = await q(`insert into public.connector_tokens (user_id, token_hash, token_prefix, name, kind, agent_provider, matter_scope)
  values ($1, $2, 'csp_agt', 'Grok', 'agent', 'grok', '{}') returning id`, [ADA, hex('1')]);

const SIG = 'public.oauth_grant_approve(uuid, text, text, text[], text, text, text, uuid[], text, boolean)';
const fnState = async () => {
  await asSuperuser();
  return JSON.stringify(await q(`select oid::regprocedure::text sig, proacl::text acl, prosecdef, proowner
    from pg_proc where proname = 'oauth_grant_approve' and pronamespace = 'public'::regnamespace`));
};
const approveAgent = async (clientId, provider, tokenChar) => {
  await asService();
  const [r] = await q(`select * from public.oauth_grant_approve($1, $2, 'Muse', null, null, 'Muse', $3, '{}'::uuid[], $4, false)`,
    [ADA, clientId, provider, hex(tokenChar)]);
  await asSuperuser();
  const [t] = await q(`select agent_provider from public.connector_tokens where id = $1`, [r.agent_token_id]);
  return t.agent_provider;
};

// Before 118: the consent write turns 'meta' into 'other'.
check(await approveAgent('client-before', 'meta', 'a') === 'other', "before 118, a 'meta' consent is stored as 'other'");

// ===========================================================================
section('118 applies, twice');
// ===========================================================================
const before = await fnState();
const r1 = await execAttempt(migration(M118));
const after1 = await fnState();
const r2 = await execAttempt(migration(M118));
const after2 = await fnState();
check(!r1.err && !r2.err, '118 applies, and applies again over itself', r1.err?.message || r2.err?.message || '');
check(before === after1 && after1 === after2,
  'oauth_grant_approve: same single signature, owner, SECURITY DEFINER and grants', after2);
{
  const [d] = await q(`select pg_get_functiondef($1::regprocedure) def`, [SIG]);
  const n = d.def.split(`'meta'`).length - 1;
  check(n === 1, "the function lists 'meta' exactly once", `found ${n}`);
}

// ===========================================================================
section('the column rule');
// ===========================================================================
{
  await asSuperuser();
  const ok = await execAttempt(`insert into public.connector_tokens (user_id, token_hash, token_prefix, name, kind, agent_provider, matter_scope)
    values ('${ADA}', '${hex('b')}', 'csp_m', 'Instinct', 'agent', 'meta', '{}')`);
  check(!ok.err, "an agent row with provider 'meta' is accepted", ok.err?.message || '');
  const bad = await execAttempt(`insert into public.connector_tokens (user_id, token_hash, token_prefix, name, kind, agent_provider, matter_scope)
    values ('${ADA}', '${hex('c')}', 'csp_x', 'X', 'agent', 'mistral', '{}')`);
  check(!!bad.err, "a provider nobody listed is still refused", bad.err ? '' : 'it was accepted');
  const [p] = await q(`select agent_provider from public.connector_tokens where id = $1`, [pre.id]);
  check(p.agent_provider === 'grok', 'an existing row is untouched');
}

// ===========================================================================
section('the consent write');
// ===========================================================================
check(await approveAgent('client-meta', 'meta', 'd') === 'meta', "a 'meta' consent is stored as 'meta'");
check(await approveAgent('client-odd', 'mistral', 'e') === 'other', "an unknown provider is still stored as 'other'");
check(await approveAgent('client-grok', 'grok', 'f') === 'grok', "'grok' is unchanged");

// ===========================================================================
section('a function that does not look like 088 is left alone');
// ===========================================================================
{
  // Back to the pre-118 rule, with an approve function that lists the
  // providers twice.
  await asSuperuser();
  await db.exec(`
    update public.connector_tokens set agent_provider = 'other' where agent_provider = 'meta';
    alter table public.connector_tokens drop constraint connector_tokens_agent_provider_chk;
    alter table public.connector_tokens add constraint connector_tokens_agent_provider_chk
      check (agent_provider is null or agent_provider in ('grok', 'chatgpt', 'claude', 'gemini', 'other'));
  `);
  const [d] = await q(`select pg_get_functiondef($1::regprocedure) def`, [SIG]);
  const list = `in ('grok', 'chatgpt', 'claude', 'gemini', 'other')`;
  const doubled = d.def
    .replace(`in ('grok', 'chatgpt', 'claude', 'gemini', 'meta', 'other')`, list)
    .replace('v_agent_name := left(', `perform 1 where 'x' ${list};\n  v_agent_name := left(`);
  await db.exec(doubled);
  const [d0] = await q(`select pg_get_functiondef($1::regprocedure) def`, [SIG]);
  const r = await execAttempt(migration(M118));
  const [d1] = await q(`select pg_get_functiondef($1::regprocedure) def`, [SIG]);
  check(!!r.err && /found 2/.test(r.err.message), '118 stops with "found 2"', r.err?.message || 'no error');
  check(d0.def === d1.def, 'and the function is exactly as it was');
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
