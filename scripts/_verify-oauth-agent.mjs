// Migration 087 — "Connect as an agent" over OAuth — EXECUTED in PGlite with
// the real migration chain and real RLS, and driven end to end through the
// real handlers: /api/oauth-approve (the consent POST), /api/oauth-token
// (code exchange and refresh) and api/mcp.mjs authenticate().
//
// What it proves
// ---------------------------------------------------------------------------
//   SQL   087 applies (twice) on 001…022 + 065 + 085; its functions are
//         service-role only; a customer cannot change a grant's agent link;
//         deleting an agent row cuts the link (ON DELETE SET NULL) and does
//         not widen anything.
//   FLOW  consent "as an agent" → an agent row (kind agent, provider, scope,
//         a token_hash nobody holds) + a grant linked to it → a code, access
//         and refresh token carrying `agt` → authenticate() returns the SAME
//         identity path A returns for that agent's row.
//         A full-assistant consent is unchanged (a user identity).
//         Refresh keeps the link. Edit matters bites on the next request.
//         Revoking the agent → 401 and the refresh is refused. Revoking the
//         grant → 401 on the very next request (no cache for agents).
//         Switching modes on re-consent mints a new grant, so a token from
//         one mode never serves the other.
//   GUARD the consent POST is refused (and writes nothing) for a sealed
//         matter, a matter under a sealed one, a matter the user cannot
//         open, and a malformed id. With 087 unapplied, "as an agent" is
//         refused and "full assistant" still works.
//   FAIL  an `agt` token fails CLOSED when grant state is unreadable; a
//         full-access token keeps 065's fail-open. A bare (unwrapped) agent
//         JWT is still the agent, never the user.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-oauth-agent.mjs
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
  try { return { rows: (await db.query(sql, params)).rows, err: null }; } catch (err) { return { rows: null, err }; }
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

section('the chain: 001…022, 065, 085, then 087 twice');
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
// 051's column, which is all this harness needs of the SecureSpace tier.
await db.exec(`alter table public.matterspaces add column if not exists ai_tier text not null default 'A'`);
await db.exec(migration('065_oauth_grants.sql'));
await db.exec(migration('085_agent_tokens_and_tasks.sql'));
await db.exec(`grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;`);
// 065 narrows oauth_grants' privileges; re-assert them after the blanket grant
// above, the way the real database has them.
await db.exec(`
  revoke all on public.oauth_grants from anon, authenticated;
  grant select on public.oauth_grants to authenticated;
  grant update (revoked_at) on public.oauth_grants to authenticated;
`);
const execAttempt = async (sql) => { try { await db.exec(sql); return { err: null }; } catch (err) { return { err }; } };
const r087a = await execAttempt(migration('087_oauth_grant_agent_link.sql'));
const r087b = await execAttempt(migration('087_oauth_grant_agent_link.sql'));
check(!r087a.err && !r087b.err, '087 applies, and applies again over itself', r087a.err?.message || r087b.err?.message || '');

// A firm.
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
const M1_CHILD = await mk(s1.id, 'Vashti › Appeal', M1);
const M3 = await mk(s1.id, 'Brannock');
const SEALED = await mk(s1.id, 'Privileged', null, 'B');
const SEALED_CHILD = await mk(s1.id, 'Privileged › Notes', SEALED);   // tier A, inherits the seal
const [sb] = await q(`insert into public.serverspaces (clientspace_id, name)
  select id, 'Bob firm' from public.clientspaces where user_id = $1 returning id`, [BOB]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner')`, [sb.id, BOB]);
const BOB_MATTER = await mk(sb.id, 'Bob only');

{
  const cols = await q(`select column_name, is_nullable from information_schema.columns
    where table_schema='public' and table_name='oauth_grants' and column_name='agent_token_id'`);
  check(cols.length === 1 && cols[0].is_nullable === 'YES', 'oauth_grants.agent_token_id exists, nullable');
  const fk = await q(`select confdeltype from pg_constraint
    where conrelid='public.oauth_grants'::regclass and contype='f'
      and confrelid='public.connector_tokens'::regclass`);
  check(fk.length === 1 && fk[0].confdeltype === 'n', 'it references connector_tokens(id) ON DELETE SET NULL');
  const idx = await q(`select 1 from pg_indexes where tablename='oauth_grants' and indexname='idx_oauth_grants_agent_token'`);
  check(idx.length === 1, 'and is indexed');
  const nulls = await q(`select count(*)::int n from public.oauth_grants where agent_token_id is not null`);
  check(nulls[0].n === 0, 'no existing grant is linked (additive)');
  for (const f of ['oauth_grant_approve(uuid,text,text,text[],text,text,text,uuid[],text)', 'oauth_grant_link_state(uuid)']) {
    const [p] = await q(`select has_function_privilege('authenticated', 'public.${f}', 'execute') a,
                                has_function_privilege('anon', 'public.${f}', 'execute') n,
                                has_function_privilege('service_role', 'public.${f}', 'execute') s`);
    check(!p.a && !p.n && p.s, `${f.split('(')[0]}: service role only`);
  }
  const [st] = await q(`select pg_get_function_result('public.oauth_grant_state(uuid)'::regprocedure) r`);
  check(!/agent_token_id/.test(st.r), "065's oauth_grant_state keeps its exact signature (deployed code unaffected)");
}

// ---------------------------------------------------------------------------
// The stub PostgREST + auth server, over the same database
// ---------------------------------------------------------------------------
let mode = 'deployed';   // 'deployed' | 'undeployed' | 'server-error'
const SESSIONS = { 'sb-ada': ADA, 'sb-bob': BOB };
const PARAM_CASTS = {
  p_user_id: 'uuid', p_client_id: 'text', p_client_name: 'text', p_scopes: 'text[]', p_notes: 'text',
  p_grant_id: 'uuid', p_agent_name: 'text', p_agent_provider: 'text', p_matter_scope: 'uuid[]', p_token_hash: 'text',
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
    if (mode === 'undeployed') return jsonResponse(404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` });
    if (mode === 'server-error') return jsonResponse(500, { message: 'upstream connect error' });
    const body = JSON.parse(init.body || '{}');
    const keys = Object.keys(body);
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
    if (mode === 'server-error') return jsonResponse(500, { message: 'upstream connect error' });
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
const grants = await import('../lib/oauth-grants.mjs');
const { connectorTokenIdentity } = await import('../lib/connector-token-auth.mjs');
const approveHandler = (await import('../api/oauth-approve.mjs')).default;
const tokenHandler = (await import('../api/oauth-token.mjs')).default;
const { authenticate, callToolOptsFor } = await import('../api/mcp.mjs');
const SECRET = process.env.MCP_OAUTH_SECRET;
const settle = () => new Promise((r) => setTimeout(r, 20));

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(b) { this.body = b ?? null; return this; },
    json() { try { return JSON.parse(this.body || 'null'); } catch { return null; } },
  };
}
const registerClient = (name, redirect) => signJwt(
  { typ: 'client', client_name: name, redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'] }, SECRET, 3600);
const REDIRECT = 'https://grok.com/oauth/callback';
const GROK = registerClient('Grok', REDIRECT);
const VERIFIER = 'v'.repeat(64);

async function approve(extra = {}, session = 'sb-ada', client = GROK) {
  const res = mockRes();
  await approveHandler({
    method: 'POST',
    headers: { authorization: `Bearer ${session}`, host: 'www.contextspaces.ai' },
    body: { client_id: client, redirect_uri: REDIRECT, code_challenge: pkceS256(VERIFIER), code_challenge_method: 'S256', state: 's', scope: 'mcp', ...extra },
  }, res);
  return res;
}
const codeOf = (res) => new URL(res.json().redirect).searchParams.get('code');
async function exchange(code, client = GROK) {
  const res = mockRes();
  await tokenHandler({ method: 'POST', headers: { 'content-type': 'application/json', host: 'www.contextspaces.ai' },
    body: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, redirect_uri: REDIRECT, client_id: client } }, res);
  return res;
}
async function refresh(refresh_token, client = GROK) {
  const res = mockRes();
  await tokenHandler({ method: 'POST', headers: { 'content-type': 'application/json', host: 'www.contextspaces.ai' },
    body: { grant_type: 'refresh_token', refresh_token, client_id: client } }, res);
  return res;
}
const inner = (access) => Buffer.from(String(access).slice(5), 'base64url').toString('utf8');
const payloadOf = (access) => verifyJwt(inner(access), SECRET);
const auth = async (bearer) => { try { return await authenticate({ headers: { authorization: `Bearer ${bearer}` } }); } catch (err) { return { err }; } };
const connect = async (extra) => {
  const a = await approve(extra);
  if (a.statusCode !== 200) return { approve: a };
  const t = await exchange(codeOf(a));
  return { approve: a, token: t, access: t.json()?.access_token, refresh: t.json()?.refresh_token };
};
const counts = async () => {
  await asSuperuser();
  const [r] = await q(`select (select count(*)::int from public.oauth_grants) g, (select count(*)::int from public.connector_tokens) t`);
  return r;
};

// ===========================================================================
section('full assistant — today\'s behaviour, unchanged');
// ===========================================================================
let fullAccess;
{
  const c = await connect({});
  check(c.approve.statusCode === 200, 'consent with no choice made = full assistant: approved');
  const code = verifyJwt(codeOf(c.approve), SECRET);
  check(!!code.gid && !('agt' in code), 'its code carries a grant id and no agent', JSON.stringify({ gid: !!code.gid, agt: code.agt }));
  const p = payloadOf(c.access);
  check(!!p.gid && !('agt' in p), 'its access token likewise');
  const id = await auth(c.access);
  check(id.kind === 'user' && id.userId === ADA && !id.tokenId, 'an unlinked grant authenticates as the user, exactly as before');
  const opts = callToolOptsFor(id, {});
  check(!('agentToken' in opts) && !('actor' in opts) && opts.sealConnector === true, 'and gets the plain connector options (seal only)');
  fullAccess = c.access;
  const again = await approve({ connect_as: 'assistant' });
  const code2 = verifyJwt(codeOf(again), SECRET);
  check(code2.gid === code.gid, 're-approving as full assistant attaches to the same grant (065)');
}

// ===========================================================================
section('connect as an agent');
// ===========================================================================
let agentConn, agentId, agentGid;
{
  const c = await connect({ connect_as: 'agent', agent: { name: 'Grok Bot', provider: 'grok', matter_scope: [M1] } });
  check(c.approve.statusCode === 200, 'consent as an agent with [Vashti]: approved', c.approve.body);
  const code = verifyJwt(codeOf(c.approve), SECRET);
  check(!!code.gid && !!code.agt, 'its code carries the grant id AND the agent id');
  await asSuperuser();
  const [row] = await q(`select * from public.connector_tokens where id = $1`, [code.agt]);
  check(row?.kind === 'agent' && row.agent_provider === 'grok' && row.name === 'Grok Bot' && row.user_id === ADA,
    'an agent row exists: kind agent, provider grok, the name given, owned by the user');
  check(JSON.stringify(row?.matter_scope) === JSON.stringify([M1]), 'its matter_scope is exactly what was ticked');
  check(/^[0-9a-f]{64}$/.test(row?.token_hash || '') && row.token_prefix === 'oauth',
    'token_hash is a 64-hex hash nobody holds the secret for; prefix "oauth"');
  const [g] = await q(`select * from public.oauth_grants where id = $1`, [code.gid]);
  check(g?.agent_token_id === code.agt && !g.revoked_at, 'the grant is linked to the agent');
  const [old] = await q(`select revoked_at from public.oauth_grants where user_id=$1 and agent_token_id is null order by created_at limit 1`, [ADA]);
  check(!!old?.revoked_at, 'switching Grok from full assistant to agent revoked the full-access grant (a new mode is a new grant)');
  check(c.token.statusCode === 200, 'the code exchanges for tokens');
  const p = payloadOf(c.access);
  const rp = verifyJwt(c.refresh, SECRET);
  check(p.agt === code.agt && p.gid === code.gid && rp.agt === code.agt && rp.gid === code.gid,
    'access and refresh tokens both carry gid + agt');
  agentConn = c; agentId = code.agt; agentGid = code.gid;

  grants._resetGrantCache();
  const oldFull = await auth(fullAccess);
  check(oldFull.err?.status === 401, 'the earlier full-access token is now refused (its grant was replaced)');

  const id = await auth(c.access);
  const pathA = connectorTokenIdentity(row);
  check(JSON.stringify(id) === JSON.stringify(pathA),
    'authenticate() returns the SAME identity path A returns for that agent row', JSON.stringify(id));
  check(id.kind === 'agent' && id.tokenId === agentId && JSON.stringify(id.matterScope) === JSON.stringify([M1]),
    'kind agent, the agent\'s token id, its matter scope');
  const opts = callToolOptsFor(id, {});
  check(opts.agentToken?.id === agentId && JSON.stringify(opts.agentToken.matterScope) === JSON.stringify([M1])
    && opts.actor?.ref === `agent:${agentId}` && opts.sealConnector === true,
    'so callTool gets agentToken (scope enforcement, task tools, metering) + actor agent:<id> + the seal');
  const bare = await auth(inner(c.access));
  check(bare.kind === 'agent' && bare.tokenId === agentId,
    'the same token with its cspa_ envelope removed (path C) is still the agent, never the user');
  await settle();
  await asSuperuser();
  const [used] = await q(`select last_used_at from public.connector_tokens where id=$1`, [agentId]);
  check(!!used?.last_used_at, 'the agent\'s last_used_at is stamped (Connections › Agents shows it)');
}

// ===========================================================================
section('Edit matters, refresh, re-consent');
// ===========================================================================
{
  await asUser(ADA);
  await q(`update public.connector_tokens set matter_scope = $1 where id = $2`, [`{${M3}}`, agentId]);
  const id = await auth(agentConn.access);
  check(JSON.stringify(id.matterScope) === JSON.stringify([M3]), 'Edit matters in Connections › Agents bites on the next request');

  const r = await refresh(agentConn.refresh);
  check(r.statusCode === 200, 'refresh succeeds');
  const p = payloadOf(r.json().access_token);
  check(p.agt === agentId && p.gid === agentGid, 'refresh keeps the link (same gid, same agt)');
  const id2 = await auth(r.json().access_token);
  check(id2.kind === 'agent' && id2.tokenId === agentId, 'the refreshed token is the same agent');

  const before = await counts();
  const again = await approve({ connect_as: 'agent', agent: { name: 'Grok Bot (discovery)', provider: 'grok', matter_scope: [M1, M1_CHILD] } });
  const code = verifyJwt(codeOf(again), SECRET);
  const after = await counts();
  check(code.gid === agentGid && code.agt === agentId && after.g === before.g && after.t === before.t,
    're-consenting as an agent while connected as one attaches: same grant, same agent, nothing new minted');
  await asSuperuser();
  const [row] = await q(`select name, matter_scope from public.connector_tokens where id=$1`, [agentId]);
  check(row.name === 'Grok Bot (discovery)' && row.matter_scope.length === 2, 'and updates its name and matters to what was just ticked');
}

// ===========================================================================
section('revoking either end cuts the connection off');
// ===========================================================================
{
  await asUser(ADA);
  await q(`update public.connector_tokens set revoked_at = now() where id = $1`, [agentId]);
  const id = await auth(agentConn.access);
  check(id.err?.status === 401 && id.err.code === 'invalid_token', 'agent revoked in Connections › Agents → 401 invalid_token on the next request');
  const r = await refresh(agentConn.refresh);
  check(r.statusCode === 400 && r.json()?.error === 'invalid_grant', 'and its refresh is refused (invalid_grant)', r.body);

  const c = await connect({ connect_as: 'agent', agent: { name: 'Grok Bot 2', provider: 'grok', matter_scope: [M1] } });
  const code = verifyJwt(codeOf(c.approve), SECRET);
  check(code.agt && code.agt !== agentId && code.gid !== agentGid,
    're-consenting after the agent was revoked makes a new agent and a new grant');
  const ok = await auth(c.access);
  check(ok.kind === 'agent' && ok.tokenId === code.agt, 'which works');
  await asUser(ADA);
  await q(`update public.oauth_grants set revoked_at = now() where id = $1`, [code.gid]);
  const cut = await auth(c.access);
  check(cut.err?.status === 401, 'revoking the grant (Approved AI clients) → 401 on the very next request, no cache window for agents');
  agentConn = c; agentId = code.agt; agentGid = code.gid;
}

// ===========================================================================
section('the grant row: a customer cannot move the link');
// ===========================================================================
{
  const c = await connect({ connect_as: 'agent', agent: { name: 'Grok Bot 3', matter_scope: [M1] } });
  const code = verifyJwt(codeOf(c.approve), SECRET);
  await asUser(ADA);
  const r1 = await attempt(`update public.oauth_grants set agent_token_id = null where id = $1`, [code.gid]);
  check(!!r1.err, 'setting agent_token_id directly is refused (no column privilege)', r1.err?.code);
  await asSuperuser();
  await db.exec(`grant update on public.oauth_grants to authenticated`);   // the blanket grant 065 warns about
  await asUser(ADA);
  const r2 = await attempt(`update public.oauth_grants set agent_token_id = null, revoked_at = null where id = $1`, [code.gid]);
  await asSuperuser();
  const [g] = await q(`select agent_token_id, revoked_at from public.oauth_grants where id=$1`, [code.gid]);
  check(!!r2.err && g.agent_token_id === code.agt, 'even with a blanket UPDATE grant, the guard keeps the link (and refuses a non-revoking update)', r2.err?.code);
  await asUser(ADA);
  await q(`update public.oauth_grants set revoked_at = now(), agent_token_id = null where id = $1`, [code.gid]);
  await asSuperuser();
  const [g2] = await q(`select agent_token_id, revoked_at from public.oauth_grants where id=$1`, [code.gid]);
  check(!!g2.revoked_at && g2.agent_token_id === code.agt, 'a revocation that also tries to null the link: revoked, link frozen');
  await db.exec(`revoke update on public.oauth_grants from authenticated; grant update (revoked_at) on public.oauth_grants to authenticated;`);

  // Deleting the agent row (the UI never does; 003's policy allows it).
  const d = await connect({ connect_as: 'agent', agent: { name: 'Grok Bot 4', matter_scope: [M1] } });
  const dc = verifyJwt(codeOf(d.approve), SECRET);
  await asUser(ADA);
  const del = await attempt(`delete from public.connector_tokens where id = $1`, [dc.agt]);
  await asSuperuser();
  const [g3] = await q(`select agent_token_id, revoked_at from public.oauth_grants where id=$1`, [dc.gid]);
  check(!del.err && g3.agent_token_id === null, 'deleting the agent row sets the grant\'s link to null (ON DELETE SET NULL)', del.err?.message);
  grants._resetGrantCache();
  const after = await auth(d.access);
  check(after.err?.status === 401, 'and its tokens are refused — the grant did NOT become a full-access one');
  const rr = await refresh(d.refresh);
  check(rr.statusCode === 400, 'its refresh is refused too');
}

// ===========================================================================
section('the consent POST is validated server-side');
// ===========================================================================
{
  const before = await counts();
  const cases = [
    [[SEALED], 403, 'sealed_matter', 'a sealed matter'],
    [[M1, SEALED_CHILD], 403, 'sealed_matter', 'a matter under a sealed one (inherited seal)'],
    [[BOB_MATTER], 403, 'matter_not_accessible', 'a matter the user cannot open'],
    [['00000000-0000-4000-8000-000000000000'], 403, 'matter_not_accessible', 'a matter that does not exist'],
    [['not-a-uuid'], 400, 'invalid_scope', 'something that is not a matter id'],
  ];
  for (const [ids, status, code, label] of cases) {
    const r = await approve({ connect_as: 'agent', agent: { name: 'x', matter_scope: ids } });
    check(r.statusCode === status && r.json()?.error === code && !r.json()?.redirect,
      `refused: ${label}`, `${r.statusCode} ${r.json()?.error}`);
  }
  const bobOwn = await approve({ connect_as: 'agent', agent: { name: 'Bob bot', matter_scope: [BOB_MATTER] } }, 'sb-bob');
  check(bobOwn.statusCode === 200, 'the same matter is fine for the person who can open it');
  const after = await counts();
  check(after.g === before.g + 1 && after.t === before.t + 1, 'the refused consents wrote nothing (only Bob\'s own went through)');

  const empty = await connect({ connect_as: 'agent', agent: { name: 'Grok idle', matter_scope: [] } });
  const id = await auth(empty.access);
  check(id.kind === 'agent' && Array.isArray(id.matterScope) && id.matterScope.length === 0,
    'nothing ticked = an agent that sees nothing (scope {})');
  const nm = await connect({ connect_as: 'agent', agent: { matter_scope: [M1] } });
  const nid = await auth(nm.access);
  check(nid.name === 'Grok' && nid.provider === 'grok', 'no name / provider given: the client name, and the provider guessed from it');
}

// ===========================================================================
section('failure direction');
// ===========================================================================
{
  const c = await connect({ connect_as: 'agent', agent: { name: 'Grok live', matter_scope: [M1] } });
  const full = await connect({ connect_as: 'assistant' });   // replaces the agent grant with a full one
  const fullOk = await auth(full.access);
  check(fullOk.kind === 'user', 'switching back to full assistant works (and is a user identity)');
  await asSuperuser();
  const [prev] = await q(`select revoked_at from public.connector_tokens where id=$1`, [verifyJwt(codeOf(c.approve), SECRET).agt]);
  check(!!prev.revoked_at, 'and the agent it replaced is revoked, not left orphaned in Connections › Agents');

  const a = await connect({ connect_as: 'agent', agent: { name: 'Grok live 2', matter_scope: [M1] } });
  grants._resetGrantCache();
  mode = 'server-error';
  const blip = await auth(a.access);
  check(blip.err?.status === 401, 'an agent token while grant state is unreadable → 401 (fails CLOSED, never the user)');
  mode = 'deployed';
  const b = await connect({ connect_as: 'assistant' });
  grants._resetGrantCache();
  mode = 'server-error';
  const fblip = await auth(b.access);
  mode = 'deployed';
  check(fblip.kind === 'user', 'a full-access token in the same blip keeps 065\'s fail-open (availability)');

  mode = 'undeployed';
  const und = await approve({ connect_as: 'agent', agent: { name: 'x', matter_scope: [M1] } });
  check(und.statusCode === 503 && und.json()?.error === 'agent_connect_unavailable' && !und.json()?.redirect,
    '087 not applied: "as an agent" is refused (503) and no code is minted', und.body);
  const undFull = await approve({});
  check(undFull.statusCode === 200 && !!undFull.json()?.redirect, '087 not applied: full assistant still approves, as before');
  mode = 'deployed';
}

globalThis.fetch = realFetch;
console.log(`\n${failures === 0
  ? `OAUTH AGENT HOLDS — ${passes} checks: an OAuth sign-in can be an agent, and only ever that agent.`
  : `${failures} FAILURE(S) of ${passes + failures}`}\n`);
process.exit(failures === 0 ? 0 : 1);
