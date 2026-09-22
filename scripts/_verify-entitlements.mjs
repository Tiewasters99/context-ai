// Hidden also means LOCKED — the proof, in two halves.
//
// PART A (no dependencies, always runs): the SURFACE TABLE is honest.
//   lib/surfaces.mjs is the one list the browser, the API handlers and
//   migration 083 all read. This half asserts that every surface declares HOW
//   the server holds it shut, and then checks the declaration instead of
//   believing it: a named endpoint must really call requireEntitlement() with
//   that surface's id, a named table must really be fenced in 083, and 083's
//   own core list must match the table. A frozen or beta surface that declares
//   nothing fails the build — which is the whole point, because the failure
//   this is written against is a hidden room shipping unlocked and nobody
//   noticing for four months.
//
// PART B (PGlite): migration 083 does what it says.
//   Executes the real 001 / 005 / 008 / 016 / 022 / 034 / 037 / 039 / 041 /
//   052 / 062 chain inside PGlite (Postgres compiled to WASM: real plpgsql,
//   real roles, real RLS), opens with the HOLE as a negative control — a free
//   account starting a Moot Bench session — then applies 083 twice and holds
//   it to:
//     * plan_can_open() answers exactly what lib/surfaces.mjs answers, for
//       every surface against free, pro and workshop;
//     * a free and a pro account cannot INSERT into any fenced table, and a
//       workshop account can;
//     * the row the free account made BEFORE 083 is still readable, editable
//       and deletable by them — nobody loses their own work;
//     * the invitation cap counts, refuses in plain words, and is reachable by
//       the service role alone;
//     * `profiles` is byte-for-byte untouched: the same policies and the same
//       check constraint before and after (062 and 067 own that table);
//     * running 083 twice changes nothing.
//
//   npm i --no-save @electric-sql/pglite     # once; not a repo dependency
//   node scripts/_verify-entitlements.mjs
//
// Touches nothing outside this process. No .env, no network, no production.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SURFACES,
  SURFACE_TIERS,
  ENFORCEMENT_EXEMPTIONS,
  canOpenSurfaceId,
} from '../lib/surfaces.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

const SURFACE_IDS = Object.keys(SURFACES);
const MIGRATION = '083_server_entitlements.sql';
const sql083 = read(`supabase/migrations/${MIGRATION}`);

/** The ids quoted between two marker comments in 083. */
const between = (text, begin, end) => {
  const a = text.indexOf(begin);
  const b = text.indexOf(end);
  if (a < 0 || b < 0 || b < a) return null;
  return text.slice(a + begin.length, b);
};

// ===========================================================================
// PART A — the surface table, and every claim it makes
// ===========================================================================
console.log('\n--- A. the surface table declares how the server holds it shut ---');

for (const id of SURFACE_IDS) {
  const s = SURFACES[id];
  const e = s.enforcement;
  const gated = (e?.endpoints?.length || 0) > 0 || (e?.tables?.length || 0) > 0;
  const exempt = e?.exempt ?? null;

  check(SURFACE_TIERS.includes(s.tier), `${id}: tier is one of core/frozen/beta`, s.tier);
  check(Array.isArray(s.paths), `${id}: paths is a list`);
  check(
    !!e && Array.isArray(e.endpoints) && Array.isArray(e.tables) && typeof e.note === 'string' && e.note.length > 20,
    `${id}: declares an enforcement with a written note`,
  );
  check(
    exempt === null || ENFORCEMENT_EXEMPTIONS.includes(exempt),
    `${id}: any exemption uses one of the accepted words`,
    String(exempt),
  );
  // THE RULE THIS FILE EXISTS FOR. A surface that is hidden from a plan must
  // either be locked on the server or say, in writing, why it is not.
  check(
    gated || exempt !== null,
    `${id}: a hidden room is locked, or says in writing why it is not`,
  );
  // 'core-open' is not an excuse available to a frozen or beta surface.
  check(
    (exempt === 'core-open') === (s.tier === 'core'),
    `${id}: 'core-open' is used for core surfaces and only for core surfaces`,
  );
  if (s.tier !== 'core') {
    check(!gated || exempt === null, `${id}: a gated surface does not also claim an exemption`);
  }
}

console.log('\n--- A. every declared endpoint really calls the gate -------------');
for (const id of SURFACE_IDS) {
  for (const rel of SURFACES[id].enforcement.endpoints) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) {
      check(false, `${id}: ${rel} exists`);
      continue;
    }
    const src = fs.readFileSync(full, 'utf8');
    check(
      /requireEntitlement\s*\(/.test(src) && src.includes(`'${id}'`),
      `${id}: ${rel} calls requireEntitlement() with '${id}'`,
    );
    check(
      /sendEntitlementRefusal\s*\(/.test(src),
      `${id}: ${rel} answers a refusal with the shared sentence`,
    );
  }
}

console.log('\n--- A. every declared table really is fenced in 083 --------------');
const fenceBlock = between(sql083, '083-FENCE-BEGIN', '083-FENCE-END');
check(fenceBlock !== null, `${MIGRATION}: the fence list is marked for reading`);
const fencePairs = [...(fenceBlock || '').matchAll(/\(\s*'([a-z0-9_]+)'\s*,\s*'([A-Za-z][A-Za-z0-9]*)'\s*\)/g)]
  .map((m) => ({ table: m[1], surface: m[2] }));
check(fencePairs.length > 0, `${MIGRATION}: the fence list has entries`, String(fencePairs.length));
check(
  /as restrictive for insert to authenticated/.test(sql083)
  && /public\.plan_can_open\(%L\)/.test(sql083),
  `${MIGRATION}: the fence is a RESTRICTIVE insert policy calling plan_can_open`,
);

const declared = new Map();
for (const id of SURFACE_IDS) {
  for (const t of SURFACES[id].enforcement.tables) declared.set(t, id);
}
for (const [table, id] of declared) {
  const hit = fencePairs.find((p) => p.table === table);
  check(!!hit, `${id}: ${table} is fenced by ${MIGRATION}`);
  if (hit) check(hit.surface === id, `${table} is fenced as '${id}'`, hit.surface);
}
for (const pair of fencePairs) {
  check(
    declared.get(pair.table) === pair.surface,
    `${MIGRATION} fences ${pair.table} for a surface that declares it`,
    `${pair.surface} / declared by ${declared.get(pair.table) ?? '(nobody)'}`,
  );
}

console.log('\n--- A. 083 and the shared table hold the same list ---------------');
const idsIn = (block) => [...(block || '').matchAll(/'([A-Za-z][A-Za-z0-9_]*)'/g)].map((m) => m[1]);
const sqlCore = idsIn(between(sql083, '083-CORE-LIST-BEGIN', '083-CORE-LIST-END'));
const sqlNonCore = idsIn(between(sql083, '083-NONCORE-LIST-BEGIN', '083-NONCORE-LIST-END'));
const tableCore = SURFACE_IDS.filter((id) => SURFACES[id].tier === 'core');
const tableNonCore = SURFACE_IDS.filter((id) => SURFACES[id].tier !== 'core');
const sameSet = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
check(sameSet(sqlCore, tableCore), `${MIGRATION}: the core list matches lib/surfaces.mjs`,
  `sql=[${sqlCore.join(',')}]`);
check(sameSet(sqlNonCore, tableNonCore), `${MIGRATION}: the frozen+beta list matches lib/surfaces.mjs`,
  `sql=[${sqlNonCore.join(',')}]`);

console.log('\n--- A. one list, not two -----------------------------------------');
const dmts = read('lib/surfaces.d.mts');
const dmtsKeys = [...dmts.matchAll(/^\s+readonly\s+([A-Za-z][A-Za-z0-9]*):\s*Surface;$/gm)].map((m) => m[1]);
check(sameSet(dmtsKeys, SURFACE_IDS), 'lib/surfaces.d.mts names every surface and no others',
  `d.mts=${dmtsKeys.length} mjs=${SURFACE_IDS.length}`);

const planTs = read('src/lib/plan.ts');
check(planTs.includes("from '../../lib/surfaces.mjs'"), 'src/lib/plan.ts reads the shared table');
check(
  !/tier:\s*'(core|frozen|beta)'/.test(planTs),
  'src/lib/plan.ts does not keep a second copy of the table',
);
for (const name of ['SURFACES', 'canOpenSurface', 'canOpenPath', 'surfacePresentation', 'surfaceForPath', 'isWorkshop', 'asPlan']) {
  check(new RegExp(`export (const|function) ${name}\\b`).test(planTs),
    `src/lib/plan.ts still exports ${name} (its public API is unchanged)`);
}

// Every handler that gates must import the shared module, not re-derive a list.
console.log('\n--- A. the handlers read the shared table ------------------------');
const gatedFiles = [...new Set(SURFACE_IDS.flatMap((id) => SURFACES[id].enforcement.endpoints))];
for (const rel of gatedFiles) {
  const src = read(rel);
  check(src.includes("from '../lib/entitlements.mjs'"), `${rel} imports lib/entitlements.mjs`);
  check(!/pricing_tier/.test(src), `${rel} never reads the tier itself`);
}
check(read('lib/entitlements.mjs').includes("from './surfaces.mjs'"),
  'lib/entitlements.mjs answers from the shared table');

// ===========================================================================
// PART B — migration 083 against a real Postgres
// ===========================================================================
let PGlite, uuid_ossp;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
} catch {
  console.error('\nPGlite is not installed. Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const migration = (name) => {
  const p = path.resolve(ROOT, 'supabase', 'migrations', name);
  console.log(`  executing ${path.relative(process.cwd(), p).replace(/\\/g, '/')}`);
  return fs.readFileSync(p, 'utf8');
};

const db = new PGlite({ extensions: { uuid_ossp } });
const q = async (sql, params) => (await db.query(sql, params)).rows;
const attempt = async (sql, params) => {
  try { await db.query(sql, params); return null; } catch (err) { return err; }
};

/** Become a signed-in user: PostgREST sets the claims GUC, then the role. */
const asUser = async (uid) => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: uid, role: 'authenticated' }),
  ]);
  await db.exec('set role authenticated');
};
const asAnon = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  await db.exec('set role anon');
};
const asService = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  await db.exec('set role service_role');
};
const asOwner = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
};

console.log('\n--- B. supabase stubs -------------------------------------------');
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
    select nullif(
      coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      ), ''
    )::uuid
  $$;

  -- 041's study-group policies read the caller's email out of the token.
  create or replace function auth.jwt() returns jsonb
  language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb)
  $$;

  create table public.documents (
    id uuid primary key default gen_random_uuid(),
    matterspace_id uuid,
    created_by uuid
  );
  create table public.passages (
    id uuid primary key default gen_random_uuid(),
    matterspace_id uuid
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text,
    name text
  );
  create or replace function storage.foldername(p_name text)
  returns text[] language sql immutable as $$
    select string_to_array(p_name, '/')
  $$;

  grant usage on schema public, auth, storage to anon, authenticated, service_role;

  -- 041 adds the group chat to Supabase's realtime publication; PGlite has no
  -- Supabase bootstrap, so the publication has to exist for that line to run.
  do $$ begin create publication supabase_realtime; exception when duplicate_object then null; end $$;
`);
console.log('  roles, auth.uid() and the stub tables are in place');

console.log('\n--- B. the schema production has --------------------------------');
for (const m of [
  '001_initial_schema.sql',
  '005_fix_rls_recursion.sql',
  '008_submatters.sql',
  '016_matterspace_members.sql',
  '022_matterspaces_rls_invoker_wrappers.sql',
  '034_argument_prep.sql',
  '037_student_hub.sql',
  '039_student_hub_texts.sql',
  '041_student_hub_groups.sql',
  '052_agent_charters.sql',
]) {
  try {
    await db.exec(migration(m));
  } catch (err) {
    // A whole PGlite error object is a page of WASM noise; the line that
    // matters is the message.
    console.error(`  ${m} failed: ${err?.message || err}`);
    process.exit(1);
  }
}
// The blanket grant Supabase's own bootstrap applies, and every "fix the
// permissions" paste re-applies. 062 exists because of it; 083 must hold
// under it too.
await db.exec(`
  grant select, insert, update, delete on all tables in schema public
    to anon, authenticated, service_role;
`);
await db.exec(migration('062_profiles_rls_plan.sql'));
console.log('  blanket table grants applied (the Supabase default)');

console.log('\n--- B. three accounts -------------------------------------------');
const signup = async (email, name) => {
  const [row] = await q(
    `insert into auth.users (email, raw_user_meta_data)
     values ($1, jsonb_build_object('display_name', $2::text)) returning id`,
    [email, name],
  );
  return row.id;
};
const setTier = async (uid, tier) => {
  await asOwner();
  await q(`update public.profiles set pricing_tier = $2 where id = $1`, [uid, tier]);
};
const FREE = await signup('free@example.test', 'Freda');
const PRO = await signup('pro@example.test', 'Preston');
const SHOP = await signup('shop@example.test', 'Eden');
await setTier(FREE, 'free');
await setTier(PRO, 'pro');
await setTier(SHOP, 'workshop');
const tierOf = async (uid) => (await q(`select pricing_tier from public.profiles where id = $1`, [uid]))[0]?.pricing_tier;
check(await tierOf(FREE) === 'free' && await tierOf(PRO) === 'pro' && await tierOf(SHOP) === 'workshop',
  'three accounts on free / pro / workshop');

// The shapes an INSERT needs, per fenced table.
const START_WORK = {
  argument_prep_sessions: (uid) => ({
    sql: `insert into public.argument_prep_sessions (owner_id, title, model_id)
          values ($1, 'Oral argument', 'claude-opus-5') returning id`,
    params: [uid],
  }),
  agent_charters: (uid) => ({
    sql: `insert into public.agent_charters (owner_id, name) values ($1, 'Docket watcher') returning id`,
    params: [uid],
  }),
  student_hub_texts: (uid) => ({
    sql: `insert into public.student_hub_texts (owner_id, title) values ($1, 'Torts') returning id`,
    params: [uid],
  }),
  student_hub_sessions: (uid) => ({
    sql: `insert into public.student_hub_sessions (owner_id, title, reading, model_id)
          values ($1, 'Palsgraf', 'The plaintiff stood on a platform...', 'claude-opus-5') returning id`,
    params: [uid],
  }),
  student_hub_groups: (uid) => ({
    sql: `insert into public.student_hub_groups (text_id, name, created_by)
          values ((select id from public.student_hub_texts limit 1), 'Section B', $1) returning id`,
    params: [uid],
  }),
};
const FENCED = fencePairs.map((p) => p.table);

console.log('\n--- B. before 083: the hole is real ------------------------------');
// A workshop text first, so the group insert below has a text to hang on.
await asUser(SHOP);
await q(START_WORK.student_hub_texts(SHOP).sql, START_WORK.student_hub_texts(SHOP).params);
await asUser(FREE);
const beforeRows = {};
for (const table of FENCED) {
  const spec = START_WORK[table](FREE);
  try {
    const [row] = await q(spec.sql, spec.params);
    beforeRows[table] = row.id;
    check(true, `free account can START ${table} before 083 (this is the hole)`);
  } catch (err) {
    beforeRows[table] = null;
    check(false, `free account can START ${table} before 083 (this is the hole)`, err.message);
  }
}
await asOwner();

// The `profiles` fingerprint, taken before 083 and compared after.
const profilesFingerprint = async () => JSON.stringify({
  policies: await q(
    `select policyname, cmd, permissive, qual, with_check from pg_policies
      where schemaname = 'public' and tablename = 'profiles' order by policyname`),
  constraint: await q(
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'public.profiles'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) ilike '%pricing_tier%'`),
  grants: await q(
    `select grantee, privilege_type, column_name from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'profiles'
        and grantee in ('anon','authenticated') order by grantee, privilege_type, column_name`),
});
const profilesBefore = await profilesFingerprint();

console.log('\n--- B. apply 083, twice -----------------------------------------');
/** A whole migration file is many statements: exec, not query. */
const applyMigration = async () => {
  try { await db.exec(migration(MIGRATION)); return null; } catch (err) { return err; }
};
const first = await applyMigration();
check(first === null, '083 applies', first?.message ?? '');
const second = await applyMigration();
check(second === null, '083 is idempotent — a second run is a no-op', second?.message ?? '');

check(await profilesFingerprint() === profilesBefore,
  'profiles is untouched: the same policies, constraint and column grants as before');

console.log('\n--- B. plan_can_open answers what lib/surfaces.mjs answers -------');
for (const [uid, tier] of [[FREE, 'free'], [PRO, 'pro'], [SHOP, 'workshop']]) {
  await asUser(uid);
  let agreed = 0;
  const disagreements = [];
  for (const id of SURFACE_IDS) {
    const [row] = await q(`select public.plan_can_open($1) as ok`, [id]);
    const expected = canOpenSurfaceId(id, tier);
    if (row.ok === expected) agreed += 1;
    else disagreements.push(`${id}: sql=${row.ok} js=${expected}`);
  }
  check(agreed === SURFACE_IDS.length,
    `${tier}: plan_can_open agrees with canOpenSurfaceId on all ${SURFACE_IDS.length} surfaces`,
    disagreements.join('; '));
}
await asUser(FREE);
check((await q(`select public.plan_can_open('not-a-room') as ok`))[0].ok === false,
  'a surface nobody has declared is not a way in');
check((await q(`select public.plan_can_open(null) as ok`))[0].ok === false,
  'a null surface is not a way in');
await asAnon();
check((await q(`select public.plan_can_open('vault') as ok`))[0].ok === false,
  'signed out is not a way in, not even to a core surface');
await asOwner();

console.log('\n--- B. after 083: a hidden room cannot be entered ----------------');
for (const [uid, tier] of [[FREE, 'free'], [PRO, 'pro']]) {
  await asUser(uid);
  for (const table of FENCED) {
    const spec = START_WORK[table](uid);
    const err = await attempt(spec.sql, spec.params);
    check(!!err && /row-level security|violates/i.test(err.message || ''),
      `${tier} account cannot START ${table}`, err ? err.code : 'the insert SUCCEEDED');
  }
}
await asUser(SHOP);
for (const table of FENCED) {
  const spec = START_WORK[table](SHOP);
  const err = await attempt(spec.sql, spec.params);
  check(err === null, `workshop account can still START ${table}`, err?.message ?? '');
}
await asService();
for (const table of FENCED) {
  const spec = START_WORK[table](FREE);
  const err = await attempt(spec.sql, spec.params);
  check(err === null, `the service role is unaffected on ${table} (BYPASSRLS)`, err?.message ?? '');
}
await asOwner();

console.log('\n--- B. nobody loses their own work -------------------------------');
// Read and edit every row FIRST. Deleting them interleaved would cascade —
// student_hub_groups.text_id is `on delete cascade` — and a row that a
// foreign key removed would look like a row the migration took away.
await asUser(FREE);
for (const table of FENCED) {
  const id = beforeRows[table];
  if (!id) { check(false, `${table}: there is a pre-083 row to test`); continue; }
  const found = await q(`select id from public.${table} where id = $1`, [id]);
  check(found.length === 1, `${table}: the row made before 083 is still readable`);
  // student_hub_groups has no updated_at column; edit what it does have.
  const col = table === 'student_hub_groups' ? 'name' : 'updated_at';
  const val = table === 'student_hub_groups' ? `'Section C'` : 'now()';
  const upd = await attempt(`update public.${table} set ${col} = ${val} where id = $1`, [id]);
  check(upd === null, `${table}: the row made before 083 is still editable`, upd?.message ?? '');
}
for (const table of FENCED) {
  const id = beforeRows[table];
  if (!id) continue;
  const del = await attempt(`delete from public.${table} where id = $1`, [id]);
  check(del === null, `${table}: the row made before 083 is still deletable`, del?.message ?? '');
}
await asOwner();

console.log('\n--- B. the Student Hub invitation cap ----------------------------');
const GROUP = '11111111-1111-1111-1111-111111111111';
const charge = async (email, sender = FREE, group = GROUP) =>
  (await q(`select public.student_hub_invite_charge($1, $2, $3) as r`, [group, email, sender]))[0].r;
await asService();
const first3 = [await charge('sam@example.test'), await charge('SAM@example.test'), await charge('sam@example.test')];
check(first3.every((r) => r.allowed === true), 'three invitations to one seat go through');
const fourth = await charge('sam@example.test');
check(fourth.allowed === false && fourth.reason === 'invite_seat_cap' && fourth.status === 429,
  'the fourth is refused, per seat', JSON.stringify(fourth.reason));
check(typeof fourth.message === 'string' && /try again tomorrow/i.test(fourth.message),
  'the refusal is a sentence a person can read', fourth.message);
check(Number(fourth.retry_after_seconds) > 0, 'and it says when it clears',
  String(fourth.retry_after_seconds));
check((await charge('other@example.test')).allowed === true,
  'a DIFFERENT seat in the same group is unaffected');
let ownerRefusal = null;
for (let i = 0; i < 25 && !ownerRefusal; i += 1) {
  const r = await charge(`seat${i}@example.test`);
  if (r.allowed === false) ownerRefusal = r;
}
check(ownerRefusal?.reason === 'invite_daily_cap',
  'one owner is capped for the day across every seat', JSON.stringify(ownerRefusal?.reason));
check((await charge('sam@example.test', PRO)).allowed === false,
  'the seat cap is the SEAT’s, so a second owner cannot re-mail the same address');
check((await charge('fresh@example.test', PRO)).allowed === true,
  'but a second owner is not punished for the first one’s day');
check((await charge('', FREE)).allowed === false, 'an empty address is refused, not recorded');
await asUser(FREE);
const callerTriedTheCap = await attempt(
  `select public.student_hub_invite_charge($1, 'x@example.test', $2)`, [GROUP, FREE]);
check(!!callerTriedTheCap, 'a signed-in browser cannot call the cap at all',
  callerTriedTheCap?.code ?? 'it SUCCEEDED');
const callerReadTheLog = await q(`select * from public.student_hub_invite_sends`)
  .then((r) => r.length).catch(() => 'refused');
check(callerReadTheLog === 0 || callerReadTheLog === 'refused',
  'and cannot read the send log', String(callerReadTheLog));
await asOwner();

console.log('\n--- B. a table 083 does not know about is skipped, not crashed ---');
await db.exec(`drop table if exists public.argument_prep_messages cascade;
               drop table if exists public.argument_prep_sessions cascade;`);
const drifted = await applyMigration();
check(drifted === null, '083 applies to a database that is missing one of the tables',
  drifted?.message ?? '');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
