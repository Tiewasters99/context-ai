// Migration 095 — "Disconnect everything" — EXECUTED in PGlite with the real
// migration chain and real RLS, and then proved from the OUTSIDE: every
// credential it revokes is refused on the next request by the checks that
// already existed (api/mcp.mjs authenticate(), lib/connector-token-auth.mjs,
// lib/oauth-grants.mjs), driven unmodified through a stub PostgREST over the
// same database.
//
// Why this exists
// ---------------------------------------------------------------------------
// docs/specs/SECURITY-BUILD-2026-09-26.md §S2: "One press disconnects every
// assistant, agent and connected app from my account — or from one matter —
// and pauses AI there." Rule 3 of the spec: switches may not fail open. So
// the harness cares, in order, about:
//   A. the chain, and 095 twice; it refuses to install without its
//      prerequisites; the wrappers are not callable by anon.
//   B. the preview names exactly what the press will touch, and touches
//      nothing — for the account, for a matter, for a sub-matter.
//   C. matter scope: only that matter's reach — the presser's full-access
//      connections outright, their agents that can see the matter (listed,
//      inherited from a parent, or "all my matters"), NOT an agent scoped
//      elsewhere, not a charter, nobody else's anything; the matter paused;
//      matter.disconnected on its chain. A member who is not an owner/admin
//      is refused by the wrapper AND by the definer core.
//   D. account scope as the owner: every row flips (revoked_by stamped), an
//      expired token is left alone, charters off, every ROOT matter of every
//      serverspace they run is paused — an already-paused one keeps its own
//      note and byline, a sub-matter inherits — and nothing of anyone else's
//      moves; a matter admin who does not run the serverspace pauses nothing
//      of the firm's. The Record: connector.revoked {by:'kill'} per grant and
//      token (an OAuth agent once), account.locked on the account chain,
//      ai.paused {reason:'kill'} on each root's chain; the chains verify.
//   E. THE NEXT REQUEST. Before the press every credential authenticates;
//      after it, the same credentials are refused by api/mcp.mjs path A
//      (csp_), path B (cspa_ OAuth, full and agent), the refresh grant, and
//      lib/connector-token-auth.mjs — while another customer's still work.
//   F. fails closed: a failure at the LAST step (the account.locked row)
//      leaves every earlier revoke, pause and Record row undone.
//   G. account.unlocked: written once, on the first resume / reconnect after
//      a lock, never for an account that was not locked.
//   H. api/account-lockdown.mjs: no bearer → 401 and no database call; a
//      database failure → 502 and NO sign-out; success → the counts, and
//      Supabase Auth's logout?scope=others with the presser's own token;
//      095 absent → 503, no sign-out; logout failing → 200, said so.
//   I. the confirm sentence, from the counts the database returned.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-disconnect-all.mjs
//
// No .env, no network, no production.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
const execAttempt = async (sql, onDb = db) => { try { await onDb.exec(sql); return { err: null }; } catch (err) { return { err }; } };
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

// The Supabase pieces the chain assumes — _verify-stepup-seal.mjs's preamble
// (094's SQL functions are body-checked at create time, so auth.jwt,
// auth.mfa_factors and auth.sessions must exist) without pgvector: 094's
// search wrappers are skipped with a notice when their cores are absent.
const PREAMBLE = `
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
  create or replace function auth.jwt() returns jsonb
  language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
  $$;
  create table auth.mfa_factors (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    friendly_name text, factor_type text not null, status text not null,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table auth.sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    created_at timestamptz default now(), updated_at timestamptz default now(),
    factor_id uuid, aal text, not_after timestamptz,
    refreshed_at timestamp without time zone, user_agent text, ip inet, tag text
  );
  create table public.documents (
    id uuid primary key default gen_random_uuid(), matterspace_id uuid, created_by uuid,
    page_count int, file_size_bytes bigint, ingested_at timestamptz,
    processing_status text, processing_error text,
    created_at timestamptz not null default now());
  create table public.passages (
    id uuid primary key default gen_random_uuid(), matterspace_id uuid);
  create table storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  create or replace function storage.foldername(p_name text)
  returns text[] language sql immutable as $$ select string_to_array(p_name, '/') $$;
  grant usage on schema public, auth, storage to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

// ===========================================================================
section('A. the chain: 001…088, 094, then 095 twice');
// ===========================================================================
{
  // Negative first: 095 on a database without its prerequisites refuses to
  // install, rather than installing a sweep that half-works.
  const bare = new PGlite({ extensions: { uuid_ossp } });
  await bare.exec(PREAMBLE);
  await bare.exec(migration('001_initial_schema.sql'));
  const r = await execAttempt(migration('095_disconnect_all.sql'), bare);
  check(Boolean(r.err) && /095 needs these first/.test(r.err.message),
    '095 on a database without 065/070/085/087/088/064 raises instead of installing', r.err?.message?.slice(0, 120));
  const [s] = (await bare.query(`select to_regprocedure('public.disconnect_all(text,uuid)') is null gone`)).rows;
  check(s.gone === true, 'and leaves no disconnect_all behind');
  await bare.close();
}

await db.exec(PREAMBLE);
for (const f of [
  '001_initial_schema.sql', '003_connector_tokens.sql', '005_fix_rls_recursion.sql',
  '008_submatters.sql', '016_matterspace_members.sql', '022_matterspaces_rls_invoker_wrappers.sql',
  '023_matterspaces_update_invoker_wrapper.sql', '051_securespace.sql', '052_agent_charters.sql',
  '062_profiles_rls_plan.sql', '063_usage_budgets.sql', '064_events_ledger.sql',
  '065_oauth_grants.sql', '070_ai_pause.sql', '072_account_chain_and_session_immutability.sql',
  '073_completion_requested.sql', '085_agent_tokens_and_tasks.sql',
]) await db.exec(migration(f));
// Supabase's blanket default — the state 086 exists to undo — and 065's own
// narrowing of oauth_grants re-asserted after it, as the real database has it.
await db.exec(`grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;`);
await db.exec(`
  revoke all on public.oauth_grants from anon, authenticated;
  grant select on public.oauth_grants to authenticated;
  grant update (revoked_at) on public.oauth_grants to authenticated;
`);
for (const f of [
  '086_connector_metering_and_token_lock.sql', '087_oauth_grant_agent_link.sql',
  '088_agent_scope_all.sql', '094_security_kinds_and_stepup.sql',
]) await db.exec(migration(f));

const r095a = await execAttempt(migration('095_disconnect_all.sql'));
const r095b = await execAttempt(migration('095_disconnect_all.sql'));
check(!r095a.err && !r095b.err, '095 applies, and applies again over itself', r095a.err?.message || r095b.err?.message || '');

{
  await asSuperuser();
  for (const f of ['disconnect_all(text,uuid)', 'disconnect_all_preview(text,uuid)']) {
    const [p] = await q(`select has_function_privilege('authenticated', 'public.${f}', 'execute') a,
                                has_function_privilege('anon', 'public.${f}', 'execute') n,
                                (select prosecdef from pg_proc where oid = 'public.${f}'::regprocedure) d`);
    check(p.a && !p.n && !p.d, `${f.split('(')[0]}: INVOKER, callable by authenticated, not by anon`);
  }
  const [core] = await q(`select prosecdef d from pg_proc where oid = 'disconnect_internal.run(text,uuid,boolean)'::regprocedure`);
  check(core.d === true, 'the core it wraps is SECURITY DEFINER, in a schema PostgREST does not expose');
  const [nu] = await q(`select has_function_privilege('authenticated', 'disconnect_internal.note_unlocked(uuid,text,uuid)', 'execute') a`);
  check(nu.a === false, 'the unlock writer is callable by no role (only its own triggers reach it)');
}

// ---------------------------------------------------------------------------
// The firm
// ---------------------------------------------------------------------------
const signup = async (email, name) => {
  const [row] = await q(`insert into auth.users (email, raw_user_meta_data)
    values ($1, jsonb_build_object('display_name', $2::text)) returning id`, [email, name]);
  return row.id;
};
await asSuperuser();
const ADA = await signup('ada@example.test', 'Ada Quill');     // runs the firm
const BOB = await signup('bob@example.test', 'Bob');           // member of M1; runs his own
const CARL = await signup('carl@example.test', 'Carl');        // outside co-counsel: admin on M2 only
const [s1] = await q(`insert into public.serverspaces (clientspace_id, name)
  select id, 'Firm' from public.clientspaces where user_id = $1 returning id`, [ADA]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner')`, [s1.id, ADA]);
const mk = async (ss, name, parent = null, tier = 'A') => (await q(
  `insert into public.matterspaces (serverspace_id, name, parent_matterspace_id, ai_tier) values ($1,$2,$3,$4) returning id`,
  [ss, name, parent, tier]))[0].id;
const M1 = await mk(s1.id, 'Vashti');
const M1_CHILD = await mk(s1.id, 'Vashti › Appeal', M1);
const M2 = await mk(s1.id, 'Brannock');
const M3 = await mk(s1.id, 'Okafor');                          // paused before, with its own note
const SEALED = await mk(s1.id, 'Privileged', null, 'B');
await q(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,'member')`, [M1, BOB]);
await q(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,'admin')`, [M2, CARL]);
const [sb] = await q(`insert into public.serverspaces (clientspace_id, name)
  select id, 'Bob firm' from public.clientspaces where user_id = $1 returning id`, [BOB]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner')`, [sb.id, BOB]);
const BOB_MATTER = await mk(sb.id, 'Bob only');

// M3 was paused by Ada last week, with a note — that is evidence, and the
// sweep must leave it exactly as it is.
await asUser(ADA);
await q(`select public.matter_set_ai_pause($1, true, 'client call pending')`, [M3]);
await asSuperuser();
const [m3Before] = await q(`select ai_paused_at, ai_pause_note from public.matterspaces where id = $1`, [M3]);

// ---------------------------------------------------------------------------
// The stub PostgREST + auth server, over the same database
// (_verify-oauth-agent.mjs's, plus /auth/v1/logout).
// ---------------------------------------------------------------------------
let mode = 'deployed';   // 'deployed' | 'undeployed' | 'server-error'
let logoutMode = 'ok';   // 'ok' | 'fail'
const SESSIONS = { 'sb-ada': ADA, 'sb-bob': BOB, 'sb-carl': CARL };
const calls = [];        // every outbound request, as "METHOD path?query"
const logouts = [];      // {scope, bearer, apikey}
const PARAM_CASTS = {
  p_user_id: 'uuid', p_client_id: 'text', p_client_name: 'text', p_scopes: 'text[]', p_notes: 'text',
  p_grant_id: 'uuid', p_agent_name: 'text', p_agent_provider: 'text', p_matter_scope: 'uuid[]', p_token_hash: 'text',
  p_scope_all: 'boolean', p_scope: 'text', p_matter: 'uuid',
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
const asBearer = async (bearer, fn) => {
  const tok = String(bearer).replace(/^Bearer\s+/i, '');
  if (tok === SERVICE) await asService();
  else if (SESSIONS[tok]) await asUser(SESSIONS[tok]);
  else return jsonResponse(401, { message: 'bad jwt' });
  try { return await fn(); } finally { await db.exec('reset role').catch(() => {}); }
};

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (!url.href.startsWith(SB_URL)) throw new Error(`unexpected outbound call to ${url.href}`);
  const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
  calls.push(`${method} ${url.pathname}${url.search}`);
  const bearer = headerOf(init, 'authorization');

  if (url.pathname === '/auth/v1/user') {
    const uid = SESSIONS[String(bearer).replace(/^Bearer\s+/i, '')];
    return uid ? jsonResponse(200, { id: uid, email: 'x@example.test' }) : jsonResponse(401, { message: 'invalid session' });
  }
  if (url.pathname === '/auth/v1/logout') {
    logouts.push({ scope: url.searchParams.get('scope'), bearer, apikey: headerOf(init, 'apikey') });
    if (logoutMode === 'fail') return jsonResponse(500, { message: 'auth is down' });
    return new Response(null, { status: 204 });
  }

  const rpcM = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z0-9_]+)$/);
  if (rpcM) {
    const fn = rpcM[1];
    if (mode === 'undeployed') return jsonResponse(404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` });
    if (mode === 'server-error') return jsonResponse(500, { message: 'upstream connect error' });
    const body = JSON.parse(init.body || '{}');
    const keys = Object.keys(body);
    const args = keys.map((k, i) => `${k} => $${i + 1}::${PARAM_CASTS[k] || 'text'}`).join(', ');
    return asBearer(bearer, async () => {
      try {
        const { rows } = await db.query(`select * from public.${fn}(${args})`, keys.map((k) => bindable(body[k])));
        // A scalar-returning function answers its value, as PostgREST does.
        if (rows.length === 1 && Object.keys(rows[0]).length === 1 && Object.keys(rows[0])[0] === fn) {
          return jsonResponse(200, rows[0][fn]);
        }
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
    return asBearer(bearer, async () => {
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
const { authenticateConnectorToken } = await import('../lib/connector-token-auth.mjs');
const approveHandler = (await import('../api/oauth-approve.mjs')).default;
const tokenHandler = (await import('../api/oauth-token.mjs')).default;
const { authenticate } = await import('../api/mcp.mjs');
const lockdownHandler = (await import('../api/account-lockdown.mjs')).default;
const sentence = await import('../src/lib/disconnect-all-sentence.ts');
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
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const registerClient = (name) => signJwt(
  { typ: 'client', client_name: name, redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'] }, SECRET, 3600);
const VERIFIER = 'v'.repeat(64);
async function connect(session, client, extra = {}) {
  const a = mockRes();
  await approveHandler({
    method: 'POST',
    headers: { authorization: `Bearer ${session}`, host: 'www.contextspaces.ai' },
    body: { client_id: client, redirect_uri: REDIRECT, code_challenge: pkceS256(VERIFIER), code_challenge_method: 'S256', state: 's', scope: 'mcp', ...extra },
  }, a);
  if (a.statusCode !== 200) return { approve: a };
  const code = new URL(a.json().redirect).searchParams.get('code');
  const t = mockRes();
  await tokenHandler({ method: 'POST', headers: { 'content-type': 'application/json', host: 'www.contextspaces.ai' },
    body: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, redirect_uri: REDIRECT, client_id: client } }, t);
  return { approve: a, access: t.json()?.access_token, refresh: t.json()?.refresh_token, client };
}
async function refresh(conn) {
  const res = mockRes();
  await tokenHandler({ method: 'POST', headers: { 'content-type': 'application/json', host: 'www.contextspaces.ai' },
    body: { grant_type: 'refresh_token', refresh_token: conn.refresh, client_id: conn.client } }, res);
  return res;
}
// api/mcp.mjs's own authenticate(); the grant cache is forgotten first, so
// "the next request" means a request that asks the database again (see the
// PR: on a warm instance a full-access grant bites within GRANT_CACHE_TTL_MS).
const mcp = async (bearer) => {
  grants._resetGrantCache();
  try { const id = await authenticate({ headers: { authorization: `Bearer ${bearer}` } }); await settle(); return id; }
  catch (err) { await settle(); return { err }; }
};
const ext = async (bearer) => {
  try { return { uid: await authenticateConnectorToken({ headers: { authorization: `Bearer ${bearer}` } }) }; }
  catch (err) { return { err }; }
};

// Pasted tokens: the plaintext is what an app holds; the row holds its hash.
const TOK = {};
async function pasteToken(uid, label, { kind = 'user', scope = null, scopeAll = false, expired = false } = {}) {
  const plain = `csp_${label.replace(/[^a-z0-9]/gi, '')}_${'x'.repeat(20)}`;
  const hash = createHash('sha256').update(plain).digest('hex');
  await asSuperuser();
  const [row] = await q(`insert into public.connector_tokens
      (user_id, token_hash, token_prefix, name, kind, agent_provider, matter_scope, scope_all, expires_at)
    values ($1, $2, left($3, 12), $4, $5, $6, $7::uuid[], $8, $9) returning id`,
  [uid, hash, plain, label, kind, kind === 'agent' ? 'grok' : null,
    kind === 'agent' ? `{${(scope ?? []).join(',')}}` : null, scopeAll,
    expired ? new Date(Date.now() - 86400e3).toISOString() : null]);
  TOK[label] = { id: row.id, plain };
  return TOK[label];
}

// Ada's connections.
const CLAUDE = registerClient('Claude');
const GROK = registerClient('Grok');
const adaClaude = await connect('sb-ada', CLAUDE);                                           // full assistant
const adaGrok = await connect('sb-ada', GROK, { connect_as: 'agent', agent: { name: 'Grok Bot', provider: 'grok', matter_scope: [M1] } });
await pasteToken(ADA, 'Claude Desktop');                                                     // a connected app
await pasteToken(ADA, 'Old laptop', { expired: true });                                      // dead already
await pasteToken(ADA, 'Vashti agent', { kind: 'agent', scope: [M1] });
await pasteToken(ADA, 'Brannock agent', { kind: 'agent', scope: [M2] });
await pasteToken(ADA, 'Everything agent', { kind: 'agent', scope: [], scopeAll: true });
// Bob's — a member of M1, and a customer in his own right.
const bobClaude = await connect('sb-bob', CLAUDE);
await pasteToken(BOB, 'Bob agent', { kind: 'agent', scope: [M1] });
await pasteToken(BOB, 'Bob desktop');
// Carl's.
await pasteToken(CARL, 'Carl desktop');
await asSuperuser();
const [ch1] = await q(`insert into public.agent_charters (owner_id, matterspace_id, name, enabled) values ($1,$2,'Daily digest', true) returning id`, [ADA, M1]);
const [ch2] = await q(`insert into public.agent_charters (owner_id, matterspace_id, name, enabled) values ($1,$2,'Retired', false) returning id`, [ADA, M1]);
const [chBob] = await q(`insert into public.agent_charters (owner_id, matterspace_id, name, enabled) values ($1,$2,'Bob digest', true) returning id`, [BOB, BOB_MATTER]);

check(Boolean(adaClaude.access && adaGrok.access && bobClaude.access),
  'fixture: Ada connected Claude (full) and Grok (as an agent) over OAuth; Bob connected Claude');
const adaGrant = (await q(`select id from public.oauth_grants where user_id = $1 and agent_token_id is null`, [ADA]))[0].id;
const [adaAgentGrant] = await q(`select id, agent_token_id from public.oauth_grants where user_id = $1 and agent_token_id is not null`, [ADA]);

// ---------------------------------------------------------------------------
section('E0. before the press, every credential works (positive control)');
// ---------------------------------------------------------------------------
{
  const a = await mcp(adaClaude.access);
  check(a.userId === ADA && a.kind === 'user', 'Ada\'s Claude (OAuth, full) authenticates', JSON.stringify(a.err?.code ?? a.kind));
  const g = await mcp(adaGrok.access);
  check(g.kind === 'agent' && g.tokenId === adaAgentGrant.agent_token_id, 'Ada\'s Grok (OAuth, as an agent) authenticates as the agent');
  const d = await mcp(TOK['Claude Desktop'].plain);
  check(d.userId === ADA && d.kind === 'user', 'Ada\'s pasted token authenticates at /api/mcp');
  const e = await ext(TOK['Claude Desktop'].plain);
  check(e.uid === ADA, 'and at the extension endpoints (lib/connector-token-auth.mjs)');
  for (const k of ['Vashti agent', 'Brannock agent', 'Everything agent']) {
    const x = await mcp(TOK[k].plain);
    check(x.kind === 'agent', `Ada's "${k}" authenticates as an agent`);
  }
  const r = await refresh(adaClaude);
  check(r.statusCode === 200, 'Ada\'s Claude can refresh', String(r.statusCode));
  adaClaude.refresh = r.json()?.refresh_token ?? adaClaude.refresh;
}

// ===========================================================================
section('B. the preview names what the press will touch, and touches nothing');
// ===========================================================================
const snapshot = async () => {
  await asSuperuser();
  return JSON.stringify(await q(`
    select (select json_agg(json_build_object('id', id, 'r', revoked_at) order by id) from public.oauth_grants) g,
           (select json_agg(json_build_object('id', id, 'r', revoked_at) order by id) from public.connector_tokens) t,
           (select json_agg(json_build_object('id', id, 'e', enabled) order by id) from public.agent_charters) c,
           (select json_agg(json_build_object('id', id, 'p', ai_paused) order by id) from public.matterspaces) m,
           (select count(*) from public.events) e`));
};
const preview = async (uid, scope, matter = null) => {
  await asUser(uid);
  const r = await attempt(`select public.disconnect_all_preview($1, $2::uuid) v`, [scope, matter]);
  await asSuperuser();
  return r.err ? { err: r.err } : r.rows[0].v;
};
let accountPreview;
{
  const before = await snapshot();
  accountPreview = await preview(ADA, 'account');
  const p = accountPreview;
  check(p.assistants === 1 && p.agents === 4 && p.apps === 1 && p.charters === 1,
    'account: 1 assistant, 4 agents (3 pasted + Grok, counted once), 1 app (the expired one is not), 1 charter', JSON.stringify(p));
  check(p.matters === 5 && p.matters_paused_now === 3,
    'account: AI paused on all 5 of the firm\'s matters; 3 roots flip (Okafor is already paused, the Appeal inherits)', JSON.stringify(p));
  const m1 = await preview(ADA, 'matter', M1);
  check(m1.assistants === 1 && m1.apps === 1 && m1.agents === 3 && m1.charters === 0 && m1.outright === true,
    'matter Vashti: the full-access assistant and app outright; 3 agents reach it (listed, Grok, all-matters); not Brannock\'s', JSON.stringify(m1));
  const child = await preview(ADA, 'matter', M1_CHILD);
  check(child.agents === 3, 'matter Vashti › Appeal: the agents scoped to its PARENT reach it too', JSON.stringify(child));
  const m2 = await preview(ADA, 'matter', M2);
  check(m2.agents === 2, 'matter Brannock: its own agent and the all-matters agent only', JSON.stringify(m2));
  check((await snapshot()) === before, 'four previews later, not one row anywhere has changed');
  const bobM1 = await preview(BOB, 'matter', M1);
  check(bobM1.err?.code === '42501', 'Bob (a member, not an owner/admin) is refused even the preview of Vashti', bobM1.err?.code);
}

// ===========================================================================
section('C. matter scope — only that matter\'s reach (then rolled back)');
// ===========================================================================
{
  // BOB, a member of Vashti: refused by the wrapper AND by the definer core.
  await asUser(BOB);
  const w = await attempt(`select public.disconnect_all('matter', $1)`, [M1]);
  const c = await attempt(`select disconnect_internal.run('matter', $1, false)`, [M1]);
  await asSuperuser();
  check(w.err?.code === '42501', 'a member who is not an owner/admin: refused by disconnect_all', w.err?.message);
  check(c.err?.code === '42501', 'and by the definer core called directly', c.err?.message);
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  await db.exec('set role anon');
  const anon = await attempt(`select public.disconnect_all('account', null)`);
  await asSuperuser();
  check(Boolean(anon.err), 'anon cannot call it at all', anon.err?.code);

  await db.exec('begin');
  const beforeBob = JSON.stringify(await q(`select id, revoked_at from public.connector_tokens where user_id = $1 order by id`, [BOB]));
  await asUser(ADA);
  const { rows: [{ v }] } = await db.query(`select public.disconnect_all('matter', $1) v`, [M1]);
  await asSuperuser();
  check(v.done === true && v.agents === 3 && v.outright === true, 'Ada disconnects everything of hers that reaches Vashti', JSON.stringify(v));
  const tokState = Object.fromEntries((await q(`select name, revoked_at is not null r from public.connector_tokens where user_id = $1`, [ADA])).map((r) => [r.name, r.r]));
  check(tokState['Vashti agent'] && tokState['Everything agent'] && tokState['Grok Bot'] && tokState['Claude Desktop'],
    'revoked: the Vashti agent, the all-matters agent, the Grok sign-in agent, the pasted app', JSON.stringify(tokState));
  check(!tokState['Brannock agent'] && !tokState['Old laptop'], 'NOT revoked: the agent scoped to Brannock; the expired token is left as it was');
  const [gs] = await q(`select count(*) filter (where revoked_at is not null)::int r, count(*)::int n from public.oauth_grants where user_id = $1`, [ADA]);
  check(gs.r === 2 && gs.n === 2, 'both of Ada\'s OAuth grants revoked (the full one outright, Grok with its agent)');
  const [ch] = await q(`select enabled from public.agent_charters where id = $1`, [ch1.id]);
  check(ch.enabled === true, 'a charter is not touched by a matter-scoped press (the pause stops it here)');
  check(JSON.stringify(await q(`select id, revoked_at from public.connector_tokens where user_id = $1 order by id`, [BOB])) === beforeBob
    && (await q(`select revoked_at from public.oauth_grants where user_id = $1`, [BOB]))[0].revoked_at === null,
  'Bob\'s agent on Vashti and his Claude are untouched — the pause covers them, not a revoke');
  const paused = Object.fromEntries((await q(`select name, ai_paused, ai_pause_note from public.matterspaces where serverspace_id = $1`, [s1.id])).map((r) => [r.name, r]));
  check(paused.Vashti.ai_paused && paused.Vashti.ai_pause_note === 'disconnect_all' && !paused.Brannock.ai_paused,
    'Vashti is paused (note: the disconnect marker); Brannock is not');
  const ev = await q(`select kind, chain_key::text ck, payload from public.events where kind in ('matter.disconnected','connector.revoked','account.locked') order by seq`);
  const md = ev.filter((e) => e.kind === 'matter.disconnected');
  check(md.length === 1 && md[0].ck === M1 && md[0].payload.agents === 3, 'matter.disconnected {counts} on Vashti\'s own chain');
  const cr = ev.filter((e) => e.kind === 'connector.revoked');
  check(cr.length === 5 && cr.every((e) => e.ck === ADA && e.payload.by === 'kill'),
    'connector.revoked {by:\'kill\'} on Ada\'s ACCOUNT chain: 2 grants + 3 tokens (Grok\'s agent row once, via its grant)', `${cr.length}`);
  check(!ev.some((e) => e.kind === 'account.locked'), 'no account.locked for a matter-sized press');
  await db.exec('rollback');
  const [back] = await q(`select count(*)::int n from public.oauth_grants where revoked_at is not null`);
  check(back.n === 0, '(rolled back: the account-scope test below starts from the same state)');
}

// ===========================================================================
section('D. account scope, as the owner');
// ===========================================================================
let lockResult;
{
  const bobBefore = JSON.stringify(await q(`
    select (select json_agg(revoked_at) from public.connector_tokens where user_id = $1) t,
           (select json_agg(revoked_at) from public.oauth_grants where user_id = $1) g,
           (select json_agg(enabled) from public.agent_charters where owner_id = $1) c,
           (select ai_paused from public.matterspaces where id = $2) p`, [BOB, BOB_MATTER]));
  await asUser(ADA);
  const r = await attempt(`select public.disconnect_all('account', null) v`);
  await asSuperuser();
  lockResult = r.rows?.[0]?.v;
  check(!r.err && lockResult?.done === true, 'Ada presses "Disconnect everything"', r.err?.message);
  check(JSON.stringify({ ...lockResult, done: undefined }) === JSON.stringify({ ...accountPreview, done: undefined }),
    'and it did exactly what the preview said it would', JSON.stringify(lockResult));

  const g = await q(`select revoked_at is not null r, revoked_by from public.oauth_grants where user_id = $1`, [ADA]);
  check(g.length === 2 && g.every((x) => x.r && x.revoked_by === ADA), 'every OAuth grant revoked, revoked_by = Ada');
  const t = Object.fromEntries((await q(`select name, revoked_at is not null r from public.connector_tokens where user_id = $1`, [ADA])).map((x) => [x.name, x.r]));
  check(t['Claude Desktop'] && t['Vashti agent'] && t['Brannock agent'] && t['Everything agent'] && t['Grok Bot'],
    'every live connector token revoked — apps and agents alike', JSON.stringify(t));
  check(t['Old laptop'] === false, 'the already-expired token is left exactly as it was');
  const c = await q(`select id, enabled from public.agent_charters where owner_id = $1 order by name`, [ADA]);
  check(c.every((x) => x.enabled === false), 'every charter of Ada\'s is switched off');
  const m = Object.fromEntries((await q(`select name, ai_paused p, ai_pause_note n, ai_paused_by b, ai_paused_by_name bn, ai_paused_at a
    from public.matterspaces where serverspace_id = $1`, [s1.id])).map((x) => [x.name, x]));
  check(m.Vashti.p && m.Brannock.p && m.Privileged.p, 'every root matter of the firm is paused — the sealed one too');
  check(m.Vashti.n === 'disconnect_all' && m.Vashti.b === ADA && m.Vashti.bn === 'Ada Quill',
    'the pause names who and why (070\'s byline), through 070\'s own writer');
  check(m['Vashti › Appeal'].p === false, 'the sub-matter is not paused row-by-row …');
  await asUser(ADA);
  const [inh] = await q(`select paused, inherited from public.matter_ai_pause($1)`, [M1_CHILD]);
  await asSuperuser();
  check(inh.paused && inh.inherited, '… it is paused by inheritance, so resuming Vashti resumes it too');
  check(m.Okafor.n === 'client call pending' && String(m.Okafor.a) === String(m3Before.ai_paused_at),
    'the matter Ada had already paused keeps its own note and time');
  const bobAfter = JSON.stringify(await q(`
    select (select json_agg(revoked_at) from public.connector_tokens where user_id = $1) t,
           (select json_agg(revoked_at) from public.oauth_grants where user_id = $1) g,
           (select json_agg(enabled) from public.agent_charters where owner_id = $1) c,
           (select ai_paused from public.matterspaces where id = $2) p`, [BOB, BOB_MATTER]));
  check(bobAfter === bobBefore, 'nothing of Bob\'s moved: his grant, his tokens, his charter, his own matter');

  const ev = await q(`select kind, chain_key::text ck, matterspace_id::text m, actor_user_id::text u, payload
    from public.events where kind in ('connector.revoked','account.locked','ai.paused') order by ts, seq`);
  const cr = ev.filter((e) => e.kind === 'connector.revoked');
  check(cr.length === 6 && cr.every((e) => e.ck === ADA && e.u === ADA && e.payload.by === 'kill' && e.m === null),
    'connector.revoked {by:\'kill\'} ×6 on Ada\'s account chain (2 grants + 4 tokens; Grok\'s agent once)', `${cr.length}`);
  check(cr.some((e) => e.payload.client_name === 'Claude' && typeof e.payload.client_id === 'string' && e.payload.client_id.length === 12),
    'each names the client and its stored 12-character id prefix — never a token, never a hash');
  const al = ev.filter((e) => e.kind === 'account.locked');
  check(al.length === 1 && al[0].ck === ADA && al[0].payload.assistants === 1 && al[0].payload.matters === 5,
    'account.locked {counts} on the account chain', JSON.stringify(al[0]?.payload));
  const ap = ev.filter((e) => e.kind === 'ai.paused' && e.payload.reason === 'kill');
  check(ap.length === 3 && ap.every((e) => e.ck === e.m) && new Set(ap.map((e) => e.m)).size === 3
    && [M1, M2, SEALED].every((id) => ap.some((e) => e.m === id)),
  'ai.paused {reason:\'kill\'} on each flipped root\'s OWN chain (Vashti, Brannock, Privileged)');
  await asUser(ADA);
  const [vc] = await q(`select ok, checked from public.verify_chain($1)`, [ADA]);
  const [vm] = await q(`select ok, checked from public.verify_chain($1)`, [M1]);
  await asSuperuser();
  check(vc.ok && vc.checked >= 7 && vm.ok, 'both chains still verify end to end, as Ada reads them', JSON.stringify({ vc, vm }));
  await asUser(BOB);
  const [bobSees] = await q(`select count(*)::int n from public.events where chain_key = $1`, [ADA]);
  await asSuperuser();
  check(bobSees.n === 0, 'and Ada\'s account chain is readable by nobody else (Bob sees 0 rows)');

  // Carl is an admin of Brannock but does not run the firm: his own press
  // disconnects HIS app and pauses none of the firm's matters.
  await asUser(CARL);
  const cr2 = await attempt(`select public.disconnect_all('account', null) v`);
  await asSuperuser();
  const [cm] = await q(`select ai_pause_note from public.matterspaces where id = $1`, [M2]);
  const [ct] = await q(`select revoked_at is not null r from public.connector_tokens where user_id = $1`, [CARL]);
  check(!cr2.err && cr2.rows[0].v.matters === 0 && ct.r,
    'Carl (matter admin, not a serverspace owner) disconnects his own app and pauses nothing of the firm\'s', JSON.stringify(cr2.rows?.[0]?.v));
  check(cm.ai_pause_note === 'disconnect_all', '(Brannock\'s pause is still Ada\'s, unchanged by Carl)');
}

// ===========================================================================
section('E. the next request — refused by the checks that already existed');
// ===========================================================================
{
  const a = await mcp(adaClaude.access);
  check(a.err?.status === 401, 'Ada\'s Claude (OAuth, full): api/mcp.mjs → 401', a.err?.code);
  grants._resetGrantCache();
  const why = await grants.checkAccessGrant(verifyJwt(Buffer.from(adaClaude.access.slice(5), 'base64url').toString('utf8'), SECRET));
  check(why.ok === false && why.reason === 'grant_revoked', 'lib/oauth-grants.mjs says why: grant_revoked', why.reason);
  const r = await refresh(adaClaude);
  check(r.statusCode >= 400, 'and its refresh token is refused at /api/oauth-token', String(r.statusCode));
  const g = await mcp(adaGrok.access);
  check(g.err?.status === 401, 'Ada\'s Grok (OAuth, as an agent): 401', g.err?.code);
  const d = await mcp(TOK['Claude Desktop'].plain);
  check(d.err?.status === 401 && d.err?.code === 'revoked', 'Ada\'s pasted token at /api/mcp: 401 revoked', d.err?.code);
  const e = await ext(TOK['Claude Desktop'].plain);
  check(e.err?.status === 401 && e.err?.code === 'revoked', 'and at the extension endpoints (connector-token-auth): 401 revoked', e.err?.code);
  for (const k of ['Vashti agent', 'Brannock agent', 'Everything agent']) {
    const x = await mcp(TOK[k].plain);
    check(x.err?.status === 401, `Ada's "${k}": 401`, x.err?.code);
  }
  const b = await mcp(bobClaude.access);
  check(b.userId === BOB, 'Bob\'s Claude still authenticates — one customer\'s press is not another\'s');
  const bt = await mcp(TOK['Bob agent'].plain);
  check(bt.kind === 'agent', 'and so does Bob\'s agent');
}

// ===========================================================================
section('F. fails closed — a failure at the last step undoes everything');
// ===========================================================================
{
  // The account.locked row is the LAST thing the core writes. Make it fail
  // for Bob, press, and look for any trace of the revokes before it.
  await asSuperuser();
  await db.exec(`
    create or replace function public._harness_refuse_lock() returns trigger language plpgsql as $$
    begin
      if new.kind = 'account.locked' then raise exception 'harness: the Record is unavailable'; end if;
      return new;
    end $$;
    create trigger harness_refuse_lock before insert on public.events
      for each row execute function public._harness_refuse_lock();
  `);
  const before = await snapshot();
  await asUser(BOB);
  const r = await attempt(`select public.disconnect_all('account', null) v`);
  await asSuperuser();
  check(Boolean(r.err) && /Record is unavailable/.test(r.err.message), 'the press fails and says why', r.err?.message);
  check((await snapshot()) === before,
    'and NOTHING changed: no grant, token, charter, pause or Record row of Bob\'s — the whole press rolled back');
  const bt = await mcp(TOK['Bob agent'].plain);
  check(bt.kind === 'agent', 'Bob\'s agent still authenticates (nothing was half-revoked)');
  await db.exec(`drop trigger harness_refuse_lock on public.events; drop function public._harness_refuse_lock();`);
}

// ===========================================================================
section('G. account.unlocked — the first deliberate reconnection, once');
// ===========================================================================
{
  const unlocks = async (uid) => (await q(`select payload from public.events where chain_key = $1 and kind = 'account.unlocked' order by seq`, [uid])).map((r) => r.payload);
  check((await unlocks(ADA)).length === 0, 'Ada is locked; nothing unlocked yet');
  await asUser(ADA);
  await q(`select public.matter_set_ai_pause($1, false, null)`, [M1]);
  await asSuperuser();
  let u = await unlocks(ADA);
  check(u.length === 1 && u[0].via === 'ai.resumed' && u[0].ref === M1, 'resuming AI on Vashti writes account.unlocked {via:\'ai.resumed\'}', JSON.stringify(u));
  await asUser(ADA);
  await q(`select public.matter_set_ai_pause($1, false, null)`, [M2]);
  await asSuperuser();
  check((await unlocks(ADA)).length === 1, 'resuming a second matter does not write another');
  const again = await connect('sb-ada', CLAUDE);
  check(Boolean(again.access) && (await unlocks(ADA)).length === 1, 'nor does reconnecting Claude afterwards (it is already unlocked)');
  const a2 = await mcp(again.access);
  check(a2.userId === ADA, 'the reconnected Claude works — a new grant, deliberately approved');

  // Lock again; this time the first reconnection is the consent screen, which
  // runs as the service role (auth.uid() is null there).
  await asUser(ADA);
  await q(`select public.disconnect_all('account', null)`);
  await asSuperuser();
  await connect('sb-ada', GROK);
  u = await unlocks(ADA);
  check(u.length === 2 && u[1].via === 'assistant', 'after a second lock, approving an assistant on the consent screen writes it', JSON.stringify(u[1]));
  const [row] = await q(`select actor_user_id::text u, chain_key::text ck from public.events where chain_key = $1 and kind = 'account.unlocked' order by seq desc limit 1`, [ADA]);
  check(row.u === ADA && row.ck === ADA, 'on Ada\'s own account chain, with Ada as the actor (never another chain)');
  await asUser(ADA);
  await q(`select public.disconnect_all('account', null)`);
  await asSuperuser();
  await pasteToken(ADA, 'New desktop');
  u = await unlocks(ADA);
  check(u.length === 3 && u[2].via === 'app', 'a third lock; pasting a new token writes it with via:\'app\'');
  await asUser(ADA);
  await q(`select public.disconnect_all('account', null)`);
  await q(`update public.agent_charters set enabled = true where id = $1`, [ch2.id]);
  await asSuperuser();
  u = await unlocks(ADA);
  check(u.length === 4 && u[3].via === 'in-app agent', 'a fourth; switching a charter back on writes it');
  await pasteToken(BOB, 'Bob laptop');
  await asUser(BOB);
  await q(`update public.agent_charters set enabled = true where id = $1`, [chBob.id]);
  await asSuperuser();
  check((await unlocks(BOB)).length === 0, 'Bob was never locked: his new token and charter write nothing');
  await asUser(ADA);
  const [vc] = await q(`select ok from public.verify_chain($1)`, [ADA]);
  await asSuperuser();
  check(vc.ok, 'Ada\'s account chain still verifies with the unlock rows in it');
}

// ===========================================================================
section('H. api/account-lockdown.mjs');
// ===========================================================================
{
  const call = async (headers) => {
    const res = mockRes();
    await lockdownHandler({ method: 'POST', headers }, res);
    return res;
  };
  calls.length = 0; logouts.length = 0;
  const none = await call({});
  check(none.statusCode === 401 && none.json()?.error === 'missing_bearer' && calls.length === 0,
    'no bearer → 401, and not one request leaves the endpoint', `${none.statusCode} ${calls.join(' | ')}`);
  const bad = await call({ authorization: 'Bearer not-a-session' });
  check(bad.statusCode === 401 && !calls.some((c) => c.includes('/rpc/')) && logouts.length === 0,
    'an unknown bearer → 401, no database call, no sign-out');

  // A database failure: the press rolls back and NO sign-out happens.
  await pasteToken(BOB, 'Bob tablet');
  await asSuperuser();
  await db.exec(`
    create or replace function public._harness_refuse_lock() returns trigger language plpgsql as $$
    begin
      if new.kind = 'account.locked' then raise exception 'harness: the Record is unavailable'; end if;
      return new;
    end $$;
    create trigger harness_refuse_lock before insert on public.events
      for each row execute function public._harness_refuse_lock();
  `);
  calls.length = 0; logouts.length = 0;
  const failed = await call({ authorization: 'Bearer sb-bob' });
  const [still] = await q(`select revoked_at from public.connector_tokens where id = $1`, [TOK['Bob tablet'].id]);
  check(failed.statusCode === 502 && logouts.length === 0 && still.revoked_at === null,
    'the database refuses → 502, nothing revoked, and NO other session is signed out', `${failed.statusCode} logouts=${logouts.length}`);
  await db.exec(`drop trigger harness_refuse_lock on public.events; drop function public._harness_refuse_lock();`);

  mode = 'undeployed';
  calls.length = 0; logouts.length = 0;
  const und = await call({ authorization: 'Bearer sb-bob' });
  mode = 'deployed';
  check(und.statusCode === 503 && und.json()?.error === 'not_available' && logouts.length === 0,
    '095 not pasted → 503 not_available, and no sign-out');

  calls.length = 0; logouts.length = 0;
  const ok = await call({ authorization: 'Bearer sb-bob' });
  const body = ok.json();
  const [gone] = await q(`select revoked_at from public.connector_tokens where id = $1`, [TOK['Bob tablet'].id]);
  const [bobGrant] = await q(`select revoked_by::text b from public.oauth_grants where user_id = $1`, [BOB]);
  check(ok.statusCode === 200 && body?.counts?.done === true && body.counts.apps >= 1 && gone.revoked_at !== null && bobGrant.b === BOB,
    'Bob presses: 200 with the counts; revoked as Bob (auth.uid() was his, from his own bearer)', JSON.stringify(body?.counts));
  const rpcIdx = calls.findIndex((c) => c.includes('/rpc/disconnect_all'));
  const outIdx = calls.findIndex((c) => c.includes('/auth/v1/logout'));
  check(logouts.length === 1 && logouts[0].scope === 'others' && logouts[0].bearer === 'Bearer sb-bob' && logouts[0].apikey === SERVICE,
    'then Supabase Auth logout?scope=others — with Bob\'s OWN token (he keeps this session) and the service key', JSON.stringify(logouts));
  check(rpcIdx >= 0 && outIdx > rpcIdx && body.others_signed_out === true, 'in that order: the database first, the sign-out only after it committed');

  logoutMode = 'fail';
  await pasteToken(BOB, 'Bob phone');
  const half = await call({ authorization: 'Bearer sb-bob' });
  logoutMode = 'ok';
  check(half.statusCode === 200 && half.json()?.others_signed_out === false && half.json()?.counts?.apps === 1,
    'sign-out failing after the commit → 200, the counts, and others_signed_out:false (said, not hidden)');

  const get = mockRes();
  await lockdownHandler({ method: 'GET', headers: { authorization: 'Bearer sb-bob' } }, get);
  check(get.statusCode === 405, 'GET is not a way in (405)');
}

// ===========================================================================
section('I. the confirm sentence, from the database\'s own counts');
// ===========================================================================
{
  const c = sentence.normaliseCounts(accountPreview);
  const s = sentence.accountSentence(c);
  check(/disconnects 1 assistant, 4 agents and 1 connected app/.test(s) && /pauses AI on 5 matters/.test(s)
    && /switches off 1 agent you built here/.test(s),
  'account: names every count before the press', s);
  check(sentence.countsLine(c) === '1 assistant, 4 agents, 1 connected app; 1 agent you built here switched off; AI paused on 5 matters',
    'the short line matches the spec\'s shape', sentence.countsLine(c));
  const m = sentence.matterSentence(sentence.normaliseCounts({ scope: 'matter', assistants: 1, apps: 1, agents: 3, matters: 1, outright: true }), 'Vashti');
  check(/pauses AI on Vashti for everyone/.test(m) && /3 agents of yours/.test(m) && /disconnected from all of them, not just this one/.test(m),
    'matter: says the full-access connections go everywhere, not just here', m);
  check(!/kill|lockdown|security/i.test(s + m), 'no "kill", "lockdown" or "security" in anything a person reads');
}

console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
