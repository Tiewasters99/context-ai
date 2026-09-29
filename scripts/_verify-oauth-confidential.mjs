// The CONFIDENTIAL OAuth client — a Custom GPT's Actions (docs/specs/
// GPT-ACTIONS-2026-09-29.md §2) — driven end to end through the real handlers
// in PGlite: /api/oauth-approve (consent), /api/oauth-token (code exchange and
// refresh) and the bearer check now in lib/oauth-bearer.mjs (moved out of
// api/mcp.mjs the same day; api/mcp.mjs re-exports it).
//
// What it proves
// ---------------------------------------------------------------------------
//   MOVE   api/mcp.mjs and lib/oauth-bearer.mjs expose the SAME authenticate,
//          callToolOptsFor and AuthError; mcp.mjs keeps no copy of its own.
//   CLIENT a confidential client_id is a signed client JWT with confidential
//          + secret_hash; the secret is in it nowhere; dynamic registration
//          cannot mint one.
//   PUBLIC the PKCE client is unchanged: no challenge → refused at consent;
//          no verifier → refused at the token endpoint; a stray secret is not
//          a verifier; refresh needs no secret.
//   GPT    consent with no code_challenge → a code with no challenge key; the
//          code exchange needs the secret (body or HTTP Basic) and refuses a
//          missing/wrong secret with 401 invalid_client; another client cannot
//          redeem the code; authenticate serves the token as the user with the
//          grant; refresh needs the secret every time; revoking the grant in
//          Connections ends it.
//   GUARD  a confidential client that sent a challenge is still held to the
//          verifier — the secret never lets a challenge be dropped.
//   SCRIPT scripts/register-oauth-client.mjs mints a matching pair; with --out
//          the secret goes to the file and never to stdout.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-oauth-confidential.mjs
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

section('the chain: 001…022, 065, 085, 087 (the same database the agent harness builds)');
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
const { authenticate } = await import('../api/mcp.mjs');
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
// The confidential client (docs/specs/GPT-ACTIONS-2026-09-29.md §2)
// ===========================================================================
const clients = await import('../lib/oauth-clients.mjs');
const bearerLib = await import('../lib/oauth-bearer.mjs');
const mcpMod = await import('../api/mcp.mjs');
const GPT_REDIRECT = 'https://chat.openai.com/aip/g-harness/oauth/callback';
const minted = clients.mintConfidentialClient({ client_name: 'Contextspaces GPT', redirect_uris: [GPT_REDIRECT, 'https://chatgpt.com/aip/g-harness/oauth/callback'] }, SECRET);
const GPT = minted.client_id;
const GPT_SECRET = minted.client_secret;
const basic = (id, secret) => 'Basic ' + Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`, 'utf8').toString('base64');

// A consent POST for any client, with exactly the fields given (no PKCE unless asked).
async function approveAs(client, redirect, fields = {}, session = 'sb-ada') {
  const res = mockRes();
  await approveHandler({
    method: 'POST',
    headers: { authorization: `Bearer ${session}`, host: 'www.contextspaces.ai' },
    body: { client_id: client, redirect_uri: redirect, state: 's', scope: 'contextspaces', ...fields },
  }, res);
  return res;
}
// A token POST as a GPT would send it: form-encoded body, optional Basic header.
async function tokenPost(body, headers = {}) {
  const res = mockRes();
  await tokenHandler({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', host: 'www.contextspaces.ai', ...headers },
    body: new URLSearchParams(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))).toString(),
  }, res);
  return res;
}
const codePayloadOf = (code) => verifyJwt(code, SECRET);
const { createHash } = await import('node:crypto');
const GPT_HASH = createHash('sha256').update(GPT).digest('hex');   // oauth_grants stores client_id_hash, never the JWT

section('A. the moved bearer check is one function, wherever it is imported from');
{
  check(mcpMod.authenticate === bearerLib.authenticate && mcpMod.callToolOptsFor === bearerLib.callToolOptsFor,
    'api/mcp.mjs re-exports lib/oauth-bearer.mjs authenticate/callToolOptsFor (the same functions)');
  check(mcpMod.AuthError === bearerLib.AuthError, 'and the same AuthError class (instanceof in the handler still holds)');
  check(bearerLib.resolveBearer === bearerLib.authenticate, 'resolveBearer is the spec name for it');
  const mcpSrc = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'mcp.mjs'), 'utf8');
  check(!/async function authenticate\(/.test(mcpSrc) && !/class AuthError/.test(mcpSrc) && !/function adminClient\(/.test(mcpSrc),
    'api/mcp.mjs no longer carries its own copy of any of it');
  check(/jobClient: adminClient\(\)/.test(mcpSrc), 'move_document still gets the service-role jobClient');
}

section('B. what a confidential client is');
{
  const payload = verifyJwt(GPT, SECRET);
  check(payload?.typ === 'client' && payload.confidential === true && typeof payload.secret_hash === 'string' && payload.secret_hash.length === 64,
    'client_id is a signed client JWT with confidential:true and a sha256 secret_hash');
  check(!GPT.includes(GPT_SECRET.slice(6)) && !JSON.stringify(payload).includes(GPT_SECRET),
    'the secret itself is nowhere in the client_id');
  check(payload.token_endpoint_auth_method === 'client_secret_post' && payload.redirect_uris.length === 2,
    'auth method client_secret_post; both ChatGPT callback hosts registered');
  check(clients.isConfidentialClient(payload) && !clients.isConfidentialClient(verifyJwt(GROK, SECRET)),
    'isConfidentialClient: the GPT yes, the public PKCE client no');
  check(clients.clientSecretMatches(payload, GPT_SECRET) && !clients.clientSecretMatches(payload, GPT_SECRET + 'x') && !clients.clientSecretMatches(payload, ''),
    'clientSecretMatches: the secret, and nothing else');
  check(clients.presentedClientSecret({ client_secret: 's1' }, {}) === 's1'
    && clients.presentedClientSecret({}, { authorization: basic('id', 'p@ss:word') }) === 'p@ss:word'
    && clients.presentedClientSecret({}, {}) === null,
    'presentedClientSecret reads the body, then Basic (url-decoded), else null');
  let threw = null;
  try { clients.mintConfidentialClient({ client_name: 'x', redirect_uris: ['http://insecure.example/cb'] }, SECRET); } catch (e) { threw = e; }
  check(!!threw, 'a non-https redirect_uri is refused at mint time');
  // Two mints never share a secret or an id.
  const again = clients.mintConfidentialClient({ client_name: 'Contextspaces GPT', redirect_uris: [GPT_REDIRECT] }, SECRET);
  check(again.client_secret !== GPT_SECRET && again.client_id !== GPT, 'every mint is fresh');
}

section('C. the public PKCE client is exactly as it was');
{
  const noChallenge = await approveAs(GROK, REDIRECT, {});
  check(noChallenge.statusCode === 400 && noChallenge.json()?.error === 'invalid_request' && !noChallenge.json()?.redirect,
    'a public client with no code_challenge is refused at consent', noChallenge.body);
  const ok = await approveAs(GROK, REDIRECT, { code_challenge: pkceS256(VERIFIER), code_challenge_method: 'S256' });
  check(ok.statusCode === 200 && !!codeOf(ok), 'with PKCE it is approved');
  const noVerifier = await tokenPost({ grant_type: 'authorization_code', code: codeOf(ok), redirect_uri: REDIRECT, client_id: GROK });
  check(noVerifier.statusCode === 400 && noVerifier.json()?.error === 'invalid_request',
    'its code exchange without code_verifier is refused (invalid_request)', noVerifier.body);
  const withSecretNoVerifier = await tokenPost({ grant_type: 'authorization_code', code: codeOf(ok), redirect_uri: REDIRECT, client_id: GROK, client_secret: 'whatever' });
  check(withSecretNoVerifier.statusCode === 400, 'a stray client_secret does not stand in for PKCE on a public client');
  const good = await tokenPost({ grant_type: 'authorization_code', code: codeOf(ok), redirect_uri: REDIRECT, client_id: GROK, code_verifier: VERIFIER });
  check(good.statusCode === 200 && String(good.json()?.access_token).startsWith('cspa_'), 'with the verifier: tokens', good.body);
  const r = await tokenPost({ grant_type: 'refresh_token', refresh_token: good.json().refresh_token, client_id: GROK });
  check(r.statusCode === 200 && !!r.json()?.access_token, 'and its refresh needs no secret');
  const who = await auth(good.json().access_token);
  check(who.userId === ADA && who.kind === 'user' && !!who.grantId, 'authenticate (from the lib) serves the token as Ada');
}

section('D. consent for a confidential client — no PKCE');
let gptCode, gptTokens;
{
  const a = await approveAs(GPT, GPT_REDIRECT, {});
  check(a.statusCode === 200 && !!codeOf(a), 'approved with no code_challenge at all', a.body);
  gptCode = codeOf(a);
  const p = codePayloadOf(gptCode);
  check(p?.typ === 'code' && p.sub === ADA && p.client_id === GPT && p.redirect_uri === GPT_REDIRECT && !!p.gid,
    'the code binds user, client, redirect and the recorded grant');
  check(!('code_challenge' in p), "and carries no code_challenge key (omitted, not '')");
  const wrongRedirect = await approveAs(GPT, 'https://evil.example/aip/g-harness/oauth/callback', {});
  check(wrongRedirect.statusCode === 400 && wrongRedirect.json()?.error === 'invalid_redirect_uri', 'an unregistered redirect_uri is still refused');
  const other = await approveAs(GPT, 'https://chatgpt.com/aip/g-harness/oauth/callback', {});
  check(other.statusCode === 200, 'the chatgpt.com twin callback is accepted');
  await asSuperuser();
  const [g] = await q(`select count(*)::int n from public.oauth_grants where user_id=$1 and client_id_hash=$2 and revoked_at is null`, [ADA, GPT_HASH]);
  check(g.n === 1, 'one grant row for the GPT (re-consent attaches, never duplicates)');
}

section('E. the code exchange: the secret in place of the verifier');
{
  const missing = await tokenPost({ grant_type: 'authorization_code', code: gptCode, redirect_uri: GPT_REDIRECT, client_id: GPT });
  check(missing.statusCode === 401 && missing.json()?.error === 'invalid_client' && /basic/i.test(missing.headers['www-authenticate'] || ''),
    'no secret → 401 invalid_client with a WWW-Authenticate challenge', missing.body);
  const wrong = await tokenPost({ grant_type: 'authorization_code', code: gptCode, redirect_uri: GPT_REDIRECT, client_id: GPT, client_secret: GPT_SECRET + 'x' });
  check(wrong.statusCode === 401 && wrong.json()?.error === 'invalid_client', 'wrong secret → 401 invalid_client');
  const verifierOnly = await tokenPost({ grant_type: 'authorization_code', code: gptCode, redirect_uri: GPT_REDIRECT, client_id: GPT, code_verifier: VERIFIER });
  check(verifierOnly.statusCode === 401, 'a verifier does not stand in for the secret');
  const asGrok = await tokenPost({ grant_type: 'authorization_code', code: gptCode, redirect_uri: GPT_REDIRECT, client_id: GROK, code_verifier: VERIFIER });
  check(asGrok.statusCode === 400 && asGrok.json()?.error === 'invalid_grant', "another client cannot redeem the GPT's code");
  // The real thing: form body, client_id + client_secret + code + redirect_uri (the fields OpenAI documents).
  const ok = await tokenPost({ grant_type: 'authorization_code', code: gptCode, redirect_uri: GPT_REDIRECT, client_id: GPT, client_secret: GPT_SECRET });
  check(ok.statusCode === 200 && String(ok.json()?.access_token).startsWith('cspa_') && !!ok.json()?.refresh_token && ok.json()?.token_type === 'Bearer',
    'client_secret in the POST body (client_secret_post) → tokens', ok.body);
  gptTokens = ok.json();
  const p = payloadOf(gptTokens.access_token);
  check(p?.typ === 'access' && p.sub === ADA && p.client_id === GPT && !!p.gid && p.scope === 'contextspaces',
    'the access token names Ada, the GPT client and the grant');
  const who = await auth(gptTokens.access_token);
  check(who.userId === ADA && who.kind === 'user' && who.grantId === p.gid, 'authenticate serves it as Ada, with the grant as task identity');
  // client_secret_basic: id and secret in the header, nothing in the body but grant, code, redirect.
  const a2 = await approveAs(GPT, GPT_REDIRECT, {});
  const viaBasic = await tokenPost({ grant_type: 'authorization_code', code: codeOf(a2), redirect_uri: GPT_REDIRECT }, { authorization: basic(GPT, GPT_SECRET) });
  check(viaBasic.statusCode === 200 && !!viaBasic.json()?.access_token, 'client_secret_basic (HTTP Basic, no client_id in the body) → tokens', viaBasic.body);
  const badBasic = await tokenPost({ grant_type: 'authorization_code', code: codeOf(a2), redirect_uri: GPT_REDIRECT }, { authorization: basic(GPT, 'nope') });
  check(badBasic.statusCode === 401, 'a wrong Basic secret is refused');
  const garbage = await tokenPost({ grant_type: 'authorization_code', code: gptCode, redirect_uri: GPT_REDIRECT, client_id: 'not.a.client', client_secret: GPT_SECRET });
  check(garbage.statusCode === 401 && garbage.json()?.error === 'invalid_client', 'an unknown client_id → 401 invalid_client');
}

section('F. no downgrade: a confidential client that sent a challenge is held to it');
{
  const a = await approveAs(GPT, GPT_REDIRECT, { code_challenge: pkceS256(VERIFIER), code_challenge_method: 'S256' });
  check(a.statusCode === 200 && codePayloadOf(codeOf(a)).code_challenge === pkceS256(VERIFIER), 'consent with PKCE records the challenge on the code');
  const dropped = await tokenPost({ grant_type: 'authorization_code', code: codeOf(a), redirect_uri: GPT_REDIRECT, client_id: GPT, client_secret: GPT_SECRET });
  check(dropped.statusCode === 400 && dropped.json()?.error === 'invalid_grant', 'secret but no verifier → invalid_grant (pkce mismatch)', dropped.body);
  const wrongV = await tokenPost({ grant_type: 'authorization_code', code: codeOf(a), redirect_uri: GPT_REDIRECT, client_id: GPT, client_secret: GPT_SECRET, code_verifier: 'x'.repeat(64) });
  check(wrongV.statusCode === 400, 'a wrong verifier is refused');
  const both = await tokenPost({ grant_type: 'authorization_code', code: codeOf(a), redirect_uri: GPT_REDIRECT, client_id: GPT, client_secret: GPT_SECRET, code_verifier: VERIFIER });
  check(both.statusCode === 200, 'secret + matching verifier → tokens');
}

section('G. refresh: the secret every time');
{
  const noSecret = await tokenPost({ grant_type: 'refresh_token', refresh_token: gptTokens.refresh_token, client_id: GPT });
  check(noSecret.statusCode === 401 && noSecret.json()?.error === 'invalid_client', 'refresh without the secret → 401 invalid_client', noSecret.body);
  const body = await tokenPost({ grant_type: 'refresh_token', refresh_token: gptTokens.refresh_token, client_id: GPT, client_secret: GPT_SECRET });
  check(body.statusCode === 200 && !!body.json()?.access_token, 'refresh with client_secret in the body → tokens', body.body);
  const hdr = await tokenPost({ grant_type: 'refresh_token', refresh_token: gptTokens.refresh_token }, { authorization: basic(GPT, GPT_SECRET) });
  check(hdr.statusCode === 200 && !!hdr.json()?.access_token, 'refresh with HTTP Basic → tokens', hdr.body);
  const who = await auth(hdr.json().access_token);
  check(who.userId === ADA && who.kind === 'user', 'the refreshed token still serves Ada');
  // Revocation cuts the GPT off exactly as it cuts off claude.ai.
  await asSuperuser();
  await q(`update public.oauth_grants set revoked_at = now() where user_id=$1 and client_id_hash=$2`, [ADA, GPT_HASH]);
  grants._resetGrantCache();
  const after = await tokenPost({ grant_type: 'refresh_token', refresh_token: gptTokens.refresh_token, client_id: GPT, client_secret: GPT_SECRET });
  check(after.statusCode === 400 && after.json()?.error === 'invalid_grant', 'after the user revokes the GPT in Connections, its refresh is refused', after.body);
}

section('H. source facts');
{
  const meta = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'oauth-metadata.mjs'), 'utf8');
  check(/token_endpoint_auth_methods_supported:\s*\['none',\s*'client_secret_post',\s*'client_secret_basic'\]/.test(meta),
    'the AS metadata advertises none + client_secret_post + client_secret_basic');
  const page = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'pages', 'OAuthAuthorize.tsx'), 'utf8');
  check(/if \(!oauth\.code_challenge && !confidentialClient\) paramErrors\.push/.test(page) && /clientMeta\?\.confidential === true/.test(page),
    'the consent page waives the PKCE parameter only for a client_id that says confidential');
  const approve = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'oauth-approve.mjs'), 'utf8');
  check(approve.indexOf('const client = verifyJwt(client_id, oauthSecret)') < approve.indexOf('isConfidentialClient(client)'),
    'the approve endpoint decides confidentiality on the VERIFIED client payload');
  const reg = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'oauth-register.mjs'), 'utf8');
  check(!/confidential/.test(reg), 'dynamic registration cannot mint a confidential client');
}

section('I. scripts/register-oauth-client.mjs');
{
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const out = path.join(os.tmpdir(), `cs-oauth-client-${process.pid}.txt`);
  const stdout = execFileSync(process.execPath, [
    path.resolve(__dirname, 'register-oauth-client.mjs'), '--name', 'Contextspaces GPT (harness)',
    '--redirect', GPT_REDIRECT, '--out', out,
  ], { env: { ...process.env, MCP_OAUTH_SECRET: SECRET }, encoding: 'utf8' });
  const text = fs.readFileSync(out, 'utf8');
  const id = /CLIENT_ID[^\n]*\n([^\n]+)/.exec(text)?.[1]?.trim();
  const sec = /CLIENT_SECRET[^\n]*\n([^\n]+)/.exec(text)?.[1]?.trim();
  const pl = id ? verifyJwt(id, SECRET) : null;
  check(!!pl && clients.isConfidentialClient(pl) && clients.clientSecretMatches(pl, sec) && pl.redirect_uris[0] === GPT_REDIRECT,
    'the script mints a confidential client whose secret matches its hash');
  check(!stdout.includes(sec) && stdout.includes(out), 'with --out the secret goes to the file, and stdout names only the file');
  fs.unlinkSync(out);
  let code = 0; try { execFileSync(process.execPath, [path.resolve(__dirname, 'register-oauth-client.mjs'), '--redirect', GPT_REDIRECT], { env: { ...process.env, MCP_OAUTH_SECRET: '' }, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { code = e.status; }
  check(code === 2, 'without MCP_OAUTH_SECRET it refuses (exit 2)');
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : `CONFIDENTIAL CLIENT HOLDS — ${passes} checks: a Custom GPT signs in with its secret, a public client still with PKCE, and neither can drop the other's proof.`}\n`);
process.exit(failures ? 1 : 0);
