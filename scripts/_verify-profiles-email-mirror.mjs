// Execute migration 082 against a real Postgres and prove what it claims.
//
// 082 exists because Share › Add by email said "No Contextspaces account for
// quaintonlaw@gmail.com" about an account that signs in with that address:
// the login email had been changed, auth.users.email moved, and profiles.email
// (copied once, at signup, by handle_new_user) never followed. This runs the
// real 001 / 005 / 008 / 016 / 022 / 062 chain inside PGlite, reproduces that
// drift BEFORE 082 (a test that cannot fail on the old schema is not testing
// anything), then applies 082 twice and asserts the repair, the mirror and
// the lookup. Same harness shape as _verify-profiles-rls.mjs.
//
//   npm i --no-save @electric-sql/pglite     # once; not a repo dependency
//   node scripts/_verify-profiles-email-mirror.mjs
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
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = (name) => {
  const p = path.resolve(__dirname, '..', 'supabase', 'migrations', name);
  console.log(`  executing ${path.relative(process.cwd(), p).replace(/\\/g, '/')}`);
  return fs.readFileSync(p, 'utf8');
};

const db = new PGlite({ extensions: { uuid_ossp } });
const q = async (sql, params) => (await db.query(sql, params)).rows;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

/** Run something and return the Postgres error, or null if it succeeded. */
const attempt = async (sql, params) => {
  try {
    await db.query(sql, params);
    return null;
  } catch (err) {
    return err;
  }
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
const asOwner = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
};
/** GoTrue's role: rights on auth.users, none on public.profiles. */
const asAuthAdmin = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  await db.exec('set role supabase_auth_admin');
};

// ---------------------------------------------------------------------------
// 1. The bits of Supabase the migrations assume.
// ---------------------------------------------------------------------------
console.log('\n--- supabase stubs ---------------------------------------------');
await db.exec(`
  do $$ begin create role anon;                     exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated;            exception when duplicate_object then null; end $$;
  do $$ begin create role service_role bypassrls;   exception when duplicate_object then null; end $$;
  do $$ begin create role supabase_auth_admin;      exception when duplicate_object then null; end $$;

  create schema if not exists auth;
  create schema if not exists storage;

  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    email_change text,
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

  -- Stand-ins: 005 rewrites policies on these three, 082 never touches them.
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

  -- GoTrue owns the auth schema's data and has nothing in public.
  grant usage on schema auth to supabase_auth_admin;
  grant select, insert, update, delete on auth.users to supabase_auth_admin;
`);
console.log('  auth schema, roles (incl. supabase_auth_admin) and the stub tables are in place');

// ---------------------------------------------------------------------------
// 2. The real migration chain, verbatim, up to the schema 082 lands on.
// ---------------------------------------------------------------------------
console.log('\n--- the schema production has -----------------------------------');
await db.exec(migration('001_initial_schema.sql'));
await db.exec(migration('005_fix_rls_recursion.sql'));
await db.exec(migration('008_submatters.sql'));
await db.exec(migration('016_matterspace_members.sql'));
await db.exec(migration('022_matterspaces_rls_invoker_wrappers.sql'));
await db.exec(`
  grant select, insert, update, delete on all tables in schema public
    to anon, authenticated, service_role;
`);
await db.exec(migration('062_profiles_rls_plan.sql'));

// ---------------------------------------------------------------------------
// 3. Three accounts, born through the real handle_new_user trigger.
// ---------------------------------------------------------------------------
console.log('\n--- three accounts ---------------------------------------------');
const signup = async (email, name) => {
  const [row] = await q(
    `insert into auth.users (email, raw_user_meta_data)
     values ($1, jsonb_build_object('display_name', $2::text)) returning id`,
    [email, name],
  );
  return row.id;
};
const E = await signup('equainton@example.test', 'Eden');  // will change login email BEFORE 082
const B = await signup('bob@example.test', 'Bob');         // the one doing the inviting
const C = await signup('cara@example.test', 'Cara');       // will change login email AFTER 082

const find = async (asUid, email) => {
  await asUser(asUid);
  const rows = await q(`select * from public.find_profile_by_email($1)`, [email]);
  await asOwner();
  return rows;
};
const profileEmail = async (uid) =>
  (await q(`select email from public.profiles where id = $1`, [uid]))[0]?.email;

// ---------------------------------------------------------------------------
// 4. Before 082: reproduce the production symptom exactly.
// ---------------------------------------------------------------------------
console.log('\n--- before 082: the drift is real -------------------------------');
await asAuthAdmin();
await q(`update auth.users set email = 'quaintonlaw@example.test' where id = $1`, [E]);
await asOwner();
check(
  (await profileEmail(E)) === 'equainton@example.test',
  'a login-email change leaves profiles.email behind',
  `profiles.email = ${await profileEmail(E)}`,
);
check(
  (await find(B, 'quaintonlaw@example.test')).length === 0,
  'the address the person signs in with cannot be invited ("No Contextspaces account for …")',
);
check(
  (await find(B, 'equainton@example.test'))[0]?.id === E,
  '…while the address they no longer use still resolves to them',
);
const tierBefore = (await q(`select pricing_tier from public.profiles where id = $1`, [E]))[0].pricing_tier;

// ---------------------------------------------------------------------------
// 5. Apply 082 — twice, because prod drifts from this folder.
// ---------------------------------------------------------------------------
console.log('\n--- migration 082 ----------------------------------------------');
await db.exec(migration('082_profiles_email_mirror.sql'));
let second = null;
try {
  await db.exec(migration('082_profiles_email_mirror.sql'));
} catch (err) {
  second = err;
}
check(second === null, '082 is idempotent (second run succeeds)', second ? String(second.message).slice(0, 120) : '');

// ---------------------------------------------------------------------------
// 6. The repair.
// ---------------------------------------------------------------------------
console.log('\n--- after 082: the drifted row is repaired ----------------------');
check(
  (await profileEmail(E)) === 'quaintonlaw@example.test',
  'backfill brought profiles.email up to the login email',
  `profiles.email = ${await profileEmail(E)}`,
);
const mismatches = (await q(
  `select count(*)::int as n from auth.users u join public.profiles p on p.id = u.id
    where p.email is distinct from u.email`,
))[0].n;
check(mismatches === 0, 'no profile disagrees with its auth row', `${mismatches} mismatches`);
check(
  (await q(`select pricing_tier from public.profiles where id = $1`, [E]))[0].pricing_tier === tierBefore,
  'backfill left pricing_tier alone (profiles_guard_plan had nothing to object to)',
);
check(
  (await find(B, 'quaintonlaw@example.test'))[0]?.id === E,
  'the login address now resolves to the account',
);
check(
  (await find(B, '  QuaintonLaw@Example.TEST '))[0]?.id === E,
  '…case- and whitespace-insensitively, as before',
);
check(
  (await find(B, 'equainton@example.test')).length === 0,
  'the abandoned address no longer resolves to anyone',
);

// ---------------------------------------------------------------------------
// 7. The mirror: a change made the way GoTrue makes it, after 082.
// ---------------------------------------------------------------------------
console.log('\n--- after 082: new email changes are mirrored -------------------');
await asAuthAdmin();
const pending = await attempt(`update auth.users set email_change = 'cara.new@example.test' where id = $1`, [C]);
await asOwner();
check(pending === null, 'a pending (unconfirmed) change is accepted', pending ? String(pending.message) : '');
check(
  (await profileEmail(C)) === 'cara@example.test',
  '…and does NOT move profiles.email (only the confirmed address is mirrored)',
);
await asAuthAdmin();
const confirmed = await attempt(
  `update auth.users set email = 'cara.new@example.test', email_change = null where id = $1`, [C],
);
await asOwner();
check(
  confirmed === null,
  'supabase_auth_admin (no rights on public.profiles) can confirm the change',
  confirmed ? String(confirmed.message).slice(0, 120) : '',
);
check(
  (await profileEmail(C)) === 'cara.new@example.test',
  'profiles.email followed the confirmed change',
  `profiles.email = ${await profileEmail(C)}`,
);
check((await find(B, 'cara.new@example.test'))[0]?.id === C, 'the new address can be invited');
check((await find(B, 'cara@example.test')).length === 0, 'the old one cannot');
check((await profileEmail(B)) === 'bob@example.test', 'nobody else\'s row moved');

// A mirror failure must never block the login-email change itself.
await db.exec(`alter table public.profiles add constraint _t_email_unique unique (email)`);
await asAuthAdmin();
// auth.users.email is not unique in this stub, so this collides only in profiles.
const collide = await attempt(`update auth.users set email = 'bob@example.test' where id = $1`, [C]);
await asOwner();
check(collide === null, 'a failing mirror is a warning, not a blocked email change', collide ? String(collide.message).slice(0, 120) : '');
await db.exec(`alter table public.profiles drop constraint _t_email_unique`);
await asAuthAdmin();
await q(`update auth.users set email = 'cara.new@example.test' where id = $1`, [C]);
await asOwner();

// ---------------------------------------------------------------------------
// 8. 062's contract on the lookup is intact.
// ---------------------------------------------------------------------------
console.log('\n--- after 082: the lookup is still narrow -----------------------');
await asAnon();
const anonErr = await attempt(`select * from public.find_profile_by_email('bob@example.test')`);
await asOwner();
check(anonErr !== null && anonErr.code === '42501', 'anon cannot execute find_profile_by_email', anonErr ? anonErr.code : 'it ran');
const cols = Object.keys((await find(E, 'bob@example.test'))[0] ?? {}).sort().join(',');
check(cols === 'display_name,id', 'it returns id + display_name and no email', cols || '(no row)');
check((await find(B, '%')).length === 0 && (await find(B, 'bob%')).length === 0, 'no wildcards: it cannot enumerate');
check((await find(B, '')).length === 0, 'empty input returns nothing');
await asUser(B);
const directRead = await attempt(`select email from auth.users limit 1`);
await asOwner();
check(directRead !== null, 'a signed-in user still cannot read auth.users directly', directRead ? directRead.code : 'it ran');
const stranger = await (async () => {
  await asUser(B);
  const rows = await q(`select id from public.profiles where id = $1`, [E]);
  await asOwner();
  return rows.length;
})();
check(stranger === 0, '062\'s profiles SELECT policy is untouched (a stranger\'s row is still invisible)');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
