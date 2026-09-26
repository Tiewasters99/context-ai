// Execute migration 096 against a real Postgres and drive /api/document-url
// and get_media against it, to prove S4a's sentence: every copy that leaves a
// sealed matter is in its Record — and the bucket gives a sealed matter's
// bytes to nobody who has not come through the door that writes it down.
//
// docs/specs/SECURITY-BUILD-2026-09-26.md §S4a. Real roles, real RLS, the
// real 005/016/030/049 storage policies, the real 051 tier, the real 064
// ledger and the real 094 gate, with request.jwt.claims set the way PostgREST
// sets them. The endpoint and get_media are the real files, driven with
// `fetch` replaced by a witness that answers as Supabase — PostgREST, Auth and
// Storage — by running each request against this database AS the role its
// bearer names. Storage's sign call is modelled as what storage-api does: a
// SELECT on storage.objects as the caller, "Object not found" when RLS hides
// the row. Every mint is counted, every Record row is read back.
//
// Parts:
//   A. the negative control — the chain up to 094, NO 096: an aal2 member
//      reads a sealed object's row directly. (If they could not, nothing
//      below would prove 096 is what refuses.)
//   B. 096, twice. Direct reads: sealed refused (own tier and inherited),
//      open allowed, discovery-files the same, service role unaffected, a
//      stranger and anon refused. Writes: a NEW upload into a sealed matter
//      still works (INSERT … RETURNING — the created_at = now() clause), an
//      overwrite / rename / created_at rewrite of an existing sealed object
//      reaches nothing, no UPDATE policy added, a non-uuid path cannot throw.
//      And 096 refuses to run without 094.
//   C. /api/document-url. aal2 member, sealed: minted + file.opened (read),
//      file.opened + file.exported (download), inherited seal too. aal1
//      member, sealed: step_up_required, nothing minted, nothing written.
//      Open matter: read writes nothing, download writes file.exported
//      {destination:'download'}. Non-member: not_found, nothing minted. No
//      bearer / bad bearer / connector-stamped token refused. A row pointing
//      at another matter's object refused before the mint. discovery-files
//      by path, with a traversal refused. A Record that cannot be written on
//      a sealed matter: nothing handed out.
//   D. get_media on a sealed matter: file.opened with the connector actor;
//      without a service-role mint the bucket refuses and nothing is written;
//      an open matter writes no file.opened.
//   E. the source: no browser code signs or downloads from the two buckets
//      except src/lib/vault-object.ts; the endpoint never records a path or a
//      URL; 096 creates no UPDATE policy.
//
//   npm i --no-save @electric-sql/pglite @electric-sql/pglite-pgvector
//   node scripts/_verify-sealed-download.mjs
//
// Touches nothing outside this process. No .env, no network, no production.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let PGlite, uuid_ossp;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
} catch {
  console.error('Run:  npm i --no-save @electric-sql/pglite @electric-sql/pglite-pgvector');
  process.exit(2);
}

// ── env, BEFORE the handlers run. Fake strings; a real key in the environment
// is overwritten rather than used.
const SUPABASE_URL = 'https://stub.supabase.test';
const ANON_KEY = 'anon-stub-not-a-key';
const SERVICE_KEY = 'service-role-stub-not-a-key';
process.env.VITE_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.VITE_SUPABASE_ANON_KEY = ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationSql = (name) => fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', name), 'utf8');

process.on('uncaughtException', (e) => { console.error(`\n  ERROR: ${e?.message ?? e}\n`); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(`\n  ERROR: ${e?.message ?? e}\n`); process.exit(1); });

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------------------
// A database with the bits of Supabase the migrations assume.
// ---------------------------------------------------------------------------
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
    select nullif(
      coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      ), ''
    )::uuid
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

  -- Supabase Storage's objects table, with the columns the policies read.
  create table storage.buckets (id text primary key, name text, public boolean default false);
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets(id),
    name text,
    owner uuid,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    unique (bucket_id, name)
  );
  create or replace function storage.foldername(name text) returns text[]
    language sql immutable as $$
      select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
    $$;
  alter table storage.objects enable row level security;
  insert into storage.buckets (id, name) values ('vault-documents', 'vault-documents');

  create table public.documents (
    id uuid primary key default gen_random_uuid(),
    matterspace_id uuid,
    title text, doc_type text, source_filename text, storage_path text,
    file_size_bytes bigint, page_count int,
    processing_status text not null default 'pending',
    processing_error text, ingested_at timestamptz, created_by uuid,
    metadata jsonb not null default '{}', created_at timestamptz not null default now()
  );
  create table public.passages (
    id uuid primary key default gen_random_uuid(),
    document_id uuid references public.documents(id) on delete cascade,
    matterspace_id uuid, sequence_number int
  );

  grant usage on schema public, auth, storage to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
  grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;
const CHAIN_TO_094 = [
  '001_initial_schema.sql', '005_fix_rls_recursion.sql', '008_submatters.sql',
  '016_matterspace_members.sql', '022_matterspaces_rls_invoker_wrappers.sql',
  '030_discovery_productions.sql', '049_vault_documents_storage_update_policy.sql',
  '051_securespace.sql', '064_events_ledger.sql',
  '072_account_chain_and_session_immutability.sql', '073_completion_requested.sql',
  '094_security_kinds_and_stepup.sql',
];

const db = new PGlite({ extensions: { uuid_ossp } });
await db.exec(PREAMBLE);
for (const m of CHAIN_TO_094) {
  console.log(`  executing supabase/migrations/${m}`);
  await db.exec(migrationSql(m));
}
await db.exec(`
  grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
  alter table public.documents enable row level security;
  drop policy if exists d_sel on public.documents;
  create policy d_sel on public.documents for select using (public.can_access_matter(matterspace_id));
`);

const q = async (sql, params) => (await db.query(sql, params)).rows;

// ---------------------------------------------------------------------------
// Who is asking — PostgREST's way.
// ---------------------------------------------------------------------------
const epoch = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const SIGNED_IN = '2026-10-01T12:00:00Z';
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.stub-signature`;
const VALID = new Set();
const browserToken = (uid, aal) => {
  const t = jwt({
    sub: uid, role: 'authenticated', aal, session_id: '5e551011-0000-4000-8000-000000000001',
    amr: [{ method: 'password', timestamp: epoch(SIGNED_IN) }],
  });
  VALID.add(t);
  return t;
};
const connectorToken = (uid) => {
  const t = jwt({ sub: uid, role: 'authenticated', aud: 'authenticated', cs_via: 'connector' });
  VALID.add(t);
  return t;
};
const claimsOf = (token) => {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
};

// One statement at a time: `set role` is per session, and the stub is async.
let lock = Promise.resolve();
const serial = (fn) => {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
};
const asRole = (token, fn) => serial(async () => {
  await db.exec('reset role');
  if (token === SERVICE_KEY) {
    await db.query(`select set_config('request.jwt.claims', '', false)`);
    await db.exec('set role service_role');
  } else if (token && VALID.has(token)) {
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claimsOf(token))]);
    await db.exec('set role authenticated');
  } else {
    await db.query(`select set_config('request.jwt.claims', '', false)`);
    await db.exec('set role anon');
  }
  try { return await fn(); } finally { await db.exec('reset role'); }
});
const sqlAs = (token, sql, params) => asRole(token, async () => (await db.query(sql, params)).rows);
const attemptAs = async (token, sql, params) => {
  try { return { rows: await sqlAs(token, sql, params), err: null }; } catch (err) { return { rows: null, err }; }
};

// ---------------------------------------------------------------------------
// The Supabase witness. Answers Auth, PostgREST and Storage from this database.
// ---------------------------------------------------------------------------
const mints = [];                // every signed URL storage handed out: { bucket, name, role }
let failLedgerOnce = false;      // the next ledger_append answers 500
const IDENT = /^[a-z_][a-z0-9_]*$/;

const reply = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const bearerOf = (init) => {
  const h = new Headers(init?.headers ?? {});
  const a = h.get('authorization') || '';
  return a.toLowerCase().startsWith('bearer ') ? a.slice(7).trim() : null;
};

async function stubFetch(input, init = {}) {
  const u = new URL(typeof input === 'string' ? input : input.url);
  if (u.host !== 'stub.supabase.test') throw new Error(`egress to ${u.host} — the harness allows none`);
  const bearer = bearerOf(init);
  const method = (init.method || 'GET').toUpperCase();

  if (u.pathname === '/auth/v1/user') {
    if (!bearer || !VALID.has(bearer)) return reply(401, { message: 'invalid JWT' });
    return reply(200, { id: claimsOf(bearer).sub, factors: [] });
  }

  if (u.pathname.startsWith('/rest/v1/rpc/')) {
    const fn = u.pathname.slice('/rest/v1/rpc/'.length);
    if (!IDENT.test(fn)) return reply(400, { message: 'bad function' });
    if (fn === 'ledger_append' && failLedgerOnce) {
      failLedgerOnce = false;
      return reply(500, { code: 'XX000', message: 'ledger exploded' });
    }
    const args = init.body ? JSON.parse(init.body) : {};
    const names = Object.keys(args).filter((k) => IDENT.test(k));
    const sql = `select to_jsonb(public.${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(', ')})) as r`;
    const params = names.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
    try {
      const rows = await sqlAs(bearer, sql, params);
      return reply(200, rows[0]?.r ?? null);
    } catch (err) {
      const code = err?.code ?? 'XX000';
      if (code === '42883') return reply(404, { code: 'PGRST202', message: err.message });
      return reply(400, { code, message: err?.message });
    }
  }

  if (u.pathname.startsWith('/rest/v1/') && method === 'GET') {
    const table = u.pathname.slice('/rest/v1/'.length);
    if (!IDENT.test(table)) return reply(400, { message: 'bad table' });
    const cols = (u.searchParams.get('select') || '*').split(',').map((c) => c.trim());
    if (!cols.every((c) => c === '*' || IDENT.test(c))) return reply(400, { message: 'bad select' });
    const where = [];
    const params = [];
    for (const [k, v] of u.searchParams) {
      if (k === 'select' || k === 'limit' || k === 'order' || k === 'offset') continue;
      if (!IDENT.test(k) || !v.startsWith('eq.')) return reply(400, { message: `unsupported filter ${k}` });
      params.push(v.slice(3));
      where.push(`${k}::text = $${params.length}`);
    }
    const limit = Number(u.searchParams.get('limit')) || 1000;
    const sql = `select ${cols.join(', ')} from public.${table}${where.length ? ` where ${where.join(' and ')}` : ''} limit ${limit}`;
    try {
      return reply(200, await sqlAs(bearer, sql, params));
    } catch (err) {
      return reply(400, { code: err?.code, message: err?.message });
    }
  }

  if (u.pathname.startsWith('/storage/v1/object/sign/') && method === 'POST') {
    const rest = u.pathname.slice('/storage/v1/object/sign/'.length).split('/').map(decodeURIComponent);
    const bucket = rest.shift();
    const name = rest.join('/');
    // What storage-api does before it signs: find the object AS THE CALLER.
    let rows;
    try {
      rows = await sqlAs(bearer, 'select id from storage.objects where bucket_id = $1 and name = $2', [bucket, name]);
    } catch (err) {
      return reply(400, { statusCode: '403', error: 'Unauthorized', message: err?.message });
    }
    if (!rows.length) return reply(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
    mints.push({ bucket, name, role: bearer === SERVICE_KEY ? 'service_role' : 'authenticated' });
    return reply(200, { signedURL: `/object/sign/${bucket}/${name}?token=signed-${mints.length}` });
  }

  return reply(404, { message: `unrouted ${method} ${u.pathname}` });
}
globalThis.fetch = stubFetch;   // the handlers' default, and supabase-js's

// ---------------------------------------------------------------------------
// The firm. A fictional dispute; no client names.
// ---------------------------------------------------------------------------
console.log('\n--- a firm ------------------------------------------------------');
const signup = async (email) => (await q(`insert into auth.users (email) values ($1) returning id`, [email]))[0].id;
const ADA = await signup('ada@example.test');    // owns the serverspace
const CAL = await signup('cal@example.test');    // a member; has a factor
const BOB = await signup('bob@example.test');    // a stranger
for (const u of [ADA, CAL]) {
  await q(`insert into auth.mfa_factors (user_id, factor_type, status) values ($1, 'totp', 'verified')`, [u]);
}
const [space] = await q(
  `insert into public.serverspaces (clientspace_id, name)
   select id, 'Fixture Law' from public.clientspaces where user_id = $1 returning id`, [ADA]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner'), ($1,$3,'member')`,
  [space.id, ADA, CAL]);
const matter = async (name, parent = null, tier = 'A') => (await q(
  `insert into public.matterspaces (serverspace_id, name, parent_matterspace_id, ai_tier)
   values ($1,$2,$3,$4) returning id`, [space.id, name, parent, tier]))[0].id;
const OPEN = await matter('Vashti v. Ormsby');
const SEALED = await matter('Ormsby privileged', null, 'B');
const SEALED_KID = await matter('Ormsby privileged / memos', SEALED, 'A');   // sealed by inheritance

const doc = async (m, title, file, storagePath = null) => {
  const [d] = await q(
    `insert into public.documents (matterspace_id, title, source_filename, created_by)
     values ($1,$2,$3,$4) returning id`, [m, title, file, ADA]);
  const p = storagePath ?? `${m}/${d.id}/${file}`;
  await q(`update public.documents set storage_path = $1 where id = $2`, [p, d.id]);
  await q(`insert into storage.objects (bucket_id, name, created_at) values ('vault-documents', $1, now() - interval '1 day')
           on conflict do nothing`, [p]);
  return { id: d.id, path: p, title };
};
const D_OPEN = await doc(OPEN, 'Complaint', 'complaint.pdf');
const D_SEALED = await doc(SEALED, 'Advice memo', 'advice.pdf');
const D_KID = await doc(SEALED_KID, 'Draft settlement', 'draft.pdf');
// A row in the OPEN matter whose storage_path points at the sealed object.
const D_POINTER = await doc(OPEN, 'Innocent-looking row', 'x.pdf', D_SEALED.path);
const DISC_SEALED = `${SEALED}/prod-1/natives/ORM-000001.msg`;
const DISC_OPEN = `${OPEN}/prod-2/package.zip`;
await q(`insert into storage.objects (bucket_id, name, created_at) values
  ('discovery-files', $1, now() - interval '1 day'), ('discovery-files', $2, now() - interval '1 day'),
  ('vault-documents', 'loose-file-not-a-matter/readme.txt', now() - interval '1 day')`, [DISC_SEALED, DISC_OPEN]);
console.log('  one serverspace; OPEN, SEALED (B) and SEALED_KID (inherits); four documents; two production files');

const T_CAL2 = browserToken(CAL, 'aal2');
const T_CAL1 = browserToken(CAL, 'aal1');
const T_BOB2 = browserToken(BOB, 'aal2');
const T_CONN = connectorToken(CAL);
const objectRows = (token, bucket, name) =>
  sqlAs(token, 'select name from storage.objects where bucket_id = $1 and name = $2', [bucket, name]);

// ---------------------------------------------------------------------------
// A. The negative control — no 096.
// ---------------------------------------------------------------------------
console.log('\n--- A. without 096 ------------------------------------------------');
check((await objectRows(T_CAL2, 'vault-documents', D_SEALED.path)).length === 1,
  'aal2 member reads a SEALED matter\'s object directly (the gap S4a closes)');
check((await objectRows(T_CAL2, 'discovery-files', DISC_SEALED)).length === 1,
  'aal2 member reads a SEALED matter\'s production file directly');
const updatePoliciesBefore = (await q(
  `select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd = 'UPDATE' order by 1`))
  .map((r) => r.policyname);
check(updatePoliciesBefore.some((n) => n.startsWith('Members can move vault-documents files')),
  '049\'s UPDATE policy exists before 096 (spec §1\'s "no UPDATE policy" is out of date)', updatePoliciesBefore.join(', '));

// ---------------------------------------------------------------------------
// B. 096 — the bucket.
// ---------------------------------------------------------------------------
console.log('\n--- B. 096, the bucket ---------------------------------------------');
await db.exec(migrationSql('096_sealed_storage_gate.sql'));
let rerun = null;
try { await db.exec(migrationSql('096_sealed_storage_gate.sql')); } catch (e) { rerun = e; }
check(!rerun, '096 executes twice (re-runnable)', rerun?.message);

check((await objectRows(T_CAL2, 'vault-documents', D_SEALED.path)).length === 0,
  'aal2 member: a SEALED object is refused at the bucket');
check((await objectRows(T_CAL2, 'vault-documents', D_KID.path)).length === 0,
  'aal2 member: an object in an open-tier matter under a sealed parent is refused (inherited)');
check((await objectRows(T_CAL2, 'vault-documents', D_OPEN.path)).length === 1,
  'aal2 member: an OPEN matter\'s object is still read directly');
check((await objectRows(T_CAL1, 'vault-documents', D_OPEN.path)).length === 1,
  'aal1 member: an OPEN matter\'s object is still read directly');
check((await objectRows(T_CAL2, 'discovery-files', DISC_SEALED)).length === 0,
  'discovery-files: a SEALED matter\'s production file is refused at the bucket');
check((await objectRows(T_CAL2, 'discovery-files', DISC_OPEN)).length === 1,
  'discovery-files: an OPEN matter\'s production file is still read directly');
check((await objectRows(T_BOB2, 'vault-documents', D_OPEN.path)).length === 0
  && (await objectRows(T_BOB2, 'discovery-files', DISC_OPEN)).length === 0,
  'a stranger reads nothing, open or sealed');
check((await objectRows(null, 'vault-documents', D_OPEN.path)).length === 0,
  'anon reads nothing (no policy for anon)');
check((await objectRows(SERVICE_KEY, 'vault-documents', D_SEALED.path)).length === 1
  && (await objectRows(SERVICE_KEY, 'discovery-files', DISC_SEALED)).length === 1,
  'the service role (worker, endpoint) still reads sealed objects');
{
  const r = await attemptAs(T_CAL2, `select name from storage.objects where bucket_id = 'vault-documents'`);
  check(!r.err && !r.rows.some((x) => x.name.startsWith('loose-')),
    'a non-uuid path is simply invisible — the policy cannot throw on it', r.err?.message);
}

// Writes. Storage writes an upload with INSERT … RETURNING, and Postgres
// holds the returned row to the SELECT policy.
const NEW_SEALED = `${SEALED}/${crypto.randomUUID()}/new-upload.pdf`;
{
  const r = await attemptAs(T_CAL2,
    `insert into storage.objects (bucket_id, name) values ('vault-documents', $1) returning id, name`, [NEW_SEALED]);
  check(!r.err && r.rows?.length === 1, 'a NEW upload into a sealed matter still works (INSERT … RETURNING)', r.err?.message);
}
{
  const r = await attemptAs(T_CAL2,
    `insert into storage.objects (bucket_id, name) values ('vault-documents', $1)
     on conflict (bucket_id, name) do update set updated_at = now() returning id`,
    [`${SEALED}/${crypto.randomUUID()}/new-upsert.pdf`]);
  check(!r.err && r.rows?.length === 1, 'a NEW upsert into a sealed matter still works (upload with upsert:true)', r.err?.message);
}
check((await objectRows(T_CAL2, 'vault-documents', NEW_SEALED)).length === 0,
  '…and the moment its transaction ends, the new object is as closed as any other');
{
  const r = await attemptAs(T_CAL2,
    `insert into storage.objects (bucket_id, name) values ('vault-documents', $1)
     on conflict (bucket_id, name) do update set updated_at = now() returning id`, [D_SEALED.path]);
  check(Boolean(r.err), 'OVERWRITE of an existing sealed object is refused (upsert onto it)', r.err?.message?.slice(0, 80));
}
{
  const r = await attemptAs(T_CAL2,
    `update storage.objects set name = $2 where bucket_id = 'vault-documents' and name = $1 returning name`,
    [D_SEALED.path, `${OPEN}/${D_SEALED.id}/advice.pdf`]);
  check(!r.err && r.rows?.length === 0, 'a user-JWT MOVE of a sealed object out of the matter reaches nothing', r.err?.message);
}
{
  const r = await attemptAs(T_CAL2,
    `update storage.objects set created_at = now() where bucket_id = 'vault-documents' and name = $1 returning name`,
    [D_SEALED.path]);
  const still = await objectRows(T_CAL2, 'vault-documents', D_SEALED.path);
  check(!r.err && r.rows?.length === 0 && still.length === 0,
    'rewriting created_at to "now" cannot open an existing sealed object (the UPDATE never reaches it)');
}
{
  // A DELETE reads the rows it removes, so the SELECT policy applies: a
  // user's remove() of a sealed object matches nothing (and storage reports
  // success). Named in 096's header: the Vault's delete leaves an orphan.
  const r = await attemptAs(browserToken(ADA, 'aal2'),
    `delete from storage.objects where bucket_id = 'vault-documents' and name = $1 returning name`, [D_KID.path]);
  const still = await objectRows(SERVICE_KEY, 'vault-documents', D_KID.path);
  check(!r.err && r.rows?.length === 0 && still.length === 1,
    'a user-JWT DELETE of a sealed object (even by the owner) reaches nothing — the object stays (named in the header)',
    r.err?.message);
  const r2 = await attemptAs(browserToken(ADA, 'aal2'),
    `delete from storage.objects where bucket_id = 'vault-documents' and name = $1 returning name`, [NEW_SEALED]);
  check(!r2.err && r2.rows?.length === 0, '…the same for an object uploaded a moment ago (its transaction has ended)');
}
const updatePoliciesAfter = (await q(
  `select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd = 'UPDATE' order by 1`))
  .map((r) => r.policyname);
check(JSON.stringify(updatePoliciesAfter) === JSON.stringify(updatePoliciesBefore),
  '096 adds no UPDATE policy and leaves 049\'s as it was');
{
  const db2 = new PGlite();
  let err = null;
  try { await db2.exec(migrationSql('096_sealed_storage_gate.sql')); } catch (e) { err = e; }
  check(Boolean(err) && /needs migration 094/.test(err.message), '096 refuses to run without 094', err?.message);
  await db2.close();
}

// ---------------------------------------------------------------------------
// C. /api/document-url
// ---------------------------------------------------------------------------
console.log('\n--- C. /api/document-url -------------------------------------------');
const { default: handler } = await import('../api/document-url.mjs');

const call = async (token, body) => {
  const req = {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  };
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(s) { this.body = s ? JSON.parse(s) : null; },
  };
  await handler(req, res, { fetchImpl: stubFetch });
  return { status: res.statusCode, body: res.body };
};
const events = async () => q(
  `select kind, matterspace_id, actor_kind, actor_ref, actor_user_id, payload from public.events order by ts, seq`);
const around = async (fn) => {
  const e0 = (await events()).length;
  const m0 = mints.length;
  const out = await fn();
  const all = await events();
  return { ...out, newEvents: all.slice(e0), newMints: mints.slice(m0) };
};

{
  const r = await around(() => call(null, { document_id: D_SEALED.id, purpose: 'read' }));
  check(r.status === 401 && r.body?.error === 'missing_bearer' && r.newMints.length === 0 && r.newEvents.length === 0,
    'no bearer: 401, nothing minted, nothing written', `${r.status} ${r.body?.error}`);
}
{
  const r = await around(() => call('not.a-real.token', { document_id: D_SEALED.id, purpose: 'read' }));
  check(r.status === 401 && r.newMints.length === 0 && r.newEvents.length === 0,
    'a bearer Supabase Auth does not accept: 401, nothing minted', `${r.status}`);
}
{
  const r = await around(() => call(T_CAL2, { document_id: D_SEALED.id, purpose: 'read' }));
  const e = r.newEvents;
  check(r.status === 200 && typeof r.body?.url === 'string' && r.body.sealed === true && r.body.expires_in === 900,
    'aal2 member, sealed, read: a 900 s URL', `${r.status} ${JSON.stringify(r.body)?.slice(0, 120)}`);
  check(r.newMints.length === 1 && r.newMints[0].role === 'service_role' && r.newMints[0].name === D_SEALED.path,
    '…minted by the service role, for the row\'s own path');
  check(e.length === 1 && e[0].kind === 'file.opened' && e[0].matterspace_id === SEALED
    && e[0].payload.purpose === 'read' && e[0].payload.sealed === true
    && e[0].payload.document_id === D_SEALED.id && e[0].payload.title === 'Advice memo'
    && e[0].actor_kind === 'user' && e[0].actor_user_id === CAL,
  '…and file.opened {document_id, title, purpose:read, sealed:true} is on the SEALED chain, by the person',
  JSON.stringify(e.map((x) => [x.kind, x.payload])));
}
{
  const r = await around(() => call(T_CAL2, { document_id: D_SEALED.id, purpose: 'download' }));
  const kinds = r.newEvents.map((x) => x.kind).sort();
  const exp = r.newEvents.find((x) => x.kind === 'file.exported');
  const op = r.newEvents.find((x) => x.kind === 'file.opened');
  check(r.status === 200 && /download=advice\.pdf/.test(r.body?.url ?? ''),
    'aal2 member, sealed, download: a URL that saves under the filed name', r.body?.url);
  check(JSON.stringify(kinds) === JSON.stringify(['file.exported', 'file.opened'])
    && op?.payload.purpose === 'download' && exp?.payload.destination === 'download',
  '…file.opened {purpose:download} AND file.exported {destination:download}', JSON.stringify(kinds));
}
{
  const r = await around(() => call(T_CAL2, { document_id: D_KID.id, purpose: 'read' }));
  check(r.status === 200 && r.body?.sealed === true && r.newEvents[0]?.kind === 'file.opened'
    && r.newEvents[0]?.matterspace_id === SEALED_KID,
  'inherited seal: the sub-matter\'s document is sealed=true and recorded on the sub-matter\'s chain');
}
{
  const r = await around(() => call(T_CAL1, { document_id: D_SEALED.id, purpose: 'read' }));
  check(r.status === 403 && r.body?.error === 'step_up_required' && r.body?.mode === 'stepup' && r.body?.matter_id === SEALED,
    'aal1 member, sealed: 403 step_up_required {mode:stepup} — the StepUpPrompt\'s cue', JSON.stringify(r.body));
  check(r.newMints.length === 0 && r.newEvents.length === 0, '…nothing minted, nothing written');
}
{
  const r = await around(() => call(T_CAL1, { document_id: D_SEALED.id, purpose: 'download' }));
  check(r.status === 403 && r.newMints.length === 0 && r.newEvents.length === 0,
    'aal1 member, sealed, download: refused the same way, nothing minted, nothing written');
}
{
  const r = await around(() => call(T_CAL2, { document_id: D_OPEN.id, purpose: 'read' }));
  check(r.status === 200 && r.body?.sealed === false && r.newEvents.length === 0,
    'open matter, read: served, and NOTHING written (open-to-read is not recorded on Tier A)');
}
{
  const r = await around(() => call(T_CAL1, { document_id: D_OPEN.id, purpose: 'download' }));
  const e = r.newEvents;
  check(r.status === 200 && e.length === 1 && e[0].kind === 'file.exported'
    && e[0].payload.destination === 'download' && e[0].payload.sealed === false
    && e[0].matterspace_id === OPEN && e[0].payload.document_id === D_OPEN.id,
  'open matter, download (even at aal1): file.exported {destination:download} on the OPEN chain, no file.opened',
  JSON.stringify(e.map((x) => [x.kind, x.payload])));
}
{
  const r1 = await around(() => call(T_BOB2, { document_id: D_SEALED.id, purpose: 'read' }));
  const r2 = await around(() => call(T_BOB2, { document_id: D_OPEN.id, purpose: 'download' }));
  const r3 = await around(() => call(T_BOB2, { bucket: 'discovery-files', path: DISC_OPEN, purpose: 'read' }));
  check([r1, r2, r3].every((r) => r.status === 404 && r.body?.error === 'not_found' && r.newMints.length === 0 && r.newEvents.length === 0),
    'a non-member: not_found everywhere (sealed, open, discovery), nothing minted, nothing written',
    [r1, r2, r3].map((r) => r.status).join(' '));
}
{
  const r = await around(() => call(T_CONN, { document_id: D_SEALED.id, purpose: 'read' }));
  check(r.status === 403 && r.body?.error === 'browser_sessions_only' && r.newMints.length === 0,
    'a connector-stamped token (094 lets it past the gate) is refused at this door');
}
{
  const r = await around(() => call(T_CAL2, { document_id: D_POINTER.id, purpose: 'read' }));
  check(r.status === 409 && r.body?.error === 'path_mismatch' && r.newMints.length === 0 && r.newEvents.length === 0,
    'a row in an OPEN matter pointing at a SEALED object: refused before any mint', `${r.status} ${r.body?.error}`);
}
{
  const r = await around(() => call(T_CAL2, { path: D_SEALED.path, purpose: 'read' }));
  check(r.status === 200 && r.newEvents[0]?.payload.document_id === D_SEALED.id,
    'by path: the document is found as the user and recorded by its id');
  const r2 = await around(() => call(T_CAL2, { path: `${SEALED}/${D_OPEN.id}/advice.pdf`, purpose: 'read' }));
  check(r2.status === 404 && r2.newMints.length === 0 && r2.newEvents.length === 0,
    'by path: a path naming a document that does not own it is not_found, nothing minted');
}
{
  const r = await around(() => call(T_CAL2, { bucket: 'discovery-files', path: DISC_SEALED, purpose: 'download' }));
  const kinds = r.newEvents.map((x) => x.kind).sort();
  check(r.status === 200 && r.body?.sealed === true && r.newMints[0]?.bucket === 'discovery-files'
    && JSON.stringify(kinds) === JSON.stringify(['file.exported', 'file.opened'])
    && r.newEvents.every((x) => x.payload.bucket === 'discovery-files' && x.payload.title === 'ORM-000001.msg'),
  'discovery-files, sealed, download: minted + file.opened + file.exported {bucket}', JSON.stringify(kinds));
}
{
  const r = await around(() => call(T_CAL1, { bucket: 'discovery-files', path: DISC_SEALED, purpose: 'read' }));
  check(r.status === 403 && r.body?.error === 'step_up_required' && r.newMints.length === 0 && r.newEvents.length === 0,
    'discovery-files, sealed, aal1: step_up_required, nothing minted');
}
{
  const r = await around(() => call(T_CAL2, { bucket: 'discovery-files', path: `${OPEN}/../${SEALED}/prod-1/natives/ORM-000001.msg`, purpose: 'read' }));
  const r2 = await around(() => call(T_CAL2, { bucket: 'discovery-files', path: `${OPEN}//x`, purpose: 'read' }));
  check(r.status === 400 && r2.status === 400 && r.newMints.length === 0 && r2.newMints.length === 0,
    'a caller-named path with .. or an empty segment is refused before anything is asked');
}
{
  failLedgerOnce = true;
  const r = await around(() => call(T_CAL2, { document_id: D_SEALED.id, purpose: 'read' }));
  check(r.status === 503 && r.body?.error === 'record_failed' && !r.body?.url && r.newEvents.length === 0,
    'sealed, and the Record cannot be written: 503, the minted URL is NOT handed out', `${r.status} ${JSON.stringify(r.body)}`);
}
{
  failLedgerOnce = true;
  const r = await around(() => call(T_CAL2, { document_id: D_OPEN.id, purpose: 'download' }));
  check(r.status === 200 && r.body?.recorded === false && typeof r.body?.url === 'string',
    'open matter, Record unavailable: the download still works and says recorded:false (the direct path exists anyway)');
}
{
  const r = await call(T_CAL2, { document_id: D_SEALED.id, purpose: 'print' });
  check(r.status === 400, 'an unknown purpose is refused');
}

// ---------------------------------------------------------------------------
// D. get_media
// ---------------------------------------------------------------------------
console.log('\n--- D. get_media -----------------------------------------------------');
const { createClient } = await import('@supabase/supabase-js');
const { handleGetMedia } = await import('../lib/mcp-core.mjs');
const clientFor = (token) => createClient(SUPABASE_URL, token === SERVICE_KEY ? SERVICE_KEY : ANON_KEY, {
  global: { fetch: stubFetch, headers: token === SERVICE_KEY ? {} : { Authorization: `Bearer ${token}` } },
  auth: { persistSession: false, autoRefreshToken: false },
});
// The shape api/mcp.mjs gives an agent connection (callToolOptsFor).
const CONNECTOR_ACTOR = { kind: 'connector', ref: 'agent:7e57a9e0-0000-4000-8000-000000000001', user_id: CAL, label: 'Research agent (claude)' };
const connClient = clientFor(T_CONN);
const serviceClient = clientFor(SERVICE_KEY);
{
  const e0 = (await events()).length;
  let out = null; let err = null;
  try {
    out = await handleGetMedia(connClient, { document_id: D_SEALED.id, expires_in: 3600 },
      { actor: CONNECTOR_ACTOR, storageClient: serviceClient });
  } catch (e) { err = e; }
  const e = (await events()).slice(e0);
  check(!err && typeof out?.stream_url === 'string' && out.expires_in_seconds === 900,
    'get_media, sealed: a URL, capped at 900 s whatever was asked', err?.message);
  check(e.length === 1 && e[0].kind === 'file.opened' && e[0].matterspace_id === SEALED
    && e[0].actor_kind === 'connector' && e[0].actor_ref === CONNECTOR_ACTOR.ref
    && e[0].payload.via === 'connector' && e[0].payload.purpose === 'read' && e[0].payload.document_id === D_SEALED.id,
  '…file.opened {purpose:read, via:connector} with the connector as the actor', JSON.stringify(e.map((x) => [x.kind, x.actor_kind, x.payload])));
}
{
  const e0 = (await events()).length;
  const m0 = mints.length;
  let err = null;
  try {
    await handleGetMedia(connClient, { document_id: D_SEALED.id }, { actor: CONNECTOR_ACTOR });
  } catch (e) { err = e; }
  const e = (await events()).slice(e0);
  check(Boolean(err) && /sign url/.test(err.message) && e.length === 0 && mints.length === m0,
    'get_media, sealed, no service-role minter: the bucket refuses, nothing is written', err?.message);
}
{
  const e0 = (await events()).length;
  let out = null; let err = null;
  try {
    out = await handleGetMedia(connClient, { document_id: D_OPEN.id }, { actor: CONNECTOR_ACTOR });
  } catch (e) { err = e; }
  const e = (await events()).slice(e0);
  check(!err && typeof out?.stream_url === 'string' && !e.some((x) => x.kind === 'file.opened'),
    'get_media, open matter: served with the caller\'s own client, no file.opened', err?.message);
}
{
  failLedgerOnce = true;
  let out = null; let err = null;
  try {
    out = await handleGetMedia(connClient, { document_id: D_SEALED.id }, { actor: CONNECTOR_ACTOR, storageClient: serviceClient });
  } catch (e) { err = e; }
  check(Boolean(err) && !out && /Record could not be written/.test(err.message),
    'get_media, sealed, Record unavailable: no link is issued', err?.message);
}

// ---------------------------------------------------------------------------
// E. The source
// ---------------------------------------------------------------------------
console.log('\n--- E. the source ----------------------------------------------------');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
  d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
const offenders = [];
for (const f of walk(path.join(ROOT, 'src')).filter((f) => /\.(ts|tsx)$/.test(f))) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (rel === 'src/lib/vault-object.ts') continue;
  const text = fs.readFileSync(f, 'utf8');
  if (!/vault-documents|discovery-files|DISCOVERY_BUCKET|VAULT_BUCKET/.test(text)) continue;
  if (/\.(createSignedUrl|createSignedUrls|download)\s*\(/.test(text)) offenders.push(rel);
}
check(offenders.length === 0,
  'no browser file that names either bucket signs or downloads from storage itself — only src/lib/vault-object.ts',
  offenders.join(', '));
const endpointSrc = fs.readFileSync(path.join(ROOT, 'api', 'document-url.mjs'), 'utf8');
const recorded = (await events()).filter((e) => ['file.opened', 'file.exported'].includes(e.kind));
check(recorded.length > 0 && recorded.every((e) => !JSON.stringify(e.payload).match(/token=|storage_path|\/storage\/v1|signed-/)),
  'no Record row carries a URL, a token or a storage path');
check(/record\(ledger/.test(endpointSrc) && !/payload:[^\n]*objectPath/.test(endpointSrc),
  'the endpoint records through lib/ledger.mjs, never the object path');
const sql096 = migrationSql('096_sealed_storage_gate.sql').replace(/--.*$/gm, '');
check(!/for\s+update/i.test(sql096) && !/for\s+all/i.test(sql096),
  '096 creates no UPDATE (or ALL) policy');
check(!/\bto\s+anon\b/i.test(sql096), '096 grants anon nothing');

await db.close();
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
