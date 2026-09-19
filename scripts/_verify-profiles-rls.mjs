// Execute migration 062 against a real Postgres and prove what it claims.
//
// Why this exists
// ---------------------------------------------------------------------------
// 062 closes two holes that have been open since migration 001: any signed-in
// user could set their own profiles.pricing_tier from the browser, and every
// user could read every other user's row (email included). "It looks right"
// is not good enough for a permission fix, and there is no local Postgres and
// no Docker on this machine — so this runs the REAL migration files inside
// PGlite (Postgres 18 compiled to WebAssembly, in this Node process: real
// plpgsql, real roles, real RLS) and asserts the behaviour.
//
// It runs the genuine 001 / 005 / 008 / 016 / 022 chain first, so the
// membership policies the new profiles policy leans on are the ones
// production actually has — including 005's DEFINER helpers, which are what
// keep the membership tables from recursing, and 022's INVOKER wrappers,
// which are the pattern 062's own wrapper follows. Only documents, passages
// and storage.objects are stubbed (005 rewrites policies on them; their real
// migration pulls in pgvector and the storage schema, neither of which 062
// touches).
//
// Three things here are worth more than the rest:
//   * it proves the hole was real BEFORE 062 (a test that cannot fail on the
//     old schema is not testing anything);
//   * it runs 062 TWICE — prod drifts from this folder, so the file has to be
//     re-runnable;
//   * it re-runs `grant all on all tables in schema public to authenticated`
//     AFTER 062 and shows the guard still holds. That is the whole argument
//     for a trigger rather than column privileges alone.
//
//   npm i --no-save @electric-sql/pglite     # once; not a repo dependency
//   node scripts/_verify-profiles-rls.mjs
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
const asService = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  await db.exec('set role service_role');
};
const asOwner = () => db.exec('reset role');

// ---------------------------------------------------------------------------
// 1. The bits of Supabase the migrations assume: roles, the auth schema,
//    auth.uid(), and stand-ins for the three tables 005 also rewrites.
// ---------------------------------------------------------------------------
console.log('\n--- supabase stubs ---------------------------------------------');
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

  -- The real auth.uid() reads the request's JWT claims out of a GUC.
  create or replace function auth.uid() returns uuid
  language sql stable as $$
    select nullif(
      coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      ), ''
    )::uuid
  $$;

  -- Stand-ins: 005 rewrites policies on these three, 062 never touches them.
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
`);
console.log('  auth schema, roles and the three stub tables are in place');

// ---------------------------------------------------------------------------
// 2. The real migration chain, verbatim.
// ---------------------------------------------------------------------------
console.log('\n--- the schema production has -----------------------------------');
await db.exec(migration('001_initial_schema.sql'));
await db.exec(migration('005_fix_rls_recursion.sql'));
await db.exec(migration('008_submatters.sql'));
await db.exec(migration('016_matterspace_members.sql'));
await db.exec(migration('022_matterspaces_rls_invoker_wrappers.sql'));

// What Supabase itself does to every table in public, and what any future
// "fix the permissions" paste does again. This is the grant that made the
// pricing_tier hole reachable from a browser.
const BLANKET_GRANT = `
  grant select, insert, update, delete on all tables in schema public
    to anon, authenticated, service_role;
`;
await db.exec(BLANKET_GRANT);
console.log('  blanket table grants applied (the Supabase default)');

// ---------------------------------------------------------------------------
// 3. Four accounts, born the way signup makes them (through the real
//    handle_new_user trigger on auth.users).
// ---------------------------------------------------------------------------
console.log('\n--- four accounts ----------------------------------------------');
const signup = async (email, name) => {
  const [row] = await q(
    `insert into auth.users (email, raw_user_meta_data)
     values ($1, jsonb_build_object('display_name', $2::text)) returning id`,
    [email, name],
  );
  return row.id;
};
const A = await signup('ada@example.test', 'Ada');       // our user
const B = await signup('bob@example.test', 'Bob');       // a stranger
const C = await signup('cara@example.test', 'Cara');     // co-member of a serverspace
const D = await signup('dan@example.test', 'Dan');       // co-counsel on one matter only

const profileCount = (await q(`select count(*)::int as n from public.profiles`))[0].n;
check(profileCount === 4, 'handle_new_user created a profile per signup', `${profileCount} profiles`);

const [s1] = await q(
  `insert into public.serverspaces (clientspace_id, name)
   select id, 'Quainton Law' from public.clientspaces where user_id = $1 returning id`,
  [A],
);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner')`, [s1.id, A]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'member')`, [s1.id, C]);
const [m1] = await q(
  `insert into public.matterspaces (serverspace_id, name) values ($1, 'Peloso v. Curtis') returning id`,
  [s1.id],
);
await q(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,'member')`, [m1.id, D]);
console.log('  Ada owns a serverspace, Cara is a member of it, Dan is co-counsel on one matter, Bob is a stranger');

// ---------------------------------------------------------------------------
// 4. The holes, on the schema as it stands TODAY. If these two pass, the
//    assertions after 062 are measuring something real.
// ---------------------------------------------------------------------------
console.log('\n--- before 062: the holes are real ------------------------------');
await asUser(A);
const selfUpgrade = await attempt(
  `update public.profiles set pricing_tier = 'max' where id = $1`, [A],
);
check(selfUpgrade === null, 'a signed-in user CAN set their own pricing_tier (001:131)');
const strangers = await q(`select email from public.profiles where id = $1`, [B]);
check(strangers.length === 1, "a signed-in user CAN read a stranger's email (001:130)",
  strangers[0]?.email ?? '');
await asOwner();
await q(`update public.profiles set pricing_tier = 'free' where id = $1`, [A]);

// ---------------------------------------------------------------------------
// 5. Apply 062 — twice, because prod drifts from this folder and the file has
//    to survive being pasted again.
// ---------------------------------------------------------------------------
console.log('\n--- migration 062 ----------------------------------------------');
const before = await q(`select id, pricing_tier from public.profiles order by email`);
await db.exec(migration('062_profiles_rls_plan.sql'));
let second = null;
try {
  await db.exec(migration('062_profiles_rls_plan.sql'));
} catch (err) {
  second = err;
}
check(second === null, '062 is idempotent (second run succeeds)', second ? String(second.message).slice(0, 120) : '');

// Captured here, before section 6 deliberately re-widens the table grant.
const grantsAfter062 = await q(
  `select column_name from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'profiles'
      and grantee = 'authenticated' and privilege_type = 'UPDATE'
    order by 1`,
);

const after = await q(`select id, pricing_tier from public.profiles order by email`);
check(
  JSON.stringify(before) === JSON.stringify(after),
  '062 sets no row\'s pricing_tier (every account still where it was)',
  after.map((r) => r.pricing_tier).join(', '),
);

// ---------------------------------------------------------------------------
// 6. The plan is server-owned.
// ---------------------------------------------------------------------------
console.log('\n--- pricing_tier is the service role\'s to write ------------------');
await asUser(A);

const selfUpgrade2 = await attempt(`update public.profiles set pricing_tier = 'max' where id = $1`, [A]);
check(!!selfUpgrade2, 'a user CANNOT set their own pricing_tier', selfUpgrade2?.code ?? '');

const sneaky = await attempt(
  `update public.profiles set display_name = 'Ada Q', pricing_tier = 'workshop' where id = $1`, [A],
);
check(!!sneaky, 'and cannot smuggle it in alongside a legitimate column', sneaky?.code ?? '');

const rename = await attempt(`update public.profiles set display_name = 'Ada Q' where id = $1`, [A]);
const renamed = (await q(`select display_name from public.profiles where id = $1`, [A]))[0]?.display_name;
check(rename === null && renamed === 'Ada Q', 'own-profile edits still work (display_name)', renamed ?? '');

const avatar = await attempt(`update public.profiles set avatar_url = 'https://x/y.png' where id = $1`, [A]);
check(avatar === null, 'own-profile edits still work (avatar_url)');

const hijack = await db.query(`update public.profiles set display_name = 'pwned' where id = $1`, [B]);
check(hijack.affectedRows === 0, "a user cannot edit a stranger's profile", `${hijack.affectedRows} rows`);

await asService();
const byService = await attempt(`update public.profiles set pricing_tier = 'workshop' where id = $1`, [A]);
const tier = (await q(`select pricing_tier from public.profiles where id = $1`, [A]))[0]?.pricing_tier;
check(byService === null && tier === 'workshop', "the service role CAN set it (Eden's workshop line)", tier ?? '');

const badTier = await attempt(`update public.profiles set pricing_tier = 'enterprise' where id = $1`, [A]);
check(!!badTier, "the check constraint still rejects a tier that isn't free/pro/max/workshop");

// The argument for a trigger and not column grants alone: re-open the grant.
await asOwner();
await db.exec(BLANKET_GRANT);
await asUser(A);
const afterRegrant = await attempt(`update public.profiles set pricing_tier = 'max' where id = $1`, [A]);
check(!!afterRegrant,
  'still blocked after a blanket re-grant to authenticated (this is why it is a trigger)',
  afterRegrant?.code ?? '');

// ---------------------------------------------------------------------------
// 7. Email is no longer public.
// ---------------------------------------------------------------------------
console.log('\n--- who can read whose row -------------------------------------');
await asUser(A);

const own = await q(`select id, email, pricing_tier from public.profiles where id = $1`, [A]);
check(own.length === 1 && own[0].email === 'ada@example.test' && own[0].pricing_tier === 'workshop',
  'A reads their own row in full (this is the read the app makes for the plan)');

const stranger = await q(`select id, email from public.profiles where id = $1`, [B]);
check(stranger.length === 0, "A cannot read stranger B's row at all (no email, no row)");

const coMember = await q(`select id, display_name, email, avatar_url from public.profiles where id = $1`, [C]);
check(coMember.length === 1 && coMember[0].display_name === 'Cara',
  'A reads co-member C: display fields resolve (member lists, comment authors, margin notes)');
check(coMember[0]?.email === 'cara@example.test',
  '  …and C\'s email, which the Share dialog prints for every member');

const coCounsel = await q(`select id, display_name from public.profiles where id = $1`, [D]);
check(coCounsel.length === 1,
  'A reads matter-only co-counsel D (serverspace owner ↔ matter member, the asymmetric case)');

const visible = await q(`select count(*)::int as n from public.profiles`);
check(visible[0].n === 3, 'A sees exactly 3 of the 4 accounts — everyone but the stranger', `${visible[0].n}`);

await asUser(D);
const dSeesA = await q(`select count(*)::int as n from public.profiles where id = $1`, [A]);
const dSeesB = await q(`select count(*)::int as n from public.profiles where id = $1`, [B]);
check(dSeesA[0].n === 1 && dSeesB[0].n === 0,
  'and it is symmetric: D reads A (shared matter) but not B');

await asUser(B);
const bSees = await q(`select count(*)::int as n from public.profiles`);
check(bSees[0].n === 1, 'B, who shares nothing, sees only himself', `${bSees[0].n}`);

await asAnon();
const anonSees = await q(`select count(*)::int as n from public.profiles`);
check(anonSees[0].n === 0, 'a signed-out caller sees nothing');

// ---------------------------------------------------------------------------
// 8. Invite by email still works, and still cannot enumerate.
// ---------------------------------------------------------------------------
console.log('\n--- invite by email (ShareModal) --------------------------------');
await asUser(A);
const found = await q(`select * from public.find_profile_by_email($1)`, ['  BOB@example.test ']);
check(found.length === 1 && found[0].id === B,
  'find_profile_by_email resolves a stranger by exact address (trimmed, case-insensitive)');
check(!('email' in (found[0] ?? {})),
  '  …and returns no email column', Object.keys(found[0] ?? {}).join(', '));

const miss = await q(`select * from public.find_profile_by_email($1)`, ['nobody@example.test']);
check(miss.length === 0, 'an address with no account returns nothing');

await asAnon();
const anonLookup = await attempt(`select * from public.find_profile_by_email($1)`, ['bob@example.test']);
check(anonLookup?.code === '42501',
  'a signed-out caller cannot even call it (execute is granted to authenticated only)',
  anonLookup?.code ?? 'no error');

// ---------------------------------------------------------------------------
// 9. Structure.
// ---------------------------------------------------------------------------
console.log('\n--- structure ---------------------------------------------------');
await asOwner();
const pol = await q(
  `select polname from pg_policy where polrelid = 'public.profiles'::regclass order by 1`,
);
check(!pol.some((p) => p.polname === 'Profiles are viewable by everyone'),
  'the using(true) select policy is gone');
check(pol.length === 3, 'profiles carries exactly 3 policies', pol.map((p) => p.polname).join(' | '));

const trg = await q(
  `select tgname from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = 'profiles_guard_plan'`,
);
check(trg.length === 1, 'the guard trigger is installed exactly once');

// Measured immediately after 062, i.e. before section 6 re-ran the blanket
// grant on purpose. The grants are the braces; the trigger is the belt.
check(
  grantsAfter062.map((g) => g.column_name).join(',') === 'assistant_mode,avatar_url,display_name',
  'authenticated holds column UPDATE on exactly name/avatar/assistant_mode',
  grantsAfter062.map((g) => g.column_name).join(',') || '(none)',
);

const wrapper = await q(
  `select prosecdef, l.lanname
     from pg_proc p join pg_language l on l.oid = p.prolang
    where p.proname = '_profiles_select_check'`,
);
check(wrapper.length === 1 && wrapper[0].prosecdef === false && wrapper[0].lanname === 'plpgsql',
  'the policy wrapper is SECURITY INVOKER plpgsql (feedback_rls_security_invoker_wrappers)');

const helper = await q(
  `select prosecdef, pronargs, prosrc from pg_proc where proname = '_profiles_share_workspace'`,
);
check(helper.length === 1 && helper[0].prosecdef === true && helper[0].pronargs === 2,
  'the membership lookup underneath it is DEFINER and takes both ids');
check(helper.length === 1 && !/auth\.uid\(\)/.test(helper[0].prosrc),
  '  …and never calls auth.uid(), so 022\'s hazard cannot reach it');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
