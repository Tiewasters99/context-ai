// Migration 099 — S2b: a disconnection is one-way, and the Record says who
// reconnected — EXECUTED in PGlite with the real migration chain (001…088,
// 094, 095, then 099 twice) and real roles and RLS, and driven from the
// outside through the real handlers (api/account-lockdown, api/oauth-approve,
// api/oauth-token, api/mcp authenticate(), api/ext/*) over a stub PostgREST
// and Supabase Auth backed by the same database.
//
// Why this exists
// ---------------------------------------------------------------------------
// The adversarial review of PR #246 (095) found that "Disconnect everything"
// could be undone by the people it is pressed against, and that the Record
// could then say the owner had done it. Its probes (sections R and R2 of
// scripts/_rev246-probe.mjs in the review worktree) are reused below as the
// negative controls, now expected to be REFUSED:
//
//   A. the chain; 099 twice; refuses to install without 095; accounts 095
//      already locked are seeded; the lock table cannot be written by a
//      browser even under Supabase's blanket grant; the new server functions
//      are service-role only.
//   S. (round 2) the press is never gated on a factor: at aal1 it revokes,
//      stamps the lock with the presser's session, and only the sign-out of
//      others waits for the factor (sign_out_only finishes it). Before that
//      sign-out, the thief's surviving session REFRESHED (the reviewer's R3)
//      is refused and writes nothing. A factor a thief enrolled on a
//      factor-less account (newer than the owner's session) stops neither
//      the press nor the sign-out. (Round 3, R4) the surviving thief session
//      pressing AGAIN does not become the presser, moves nothing, mints
//      nothing and unlocks nothing; sign_out_only from it is refused even at
//      aal2; Ada's pending session claims the presser slot on its step-up.
//      In U, a further press from Ada's post-lock sign-in moves locked_at
//      forward, becomes the presser, and keeps working.
//   O. owner vs admin: a serverspace ADMIN's own press pauses nothing of the
//      firm's (Eden's decision; see the PR).
//   R. (HIGH-1) after the press no UPDATE brings a token back — revoked_at,
//      expires_at, kind, matter_scope, scope_all, user_id, token_hash — from
//      a stolen pre-press sign-in OR from the owner's own post-press one; the
//      name still changes; the token is still refused.
//   L. (HIGH-2) a pre-065 client (no grant id): its refresh is refused, the
//      database refuses to adopt it, its access token is refused by both
//      cspa_ and bare-JWT paths; no grant row, no account.unlocked.
//   P. (MEDIUM-3, NEW-1) no session from before the press but the presser's —
//      the thief's signed-out session and its unexpired token, the same
//      refreshed, one created in the lock's own instant, a token with no
//      session, a connector's minted token — can insert a token, approve a
//      grant, enable a charter, resume AI or widen an agent, and none writes
//      account.unlocked. A colleague who is not locked may resume a firm
//      matter, and unlocks nobody.
//   U. the presser's own session reconnects with its pre-press token (no
//      refresh); the ONE account.unlocked row carries its session_id and iat
//      and clears the lock; the thief is still refused afterwards. A second
//      press over the RPC alone (no sign-out): a surviving pre-press session,
//      refreshed, is still refused; a sign-in made after it reconnects
//      through the consent screen and the row names it. After the unlock a
//      service-role grant with no sign-in behind it is still refused (NEW-3).
//   E. (MEDIUM-4) the extension endpoints refuse a paused matter:
//      /api/ext/matters leaves it out, /api/ext/documents and
//      /api/ext/push-to-drive answer 403 ai_paused (inherited by a
//      sub-matter), before any byte is read; an unreadable pause refuses.
//   C. (LOW-10) the grant cache is not trusted while the owner is locked, and
//      an unreadable grant fails CLOSED under a lock and OPEN elsewhere.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-disconnect-one-way.mjs
//
// No .env, no network, no production.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
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
process.env.GOOGLE_OAUTH_CLIENT_ID = 'harness-google-client';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'harness-google-secret';
// The extension endpoints act as the user through a JWT our server signs
// (lib/supabase-user-jwt.mjs). A throwaway P-256 key; the stub reads the
// claims of any token carrying its kid.
const KID = 'harness-kid';
{
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.MCP_SIGNING_KEY_JWK_B64 = Buffer.from(JSON.stringify(privateKey.export({ format: 'jwk' }))).toString('base64');
  process.env.MCP_SIGNING_KEY_ID = KID;
}
delete process.env.OPENAI_API_KEY;

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------
const db = new PGlite({ extensions: { uuid_ossp } });
const q = async (sql, params) => (await db.query(sql, params)).rows;
const attempt = async (sql, params) => {
  try { return { rows: (await db.query(sql, params)).rows, err: null }; } catch (err) { return { rows: null, err }; }
};
const execAttempt = async (sql, onDb = db) => { try { await onDb.exec(sql); return { err: null }; } catch (err) { return { err }; } };
const asClaims = async (claims) => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec('set role authenticated');
};
// Service role, as PostgREST presents it: the key's own claims.
const asService = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
  await db.exec('set role service_role');
};
// An operator: no claims at all (the SQL editor).
const asSuperuser = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
};
const nowS = () => Math.floor(Date.now() / 1000);

// _verify-disconnect-all.mjs's preamble (094's SQL functions are body-checked
// at create time), with the document columns the extension endpoints read.
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
    title text, source_filename text, storage_path text, doc_type text,
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

const CHAIN_BEFORE_095 = [
  '001_initial_schema.sql', '003_connector_tokens.sql', '005_fix_rls_recursion.sql',
  '008_submatters.sql', '016_matterspace_members.sql', '022_matterspaces_rls_invoker_wrappers.sql',
  '023_matterspaces_update_invoker_wrapper.sql', '051_securespace.sql', '052_agent_charters.sql',
  '062_profiles_rls_plan.sql', '063_usage_budgets.sql', '064_events_ledger.sql',
  '065_oauth_grants.sql', '070_ai_pause.sql', '072_account_chain_and_session_immutability.sql',
  '073_completion_requested.sql', '085_agent_tokens_and_tasks.sql',
];

// ===========================================================================
section('A. the chain: 001…088, 094, 095, then 099 twice');
// ===========================================================================
{
  const bare = new PGlite({ extensions: { uuid_ossp } });
  await bare.exec(PREAMBLE);
  await bare.exec(migration('001_initial_schema.sql'));
  const r = await execAttempt(migration('099_disconnect_one_way.sql'), bare);
  check(Boolean(r.err) && /099 needs these first/.test(r.err.message),
    '099 on a database without 095/088/094 raises instead of installing', r.err?.message?.slice(0, 120));
  const [s] = (await bare.query(`select to_regclass('public.account_connection_locks') is null gone`)).rows;
  check(s.gone === true, 'and leaves no lock table behind');
  await bare.close();
}

await db.exec(PREAMBLE);
for (const f of CHAIN_BEFORE_095) await db.exec(migration(f));
// What the extension endpoints read that this chain does not otherwise need:
// matterspaces.short_code (a later migration's column), and 012's
// matterspace_descendants — the walk lib/ai-tier-policy.mjs pausedMatterIds
// uses — taken verbatim from 012 (whose search half needs pgvector).
await db.exec(`alter table public.matterspaces add column if not exists short_code text;`);
{
  const m012 = migration('012_matter_descendants_search.sql');
  const from = m012.indexOf('create or replace function public.matterspace_descendants');
  const to = m012.indexOf('create or replace function public.search_passages');
  await db.exec(m012.slice(from, to));
}
await db.exec(`grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;`);
await db.exec(`
  revoke all on public.oauth_grants from anon, authenticated;
  grant select on public.oauth_grants to authenticated;
  grant update (revoked_at) on public.oauth_grants to authenticated;
`);
for (const f of [
  '086_connector_metering_and_token_lock.sql', '087_oauth_grant_agent_link.sql',
  '088_agent_scope_all.sql', '094_security_kinds_and_stepup.sql', '095_disconnect_all.sql',
]) await db.exec(migration(f));

// ---------------------------------------------------------------------------
// The firm
// ---------------------------------------------------------------------------
const signup = async (email, name) => {
  const [row] = await q(`insert into auth.users (email, raw_user_meta_data)
    values ($1, jsonb_build_object('display_name', $2::text)) returning id`, [email, name]);
  return row.id;
};
await asSuperuser();
const ADA = await signup('ada@example.test', 'Ada Quill');   // owns the firm's serverspace
const BOB = await signup('bob@example.test', 'Bob');         // an ADMIN of the firm's serverspace
const CARL = await signup('carl@example.test', 'Carl');      // outside co-counsel, member of two matters
const EVE = await signup('eve@example.test', 'Eve');         // matter admin on Brannock, never locked
const DAN = await signup('dan@example.test', 'Dan');         // pressed under 095, before 099
const [s1] = await q(`insert into public.serverspaces (clientspace_id, name)
  select id, 'Firm' from public.clientspaces where user_id = $1 returning id`, [ADA]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner'), ($1,$3,'admin')`, [s1.id, ADA, BOB]);
const mk = async (ss, name, parent = null) => (await q(
  `insert into public.matterspaces (serverspace_id, name, parent_matterspace_id) values ($1,$2,$3) returning id`,
  [ss, name, parent]))[0].id;
const M1 = await mk(s1.id, 'Vashti');
const M1_CHILD = await mk(s1.id, 'Vashti › Appeal', M1);
const M2 = await mk(s1.id, 'Brannock');
const M3 = await mk(s1.id, 'Okafor');
await q(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,'member'), ($3,$2,'member'), ($3,$4,'admin')`,
  [M1, CARL, M2, EVE]);
const doc = async (matter, title) => (await q(
  `insert into public.documents (matterspace_id, title, source_filename, storage_path, file_size_bytes, doc_type, processing_status)
   values ($1::uuid, $2::text, $2::text || '.pdf', 'm/' || $1::text || '/' || $2::text || '.pdf', 1000, 'pdf', 'ready') returning id`, [matter, title]))[0].id;
const DOC1 = await doc(M1, 'Complaint');
const DOC_CHILD = await doc(M1_CHILD, 'Brief');
const DOC2 = await doc(M2, 'Contract');

// Dan presses under 095 alone — the state production is in today.
await asClaims({ sub: DAN, role: 'authenticated', iat: nowS() });
await q(`select public.disconnect_all('account', null)`);
await asSuperuser();

const r099a = await execAttempt(migration('099_disconnect_one_way.sql'));
const r099b = await execAttempt(migration('099_disconnect_one_way.sql'));
check(!r099a.err && !r099b.err, '099 applies, and applies again over itself', r099a.err?.message || r099b.err?.message || '');

{
  await asSuperuser();
  const [d] = await q(`select locked_at is not null l, unlocked_at from public.account_connection_locks where user_id = $1`, [DAN]);
  check(d?.l === true && d.unlocked_at === null, 'an account 095 had already locked is seeded as locked, from its Record');
  const [n] = await q(`select count(*)::int n from public.account_connection_locks`);
  check(n.n === 1, 'and no one else is');

  for (const f of [
    'oauth_grant_approve_session(jsonb,uuid,text,text,text[],text,text,text,uuid[],text,boolean)',
    'oauth_grant_lock_state(uuid)', 'account_connections_lock_state(uuid)', 'oauth_grant_adopt(uuid,text,text,text[],text)',
  ]) {
    const [p] = await q(`select has_function_privilege('authenticated', 'public.${f}', 'execute') a,
                                has_function_privilege('anon', 'public.${f}', 'execute') n,
                                has_function_privilege('service_role', 'public.${f}', 'execute') s`);
    check(!p.a && !p.n && p.s, `${f.split('(')[0]}: service role only`);
  }

  // Supabase's blanket grant, re-run AFTER 099: RLS still has no write policy.
  await db.exec(`grant all on public.account_connection_locks to anon, authenticated;`);
  await asClaims({ sub: DAN, role: 'authenticated', iat: nowS() + 5 });
  const up = await attempt(`update public.account_connection_locks set unlocked_at = now() where user_id = $1 returning 1`, [DAN]);
  const del = await attempt(`delete from public.account_connection_locks where user_id = $1 returning 1`, [DAN]);
  const ins = await attempt(`insert into public.account_connection_locks (user_id, locked_at) values ($1, now() - interval '1 year') returning 1`, [CARL]);
  const [sees] = await q(`select count(*)::int n from public.account_connection_locks`);
  await asSuperuser();
  const [still] = await q(`select unlocked_at from public.account_connection_locks where user_id = $1`, [DAN]);
  check((up.err || up.rows.length === 0) && (del.err || del.rows.length === 0) && Boolean(ins.err) && still.unlocked_at === null,
    'even under a blanket grant a browser cannot update, delete or forge a lock row (RLS has no write policy)');
  check(sees.n === 1, 'and reads only its own');
  await db.exec(`revoke all on public.account_connection_locks from anon, authenticated; grant select on public.account_connection_locks to authenticated;`);
}

// ---------------------------------------------------------------------------
// Sign-ins. A Supabase access token, as the stub's Auth server issues it: the
// claims are what matter here (sub, iat, session_id, aal); the stub accepts
// exactly the tokens it has issued.
// ---------------------------------------------------------------------------
const SESSIONS = new Map();   // token -> claims
const FACTORS = new Map();    // uid -> Supabase Auth's factor list (mirrors auth.mfa_factors)
const SESS = {};              // label -> auth.sessions.id
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
// A sign-in: a row in auth.sessions (created at `created`, default its first
// iat) and an access token carrying its id. Calling again with the same label
// is a REFRESH: same session, a new iat — exactly what Supabase Auth does.
async function signIn(uid, { iat = nowS(), session = null, aal = 'aal1', created = null } = {}) {
  let id = session ? SESS[session] : null;
  if (!id) {
    await asSuperuser();
    const [row] = await q(`insert into auth.sessions (user_id, created_at, aal) values ($1, $2, $3) returning id`,
      [uid, created ?? new Date(iat * 1000).toISOString(), aal]);
    id = row.id;
    if (session) SESS[session] = id;
  }
  const claims = { sub: uid, role: 'authenticated', aud: 'authenticated', iat, exp: iat + 3600, session_id: id, aal };
  const token = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(claims)}.stub`;
  SESSIONS.set(token, claims);
  return token;
}
const claimsOf = (token) => SESSIONS.get(token);

// ---------------------------------------------------------------------------
// The stub PostgREST + Auth server over the same database
// ---------------------------------------------------------------------------
let mode = 'deployed';   // 'deployed' | 'server-error' | 'pause-error'
const calls = [];
const logouts = [];
const PARAM_CASTS = {
  p_user_id: 'uuid', p_client_id: 'text', p_client_name: 'text', p_scopes: 'text[]', p_notes: 'text',
  p_grant_id: 'uuid', p_agent_name: 'text', p_agent_provider: 'text', p_matter_scope: 'uuid[]', p_token_hash: 'text',
  p_scope_all: 'boolean', p_scope: 'text', p_matter: 'uuid', p_session: 'jsonb', p_root: 'uuid', p_user: 'uuid',
};
const jsonResponse = (status, obj) => new Response(obj === undefined ? '' : JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json' },
});
const bindable = (v) => (Array.isArray(v) ? `{${v.map((s) => `"${String(s)}"`).join(',')}}`
  : v && typeof v === 'object' ? JSON.stringify(v) : v);
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
  else if (SESSIONS.has(tok)) await asClaims(SESSIONS.get(tok));
  else {
    // A token our own server signed for a connector (lib/supabase-user-jwt.mjs).
    const [h, p] = tok.split('.');
    let header = null; let claims = null;
    try { header = JSON.parse(Buffer.from(h, 'base64url').toString()); claims = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { /* not ours */ }
    if (header?.kid !== KID || !claims?.sub) return jsonResponse(401, { message: 'bad jwt' });
    await asClaims(claims);
  }
  try { return await fn(); } finally { await db.exec('reset role').catch(() => {}); }
};
const selectCols = (select) => {
  if (select === '*') return '*';
  const out = [];
  let depth = 0; let cur = '';
  for (const ch of select) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim()).filter((c) => c && !c.includes('(')).map((c) => {
    if (!COL.test(c)) throw new Error(`stub: bad select ${c}`);
    return c;
  }).join(', ');
};

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (!url.href.startsWith(SB_URL)) throw new Error(`unexpected outbound call to ${url.href}`);
  const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
  calls.push(`${method} ${url.pathname}${url.search}`);
  const bearer = headerOf(init, 'authorization');

  if (url.pathname === '/auth/v1/user') {
    const c = claimsOf(String(bearer).replace(/^Bearer\s+/i, ''));
    if (!c) return jsonResponse(401, { message: 'invalid session' });
    return jsonResponse(200, { id: c.sub, email: 'x@example.test', factors: FACTORS.get(c.sub) ?? [] });
  }
  if (url.pathname === '/auth/v1/logout') {
    logouts.push({ scope: url.searchParams.get('scope'), bearer });
    // Supabase Auth deletes the account's other sessions (their refresh
    // tokens go with them); the caller's own session is kept.
    const c = claimsOf(String(bearer).replace(/^Bearer\s+/i, ''));
    if (c && url.searchParams.get('scope') === 'others') {
      await asSuperuser();
      await q(`delete from auth.sessions where user_id = $1 and id <> $2`, [c.sub, c.session_id]);
    }
    return new Response(null, { status: 204 });
  }

  const rpcM = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z0-9_]+)$/);
  if (rpcM) {
    const fn = rpcM[1];
    if (mode === 'server-error') return jsonResponse(500, { message: 'upstream connect error' });
    const body = JSON.parse(init.body || '{}');
    const keys = Object.keys(body);
    const args = keys.map((k, i) => `${k} => $${i + 1}::${PARAM_CASTS[k] || 'text'}`).join(', ');
    return asBearer(bearer, async () => {
      try {
        const { rows } = await db.query(`select * from public.${fn}(${args})`, keys.map((k) => bindable(body[k])));
        if (rows.length === 1 && Object.keys(rows[0]).length === 1 && Object.keys(rows[0])[0] === fn) {
          return jsonResponse(200, rows[0][fn]);
        }
        return jsonResponse(200, rows);
      } catch (err) {
        if (/function .* does not exist/.test(err?.message || '')) {
          return jsonResponse(404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` });
        }
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
    let order = '';
    let limit = '';
    for (const [k, v] of url.searchParams) {
      if (k === 'select') { select = v; continue; }
      if (k === 'order') {
        const [c, dir] = v.split('.');
        if (!COL.test(c)) throw new Error(`stub: bad order ${v}`);
        order = ` order by ${c} ${dir === 'desc' ? 'desc' : 'asc'}`; continue;
      }
      if (k === 'limit') { limit = ` limit ${Number(v) || 1000}`; continue; }
      if (!COL.test(k)) throw new Error(`stub: bad column ${k}`);
      if (v.startsWith('eq.')) { params.push(v.slice(3)); where.push(`${k}::text = $${params.length}`); }
      else if (v.startsWith('in.(')) {
        const list = v.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, ''));
        params.push(`{${list.join(',')}}`); where.push(`${k}::text = any($${params.length}::text[])`);
      } else throw new Error(`stub: unsupported filter ${k}=${v}`);
    }
    if (mode === 'pause-error' && table === 'matterspaces' && /ai_paused/.test(select + url.search)) {
      return jsonResponse(500, { message: 'upstream connect error' });
    }
    const cols = selectCols(select);
    return asBearer(bearer, async () => {
      try {
        if (method === 'GET') {
          const { rows } = await db.query(`select ${cols} from public.${table}${where.length ? ' where ' + where.join(' and ') : ''}${order}${limit}`, params);
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

const { signJwt, pkceS256 } = await import('../lib/oauth-jwt.mjs');
const grants = await import('../lib/oauth-grants.mjs');
const approveHandler = (await import('../api/oauth-approve.mjs')).default;
const tokenHandler = (await import('../api/oauth-token.mjs')).default;
const { authenticate } = await import('../api/mcp.mjs');
const lockdownHandler = (await import('../api/account-lockdown.mjs')).default;
const extMatters = (await import('../api/ext/matters.mjs')).default;
const extDocuments = (await import('../api/ext/documents.mjs')).default;
const extPush = (await import('../api/ext/push-to-drive.mjs')).default;
const SECRET = process.env.MCP_OAUTH_SECRET;
const settle = () => new Promise((r) => setTimeout(r, 20));
const CUTOFF = Date.parse(grants.LEGACY_NO_GID_CUTOFF_ISO);

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
async function approve(session, client, extra = {}) {
  const a = mockRes();
  await approveHandler({
    method: 'POST',
    headers: { authorization: `Bearer ${session}`, host: 'www.contextspaces.ai' },
    body: { client_id: client, redirect_uri: REDIRECT, code_challenge: pkceS256(VERIFIER), code_challenge_method: 'S256', state: 's', scope: 'mcp', ...extra },
  }, a);
  return a;
}
async function connect(session, client, extra = {}) {
  const a = await approve(session, client, extra);
  if (a.statusCode !== 200) return { approve: a };
  const code = new URL(a.json().redirect).searchParams.get('code');
  const t = mockRes();
  await tokenHandler({ method: 'POST', headers: { 'content-type': 'application/json', host: 'www.contextspaces.ai' },
    body: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, redirect_uri: REDIRECT, client_id: client } }, t);
  return { approve: a, access: t.json()?.access_token, refresh: t.json()?.refresh_token, client };
}
async function refreshWith(refresh_token, client) {
  const res = mockRes();
  await tokenHandler({ method: 'POST', headers: { 'content-type': 'application/json', host: 'www.contextspaces.ai' },
    body: { grant_type: 'refresh_token', refresh_token, client_id: client } }, res);
  return res;
}
const mcp = async (bearer) => {
  grants._resetGrantCache();
  try { const id = await authenticate({ headers: { authorization: `Bearer ${bearer}` } }); await settle(); return id; }
  catch (err) { await settle(); return { err }; }
};
// checkAccessGrant, then let its fire-and-forget last_used_at stamp land, so
// it cannot interleave with the next statement's role.
const cag = async (payload, opts) => { const r = await grants.checkAccessGrant(payload, opts); await settle(); return r; };
const lockdown = async (session, body = undefined) => {
  const res = mockRes();
  await lockdownHandler({ method: 'POST', headers: { authorization: `Bearer ${session}` }, body: body ?? {} }, res);
  return res;
};

const TOK = {};
async function pasteToken(uid, label, { kind = 'user', scope = null, expired = false } = {}) {
  const plain = `csp_${label.replace(/[^a-z0-9]/gi, '')}_${'x'.repeat(20)}`;
  const hash = createHash('sha256').update(plain).digest('hex');
  await asSuperuser();
  const [row] = await q(`insert into public.connector_tokens
      (user_id, token_hash, token_prefix, name, kind, agent_provider, matter_scope, expires_at)
    values ($1, $2, left($3, 12), $4, $5, $6, $7::uuid[], $8) returning id`,
  [uid, hash, plain, label, kind, kind === 'agent' ? 'grok' : null,
    kind === 'agent' ? `{${(scope ?? []).join(',')}}` : null,
    expired ? new Date(Date.now() + 30 * 86400e3).toISOString() : null]);
  TOK[label] = { id: row.id, plain, hash };
  return TOK[label];
}
const unlocks = async (uid) => {
  await asSuperuser();
  return (await q(`select payload from public.events where chain_key = $1 and kind = 'account.unlocked' order by seq`, [uid])).map((r) => r.payload);
};
const lockRow = async (uid) => {
  await asSuperuser();
  return (await q(`select locked_at, unlocked_at, unlocked_session_id, unlocked_iat, presser_session_id, pending_session_id from public.account_connection_locks where user_id = $1`, [uid]))[0] ?? null;
};
const floorOf = (ts) => Math.floor(new Date(ts).getTime() / 1000);
// A pasted token's INSERT, as the Connect pages and Connections › Agents do it.
async function insertTokenAs(claims, label, extra = {}) {
  const plain = `csp_${label.replace(/[^a-z0-9]/gi, '')}_${'y'.repeat(20)}`;
  await asClaims(claims);
  const r = await attempt(`insert into public.connector_tokens (user_id, token_hash, token_prefix, name, kind, matter_scope)
    values ($1, $2, left($3, 12), $4, $5, $6::uuid[]) returning id`,
  [claims.sub, createHash('sha256').update(plain).digest('hex'), plain, label, extra.kind ?? 'user', extra.kind === 'agent' ? `{${(extra.scope ?? []).join(',')}}` : null]);
  await asSuperuser();
  if (!r.err) TOK[label] = { id: r.rows[0].id, plain };
  return r;
}
async function resumeAs(claims, matter) {
  await asClaims(claims);
  const r = await attempt(`select public.matter_set_ai_pause($1, false, null)`, [matter]);
  await asSuperuser();
  return r;
}
async function enableCharterAs(claims, id) {
  await asClaims(claims);
  const r = await attempt(`update public.agent_charters set enabled = true where id = $1 returning id`, [id]);
  await asSuperuser();
  return r;
}

// ---------------------------------------------------------------------------
// Ada's connections, made from her own sign-in before any press
// ---------------------------------------------------------------------------
const T0 = nowS();
const ago = (s) => new Date((T0 - s) * 1000).toISOString();
const S_THIEF = await signIn(ADA, { iat: T0 - 1200, session: 'sess-thief', created: ago(1200) });   // stolen
const S_TAB = await signIn(ADA, { iat: T0 - 600, session: 'sess-tab', created: ago(600) });         // the tab Ada presses in
const S_TAB_AAL2 = await signIn(ADA, { iat: T0 - 500, session: 'sess-tab', aal: 'aal2' });          // the same session, stepped up
const S_BOB = await signIn(BOB, { iat: T0 - 100, session: 'sess-bob', created: ago(100) });
const S_EVE = await signIn(EVE, { iat: T0 - 100, session: 'sess-eve', created: ago(100) });
const sid = (label) => SESS[label];
const C = (tok) => claimsOf(tok);

const CLAUDE = registerClient('Claude');
const GROK = registerClient('Grok');
const OLD = registerClient('Old ChatGPT');
const adaClaude = await connect(S_TAB, CLAUDE);
const adaGrok = await connect(S_TAB, GROK, { connect_as: 'agent', agent: { name: 'Grok Bot', provider: 'grok', matter_scope: [M1] } });
await pasteToken(ADA, 'Claude Desktop');
await pasteToken(ADA, 'Soon laptop', { expired: true });   // expires in 30 days
await pasteToken(ADA, 'Vashti agent', { kind: 'agent', scope: [M1] });
await pasteToken(CARL, 'Carl desktop');
await asSuperuser();
const [ch1] = await q(`insert into public.agent_charters (owner_id, matterspace_id, name, enabled) values ($1,$2,'Daily digest', true) returning id`, [ADA, M1]);
// A client connected before 065: its refresh and access tokens carry no gid.
const oldRefresh = signJwt({ iss: 'https://www.contextspaces.ai', typ: 'refresh', sub: ADA, client_id: OLD, scope: 'mcp' }, SECRET, 30 * 86400);
const oldAccessJwt = signJwt({ iss: 'https://www.contextspaces.ai', typ: 'access', sub: ADA, client_id: OLD, scope: 'mcp' }, SECRET, 3600);
const oldAccessCspa = `cspa_${Buffer.from(oldAccessJwt).toString('base64url')}`;
check(Boolean(adaClaude.access && adaGrok.access), 'fixture: Ada connected Claude (full) and Grok (as an agent) from her own sign-in');
check((await mcp(TOK['Claude Desktop'].plain)).userId === ADA, 'fixture: her pasted token works before any press');

// ===========================================================================
section('O. owner vs admin — a serverspace admin\'s own press');
// ===========================================================================
{
  const res = await lockdown(S_BOB);
  const body = res.json();
  await asSuperuser();
  const paused = await q(`select name from public.matterspaces where serverspace_id = $1 and ai_paused`, [s1.id]);
  check(res.statusCode === 200 && body?.counts?.matters === 0 && paused.length === 0,
    'Bob (ADMIN of the firm\'s serverspace, not its owner) presses for his own account: AI paused on 0 of the firm\'s matters',
    JSON.stringify(body?.counts));
  await asClaims(claimsOf(S_TAB));
  const [p] = await q(`select public.disconnect_all_preview('account', null) v`);
  await asSuperuser();
  check(p.v.matters === 4, 'Ada (the OWNER) would pause all 4 — the preview says so', JSON.stringify(p.v));
}

// ===========================================================================
section('S. the press is never gated on a factor; the sign-out of others is');
// ===========================================================================
let LOCK;
{
  // Ada's own factor, enrolled long before this session began.
  await asSuperuser();
  const [f] = await q(`insert into auth.mfa_factors (user_id, factor_type, status, created_at) values ($1, 'totp', 'verified', $2) returning id`, [ADA, ago(3600)]);
  FACTORS.set(ADA, [{ id: f.id, factor_type: 'totp', status: 'verified', created_at: ago(3600) }]);
  calls.length = 0; logouts.length = 0;
  const r1 = await lockdown(S_TAB);
  const b1 = r1.json();
  check(r1.statusCode === 200 && b1?.counts?.done === true,
    'Ada presses at aal1 with a factor: the press HAPPENS — revoking is never gated', `${r1.statusCode} ${r1.body?.slice(0, 120)}`);
  check(b1?.others_signed_out === false && b1?.sign_out === 'step_up_required' && logouts.length === 0,
    'but the other sessions are NOT signed out: sign_out step_up_required (her factor predates this session)');
  const m = await mcp(TOK['Claude Desktop'].plain);
  check(m.err?.status === 401, 'her pasted token is already refused', m.err?.code);
  LOCK = await lockRow(ADA);
  check(LOCK?.locked_at && LOCK.unlocked_at === null && LOCK.presser_session_id === null && LOCK.pending_session_id === sid('sess-tab'),
    'the lock is stamped and Ada is locked; her aal1 session (a factor older than it) is PENDING, not yet the presser');
  const ms = await q(`select name from public.matterspaces where serverspace_id = $1 and ai_paused order by name`, [s1.id]);
  check(ms.map((x) => x.name).join(',') === 'Brannock,Okafor,Vashti', 'every ROOT matter of the serverspace Ada owns is paused', ms.map((x) => x.name).join(','));

  // NEW-1, the reviewer's R3: no sign-out has happened, and the thief's
  // session still exists. It refreshes — same session, a post-lock iat.
  const S_THIEF_REFRESHED = await signIn(ADA, { iat: nowS() + 5, session: 'sess-thief' });
  const t = await insertTokenAs(C(S_THIEF_REFRESHED), 'Thief refreshed');
  const p = await resumeAs(C(S_THIEF_REFRESHED), M1);
  const a = await approve(S_THIEF_REFRESHED, registerClient('Thief refreshed client'));
  check(t.err && /connections_locked/.test(t.err.message) && p.err && a.statusCode === 403,
    'the thief\'s session REFRESHED after the press (no sign-out yet) cannot paste a token, resume AI or approve a grant',
    `${t.err ? 'refused' : 'ALLOWED'}/${p.err ? 'refused' : 'ALLOWED'}/${a.statusCode}`);
  check((await unlocks(ADA)).length === 0 && (await lockRow(ADA)).unlocked_at === null,
    'and writes no account.unlocked — the block does not depend on the sign-out');

  // R4 (the reviewer's round-3 probe): the surviving thief session PRESSES
  // AGAIN, over the RPC, to take the presser slot.
  const before4 = await lockRow(ADA);
  await asClaims(C(S_THIEF_REFRESHED));
  const rp = await attempt(`select public.disconnect_all('account', null) v`);
  await asSuperuser();
  check(!rp.err && rp.rows[0].v.presser === false, 'R4: the thief may press again (revoking is always allowed) — the database answers presser:false', rp.err?.message);
  const lk4 = await lockRow(ADA);
  check(lk4.presser_session_id === null && lk4.pending_session_id === sid('sess-tab')
    && String(lk4.locked_at) === String(before4.locked_at),
  'R4: the lock is unchanged — no presser taken, the pending session is still Ada\'s, locked_at not moved');
  const t4 = await insertTokenAs(C(S_THIEF_REFRESHED), 'Thief as presser');
  check(t4.err && /connections_locked/.test(t4.err.message), 'R4: and the thief\'s csp_ mint is refused', t4.err?.message?.slice(0, 60));
  check((await unlocks(ADA)).length === 0, 'R4: no account.unlocked');
  // sign_out_only from the thief — even with an aal2 token for that session.
  const thiefAal2 = await signIn(ADA, { iat: nowS() + 6, session: 'sess-thief', aal: 'aal2' });
  logouts.length = 0;
  const so = await lockdown(thiefAal2, { sign_out_only: true });
  check(so.statusCode === 403 && so.json()?.error === 'not_allowed' && logouts.length === 0,
    'sign_out_only from a pre-lock session that is not the presser: refused, even at aal2 — nobody signed out', `${so.statusCode} ${so.json()?.error}`);

  const r2 = await lockdown(S_TAB, { sign_out_only: true });
  check(r2.statusCode === 403 && r2.json()?.error === 'step_up_required' && logouts.length === 0,
    'sign_out_only at aal1 (old factor) → 403 step_up_required, nobody signed out');
  await asSuperuser();
  const lockedRowsBefore = (await q(`select count(*)::int n from public.events where chain_key = $1 and kind = 'account.locked'`, [ADA]))[0].n;
  calls.length = 0;
  const r3 = await lockdown(S_TAB_AAL2, { sign_out_only: true });
  check(r3.statusCode === 200 && r3.json()?.others_signed_out === true && logouts[0]?.scope === 'others'
    && !calls.some((c) => c.includes('/rpc/disconnect_all')),
    'stepped up: sign_out_only signs the others out and presses nothing again');
  check((await lockRow(ADA)).presser_session_id === sid('sess-tab'),
    'and Ada\'s pending session, now at aal2, has claimed the presser slot');
  await asSuperuser();
  const [gone] = await q(`select count(*)::int n from auth.sessions where id = $1`, [sid('sess-thief')]);
  const [kept] = await q(`select count(*)::int n from auth.sessions where id = $1`, [sid('sess-tab')]);
  check(gone.n === 0 && kept.n === 1, 'the thief\'s session is gone; the presser\'s is kept');
  const [again] = await q(`select count(*)::int n from public.events where chain_key = $1 and kind = 'account.locked'`, [ADA]);
  check(again.n === lockedRowsBefore, 'the sign-out half wrote no further press (no new account.locked row)');

  // NEW-2: a thief enrols a factor on a factor-less account.
  const FRANK = await signup('frank@example.test', 'Frank');
  const S_FRANK = await signIn(FRANK, { iat: T0 - 600, session: 'sess-frank', created: ago(600) });
  await signIn(FRANK, { iat: T0 - 60, session: 'sess-frank-thief', created: ago(60) });
  await pasteToken(FRANK, 'Frank desktop');
  await asSuperuser();
  await q(`insert into auth.mfa_factors (user_id, factor_type, status, created_at) values ($1, 'totp', 'verified', $2)`, [FRANK, ago(30)]);
  FACTORS.set(FRANK, [{ id: 'f-frank', factor_type: 'totp', status: 'verified', created_at: ago(30) }]);
  logouts.length = 0;
  const rf = await lockdown(S_FRANK);
  const bf = rf.json();
  check(rf.statusCode === 200 && bf?.counts?.done === true,
    'a thief enrolled a factor on Frank\'s factor-less account: Frank\'s aal1 press still happens');
  check(bf?.others_signed_out === true && !bf?.sign_out && logouts.length === 1,
    'and signs the others out at aal1: the only factor is newer than Frank\'s session, so not his to prove');
  await asSuperuser();
  const [fs] = await q(`select count(*)::int n from auth.sessions where id = $1`, [sid('sess-frank-thief')]);
  check(fs.n === 0, 'the thief\'s session is gone');
}
const S_SAME = await signIn(ADA, { iat: floorOf(LOCK.locked_at), session: 'sess-same-second', created: LOCK.locked_at });

// ===========================================================================
section('R. HIGH-1 — nothing un-revokes (the reviewer\'s R probe, now refused)');
// ===========================================================================
{
  const tries = [
    ['revoked_at = null', `update public.connector_tokens set revoked_at = null where id = $1`, 'Claude Desktop'],
    ['expires_at = null', `update public.connector_tokens set expires_at = null where id = $1`, 'Soon laptop'],
    ['expires_at pushed back a year', `update public.connector_tokens set expires_at = now() + interval '1 year' where id = $1`, 'Soon laptop'],
    ['kind user → agent', `update public.connector_tokens set kind = 'agent', matter_scope = '{}' where id = $1`, 'Claude Desktop'],
    ['matter_scope on a revoked agent', `update public.connector_tokens set matter_scope = array['${M2}'::uuid] where id = $1`, 'Vashti agent'],
    ['scope_all on a revoked agent', `update public.connector_tokens set scope_all = true where id = $1`, 'Vashti agent'],
    ['user_id moved', `update public.connector_tokens set user_id = '${CARL}' where id = $1`, 'Claude Desktop'],
    ['token_hash replaced (a new secret on an old row)', `update public.connector_tokens set token_hash = repeat('a', 64) where id = $1`, 'Claude Desktop'],
  ];
  for (const [who, tok] of [['the thief\'s (signed-out) sign-in', S_THIEF], ['Ada\'s own session, the one that pressed', S_TAB]]) {
    const refused = [];
    for (const [label, sql, name] of tries) {
      await asClaims(C(tok));
      const r = await attempt(sql, [TOK[name].id]);
      await asSuperuser();
      // Refused BY THE GUARD (or 003's own-row check for user_id), not by a
      // typo in the probe: the error must be the permission error.
      if (r.err && (r.err.code === '42501' || /connector_tokens:|connections_locked|row-level security/.test(r.err.message))) refused.push(label);
      else console.log(`      (not refused by the guard: ${label} — ${r.err?.message ?? 'allowed'})`);
    }
    check(refused.length === tries.length, `${who}: every one of ${tries.length} un-revoking UPDATEs is refused`, `${refused.length}/${tries.length}`);
  }
  await asSuperuser();
  const [cd] = await q(`select revoked_at is not null r, kind, user_id::text u, token_hash = $2 h from public.connector_tokens where id = $1`,
    [TOK['Claude Desktop'].id, createHash('sha256').update(TOK['Claude Desktop'].plain).digest('hex')]);
  check(cd.r && cd.kind === 'user' && cd.u === ADA && cd.h, 'the row is exactly as the press left it');
  await asClaims(C(S_TAB));
  const rn = await attempt(`update public.connector_tokens set name = 'renamed' where id = $1 returning name`, [TOK['Claude Desktop'].id]);
  await asSuperuser();
  check(!rn.err && rn.rows[0]?.name === 'renamed', 'the name can still change (nothing about access)');
  const m = await mcp(TOK['Claude Desktop'].plain);
  check(m.err?.status === 401, 'and the token is still refused at /api/mcp', m.err?.code);
  const s = await mcp(TOK['Soon laptop'].plain);
  check(s.err?.status === 401, 'as is the revoked soon-to-expire one', s.err?.code);
}

// ===========================================================================
section('L. HIGH-2 — a pre-065 client (no grant id) (the reviewer\'s R2 probe, now refused)');
// ===========================================================================
{
  const r = await refreshWith(oldRefresh, OLD);
  check(r.statusCode === 400 && r.json()?.error === 'invalid_grant', 'its refresh token is refused at /api/oauth-token', `${r.statusCode}`);
  grants._resetGrantCache();
  const pre = await grants.checkRefreshGrant({ gid: null, user_id: ADA, client_id: OLD, client_name: 'Old ChatGPT', now: CUTOFF - 86_400_000 });
  check(!pre.ok && pre.reason === 'account_locked', 'even with the old cut-off date, a locked account refuses it (no adoption)', pre.reason);
  await asService();
  const [ad] = await q(`select * from public.oauth_grant_adopt($1, $2, 'Old ChatGPT', null, null)`, [ADA, OLD]);
  await asSuperuser();
  check(ad.outcome === 'locked' && ad.grant_id === null, 'and the database itself refuses to adopt it (outcome locked)', JSON.stringify(ad));
  const [g] = await q(`select count(*)::int n from public.oauth_grants where user_id = $1 and client_name = 'Old ChatGPT'`, [ADA]);
  check(g.n === 0, 'no grant row was minted for it');
  const a1 = await mcp(oldAccessCspa);
  const a2 = await mcp(oldAccessJwt);
  check(a1.err?.status === 401 && a2.err?.status === 401, 'its access token is refused on the cspa_ path AND the bare-JWT path C', `${a1.err?.code} ${a2.err?.code}`);
  grants._resetGrantCache();
  const acc = await grants.checkAccessGrant({ sub: ADA, client_id: OLD, typ: 'access' }, { now: CUTOFF - 86_400_000 });
  check(!acc.ok && acc.reason === 'account_locked', '(and before the cut-off it would be refused for the lock: legacy_ungranted is closed)', acc.reason);
  check((await unlocks(ADA)).length === 0 && (await lockRow(ADA)).unlocked_at === null, 'no account.unlocked; Ada is still locked');
}

// ===========================================================================
section('P. MEDIUM-3 — no session from before the press brings anything back');
// ===========================================================================
{
  const who = [
    ['the thief\'s signed-out session (an unexpired token)', C(S_THIEF)],
    ['the thief\'s signed-out session, refreshed (later iat)', { ...C(S_THIEF), iat: nowS() + 30 }],
    ['a session created in the lock\'s own instant', C(S_SAME)],
    ['a token with no session_id and no iat', { sub: ADA, role: 'authenticated' }],
    ['a connector\'s minted token (fresh iat)', { sub: ADA, role: 'authenticated', iat: nowS() + 5, cs_via: 'connector' }],
  ];
  for (const [label, claims] of who) {
    const t = await insertTokenAs(claims, `Thief ${label.length}`);
    const c = await enableCharterAs(claims, ch1.id);
    const p = await resumeAs(claims, M1);
    check([t, c, p].every((x) => x.err && /connections_locked/.test(x.err.message)),
      `${label}: cannot paste a token, enable a charter or resume AI`,
      [t, c, p].map((x) => (x.err ? 'refused' : 'ALLOWED')).join('/'));
  }
  await asSuperuser();
  const [before] = await q(`select count(*)::int n from public.oauth_grants where user_id = $1`, [ADA]);
  const a = await approve(S_THIEF, registerClient('Thief client'));
  const ag = await approve(S_THIEF, registerClient('Thief agent'), { connect_as: 'agent', agent: { name: 'X', provider: 'grok', matter_scope: [M1] } });
  const [after] = await q(`select count(*)::int n from public.oauth_grants where user_id = $1`, [ADA]);
  check(a.statusCode === 401 || a.statusCode === 403, 'the thief\'s signed-out sign-in on the consent screen: refused', `${a.statusCode} ${a.json()?.error}`);
  check((ag.statusCode === 401 || ag.statusCode === 403) && after.n === before.n, 'nor as an agent; no grant row', String(ag.statusCode));
  // 098's connector_token_create will be a DEFINER RPC: the claims, not
  // current_user, decide — a definer insert from the thief is refused too.
  await asSuperuser();
  await db.exec(`create or replace function public._harness_definer_token(p_hash text) returns uuid
    language plpgsql security definer set search_path = public as $$
    declare v uuid; begin
      insert into public.connector_tokens (user_id, token_hash, token_prefix, name)
      values (auth.uid(), p_hash, 'csp_harness', 'via definer') returning id into v;
      return v; end $$;`);
  await asClaims({ ...C(S_THIEF), iat: nowS() + 30 });
  const d = await attempt(`select public._harness_definer_token(repeat('b', 64))`);
  await asSuperuser();
  check(Boolean(d.err) && /connections_locked/.test(d.err.message), 'an INSERT inside a DEFINER RPC is judged by the caller\'s session (098\'s shape)', d.err?.message?.slice(0, 80));
  check((await unlocks(ADA)).length === 0, 'not one account.unlocked row from any of it');
  check((await lockRow(ADA)).unlocked_at === null, 'and Ada is still locked');

  const e = await resumeAs(C(S_EVE), M2);
  check(!e.err, 'Eve (matter admin, never locked) resumes Brannock', e.err?.message);
  check((await unlocks(ADA)).length === 0 && (await unlocks(EVE)).length === 0, 'and neither Ada\'s Record nor Eve\'s says anyone reconnected');
}

let U_FRESH;   // the connection U makes; C reads its grant
// ===========================================================================
section('U. the presser\'s own session, and a fresh sign-in — and the one row that says so');
// ===========================================================================
{
  const t = await insertTokenAs(C(S_TAB), 'New desktop');
  check(!t.err, 'Ada\'s own tab — the session that pressed, with its PRE-press token, no refresh — pastes a new token', t.err?.message);
  let u = await unlocks(ADA);
  check(u.length === 1 && u[0].via === 'app' && u[0].session_id === sid('sess-tab') && u[0].iat === T0 - 600 && u[0].through === 'sign-in',
    'account.unlocked {via:app, session_id, iat, through:sign-in} names the session that did it', JSON.stringify(u[0]));
  const lr = await lockRow(ADA);
  check(lr.unlocked_at && lr.unlocked_session_id === sid('sess-tab'), 'and clears the lock, recording which session');
  const p = await resumeAs(C(S_TAB), M3);
  check(!p.err && (await unlocks(ADA)).length === 1, 'resuming Okafor from the same session: allowed, and no second row');
  const nt = await mcp(TOK['New desktop'].plain);
  check(nt.userId === ADA, 'the new token works');

  const t2 = await insertTokenAs({ ...C(S_THIEF), iat: nowS() + 60 }, 'Thief after');
  const p2 = await resumeAs({ ...C(S_THIEF), iat: nowS() + 60 }, M1);
  check(t2.err && p2.err, 'the thief is STILL refused after Ada reconnected — the lock is a floor, never cleared');

  const ag = await insertTokenAs(C(S_TAB), 'New agent', { kind: 'agent', scope: [M3] });
  check(!ag.err, 'a new agent from the presser\'s session');
  await asClaims(C(S_TAB));
  const ok = await attempt(`update public.connector_tokens set matter_scope = array[$2::uuid] where id = $1 returning 1`, [TOK['New agent'].id, M2]);
  await asClaims({ ...C(S_THIEF), iat: nowS() + 60 });
  const wide = await attempt(`update public.connector_tokens set scope_all = true, matter_scope = '{}' where id = $1 returning 1`, [TOK['New agent'].id]);
  const rev = await attempt(`update public.connector_tokens set revoked_at = '2000-01-01' where id = $1 returning revoked_at`, [TOK['New desktop'].id]);
  await asSuperuser();
  check(!ok.err, 'Edit matters on a live agent from an admissible session still works (Connections › Agents)', ok.err?.message);
  check(Boolean(wide.err) && /connections_locked/.test(wide.err.message), 'widening it to "all my matters" from the thief\'s session is refused');
  check(!rev.err && new Date(rev.rows[0].revoked_at).getFullYear() > 2000,
    'revoking is always allowed (one-way), and the server stamps the time, not the browser');
  await asClaims(C(S_TAB));
  const again = await attempt(`update public.connector_tokens set revoked_at = now() + interval '1 day' where id = $1 returning revoked_at`, [TOK['New desktop'].id]);
  await asSuperuser();
  check(!again.err && String(again.rows[0].revoked_at) === String(rev.rows[0].revoked_at),
    'revoking twice (a double click) is not an error, and keeps the first time');

  // A second press over the RPC alone — no endpoint, no sign-out at all.
  // A second thief session began before it and survives.
  await signIn(ADA, { iat: nowS() - 5, session: 'sess-thief2', created: new Date(Date.now() - 5000).toISOString() });
  await asClaims(C(S_TAB));
  const rp = await attempt(`select public.disconnect_all('account', null) v`);
  await asSuperuser();
  check(!rp.err && rp.rows[0].v.done === true, 'Ada presses again, over the RPC only (nobody is signed out)', rp.err?.message);
  const T2 = await signIn(ADA, { iat: nowS() + 90, session: 'sess-thief2' });   // refreshed after the press
  const tt = await insertTokenAs(C(T2), 'Thief2');
  const ta = await approve(T2, CLAUDE);
  check(tt.err && /connections_locked/.test(tt.err.message) && ta.statusCode === 403,
    'RPC-only press: the surviving pre-press session, refreshed, still cannot paste a token or approve a grant',
    `${tt.err ? 'refused' : 'ALLOWED'}/${ta.statusCode}`);

  // A sign-in made after the press reconnects through the consent screen.
  const S_CONSENT = await signIn(ADA, { iat: nowS() + 120, session: 'sess-consent', created: new Date(Date.now() + 2000).toISOString() });
  const fresh = await connect(S_CONSENT, CLAUDE);
  check(Boolean(fresh.access), 'consent from a sign-in made after it: a code, a token');
  u = await unlocks(ADA);
  const last = u[u.length - 1];
  check(u.length === 2 && last.via === 'assistant' && last.through === 'consent' && last.session_id === sid('sess-consent'),
    'account.unlocked {via:assistant, through:consent} carries the APPROVING session, though the grant was written by the service role', JSON.stringify(last));
  const [row] = await q(`select actor_user_id::text u, chain_key::text ck from public.events where chain_key = $1 and kind = 'account.unlocked' order by seq desc limit 1`, [ADA]);
  check(row.u === ADA && row.ck === ADA, 'on Ada\'s own chain, as Ada');

  // NEW-3: after an unlock, a service-role write with no sign-in behind it —
  // the gid-less code exchange's grant — is still refused for this account.
  const up = await grants.ensureGrantOnApprove({ user_id: ADA, client_id: registerClient('No sign-in'), client_name: 'No sign-in' });
  check(up.outcome === 'locked', 'after the unlock, a grant written by the service role with no sign-in is still refused (outcome locked)', up.outcome);
  await asSuperuser();

  await asClaims(C(S_TAB));
  const [vc] = await q(`select ok from public.verify_chain($1)`, [ADA]);
  await asSuperuser();
  check(vc.ok, 'Ada\'s account chain verifies');
  const a = await mcp(fresh.access);
  check(a.userId === ADA, 'and the reconnected Claude works');
  U_FRESH = fresh;

  // A legitimate further press by the owner from a POST-lock session (the
  // consent sign-in, stepped up): locked_at moves forward, that session
  // becomes the presser, and it keeps working.
  const before5 = await lockRow(ADA);
  const S_CONSENT_AAL2 = await signIn(ADA, { iat: nowS() + 130, session: 'sess-consent', aal: 'aal2' });
  await asClaims(C(S_CONSENT_AAL2));
  const r5 = await attempt(`select public.disconnect_all('account', null) v`);
  await asSuperuser();
  const lk5 = await lockRow(ADA);
  check(!r5.err && r5.rows[0].v.presser === true && new Date(lk5.locked_at) > new Date(before5.locked_at)
    && lk5.presser_session_id === sid('sess-consent'),
  'Ada presses again from her post-lock sign-in: locked_at moves forward and that session becomes the presser', r5.err?.message);
  const t5 = await insertTokenAs(C(S_CONSENT_AAL2), 'After third press');
  check(!t5.err, 'and it keeps working — it reconnects a token', t5.err?.message);

  const again5 = await connect(S_CONSENT_AAL2, CLAUDE);
  check(Boolean(again5.access), 'and reconnects Claude through consent');
  U_FRESH = again5;
}

// ===========================================================================
section('E. MEDIUM-4 — the extension endpoints refuse a paused matter');
// ===========================================================================
{
  // State: Vashti (and its Appeal) paused by Ada's press; Brannock resumed by Eve.
  const call = async (handler, { method = 'GET', query = {}, body = undefined } = {}) => {
    const res = mockRes();
    await handler({ method, headers: { authorization: `Bearer ${TOK['Carl desktop'].plain}` }, query, body }, res);
    return res;
  };
  // The second press (U) paused Brannock again; Eve resumes it.
  const ev = await resumeAs(C(S_EVE), M2);
  check(!ev.err, 'Eve resumes Brannock again after Ada\'s second press', ev.err?.message);
  const list = await call(extMatters);
  const ids = (list.json()?.matters ?? []).map((m) => m.id);
  check(list.statusCode === 200 && ids.includes(M2) && !ids.includes(M1),
    'Carl\'s pasted token: /api/ext/matters lists Brannock and leaves paused Vashti out', `${list.statusCode} ${ids.length}`);
  const d1 = await call(extDocuments, { query: { matter: M1 } });
  check(d1.statusCode === 403 && d1.json()?.error === 'ai_paused' && /paused/.test(d1.json()?.message ?? ''),
    '/api/ext/documents on Vashti: 403 ai_paused, with the one sentence', `${d1.statusCode} ${d1.json()?.error}`);
  const d2 = await call(extDocuments, { query: { matter: M2 } });
  check(d2.statusCode === 200 && d2.json()?.documents?.some((x) => x.id === DOC2), '/api/ext/documents on Brannock (not paused): 200', String(d2.statusCode));

  calls.length = 0;
  const p1 = await call(extPush, { method: 'POST', body: { documentId: DOC1 } });
  check(p1.statusCode === 403 && p1.json()?.error === 'ai_paused', '/api/ext/push-to-drive of a Vashti document: 403 ai_paused', `${p1.statusCode} ${p1.body}`);
  check(!calls.some((c) => /\/rest\/v1\/connections|\/storage\/v1\//.test(c)), 'before the Drive connection or the file is read', calls.join(' | ').slice(0, 200));
  const p2 = await call(extPush, { method: 'POST', body: { documentId: DOC_CHILD } });
  check(p2.statusCode === 403 && p2.json()?.error === 'ai_paused', 'a document in the Appeal (paused by inheritance): 403 too', String(p2.statusCode));

  mode = 'pause-error';
  const pe = await call(extPush, { method: 'POST', body: { documentId: DOC2 } });
  const le = await call(extMatters);
  mode = 'deployed';
  check(pe.statusCode === 503 && le.statusCode === 503, 'a pause that cannot be read refuses (503), never passes', `${pe.statusCode} ${le.statusCode}`);
}

// ===========================================================================
section('C. LOW-10 — the grant cache under a lock');
// ===========================================================================
{
  // Ada is unlocked (U). Her Claude grant is cached as live.
  const grantPayload = (acc) => JSON.parse(Buffer.from(Buffer.from(acc.slice(5), 'base64url').toString().split('.')[1], 'base64url').toString());
  const pl = grantPayload(U_FRESH.access);
  grants._resetGrantCache();
  const t0 = Date.now();
  const first = await cag(pl, { now: t0 });
  check(first.ok && first.reason === 'ok', 'Ada\'s reconnected Claude, read and cached');

  // A third press. The entry cached before it does not know (said in the PR).
  const r = await lockdown(await signIn(ADA, { iat: nowS() + 10, session: 'sess-tab', aal: 'aal2' }));
  check(r.statusCode === 200, 'Ada presses a third time');
  const stale = await cag(pl, { now: t0 + 1000 });
  check(stale.ok, 'within the minute, a warm instance\'s pre-press entry still answers (the residual 095 already documented)');
  const fresh = await cag(pl, { now: t0 + grants.GRANT_CACHE_TTL_MS + 1 });
  check(!fresh.ok && fresh.reason === 'grant_revoked', 'after it, the fresh read refuses — and now knows the owner is locked');

  // A live grant while the owner is locked (an operator made it): the cache
  // is not trusted for it, so its revocation bites on the very next request.
  await asSuperuser();
  const [live] = await q(`insert into public.oauth_grants (user_id, client_id_hash, client_id_prefix, client_name)
    values ($1, repeat('c', 64), 'opclient', 'Operator client') returning id`, [ADA]);
  const lp = { sub: ADA, client_id: 'x', typ: 'access', gid: live.id };
  const t1 = t0 + 10 * grants.GRANT_CACHE_TTL_MS;
  const a = await cag(lp, { now: t1 });
  check(a.ok, 'a live grant of a locked owner is served …');
  await asSuperuser();
  await q(`update public.oauth_grants set revoked_at = now() where id = $1`, [live.id]);
  const b = await cag(lp, { now: t1 + 1000 });
  check(!b.ok && b.reason === 'grant_revoked', '… and read FRESH on the next request (the cache is skipped while the owner is locked)', b.reason);

  await asSuperuser();
  const [live2] = await q(`insert into public.oauth_grants (user_id, client_id_hash, client_id_prefix, client_name)
    values ($1, repeat('d', 64), 'opclient2', 'Operator client 2') returning id`, [ADA]);
  const lp2 = { sub: ADA, client_id: 'y', typ: 'access', gid: live2.id };
  await cag(lp2, { now: t1 });
  mode = 'server-error';
  const c1 = await cag(lp2, { now: t1 + 1000 });
  const c2 = await cag(lp2, { now: t1 + 2000 });
  mode = 'deployed';
  check(!c1.ok && c1.reason === 'grant_unverifiable_locked' && !c2.ok,
    'grant state unreadable while the owner is locked → REFUSED (and still refused on the next failure)', `${c1.reason} ${c2.reason}`);

  // Not locked: the existing fail-open is unchanged.
  const eve = await connect(S_EVE, CLAUDE);
  const ep = grantPayload(eve.access);
  grants._resetGrantCache();
  await cag(ep, { now: t1 });
  mode = 'server-error';
  const e1 = await cag(ep, { now: t1 + grants.GRANT_CACHE_TTL_MS + 1 });
  mode = 'deployed';
  check(e1.ok && e1.reason === 'grants_unavailable', 'Eve is not locked: an unreadable grant still fails OPEN, logged, as before', e1.reason);
}

console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
