// Execute migration 098 against a real Postgres and prove that the seal is
// checked wherever a sealed matter's rows are read or moved — not only at the
// matter's front door, which is all 094 guarded.
//
// Why this exists
// ---------------------------------------------------------------------------
// The adversarial review of #245 (migration 094) found, with probes like the
// ones below, that the second-factor gate on sealed matters held at matter
// entry and nowhere else:
//   CRITICAL-2  an aal1 session moved a sealed matter's documents and passages
//               into an open matter, and the seal was gone for everyone;
//   CRITICAL-1  any session could mint a csp_ connector token, whose JWT 094
//               exempts, and /api/ext/* listed sealed documents and pushed
//               their bytes to Drive;
//   HIGH-3      documents were read by id without entering the matter;
//   HIGH-5      the grace compared the EARLIEST sign-in with the date and never
//               the clock;
//   MEDIUM-6    comments, conversations, content and the activity feed used
//               can_access_matter alone;
//   MEDIUM-7    signing a device out needed no second factor.
// Every one of those is replayed here as a caller — SET ROLE authenticated
// with request.jwt.claims set the way PostgREST sets them — against the REAL
// migration chain 001…095 (every file, in order: PGlite runs them all), then
// again after 098.
//
// Parts:
//   A. Negative control: the chain through 095, NO 098. The reviewer's exact
//      row move succeeds; a sealed document is readable by id at aal1. (If
//      they did not, nothing below would prove 098 is what refuses.) The
//      search and per-row timings are taken here, as "before".
//   B. 098, twice. sealed_effective equals the ancestry walk everywhere, and
//      follows a tier change / a re-parent down the tree, and cannot be written
//      by hand.
//   C. The reviewer's row move, and every way back out of the seal.
//   D. Reads by id: documents, passages, comments, conversations, content,
//      storage objects, the activity feed; aal1-with-factor refused, aal2
//      allowed, connector stamp exempt (the seal governs it in code), anon
//      empty rather than an error.
//   E. The grace: before the date, after it (the LATEST sign-in decides), and
//      after the hard end (date + 7 days) nobody without aal2.
//   F. The probes: matter_entry still says 'stepup' to a member;
//      document_entry says the same by document id; neither is an oracle.
//   G. connector_tokens: no direct insert; connector_token_create asks for
//      the factor; token_hash cannot be overwritten; revoke still works.
//   H. account_session_revoke asks for the factor.
//   I. /api/ext/documents, /api/ext/matters and /api/ext/push-to-drive driven
//      with a client that runs as the connector's own JWT against this
//      database: sealed matters are not listed, not served, not pushed —
//      confirmed or not — and the refusal is in the Record.
//   J. Search: identical results for open matters; timings before and after
//      (PGlite is single-process WASM — the numbers are a smoke check of the
//      plan's shape, not a production benchmark; see the note printed).
//
//   npm i --no-save @electric-sql/pglite@0.5.8 @electric-sql/pglite-pgvector@0.0.9
//   node scripts/_verify-seal-in-access.mjs
//
// Touches nothing outside this process. No .env, no network, no production.

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

let PGlite, uuid_ossp, vector, pg_trgm;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
  ({ pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm'));
  ({ vector } = await import('@electric-sql/pglite-pgvector'));
} catch {
  console.error('Run:  npm i --no-save @electric-sql/pglite@0.5.8 @electric-sql/pglite-pgvector@0.0.9');
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');
const M098 = '098_seal_in_access_helpers.sql';
const migration = (name) => fs.readFileSync(path.join(MIG_DIR, name), 'utf8');

process.on('uncaughtException', (e) => { console.error(`\n  ERROR: ${e?.stack ?? e}\n`); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(`\n  ERROR: ${e?.stack ?? e}\n`); process.exit(1); });

let failures = 0;
let passes = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  if (ok) passes += 1; else failures += 1;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 70 - t.length))}`);

const db = new PGlite({ extensions: { uuid_ossp, vector, pg_trgm } });
const q = async (sql, params) => (await db.query(sql, params)).rows;

// ---------------------------------------------------------------------------
// Sessions. A session is the claims PostgREST would set. `null` = the
// superuser (fixtures, and the stand-in for the service role's view).
// ---------------------------------------------------------------------------
const secs = (d) => Math.floor(new Date(d).getTime() / 1000);
const aal1 = (uid, signedIn = Date.now()) => ({
  sub: uid, role: 'authenticated', aud: 'authenticated', aal: 'aal1',
  amr: [{ method: 'password', timestamp: secs(signedIn) }],
});
const aal2 = (uid) => ({
  sub: uid, role: 'authenticated', aud: 'authenticated', aal: 'aal2',
  amr: [{ method: 'password', timestamp: secs(Date.now() - 3600e3) }, { method: 'totp', timestamp: secs(Date.now()) }],
});
// What lib/supabase-user-jwt.mjs signs for api/mcp.mjs, the stdio server and /api/ext/*.
const connector = (uid) => ({ sub: uid, role: 'authenticated', aud: 'authenticated', iss: 'supabase', cs_via: 'connector' });
const ANON = { role: 'anon' };

async function as(claims, fn) {
  await db.exec('reset role');
  if (claims === null) {
    await db.query(`select set_config('request.jwt.claims', '', false)`);
    return fn();
  }
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(claims.role === 'anon' ? 'set role anon' : 'set role authenticated');
  try { return await fn(); } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}
const qa = (claims, sql, params) => as(claims, () => q(sql, params));
const tryAs = async (claims, sql, params) => {
  try { return { rows: await qa(claims, sql, params), err: null }; } catch (err) { return { rows: null, err }; }
};

// ---------------------------------------------------------------------------
// The database: Supabase's auth/storage stand-ins, then every migration up to
// 095 exactly as written.
// ---------------------------------------------------------------------------
section('the chain: every migration 001…095, as written');
await db.exec(`
  create extension if not exists vector;
  create extension if not exists pg_trgm;
  create extension if not exists "uuid-ossp";
  do $$ begin create role anon;                   exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated;          exception when duplicate_object then null; end $$;
  do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
  create schema if not exists auth;
  create schema if not exists storage;
  create schema if not exists extensions;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text not null,
    raw_user_meta_data jsonb not null default '{}'::jsonb);
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid $$;
  create or replace function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim', true), ''),
      nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
  create or replace function auth.role() returns text language sql stable as $$
    select coalesce(auth.jwt() ->> 'role', '') $$;
  create table auth.mfa_factors (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    friendly_name text, factor_type text not null, status text not null,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now());
  create table auth.sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    created_at timestamptz default now(), updated_at timestamptz default now(),
    factor_id uuid, aal text, not_after timestamptz, refreshed_at timestamp,
    user_agent text, ip inet, tag text);
  create table storage.buckets (id text primary key, name text, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text,
    name text, owner uuid, created_at timestamptz default now(), metadata jsonb);
  alter table storage.objects enable row level security;
  create or replace function storage.foldername(p_name text) returns text[]
    language sql immutable as $$ select string_to_array(p_name, '/') $$;
  grant usage on schema public, auth, storage to anon, authenticated, service_role;
  grant select on storage.objects to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.jwt(), auth.role() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  create publication supabase_realtime;
`);
const chain = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql') && f < '098').sort();
for (const f of chain) {
  try { await db.exec(migration(f)); } catch (err) {
    console.error(`  ${f} failed: ${err.message}`);
    process.exit(1);
  }
}
check(chain.length > 80 && chain.at(-1).startsWith('095'), `${chain.length} migrations applied, last ${chain.at(-1)}`);

// ---------------------------------------------------------------------------
// People, matters, rows.
// ---------------------------------------------------------------------------
const signup = async (email) => (await q(`insert into auth.users (email) values ($1) returning id`, [email]))[0].id;
const EDEN = await signup('eden@firm.test');      // serverspace owner, has a factor
const MEM = await signup('mem@firm.test');        // serverspace member, has a factor
const GRACE = await signup('grace@firm.test');    // serverspace member, NO factor
const OUT = await signup('out@elsewhere.test');   // nobody here
const ADM = await signup('adm@firm.test');        // serverspace ADMIN, NO factor (round 2: may unseal?)
for (const u of [EDEN, MEM]) {
  await q(`insert into auth.mfa_factors (user_id, factor_type, status) values ($1, 'totp', 'verified')`, [u]);
}
// An unverified factor does not count as one.
await q(`insert into auth.mfa_factors (user_id, factor_type, status) values ($1, 'totp', 'unverified')`, [GRACE]);

const [firm] = await q(`insert into public.serverspaces (clientspace_id, name)
  select id, 'Quainton Law' from public.clientspaces where user_id = $1 returning id`, [EDEN]);
for (const [u, role] of [[EDEN, 'owner'], [MEM, 'member'], [GRACE, 'member'], [ADM, 'admin']]) {
  await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,$3)
    on conflict (serverspace_id, user_id) do update set role = excluded.role`, [firm.id, u, role]);
}
const matter = async (name, tier = 'A', parent = null) => (await q(
  `insert into public.matterspaces (serverspace_id, name, ai_tier, parent_matterspace_id)
   values ($1,$2,$3,$4) returning id`, [firm.id, name, tier, parent]))[0].id;
const OPEN = await matter('Open matter');
const SEALED = await matter('Sealed matter', 'B');
const SEALED_KID = await matter('Open-tier folder inside the sealed matter', 'A', SEALED);
const ROOT_M = await matter('Tree root');
const MID = await matter('Tree middle', 'A', ROOT_M);
const LEAF = await matter('Tree leaf', 'A', MID);

const doc = async (m, title) => (await q(
  `insert into public.documents (matterspace_id, title, doc_type, created_by, storage_path, source_filename)
   values ($1,$2,'deposition',$3,$4,'x.pdf') returning id`, [m, title, EDEN, null]))[0].id;
const DOC_O = await doc(OPEN, 'Open deposition');
const DOC_S = await doc(SEALED, 'SEALED-TITLE privileged memo');
const DOC_K = await doc(SEALED_KID, 'SEALED-TITLE inside the sealed folder');
for (const [d, m] of [[DOC_O, OPEN], [DOC_S, SEALED], [DOC_K, SEALED_KID]]) {
  await q(`update public.documents set storage_path = $2 || '/' || id || '/x.pdf' where id = $1`, [d, m]);
  await q(`insert into storage.objects (bucket_id, name) values ('vault-documents', $1 || '/' || $2 || '/x.pdf')`, [m, d]);
}
const passage = async (d, m, n, text) => (await q(
  `insert into public.passages (document_id, matterspace_id, sequence_number, text)
   values ($1,$2,$3,$4) returning id`, [d, m, n, text]))[0].id;
const P_O = await passage(DOC_O, OPEN, 1, 'The witness testified about the deposition schedule.');
const P_S = await passage(DOC_S, SEALED, 1, 'Privileged: the deposition strategy we will not disclose.');
await passage(DOC_K, SEALED_KID, 1, 'Privileged folder note about the deposition.');

// A comment (the General thread, 091), a page (content_items), a meeting.
const COMMENT_S = (await q(`insert into public.matter_comments (matterspace_id, user_id, body)
  values ($1,$2,'SEALED-TITLE remark in the thread') returning id`, [SEALED, EDEN]))[0].id;
await q(`insert into public.matter_comments (matterspace_id, user_id, body) values ($1,$2,'open remark')`, [OPEN, EDEN]);
const PAGE_S = (await q(`insert into public.content_items (space_id, space_type, content_type, title, created_by)
  values ($1,'matterspace','page','SEALED-TITLE strategy page',$2) returning id`, [SEALED, EDEN]))[0].id;
await q(`insert into public.meetings (matterspace_id, created_by, title) values ($1,$2,'SEALED-TITLE meeting')`, [SEALED, EDEN]);
// Round 2 (N1): the reviewer's sealed-pen transcript, and a Record row Eden
// wrote in the sealed matter (as her aal2 self, through ledger_append).
const [PEN] = await q(`insert into public.ai_sessions (matterspace_id, owner_id, title, tier)
  values ($1,$2,'SEALED-TITLE pen session','B') returning id`, [SEALED, EDEN]);
await q(`insert into public.ai_messages (session_id, seq, role, content)
  values ($1,1,'assistant','[{"type":"text","text":"SEALED-TEXT: the deposition strategy is ..."}]'::jsonb)`, [PEN.id]);
// Round 2 (N2): Office shelves, one for Eden (the room's owner) and one for Mem.
const shelf = async (u) => (await q(`insert into public.office_sections (owner_id, kind, title) values ($1,'library','Shelf') returning id`, [u]))[0].id;
const SHELF_E = await shelf(EDEN);
const SHELF_M = await shelf(MEM);

// The timing fixture: a few thousand passages in each of the two matters.
const BULK = 2500;
const BULK_O = await doc(OPEN, 'Bulk open transcript');
const BULK_S = await doc(SEALED, 'SEALED-TITLE bulk transcript');
for (const [d, m] of [[BULK_O, OPEN], [BULK_S, SEALED]]) {
  await q(`insert into public.passages (document_id, matterspace_id, sequence_number, text)
    select $1, $2, g, 'Line ' || g || ' of the deposition transcript, witness answers about ' ||
      (array['causation','damages','notice','timing','contract'])[1 + g % 5]
      from generate_series(2, $3::int + 1) g`, [d, m, BULK]);
}
await db.exec('analyze');
check(true, `fixture: 6 matters, ${2 * BULK + 3} passages, 3 people with sessions, 1 outsider`);

// ---------------------------------------------------------------------------
// Timing helpers (used before and after 098)
// ---------------------------------------------------------------------------
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
async function timed(claims, sql, params, runs = 7) {
  const ms = [];
  let rows = null;
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    rows = await qa(claims, sql, params);
    ms.push(performance.now() - t0);
  }
  return { ms: median(ms), rows };
}
async function explainTime(claims, sql, params) {
  const plan = (await qa(claims, `explain (analyze, buffers off, timing on) ${sql}`, params)).map((r) => r['QUERY PLAN']);
  const exec = plan.find((l) => /Execution Time/.test(l)) ?? '';
  const filter = plan.find((l) => /Filter:/.test(l)) ?? '';
  return { exec: exec.trim(), filter: filter.trim().slice(0, 110) };
}
const SEARCH = `select passage_id from public.search_passages($1::uuid[], 'deposition witness', null, null, null, null, 0, 50) order by passage_id`;
const DIRECT = `select count(*)::int n from public.passages where matterspace_id = $1`;
async function measure(label) {
  const out = {};
  out.searchOpen = await timed(aal2(MEM), SEARCH, [[OPEN]]);
  out.searchBoth = await timed(aal2(MEM), SEARCH, [[OPEN, SEALED]]);
  out.directOpenAal1 = await timed(aal1(MEM), DIRECT, [OPEN]);
  out.directSealedAal2 = await timed(aal2(MEM), DIRECT, [SEALED]);
  out.directSealedAal1 = await timed(aal1(MEM), DIRECT, [SEALED]);
  out.explainSealedAal2 = await explainTime(aal2(MEM), DIRECT, [SEALED]);
  out.explainSealedAal1 = await explainTime(aal1(MEM), DIRECT, [SEALED]);
  out.label = label;
  return out;
}

// ===========================================================================
section('A. negative control — the chain through 095, no 098');
// ===========================================================================
await qa(aal2(EDEN), `select public.ledger_append('tool.invoked', $1, null, null, 'user', $2, null,
  '{"tool":"get_passage","document_ids":["x"]}'::jsonb)`, [SEALED, EDEN]);
const PEN_READS = {
  'ai_messages (the sealed pen transcript)': `select content::text c from public.ai_messages where content::text like '%SEALED-TEXT%'`,
  'ai_sessions': `select id from public.ai_sessions where matterspace_id = '${SEALED}'`,
  'events (the Record) of the sealed matter': `select id from public.events where matterspace_id = '${SEALED}'`,
};
{
  for (const [label, sql] of Object.entries(PEN_READS)) {
    const r = await qa(aal1(EDEN), sql);
    check(r.length > 0, `pre-098: aal1 owner reads their own ${label} in the sealed matter (N1 reproduced)`);
  }
  const viaServerspace = await qa(aal1(MEM), PEN_READS['events (the Record) of the sealed matter']);
  check(viaServerspace.length > 0, 'pre-098: a serverspace member at aal1 reads the sealed matter Record through the serverspace fallback');
  const shelved = await tryAs(aal1(MEM), `insert into public.office_items (owner_id, section_id, document_id, title)
    values ($1,$2,$3,'shelved') returning id`, [MEM, SHELF_M, DOC_S]);
  check(!shelved.err, 'pre-098: an aal1 password holder shelves a SEALED document in the Office (N2 reproduced)', shelved.err?.message ?? '');
  await q(`delete from public.office_items where title = 'shelved'`);

  const byId = await qa(aal1(MEM), `select id, title from public.documents where id = $1`, [DOC_S]);
  check(byId.length === 1, 'pre-098: an aal1 session WITH a factor reads a sealed document by id (HIGH-3 reproduced)');
  const ent = await qa(aal1(MEM), `select public.matter_entry($1) e`, [SEALED]);
  check(ent[0].e === 'stepup', 'pre-098: yet the matter itself says "stepup" — the gate was at the door only');

  // The reviewer's case, verbatim, at aal1 with a factor.
  const s = aal1(MEM);
  const moved = await qa(s, `update public.documents set matterspace_id=$1 where matterspace_id=$2 returning id`, [OPEN, SEALED]);
  const movedP = await qa(s, `update public.passages  set matterspace_id=$1 where matterspace_id=$2 returning id`, [OPEN, SEALED]);
  check(moved.length > 0 && movedP.length > 0,
    `pre-098: aal1 MOVES sealed rows out (CRITICAL-2 reproduced: ${moved.length} documents, ${movedP.length} passages)`);
  // Put them back (as the owner of the tables) so the rest runs on the fixture.
  await q(`update public.documents set matterspace_id=$1 where id = any($2::uuid[])`, [SEALED, moved.map((r) => r.id)]);
  await q(`update public.passages set matterspace_id=$1 where id = any($2::uuid[])`, [SEALED, movedP.map((r) => r.id)]);

  const tok = await tryAs(aal1(MEM), `insert into public.connector_tokens (user_id, token_hash, token_prefix, name)
    values ($1, repeat('a', 64), 'csp_pre098aaaa', 'pre') returning id`, [MEM]);
  check(!tok.err, 'pre-098: an aal1 session with a factor mints a csp_ token directly (CRITICAL-1 reproduced)', tok.err?.message ?? '');
  await q(`delete from public.connector_tokens where token_prefix = 'csp_pre098aaaa'`);
}
const before = await measure('before 098');
const searchBefore = before.searchOpen.rows.map((r) => r.passage_id).join(',');

// ===========================================================================
section('B. 098, applied twice; sealed_effective');
// ===========================================================================
{
  try { await db.exec(migration(M098)); check(true, '098 applies'); } catch (err) { check(false, '098 applies', err.message); process.exit(1); }
  try { await db.exec(migration(M098)); check(true, '098 applies a second time (re-runnable)'); } catch (err) { check(false, '098 re-runs', err.message); process.exit(1); }

  const drift = async () => (await q(`select count(*)::int n from public.matterspaces m
    where m.sealed_effective is distinct from stepup_internal.effective_tier_walk(m.id)`))[0].n;
  const eff = async (id) => (await q(`select sealed_effective s from public.matterspaces where id = $1`, [id]))[0].s;
  check(await drift() === 0, 'the column equals the ancestry walk on every matter');
  check(await eff(SEALED) && await eff(SEALED_KID) && !await eff(OPEN), 'SEALED and its Tier-A child are sealed; OPEN is not');

  // A parent's tier change follows down the tree, as the owner changes it.
  await q(`update public.matterspaces set ai_tier = 'B' where id = $1`, [ROOT_M]);
  check(await eff(ROOT_M) && await eff(MID) && await eff(LEAF), 'sealing the root seals the middle and the leaf');
  await q(`update public.matterspaces set ai_tier = 'A' where id = $1`, [ROOT_M]);
  check(!await eff(ROOT_M) && !await eff(MID) && !await eff(LEAF), 'unsealing the root unseals them again');
  await q(`update public.matterspaces set ai_tier = 'C' where id = $1`, [MID]);
  check(!await eff(ROOT_M) && await eff(MID) && await eff(LEAF), 'a Tier-C middle seals itself and the leaf, not the root');
  // Re-parenting: the leaf moves under OPEN, then under SEALED.
  await q(`update public.matterspaces set parent_matterspace_id = $2 where id = $1`, [LEAF, OPEN]);
  check(!await eff(LEAF), 'a sealed leaf re-parented under an open matter is unsealed');
  await q(`update public.matterspaces set parent_matterspace_id = $2 where id = $1`, [LEAF, SEALED]);
  check(await eff(LEAF), 're-parented under a sealed matter, sealed');
  // One statement that changes a parent and its descendant together.
  await q(`update public.matterspaces set ai_tier = case when id = $1 then 'B' else 'A' end where id in ($1, $2)`, [ROOT_M, MID]);
  check(await drift() === 0, 'one statement changing a parent and a child together still converges');
  // As the person, through RLS: a matter admin writing the column by hand.
  const tamper = await tryAs(aal2(EDEN), `update public.matterspaces set sealed_effective = false where id = $1 returning sealed_effective`, [SEALED]);
  check(!tamper.err && tamper.rows?.[0]?.sealed_effective === true, 'writing sealed_effective = false by hand is overwritten with the truth', tamper.err?.message ?? tamper.rows);
  // A new sub-matter under a sealed parent is born sealed, even if the creator
  // cannot see the parent (the trigger is definer).
  const born = (await q(`insert into public.matterspaces (serverspace_id, name, parent_matterspace_id) values ($1,'born',$2) returning sealed_effective s`, [firm.id, SEALED]))[0].s;
  check(born === true, 'a sub-matter created under a sealed matter is sealed from birth');
  await q(`update public.matterspaces set ai_tier = 'A' where id in ($1,$2)`, [ROOT_M, MID]);
  await q(`update public.matterspaces set parent_matterspace_id = $2 where id = $1`, [LEAF, MID]);
  check(await drift() === 0, 'and after all of it, no drift');
  const wrapper = (await qa(aal2(EDEN), `select public.effective_tier_is_sealed($1) a, public.effective_tier_is_sealed($2) b`, [SEALED_KID, OPEN]))[0];
  check(wrapper.a === true && wrapper.b === false, 'public.effective_tier_is_sealed() is the column, through 094\'s wrapper');
}

// ===========================================================================
section('C. moving rows out of a seal');
// ===========================================================================
{
  // The reviewer's case, verbatim. aal1 session that HAS a factor (gated, no grace).
  const s = aal1(MEM);
  const moved  = await qa(s, `update public.documents set matterspace_id=$1 where matterspace_id=$2 returning id`, [OPEN, SEALED]);
  const movedP = await qa(s, `update public.passages  set matterspace_id=$1 where matterspace_id=$2 returning id`, [OPEN, SEALED]);
  check(moved.length === 0 && movedP.length === 0, 'aal1 must NOT move sealed rows out', { moved: moved.length, movedP: movedP.length });

  // By id, too; and INTO a sealed matter at aal1 (the new row fails WITH CHECK).
  const byId = await qa(s, `update public.documents set matterspace_id=$1 where id=$2 returning id`, [OPEN, DOC_S]);
  check(byId.length === 0, 'aal1: not by id either');
  const inward = await tryAs(s, `update public.documents set matterspace_id=$1 where id=$2 returning id`, [SEALED, DOC_O]);
  check(inward.err?.code === '42501' || inward.rows?.length === 0, 'aal1: an open document cannot be moved INTO a sealed matter either', inward.err?.message ?? inward.rows);
  const ins = await tryAs(s, `insert into public.documents (matterspace_id, title, doc_type, created_by) values ($1,'x','other',$2) returning id`, [SEALED, MEM]);
  check(Boolean(ins.err), 'aal1: no new document in a sealed matter (INSERT WITH CHECK)', ins.err?.code);

  // A grace session (no factor, signed in before the date) may enter the
  // matter — but may not take a row OUT of the seal: that needs aal2.
  await setRequiredFrom(new Date(Date.now() + 30 * 864e5));
  const g = aal1(GRACE, Date.now() - 864e5);
  const graceRead = await qa(g, `select id from public.documents where id = $1`, [DOC_S]);
  check(graceRead.length === 1, 'grace session reads the sealed document (the grace, as 094 intends)');
  const graceMove = await tryAs(g, `update public.documents set matterspace_id=$1 where id=$2 returning id`, [OPEN, DOC_S]);
  check(graceMove.err?.code === '42501' && /step_up_required/.test(graceMove.err?.message ?? ''),
    'grace session: moving it OUT of the seal is refused (step_up_required)', graceMove.err?.message ?? graceMove.rows);
  const graceP = await tryAs(g, `update public.passages set matterspace_id=$1 where id=$2 returning id`, [OPEN, P_S]);
  check(graceP.err?.code === '42501', 'grace session: a passage cannot leave either', graceP.err?.message ?? graceP.rows);
  const graceSealedToSealed = await tryAs(g, `update public.documents set matterspace_id=$1 where id=$2 returning id`, [SEALED_KID, DOC_S]);
  check(!graceSealedToSealed.err && graceSealedToSealed.rows.length === 1, 'grace session: sealed → sealed is not leaving the seal, and is allowed');
  await q(`update public.documents set matterspace_id=$1 where id=$2`, [SEALED, DOC_S]);

  const allowed = await qa(g, `select public.seal_leave_allowed($1,$2) a, public.seal_leave_allowed($3,$4) b`, [SEALED, OPEN, OPEN, SEALED]);
  check(allowed[0].a === false && allowed[0].b === true, 'seal_leave_allowed (move-document.mjs\'s precheck) agrees with the trigger');

  // aal2 may move it out — a deliberate, confirmed act — and it is then open.
  const a2 = await qa(aal2(MEM), `update public.documents set matterspace_id=$1 where id=$2 returning id`, [OPEN, DOC_S]);
  check(a2.length === 1, 'aal2 may move a document out of the seal (S7 may later ask for more)');
  await q(`update public.documents set matterspace_id=$1 where id=$2`, [SEALED, DOC_S]);

  // The worker (service role: no auth.uid()) is not a browser session.
  await db.exec('set role service_role');
  const svc = await q(`update public.passages set matterspace_id = matterspace_id where id = $1 returning id`, [P_S]);
  await db.exec('reset role');
  check(svc.length === 1, 'the service role (the worker) is untouched');
}

// ===========================================================================
section('D. reads by id and by matter');
// ===========================================================================
const READS = {
  'document by id': [`select id from public.documents where id = $1`, () => [DOC_S]],
  'document in an open-tier folder inside the seal': [`select id from public.documents where id = $1`, () => [DOC_K]],
  'passage by id': [`select id from public.passages where id = $1`, () => [P_S]],
  'passages by matter id': [`select id from public.passages where matterspace_id = $1 limit 1`, () => [SEALED]],
  'comment by id': [`select id from public.matter_comments where id = $1`, () => [COMMENT_S]],
  'conversations (list_matter_conversations)': [`select id from public.list_matter_conversations($1)`, () => [SEALED]],
  'page (content_items) by id': [`select id from public.content_items where id = $1`, () => [PAGE_S]],
  'meeting in the matter': [`select id from public.meetings where matterspace_id = $1 and created_by <> auth.uid()`, () => [SEALED]],
  'stored file (storage.objects)': [`select id from storage.objects where name like $1 || '/%'`, () => [SEALED]],
  'co-members of the matter': [`select id from public.matterspace_members where matterspace_id = $1`, () => [SEALED]],
};
// A matter-level membership row so the co-members read has something to hide.
await q(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,'viewer')`, [SEALED, OUT]);
await setRequiredFrom(new Date(Date.now() + 30 * 864e5));
for (const [label, [sql, args]] of Object.entries(READS)) {
  const r1 = await tryAs(aal1(MEM), sql, args());
  const r2 = await tryAs(aal2(MEM), sql, args());
  const rc = await tryAs(connector(MEM), sql, args());
  const ok1 = !r1.err && r1.rows.length === 0;
  const ok2 = !r2.err && r2.rows.length > 0;
  check(ok1 && ok2, `${label}: aal1-with-factor sees nothing, aal2 sees it`, { aal1: r1.err?.message ?? r1.rows.length, aal2: r2.err?.message ?? r2.rows.length });
  if (label.startsWith('meeting')) continue;   // the connector does not read meetings by matter; not a claim
  check(!rc.err && rc.rows.length > 0, `${label}: the connector stamp is still exempt (the seal governs it in code)`);
}
await q(`delete from public.matterspace_members where matterspace_id = $1 and user_id = $2`, [SEALED, OUT]);
{
  const r = await tryAs(aal1(MEM), `select public.ensure_general_conversation($1) g`, [SEALED]);
  check(!r.err && r.rows[0].g === null, 'ensure_general_conversation(sealed) at aal1 answers null, not a thread id');
  const feed1 = await qa(aal1(MEM), `select title from public.activity_feed`);
  const feed2 = await qa(aal2(MEM), `select title from public.activity_feed`);
  check(!feed1.some((f) => /SEALED-TITLE/.test(f.title ?? '')) && feed1.length > 0,
    'activity_feed at aal1: no sealed titles (documents, comments, pages, meetings)', feed1.map((f) => f.title));
  check(feed2.filter((f) => /SEALED-TITLE/.test(f.title ?? '')).length >= 4, 'activity_feed at aal2: the sealed rows are there');
  const anon = await tryAs(ANON, `select id from public.documents`);
  check(!anon.err && anon.rows.length === 0, 'anon: an empty answer, not "permission denied for schema stepup_internal"', anon.err?.message ?? '');
  const outsider = await tryAs(aal2(OUT), `select id from public.documents where id = any($1::uuid[])`, [[DOC_S, DOC_O]]);
  check(!outsider.err && outsider.rows.length === 0, 'an outsider at aal2 sees neither (membership still comes first)');
  const helpers = (await qa(aal1(MEM), `select public.can_access_matter($1) a, public.can_write_matter($1) w,
    public.can_manage_matter($1) m, public.matter_role($1) r, public.can_access_matter($2) o, public.matter_role($2) orole`, [SEALED, OPEN]))[0];
  check(!helpers.a && !helpers.w && !helpers.m && helpers.r === null && helpers.o && helpers.orole === 'member',
    'the four helpers, at aal1: no role on the sealed matter, "member" on the open one', helpers);
  const helpers2 = (await qa(aal2(EDEN), `select public.matter_role($1) r, public.can_manage_matter($1) m`, [SEALED]))[0];
  check(helpers2.r === 'owner' && helpers2.m === true, 'at aal2 the owner is the owner');
  // 095's kill switch asks public.matter_role for matter scope. At aal2 it
  // works on a sealed matter; at aal1 the owner is refused on it (the matter
  // is hidden from that session by 094 anyway); account scope asks no helper.
  const kill2 = await tryAs(aal2(EDEN), `select public.disconnect_all_preview('matter', $1) p`, [SEALED]);
  check(!kill2.err && kill2.rows[0].p, 'disconnect_all_preview(matter, sealed) works for the owner at aal2', kill2.err?.message);
  const kill1 = await tryAs(aal1(EDEN), `select public.disconnect_all_preview('matter', $1) p`, [SEALED]);
  check(kill1.err?.code === '42501', 'at aal1 it is refused on the sealed matter (not owner/admin — to this session it is not there)', kill1.err?.message);
  const killAcct = await tryAs(aal1(EDEN), `select public.disconnect_all_preview('account', null) p`);
  check(!killAcct.err && killAcct.rows[0].p, 'account scope still works at aal1 — the one press never needs a factor', killAcct.err?.message);
  const secdef = (await q(`select proname, prosecdef from pg_proc where pronamespace = 'public'::regnamespace
    and proname in ('matter_role','can_access_matter','can_write_matter','can_manage_matter')`));
  check(secdef.length === 4 && secdef.every((p) => p.prosecdef === false), 'the public helpers are INVOKER wrappers now (house rule)');
}

// ===========================================================================
section('E. the grace: the date, the latest sign-in, the hard end');
// ===========================================================================
{
  const read = async (claims) => (await qa(claims, `select count(*)::int n from public.documents where id = $1`, [DOC_S]))[0].n === 1;
  const day = 864e5;
  // Before the date: a session with no factor is in.
  await setRequiredFrom(new Date(Date.now() + 10 * day));
  check(await read(aal1(GRACE, Date.now() - day)), 'before the date: no factor, signed in before it → in');
  check(!await read(aal1(MEM, Date.now() - day)), 'before the date: a person WITH a factor still steps up');

  // After the date (by 1 day), inside the seven-day tail.
  await setRequiredFrom(new Date(Date.now() - day));
  check(await read(aal1(GRACE, Date.now() - 3 * day)), 'after the date: a session signed in BEFORE it keeps its grace for now');
  check(!await read(aal1(GRACE, Date.now())), 'after the date: a session signed in after it is gated');
  const reauthed = {
    ...aal1(GRACE),
    amr: [{ method: 'password', timestamp: secs(Date.now() - 3 * day) }, { method: 'password', timestamp: secs(Date.now()) }],
  };
  check(!await read(reauthed), 'HIGH-5: the LATEST amr entry decides — a re-sign-in after the date ends the grace (094 took the earliest)');
  const noAmr = { sub: GRACE, role: 'authenticated', aal: 'aal1' };
  check(!await read(noAmr), 'a token without amr is treated as signed in now (fails closed)');

  // After the hard end: nobody without aal2.
  await setRequiredFrom(new Date(Date.now() - 8 * day));
  check(!await read(aal1(GRACE, Date.now() - 30 * day)), 'HIGH-5: seven days after the date, no amr keeps anyone in — the grace has a hard end');
  check(await read(aal2(MEM)), 'aal2 still reads');
  check(await read(connector(GRACE)), 'the connector stamp is not the grace (the seal governs it in code)');
  const entry = (await qa(aal1(GRACE, Date.now() - 30 * day), `select public.matter_entry($1) e`, [SEALED]))[0].e;
  check(entry === 'enrol', 'after the hard end, a person with no factor is told to enrol', entry);
  await setRequiredFrom(new Date(Date.now() + 30 * day));
}

// ===========================================================================
section('F. the probes: matter_entry and document_entry');
// ===========================================================================
{
  const me = async (claims, m) => (await qa(claims, `select public.matter_entry($1) e`, [m]))[0].e;
  const de = async (claims, d) => (await qa(claims, `select public.document_entry($1) e`, [d]))[0].e;
  check(await me(aal1(MEM), SEALED) === 'stepup', 'matter_entry still says "stepup" to a member at aal1 (it asks membership, not the gated helper)');
  check(await me(aal1(MEM), SEALED_KID) === 'stepup', '… and for the open-tier folder inside the seal');
  check(await me(aal2(MEM), SEALED) === 'open', '… "open" at aal2');
  check(await me(aal1(OUT), SEALED) === 'none', '… "none" to a non-member (not an oracle)');
  check(await de(aal1(MEM), DOC_S) === 'stepup', 'document_entry: "stepup" for a sealed document at aal1 — the Reader shows the prompt');
  check(await de(aal1(MEM), DOC_O) === 'open', 'document_entry: "open" for an open document');
  check(await de(aal2(MEM), DOC_K) === 'open', 'document_entry: "open" at aal2');
  check(await de(aal1(OUT), DOC_S) === 'none', 'document_entry: "none" to a non-member');
  check(await de(aal1(MEM), '00000000-0000-4000-8000-000000000000') === 'none', 'document_entry: "none" for a missing id — the same answer');
  const anon = await tryAs(ANON, `select public.document_entry($1) e`, [DOC_S]);
  check(Boolean(anon.err), 'document_entry is not callable by anon');
}

// ===========================================================================
section('G. connector tokens: one door, and it asks for the factor');
// ===========================================================================
{
  const hash = (c) => c.repeat(64);
  const create = (claims, c, extra = '') => tryAs(claims,
    `select public.connector_token_create($1, $2, 'test token'${extra}) id`, [hash(c), `csp_test${c}${c}${c}${c}`]);

  const direct = await tryAs(aal2(MEM), `insert into public.connector_tokens (user_id, token_hash, token_prefix, name)
    values ($1, $2, 'csp_directxxxx', 'direct') returning id`, [MEM, hash('d')]);
  check(Boolean(direct.err), 'a direct INSERT is refused, even at aal2 (the policy and the grant are gone)', direct.err?.code);

  const a1 = await create(aal1(MEM), 'a');
  check(a1.err?.code === '42501' && /step_up_required/.test(a1.err.message), 'aal1, person with a factor: step_up_required (CRITICAL-1)', a1.err?.message);
  const a2 = await create(aal2(MEM), 'b');
  check(!a2.err && a2.rows[0].id, 'aal2: created');
  const g = await create(aal1(GRACE), 'c');
  check(!g.err && g.rows[0].id, 'a person with no factor is not asked (nothing to confirm with; E2 does not require one of everybody)');
  const viaConnector = await create(connector(MEM), 'e');
  check(viaConnector.err?.code === '42501', 'a connector cannot make another connector', viaConnector.err?.message);
  const bad = await create(aal2(MEM), 'Z');
  check(bad.err?.code === '22023', 'a malformed hash is refused', bad.err?.message);
  const agent = await tryAs(aal2(MEM), `select public.connector_token_create($1, 'csp_agentffff', 'agent', 'agent', 'grok', $2::uuid[], false) id`, [hash('f'), [OPEN]]);
  const agentRow = agent.err ? null : (await q(`select kind, agent_provider, matter_scope, user_id from public.connector_tokens where id = $1`, [agent.rows[0].id]))[0];
  check(agentRow?.kind === 'agent' && agentRow.agent_provider === 'grok' && agentRow.matter_scope?.[0] === OPEN && agentRow.user_id === MEM,
    'an agent is created with its provider and matters, owned by the caller', agent.err?.message ?? agentRow);
  const unlocked = (await q(`select count(*)::int n from pg_trigger where tgname = 'connector_tokens_unlock_on_connect'`))[0].n;
  check(unlocked === 1, '095\'s AFTER INSERT trigger is still in place (and fires on this insert like the old one)');

  const tid = a2.rows[0].id;
  const overwrite = await tryAs(aal2(MEM), `update public.connector_tokens set token_hash = $2 where id = $1`, [tid, hash('9')]);
  check(overwrite.err?.code === '42501', 'token_hash cannot be overwritten from the browser (no second door)', overwrite.err?.message);
  const owner = await tryAs(aal2(MEM), `update public.connector_tokens set user_id = $2 where id = $1`, [tid, EDEN]);
  check(owner.err?.code === '42501', 'nor user_id');
  const revoke = await tryAs(aal1(MEM), `update public.connector_tokens set revoked_at = now() where id = $1 returning id`, [tid]);
  check(!revoke.err && revoke.rows.length === 1, 'revoking still works, at any aal (closing a door never needs a factor)', revoke.err?.message);
  const scope = await tryAs(aal2(MEM), `update public.connector_tokens set matter_scope = $2::uuid[] where id = $1 returning id`, [agent.rows?.[0]?.id, [OPEN, ROOT_M]]);
  check(!scope.err && scope.rows.length === 1, 'an agent\'s matters can still be edited (Connections › Agents)', scope.err?.message);
  const grants = (await q(`select column_name c from information_schema.column_privileges
    where table_name = 'connector_tokens' and grantee = 'authenticated' and privilege_type = 'UPDATE' order by 1`)).map((r) => r.c);
  check(JSON.stringify(grants) === JSON.stringify(['expires_at', 'last_used_at', 'matter_scope', 'name', 'revoked_at', 'scope_all']),
    'N3: the browser may UPDATE exactly the columns 099 §5 names', grants);
  const prov = await tryAs(aal2(MEM), `update public.connector_tokens set agent_provider = 'claude' where id = $1`, [agent.rows?.[0]?.id]);
  check(prov.err?.code === '42501', 'N3: agent_provider is not writable (099 refuses it too)');
  const exp = await tryAs(aal2(MEM), `update public.connector_tokens set expires_at = now() + interval '1 day' where id = $1 returning id`, [agent.rows?.[0]?.id]);
  check(!exp.err && exp.rows.length === 1, 'N3: expires_at is writable (099 trigger decides "earlier only")', exp.err?.message);
  const others = await tryAs(aal2(EDEN), `update public.connector_tokens set revoked_at = now() where id = $1 returning id`, [agent.rows?.[0]?.id]);
  check(!others.err && others.rows.length === 0, 'and only by their owner');
}

// ===========================================================================
section('H. signing a device out asks for the factor');
// ===========================================================================
{
  const sess = async (u) => (await q(`insert into auth.sessions (user_id, aal) values ($1,'aal1') returning id`, [u]))[0].id;
  const s1 = await sess(MEM);
  const s2 = await sess(GRACE);
  await db.exec('set role service_role');
  const noAal = await (async () => { try { await q(`select public.account_session_revoke($1,$2) ok`, [MEM, s1]); return null; } catch (e) { return e; } })();
  const withAal1 = await (async () => { try { await q(`select public.account_session_revoke($1,$2,'aal1') ok`, [MEM, s1]); return null; } catch (e) { return e; } })();
  const withAal2 = (await q(`select public.account_session_revoke($1,$2,'aal2') ok`, [MEM, s1]))[0].ok;
  const noFactor = (await q(`select public.account_session_revoke($1,$2,'aal1') ok`, [GRACE, s2]))[0].ok;
  await db.exec('reset role');
  check(noAal?.code === '42501' && /step_up_required/.test(noAal.message), 'MEDIUM-7: a person with a factor, no aal given → step_up_required');
  check(withAal1?.code === '42501', 'MEDIUM-7: … and at aal1');
  check(withAal2 === true, 'at aal2 the device is signed out');
  check(noFactor === true, 'a person with no factor is not asked');
  const two = (await q(`select count(*)::int n from pg_proc where proname = 'account_session_revoke'`))[0].n;
  check(two === 1, 'one account_session_revoke (the 2-argument form is gone; no PostgREST overload ambiguity)');
  const browser = await tryAs(aal2(MEM), `select public.account_session_revoke($1,$2,'aal2')`, [MEM, s1]);
  check(Boolean(browser.err), 'still not callable by a browser session');
}

// ===========================================================================
section('I. /api/ext/* as the connector JWT, against this database');
// ===========================================================================
// A client with the parts of supabase-js the three routes use, running every
// query as the JWT lib/supabase-user-jwt.mjs would sign (cs_via:'connector'),
// or as the superuser for the service role. Real handlers, real policies.
function pgClient(claims) {
  const run = (sql, params) => as(claims, () => q(sql, params));
  const ident = (c) => { if (!/^[a-z_]+(->>[a-z_]+)?$/.test(c)) throw new Error(`bad identifier ${c}`); return c.replace(/->>([a-z_]+)$/, "->>'$1'"); };
  return {
    from(table) {
      const st = { cols: '*', where: [], params: [], order: null, limit: null };
      const exec = async () => {
        const cols = st.cols === '*' ? '*'
          : st.cols.split(',').map((c) => c.trim()).filter((c) => /^[a-z_]+$/.test(c)).join(', ');
        const where = st.where.length ? ` where ${st.where.join(' and ')}` : '';
        const order = st.order ? ` order by ${ident(st.order[0])} ${st.order[1] ? 'asc' : 'desc'}` : '';
        const lim = st.limit ? ` limit ${Number(st.limit)}` : '';
        try { return { data: await run(`select ${cols} from public.${ident(table)}${where}${order}${lim}`, st.params), error: null }; }
        catch (e) { return { data: null, error: { message: e.message, code: e.code } }; }
      };
      const api = {
        select(cols) { st.cols = cols; return api; },
        eq(c, v) { st.params.push(v); st.where.push(`${ident(c)} = $${st.params.length}`); return api; },
        in(c, vs) { st.params.push(vs); st.where.push(`${ident(c)}::text = any($${st.params.length}::text[])`); return api; },
        order(c, o = {}) { st.order = [c, o.ascending !== false]; return api; },
        gte(c, v) { st.params.push(v); st.where.push(`${ident(c)} >= $${st.params.length}`); return api; },
        limit(n) { st.limit = n; return api; },
        async maybeSingle() { const r = await exec(); return { data: r.data?.[0] ?? null, error: r.error }; },
        then(ok, bad) { return exec().then(ok, bad); },
      };
      return api;
    },
    async rpc(fn, args = {}) {
      const keys = Object.keys(args);
      const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k]));
      try {
        const rows = await run(`select * from public.${ident(fn)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')})`, vals);
        const scalar = rows.length === 1 && Object.keys(rows[0]).length === 1 && Object.keys(rows[0])[0] === fn;
        return { data: scalar ? rows[0][fn] : rows, error: null };
      } catch (e) { return { data: null, error: { message: e.message, code: e.code } }; }
    },
  };
}
{
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'stub-client';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'stub-secret';
  const { default: extDocuments } = await import('../api/ext/documents.mjs');
  const { default: extMatters } = await import('../api/ext/matters.mjs');
  const { default: pushToDrive } = await import('../api/ext/push-to-drive.mjs');
  const { walkEffectiveTier } = await import('../lib/ai-tier-policy.mjs');

  // Nothing here may reach the network: a sealed push must not even try.
  const outbound = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { outbound.push(String(u)); throw new Error('network is off in this harness'); };

  // The service-role tier, with the real walk over this database's rows.
  const tierOf = (id) => walkEffectiveTier(async (mid) =>
    (await q(`select id, parent_matterspace_id, ai_tier from public.matterspaces where id = $1`, [mid]))[0] ?? null, id);
  const deps = (uid) => ({
    authenticate: async () => uid,
    userClient: () => pgClient(connector(uid)),
    adminClient: () => pgClient(null),
    tierOf,
  });
  const call = async (handler, { method = 'GET', query = {}, body = null, uid = MEM } = {}) => {
    let status = 0; let text = '';
    const res = { statusCode: 200, setHeader() {}, end(t) { status = this.statusCode; text = t ?? ''; } };
    await handler({ method, headers: { authorization: 'Bearer csp_x' }, query, body }, res, deps(uid));
    let json = null; try { json = JSON.parse(text); } catch { /* none */ }
    return { status, json, text };
  };
  const refusals = async (m) => (await q(`select count(*)::int n from public.events
    where kind = 'tool.invoked' and matterspace_id = $1 and payload ->> 'refused' = 'sealed'`, [m]))[0].n;

  // The DB alone would serve it: the connector stamp is exempt from 094/098.
  const raw = await qa(connector(MEM), `select count(*)::int n from public.documents where matterspace_id = $1`, [SEALED]);
  check(raw[0].n > 0, 'the connector JWT can read sealed rows in the database — so the route itself must refuse');

  const before = await refusals(SEALED);
  const docs = await call(extDocuments, { query: { matter: SEALED } });
  check(docs.status === 403 && docs.json?.error === 'sealed_matter' && !docs.text.includes('SEALED-TITLE'),
    '/api/ext/documents refuses a sealed matter; not one title', docs.json);
  const kid = await call(extDocuments, { query: { matter: SEALED_KID } });
  check(kid.status === 403, '/api/ext/documents refuses the open-tier folder inside it (inherited)', kid.json);
  check(await refusals(SEALED) === before + 1, 'the refusal is a tool.invoked {refused:"sealed"} row in the matter\'s Record');
  const open = await call(extDocuments, { query: { matter: OPEN } });
  check(open.status === 200 && open.json?.documents?.length >= 2 && open.json.sealed === false, '/api/ext/documents lists an open matter as before');
  const stranger = await call(extDocuments, { query: { matter: SEALED }, uid: OUT });
  check(stranger.status === 404, 'a non-member gets "not found" for a sealed matter — the same as for any other (not an oracle)', stranger.json);

  const list = await call(extMatters);
  const ids = (list.json?.matters ?? []).map((m) => m.id);
  check(list.status === 200 && ids.includes(OPEN) && !ids.includes(SEALED) && !ids.includes(SEALED_KID),
    '/api/ext/matters lists open matters and no sealed one', { ids: ids.length });

  const push = await call(pushToDrive, { method: 'POST', body: { documentId: DOC_S } });
  check(push.status === 403 && push.json?.error === 'sealed_matter', 'push-to-drive: a sealed document is refused without a confirmation', push.json);
  const pushConfirmed = await call(pushToDrive, { method: 'POST', body: { documentId: DOC_S, confirm_leave_seal: true } });
  check(pushConfirmed.status === 403 && pushConfirmed.json?.error === 'sealed_matter',
    'push-to-drive: and WITH confirm_leave_seal:true in the body — a token holder\'s "yes" is not the person\'s', pushConfirmed.json);
  check(outbound.length === 0, 'push-to-drive: nothing left the process (no Google, no storage)', outbound);
  check(await refusals(SEALED) === before + 2,
    'N4: the push refusal is recorded once — the second, within the minute, is not a second row');
  for (let i = 0; i < 5; i += 1) await call(extDocuments, { query: { matter: SEALED } });
  check(await refusals(SEALED) === before + 2, 'N4: five more /api/ext/documents refusals in the same minute add no rows (no flooding the Record)');
  const src = fs.readFileSync(path.join(ROOT, 'api/ext/push-to-drive.mjs'), 'utf8');
  check(!/confirm_leave_seal\s*:\s*true/.test(src) && /confirmed: body\.confirm_leave_seal === true/.test(src),
    'push-to-drive never supplies confirm_leave_seal itself; the export gate reads only the request body');
  globalThis.fetch = realFetch;
}

// ===========================================================================
section('K. round 2: the Record, the sealed pen, the Office, unsealing, drift');
// ===========================================================================
{
  // N1 — the reviewer's case.
  for (const [label, sql] of Object.entries(PEN_READS)) {
    const r1 = await qa(aal1(EDEN), sql);
    const r2 = await qa(aal2(EDEN), sql);
    check(r1.length === 0 && r2.length > 0, `N1: ${label} — the aal1 owner sees none, aal2 sees it`, { aal1: r1.length, aal2: r2.length });
  }
  const viaServerspace = await qa(aal1(MEM), PEN_READS['events (the Record) of the sealed matter']);
  check(viaServerspace.length === 0, 'N1: no serverspace fallback into a sealed matter\'s Record at aal1');
  await qa(aal2(EDEN), `select public.ledger_append('tool.invoked', $1, null, null, 'user', $2, null, '{}'::jsonb)`, [OPEN, EDEN]);
  const openRows = await qa(aal1(EDEN), `select id from public.events where matterspace_id = $1`, [OPEN]);
  check(openRows.length > 0, 'N1: the Record of an open matter is read as before');

  // N2 — the Office.
  const shelve = (claims, u, sec, d) => tryAs(claims, `insert into public.office_items (owner_id, section_id, document_id, title)
    values ($1,$2,$3,'shelved') returning id`, [u, sec, d]);
  const s1 = await shelve(aal1(MEM), MEM, SHELF_M, DOC_S);
  check(s1.err?.code === '42501', 'N2: an aal1 password holder cannot shelve a sealed document', s1.err?.message);
  const s2 = await shelve(aal1(MEM), MEM, SHELF_M, DOC_O);
  check(!s2.err, 'N2: an open document can be shelved as before', s2.err?.message);
  const s3 = await shelve(aal1(OUT), OUT, SHELF_M, DOC_O);
  check(Boolean(s3.err), 'N2: nobody can shelve a document they cannot read');
  const repoint = await tryAs(aal1(MEM), `update public.office_items set document_id = $2 where id = $1 returning id`, [s2.rows?.[0]?.id, DOC_S]);
  check(repoint.err?.code === '42501', 'N2: an item cannot be re-pointed at a sealed document either', repoint.err?.message);
  // A row shelved before 098 (or by an aal2 session) for a sealed document.
  await q(`insert into public.office_items (owner_id, section_id, document_id, title) values ($1,$2,$3,'legacy sealed')`, [EDEN, SHELF_E, DOC_S]);
  const { documentIsSealed } = await import('../api/office.mjs');
  const svc = pgClient(null);
  check(await documentIsSealed(svc, DOC_S) === true && await documentIsSealed(svc, DOC_K) === true
    && await documentIsSealed(svc, DOC_O) === false,
    'N2: api/office.mjs documentIsSealed (service role): sealed, inherited-sealed, open');
  const officeSrc = fs.readFileSync(path.join(ROOT, 'api/office.mjs'), 'utf8');
  const asked = officeSrc.indexOf('documentIsSealed(supabase, item.document_id)');
  check(asked > 0 && asked < officeSrc.indexOf(".from('passages')"),
    'N2: the reading room asks before any passage is read, so a pre-existing sealed item is not served');

  // N5 — unsealing a matter needs aal2.
  const grace = aal1(ADM, Date.now() - 864e5);
  const retier = await tryAs(grace, `update public.matterspaces set ai_tier = 'A' where id = $1 returning id`, [SEALED]);
  check(retier.err?.code === '42501' && /step_up_required/.test(retier.err.message),
    'N5: a grace-session admin cannot re-tier a sealed matter to A', retier.err?.message ?? retier.rows);
  const reparent = await tryAs(grace, `update public.matterspaces set parent_matterspace_id = $2 where id = $1 returning id`, [SEALED_KID, OPEN]);
  check(reparent.err?.code === '42501', 'N5: nor move an inherited-seal sub-matter under an open parent', reparent.err?.message ?? reparent.rows);
  const rename = await tryAs(grace, `update public.matterspaces set name = name || '' where id = $1 returning id`, [SEALED]);
  check(!rename.err && rename.rows.length === 1, 'N5: an ordinary edit of the sealed matter is not refused', rename.err?.message);
  const sealIt = await tryAs(grace, `update public.matterspaces set ai_tier = 'B' where id = $1 returning id`, [ROOT_M]);
  check(!sealIt.err && sealIt.rows.length === 1, 'N5: sealing is never refused — only leaving the seal is', sealIt.err?.message);
  const unseal2 = await tryAs(aal2(EDEN), `update public.matterspaces set ai_tier = 'A' where id = $1 returning id`, [ROOT_M]);
  check(!unseal2.err && unseal2.rows.length === 1, 'N5: at aal2 a matter can be unsealed (and its children with it)', unseal2.err?.message);

  // Drift: the monitor's check.
  const { fetchSealDrift, sealDriftLines } = await import('./ingest-monitor.mjs');
  const clean = await fetchSealDrift(svc);
  check(clean.available && !clean.red && clean.rows.length === 0, 'drift: none on a healthy database', clean);
  const denied = await tryAs(aal2(EDEN), `select * from public.sealed_effective_drift()`);
  check(Boolean(denied.err), 'drift: service role only');
  await db.exec(`alter table public.matterspaces disable trigger matterspaces_sealed_effective`);
  await q(`update public.matterspaces set sealed_effective = false where id = $1`, [SEALED_KID]);
  await db.exec(`alter table public.matterspaces enable trigger matterspaces_sealed_effective`);
  const drifted = await fetchSealDrift(svc);
  const lines = sealDriftLines(drifted).join('\n');
  check(drifted.red && drifted.rows.length === 1 && drifted.rows[0].matterspace_id === SEALED_KID && /SEAL DRIFT: 1 matter/.test(lines),
    'drift: a corrupted column is found, and the monitor reports it red', lines.split('\n')[0]);
  await q(`update public.matterspaces set ai_tier = ai_tier where id = $1`, [SEALED_KID]);
  check((await fetchSealDrift(svc)).rows.length === 0, 'drift: the repair the monitor prints works');
  const missing = await fetchSealDrift({ rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }) });
  check(!missing.red && /not deployed/.test(sealDriftLines(missing)[0]), 'drift: before 098 is pasted the monitor says so and is not red');
  const broken = await fetchSealDrift({ rpc: async () => ({ data: null, error: { code: '57014', message: 'timeout' } }) });
  check(broken.red && /NOT GREEN/.test(sealDriftLines(broken)[0]), 'drift: a check that could not run is not green');
}

// ===========================================================================
section('J. search: the same answers for open matters, and what it costs');
// ===========================================================================
{
  const after = await measure('after 098');
  const searchAfter = after.searchOpen.rows.map((r) => r.passage_id).join(',');
  check(searchAfter === searchBefore && after.searchOpen.rows.length > 0,
    `search_passages on an open matter returns the same ${after.searchOpen.rows.length} passages before and after`);
  const sealedIn = await qa(aal1(MEM), `select count(*)::int n from public.search_passages($1::uuid[], 'deposition', null, null, null, null, 0, 50) s
    join public.passages p on p.id = s.passage_id where p.matterspace_id = $2`, [[OPEN, SEALED], SEALED]);
  check(sealedIn[0].n === 0, 'search at aal1 with a sealed matter in scope returns none of its passages');
  check(after.directSealedAal1.rows[0].n === 0 && after.directSealedAal2.rows[0].n === BULK + 1,
    'a direct per-row read of a sealed matter: 0 rows at aal1, all of them at aal2');
  check(after.directOpenAal1.rows[0].n === before.directOpenAal1.rows[0].n, 'and the open matter\'s count is unchanged');

  const row = (k, lbl) => {
    const b = before[k].ms; const a = after[k].ms;
    console.log(`        ${lbl.padEnd(54)} ${b.toFixed(1).padStart(8)} ms → ${a.toFixed(1).padStart(8)} ms  (${(a / b).toFixed(2)}×)`);
  };
  console.log('\n  Timings (median of 7, PGlite, same database, same session kinds):');
  row('searchOpen', 'search_passages, open matter, aal2');
  row('searchBoth', 'search_passages, open + sealed in scope, aal2');
  row('directOpenAal1', `direct read, ${BULK + 1} open passages, aal1 (per-row policy)`);
  row('directSealedAal2', `direct read, ${BULK + 1} sealed passages, aal2 (per-row policy)`);
  row('directSealedAal1', `direct read, ${BULK + 1} sealed passages, aal1 (per-row policy)`);
  console.log(`        EXPLAIN ANALYZE, sealed matter at aal2:  before ${before.explainSealedAal2.exec} | after ${after.explainSealedAal2.exec}`);
  console.log(`        EXPLAIN ANALYZE, sealed matter at aal1:  before ${before.explainSealedAal1.exec} | after ${after.explainSealedAal1.exec}`);
  console.log(`        policy filter after: ${after.explainSealedAal1.filter}`);
  console.log('        Note: PGlite is Postgres compiled to WASM in one process. The numbers show the shape of the');
  console.log('        cost (search authorises per matter, so it should not move; the direct read pays the helper');
  console.log('        per row before and after), not what production will measure. Run the same EXPLAIN in the');
  console.log('        SQL editor after pasting to see production\'s figure.');
  // A guard against a gross regression only: the per-row helper must stay
  // within a small multiple of what it cost before the seal was added to it.
  const ratio = after.directOpenAal1.ms / Math.max(before.directOpenAal1.ms, 0.5);
  check(ratio < 4, `the per-row helper on an open matter stays within 4× of its pre-098 cost (${ratio.toFixed(2)}×)`);
  const sratio = after.searchOpen.ms / Math.max(before.searchOpen.ms, 0.5);
  check(sratio < 3, `search_passages is not slowed by 098 beyond noise (${sratio.toFixed(2)}×)`);
}

async function setRequiredFrom(d) {
  await db.exec(`create or replace function public.second_factor_required_from()
    returns timestamptz language sql immutable as $$ select timestamptz '${new Date(d).toISOString()}' $$;
    discard plans;`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} (${passes} checks passed)`);
process.exit(failures === 0 ? 0 : 1);
