// Migration 091 — matter conversations: named, private-or-shared, searchable —
// EXECUTED in PGlite with the real migration chain and real RLS, and then the
// REAL lib/mcp-core.mjs search and grep handlers driven against that same
// database as each person, the way the hosted connector, the in-app assistant
// and the agents reach it.
//
// The fixture is the Bushell case the feature was built for:
//   Eden    owns the firm's serverspace
//   James   the client, a VIEWER on the Bushell matter
//   Yfat    co-counsel, a MEMBER on Bushell, no JDA yet
//   Sam     co-counsel shared ONLY on a Bushell sub-matter
//   Stella  another firm: a stranger to all of it
//
// What it proves (every assertion is made from SET ROLE authenticated with
// request.jwt.claims set the way PostgREST sets it, unless it says otherwise)
//   SQL      091 applies on 001…022 + 017 + 021 + 062 + 042's view, and again
//            over itself, converging. Pre-091 comments land in one "General"
//            per matter. No policy calls a SECURITY DEFINER function; every
//            wrapper is INVOKER; the helpers agree with can_access_matter /
//            can_manage_matter for every person and matter. The two one-line
//            settings agree with src/lib/conversations.ts.
//   PRIVATE  Yfat, on the matter but not in the private conversation, cannot
//            select, list, count, search, grep, see in the activity feed,
//            post into, join, or move a message into it — not its messages,
//            not its title. James, in it, can.
//   SHARED   an "Everyone on this matter" conversation is read by every
//            matter member; Sam (sub-matter only) sees none of the parent's
//            conversations; Stella and anon see nothing at all.
//   AI       *_for_ai never returns a message whose conversation has AI off —
//            even to a member — nor one in a sealed or paused matter (or
//            beneath one), even with no exclusion list passed.
//   LATER    someone added later reads the earlier messages (the default),
//            and only newer ones when the setting is flipped.
//   GUARDS   audience fixed at creation; a message cannot be moved; archived
//            is read-only; General cannot be archived; a message cannot name
//            one matter and another matter's conversation.
//   CONTROL  with 017's policy put back, the private message LEAKS to Yfat —
//            proof the checks above can see a leak — and the search function
//            still refuses it (it re-checks the audience itself). Re-pasting
//            091 closes it again.
//   MCP      the real handleSearch / handleGrep, with fetch witnessed (zero
//            calls), never return a private non-AI message to any caller.
//   SOURCE   lib/ + api/ + worker/ never read the conversation tables
//            directly and never call the person's search function; the task
//            board's attachment kinds do not include messages.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-matter-conversations.mjs
//
// No .env, no network, no production.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const M091 = '091_matter_conversations.sql';

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
const asAnon = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'anon' })]);
  await db.exec('set role anon');
};
const asSuperuser = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
};
/** Run fn as a user and always come back as the superuser. */
const as = async (uid, fn) => {
  if (uid === 'anon') await asAnon(); else await asUser(uid);
  try { return await fn(); } finally { await asSuperuser(); }
};

// ===========================================================================
section('the chain: 001…022, 017, 021, 062, 042\'s activity_feed');
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
  -- The tables 042's view reads that this harness does not otherwise need,
  -- reduced to the columns the view names.
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
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  create publication supabase_realtime;
`);
for (const f of [
  '001_initial_schema.sql', '005_fix_rls_recursion.sql', '008_submatters.sql',
  '016_matterspace_members.sql', '022_matterspaces_rls_invoker_wrappers.sql',
  '017_matter_comments.sql', '021_matter_comment_attachments.sql',
]) await db.exec(migration(f));
// 051's tier and 070's pause, reduced to the two columns 091 reads.
await db.exec(`
  alter table public.matterspaces add column if not exists ai_tier text not null default 'A';
  alter table public.matterspaces add column if not exists ai_paused boolean not null default false;
  alter table public.matterspaces add column if not exists short_code text;
`);
await db.exec(migration('062_profiles_rls_plan.sql'));
// 042 section 0 — the LIVE activity_feed definition — executed from the file.
{
  const src = migration('042_matter_state_ledger.sql');
  const start = src.indexOf('drop view if exists public.activity_feed;');
  const end = src.indexOf('grant select on public.activity_feed to authenticated, service_role;');
  await db.exec(src.slice(start, end));
}
// 012's descendants function (the MCP handlers call it).
await db.exec(`
  create or replace function public.matterspace_descendants(p_root uuid)
  returns table (id uuid) language sql stable as $$
    with recursive tree as (
      select m.id from public.matterspaces m where m.id = p_root
      union all
      select c.id from public.matterspaces c join tree t on c.parent_matterspace_id = t.id
    ) select id from tree $$;
`);
await db.exec(`grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema public to anon, authenticated, service_role;`);
check(true, 'the chain 091 sits on is applied');

// ---------------------------------------------------------------------------
// The people and the matters
// ---------------------------------------------------------------------------
const signup = async (email, name) => (await q(`insert into auth.users (email, raw_user_meta_data)
  values ($1, jsonb_build_object('display_name', $2::text)) returning id`, [email, name]))[0].id;
const EDEN = await signup('eden@firm.test', 'Eden Quainton');
const JAMES = await signup('james@client.test', 'James Bushell');
const YFAT = await signup('yfat@cocounsel.test', 'Yfat');
const SAM = await signup('sam@subcounsel.test', 'Sam');
const STELLA = await signup('stella@elsewhere.test', 'Stella');
const WHO = { [EDEN]: 'Eden', [JAMES]: 'James', [YFAT]: 'Yfat', [SAM]: 'Sam', [STELLA]: 'Stella' };

const [firm] = await q(`insert into public.serverspaces (clientspace_id, name)
  select id, 'Quainton Law' from public.clientspaces where user_id = $1 returning id`, [EDEN]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner')
  on conflict do nothing`, [firm.id, EDEN]);
const [elsewhere] = await q(`insert into public.serverspaces (clientspace_id, name)
  select id, 'Elsewhere LLP' from public.clientspaces where user_id = $1 returning id`, [STELLA]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner')
  on conflict do nothing`, [elsewhere.id, STELLA]);

const matter = async (name, parent = null, extra = {}) => (await q(
  `insert into public.matterspaces (serverspace_id, name, parent_matterspace_id, ai_tier, ai_paused)
   values ($1,$2,$3,$4,$5) returning id`,
  [firm.id, name, parent, extra.tier ?? 'A', extra.paused ?? false]))[0].id;
const BUSHELL = await matter('Bushell v. Radiant Solar');
const BSUB = await matter('Bushell — OATH hearing', BUSHELL);
const BPAUSED = await matter('Bushell — paused folder', BUSHELL, { paused: true });
const OTHER = await matter('Another matter');
const SEALED = await matter('Sealed matter', null, { tier: 'B' });
const STELLA_M = (await q(`insert into public.matterspaces (serverspace_id, name) values ($1,'Stella''s matter') returning id`,
  [elsewhere.id]))[0].id;
const MATTERS = { BUSHELL, BSUB, BPAUSED, OTHER, SEALED, STELLA_M };

const member = (m, u, role) => q(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,$3)`, [m, u, role]);
await member(BUSHELL, JAMES, 'viewer');
await member(BUSHELL, YFAT, 'member');
await member(BSUB, SAM, 'member');
await member(SEALED, YFAT, 'member');

// The one thread as it is today, before 091: two messages on Bushell (one
// since deleted), one on the sub-matter, one on another matter.
const comment = async (m, u, body, extra = {}) => (await q(
  `insert into public.matter_comments (matterspace_id, user_id, body, created_at, deleted_at)
   values ($1,$2,$3, coalesce($4::timestamptz, now()), $5) returning id`,
  [m, u, body, extra.at ?? null, extra.deleted ?? null]))[0].id;
const PRE1 = await comment(BUSHELL, EDEN, 'Kickoff: the retainer is signed.', { at: '2026-09-01T14:00:00Z' });
const PRE2 = await comment(BUSHELL, YFAT, 'Draft complaint circulated.', { at: '2026-09-02T14:00:00Z' });
const PRE3 = await comment(BUSHELL, EDEN, 'withdrawn remark', { at: '2026-09-02T15:00:00Z', deleted: '2026-09-02T16:00:00Z' });
const PRE4 = await comment(BSUB, SAM, 'OATH hearing moved to Tuesday.', { at: '2026-09-03T14:00:00Z' });
const PRE5 = await comment(OTHER, EDEN, 'Nothing to do with Bushell.', { at: '2026-09-04T14:00:00Z' });

// ===========================================================================
section('091, applied twice');
// ===========================================================================
const shape = async () => JSON.stringify({
  policies: await q(`select tablename, policyname, cmd, qual, with_check from pg_policies
    where tablename in ('matter_comments','matter_conversations','matter_conversation_members','matter_conversation_reads')
    order by 1,2`),
  constraints: await q(`select conname, pg_get_constraintdef(oid) d from pg_constraint
    where conrelid in ('public.matter_comments'::regclass) order by 1`),
  convs: await q(`select matterspace_id, title, audience, ai_readable, is_general from public.matter_conversations order by 1,2`),
  comments: await q(`select id, conversation_id from public.matter_comments order by 1`),
});
{
  const r1 = await execAttempt(migration(M091));
  check(!r1.err, '091 applies', r1.err?.message ?? '');
  if (r1.err) { console.error(r1.err); process.exit(1); }
  const s1 = await shape();
  const r2 = await execAttempt(migration(M091));
  const s2 = await shape();
  check(!r2.err, '091 applies again over itself', r2.err?.message ?? '');
  check(s1 === s2, 'the second paste converges: same policies, constraints, conversations and filing');
}

// ===========================================================================
section('backfill: the one thread becomes "General"');
// ===========================================================================
const generalOf = async (m) => (await q(`select id from public.matter_conversations where matterspace_id=$1 and is_general`, [m]))[0]?.id ?? null;
const GEN_B = await generalOf(BUSHELL);
const GEN_SUB = await generalOf(BSUB);
const GEN_OTHER = await generalOf(OTHER);
{
  const gens = await q(`select matterspace_id, title, audience, ai_readable, created_by from public.matter_conversations where is_general`);
  check(gens.length === 3 && GEN_B && GEN_SUB && GEN_OTHER,
    'one General for each matter that had comments (Bushell, the sub-matter, the other matter) and none for the rest',
    `${gens.length} made`);
  check(gens.every((g) => g.title === 'General' && g.audience === 'matter' && g.ai_readable === true && g.created_by === null),
    'each General is titled "General", for everyone on the matter, open to AI (as the thread always was)');
  const filed = await q(`select id, conversation_id, matterspace_id from public.matter_comments`);
  const want = { [PRE1]: GEN_B, [PRE2]: GEN_B, [PRE3]: GEN_B, [PRE4]: GEN_SUB, [PRE5]: GEN_OTHER };
  check(filed.length === 5 && filed.every((c) => want[c.id] === c.conversation_id),
    'every existing comment (the deleted one too) is in its own matter\'s General');
  const [nullable] = await q(`select is_nullable from information_schema.columns
    where table_schema='public' and table_name='matter_comments' and column_name='conversation_id'`);
  check(nullable.is_nullable === 'YES', 'conversation_id stays nullable (Moot Bench and the deployed app insert without it)');
  const [times] = await q(`select last_message_at from public.matter_conversations where id=$1`, [GEN_B]);
  check(new Date(times.last_message_at).toISOString() === '2026-09-02T14:00:00.000Z',
    'General\'s last activity is its newest live message (the deleted one does not count)');
}

// ===========================================================================
section('RLS shape: wrappers INVOKER, no DEFINER in any policy');
// ===========================================================================
{
  const pols = await q(`select tablename, policyname, coalesce(qual,'') || ' ' || coalesce(with_check,'') expr from pg_policies
    where tablename in ('matter_comments','matter_conversations','matter_conversation_members','matter_conversation_reads')`);
  check(pols.length === 11, 'eleven policies across the four tables', `${pols.length}`);
  const calls = new Set();
  for (const p of pols) for (const m of p.expr.matchAll(/([a-z_]+\.)?([a-z_]+)\(/g)) calls.add(m[2]);
  calls.delete('uid');
  const fns = await q(`select p.proname, p.prosecdef, n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.proname = any($1)`, [[...calls]]);
  check(fns.length > 0 && fns.every((f) => f.prosecdef === false && f.nspname === 'public'),
    'every function a policy calls is a public SECURITY INVOKER wrapper', [...calls].sort().join(', '));
  check(!pols.some((p) => /can_access_matter|can_manage_matter|conversations_internal/.test(p.expr)),
    'no policy names can_access_matter, can_manage_matter or a conversations_internal helper directly');
  const legacy = await q(`select policyname from pg_policies where tablename='matter_comments'
    and policyname in ('Members can read matter comments','Members can post matter comments')`);
  check(legacy.length === 0, '017\'s everyone-reads-everything policies are gone');
}

// ===========================================================================
section('the helpers agree with can_access_matter / can_manage_matter');
// ===========================================================================
{
  let agree = 0; const disagree = [];
  for (const uid of [EDEN, JAMES, YFAT, SAM, STELLA]) {
    for (const [mName, m] of Object.entries(MATTERS)) {
      const [a] = await as(uid, () => q(`select coalesce(public.can_access_matter($1), false) a, coalesce(public.can_manage_matter($1), false) b`, [m]));
      const [b] = await q(`select conversations_internal.user_can_open_matter($1,$2) a,
        conversations_internal.user_can_manage_matter($1,$2) b`, [uid, m]);
      if (a.a === b.a && a.b === b.b) agree += 1; else disagree.push(`${WHO[uid]}/${mName}`);
    }
  }
  check(disagree.length === 0, `open/manage agree for all ${agree} person × matter pairs`, disagree.join(', '));
}

// ===========================================================================
section('the two one-line settings agree with src/lib/conversations.ts');
// ===========================================================================
{
  const ts = fs.readFileSync(path.resolve(ROOT, 'src', 'lib', 'conversations.ts'), 'utf8');
  const startedBy = ts.match(/PRIVATE_CONVERSATIONS_STARTED_BY[^=]*=\s*'([a-z_]+)'/)?.[1];
  const history = ts.match(/NEW_MEMBERS_SEE_HISTORY\s*=\s*(true|false)/)?.[1];
  const [sql] = await q(`select conversations_internal.setting_private_started_by() s, conversations_internal.setting_new_members_see_history() h`);
  check(startedBy === sql.s, `who may start a private conversation: '${sql.s}' in both`, `ts=${startedBy}`);
  check(String(sql.h) === history, `people added later see earlier messages: ${sql.h} in both`, `ts=${history}`);
}

// ===========================================================================
section('Eden starts the conversations');
// ===========================================================================
const create = (uid, m, title, audience, ai, members = []) => as(uid, () => attempt(
  `select public.create_matter_conversation($1,$2,$3,$4,$5::uuid[]) id`, [m, title, audience, ai, members]));
const post = (uid, m, conv, body, extra = {}) => as(uid, () => attempt(
  `insert into public.matter_comments (matterspace_id, user_id, conversation_id, body, kind, email_from, email_subject, email_date)
   values ($1,$2,$3,$4, coalesce($5,'message'), $6, $7, $8::timestamptz)`,
  [m, uid, conv, body, extra.kind ?? null, extra.from ?? null, extra.subject ?? null, extra.date ?? null]));

const PRIV = (await create(EDEN, BUSHELL, 'Strategy — Eden and James', 'members', false, [JAMES])).rows?.[0]?.id;
const PRIV_AI = (await create(EDEN, BUSHELL, 'Drafting with AI', 'members', true, [JAMES])).rows?.[0]?.id;
const SHARED = (await create(EDEN, BUSHELL, 'Case team', 'matter', true)).rows?.[0]?.id;
const QUIET = (await create(EDEN, BUSHELL, 'Case team, no AI', 'matter', false)).rows?.[0]?.id;
const SEALED_C = (await create(EDEN, SEALED, 'Sealed chatter', 'matter', true)).rows?.[0]?.id;
const PAUSED_C = (await create(EDEN, BPAUSED, 'Paused chatter', 'matter', true)).rows?.[0]?.id;
check(PRIV && PRIV_AI && SHARED && QUIET && SEALED_C && PAUSED_C,
  'create_matter_conversation (INSERT … RETURNING, as Eden) makes all six');

const posts = [
  await post(EDEN, BUSHELL, PRIV, 'Settlement floor is zebracode 250k. Not for co-counsel.'),
  await post(JAMES, BUSHELL, PRIV, 'Agreed on the zebracode floor.'),
  await post(EDEN, BUSHELL, PRIV_AI, 'Outline the mangocode argument.'),
  await post(EDEN, BUSHELL, SHARED, 'Team: sharedcode deadlines are on the calendar.'),
  await post(YFAT, BUSHELL, QUIET, 'Nothing for the machines: quietcode.'),
  await post(EDEN, SEALED, SEALED_C, 'Inside the seal: sealedcode.'),
  await post(EDEN, BPAUSED, PAUSED_C, 'Under a pause: pausedcode.'),
  await post(EDEN, BUSHELL, PRIV, 'Forwarded: zebracode email', {
    kind: 'email', from: 'Opposing Counsel <oc@radiant.test>', subject: 'Re: zebracode offer',
    date: '2026-09-24T19:12:00Z' }),
];
check(posts.every((p) => !p.err), 'the people in each conversation can post in it (a pasted email too)',
  posts.map((p) => p.err?.message).filter(Boolean).join(' | '));
{
  const [m] = await q(`select audience from public.matter_conversation_members cm
    join public.matter_conversations c on c.id = cm.conversation_id where cm.conversation_id=$1 and cm.user_id=$2`, [PRIV, EDEN]);
  check(!!m, 'whoever starts a private conversation is in its member list');
}

const bodies = (rows) => rows.map((r) => r.body).join(' | ');
const has = (rows, word) => rows.some((r) => JSON.stringify(r).includes(word));

// ===========================================================================
section('Yfat: on the matter, NOT in the private conversation');
// ===========================================================================
{
  const direct = await as(YFAT, () => q(`select body from public.matter_comments`));
  check(!has(direct, 'zebracode') && !has(direct, 'mangocode'), 'select * from matter_comments: no private message', bodies(direct));
  check(has(direct, 'sharedcode') && has(direct, 'quietcode') && has(direct, 'retainer'),
    '…while the shared conversations and General are all there');
  const byId = await as(YFAT, () => q(`select id from public.matter_comments where conversation_id = $1`, [PRIV]));
  check(byId.length === 0, 'asking for the private conversation by its id returns nothing');
  const convs = await as(YFAT, () => q(`select title from public.matter_conversations`));
  check(!convs.some((c) => /Strategy|Drafting/.test(c.title)), 'its title does not appear in matter_conversations',
    convs.map((c) => c.title).join(', '));
  const list = await as(YFAT, () => q(`select title, unread_count from public.list_matter_conversations($1)`, [BUSHELL]));
  check(list.length === 3 && !list.some((c) => /Strategy|Drafting/.test(c.title)),
    'list_matter_conversations shows General, Case team, Case team no AI — nothing else', list.map((c) => c.title).join(', '));
  const mem = await as(YFAT, () => q(`select * from public.matter_conversation_members`));
  check(mem.length === 0, 'the member lists of private conversations are invisible to her');
  const s = await as(YFAT, () => q(`select body from public.search_conversations(null, 'zebracode')`));
  const s2 = await as(YFAT, () => q(`select body from public.search_conversations_for_ai(array[$1]::uuid[], 'zebracode')`, [BUSHELL]));
  const g = await as(YFAT, () => q(`select body from public.grep_conversations_for_ai(array[$1]::uuid[], 'zebra')`, [BUSHELL]));
  check(s.length === 0 && s2.length === 0 && g.length === 0, 'search, AI search and AI grep: nothing from it');
  const feed = await as(YFAT, () => q(`select title from public.activity_feed where event_type='comment_posted'`));
  check(!has(feed, 'zebracode') && !has(feed, 'private conversation') && !has(feed, 'mangocode'),
    'the activity feed carries no row for it at all', feed.map((f) => f.title).join(' | '));
  const count = await as(YFAT, () => q(`select count(*)::int n from public.activity_feed where event_type='comment_posted' and matter_id=$1`, [BUSHELL]));
  check(count[0].n === 4, 'her feed counts exactly the four Bushell messages she can read', `${count[0].n}`);

  const intrude = await post(YFAT, BUSHELL, PRIV, 'Can I see this?');
  check(!!intrude.err, 'she cannot post into it', intrude.err?.message ?? 'INSERTED');
  const join = await as(YFAT, () => attempt(`insert into public.matter_conversation_members (conversation_id, user_id, added_by) values ($1,$2,$2)`, [PRIV, YFAT]));
  check(!!join.err, 'she cannot add herself to it', join.err?.message ?? 'INSERTED');
  const readMark = await as(YFAT, () => attempt(`insert into public.matter_conversation_reads (conversation_id, user_id) values ($1,$2)`, [PRIV, YFAT]));
  check(!!readMark.err, 'she cannot even write a read marker against it');
  const [mine] = await q(`select id from public.matter_comments where user_id=$1 and conversation_id=$2`, [YFAT, QUIET]);
  const move = await as(YFAT, () => attempt(`update public.matter_comments set conversation_id=$1 where id=$2`, [PRIV, mine.id]));
  check(!!move.err, 'she cannot move her own message into it', move.err?.message ?? 'MOVED');
  const edit = await as(YFAT, () => q(`update public.matter_comments set body='Nothing for the machines: quietcode (edited).' where id=$1 returning id`, [mine.id]));
  check(edit.length === 1, '…but she can still edit her own words where they are');
}

// ===========================================================================
section('James: the client, a viewer, IN the private conversation');
// ===========================================================================
{
  const direct = await as(JAMES, () => q(`select body from public.matter_comments where conversation_id=$1 order by created_at`, [PRIV]));
  check(direct.length === 3 && has(direct, 'zebracode'), 'he reads all three messages in it (the pasted email too)');
  const list = await as(JAMES, () => q(`select title, unread_count, member_ids from public.list_matter_conversations($1)`, [BUSHELL]));
  const priv = list.find((c) => c.title.startsWith('Strategy'));
  check(list.length === 5 && priv && priv.unread_count === 2, 'his list has all five, and two unread in Strategy (Eden\'s)',
    list.map((c) => `${c.title}:${c.unread_count}`).join(', '));
  check(priv.member_ids.includes(EDEN) && priv.member_ids.includes(JAMES) && priv.member_ids.length === 2,
    'its member list reads Eden and James');
  await as(JAMES, () => q(`insert into public.matter_conversation_reads (conversation_id, user_id, last_read_at) values ($1,$2, now() + interval '1 second')`, [PRIV, JAMES]));
  const after = await as(JAMES, () => q(`select unread_count from public.list_matter_conversations($1) where id=$2`, [BUSHELL, PRIV]));
  check(after[0].unread_count === 0, 'marking it read clears the count');
  const s = await as(JAMES, () => q(`select body, conversation_title from public.search_conversations(array[$1]::uuid[], 'zebracode')`, [BUSHELL]));
  check(s.length === 3, 'his own search (search_conversations) finds it', `${s.length}`);
  const ai = await as(JAMES, () => q(`select body from public.search_conversations_for_ai(array[$1]::uuid[], 'zebracode')`, [BUSHELL]));
  const aiGrep = await as(JAMES, () => q(`select body from public.grep_conversations_for_ai(array[$1]::uuid[], 'zebracode')`, [BUSHELL]));
  check(ai.length === 0 && aiGrep.length === 0, 'the AI door returns NOTHING from it: AI is off, member or not');
  const aiOn = await as(JAMES, () => q(`select body from public.search_conversations_for_ai(array[$1]::uuid[], 'mangocode')`, [BUSHELL]));
  check(aiOn.length === 1, 'the private conversation with AI switched on is readable through the AI door, for him');
  const feed = await as(JAMES, () => q(`select title from public.activity_feed where event_type='comment_posted' and matter_id=$1`, [BUSHELL]));
  check(feed.some((f) => f.title === 'Message in a private conversation') && !has(feed, 'zebracode') && !has(feed, 'mangocode'),
    'his feed says "Message in a private conversation" — never its words');
  check(feed.some((f) => f.title === 'Message in Case team, no AI') && !has(feed, 'quietcode'),
    'a shared conversation closed to AI shows its title in the feed, not its words');
  check(feed.some((f) => /sharedcode/.test(f.title)), 'a shared conversation open to AI shows its words, as today');
}

// ===========================================================================
section('Sam: co-counsel shared ONLY on the sub-matter');
// ===========================================================================
{
  const direct = await as(SAM, () => q(`select body, matterspace_id from public.matter_comments`));
  check(direct.length === 1 && direct[0].matterspace_id === BSUB, 'he reads the sub-matter\'s General and nothing of the parent',
    bodies(direct));
  const list = await as(SAM, () => q(`select * from public.list_matter_conversations($1)`, [BUSHELL]));
  check(list.length === 0, 'the parent matter\'s conversation list is empty for him');
  const s = await as(SAM, () => q(`select body from public.search_conversations(null, 'sharedcode or retainer')`));
  check(s.length === 0, 'search finds none of the parent\'s shared messages');
  const ctl = await as(EDEN, () => q(`select body from public.search_conversations(null, 'sharedcode or retainer')`));
  check(ctl.length === 2, '…where the same query as Eden finds both (the query itself is not empty)', `${ctl.length}`);
  const gen = await as(SAM, () => q(`select public.ensure_general_conversation($1) id`, [BUSHELL]));
  check(gen[0].id === null, 'he cannot conjure the parent\'s General');
  const add = await as(EDEN, () => attempt(`insert into public.matter_conversation_members (conversation_id, user_id, added_by) values ($1,$2,$3)`, [PRIV, SAM, EDEN]));
  check(!!add.err && /Only people who can open this matter/.test(add.err.message),
    'Eden cannot add him to a Bushell conversation: he cannot open Bushell', add.err?.message ?? 'ADDED');
  const viaRpc = await create(EDEN, BUSHELL, 'Tries to include Sam', 'members', false, [JAMES, SAM]);
  check(!!viaRpc.err, 'nor through create_matter_conversation — and nothing is left behind',
    viaRpc.err?.message ?? 'CREATED');
  const left = await q(`select count(*)::int n from public.matter_conversations where title='Tries to include Sam'`);
  check(left[0].n === 0, 'the refused conversation was not created at all');
}

// ===========================================================================
section('Stella (another firm) and anon');
// ===========================================================================
{
  const direct = await as(STELLA, () => q(`select * from public.matter_comments`));
  const convs = await as(STELLA, () => q(`select * from public.matter_conversations`));
  const feed = await as(STELLA, () => q(`select * from public.activity_feed where event_type='comment_posted'`));
  const s = await as(STELLA, () => q(`select * from public.search_conversations(null, 'zebracode or sharedcode or retainer or quietcode')`));
  check(direct.length === 0 && convs.length === 0 && feed.length === 0 && s.length === 0,
    'Stella: no message, no conversation, no feed row, no search hit');
  const ctl = await as(EDEN, () => q(`select * from public.search_conversations(null, 'zebracode or sharedcode or retainer or quietcode')`));
  check(ctl.length >= 5, '…where the same search as Eden finds every one of them', `${ctl.length}`);
  const start = await create(STELLA, BUSHELL, 'Snooping', 'matter', false);
  check(!!start.err, 'she cannot start a conversation in Bushell', start.err?.message ?? 'CREATED');
  const px = await as(STELLA, () => q(`select * from public.matter_conversation_people($1)`, [BUSHELL]));
  check(px.length === 0, 'nor list who is on it');
  const anon = await as('anon', () => attempt(`select * from public.matter_comments`));
  check(anon.err || anon.rows.length === 0, 'anon: nothing');
}

// ===========================================================================
section('AI: sealed and paused matters, whatever the switch says');
// ===========================================================================
{
  const human = await as(EDEN, () => q(`select body from public.search_conversations(null, 'sealedcode or pausedcode')`));
  check(human.length === 2, 'Eden\'s own search finds the sealed and the paused messages (they are hers)');
  const ai = await as(EDEN, () => q(`select body from public.search_conversations_for_ai(array[$1,$2,$3]::uuid[], 'sealedcode or pausedcode')`,
    [SEALED, BPAUSED, BUSHELL]));
  const g = await as(EDEN, () => q(`select body from public.grep_conversations_for_ai(array[$1,$2]::uuid[], 'code')`, [SEALED, BPAUSED]));
  check(ai.length === 0 && g.length === 0,
    'the AI door refuses both, although each conversation has AI on and no exclusion list was passed');
  const yfatSealed = await as(YFAT, () => q(`select body from public.search_conversations_for_ai(array[$1]::uuid[], 'sealedcode')`, [SEALED]));
  check(yfatSealed.length === 0, 'the same for Yfat, a member of the sealed matter');
}

// ===========================================================================
section('added later: the earlier messages (the default), and the setting');
// ===========================================================================
{
  const before = await as(YFAT, () => q(`select body from public.matter_comments where conversation_id=$1`, [PRIV_AI]));
  check(before.length === 0, 'before she is added, Yfat reads nothing of "Drafting with AI"');
  const add = await as(JAMES, () => attempt(`insert into public.matter_conversation_members (conversation_id, user_id, added_by) values ($1,$2,$3)`, [PRIV_AI, YFAT, JAMES]));
  check(!add.err, 'James (in it) can add Yfat (who can open the matter)', add.err?.message ?? '');
  const after = await as(YFAT, () => q(`select body from public.matter_comments where conversation_id=$1`, [PRIV_AI]));
  check(after.length === 1 && has(after, 'mangocode'), 'once added she reads the message posted before she arrived');
  await q(`update public.matter_conversation_members set added_at = now() + interval '1 minute' where conversation_id=$1 and user_id=$2`, [PRIV_AI, YFAT]);
  await post(EDEN, BUSHELL, PRIV_AI, 'Later note mangocode-two.');
  await q(`update public.matter_comments set created_at = now() + interval '2 minutes' where body='Later note mangocode-two.'`);
  await db.exec(`create or replace function conversations_internal.setting_new_members_see_history()
    returns boolean language sql immutable as $$ select false $$;`);
  const flipped = await as(YFAT, () => q(`select body from public.matter_comments where conversation_id=$1`, [PRIV_AI]));
  check(flipped.length === 1 && has(flipped, 'mangocode-two'),
    'with the setting flipped to false she reads only what came after she joined', bodies(flipped));
  await db.exec(`create or replace function conversations_internal.setting_new_members_see_history()
    returns boolean language sql immutable as $$ select true $$;`);
  const restored = await as(YFAT, () => q(`select body from public.matter_comments where conversation_id=$1`, [PRIV_AI]));
  check(restored.length === 2, 'and with it back to true (as shipped) she reads both');
  const leave = await as(YFAT, () => q(`delete from public.matter_conversation_members where conversation_id=$1 and user_id=$2 returning user_id`, [PRIV_AI, YFAT]));
  const gone = await as(YFAT, () => q(`select body from public.matter_comments where conversation_id=$1`, [PRIV_AI]));
  check(leave.length === 1 && gone.length === 0, 'she can leave, and then reads none of it again');
}

// ===========================================================================
section('guards');
// ===========================================================================
{
  const aud = await as(EDEN, () => attempt(`update public.matter_conversations set audience='matter' where id=$1`, [PRIV]));
  check(!!aud.err, 'a private conversation cannot be opened to the matter after the fact', aud.err?.message ?? 'CHANGED');
  const toggle = await as(EDEN, () => q(`update public.matter_conversations set ai_readable=true where id=$1 returning ai_readable`, [QUIET]));
  check(toggle.length === 1 && toggle[0].ai_readable === true, 'Eden (owner) can switch AI on for a shared conversation');
  await as(EDEN, () => q(`update public.matter_conversations set ai_readable=false where id=$1`, [QUIET]));
  const yToggle = await as(YFAT, () => q(`update public.matter_conversations set ai_readable=true where id=$1 returning id`, [SHARED]));
  check(yToggle.length === 0, 'Yfat, neither its starter nor an admin, cannot flip its AI switch');
  const jToggle = await as(JAMES, () => q(`update public.matter_conversations set ai_readable=true where id=$1 returning id`, [PRIV]));
  check(jToggle.length === 0, 'James, in it but not its starter, cannot switch AI on for Strategy');
  const archive = await as(EDEN, () => q(`update public.matter_conversations set archived_at=now() where id=$1 returning id`, [QUIET]));
  const postArchived = await post(YFAT, BUSHELL, QUIET, 'after archive');
  check(archive.length === 1 && !!postArchived.err, 'an archived conversation is read-only');
  const genArchive = await as(EDEN, () => attempt(`update public.matter_conversations set archived_at=now() where id=$1`, [GEN_B]));
  check(!!genArchive.err, 'General cannot be archived');
  const cross = await post(EDEN, OTHER, PRIV, 'wrong matter');
  check(!!cross.err, 'a message cannot name one matter and another matter\'s conversation', cross.err?.message ?? 'INSERTED');
  const general = await as(YFAT, () => q(`insert into public.matter_comments (matterspace_id, user_id, body) values ($1,$2,'Moot Bench style') returning conversation_id`, [BUSHELL, YFAT]));
  check(general[0]?.conversation_id === GEN_B, 'a message with no conversation (Moot Bench, the deployed app) lands in General');
  const startGeneral = await as(YFAT, () => attempt(`insert into public.matter_conversations (matterspace_id, title, audience, is_general, created_by) values ($1,'Fake General','matter',true,$2)`, [BUSHELL, YFAT]));
  check(!!startGeneral.err, 'nobody can insert a second "General" from the app');
  const defaults = await as(YFAT, () => q(`insert into public.matter_conversations (matterspace_id, title, created_by) values ($1,'Bare insert',$2) returning audience, ai_readable`, [BUSHELL, YFAT]));
  check(defaults[0]?.audience === 'members' && defaults[0]?.ai_readable === false,
    'a bare insert fails closed: private, AI off');
  const people = await as(YFAT, () => q(`select display_name, role from public.matter_conversation_people($1)`, [BUSHELL]));
  const names = people.map((p) => p.display_name).sort().join(', ');
  check(names === 'Eden Quainton, James Bushell, Yfat', 'the picker offers exactly the people who can open Bushell', names);
}

// ===========================================================================
section('negative control: put 017\'s policy back and watch it leak');
// ===========================================================================
{
  await db.exec(`drop policy "Conversation audience reads messages" on public.matter_comments;
    create policy "Members can read matter comments" on public.matter_comments for select
      using (public.can_access_matter(matterspace_id));`);
  const leak = await as(YFAT, () => q(`select body from public.matter_comments where body like '%zebracode%'`));
  check(leak.length > 0, 'CONTROL: with 017\'s policy Yfat reads the private message — the checks above can see a leak', `${leak.length} rows`);
  const s = await as(YFAT, () => q(`select body from public.search_conversations(null, 'zebracode')`));
  check(s.length === 0, 'even then, search_conversations refuses it: the function re-checks the audience itself');
  await db.exec(`drop policy "Members can read matter comments" on public.matter_comments;`);
  const r = await execAttempt(migration(M091));
  const closed = await as(YFAT, () => q(`select body from public.matter_comments where body like '%zebracode%'`));
  check(!r.err && closed.length === 0, 're-pasting 091 closes it again');
}

// ===========================================================================
section('MCP: the real handleSearch / handleGrep as each person');
// ===========================================================================
// A client that runs what the handlers ask for against this PGlite database AS
// the person — matterspaces reads and every RPC — and answers the passage and
// document reads with nothing (this harness is about the thread). fetch is
// replaced by a witness; the search must not need the network at all.
let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetchCalls += 1; throw new Error('network is not allowed in this harness'); };
delete process.env.OPENAI_API_KEY;

const RPC_CASTS = {
  p_matterspace_ids: 'uuid[]', p_root: 'uuid', p_query: 'text', p_pattern: 'text',
  p_limit: 'int', p_regex: 'boolean', p_case_sensitive: 'boolean',
};
function bridgeFor(uid) {
  const run = (sql, params) => as(uid, () => attempt(sql, params));
  class Builder {
    constructor(table) { this.table = table; this.filters = []; this.one = null; this.cols = '*'; }
    select(cols) { this.cols = cols || '*'; return this; }
    eq(c, v) { this.filters.push([c, '=', v]); return this; }
    in(c, vs) { this.filters.push([c, 'in', vs]); return this; }
    is() { return this; } not() { return this; } order() { return this; } limit() { return this; }
    range() { return this; } textSearch() { return this; } ilike() { return this; } like() { return this; }
    filter() { return this; } gte() { return this; } lte() { return this; }
    single() { this.one = 'single'; return this; }
    maybeSingle() { this.one = 'maybe'; return this; }
    async exec() {
      if (this.table !== 'matterspaces') return { data: this.one ? null : [], error: null };
      const where = []; const params = [];
      for (const [c, op, v] of this.filters) {
        params.push(v);
        where.push(op === 'in' ? `${c} = any($${params.length})` : `${c} = $${params.length}`);
      }
      const cols = this.cols === '*' ? '*' : this.cols;
      const r = await run(`select ${cols} from public.matterspaces ${where.length ? 'where ' + where.join(' and ') : ''}`, params);
      if (r.err) return { data: null, error: { message: r.err.message } };
      if (this.one === 'single') return r.rows.length === 1 ? { data: r.rows[0], error: null } : { data: null, error: { message: 'not found' } };
      if (this.one === 'maybe') return { data: r.rows[0] ?? null, error: null };
      return { data: r.rows, error: null };
    }
    then(res, rej) { this.exec().then(res, rej); }
  }
  const rpcCalls = [];
  return {
    rpcCalls,
    from: (t) => new Builder(t),
    rpc: async (fn, params = {}) => {
      rpcCalls.push(fn);
      if (fn === 'search_passages') return { data: [], error: null };
      const names = Object.keys(params);
      const args = names.map((n, i) => `${n} => $${i + 1}::${RPC_CASTS[n] ?? 'text'}`).join(', ');
      const r = await run(`select * from public.${fn}(${args})`, names.map((n) => params[n]));
      return r.err ? { data: null, error: { message: r.err.message } } : { data: r.rows, error: null };
    },
  };
}
const mcp = await import(pathToFileURL(path.resolve(ROOT, 'lib', 'mcp-core.mjs')).href);
{
  const everyWord = 'zebracode OR mangocode OR sharedcode OR quietcode OR sealedcode OR pausedcode OR retainer';
  const who = [EDEN, JAMES, YFAT, SAM, STELLA];
  let privateLeaks = 0;
  for (const uid of who) {
    for (const m of [BUSHELL, null]) {
      const sb = bridgeFor(uid);
      let out;
      try { out = await mcp.handleSearch(sb, { q: everyWord, ...(m ? { matter: m } : {}), limit: 20 }, {}); }
      catch (err) { out = { error: err.message }; }
      const blob = JSON.stringify(out.correspondence ?? []);
      if (/zebracode|quietcode|sealedcode|pausedcode/.test(blob)) privateLeaks += 1;
    }
  }
  check(privateLeaks === 0, 'search, as each of the five, matter-scoped and everywhere: no AI-off, sealed or paused message ever comes back');

  const eden = await mcp.handleSearch(bridgeFor(EDEN), { q: 'sharedcode', matter: BUSHELL }, {});
  const hit = eden.correspondence?.[0];
  check(eden.correspondence?.length === 1 && hit.citation.startsWith('Thread › Case team, Eden Quainton, '),
    'a shared, AI-open message comes back under `correspondence`, cited "Thread › Case team, Eden Quainton, <date>"',
    hit?.citation ?? JSON.stringify(eden).slice(0, 200));
  check(eden.result_count === 0 && Array.isArray(eden.results) && eden.results.length === 0,
    'the passage results are untouched (none in this harness), and result_count still counts passages only');
  const jamesPriv = await mcp.handleSearch(bridgeFor(JAMES), { q: 'zebracode', matter: BUSHELL }, {});
  check(!jamesPriv.correspondence, 'James asks for the private, AI-off conversation by its words: nothing', JSON.stringify(jamesPriv.correspondence ?? null));
  const jamesAi = await mcp.handleSearch(bridgeFor(JAMES), { q: 'mangocode', matter: BUSHELL }, {});
  check(jamesAi.correspondence?.length >= 1, 'a private conversation with AI switched on is found through the connector, for James who is in it');
  const yfatAi = await mcp.handleSearch(bridgeFor(YFAT), { q: 'mangocode', matter: BUSHELL }, {});
  check(!yfatAi.correspondence, '…and not for Yfat, who is no longer in it');
  const email = await mcp.handleSearch(bridgeFor(EDEN), { q: 'zebracode offer', matter: BUSHELL }, {});
  check(!email.correspondence, 'a pasted email in a private AI-off conversation is not found either');
  const filtered = await mcp.handleSearch(bridgeFor(EDEN), { q: 'sharedcode', matter: BUSHELL, document_ids: ['00000000-0000-0000-0000-000000000000'] }, {});
  check(!filtered.correspondence, 'a search filtered to documents does not reach the thread');
  const sealedEx = await mcp.handleSearch(bridgeFor(EDEN), { q: 'sealedcode' }, { excludeMatterIds: new Set([SEALED]) });
  const sealedNoEx = await mcp.handleSearch(bridgeFor(EDEN), { q: 'sealedcode' }, {});
  check(!sealedEx.correspondence && !sealedNoEx.correspondence,
    'a sealed matter\'s thread: excluded by the connector\'s seal list AND by the database when no list is passed');

  let grepLeaks = 0;
  for (const uid of who) {
    for (const pattern of ['zebracode', 'quietcode', 'code', 'Settlement floor']) {
      let out;
      try { out = await mcp.handleGrep(bridgeFor(uid), { matter: BUSHELL, pattern }, {}); } catch (err) { out = { error: err.message }; }
      if (/zebracode|quietcode|pausedcode/.test(JSON.stringify(out.correspondence_matches ?? []))) grepLeaks += 1;
    }
  }
  check(grepLeaks === 0, 'grep, as each of the five, four patterns: no AI-off or paused message');
  const g = await mcp.handleGrep(bridgeFor(YFAT), { matter: BUSHELL, pattern: 'sharedcode' }, {});
  const m0 = g.correspondence_matches?.[0];
  check(g.correspondence_matches?.length === 1 && m0.match === 'sharedcode' && /deadlines/.test(m0.after)
    && m0.citation.startsWith('Thread › Case team, '),
  'grep returns the shared message as a match with context and the Thread cite');
  const rx = await mcp.handleGrep(bridgeFor(EDEN), { matter: BUSHELL, pattern: 'z[e]bra', regex: true }, {});
  check(!rx.correspondence_matches, 'a regex grep for the private words: nothing');
  check(fetchCalls === 0, 'zero network calls across every search and grep above', `${fetchCalls}`);
}
globalThis.fetch = realFetch;

// ===========================================================================
section('source: the only ways a machine reaches a thread');
// ===========================================================================
{
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
    return /\.(m?js|ts|tsx)$/.test(e.name) ? [p] : [];
  });
  const serverFiles = ['api', 'lib', 'worker'].flatMap((d) => walk(path.resolve(ROOT, d)))
    .concat(walk(path.resolve(ROOT, 'src', 'lib', 'matter-record')));
  const offenders = [];
  for (const f of serverFiles) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (/from\(\s*['"`](matter_comments|matter_conversations|matter_conversation_members|matter_conversation_reads)['"`]\s*\)/.test(src)) offenders.push(`${rel}: reads a conversation table`);
    if (/['"`]search_conversations['"`]/.test(src)) offenders.push(`${rel}: calls the PERSON's search`);
    if (/conversations_internal/.test(src)) offenders.push(`${rel}: names conversations_internal`);
  }
  check(offenders.length === 0, 'api/, lib/, worker/ and the Record never read the tables and never call the person\'s search',
    offenders.join('; '));
  const core = fs.readFileSync(path.resolve(ROOT, 'lib', 'mcp-core.mjs'), 'utf8');
  const rpcs = [...core.matchAll(/['"`]((?:search|grep)_conversations[a-z_]*)['"`]/g)].map((m) => m[1]);
  check(rpcs.length === 2 && rpcs.every((n) => n.endsWith('_for_ai')),
    'lib/mcp-core.mjs names exactly the two _for_ai functions', rpcs.join(', '));
  const kinds = core.match(/const TASK_ITEM_KINDS\s*=\s*\[([^\]]*)\]/)?.[1]?.replace(/\s/g, '');
  check(kinds === "'document','content_item','calendar_event'",
    'the task board attaches documents, pages and calendar events — never a thread message', kinds ?? 'not found');
  for (const f of ['api/mcp.mjs', 'api/sandbox.mjs', 'lib/assistant-core.mjs']) {
    const src = fs.readFileSync(path.resolve(ROOT, f), 'utf8');
    check(/import\s*\{[^}]*\bcallTool\b[^}]*\}\s*from\s*['"]\.\.?\/(lib\/)?mcp-core\.mjs['"]/.test(src),
      `${f} reaches search/grep only through mcp-core's callTool`);
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
