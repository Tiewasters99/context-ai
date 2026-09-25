// Migration 088 — an agent can be given "All my matters (except
// SecureSpaces)" — EXECUTED in PGlite with the real migration chain and real
// RLS, and driven through the real consent POST, token endpoint and
// api/mcp.mjs authenticate().
//
// What it proves
// ---------------------------------------------------------------------------
//   SQL   088 applies (twice, converging) on 001…022 + 062 + 063 + 065 + 085
//         + 086 + 087. connector_tokens.scope_all is NOT NULL DEFAULT false,
//         every existing row reads false, and it cannot be true on a user
//         token. The browser (authenticated) can READ it — 086 grants SELECT
//         column by column — and token_hash stays unreadable. The owner can
//         set it on their own agent row, by INSERT and UPDATE, under 003's
//         existing policies; not on another person's row.
//   FUNC  oauth_grant_approve has exactly one signature, the 10-argument
//         one; the 9-argument one is gone; it is service-role only. With
//         p_scope_all it stores scope_all true + matter_scope '{}'; re-consent
//         flips an agent from "all" to a list and back (same agent, same
//         grant); full assistant is unchanged.
//   FLOW  consent "as an agent" with scope_all → the agent row → a code and
//         tokens carrying `agt` → authenticate() returns kind 'agent' with
//         scopeAll true, and callTool gets agentToken.scopeAll + actor
//         'agent:<id>' + the seal. Matter ids sent WITH scope_all are ignored
//         (a sealed id is not an error, and is not stored). Only a literal
//         `true` counts. With 088 unapplied (the RPC misses), an "all"
//         consent is refused 503 and mints no code.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-agent-scope-all.mjs
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
const M088 = '088_agent_scope_all.sql';

let failures = 0;
let passes = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (ok) passes += 1; else failures += 1;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 62 - t.length))}`);

// ---------------------------------------------------------------------------
// Env, set before the handlers are imported (they read it at module load).
// ---------------------------------------------------------------------------
const SB_URL = 'https://stub.supabase.test';
const SERVICE = 'stub-service-role-key';
process.env.VITE_SUPABASE_URL = SB_URL;
process.env.VITE_SUPABASE_ANON_KEY = 'stub-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
process.env.MCP_OAUTH_SECRET = 'harness-oauth-secret-that-is-long-enough-32+';
for (const k of ['OPENAI_API_KEY', 'MCP_SIGNING_KEY_JWK_B64', 'MCP_SIGNING_KEY_ID']) delete process.env[k];

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------
const db = new PGlite({ extensions: { uuid_ossp } });
const q = async (sql, params) => (await db.query(sql, params)).rows;
const attempt = async (sql, params) => {
  try {
    const r = await db.query(sql, params);
    return { ok: true, rows: r.rows, affected: r.affectedRows ?? 0 };
  } catch (e) {
    return { ok: false, code: e?.code ?? '?', message: String(e?.message ?? e).split('\n')[0] };
  }
};
const asUser = async (uid) => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
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

section('the chain: 001…022, 062, 063, 065, 085, 086, 087, then 088 twice');
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
// 051's column, which is all this harness needs of the SecureSpace tier.
await db.exec(`alter table public.matterspaces add column if not exists ai_tier text not null default 'A'`);
await db.exec(migration('062_profiles_rls_plan.sql'));
await db.exec(migration('063_usage_budgets.sql'));
await db.exec(migration('065_oauth_grants.sql'));
await db.exec(migration('085_agent_tokens_and_tasks.sql'));
// Supabase's blanket default — the state 086 exists to undo.
await db.exec(`grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;`);
await db.exec(`
  revoke all on public.oauth_grants from anon, authenticated;
  grant select on public.oauth_grants to authenticated;
  grant update (revoked_at) on public.oauth_grants to authenticated;
`);
await db.exec(migration('086_connector_metering_and_token_lock.sql'));
await db.exec(migration('087_oauth_grant_agent_link.sql'));

// A firm, and rows that exist BEFORE 088 (the additive claim).
const signup = async (email, name) => {
  const [row] = await q(`insert into auth.users (email, raw_user_meta_data)
    values ($1, jsonb_build_object('display_name', $2::text)) returning id`, [email, name]);
  return row.id;
};
const ADA = await signup('ada@example.test', 'Ada');
const BOB = await signup('bob@example.test', 'Bob');
const [s1] = await q(`insert into public.serverspaces (clientspace_id, name)
  select id, 'Firm' from public.clientspaces where user_id = $1 returning id`, [ADA]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner')`, [s1.id, ADA]);
const mk = async (ss, name, parent = null, tier = 'A') => (await q(
  `insert into public.matterspaces (serverspace_id, name, parent_matterspace_id, ai_tier) values ($1,$2,$3,$4) returning id`,
  [ss, name, parent, tier]))[0].id;
const M1 = await mk(s1.id, 'Vashti');
const SEALED = await mk(s1.id, 'Privileged', null, 'B');
const hex = (c) => c.repeat(64);
const [preUser] = await q(`insert into public.connector_tokens (user_id, token_hash, token_prefix, name)
  values ($1, $2, 'csp_pre', 'Claude') returning id`, [ADA, hex('1')]);
const [preAgent] = await q(`insert into public.connector_tokens (user_id, token_hash, token_prefix, name, kind, agent_provider, matter_scope)
  values ($1, $2, 'csp_agt', 'Grok', 'agent', 'grok', array[$3]::uuid[]) returning id`, [ADA, hex('2'), M1]);
const [bobAgent] = await q(`insert into public.connector_tokens (user_id, token_hash, token_prefix, name, kind, agent_provider, matter_scope)
  values ($1, $2, 'csp_bob', 'Bob agent', 'agent', 'other', '{}') returning id`, [BOB, hex('3')]);

const execAttempt = async (sql) => { try { await db.exec(sql); return { err: null }; } catch (err) { return { err }; } };
const aclOf = async () => {
  await asSuperuser();
  return JSON.stringify(await q(`
    select a.attname, a.attacl::text from pg_attribute a
     where a.attrelid = 'public.connector_tokens'::regclass and a.attnum > 0 and not a.attisdropped
     order by a.attnum`));
};
const procs = async () => q(`select oid::regprocedure::text sig from pg_proc
  where proname = 'oauth_grant_approve' and pronamespace = 'public'::regnamespace`);
const r1 = await execAttempt(migration(M088));
const acl1 = await aclOf();
const procs1 = await procs();
const r2 = await execAttempt(migration(M088));
const acl2 = await aclOf();
const procs2 = await procs();
check(!r1.err && !r2.err, '088 applies, and applies again over itself', r1.err?.message || r2.err?.message || '');
check(acl1 === acl2 && JSON.stringify(procs1) === JSON.stringify(procs2),
  'the second run converges: identical column privileges, identical functions');

// ===========================================================================
section('the column');
// ===========================================================================
{
  await asSuperuser();
  const [c] = await q(`select is_nullable, column_default, data_type from information_schema.columns
    where table_schema='public' and table_name='connector_tokens' and column_name='scope_all'`);
  check(c?.data_type === 'boolean' && c.is_nullable === 'NO' && /false/.test(c.column_default || ''),
    'connector_tokens.scope_all: boolean NOT NULL DEFAULT false', JSON.stringify(c));
  const rows = await q(`select id, scope_all from public.connector_tokens where id = any($1::uuid[])`,
    [`{${preUser.id},${preAgent.id},${bobAgent.id}}`]);
  check(rows.length === 3 && rows.every((r) => r.scope_all === false),
    'every row that existed before 088 reads false (a listed agent stays listed)');
  const bad = await attempt(`update public.connector_tokens set scope_all = true where id = $1`, [preUser.id]);
  check(!bad.ok && bad.code === '23514', 'a USER token cannot be scope_all (check constraint)', bad.code);
  const nul = await attempt(`update public.connector_tokens set scope_all = null where id = $1`, [preAgent.id]);
  check(!nul.ok && nul.code === '23502', 'and it can never be null', nul.code);
}

// ===========================================================================
section('the browser: read it, set it on its own agent, not on another\'s');
// ===========================================================================
{
  await asUser(ADA);
  const read = await attempt(`select id, kind, matter_scope, scope_all from public.connector_tokens order by created_at`);
  check(read.ok && read.rows.length === 2, 'authenticated can SELECT scope_all (086\'s column grant now names it); RLS: own rows only',
    read.ok ? `${read.rows.length} row(s)` : read.code);
  const hash = await attempt(`select token_hash from public.connector_tokens`);
  check(!hash.ok && hash.code === '42501', 'token_hash is still refused (086 holds)', hash.code);
  const star = await attempt(`select * from public.connector_tokens`);
  check(!star.ok && star.code === '42501', '`select *` is still refused', star.code);

  const own = await attempt(`update public.connector_tokens set scope_all = true, matter_scope = '{}'
    where id = $1 and kind = 'agent'`, [preAgent.id]);
  check(own.ok && own.affected === 1, 'the owner sets scope_all on their own agent (UPDATE, 1 row)', own.ok ? `${own.affected}` : own.code);
  const back = await attempt(`update public.connector_tokens set scope_all = false, matter_scope = array[$2]::uuid[]
    where id = $1`, [preAgent.id, M1]);
  check(back.ok && back.affected === 1, 'and narrows it back to a list', back.ok ? '' : back.code);
  const other = await attempt(`update public.connector_tokens set scope_all = true, matter_scope = '{}' where id = $1`, [bobAgent.id]);
  check(other.ok && other.affected === 0, 'cannot set it on another person\'s agent (RLS: 0 rows)', other.ok ? `${other.affected}` : other.code);
  const ins = await attempt(`insert into public.connector_tokens (user_id, token_hash, token_prefix, name, kind, agent_provider, matter_scope, scope_all)
    values ($1, $2, 'csp_all', 'Grok all', 'agent', 'grok', '{}', true)`, [ADA, hex('4')]);
  check(ins.ok, 'the owner can INSERT a new agent with scope_all (Connections › Agents › Add)', ins.ok ? '' : ins.code);
  const insOther = await attempt(`insert into public.connector_tokens (user_id, token_hash, token_prefix, name, kind, agent_provider, matter_scope, scope_all)
    values ($1, $2, 'csp_x', 'x', 'agent', 'grok', '{}', true)`, [BOB, hex('5')]);
  check(!insOther.ok && insOther.code === '42501', 'but not one owned by someone else', insOther.code);

  await asUser(BOB);
  const bobSees = await attempt(`select id, scope_all from public.connector_tokens`);
  check(bobSees.ok && bobSees.rows.length === 1 && bobSees.rows[0].scope_all === false,
    'Bob reads only his own row, still false');
  await asSuperuser();
  const [b] = await q(`select scope_all from public.connector_tokens where id = $1`, [bobAgent.id]);
  check(b.scope_all === false, 'Bob\'s agent was never changed by Ada');
}

// ===========================================================================
section('oauth_grant_approve: one signature, service role only');
// ===========================================================================
const NEW_SIG = 'public.oauth_grant_approve(uuid,text,text,text[],text,text,text,uuid[],text,boolean)';
const OLD_SIG = 'public.oauth_grant_approve(uuid,text,text,text[],text,text,text,uuid[],text)';
{
  await asSuperuser();
  const all = await procs();
  check(all.length === 1 && /boolean\)$/.test(all[0].sig), 'exactly one oauth_grant_approve: the 10-argument one', all.map((p) => p.sig).join(' | '));
  const [old] = await q(`select to_regprocedure($1) r`, [OLD_SIG]);
  check(old.r === null, 'the 9-argument signature is gone (dropped explicitly, no overload left behind)');
  const [p] = await q(`select has_function_privilege('authenticated', $1, 'execute') a,
                              has_function_privilege('anon', $1, 'execute') n,
                              has_function_privilege('service_role', $1, 'execute') s`, [NEW_SIG]);
  check(!p.a && !p.n && p.s, 'service role only (anon and authenticated cannot execute it)', JSON.stringify(p));
  await asUser(ADA);
  const call = await attempt(`select * from public.oauth_grant_approve($1, 'client-x', 'X', null, null, 'x', 'grok', '{}'::uuid[], $2, true)`, [ADA, hex('6')]);
  check(!call.ok && call.code === '42501', 'a signed-in customer calling it directly is refused', call.code);
  const [st] = await q(`select pg_get_function_result('public.oauth_grant_link_state(uuid)'::regprocedure) r`).catch(() => [{}]);
  check(/agent_token_id/.test(st?.r || ''), "087's oauth_grant_link_state is untouched");
}

// ===========================================================================
section('oauth_grant_approve: what p_scope_all stores');
// ===========================================================================
{
  await asService();
  const approveSql = (client, scope, all, h) => q(
    `select * from public.oauth_grant_approve($1, $2, 'Grok', null, null, 'Grok', 'grok', $3::uuid[], $4, $5)`,
    [ADA, client, scope, h, all]);
  const [a] = await approveSql('client-all', `{${SEALED}}`, true, hex('7'));
  check(a.outcome === 'created' && !!a.agent_token_id, 'p_scope_all true → a new agent + grant', a.outcome);
  let [row] = await q(`select scope_all, matter_scope, kind from public.connector_tokens where id = $1`, [a.agent_token_id]);
  check(row.scope_all === true && JSON.stringify(row.matter_scope) === '[]' && row.kind === 'agent',
    'stored: scope_all true, matter_scope \'{}\' (ids sent with it are not stored)', JSON.stringify(row));
  const [b] = await approveSql('client-all', `{${M1}}`, false, hex('8'));
  [row] = await q(`select scope_all, matter_scope from public.connector_tokens where id = $1`, [b.agent_token_id]);
  check(b.outcome === 'attached' && b.agent_token_id === a.agent_token_id && b.grant_id === a.grant_id
    && row.scope_all === false && JSON.stringify(row.matter_scope) === JSON.stringify([M1]),
    're-consent with a list: same agent, same grant, scope_all false, the list stored');
  const [c] = await approveSql('client-all', null, true, hex('9'));
  [row] = await q(`select scope_all, matter_scope from public.connector_tokens where id = $1`, [c.agent_token_id]);
  check(c.outcome === 'attached' && c.agent_token_id === a.agent_token_id && row.scope_all === true
    && JSON.stringify(row.matter_scope) === '[]',
    'and back to "all" (p_matter_scope null + p_scope_all true is an agent, not a full assistant)');
  const [full] = await q(`select * from public.oauth_grant_approve($1, 'client-full', 'Claude')`, [ADA]);
  check(full.outcome === 'created' && full.agent_token_id === null, 'full assistant (no agent args) is unchanged: a grant, no agent');
  const [nine] = await q(`select * from public.oauth_grant_approve($1, 'client-list', 'Grok', null, null, 'G', 'grok', $2::uuid[], $3)`,
    [ADA, `{${M1}}`, hex('a')]);
  [row] = await q(`select scope_all from public.connector_tokens where id = $1`, [nine.agent_token_id]);
  check(nine.outcome === 'created' && row.scope_all === false,
    'a call without p_scope_all (the code path for a listed agent) still resolves, and stores false');
}

// ---------------------------------------------------------------------------
// The stub PostgREST + auth server, over the same database
// ---------------------------------------------------------------------------
let mode = 'deployed';   // 'deployed' | 'nine-arg-only'
const SESSIONS = { 'sb-ada': ADA, 'sb-bob': BOB };
const PARAM_CASTS = {
  p_user_id: 'uuid', p_client_id: 'text', p_client_name: 'text', p_scopes: 'text[]', p_notes: 'text',
  p_grant_id: 'uuid', p_agent_name: 'text', p_agent_provider: 'text', p_matter_scope: 'uuid[]', p_token_hash: 'text',
  p_scope_all: 'boolean',
};
const jsonResponse = (status, obj) => new Response(obj === undefined ? '' : JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json' },
});
const bindable = (v) => (Array.isArray(v) ? `{${v.map((s) => `"${String(s)}"`).join(',')}}` : v);
const headerOf = (init, name) => {
  const h = init?.headers;
  if (!h) return '';
  if (typeof h.get === 'function') return h.get(name) || '';
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k ? h[k] : '';
};
const COL = /^[a-z_][a-z0-9_]*$/;
const serverspace = async (bearer, fn) => {
  const tok = String(bearer).replace(/^Bearer\s+/i, '');
  if (tok === SERVICE) await asService();
  else if (SESSIONS[tok]) await asUser(SESSIONS[tok]);
  else return jsonResponse(401, { message: 'bad jwt' });
  try { return await fn(); } finally { await db.exec('reset role').catch(() => {}); }
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (!url.href.startsWith(SB_URL)) throw new Error(`unexpected outbound call to ${url.href}`);
  const bearer = headerOf(init, 'authorization');

  if (url.pathname === '/auth/v1/user') {
    const uid = SESSIONS[String(bearer).replace(/^Bearer\s+/i, '')];
    return uid ? jsonResponse(200, { id: uid, email: 'x@example.test' }) : jsonResponse(401, { message: 'invalid session' });
  }

  const rpcM = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z0-9_]+)$/);
  if (rpcM) {
    const fn = rpcM[1];
    const body = JSON.parse(init.body || '{}');
    const keys = Object.keys(body);
    // PostgREST on a database with 087 but not 088: the function exists with
    // 9 arguments, so a call that names p_scope_all finds no match.
    if (mode === 'nine-arg-only' && fn === 'oauth_grant_approve' && keys.includes('p_scope_all')) {
      return jsonResponse(404, { code: 'PGRST202', message: `Could not find the function public.${fn}(…, p_scope_all) in the schema cache` });
    }
    const args = keys.map((k, i) => `${k} => $${i + 1}::${PARAM_CASTS[k] || 'text'}`).join(', ');
    return serverspace(bearer, async () => {
      try {
        const { rows } = await db.query(`select * from public.${fn}(${args})`, keys.map((k) => bindable(body[k])));
        return jsonResponse(200, rows);
      } catch (err) {
        return jsonResponse(400, { code: err?.code || 'XX000', message: err?.message || String(err) });
      }
    });
  }

  const tblM = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
  if (tblM) {
    const table = tblM[1];
    const where = [];
    const params = [];
    let select = '*';
    for (const [k, v] of url.searchParams) {
      if (k === 'select') { select = v; continue; }
      if (!COL.test(k)) throw new Error(`stub: bad column ${k}`);
      if (v.startsWith('eq.')) { params.push(v.slice(3)); where.push(`${k}::text = $${params.length}`); }
      else if (v.startsWith('in.(')) {
        const list = v.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, ''));
        params.push(`{${list.join(',')}}`); where.push(`${k}::text = any($${params.length}::text[])`);
      } else throw new Error(`stub: unsupported filter ${k}=${v}`);
    }
    const cols = select === '*' ? '*' : select.split(',').map((c) => { if (!COL.test(c)) throw new Error(`stub: bad select ${c}`); return c; }).join(', ');
    const method = (init.method || 'GET').toUpperCase();
    return serverspace(bearer, async () => {
      try {
        if (method === 'GET') {
          const { rows } = await db.query(`select ${cols} from public.${table}${where.length ? ' where ' + where.join(' and ') : ''}`, params);
          return jsonResponse(200, rows);
        }
        if (method === 'PATCH') {
          const patch = JSON.parse(init.body || '{}');
          const sets = Object.keys(patch).map((c, i) => `${c} = $${params.length + i + 1}`);
          await db.query(`update public.${table} set ${sets.join(', ')} where ${where.join(' and ')}`, [...params, ...Object.values(patch)]);
          return new Response(null, { status: 204 });
        }
        throw new Error(`stub: ${method}`);
      } catch (err) {
        return jsonResponse(400, { code: err?.code || 'XX000', message: err?.message || String(err) });
      }
    });
  }
  throw new Error(`unexpected outbound call to ${url.href}`);
};

const { signJwt, verifyJwt, pkceS256 } = await import('../lib/oauth-jwt.mjs');
const { connectorTokenIdentity } = await import('../lib/connector-token-auth.mjs');
const approveHandler = (await import('../api/oauth-approve.mjs')).default;
const tokenHandler = (await import('../api/oauth-token.mjs')).default;
const { authenticate, callToolOptsFor } = await import('../api/mcp.mjs');
const SECRET = process.env.MCP_OAUTH_SECRET;

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(b) { this.body = b ?? null; return this; },
    json() { try { return JSON.parse(this.body || 'null'); } catch { return null; } },
  };
}
const REDIRECT = 'https://grok.com/oauth/callback';
const GROK = signJwt({ typ: 'client', client_name: 'Grok', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'] }, SECRET, 3600);
const VERIFIER = 'v'.repeat(64);
async function approve(extra = {}) {
  const res = mockRes();
  await approveHandler({
    method: 'POST',
    headers: { authorization: 'Bearer sb-ada', host: 'www.contextspaces.ai' },
    body: { client_id: GROK, redirect_uri: REDIRECT, code_challenge: pkceS256(VERIFIER), code_challenge_method: 'S256', state: 's', scope: 'mcp', ...extra },
  }, res);
  return res;
}
const codeOf = (res) => new URL(res.json().redirect).searchParams.get('code');
async function exchange(code) {
  const res = mockRes();
  await tokenHandler({ method: 'POST', headers: { 'content-type': 'application/json', host: 'www.contextspaces.ai' },
    body: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, redirect_uri: REDIRECT, client_id: GROK } }, res);
  return res;
}
const auth = async (bearer) => { try { return await authenticate({ headers: { authorization: `Bearer ${bearer}` } }); } catch (err) { return { err }; } };
const agentRow = async (id) => { await asSuperuser(); return (await q(`select * from public.connector_tokens where id = $1`, [id]))[0]; };

// ===========================================================================
section('consent "as an agent" with All my matters, end to end');
// ===========================================================================
{
  const a = await approve({ connect_as: 'agent', agent: { name: 'Grok everywhere', provider: 'grok', scope_all: true, matter_scope: [SEALED] } });
  check(a.statusCode === 200, 'scope_all with no matter ids (and a sealed id riding along) is approved — ids are ignored', a.body);
  const code = verifyJwt(codeOf(a), SECRET);
  const row = await agentRow(code.agt);
  check(row?.kind === 'agent' && row.scope_all === true && JSON.stringify(row.matter_scope) === '[]' && row.token_prefix === 'oauth',
    'the agent row: kind agent, scope_all true, matter_scope \'{}\' (the sealed id was not stored)');
  const t = await exchange(codeOf(a));
  check(t.statusCode === 200, 'the code exchanges for tokens');
  const id = await auth(t.json().access_token);
  check(id.kind === 'agent' && id.scopeAll === true && id.tokenId === code.agt,
    'authenticate(): kind agent, scopeAll true, the agent\'s own token id', JSON.stringify(id));
  check(JSON.stringify(id) === JSON.stringify(connectorTokenIdentity(row)),
    'the SAME identity path A returns for that row');
  const opts = callToolOptsFor(id, {});
  check(opts.agentToken?.scopeAll === true && opts.agentToken.id === code.agt && opts.actor?.ref === `agent:${code.agt}`
    && opts.sealConnector === true,
    'callTool gets agentToken.scopeAll (task tools, metering bucket) + actor agent:<id> + the seal');

  const narrow = await approve({ connect_as: 'agent', agent: { name: 'Grok everywhere', provider: 'grok', matter_scope: [M1] } });
  const code2 = verifyJwt(codeOf(narrow), SECRET);
  const row2 = await agentRow(code2.agt);
  check(narrow.statusCode === 200 && code2.agt === code.agt && row2.scope_all === false
    && JSON.stringify(row2.matter_scope) === JSON.stringify([M1]),
    're-consent with ticked matters narrows the SAME agent to that list');
  const t2 = await exchange(codeOf(narrow));
  const id2 = await auth(t2.json().access_token);
  check(id2.kind === 'agent' && id2.scopeAll === false && JSON.stringify(id2.matterScope) === JSON.stringify([M1]),
    'and the next request is served as the listed agent');

  const truthy = await approve({ connect_as: 'agent', agent: { name: 'Grok everywhere', scope_all: 'true', matter_scope: [] } });
  const row3 = await agentRow(verifyJwt(codeOf(truthy), SECRET).agt);
  check(truthy.statusCode === 200 && row3.scope_all === false && JSON.stringify(row3.matter_scope) === '[]',
    'only a literal true counts: scope_all "true" (a string) is a listed agent with nothing ticked');

  const sealedList = await approve({ connect_as: 'agent', agent: { name: 'x', matter_scope: [SEALED] } });
  check(sealedList.statusCode === 403 && sealedList.json()?.error === 'sealed_matter',
    'without scope_all, a sealed id is still refused (087 unchanged)');
}

// ===========================================================================
section('088 not applied yet (087 only)');
// ===========================================================================
{
  mode = 'nine-arg-only';
  await asSuperuser();
  const [before] = await q(`select count(*)::int n from public.oauth_grants`);
  const und = await approve({ connect_as: 'agent', agent: { name: 'x', scope_all: true } });
  check(und.statusCode === 503 && und.json()?.error === 'agent_connect_unavailable' && !und.json()?.redirect
    && /All my matters/.test(und.json()?.detail || ''),
    '"All my matters" is refused 503 with its own sentence, and no code is minted', und.json()?.detail);
  await asSuperuser();
  const [after] = await q(`select count(*)::int n from public.oauth_grants`);
  check(after.n === before.n, 'the refused consent wrote nothing', `${before.n} → ${after.n}`);
  const listed = await approve({ connect_as: 'agent', agent: { name: 'x', matter_scope: [M1] } });
  check(listed.statusCode === 200 && !!listed.json()?.redirect, 'a listed-matters agent consent still works (p_scope_all is not sent)');
  const full = await approve({});
  check(full.statusCode === 200 && !!full.json()?.redirect, 'and full assistant still works');
  mode = 'deployed';
}

globalThis.fetch = realFetch;
console.log(`\n${failures === 0
  ? `088 HOLDS — ${passes} checks: "All my matters" is an agent's scope, set only by its owner, never a SecureSpace.`
  : `${failures} FAILURE(S) of ${passes + failures}`}\n`);
process.exit(failures === 0 ? 0 : 1);
