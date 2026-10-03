// Migration 105, EXECUTED — one person edits a brief at a time.
//
// The hold (brief_edit_leases) through its two INVOKER functions, as
// `authenticated` with request.jwt.claims set the way PostgREST sets them,
// over the real can_access_matter / can_write_matter (016) and real RLS:
// first window holds; a second window (same person or another) does not;
// renewal keeps the start time; a lapsed hold passes on; "Take over" works and
// the old window learns it lost; a viewer never holds; an outsider gets
// nothing; release is only one's own; the table cannot be written directly.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-brief-edit-lease.mjs
//
// No .env, no network, no prod.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.error('Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = (name) => fs.readFileSync(path.resolve(__dirname, '..', 'supabase', 'migrations', name), 'utf8');

process.on('unhandledRejection', (e) => {
  console.error(`\n  SQL ERROR: ${e?.message ?? e}\n`);
  process.exit(1);
});

const db = new PGlite();
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------------------
// Schema: enough of 001/002/005/016/051 that the REAL policy can run.
// ---------------------------------------------------------------------------
console.log('\n--- schema, roles, RLS ---------------------------------------');
await db.exec(`
  create schema if not exists auth;
  create role anon;
  create role authenticated;
  -- BYPASSRLS, exactly as production has it.
  create role service_role bypassrls;

  create table public.serverspaces (id uuid primary key default gen_random_uuid(), name text);
  create table public.matterspaces (
    id uuid primary key default gen_random_uuid(),
    serverspace_id uuid,
    parent_matterspace_id uuid,
    name text,
    -- migration 051: 'A' open, 'B' sealed, 'C' silo. The seal inherits down.
    ai_tier text not null default 'A'
  );
  create table public.serverspace_members (
    serverspace_id uuid, user_id uuid, role text, primary key (serverspace_id, user_id));
  create table public.matterspace_members (
    matterspace_id uuid, user_id uuid, role text, primary key (matterspace_id, user_id));
  create table public.documents (
    id uuid primary key default gen_random_uuid(),
    matterspace_id uuid not null,
    title text not null,
    doc_type text not null default 'other',
    source_filename text,
    file_size_bytes bigint,
    page_count int,
    storage_path text,
    processing_status text not null default 'ready',
    processing_error text,
    metadata jsonb not null default '{}',
    created_by uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create index idx_documents_matterspace on public.documents(matterspace_id);
`);

await db.exec(`
  create function auth.uid() returns uuid language sql stable as $fn$
    select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
  $fn$;

  create function public.matter_ancestry(p_matter_id uuid)
  returns table(id uuid) language sql stable security definer set search_path to 'public' as $fn$
    with recursive a(id, parent_matterspace_id) as (
      select id, parent_matterspace_id from public.matterspaces where id = p_matter_id
      union all
      select m.id, m.parent_matterspace_id
        from public.matterspaces m join a on m.id = a.parent_matterspace_id
    )
    select id from a
  $fn$;

  create function public.matter_role(p_matter_id uuid)
  returns text language plpgsql stable security definer set search_path to 'public' as $fn$
  declare
    uid uuid := auth.uid();
    best text;
  begin
    if uid is null then return null; end if;
    select role into best from (
      select mm.role from public.matterspace_members mm
        where mm.user_id = uid
          and mm.matterspace_id in (select id from public.matter_ancestry(p_matter_id))
      union all
      select sm.role from public.matterspaces m
        join public.serverspace_members sm on sm.serverspace_id = m.serverspace_id
       where m.id = p_matter_id and sm.user_id = uid
    ) r
    order by case role when 'owner' then 4 when 'admin' then 3
                       when 'member' then 2 when 'viewer' then 1 else 0 end desc
    limit 1;
    return best;
  end $fn$;

  create function public.can_access_matter(p_matter_id uuid)
  returns boolean language sql stable security definer set search_path to 'public' as $fn$
    select public.matter_role(p_matter_id) is not null
  $fn$;

  create function public.can_write_matter(p_matter_id uuid)
  returns boolean language sql stable security definer set search_path to 'public' as $fn$
    select public.matter_role(p_matter_id) in ('owner','admin','member')
  $fn$;

  alter table public.documents   enable row level security;
  alter table public.matterspaces enable row level security;
  create policy d_sel on public.documents for select using (can_access_matter(matterspace_id));
  create policy d_upd on public.documents for update using (can_write_matter(matterspace_id));
  create policy m_sel on public.matterspaces for select using (can_access_matter(id));

  grant usage on schema public to anon, authenticated, service_role;
  grant select, update on all tables in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`);
await db.exec(`grant select, insert, update, delete on all tables in schema public to service_role;`);
// As Supabase has it: every NEW table in public is granted ALL to anon and
// authenticated by default. 105 must take that back itself.
await db.exec(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`);

const ALICE = '00000000-0000-0000-0000-00000000000a';
const BOB = '00000000-0000-0000-0000-00000000000b';
const CAROL = '00000000-0000-0000-0000-00000000000c';   // viewer
const MALLORY = '00000000-0000-0000-0000-00000000000d'; // no access
const TAB_A1 = '10000000-0000-0000-0000-0000000000a1';
const TAB_A2 = '10000000-0000-0000-0000-0000000000a2';
const TAB_B1 = '10000000-0000-0000-0000-0000000000b1';
const TAB_C1 = '10000000-0000-0000-0000-0000000000c1';
const TAB_M1 = '10000000-0000-0000-0000-0000000000d1';

const ss = (await one(`insert into public.serverspaces(name) values ('Quainton Law') returning id`)).id;
await q(`insert into public.serverspace_members values ($1,$2,'owner')`, [ss, ALICE]);
const matter = (await one(`insert into public.matterspaces(serverspace_id, name) values ($1,'Bushell') returning id`, [ss])).id;
await q(`insert into public.matterspace_members values ($1,$2,'member'), ($1,$3,'viewer')`, [matter, BOB, CAROL]);
const brief = (await one(`insert into public.documents(matterspace_id, title, doc_type) values ($1,'Bushell v18','brief') returning id`, [matter])).id;

console.log('\n--- migration 105 --------------------------------------------');
await db.exec(migration('105_brief_edit_lease.sql'));
check(true, '105 executes');
await db.exec(migration('105_brief_edit_lease.sql'));
check(true, '105 executes a second time (re-paste is safe)');

const as = async (uid, sql, params = [], role = 'authenticated') => {
  await db.exec('begin');
  await db.query(`select set_config('role', $1, true)`, [role]);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [uid ? JSON.stringify({ sub: uid, role }) : '']);
  try {
    const out = (await db.query(sql, params)).rows;
    await db.exec('commit');
    return out;
  } catch (e) {
    await db.exec('rollback');
    throw e;
  }
};
const claim = async (uid, tab, force = false, name = '') =>
  (await as(uid, `select * from public.claim_brief_edit($1,$2,$3,$4)`, [brief, tab, name, force]))[0];
const raises = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const age = (secs) => q(`update public.brief_edit_leases set heartbeat_at = now() - make_interval(secs => $1) where document_id = $2`, [secs, brief]);
const leases = async () => (await one(`select count(*)::int n from public.brief_edit_leases`)).n;

console.log('\n--- holding ---------------------------------------------------');
const a1 = await claim(ALICE, TAB_A1, false, 'Eden Quainton');
check(a1?.holder_is_me === true && a1.holder_user === ALICE && a1.holder_name === 'Eden Quainton', 'the first window to open the brief holds it');
const a2 = await claim(ALICE, TAB_A2);
check(a2?.holder_is_me === false && a2.holder_user === ALICE, "the same person's second window does not; it is told who holds it (themselves)");
const b1 = await claim(BOB, TAB_B1, false, 'Bob');
check(b1?.holder_is_me === false && b1.holder_name === 'Eden Quainton', "a colleague's window does not, and sees the holder's name");
const a1again = await claim(ALICE, TAB_A1, false, 'Eden Quainton');
check(a1again?.holder_is_me === true && String(a1again.claimed_at) === String(a1.claimed_at), 'renewing keeps the hold and the time it began');

console.log('\n--- passing on ------------------------------------------------');
await age(149);
check((await claim(BOB, TAB_B1))?.holder_is_me === false, 'a hold renewed 149 s ago is still held');
await age(151);
const b1late = await claim(BOB, TAB_B1, false, 'Bob');
check(b1late?.holder_is_me === true && b1late.holder_user === BOB, 'a hold not renewed for 150 s has lapsed: the next window takes it');
check((await claim(ALICE, TAB_A1))?.holder_is_me === false, 'and the window that let it lapse learns on its next renewal that it lost it');
const forced = await claim(ALICE, TAB_A2, true, 'Eden Quainton');
check(forced?.holder_is_me === true && forced.holder_user === ALICE, '"Take over editing" takes a live hold');
const bLost = await claim(BOB, TAB_B1);
check(bLost?.holder_is_me === false && bLost.holder_user === ALICE, 'the window that was taken over from learns it at once');

console.log('\n--- who may hold ----------------------------------------------');
const c = await claim(CAROL, TAB_C1, true);
check(c?.holder_is_me === false && c.holder_user === ALICE, 'a viewer never holds, even forcing; they see who does');
await q(`delete from public.brief_edit_leases`);
check((await claim(CAROL, TAB_C1)) === undefined, 'a viewer with nobody holding gets no hold and no row');
check(/brief not found/.test((await raises(() => claim(MALLORY, TAB_M1))) ?? ''), 'someone who cannot read the brief is told nothing beyond "not found"');
check(/not signed in/.test((await raises(() => as(null, `select * from public.claim_brief_edit($1,$2)`, [brief, TAB_M1]))) ?? ''), 'no session: refused');
const anon = await raises(() => as(null, `select * from public.claim_brief_edit($1,$2)`, [brief, TAB_M1], 'anon'));
check(/not signed in|permission denied/.test(anon ?? ''), 'anon: refused', anon ?? 'accepted');

console.log('\n--- release ---------------------------------------------------');
await claim(ALICE, TAB_A1);
await as(BOB, `select public.release_brief_edit($1,$2)`, [brief, TAB_B1]);
check((await leases()) === 1, "another person's release does nothing");
await as(ALICE, `select public.release_brief_edit($1,$2)`, [brief, TAB_A2]);
check((await leases()) === 1, "the same person's OTHER window cannot release it either");
await as(ALICE, `select public.release_brief_edit($1,$2)`, [brief, TAB_A1]);
check((await leases()) === 0, 'the holding window releases it');

console.log('\n--- the table itself ------------------------------------------');
await claim(ALICE, TAB_A1);
const ins = await raises(() => as(BOB, `insert into public.brief_edit_leases(document_id, holder_tab, holder_user) values ($1,$2,$3)`, [brief, TAB_B1, BOB]));
check(!!ins, 'a direct INSERT is refused', ins ?? 'it was accepted');
const upd = await as(BOB, `update public.brief_edit_leases set holder_user = $1 returning 1`, [BOB]).catch((e) => e.message);
check(typeof upd === 'string' || upd.length === 0, 'a direct UPDATE changes nothing', JSON.stringify(upd));
const del = await as(BOB, `delete from public.brief_edit_leases returning 1`).catch((e) => e.message);
check(typeof del === 'string' || del.length === 0, 'a direct DELETE removes nothing', JSON.stringify(del));
check((await one(`select holder_user from public.brief_edit_leases`)).holder_user === ALICE, "and the hold is still Alice's");
check((await as(MALLORY, `select * from public.brief_edit_leases`)).length === 0, 'someone outside the matter cannot even see that the brief is held');
check((await as(CAROL, `select * from public.brief_edit_leases`)).length === 1, 'a viewer of the matter can see who holds it');
await q(`delete from public.documents where id = $1`, [brief]);
check((await leases()) === 0, 'deleting the brief removes its hold');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
