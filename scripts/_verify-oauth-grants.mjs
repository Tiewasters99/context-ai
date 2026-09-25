// Execute migration 065 against a real Postgres, then drive the real OAuth
// handlers against it, and prove that one AI client can be revoked without
// touching any other client or any other customer.
//
// Why this exists
// ---------------------------------------------------------------------------
// Before 065 an OAuth approval wrote no row anywhere. Revoking anything meant
// rotating MCP_OAUTH_SECRET, which disconnects every customer at once. The
// fix is a grants table plus a grant id (`gid`) inside the tokens — and the
// part that can quietly go wrong is not the happy path, it is the transition:
// every token in the field on deploy day has no `gid`, including Eden's own
// claude.ai and ChatGPT connections. A change that disconnects the founder
// the moment it ships is the disease, not the cure.
//
// So this harness cares about four things in order:
//   1. a revocation actually bites (fail CLOSED), and bites only one client;
//   2. a pre-065 token keeps working until the cut-off (back-compat), and a
//      pre-revocation refresh token CANNOT be replayed to walk back in;
//   3. merging before the migration is pasted disconnects nobody
//      (fail OPEN with a log);
//   4. user A cannot read or revoke user B's grant, and cannot forge or
//      un-revoke their own.
//
// There is no local Postgres on this machine and no Docker, so the schema
// half runs the ACTUAL migration file inside PGlite (Postgres compiled to
// WASM, in this process: real plpgsql, real roles, real RLS). The handler
// half stubs globalThis.fetch with a small PostgREST that translates
// /rest/v1/rpc/<fn> into SQL against that same database — so api/oauth-
// approve.mjs, api/oauth-token.mjs and lib/oauth-grants.mjs run unmodified,
// end to end, against real Postgres, with no network.
//
// What it cannot prove: PGlite is single-connection, so two approvals racing
// for the same (user, client) are not exercised. What IS exercised is the
// invariant that race would threaten — one active grant per pair — which is
// enforced by a partial unique index and an ON CONFLICT clause, i.e. by
// Postgres, not by us.
//
//   npm i --no-save @electric-sql/pglite     # once; not a repo dependency
//   node scripts/_verify-oauth-grants.mjs
//
// Touches nothing outside this process. No .env, no network, no production.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoFile = (...p) => path.resolve(__dirname, '..', ...p);
const migrationSql = (name) => fs.readFileSync(repoFile('supabase', 'migrations', name), 'utf8');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};
const section = (title) => console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 62 - title.length))}`);

/** Run something expecting a refusal; returns the SQLSTATE, or null if it succeeded. */
async function refused(db, sql, params) {
  try {
    await db.query(sql, params);
    return null;
  } catch (err) {
    return err?.code || err?.cause?.code || 'error';
  }
}

// ---------------------------------------------------------------------------
// Environment the handlers read. Set BEFORE importing them: api/oauth-
// approve.mjs captures the Supabase URL and anon key at module load.
// ---------------------------------------------------------------------------
const SB_URL = 'https://stub.supabase.test';
process.env.VITE_SUPABASE_URL = SB_URL;
process.env.VITE_SUPABASE_ANON_KEY = 'stub-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role-key';
process.env.MCP_OAUTH_SECRET = 'harness-oauth-secret-that-is-long-enough-32+';

// ---------------------------------------------------------------------------
// The stub PostgREST: /rest/v1/rpc/<fn> → SQL, /auth/v1/user → a user.
// ---------------------------------------------------------------------------
let activeDb = null;        // which PGlite the RPCs run against
let mode = 'deployed';      // 'deployed' | 'undeployed' | 'table-missing' | 'server-error'
let authUser = null;        // what GET /auth/v1/user answers
const rpcCalls = [];        // every RPC the code made, in order

const PARAM_CASTS = {
  p_user_id: 'uuid',
  p_client_id: 'text',
  p_client_name: 'text',
  p_scopes: 'text[]',
  p_notes: 'text',
  p_grant_id: 'uuid',
};

const jsonResponse = (status, obj) =>
  new Response(obj === undefined ? '' : JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** JS value → something PGlite will bind against an explicit cast. */
function bindable(value) {
  if (Array.isArray(value)) {
    return `{${value.map((s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;
  }
  return value;
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);

  if (u.includes('/auth/v1/user')) {
    if (!authUser) return jsonResponse(401, { message: 'invalid session' });
    return jsonResponse(200, authUser);
  }

  const m = u.match(/\/rest\/v1\/rpc\/([a-z0-9_]+)$/i);
  if (!m) throw new Error(`stub fetch: unexpected request ${u}`);
  const fn = m[1];
  rpcCalls.push(fn);

  // What a not-yet-pasted migration looks like coming back from PostgREST.
  if (mode === 'undeployed') {
    return jsonResponse(404, {
      code: 'PGRST202',
      message: `Could not find the function public.${fn} in the schema cache`,
    });
  }
  // The table-shaped variant of the same thing (PGRST205 / 42P01).
  if (mode === 'table-missing') {
    return jsonResponse(400, {
      code: '42P01',
      message: 'relation "public.oauth_grants" does not exist',
    });
  }
  // Anything else that goes wrong: a timeout, a 5xx, a torn deploy.
  if (mode === 'server-error') {
    return jsonResponse(500, { message: 'upstream connect error' });
  }

  const body = JSON.parse(init.body || '{}');
  const keys = Object.keys(body);
  const args = keys.map((k, i) => `${k} => $${i + 1}::${PARAM_CASTS[k] || 'text'}`).join(', ');
  const params = keys.map((k) => bindable(body[k]));
  try {
    await activeDb.exec('set role service_role');
    const { rows } = await activeDb.query(`select * from public.${fn}(${args})`, params);
    await activeDb.exec('reset role');
    return jsonResponse(200, rows);
  } catch (err) {
    await activeDb.exec('reset role').catch(() => {});
    return jsonResponse(400, { code: err?.code || 'XX000', message: err?.message || String(err) });
  }
};

// Imported AFTER the env and the stub are in place.
const { signJwt, verifyJwt, pkceS256 } = await import('../lib/oauth-jwt.mjs');
const grants = await import('../lib/oauth-grants.mjs');
const approveHandler = (await import('../api/oauth-approve.mjs')).default;
const tokenHandler = (await import('../api/oauth-token.mjs')).default;

const SECRET = process.env.MCP_OAUTH_SECRET;
const settle = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// Fake req/res for the Vercel-style handlers.
// ---------------------------------------------------------------------------
function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(b) { this.body = b ?? null; return this; },
    json() { try { return JSON.parse(this.body || 'null'); } catch { return null; } },
  };
}

async function callApprove(body, bearer = 'stub-supabase-access-token') {
  const res = mockRes();
  await approveHandler(
    { method: 'POST', headers: { authorization: `Bearer ${bearer}`, host: 'www.contextspaces.ai' }, body },
    res,
  );
  return res;
}

async function callToken(body) {
  const res = mockRes();
  await tokenHandler(
    { method: 'POST', headers: { 'content-type': 'application/json', host: 'www.contextspaces.ai' }, body },
    res,
  );
  return res;
}

/** Unwrap the cspa_ envelope back to the access-token payload. */
function accessPayload(access_token) {
  const inner = Buffer.from(String(access_token).slice(5), 'base64url').toString('utf8');
  return verifyJwt(inner, SECRET);
}

/** A stateless DCR client_id, exactly as /api/oauth-register mints one. */
function registerClient(client_name, redirect_uri) {
  return signJwt(
    { typ: 'client', client_name, redirect_uris: [redirect_uri], grant_types: ['authorization_code', 'refresh_token'] },
    SECRET,
    3600,
  );
}

// ---------------------------------------------------------------------------
// Build a database: Supabase stubs + migration 065 (run twice).
// ---------------------------------------------------------------------------
async function buildDb({ runMigration = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    do $$ begin create role anon;                    exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated;           exception when duplicate_object then null; end $$;
    do $$ begin create role service_role bypassrls;  exception when duplicate_object then null; end $$;

    grant usage on schema public to anon, authenticated, service_role;

    create schema if not exists auth;

    -- The real auth.uid() reads the request's JWT claims out of a GUC.
    create or replace function auth.uid() returns uuid
    language sql stable as $fn$
      select nullif(
        coalesce(
          nullif(current_setting('request.jwt.claim.sub', true), ''),
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
        ), ''
      )::uuid
    $fn$;

    -- Only the columns 065 references. profiles is migration 001's table.
    create table if not exists public.profiles (
      id uuid primary key,
      email text
    );
    grant select on public.profiles to authenticated, service_role;
  `);
  if (runMigration) {
    const sql = migrationSql('065_oauth_grants.sql');
    await db.exec(sql);
    // Prod drifts from this folder, so the file has to be re-runnable.
    await db.exec(sql);
  }
  return db;
}

const asUser = async (db, uid) => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: uid, role: 'authenticated' }),
  ]);
  await db.exec('set role authenticated');
};
const asService = async (db) => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  await db.exec('set role service_role');
};
const asOwner = async (db) => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
};

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

// ===========================================================================
// 1. The migration applies, twice, and builds what it says it builds
// ===========================================================================
section('1. migration 065 applies (twice) and creates the shape');
const db = await buildDb();
activeDb = db;
await asOwner(db);
await db.query(`insert into public.profiles (id, email) values ($1,$2), ($3,$4)
                on conflict (id) do nothing`, [USER_A, 'a@example.test', USER_B, 'b@example.test']);

{
  const cols = (await db.query(`
    select column_name from information_schema.columns
     where table_schema='public' and table_name='oauth_grants'`)).rows.map((r) => r.column_name);
  const want = ['id', 'user_id', 'client_id_hash', 'client_id_prefix', 'client_name',
    'scopes', 'notes', 'created_at', 'last_used_at', 'revoked_at', 'revoked_by'];
  check(want.every((c) => cols.includes(c)), 'oauth_grants has every column',
    want.filter((c) => !cols.includes(c)).join(',') || 'all present');

  const fns = (await db.query(`
    select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and proname like 'oauth_grant%'`)).rows.map((r) => r.proname);
  const wantFns = ['oauth_grant_hash', 'oauth_grant_upsert', 'oauth_grant_adopt',
    'oauth_grant_state', 'oauth_grant_state_by_client', 'oauth_grant_touch',
    'oauth_grants_guard_update'];
  check(wantFns.every((f) => fns.includes(f)), 'every function exists after two runs',
    wantFns.filter((f) => !fns.includes(f)).join(',') || 'all present');

  const rls = (await db.query(
    `select relrowsecurity from pg_class where oid = 'public.oauth_grants'::regclass`)).rows[0];
  check(rls?.relrowsecurity === true, 'row level security is enabled');

  const idx = (await db.query(`
    select indexdef from pg_indexes
     where schemaname='public' and tablename='oauth_grants' and indexname='uq_oauth_grants_active'`)).rows[0];
  check(/revoked_at IS NULL/i.test(idx?.indexdef || ''),
    'at most one ACTIVE grant per (user, client)', idx?.indexdef ? 'partial unique index' : 'missing');
}

// ===========================================================================
// 2. The grant lifecycle, through the SQL the server calls
// ===========================================================================
section('2. mint, attach, revoke, re-consent, adopt');
const CLIENT_A = registerClient('Claude', 'https://claude.ai/api/mcp/auth_callback');
const CLIENT_B = registerClient('ChatGPT', 'https://chatgpt.com/connector_platform_oauth_redirect');

let grantA1;
{
  await asService(db);
  const r1 = (await db.query(
    `select * from public.oauth_grant_upsert($1::uuid, $2::text, $3::text, null, null)`,
    [USER_A, CLIENT_A, 'Claude'])).rows[0];
  grantA1 = r1.grant_id;
  check(r1.outcome === 'created' && !!grantA1, 'first approval mints a grant', r1.outcome);

  const r2 = (await db.query(
    `select * from public.oauth_grant_upsert($1::uuid, $2::text, $3::text, null, null)`,
    [USER_A, CLIENT_A, 'Claude'])).rows[0];
  check(r2.outcome === 'attached' && r2.grant_id === grantA1,
    're-approving the same client attaches, it does not pile up rows', r2.outcome);

  const rB = (await db.query(
    `select * from public.oauth_grant_upsert($1::uuid, $2::text, $3::text, null, null)`,
    [USER_A, CLIENT_B, 'ChatGPT'])).rows[0];
  check(rB.outcome === 'created' && rB.grant_id !== grantA1,
    'a second client gets its own grant');

  // Adoption while a live grant exists = attach to it, never a duplicate.
  const ad = (await db.query(
    `select * from public.oauth_grant_adopt($1::uuid, $2::text, null, null, null)`,
    [USER_A, CLIENT_A])).rows[0];
  check(ad.outcome === 'attached' && ad.grant_id === grantA1,
    'adopting a pre-065 token for a live client attaches to that grant', ad.outcome);

  // Touch.
  await db.query(`select public.oauth_grant_touch($1::uuid)`, [grantA1]);
  const t = (await db.query(`select last_used_at from public.oauth_grants where id=$1`, [grantA1])).rows[0];
  check(!!t?.last_used_at, 'oauth_grant_touch stamps last_used_at');
}

// ===========================================================================
// 3. RLS: mine only, revoke only, no forging
// ===========================================================================
section('3. RLS — a customer reads and revokes only their own grant');
{
  await asUser(db, USER_A);
  const mine = (await db.query(`select id, client_name from public.oauth_grants`)).rows;
  check(mine.length === 2, 'user A sees their own two grants', `saw ${mine.length}`);

  await asUser(db, USER_B);
  const theirs = (await db.query(`select id from public.oauth_grants`)).rows;
  check(theirs.length === 0, 'user B cannot READ user A\'s grants', `saw ${theirs.length}`);

  const upd = await db.query(
    `update public.oauth_grants set revoked_at = now() where id = $1`, [grantA1]);
  check((upd.affectedRows ?? 0) === 0, 'user B cannot REVOKE user A\'s grant',
    `${upd.affectedRows ?? 0} rows`);

  await asOwner(db);
  const still = (await db.query(`select revoked_at from public.oauth_grants where id=$1`, [grantA1])).rows[0];
  check(still.revoked_at === null, 'user A\'s grant survived user B trying');

  // The one update a customer may make.
  await asUser(db, USER_A);
  const ok = await db.query(`update public.oauth_grants set revoked_at = now() where id = $1`, [grantA1]);
  check((ok.affectedRows ?? 0) === 1, 'user A revokes their own grant');
  await asOwner(db);
  const revoked = (await db.query(
    `select revoked_at, revoked_by, client_name from public.oauth_grants where id=$1`, [grantA1])).rows[0];
  check(revoked.revoked_at !== null && revoked.revoked_by === USER_A,
    'the server stamps revoked_at and revoked_by, not the browser');

  // Everything else is refused.
  await asUser(db, USER_A);
  check(await refused(db, `update public.oauth_grants set revoked_at = null where id = $1`, [grantA1]) === '42501',
    'user A cannot UN-revoke a grant');
  check(await refused(db, `insert into public.oauth_grants (user_id, client_id_hash) values ($1, 'x')`, [USER_A]) === '42501',
    'user A cannot INSERT a grant');
  check(await refused(db, `select public.oauth_grant_upsert($1::uuid, 'forged', null, null, null)`, [USER_A]) === '42501',
    'user A cannot call oauth_grant_upsert');
  check(await refused(db, `select public.oauth_grant_touch($1::uuid)`, [grantA1]) === '42501',
    'user A cannot call oauth_grant_touch (forging "last used")');
  check(await refused(db, `select * from public.oauth_grant_state($1::uuid)`, [grantA1]) === '42501',
    'user A cannot call oauth_grant_state');
}

// ===========================================================================
// 4. The trigger is the belt: a blanket re-grant does not reopen anything
// ===========================================================================
section('4. the guard survives `grant all on all tables … to authenticated`');
{
  await asOwner(db);
  const live = (await db.query(
    `select * from public.oauth_grant_upsert($1::uuid, $2::text, $3::text, null, null)`,
    [USER_B, CLIENT_A, 'Claude'])).rows[0];
  const grantB1 = live.grant_id;

  // The line that appears in Supabase's own bootstrap and undoes column privileges.
  await db.exec(`grant all on all tables in schema public to authenticated`);

  await asUser(db, USER_B);
  const renamed = await db.query(
    `update public.oauth_grants set client_name = 'Definitely Not Claude', revoked_at = now() where id = $1`,
    [grantB1]);
  check((renamed.affectedRows ?? 0) === 1, 'the revocation itself still goes through');
  await asOwner(db);
  const after = (await db.query(
    `select client_name, revoked_at from public.oauth_grants where id=$1`, [grantB1])).rows[0];
  check(after.client_name === 'Claude',
    'client_name is frozen by the trigger even with a blanket UPDATE grant', after.client_name);
  check(after.revoked_at !== null, 'and the row is revoked');

  await asUser(db, USER_B);
  check(await refused(db, `update public.oauth_grants set revoked_at = null where id=$1`, [grantB1]) === '42501',
    'un-revoking is still refused after the blanket grant');
  check(await refused(db,
    `insert into public.oauth_grants (user_id, client_id_hash) values ($1,'y')`, [USER_B]) === '42501',
    'INSERT is still refused (no policy) after the blanket grant');

  // Re-consent after a revocation: the consent screen MAY reopen the door.
  await asService(db);
  const again = (await db.query(
    `select * from public.oauth_grant_upsert($1::uuid, $2::text, $3::text, null, null)`,
    [USER_B, CLIENT_A, 'Claude'])).rows[0];
  check(again.outcome === 'created' && again.grant_id !== grantB1,
    're-approving after a revocation mints a NEW grant and keeps the old row as history');

  // Adoption may NOT. Revoke the new one and try the legacy door.
  await asOwner(db);
  await db.query(`update public.oauth_grants set revoked_at = now() where id = $1`, [again.grant_id]);
  await asService(db);
  const adopt = (await db.query(
    `select * from public.oauth_grant_adopt($1::uuid, $2::text, null, null, null)`,
    [USER_B, CLIENT_A])).rows[0];
  check(adopt.outcome === 'revoked' && adopt.grant_id === null,
    'a pre-065 token CANNOT adopt its way past a revocation', adopt.outcome);
}

// ===========================================================================
// 5. Cascade: deleting the user takes the grants with them
// ===========================================================================
section('5. cascade');
{
  await asOwner(db);
  const before = (await db.query(`select count(*)::int n from public.oauth_grants where user_id=$1`, [USER_B])).rows[0].n;
  await db.query(`delete from public.profiles where id = $1`, [USER_B]);
  const afterN = (await db.query(`select count(*)::int n from public.oauth_grants where user_id=$1`, [USER_B])).rows[0].n;
  check(before > 0 && afterN === 0, 'deleting a user removes their grants', `${before} → ${afterN}`);
  await db.query(`insert into public.profiles (id, email) values ($1,$2) on conflict (id) do nothing`,
    [USER_B, 'b@example.test']);
}

// ===========================================================================
// 6. End to end: approve → token → verify → revoke → refused
// ===========================================================================
section('6. the real handlers, end to end');
await asOwner(db);
authUser = { id: USER_A, aud: 'authenticated', email: 'a@example.test' };
grants._resetGrantCache();

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const CLIENT_LIVE = registerClient('Claude', REDIRECT);
const VERIFIER = 'a'.repeat(64);

let liveAccess, liveRefresh, liveGid;
{
  const res = await callApprove({
    client_id: CLIENT_LIVE,
    redirect_uri: REDIRECT,
    code_challenge: pkceS256(VERIFIER),
    code_challenge_method: 'S256',
    state: 'xyz',
    scope: 'mcp',
  });
  check(res.statusCode === 200, '/api/oauth-approve returns a redirect', String(res.statusCode));
  const code = new URL(res.json().redirect).searchParams.get('code');
  const codePayload = verifyJwt(code, SECRET);
  liveGid = codePayload.gid;
  check(!!liveGid, 'the authorization code carries a grant id');

  await asOwner(db);
  const row = (await db.query(
    `select client_name, user_id, notes from public.oauth_grants where id=$1`, [liveGid])).rows[0];
  check(row?.user_id === USER_A && row?.client_name === 'Claude',
    'approving wrote a grant row with the client\'s own name', row?.client_name);

  const tok = await callToken({
    grant_type: 'authorization_code',
    code, code_verifier: VERIFIER, redirect_uri: REDIRECT, client_id: CLIENT_LIVE,
  });
  check(tok.statusCode === 200, '/api/oauth-token exchanges the code', String(tok.statusCode));
  liveAccess = tok.json().access_token;
  liveRefresh = tok.json().refresh_token;
  const ap = accessPayload(liveAccess);
  const rp = verifyJwt(liveRefresh, SECRET);
  check(ap.gid === liveGid, 'the ACCESS token carries the grant id');
  check(rp.gid === liveGid, 'the REFRESH token carries the grant id');
  check(String(liveAccess).startsWith('cspa_'), 'the cspa_ envelope is unchanged');

  const g = await grants.checkAccessGrant(ap);
  await settle();
  check(g.ok && g.reason === 'ok', '/api/mcp accepts the token while the grant is live', g.reason);
}

// Revoke it the way the Connections page does, as the user.
{
  await asUser(db, USER_A);
  await db.query(`update public.oauth_grants set revoked_at = now() where id = $1`, [liveGid]);
  await asOwner(db);

  const stale = await grants.checkAccessGrant(accessPayload(liveAccess));
  check(stale.ok, 'inside the cache window the revoked token still works (documented staleness)', stale.reason);

  grants._resetGrantCache();
  const fresh = await grants.checkAccessGrant(accessPayload(liveAccess));
  check(!fresh.ok && fresh.reason === 'grant_revoked',
    'once the cache turns over, /api/mcp refuses — FAIL CLOSED', fresh.reason);

  const ref = await callToken({ grant_type: 'refresh_token', refresh_token: liveRefresh, client_id: CLIENT_LIVE });
  check(ref.statusCode === 400 && ref.json()?.error === 'invalid_grant',
    'refreshing a revoked grant is refused', `${ref.statusCode} ${ref.json()?.error}`);

  // And the OTHER client is untouched — the whole point.
  await asService(db);
  const other = (await db.query(
    `select * from public.oauth_grant_upsert($1::uuid, $2::text, 'ChatGPT', null, null)`,
    [USER_A, CLIENT_B])).rows[0];
  await asOwner(db);
  grants._resetGrantCache();
  const otherOk = await grants.checkAccessGrant({ sub: USER_A, client_id: CLIENT_B, gid: other.grant_id });
  await settle();
  check(otherOk.ok, 'revoking one client leaves the other connected', otherOk.reason);
}

// A token naming a grant that no longer exists (user deleted, row gone).
{
  grants._resetGrantCache();
  const ghost = await grants.checkAccessGrant({
    sub: USER_A, client_id: CLIENT_LIVE, gid: '33333333-3333-4333-8333-333333333333',
  });
  check(!ghost.ok && ghost.reason === 'grant_missing',
    'a token naming a grant that does not exist is refused', ghost.reason);
}

// ===========================================================================
// 7. The cache window and the last_used_at throttle
// ===========================================================================
section('7. staleness window and last_used_at throttle');
{
  await asService(db);
  const g = (await db.query(
    `select * from public.oauth_grant_upsert($1::uuid, $2::text, 'Gemini CLI', null, null)`,
    [USER_A, registerClient('Gemini CLI', 'http://localhost:7777/cb')])).rows[0];
  await asOwner(db);
  grants._resetGrantCache();

  const payload = { sub: USER_A, client_id: 'irrelevant-for-the-gid-path', gid: g.grant_id };
  const T = Date.parse('2026-09-25T12:00:00Z');

  rpcCalls.length = 0;
  await grants.checkAccessGrant(payload, { now: T });
  await settle();
  const firstReads = rpcCalls.filter((f) => f === 'oauth_grant_state').length;
  const firstTouches = rpcCalls.filter((f) => f === 'oauth_grant_touch').length;
  check(firstReads === 1 && firstTouches === 1, 'the first call reads the grant and stamps last_used_at',
    `${firstReads} read / ${firstTouches} touch`);

  rpcCalls.length = 0;
  await grants.checkAccessGrant(payload, { now: T + 1000 });
  await grants.checkAccessGrant(payload, { now: T + 30_000 });
  await settle();
  check(rpcCalls.length === 0, 'inside 60s the hot path adds NO database round trip',
    `${rpcCalls.length} calls`);

  // Revoke, then prove the window is exactly what the UI promises.
  await asUser(db, USER_A);
  await db.query(`update public.oauth_grants set revoked_at = now() where id = $1`, [g.grant_id]);
  await asOwner(db);

  const within = await grants.checkAccessGrant(payload, { now: T + 59_000 });
  check(within.ok, 'a revocation is not yet visible at 59s (cached)', within.reason);
  const after = await grants.checkAccessGrant(payload, { now: T + 61_000 });
  check(!after.ok && after.reason === 'grant_revoked',
    'a revocation IS visible at 61s — "within a minute" is true', after.reason);

  // Throttle: a live grant, many calls, one stamp per 5 minutes.
  await asService(db);
  const g2 = (await db.query(
    `select * from public.oauth_grant_upsert($1::uuid, $2::text, 'Grok', null, null)`,
    [USER_A, registerClient('Grok', 'https://grok.com/cb')])).rows[0];
  await asOwner(db);
  grants._resetGrantCache();
  const p2 = { sub: USER_A, client_id: 'x', gid: g2.grant_id };
  rpcCalls.length = 0;
  await grants.checkAccessGrant(p2, { now: T });
  await grants.checkAccessGrant(p2, { now: T + 61_000 });
  await grants.checkAccessGrant(p2, { now: T + 122_000 });
  await settle();
  const touches = rpcCalls.filter((f) => f === 'oauth_grant_touch').length;
  check(touches === 1, 'last_used_at is stamped once per 5 minutes, not once per call',
    `${touches} stamps across 3 calls`);
  rpcCalls.length = 0;
  await grants.checkAccessGrant(p2, { now: T + 5 * 60_000 + 1000 });
  await settle();
  check(rpcCalls.filter((f) => f === 'oauth_grant_touch').length === 1,
    'and again once the throttle expires');
}

// ===========================================================================
// 8. Back-compat: tokens minted before 065 carry no gid
// ===========================================================================
section('8. the transition — pre-065 tokens, and the cut-off');
const CUTOFF = Date.parse(grants.LEGACY_NO_GID_CUTOFF_ISO);
check(Number.isFinite(CUTOFF) && CUTOFF > Date.parse('2026-09-20T00:00:00Z'),
  `the cut-off is a constant, not a surprise: ${grants.LEGACY_NO_GID_CUTOFF_ISO}`);

const CLIENT_LEGACY = registerClient('Claude', REDIRECT);
const legacyAccessPayload = { sub: USER_A, client_id: CLIENT_LEGACY, scope: 'mcp', typ: 'access' };
const legacyRefresh = signJwt(
  { iss: 'https://www.contextspaces.ai', typ: 'refresh', sub: USER_A, client_id: CLIENT_LEGACY, scope: 'mcp' },
  SECRET, 60 * 60 * 24 * 30,
);
const BEFORE = Date.parse('2026-10-01T00:00:00Z');

{
  grants._resetGrantCache();
  const never = await grants.checkAccessGrant(legacyAccessPayload, { now: BEFORE });
  check(never.ok && never.reason === 'legacy_ungranted',
    'before the cut-off a pre-065 access token still works', never.reason);

  // The refresh adopts it — this is how Eden's live connections become revocable.
  const ref = await callToken({ grant_type: 'refresh_token', refresh_token: legacyRefresh, client_id: CLIENT_LEGACY });
  check(ref.statusCode === 200, 'a pre-065 refresh token still refreshes', String(ref.statusCode));
  const newGid = accessPayload(ref.json().access_token).gid;
  check(!!newGid, 'and the reissued token now carries a grant id');
  await asOwner(db);
  const adoptedRow = (await db.query(`select notes, client_name from public.oauth_grants where id=$1`, [newGid])).rows[0];
  check(/adopted/i.test(adoptedRow?.notes || ''),
    'the adopted grant says so, so Eden can see which rows came in this way', adoptedRow?.notes || '(none)');

  grants._resetGrantCache();
  const attached = await grants.checkAccessGrant(legacyAccessPayload, { now: BEFORE });
  check(attached.ok && attached.reason === 'legacy_attached' && attached.gid === newGid,
    'the OLD gid-less access token now resolves to the adopted grant', attached.reason);

  // Revoke it. The gid-less access token must die with it.
  await asUser(db, USER_A);
  await db.query(`update public.oauth_grants set revoked_at = now() where id=$1`, [newGid]);
  await asOwner(db);
  grants._resetGrantCache();
  const dead = await grants.checkAccessGrant(legacyAccessPayload, { now: BEFORE });
  check(!dead.ok && dead.reason === 'grant_revoked',
    'revoking bites the pre-065 access token too, once the client is adopted', dead.reason);

  // THE REPLAY: the same pre-adoption refresh token, presented again.
  const replay = await callToken({ grant_type: 'refresh_token', refresh_token: legacyRefresh, client_id: CLIENT_LEGACY });
  check(replay.statusCode === 400 && replay.json()?.error === 'invalid_grant',
    'a pre-revocation refresh token CANNOT be replayed to mint a fresh grant',
    `${replay.statusCode} ${replay.json()?.error}`);

  // After the cut-off, a gid-less token is refused outright, adopted or not.
  const AFTER = CUTOFF + 1000;
  const neverSeen = { sub: USER_A, client_id: registerClient('Something', 'https://x.test/cb'), typ: 'access' };
  grants._resetGrantCache();
  const late = await grants.checkAccessGrant(neverSeen, { now: AFTER });
  check(!late.ok && late.reason === 'legacy_token_after_cutoff',
    'after the cut-off a gid-less ACCESS token is refused', late.reason);
  const lateRef = await grants.checkRefreshGrant({
    gid: null, user_id: USER_A, client_id: CLIENT_LEGACY, now: AFTER,
  });
  check(!lateRef.ok && lateRef.reason === 'legacy_token_after_cutoff',
    'after the cut-off a gid-less REFRESH token is refused', lateRef.reason);
}

// ===========================================================================
// 9. Merging before the migration is pasted disconnects nobody
// ===========================================================================
section('9. fail OPEN when the grants table is not deployed');
for (const m of ['undeployed', 'table-missing', 'server-error']) {
  mode = m;
  grants._resetGrantCache();
  const label = m === 'undeployed' ? 'PGRST202 (function missing)'
    : m === 'table-missing' ? '42P01 (table missing)'
      : '500 (database unreachable)';

  const res = await callApprove({
    client_id: CLIENT_LIVE, redirect_uri: REDIRECT,
    code_challenge: pkceS256(VERIFIER), code_challenge_method: 'S256', scope: 'mcp',
  });
  const code = res.statusCode === 200 ? new URL(res.json().redirect).searchParams.get('code') : null;
  check(res.statusCode === 200 && code && !verifyJwt(code, SECRET).gid,
    `${label}: consent still works, the code simply has no grant id`);

  const tok = await callToken({
    grant_type: 'authorization_code', code, code_verifier: VERIFIER,
    redirect_uri: REDIRECT, client_id: CLIENT_LIVE,
  });
  check(tok.statusCode === 200, `${label}: the token exchange still succeeds`, String(tok.statusCode));

  const ap = accessPayload(tok.json().access_token);
  grants._resetGrantCache();
  const g = await grants.checkAccessGrant(ap, { now: BEFORE });
  check(g.ok && g.degraded, `${label}: /api/mcp allows the call and logs`, g.reason);

  // A token that DOES carry a gid keeps working too — the row is simply
  // unreadable right now, which is not evidence that consent was withdrawn.
  grants._resetGrantCache();
  const withGid = await grants.checkAccessGrant({ sub: USER_A, client_id: CLIENT_LIVE, gid: liveGid }, { now: BEFORE });
  check(withGid.ok && withGid.degraded, `${label}: a gid-carrying token is not cut off either`, withGid.reason);

  const ref = await callToken({ grant_type: 'refresh_token', refresh_token: tok.json().refresh_token, client_id: CLIENT_LIVE });
  check(ref.statusCode === 200, `${label}: refresh still succeeds`, String(ref.statusCode));
}
mode = 'deployed';

// ===========================================================================
// 10. Source facts the design depends on
// ===========================================================================
section('10. source facts');
{
  const mcp = fs.readFileSync(repoFile('api', 'mcp.mjs'), 'utf8');
  const pathB = mcp.slice(mcp.indexOf("token.startsWith('cspa_')"), mcp.indexOf('// Path C'));
  // Since 087 path B hands the verified payload to oauthIdentity(), which is
  // where the grant check (and the agent link) lives.
  const oauthFn = mcp.slice(mcp.indexOf('async function oauthIdentity('), mcp.indexOf('// callTool options, per caller'));
  check(/oauthIdentity\(payload, 'opaque'\)/.test(pathB) && /checkAccessGrant\(payload\)/.test(oauthFn),
    'api/mcp.mjs checks the grant on the opaque access-token path');
  check(/throw new AuthError\(401, 'invalid_token'\)/.test(oauthFn),
    'a refused grant becomes a 401 invalid_token, the code clients re-authorize on');

  const pathC = mcp.slice(mcp.indexOf('// Path C'), mcp.indexOf('async function oauthIdentity('));
  check(!/checkAccessGrant/.test(pathC) && /if \(payload\.gid \|\| payload\.agt\) return oauthIdentity\(payload, 'bare'\)/.test(pathC),
    'Path C: a truly old bare JWT (no gid) is untouched; one that names a grant is an unwrapped cspa_ token and gets the same checks (087)');

  const reg = fs.readFileSync(repoFile('api', 'oauth-register.mjs'), 'utf8');
  check(/consumeIpUsage/.test(reg),
    'PR #161\'s IP rate limit on /api/oauth-register is intact and not duplicated');

  const approve = fs.readFileSync(repoFile('api', 'oauth-approve.mjs'), 'utf8');
  const token = fs.readFileSync(repoFile('api', 'oauth-token.mjs'), 'utf8');
  check(!/usage-meter/.test(approve) && !/usage-meter/.test(token),
    'approve/token carry no usage guard today, and this change did not invent one');
  check(/approveGrant\(/.test(approve) && /checkRefreshGrant/.test(token),
    'the approve and refresh paths go through lib/oauth-grants.mjs');

  const conn = fs.readFileSync(repoFile('src', 'pages', 'Connections.tsx'), 'utf8');
  check(/from\('oauth_grants'\)[\s\S]{0,400}?\.update\(\{ revoked_at/.test(conn.replace(/\n/g, '\n')),
    'the Connections page revokes by updating revoked_at');
  check(!/\.update\(\{ revoked_at[\s\S]{0,160}?\.select\(/.test(conn),
    'and does not chain .select() onto it (the RETURNING/RLS footgun)');
  check(/within a minute/.test(conn),
    'the confirm dialog tells the truth about the cache window');
}

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
await db.close().catch(() => {});
process.exit(failures === 0 ? 0 : 1);
