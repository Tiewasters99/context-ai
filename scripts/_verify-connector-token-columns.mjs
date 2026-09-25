// Migration 086 §1 — connector_tokens.token_hash is server-only.
//
// The claim is not "our pages do not ask for the hash". It is "Postgres
// refuses to give it to a browser". So this builds the real chain (001 → 022,
// 003, 085), installs Supabase's blanket default grant (the state 086 has to
// undo), runs the REAL 086 file, and asserts from inside `SET ROLE` with
// `request.jwt.claims` set the way PostgREST sets it:
//
//   1. THE LEAK, before 086 — the negative control. As `authenticated`,
//      `select token_hash` and `select *` both succeed on the owner's rows.
//   2. AFTER 086. token_hash is refused (42501), `select *` is refused, the
//      hash cannot be probed through WHERE or ORDER BY; every other column is
//      readable, and RLS still cuts the rows to the caller's own.
//   3. THE BROWSER'S WRITES STILL WORK. A user token INSERT with its hash (the
//      Connect pages), an agent token INSERT with kind/provider/scope
//      (Connections › Agents), revoke by UPDATE, scope change by UPDATE, and
//      DELETE — all as the owner, none on another user's row.
//   4. THE TASK BOARD STILL WORKS. 085's policy helper _agent_token_is_mine
//      is SECURITY INVOKER, so it reads connector_tokens as `authenticated`;
//      a task can still be put in front of one's own agent, not another's.
//   5. THE SERVICE ROLE IS UNAFFECTED — it reads token_hash by hash, which is
//      what api/mcp.mjs authenticate() does.
//   6. IDEMPOTENT: 086 twice, identical column ACLs.
//   7. DRIFT: 086 on a database where 085 was never pasted (no kind column)
//      still closes the hash and grants what exists.
//   8. STATIC: no read of connector_tokens under src/ asks for `*` or names
//      token_hash, and no write chains `.select()` onto itself.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-connector-token-columns.mjs
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
const repo = path.resolve(__dirname, '..');
const migration = (name) => fs.readFileSync(path.join(repo, 'supabase', 'migrations', name), 'utf8');
const M086 = '086_connector_metering_and_token_lock.sql';

let failures = 0;
let passes = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (ok) passes += 1; else failures += 1;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 62 - t.length))}`);

// Transcribed from 086 and checked against it below, so this file cannot
// drift away from what it verifies.
const SAFE_COLUMNS = [
  'id', 'user_id', 'token_prefix', 'name', 'scopes', 'created_at', 'last_used_at',
  'revoked_at', 'expires_at', 'kind', 'agent_provider', 'matter_scope',
];
{
  const src = migration(M086);
  const m = src.match(/safe_columns\s+constant text\[\] := array\[([\s\S]*?)\];/);
  const listed = m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : [];
  check(JSON.stringify(listed) === JSON.stringify(SAFE_COLUMNS),
    "086's safe list is the one this harness checks", listed.join(', '));
  check(!listed.includes('token_hash'), 'and token_hash is not on it');
}

async function bootstrap({ with085 = true } = {}) {
  const db = new PGlite({ extensions: { uuid_ossp } });
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
  if (with085) await db.exec(migration('085_agent_tokens_and_tasks.sql'));
  // Supabase's own blanket default, applied after the tables exist — the
  // state the live database is in, and the one 086 exists to undo.
  await db.exec(`grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;`);
  return db;
}

const helpers = (db) => {
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const attempt = async (sql, params) => {
    try { return { ok: true, rows: (await db.query(sql, params)).rows }; } catch (e) {
      return { ok: false, code: e?.code ?? e?.cause?.code ?? '?', message: String(e?.message ?? e).split('\n')[0] };
    }
  };
  const asUser = async (uid) => {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    await db.exec('set role authenticated');
  };
  const asRole = async (role) => {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role })]);
    await db.exec(`set role ${role}`);
  };
  const asSuperuser = async () => {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  };
  const columnAcls = async () => JSON.stringify((await q(`
    select a.attname, a.attacl::text from pg_attribute a
     where a.attrelid = 'public.connector_tokens'::regclass and a.attnum > 0 and not a.attisdropped
     order by a.attnum`)));
  return { q, attempt, asUser, asRole, asSuperuser, columnAcls };
};

// ===========================================================================
section('1. the leak, before 086 — the negative control');
// ===========================================================================
const db = await bootstrap();
const { q, attempt, asUser, asRole, asSuperuser, columnAcls } = helpers(db);

const signup = async (email) => (await q(`insert into auth.users (email) values ($1) returning id`, [email]))[0].id;
const ADA = await signup('ada@example.test');
const BOB = await signup('bob@example.test');
const [s1] = await q(
  `insert into public.serverspaces (clientspace_id, name)
   select id, 'Firm' from public.clientspaces where user_id = $1 returning id`, [ADA]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner')`, [s1.id, ADA]);
const [m1] = await q(`insert into public.matterspaces (serverspace_id, name) values ($1,'Vashti') returning id`, [s1.id]);
await q(`insert into public.connector_tokens (user_id, token_hash, token_prefix, name) values
  ($1, 'HASH-ADA-1', 'csp_ada1', 'Claude Desktop'),
  ($2, 'HASH-BOB-1', 'csp_bob1', 'Bob laptop')`, [ADA, BOB]);

await asUser(ADA);
{
  const h = await attempt('select token_hash from public.connector_tokens');
  check(h.ok && h.rows.length === 1 && h.rows[0].token_hash === 'HASH-ADA-1',
    'BEFORE 086: the owner can read their own token_hash', h.ok ? `${h.rows.length} row(s)` : h.code);
  const star = await attempt('select * from public.connector_tokens');
  check(star.ok && 'token_hash' in (star.rows[0] ?? {}), 'BEFORE 086: `select *` hands it over too');
}
await asSuperuser();

// ===========================================================================
section('2. after 086 — Postgres refuses, not our code');
// ===========================================================================
await db.exec(migration(M086));
console.log(`  executed supabase/migrations/${M086}`);

const assertLocked = async (label) => {
  await asUser(ADA);
  const h = await attempt('select token_hash from public.connector_tokens');
  check(!h.ok && h.code === '42501', `${label}select token_hash → 42501`, h.ok ? `LEAKED ${JSON.stringify(h.rows[0])}` : h.code);
  const star = await attempt('select * from public.connector_tokens');
  check(!star.ok && star.code === '42501', `${label}\`select *\` fails loudly (42501) — every browser read must name its columns`,
    star.ok ? 'IT SUCCEEDED' : star.code);
  const where = await attempt("select id from public.connector_tokens where token_hash = 'HASH-ADA-1'");
  check(!where.ok && where.code === '42501', `${label}the hash cannot be probed through WHERE`, where.code);
  const order = await attempt('select id from public.connector_tokens order by token_hash');
  check(!order.ok && order.code === '42501', `${label}nor through ORDER BY`, order.code);
  const listing = await attempt(
    'select id, token_prefix, name, created_at, last_used_at, revoked_at, expires_at, kind from public.connector_tokens');
  check(listing.ok && listing.rows.length >= 1 && listing.rows.every((r) => r.token_prefix.startsWith('csp_ada') || r.token_prefix.startsWith('csp_ag')),
    `${label}the owner lists their tokens without the hash, and sees only their own`,
    listing.ok ? `${listing.rows.length} row(s)` : listing.code);
  let bad = [];
  for (const col of SAFE_COLUMNS) {
    const r = await attempt(`select ${col} from public.connector_tokens limit 1`);
    if (!r.ok) bad.push(`${col}:${r.code}`);
  }
  check(bad.length === 0, `${label}every other column is readable`, bad.join(', '));
  await asRole('anon');
  const anon = await attempt('select id from public.connector_tokens');
  check(!anon.ok && anon.code === '42501', `${label}anon can read nothing at all`, anon.ok ? 'allowed' : anon.code);
  await asSuperuser();
};
await assertLocked('');

// ===========================================================================
section("3. the browser's writes still work");
// ===========================================================================
await asUser(ADA);
{
  const ins = await attempt(
    `insert into public.connector_tokens (user_id, token_hash, token_prefix, name) values ($1, 'HASH-ADA-2', 'csp_ada2', 'ChatGPT')`, [ADA]);
  check(ins.ok, 'a user token INSERT with its hash works (the Connect pages)', ins.ok ? '' : `${ins.code} ${ins.message}`);
  const agent = await attempt(
    `insert into public.connector_tokens (user_id, token_hash, token_prefix, name, kind, agent_provider, matter_scope)
     values ($1, 'HASH-ADA-AGENT', 'csp_agent', 'Grok bot', 'agent', 'grok', array[$2]::uuid[])`, [ADA, m1.id]);
  check(agent.ok, 'an agent token INSERT with kind/provider/scope works (Connections › Agents)', agent.ok ? '' : `${agent.code} ${agent.message}`);
  const ret = await attempt(
    `insert into public.connector_tokens (user_id, token_hash, token_prefix) values ($1, 'HASH-ADA-3', 'csp_ada3') returning id, token_prefix`, [ADA]);
  check(ret.ok, 'INSERT … RETURNING named safe columns works', ret.ok ? '' : ret.code);
  const retHash = await attempt(
    `insert into public.connector_tokens (user_id, token_hash, token_prefix) values ($1, 'HASH-ADA-4', 'csp_ada4') returning token_hash`, [ADA]);
  check(!retHash.ok && retHash.code === '42501', 'INSERT … RETURNING token_hash is refused', retHash.ok ? 'LEAKED' : retHash.code);
  const forged = await attempt(
    `insert into public.connector_tokens (user_id, token_hash, token_prefix) values ($1, 'HASH-FORGED', 'csp_x')`, [BOB]);
  check(!forged.ok, "a token cannot be inserted for someone else (003's policy, unchanged)", forged.ok ? 'INSERTED' : forged.code);

  const [{ id: agentId }] = (await attempt(`select id from public.connector_tokens where token_prefix = 'csp_agent'`)).rows;
  const scope = await attempt(`update public.connector_tokens set matter_scope = '{}' where id = $1 and kind = 'agent'`, [agentId]);
  check(scope.ok, 'changing an agent\'s scope by UPDATE works', scope.ok ? '' : scope.code);
  const rev = await attempt(`update public.connector_tokens set revoked_at = now() where token_prefix = 'csp_ada2'`);
  check(rev.ok, 'revoking by UPDATE works', rev.ok ? '' : rev.code);
  const [{ n: bobBefore }] = await (async () => { await asSuperuser(); return q(`select count(*)::int as n from public.connector_tokens where user_id = $1 and revoked_at is null`, [BOB]); })();
  await asUser(ADA);
  await attempt(`update public.connector_tokens set revoked_at = now()`);
  await asSuperuser();
  const [{ n: bobAfter }] = await q(`select count(*)::int as n from public.connector_tokens where user_id = $1 and revoked_at is null`, [BOB]);
  check(bobBefore === 1 && bobAfter === 1, "an unfiltered UPDATE still reaches only the caller's own rows");
  await q(`update public.connector_tokens set revoked_at = null where user_id = $1`, [ADA]);
  await asUser(ADA);
  const del = await attempt(`delete from public.connector_tokens where token_prefix = 'csp_ada3'`);
  check(del.ok, 'DELETE works', del.ok ? '' : del.code);
  // Re-establish the agent's grant for §4.
  await attempt(`update public.connector_tokens set matter_scope = array[$2]::uuid[] where id = $1`, [agentId, m1.id]);

  // =========================================================================
  section('4. the task board still works under the column grants');
  // =========================================================================
  const task = await attempt(
    `insert into public.agent_tasks (matterspace_id, created_by, assigned_token_id, title)
     values ($1, $2, $3, 'Pull the docket') returning id`, [m1.id, ADA, agentId]);
  check(task.ok, "a task can be put in front of one's own agent (_agent_token_is_mine reads as authenticated)",
    task.ok ? '' : `${task.code} ${task.message}`);
  await asUser(BOB);
  const theft = await attempt(
    `insert into public.agent_tasks (matterspace_id, created_by, assigned_token_id, title)
     values ($1, $2, $3, 'x') returning id`, [m1.id, BOB, agentId]);
  check(!theft.ok, "and not in front of someone else's", theft.ok ? 'INSERTED' : theft.code);
  await asSuperuser();
}

// ===========================================================================
section('5. the service role is unaffected');
// ===========================================================================
await asRole('service_role');
{
  const r = await attempt(`select * from public.connector_tokens where token_hash = 'HASH-ADA-1'`);
  check(r.ok && r.rows.length === 1 && r.rows[0].token_hash === 'HASH-ADA-1',
    'service_role looks a token up by its hash, `select *` included (api/mcp.mjs authenticate)', r.ok ? '' : r.code);
}
await asSuperuser();

// ===========================================================================
section('6. idempotent');
// ===========================================================================
{
  const before = await columnAcls();
  await db.exec(migration(M086));
  const after = await columnAcls();
  check(before === after, 'a second paste leaves the column ACLs byte-identical');
  await assertLocked('(again) ');
}

// ===========================================================================
section('7. drift — 086 on a database where 085 was never pasted');
// ===========================================================================
{
  const db2 = await bootstrap({ with085: false });
  const h2 = helpers(db2);
  const [{ id: u }] = await h2.q(`insert into auth.users (email) values ('c@example.test') returning id`);
  await h2.q(`insert into public.connector_tokens (user_id, token_hash, token_prefix) values ($1,'HASH-C','csp_c')`, [u]);
  await db2.exec(migration(M086));
  await h2.asUser(u);
  const hash = await h2.attempt('select token_hash from public.connector_tokens');
  check(!hash.ok && hash.code === '42501', 'the hash is closed without 085', hash.code);
  const list = await h2.attempt('select id, token_prefix, name, created_at, last_used_at, revoked_at, expires_at from public.connector_tokens');
  check(list.ok && list.rows.length === 1, 'the pre-085 listing still works', list.ok ? '' : list.code);
  const kind = await h2.attempt('select kind from public.connector_tokens');
  check(!kind.ok && kind.code === '42703', 'asking for kind is 42703 (missing), which readUserTokens already retries without', kind.code);
  await h2.asSuperuser();
}

// ===========================================================================
section('8. static — no browser read asks for the hash or a star');
// ===========================================================================
{
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(repo, 'src'));
  const problems = [];
  let reads = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const re = /from\(\s*['"]connector_tokens['"]\s*\)/g;
    let m;
    while ((m = re.exec(text))) {
      // The statement this query is part of: up to the next `;`. For a read
      // routed through readUserTokens this includes the column-list literal.
      const end = text.indexOf(';', m.index);
      const stmt = text.slice(m.index, end === -1 ? undefined : end);
      const rel = path.relative(repo, f);
      const isWrite = /\.(insert|update|upsert|delete)\(/.test(stmt);
      if (/\.select\(\s*\)/.test(stmt)) problems.push(`${rel}: .select() with no columns`);
      if (/\.select\(\s*['"`]\s*\*/.test(stmt)) problems.push(`${rel}: .select('*')`);
      if (isWrite && /\.select\(/.test(stmt)) problems.push(`${rel}: a write chained with .select() (RETURNING)`);
      for (const lit of stmt.matchAll(/['"`]([^'"`]*)['"`]/g)) {
        if (/\btoken_hash\b/.test(lit[1])) problems.push(`${rel}: names token_hash in "${lit[1]}"`);
        if (lit[1].trim() === '*') problems.push(`${rel}: a '*' column list`);
      }
      if (!isWrite) reads += 1;
    }
  }
  check(reads >= 7, 'found the browser reads of connector_tokens', `${reads} read(s)`);
  check(problems.length === 0, 'none asks for `*` or token_hash, and no write asks for a representation', problems.join('; '));
}

console.log(`\n${failures === 0
  ? `086 §1 HOLDS — ${passes} checks: the hash is server-only, and every browser path still works.`
  : `${failures} FAILURE(S) of ${passes + failures}`}\n`);
process.exit(failures === 0 ? 0 : 1);
