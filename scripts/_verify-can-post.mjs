// Migration 093 — the per-person "Can post messages" switch on matter shares —
// EXECUTED in PGlite on the real chain (001…022, 051, 017, 021, 062, 042's view,
// 064 + 072 — the Record, whose ACL trigger fires on the switch — 091, 092)
// with real RLS, as each person, from SET ROLE authenticated.
//
// The cast:
//   Eden    owns the firm's serverspace
//   Adam    ADMIN on the Bushell matter (matterspace_members)
//   James   the client, VIEWER on Bushell, shared before 093 (backfilled on)
//   Yfat    co-counsel, MEMBER on the Bushell folder, shared before 093;
//           the owner switches her off after the paste (as the lead will)
//   Nina    co-counsel shared AFTER 093 (new share: off by default)
//   Sam     a row on Bushell with can_post ON and one on the folder with it
//           OFF — the ancestor row grants the folder
//   Kim     a row on Bushell with can_post OFF and one on the folder ON —
//           posts in the folder only
//   Mia     a VIEWER of the whole serverspace (posts, as today)
//
// What it proves
//   SQL      093 applies on 091+092 and again over itself, converging; the
//            backfill turns every existing share ON once; new shares start
//            OFF; a second paste never turns anyone back on. Every policy on
//            the touched tables calls only public SECURITY INVOKER wrappers;
//            the new public function is not executable by anon.
//   OFF      Yfat reads everything she read before, but cannot post a message,
//            reply, paste an email, start a conversation, or post the old way
//            (no conversation id — Moot Bench / the legacy thread). General
//            may still be ensured.
//   SWITCH   she cannot flip her own switch; James (not an admin) cannot flip
//            hers; Adam (admin) and Eden (owner) can; nobody can change a
//            share's role or matter through UPDATE.
//   ON       once on, she posts, pastes and starts conversations.
//   ALWAYS   owners and admins post whatever their own row says; serverspace
//            members post; James (backfilled) posts.
//   ANCESTOR a share on a parent grants its folders; a folder share grants
//            only the folder.
//   PRIVATE  someone an owner puts on a private conversation posts there with
//            the switch off (the one-line setting, mirrored in
//            src/lib/conversations.ts); with the setting false she cannot.
//   CONTROL  091's _mconv_can_post put back → the switched-off Yfat posts
//            (the checks can see the hole); re-pasting 093 closes it.
//   ROLLBACK the commented rollback block runs and restores 091 behaviour.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-can-post.mjs
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

process.on('unhandledRejection', (e) => {
  console.error(`\n  UNHANDLED: ${String(e?.stack ?? e?.message ?? e)}\n`);
  process.exit(1);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const migration = (name) => fs.readFileSync(path.resolve(ROOT, 'supabase', 'migrations', name), 'utf8');
const M093 = '093_share_can_post.sql';

let failures = 0;
let passes = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (ok) passes += 1; else failures += 1;
};
const section = (t) => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 62 - t.length))}`);

const db = new PGlite({ extensions: { uuid_ossp } });
const q = async (sql, params) => (await db.query(sql, params)).rows;
const attempt = async (sql, params) => {
  try { return { rows: (await db.query(sql, params)).rows, err: null }; } catch (err) { return { rows: null, err }; }
};
const execAttempt = async (sql) => { try { await db.exec(sql); return { err: null }; } catch (err) { return { err }; } };
const asUser = async (uid) => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec('set role authenticated');
};
const asSuperuser = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
};
const as = async (uid, fn) => {
  await asUser(uid);
  try { return await fn(); } finally { await asSuperuser(); }
};

// ===========================================================================
section('the chain: 001…022, 051, 017, 021, 062, 042, 064, 072, 091, 092');
// ===========================================================================
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
    id uuid primary key default gen_random_uuid(), matterspace_id uuid, created_by uuid,
    title text, created_at timestamptz not null default now());
  create table public.passages (
    id uuid primary key default gen_random_uuid(), matterspace_id uuid);
  create table public.cite_check_runs (
    id uuid primary key default gen_random_uuid(), matterspace_id uuid, created_by uuid,
    completed_at timestamptz, source_label text, status text);
  create table public.meetings (
    id uuid primary key default gen_random_uuid(), matterspace_id uuid, created_by uuid,
    started_at timestamptz, ended_at timestamptz, title text);
  create table public.matter_events (
    id uuid primary key default gen_random_uuid(), matterspace_id uuid, created_by uuid,
    created_at timestamptz not null default now(), title text);
  create table storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  create or replace function storage.foldername(p_name text)
  returns text[] language sql immutable as $$ select string_to_array(p_name, '/') $$;
  grant usage on schema public, auth, storage to anon, authenticated, service_role;
  -- Supabase's default privileges: every new table and function is granted to
  -- anon directly (the 092 lesson).
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  create publication supabase_realtime;
`);
for (const f of [
  '001_initial_schema.sql', '005_fix_rls_recursion.sql', '008_submatters.sql',
  '016_matterspace_members.sql', '022_matterspaces_rls_invoker_wrappers.sql',
  '051_securespace.sql',
  '017_matter_comments.sql', '021_matter_comment_attachments.sql',
]) await db.exec(migration(f));
await db.exec(`
  alter table public.matterspaces add column if not exists ai_tier text not null default 'A';
  alter table public.matterspaces add column if not exists ai_paused boolean not null default false;
  alter table public.matterspaces add column if not exists short_code text;
`);
await db.exec(migration('062_profiles_rls_plan.sql'));
{
  const src = migration('042_matter_state_ledger.sql');
  const start = src.indexOf('drop view if exists public.activity_feed;');
  const end = src.indexOf('grant select on public.activity_feed to authenticated, service_role;');
  await db.exec(src.slice(start, end));
}
await db.exec(`grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema public to anon, authenticated, service_role;`);
// The matter's Record (064 + 072): its ACL trigger fires on every
// matterspace_members change, including the can_post UPDATE this file adds,
// and does NOT swallow its own failure, so it has to be here for real.
await db.exec(migration('064_events_ledger.sql'));
await db.exec(migration('072_account_chain_and_session_immutability.sql'));

const signup = async (email, name) => (await q(`insert into auth.users (email, raw_user_meta_data)
  values ($1, jsonb_build_object('display_name', $2::text)) returning id`, [email, name]))[0].id;
const EDEN = await signup('eden@firm.test', 'Eden Quainton');
const ADAM = await signup('adam@firm.test', 'Adam Admin');
const JAMES = await signup('james@client.test', 'James Bushell');
const YFAT = await signup('yfat@cocounsel.test', 'Yfat');
const NINA = await signup('nina@cocounsel.test', 'Nina');
const SAM = await signup('sam@cocounsel.test', 'Sam');
const KIM = await signup('kim@cocounsel.test', 'Kim');
const MIA = await signup('mia@firm.test', 'Mia');
const STRANGER = await signup('stella@elsewhere.test', 'Stella');

const [firm] = await q(`insert into public.serverspaces (clientspace_id, name)
  select id, 'Quainton Law' from public.clientspaces where user_id = $1 returning id`, [EDEN]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner')
  on conflict do nothing`, [firm.id, EDEN]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'viewer')`, [firm.id, MIA]);

const matter = async (name, parent = null) => (await q(
  `insert into public.matterspaces (serverspace_id, name, parent_matterspace_id) values ($1,$2,$3) returning id`,
  [firm.id, name, parent]))[0].id;
const BUSHELL = await matter('Bushell v. Radiant Solar');
const FOLDER = await matter('Bushell — co-counsel folder', BUSHELL);

const share = (m, u, role) => q(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,$3) returning id`, [m, u, role]);
// Shares that exist before 093.
await share(BUSHELL, ADAM, 'admin');
await share(BUSHELL, JAMES, 'viewer');
await share(FOLDER, YFAT, 'member');
await share(BUSHELL, SAM, 'member');
await share(FOLDER, SAM, 'member');
await share(BUSHELL, KIM, 'member');
await share(FOLDER, KIM, 'member');

await db.exec(migration('091_matter_conversations.sql'));
await db.exec(migration('092_conversations_revoke_anon.sql'));
check(true, 'the chain 093 sits on is applied (051, 064 and 072 for the Record; 091 and 092)');

// ===========================================================================
section('093, applied twice; the backfill; new shares start off');
// ===========================================================================
const shape = async () => JSON.stringify({
  policies: await q(`select tablename, policyname, cmd, qual, with_check from pg_policies
    where tablename in ('matter_comments','matter_conversations','matterspace_members') order by 1,2`),
  cols: await q(`select column_name, column_default, is_nullable from information_schema.columns
    where table_schema='public' and table_name='matterspace_members' order by 1`),
  rows: await q(`select matterspace_id, user_id, can_post from public.matterspace_members order by 1,2`),
});
{
  const r1 = await execAttempt(migration(M093));
  check(!r1.err, '093 applies', r1.err?.message ?? '');
  if (r1.err) { console.error(r1.err); process.exit(1); }
  const before = await q(`select count(*)::int n, count(*) filter (where can_post)::int on_ from public.matterspace_members`);
  check(before[0].n === 7 && before[0].on_ === 7, 'every share that existed is backfilled ON — nobody who could post loses it',
    `${before[0].on_}/${before[0].n}`);
  const s1 = await shape();
  const r2 = await execAttempt(migration(M093));
  check(!r2.err && s1 === await shape(), 'a second paste converges: same policies, column and values', r2.err?.message ?? '');
  const [col] = await q(`select column_default, is_nullable, data_type from information_schema.columns
    where table_schema='public' and table_name='matterspace_members' and column_name='can_post'`);
  check(col.column_default === 'false' && col.is_nullable === 'NO' && col.data_type === 'boolean',
    'can_post is boolean, not null, default false', JSON.stringify(col));
}
// Nina is shared after 093, the way the Share dialog does it (no can_post sent).
await as(EDEN, () => q(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,'member')`, [FOLDER, NINA]));
{
  const [n] = await q(`select can_post from public.matterspace_members where user_id=$1`, [NINA]);
  check(n.can_post === false, 'a share made after 093 (Nina, by the owner, from the app) starts OFF');
}
// The lead switches Yfat off after the paste, as Eden asked.
{
  const off = await as(EDEN, () => q(`update public.matterspace_members set can_post=false where user_id=$1 returning id`, [YFAT]));
  check(off.length === 1, 'Eden (owner) switches Yfat off through the app\'s own UPDATE; 064\'s ACL trigger lets it through');
  const ev = await q(`select actor_kind, actor_ref, payload from public.events
    where kind='acl.changed' and matterspace_id=$1 and payload->>'op'='update' and payload->>'target_user_id'=$2`, [FOLDER, YFAT]);
  check(ev.length === 1 && ev[0].actor_ref === EDEN,
    'the switch is written to the folder\'s Record as acl.changed (op update, by Eden)', JSON.stringify(ev[0] ?? null));
  const r3 = await execAttempt(migration(M093));
  const [y] = await q(`select can_post from public.matterspace_members where user_id=$1`, [YFAT]);
  check(!r3.err && y.can_post === false, 'pasting 093 again afterwards leaves her OFF (the backfill never re-runs)');
}

// ===========================================================================
section('RLS shape');
// ===========================================================================
{
  const pols = await q(`select tablename, policyname, coalesce(qual,'') || ' ' || coalesce(with_check,'') expr from pg_policies
    where tablename in ('matter_comments','matter_conversations','matter_conversation_members','matter_conversation_reads')
       or (tablename='matterspace_members' and cmd='UPDATE')`);
  const calls = new Set();
  for (const p of pols) for (const m of p.expr.matchAll(/([a-z_]+\.)?([a-z_]+)\(/g)) calls.add(m[2]);
  calls.delete('uid');
  const fns = await q(`select p.proname, p.prosecdef, n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.proname = any($1)`, [[...calls]]);
  check(fns.length > 0 && fns.every((f) => f.prosecdef === false && f.nspname === 'public'),
    'every function the conversation and share-UPDATE policies call is a public SECURITY INVOKER wrapper',
    [...calls].sort().join(', '));
  check(calls.has('_mmem_can_set_post'), 'the new UPDATE policy on matterspace_members calls _mmem_can_set_post');
  const [anon] = await q(`select has_function_privilege('anon', 'public._mmem_can_set_post(uuid,uuid)', 'execute') a,
    has_function_privilege('authenticated', 'public._mmem_can_set_post(uuid,uuid)', 'execute') b`);
  check(anon.a === false && anon.b === true, 'the new public function: anon cannot execute it, authenticated can');
  const internals = await q(`select p.proname, has_function_privilege('anon', p.oid, 'execute') a
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='conversations_internal' and p.proname in ('user_can_post_in_matter','message_post','setting_private_members_may_post','conversation_start')`);
  check(internals.length === 4 && internals.every((f) => f.a === false), 'the four conversations_internal functions are not executable by anon');
}

// ===========================================================================
section('the setting agrees with src/lib/conversations.ts');
// ===========================================================================
{
  const ts = fs.readFileSync(path.resolve(ROOT, 'src', 'lib', 'conversations.ts'), 'utf8');
  const tsVal = ts.match(/PRIVATE_MEMBERS_MAY_POST\s*=\s*(true|false)/)?.[1];
  const [sql] = await q(`select conversations_internal.setting_private_members_may_post() v`);
  check(String(sql.v) === tsVal, `people on a private conversation's list may post in it: ${sql.v} in both`, `ts=${tsVal}`);
}

// ===========================================================================
// helpers
// ===========================================================================
const GEN_B = await as(EDEN, async () => (await q(`select public.ensure_general_conversation($1) id`, [BUSHELL]))[0].id);
const GEN_F = await as(EDEN, async () => (await q(`select public.ensure_general_conversation($1) id`, [FOLDER]))[0].id);
const create = (uid, m, title, audience, members = []) => as(uid, () => attempt(
  `select public.create_matter_conversation($1,$2,$3,true,$4::uuid[]) id`, [m, title, audience, members]));
const post = (uid, m, conv, body, extra = {}) => as(uid, () => attempt(
  `insert into public.matter_comments (matterspace_id, user_id, conversation_id, body, kind, email_from, email_subject, parent_id)
   values ($1,$2,$3,$4, coalesce($5,'message'), $6, $7, $8) returning id, conversation_id`,
  [m, uid, conv, body, extra.kind ?? null, extra.from ?? null, extra.subject ?? null, extra.parent ?? null]));
const email = (uid, m, conv) => post(uid, m, conv, 'Forwarded email body', { kind: 'email', from: 'oc@radiant.test', subject: 'Re: offer' });
const canPost = (uid, conv, m) => as(uid, async () => (await q(`select public._mconv_can_post($1,$2) v`, [conv, m]))[0].v);
const canStart = (uid, m) => as(uid, async () => (await q(`select public._mconv_can_start($1,'matter',false) v`, [m]))[0].v);
const setPost = (uid, who, m, v) => as(uid, () => attempt(
  `update public.matterspace_members set can_post=$1 where user_id=$2 and matterspace_id=$3 returning id`, [v, who, m]));

const TEAM_F = (await create(EDEN, FOLDER, 'Folder team', 'matter')).rows?.[0]?.id;
const first = await post(EDEN, FOLDER, TEAM_F, 'Eden: folder kickoff.');
check(TEAM_F && !first.err, 'Eden starts "Folder team" in the folder and posts in it');

// ===========================================================================
section('Yfat, switched OFF: reads, cannot write');
// ===========================================================================
{
  const read = await as(YFAT, () => q(`select body from public.matter_comments where matterspace_id=$1`, [FOLDER]));
  check(read.some((r) => /kickoff/.test(r.body)), 'she reads the folder\'s conversations');
  const list = await as(YFAT, () => q(`select title from public.list_matter_conversations($1)`, [FOLDER]));
  check(list.length === 2, 'her conversation list shows General and Folder team', list.map((c) => c.title).join(', '));
  const gen = await as(YFAT, () => q(`select public.ensure_general_conversation($1) id`, [FOLDER]));
  check(gen[0].id === GEN_F, 'ensure_general_conversation still answers for her (opening the tab works)');

  const m1 = await post(YFAT, FOLDER, TEAM_F, 'Yfat: may I?');
  check(!!m1.err && /row-level security/i.test(m1.err.message), 'she cannot post a message', m1.err?.message ?? 'INSERTED');
  const m2 = await post(YFAT, FOLDER, GEN_F, 'Yfat in General');
  check(!!m2.err, 'nor in General', m2.err?.message ?? 'INSERTED');
  const reply = await post(YFAT, FOLDER, TEAM_F, 'a reply', { parent: first.rows[0].id });
  check(!!reply.err, 'nor reply', reply.err?.message ?? 'INSERTED');
  const em = await email(YFAT, FOLDER, TEAM_F);
  check(!!em.err, 'nor paste an email', em.err?.message ?? 'INSERTED');
  const legacy = await as(YFAT, () => attempt(`insert into public.matter_comments (matterspace_id, user_id, body) values ($1,$2,'old-style') returning id`, [FOLDER, YFAT]));
  check(!!legacy.err, 'nor post the old way, with no conversation (Moot Bench, the legacy thread): the General filing meets the same gate',
    legacy.err?.message ?? 'INSERTED');
  const start = await create(YFAT, FOLDER, 'Yfat starts one', 'matter');
  check(!!start.err, 'nor start a conversation for everyone', start.err?.message ?? 'CREATED');
  const startRaw = await as(YFAT, () => attempt(`insert into public.matter_conversations (matterspace_id, title, audience, created_by) values ($1,'raw','matter',$2)`, [FOLDER, YFAT]));
  check(!!startRaw.err, 'nor by inserting the row directly');
  check(await canPost(YFAT, TEAM_F, FOLDER) === false && await canStart(YFAT, FOLDER) === false,
    'the two helpers the Thread tab asks both answer false for her');
  const nina = await post(NINA, FOLDER, TEAM_F, 'Nina: hello');
  check(!!nina.err, 'Nina (a new share, never switched on) cannot post either');
}

// ===========================================================================
section('the switch: who may flip it');
// ===========================================================================
{
  const self = await setPost(YFAT, YFAT, FOLDER, true);
  check(!self.err && self.rows.length === 0, 'Yfat cannot switch herself on (no row changes)', self.err?.message ?? '');
  const james = await setPost(JAMES, YFAT, FOLDER, true);
  check(!james.err && james.rows.length === 0, 'James (a viewer, not an admin) cannot switch her on', james.err?.message ?? '');
  const nina = await setPost(NINA, YFAT, FOLDER, true);
  check(!nina.err && nina.rows.length === 0, 'Nina (a member of the same folder) cannot either');
  const [still] = await q(`select can_post from public.matterspace_members where user_id=$1`, [YFAT]);
  check(still.can_post === false, '…and she is still off');
  const role = await as(ADAM, () => attempt(`update public.matterspace_members set role='admin' where user_id=$1 returning id`, [YFAT]));
  check(!!role.err && /permission denied/i.test(role.err.message), 'nobody, not even an admin, can change a share\'s role through UPDATE',
    role.err?.message ?? 'CHANGED');
  const moveM = await as(EDEN, () => attempt(`update public.matterspace_members set matterspace_id=$1 where user_id=$2 returning id`, [BUSHELL, YFAT]));
  check(!!moveM.err, 'nor move a share to another matter', moveM.err?.message ?? 'MOVED');
  const selfRole = await as(YFAT, () => attempt(`update public.matterspace_members set role='admin' where user_id=$1 returning id`, [YFAT]));
  check(!!selfRole.err, 'and Yfat cannot promote herself');
  const adamOwn = await setPost(ADAM, ADAM, BUSHELL, false);
  check(adamOwn.rows?.length === 0, 'an admin cannot flip their own switch either');

  const adam = await setPost(ADAM, YFAT, FOLDER, true);
  check(!adam.err && adam.rows.length === 1, 'Adam (admin of Bushell, so of its folder) switches her ON', adam.err?.message ?? '');
}

// ===========================================================================
section('Yfat, switched ON');
// ===========================================================================
{
  const m = await post(YFAT, FOLDER, TEAM_F, 'Yfat: thanks, posting now.');
  const em = await email(YFAT, FOLDER, TEAM_F);
  const legacy = await as(YFAT, () => attempt(`insert into public.matter_comments (matterspace_id, user_id, body) values ($1,$2,'old-style') returning conversation_id`, [FOLDER, YFAT]));
  const start = await create(YFAT, FOLDER, 'Yfat — questions', 'matter');
  check(!m.err && !em.err && !legacy.err && !start.err,
    'she posts, pastes an email, posts the old way (lands in General) and starts a conversation',
    [m, em, legacy, start].map((r) => r.err?.message).filter(Boolean).join(' | '));
  check(legacy.rows?.[0]?.conversation_id === GEN_F, 'the old-way post was filed into General');
  const priv = await create(YFAT, FOLDER, 'Yfat private', 'members', [NINA]);
  check(!!priv.err, 'posting rights do not let her start a PRIVATE conversation (still owners and admins only, 091)');
  const off = await setPost(EDEN, YFAT, FOLDER, false);
  const again = await post(YFAT, FOLDER, TEAM_F, 'after off');
  check(off.rows?.length === 1 && !!again.err, 'Eden switches her off again: she cannot post');
}

// ===========================================================================
section('always: owners, admins, serverspace members, backfilled shares');
// ===========================================================================
{
  await q(`update public.matterspace_members set can_post=false where user_id=$1`, [ADAM]);   // as the SQL editor
  const adam = await post(ADAM, FOLDER, TEAM_F, 'Adam posts with his own row switched off');
  const adamB = await post(ADAM, BUSHELL, GEN_B, 'Adam in Bushell General');
  const adamStart = await create(ADAM, FOLDER, 'Adam starts one', 'matter');
  check(!adam.err && !adamB.err && !adamStart.err, 'Adam (admin) posts and starts conversations whatever his row\'s can_post says',
    [adam, adamB, adamStart].map((r) => r.err?.message).filter(Boolean).join(' | '));
  const eden = await post(EDEN, BUSHELL, GEN_B, 'Eden (owner) posts');
  check(!eden.err, 'Eden (owner) posts');
  const mia = await post(MIA, FOLDER, TEAM_F, 'Mia (serverspace viewer) posts');
  const miaStart = await create(MIA, BUSHELL, 'Mia starts one', 'matter');
  check(!mia.err && !miaStart.err, 'Mia, a serverspace member (viewer), posts and starts a conversation, as today',
    mia.err?.message ?? miaStart.err?.message ?? '');
  const james = await post(JAMES, BUSHELL, GEN_B, 'James (backfilled ON) posts');
  const jamesF = await post(JAMES, FOLDER, TEAM_F, 'James in the folder, through his Bushell share');
  check(!james.err && !jamesF.err, 'James (existing viewer share, backfilled ON) still posts — in Bushell and in its folder');
}

// ===========================================================================
section('ancestors: a share on the parent grants its folders');
// ===========================================================================
{
  await q(`update public.matterspace_members set can_post=false where user_id=$1 and matterspace_id=$2`, [SAM, FOLDER]);
  await q(`update public.matterspace_members set can_post=false where user_id=$1 and matterspace_id=$2`, [KIM, BUSHELL]);
  const samF = await post(SAM, FOLDER, TEAM_F, 'Sam: folder row off, Bushell row on');
  const samB = await post(SAM, BUSHELL, GEN_B, 'Sam in Bushell');
  check(!samF.err && !samB.err, 'Sam (Bushell ON, folder OFF) posts in both: the parent\'s share grants the folder');
  const kimF = await post(KIM, FOLDER, TEAM_F, 'Kim: folder row on');
  const kimB = await post(KIM, BUSHELL, GEN_B, 'Kim in Bushell');
  check(!kimF.err && !!kimB.err, 'Kim (Bushell OFF, folder ON) posts in the folder only — a folder share does not reach the parent',
    kimB.err ? '' : 'Kim posted in Bushell');
  const kimStartB = await create(KIM, BUSHELL, 'Kim in Bushell', 'matter');
  check(!!kimStartB.err, '…and cannot start a conversation in Bushell');
  const readB = await as(KIM, () => q(`select count(*)::int n from public.matter_comments where matterspace_id=$1`, [BUSHELL]));
  check(readB[0].n > 0, '…while still reading Bushell');
}

// ===========================================================================
section('private conversations: being put on the list is authorisation');
// ===========================================================================
let PRIV;
{
  PRIV = (await create(EDEN, FOLDER, 'Eden and Yfat', 'members', [YFAT])).rows?.[0]?.id;
  check(!!PRIV, 'Eden starts a private conversation with Yfat (switched off)');
  const y = await post(YFAT, FOLDER, PRIV, 'Yfat, in the private one');
  const ye = await email(YFAT, FOLDER, PRIV);
  check(!y.err && !ye.err, 'Yfat posts and pastes an email there although her switch is off', y.err?.message ?? ye.err?.message ?? '');
  check(await canPost(YFAT, PRIV, FOLDER) === true && await canPost(YFAT, TEAM_F, FOLDER) === false,
    '_mconv_can_post says yes for that conversation and still no for Folder team');
  const nina = await post(NINA, FOLDER, PRIV, 'Nina tries');
  check(!!nina.err, 'Nina (not on its list) cannot');
  await db.exec(`create or replace function conversations_internal.setting_private_members_may_post()
    returns boolean language sql immutable as $$ select false $$;`);
  const flipped = await post(YFAT, FOLDER, PRIV, 'with the setting false');
  check(!!flipped.err, 'with the setting flipped to false, the switch governs private conversations too');
  await db.exec(`create or replace function conversations_internal.setting_private_members_may_post()
    returns boolean language sql immutable as $$ select true $$;`);
  const archived = await as(EDEN, () => q(`update public.matter_conversations set archived_at=now() where id=$1 returning id`, [PRIV]));
  const afterArchive = await post(YFAT, FOLDER, PRIV, 'after archive');
  const edenArchive = await post(EDEN, FOLDER, PRIV, 'owner after archive');
  check(archived.length === 1 && !!afterArchive.err && !!edenArchive.err, 'archived stays read-only for everyone (091)');
}

// ===========================================================================
section('reading is untouched by the switch');
// ===========================================================================
{
  const count = async () => (await as(YFAT, () => q(`select count(*)::int n from public.matter_comments`)))[0].n;
  const off = await count();
  await setPost(EDEN, YFAT, FOLDER, true);
  const on = await count();
  await setPost(EDEN, YFAT, FOLDER, false);
  check(off === on && off > 0, `Yfat reads the same ${off} messages with the switch off and on`);
}

// ===========================================================================
section('negative control: 091\'s _mconv_can_post put back');
// ===========================================================================
{
  const src = migration('091_matter_conversations.sql');
  const start = src.indexOf('create or replace function public._mconv_can_post(');
  const end = src.indexOf('create or replace function public._mconv_can_delete_message(');
  await db.exec(src.slice(start, end));
  const leak = await post(YFAT, FOLDER, TEAM_F, 'CONTROL: switched off, posting anyway');
  check(!leak.err, 'CONTROL: with 091\'s wrapper back, switched-off Yfat posts — the checks above can see the hole', leak.err?.message ?? '');
  const r = await execAttempt(migration(M093));
  const closed = await post(YFAT, FOLDER, TEAM_F, 'after re-paste');
  check(!r.err && !!closed.err, 're-pasting 093 closes it again');
}

// ===========================================================================
section('rollback: the commented block runs and restores 091');
// ===========================================================================
{
  const src = migration(M093);
  const block = src.slice(src.indexOf('-- begin;'))
    .split('\n').map((l) => l.replace(/^-- ?/, '')).join('\n');
  const r = await execAttempt(block);
  check(!r.err, 'the rollback block executes', r.err?.message ?? '');
  const cols = await q(`select column_name from information_schema.columns where table_schema='public' and table_name='matterspace_members' and column_name='can_post'`);
  const pol = await q(`select 1 from pg_policies where tablename='matterspace_members' and cmd='UPDATE'`);
  check(cols.length === 0 && pol.length === 0, 'can_post and the UPDATE policy are gone');
  const y = await post(YFAT, FOLDER, TEAM_F, 'after rollback');
  const ys = await create(YFAT, FOLDER, 'after rollback', 'matter');
  check(!y.err && !ys.err, 'after rollback anyone who can open the matter posts and starts conversations again (091)');
  const stranger = await post(STRANGER, FOLDER, TEAM_F, 'stranger');
  check(!!stranger.err, 'and someone who cannot open the matter still cannot');
  const reapply = await execAttempt(migration(M093));
  check(!reapply.err, '093 applies again after its own rollback', reapply.err?.message ?? '');
}

// ===========================================================================
section('the screens: what someone without the right is offered');
// ===========================================================================
{
  const read = (p) => fs.readFileSync(path.resolve(ROOT, p), 'utf8');
  const conv = read('src/lib/conversations.ts');
  const thread = read('src/components/matter/MatterThread.tsx');
  const view = read('src/components/matter/thread/ConversationView.tsx');
  const api = read('src/components/matter/thread/api.ts');
  const share = read('src/components/serverspace/ShareModal.tsx');
  check(conv.includes('You can read this matter’s conversations. Posting is off for you — the matter’s owner can turn it on.'),
    'the read-only line is worded as Eden asked');
  check(conv.includes('People you share with can read. Turn on ‘Can post messages’ when they may write in the Thread.'),
    'the Share dialog line is worded as Eden asked');
  check(/rpc\('_mconv_can_start'/.test(api), 'the Thread tab asks the same helper the INSERT policy uses (_mconv_can_start)');
  check(/const newButton = !mayPost \?/.test(thread) && /\{mayPost && \(\s*<button onClick=\{\(\) => setNewOpen\(true\)\}/.test(thread)
    && /newOpen && mayPost/.test(thread),
  'no "New conversation" (desktop or phone) without the right');
  check(/canPost=\{mayPost \|\| postsByMembership\(selected, user\.id\)\}/.test(thread),
    'a conversation is writable when the matter allows it, or by private-list membership (the setting)');
  check(/!archived && canPost && \(\s*<button onClick=\{onPasteEmail\}/.test(view), 'no "Paste an email" without the right');
  check((view.match(/archived \|\| !canPost \? null/g) ?? []).length === 2, 'no Reply without the right');
  check(/!canPost\s*\?\s*<p[^>]*>\{POSTING_OFF_NOTE\}<\/p>/.test(view), 'the composer becomes the read-only line');
  check(/\.update\(\{ can_post: next \}\)/.test(share) && /CAN_POST_LABEL/.test(share) && /SHARE_CAN_POST_NOTE/.test(share),
    'the Share dialog has the per-person switch and its line');
  check(!/can_post:\s*(true|false)/.test(share.replace(/\.update\(\{ can_post: next \}\)/, '')),
    'the Share dialog never sends can_post on insert: new shares take the database default (off)');
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
