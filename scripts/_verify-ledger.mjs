// Execute migration 064 against a real Postgres and prove the Record is a
// record: append-only, hash-chained, survives the matter and the account,
// invisible to strangers, and written by nothing but ledger_append().
//
// Why this exists
// ---------------------------------------------------------------------------
// The matter's Record is the artefact a lawyer hands to a court, a client or
// an insurer. "Append-only" cannot be a comment in a migration; it has to be
// something you can demonstrate. There is no local Postgres and no Docker on
// the dev machine, so this runs the REAL migration files inside PGlite
// (Postgres compiled to WebAssembly, in this Node process: real plpgsql, real
// roles, real RLS, real triggers) and asserts the behaviour — including as
// service_role, which has BYPASSRLS and is therefore the role a policy alone
// would never stop.
//
// Three things here are worth more than the rest:
//   * every refusal is tried as the matter's OWNER *and* as service_role
//     *and* as a superuser — the last one is what proves the guard is a
//     trigger rather than a privilege;
//   * 064 runs TWICE, because production drifts from this folder and the
//     file has to be re-runnable;
//   * the blanket `grant all on all tables in schema public` — the paste that
//     gets run whenever permissions look wrong — is re-applied AFTER 064 and
//     the guards still hold.
//
// Part B leaves the database and unit-tests lib/ledger.mjs plus the sealed
// strict mode in lib/assistant-core.mjs against a stubbed, failing ledger.
//
//   npm i --no-save @electric-sql/pglite     # once; not a repo dependency
//   node scripts/_verify-ledger.mjs
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
  try { await db.query(sql, params); return null; } catch (err) { return err; }
};

// PostgREST sets the claims GUC, then the role. `reset role` first, always:
// PGlite is one connection, and a role left set gives a false PASS later.
const asUser = async (uid) => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: uid, role: 'authenticated' }),
  ]);
  await db.exec('set role authenticated');
};
const asService = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  await db.exec('set role service_role');
};
const asSuperuser = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
};

// ===========================================================================
// PART A — the database
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. The bits of Supabase the migrations assume.
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

  create or replace function auth.uid() returns uuid
  language sql stable as $$
    select nullif(
      coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      ), ''
    )::uuid
  $$;

  -- 005 rewrites policies on these three; 064 never touches them.
  create table public.documents (
    id uuid primary key default gen_random_uuid(), matterspace_id uuid, created_by uuid);
  create table public.passages (
    id uuid primary key default gen_random_uuid(), matterspace_id uuid);
  create table storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  create or replace function storage.foldername(p_name text)
  returns text[] language sql immutable as $$ select string_to_array(p_name, '/') $$;

  grant usage on schema public, auth, storage to anon, authenticated, service_role;

  -- Supabase's own default: every new table in public is granted to all three
  -- roles. Without this, 064's revokes would be testing nothing.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`);
console.log('  auth schema, roles (service_role BYPASSRLS) and default privileges in place');

// ---------------------------------------------------------------------------
// 2. The real migration chain, verbatim.
// ---------------------------------------------------------------------------
console.log('\n--- the schema production has -----------------------------------');
await db.exec(migration('001_initial_schema.sql'));
await db.exec(migration('005_fix_rls_recursion.sql'));
await db.exec(migration('008_submatters.sql'));
await db.exec(migration('016_matterspace_members.sql'));
await db.exec(migration('022_matterspaces_rls_invoker_wrappers.sql'));
await db.exec(migration('051_securespace.sql'));

const BLANKET_GRANT = `
  grant select, insert, update, delete on all tables in schema public
    to anon, authenticated, service_role;
`;
await db.exec(BLANKET_GRANT);
console.log('  blanket table grants applied (the Supabase default)');

// ---------------------------------------------------------------------------
// 3. Before 064: the holes the audit found are real.
// ---------------------------------------------------------------------------
console.log('\n--- before 064: the holes are real ------------------------------');
{
  const [cascade] = await q(`
    select count(*)::int as n
      from pg_constraint c
      join pg_class rel on rel.oid = c.conrelid
     where rel.relname = 'ai_sessions' and c.contype = 'f' and c.confdeltype = 'c'`);
  check(cascade.n === 2, 'ai_sessions carries TWO on-delete-cascade foreign keys today',
    `${cascade.n} cascade FKs`);
  const [del] = await q(`
    select count(*)::int as n from pg_policies
     where schemaname = 'public' and tablename in ('ai_sessions','ai_messages') and cmd = 'DELETE'`);
  check(del.n === 2, 'and the owner has a DELETE policy on sessions AND on messages', `${del.n} policies`);
}

// ---------------------------------------------------------------------------
// 4. 064, twice.
// ---------------------------------------------------------------------------
console.log('\n--- migration 064, applied twice --------------------------------');
await db.exec(migration('064_events_ledger.sql'));
await db.exec(migration('064_events_ledger.sql'));
check(true, 'the file applies, and applies again over itself (drift-safe)');

{
  const [cascade] = await q(`
    select count(*)::int as n
      from pg_constraint c join pg_class rel on rel.oid = c.conrelid
     where rel.relname = 'ai_sessions' and c.contype = 'f' and c.confdeltype = 'c'`);
  check(cascade.n === 0, 'no cascade foreign key is left on ai_sessions', `${cascade.n} left`);
  const [setnull] = await q(`
    select count(*)::int as n
      from pg_constraint c join pg_class rel on rel.oid = c.conrelid
     where rel.relname = 'ai_sessions' and c.contype = 'f' and c.confdeltype = 'n'`);
  check(setnull.n === 2, 'both are now ON DELETE SET NULL', `${setnull.n} set-null FKs`);
  const [del] = await q(`
    select count(*)::int as n from pg_policies
     where schemaname = 'public' and tablename in ('ai_sessions','ai_messages') and cmd = 'DELETE'`);
  check(del.n === 0, 'and the owner DELETE policies are gone', `${del.n} left`);
  const [fk] = await q(`
    select count(*)::int as n
      from pg_constraint c join pg_class rel on rel.oid = c.conrelid
     where rel.relname = 'events' and c.contype = 'f'`);
  check(fk.n === 0, 'public.events has NO foreign keys at all (the row outlives every reference)');
}

// ---------------------------------------------------------------------------
// 5. Four accounts, a serverspace, a matter and a sub-matter.
// ---------------------------------------------------------------------------
console.log('\n--- a firm ------------------------------------------------------');
await asSuperuser();
const signup = async (email, name) => {
  const [row] = await q(
    `insert into auth.users (email, raw_user_meta_data)
     values ($1, jsonb_build_object('display_name', $2::text)) returning id`, [email, name]);
  return row.id;
};
const ADA = await signup('ada@example.test', 'Ada');    // owns the serverspace
const CARA = await signup('cara@example.test', 'Cara');  // serverspace member
const DAN = await signup('dan@example.test', 'Dan');    // co-counsel, one matter
const BOB = await signup('bob@example.test', 'Bob');    // a stranger

const [s1] = await q(
  `insert into public.serverspaces (clientspace_id, name)
   select id, 'Quainton Law' from public.clientspaces where user_id = $1 returning id`, [ADA]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner')`, [s1.id, ADA]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'member')`, [s1.id, CARA]);
const [m1] = await q(
  `insert into public.matterspaces (serverspace_id, name) values ($1,'Peloso v. Curtis') returning id`, [s1.id]);
const [m2] = await q(
  `insert into public.matterspaces (serverspace_id, name, parent_matterspace_id)
   values ($1,'Peloso v. Curtis › Appeal',$2) returning id`, [s1.id, m1.id]);
const [mx] = await q(
  `insert into public.matterspaces (serverspace_id, name) values ($1,'Doomed Matter') returning id`, [s1.id]);
await q(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,'member')`, [m1.id, DAN]);
console.log('  Ada owns the serverspace, Cara is in it, Dan is on one matter, Bob is a stranger');

const before = (await q(`select count(*)::int as n from public.events`))[0].n;
check(before > 0, 'the membership grants above already wrote acl.changed events by trigger', `${before} events`);

// ---------------------------------------------------------------------------
// 6. Appending — only through the function, and only on your own matters.
// ---------------------------------------------------------------------------
console.log('\n--- appending ---------------------------------------------------');
await asUser(ADA);
const [app1] = await q(
  `select public.ledger_append(
     p_kind := 'completion.received', p_matter := $1, p_actor_kind := 'user',
     p_actor_ref := $2, p_payload := $3::jsonb) as r`,
  [m1.id, ADA, JSON.stringify({ model: 'kimi-k2.5', provider: 'aws-bedrock', input_tokens: 11 })]);
check(app1.r?.seq >= 1 && typeof app1.r?.hash === 'string' && app1.r.hash.length === 64,
  'ledger_append writes a row and returns {seq, hash}', `seq ${app1.r?.seq}`);

const [row1] = await q(`select * from public.events where id = $1`, [app1.r.id]);
check(row1.matter_name === 'Peloso v. Curtis', 'the matter NAME is snapshotted on the row', row1.matter_name);
check(row1.serverspace_id === s1.id, 'so is the serverspace');
check(row1.actor_user_id === ADA, 'the byline is auth.uid(), not the argument');

// a forged byline: the ref is advisory, auth.uid() is not
const [forged] = await q(
  `select public.ledger_append(p_kind := 'tool.invoked', p_matter := $1,
     p_actor_kind := 'connector', p_actor_ref := 'claude.ai', p_actor_label := 'Claude',
     p_payload := '{"tool":"search","ok":true}'::jsonb) as r`, [m1.id]);
const [forgedRow] = await q(`select * from public.events where id = $1`, [forged.r.id]);
check(forgedRow.actor_user_id === ADA && forgedRow.actor_kind === 'connector',
  'a connector event still carries the signed-in user id — the byline cannot be forged');

// direct INSERT: refused for a signed-in user (no policy) …
const insUser = await attempt(
  `insert into public.events (chain_key, seq, kind, actor_kind, actor_ref, prev_hash, hash)
   values ($1, 999, 'tool.invoked', 'user', 'x', '', 'deadbeef')`, [m1.id]);
check(insUser !== null, 'a signed-in user cannot INSERT into events directly', insUser?.message?.slice(0, 60));

// … and for service_role, which has BYPASSRLS and full grants
await asService();
const insSvc = await attempt(
  `insert into public.events (chain_key, seq, kind, actor_kind, actor_ref, prev_hash, hash)
   values ($1, 999, 'tool.invoked', 'system', 'x', '', 'deadbeef')`, [m1.id]);
check(insSvc !== null, 'NOR can service_role, although it bypasses RLS', insSvc?.message?.slice(0, 70));

// the owner-only writer is not reachable from a signed-in session
await asUser(ADA);
const writeDirect = await attempt(
  `select public._ledger_write('tool.invoked', $1, null, null, 'user', 'x', null, '{}'::jsonb, $2)`,
  [m1.id, BOB]);
check(writeDirect !== null && /permission denied/i.test(writeDirect.message ?? ''),
  '_ledger_write (the only function that takes a uid) is not executable by a signed-in user',
  writeDirect?.message?.slice(0, 60));

// a stranger cannot append to someone else's matter
await asUser(BOB);
const strangerAppend = await attempt(
  `select public.ledger_append(p_kind := 'tool.invoked', p_matter := $1)`, [m1.id]);
check(strangerAppend !== null, 'a stranger cannot append to a matter they are not on',
  strangerAppend?.message?.slice(0, 60));
const strangerChecked = await attempt(
  `select public._ledger_append_checked('tool.invoked', $1, null, null, 'user', 'x', null, '{}'::jsonb)`,
  [m1.id]);
check(strangerChecked !== null,
  'and cannot get round the RLS gate by calling the DEFINER layer directly',
  strangerChecked?.message?.slice(0, 60));

// ---------------------------------------------------------------------------
// 7. Nobody rewrites it. Nobody deletes it.
// ---------------------------------------------------------------------------
console.log('\n--- append-only --------------------------------------------------');
for (const [label, become] of [['the matter owner', () => asUser(ADA)],
                               ['service_role (BYPASSRLS)', asService],
                               ['a SUPERUSER', asSuperuser]]) {
  await become();
  const upd = await attempt(`update public.events set payload = '{"x":1}'::jsonb where id = $1`, [app1.r.id]);
  check(upd !== null, `UPDATE is refused as ${label}`, upd?.message?.slice(0, 60));
  const del = await attempt(`delete from public.events where id = $1`, [app1.r.id]);
  check(del !== null, `DELETE is refused as ${label}`, del?.message?.slice(0, 60));
}
await asSuperuser();
const trunc = await attempt(`truncate public.events`);
check(trunc !== null, 'TRUNCATE is refused even for a superuser', trunc?.message?.slice(0, 60));

// The superuser case is the one that matters: it proves the guard is a
// trigger, not a grant. A grant cannot stop a superuser.
{
  const [t] = await q(`
    select count(*)::int as n from pg_trigger
     where tgrelid = 'public.events'::regclass and not tgisinternal`);
  check(t.n === 4, 'four triggers guard the table (insert, update, delete, truncate)', `${t.n}`);
}

// ---------------------------------------------------------------------------
// 8. Who can read it.
// ---------------------------------------------------------------------------
console.log('\n--- visibility ---------------------------------------------------');
const seen = async (uid) => {
  await asUser(uid);
  const [r] = await q(`select count(*)::int as n from public.events where matterspace_id = $1`, [m1.id]);
  return r.n;
};
const adaSees = await seen(ADA);
check(adaSees >= 2, "the serverspace owner sees the matter's events", `${adaSees}`);
check((await seen(CARA)) === adaSees, 'so does a member of the serverspace above it');
check((await seen(DAN)) === adaSees, 'so does co-counsel added to the matter itself');
check((await seen(BOB)) === 0, 'a stranger sees NOTHING', 'Bob: 0 rows');

// sub-matter inheritance: Dan is on m1, the event is on m2 (its child)
await asUser(ADA);
await q(`select public.ledger_append(p_kind := 'tool.invoked', p_matter := $1,
           p_payload := '{"tool":"search","ok":true}'::jsonb)`, [m2.id]);
await asUser(DAN);
const [subSeen] = await q(`select count(*)::int as n from public.events where matterspace_id = $1`, [m2.id]);
check(subSeen.n === 1, 'and sees events on a SUB-matter of the matter they are on');

// ---------------------------------------------------------------------------
// 9. The chain.
// ---------------------------------------------------------------------------
console.log('\n--- the hash chain -----------------------------------------------');
await asUser(ADA);
// Interleave two chains: seq must stay gapless per chain, not globally.
for (let i = 0; i < 25; i++) {
  await q(`select public.ledger_append(p_kind := 'tool.invoked', p_matter := $1,
             p_payload := $2::jsonb)`, [m1.id, JSON.stringify({ tool: 'search', i, ok: true })]);
  await q(`select public.ledger_append(p_kind := 'tool.invoked', p_matter := $1,
             p_payload := $2::jsonb)`, [m2.id, JSON.stringify({ tool: 'grep', i, ok: true })]);
}
for (const [label, id] of [['the matter', m1.id], ['the sub-matter', m2.id]]) {
  const [g] = await q(`
    select count(*)::int as n, min(seq)::int as lo, max(seq)::int as hi
      from public.events where chain_key = $1`, [id]);
  check(g.lo === 1 && g.hi === g.n, `${label}'s sequence is gapless (1…${g.hi}, ${g.n} rows)`);
}
{
  const [v] = await q(`select * from public.verify_chain($1)`, [m1.id]);
  check(v.ok === true && Number(v.checked) > 25 && v.first_bad_seq === null,
    'verify_chain confirms the whole chain', `checked ${v.checked}`);
}

// Tamper with ONE byte of ONE payload. The only way to do it is as a
// superuser with the guard trigger switched off — which is the point.
await asSuperuser();
const [victim] = await q(
  `select id, seq, payload from public.events where chain_key = $1 and seq = 5`, [m1.id]);
await db.exec(`alter table public.events disable trigger events_no_update`);
await q(`update public.events set payload = jsonb_set(payload, '{tampered}', 'true') where id = $1`, [victim.id]);
await db.exec(`alter table public.events enable trigger events_no_update`);
{
  await asUser(ADA);
  const [v] = await q(`select * from public.verify_chain($1)`, [m1.id]);
  check(v.ok === false && Number(v.first_bad_seq) === Number(victim.seq),
    'one altered payload byte flips verify_chain to first_bad_seq',
    `first_bad_seq ${v.first_bad_seq} (tampered seq ${victim.seq})`);
  const [other] = await q(`select * from public.verify_chain($1)`, [m2.id]);
  check(other.ok === true, 'and the other matter\'s chain is unaffected');
}
// put it back so the rest of the file reads a sound chain
await asSuperuser();
await db.exec(`alter table public.events disable trigger events_no_update`);
await q(`update public.events set payload = $2::jsonb where id = $1`,
  [victim.id, JSON.stringify(victim.payload)]);
await db.exec(`alter table public.events enable trigger events_no_update`);
{
  await asUser(ADA);
  const [v] = await q(`select * from public.verify_chain($1)`, [m1.id]);
  check(v.ok === true, 'restoring the byte restores the chain (the hash is over the payload, nothing else)');
}

// A stranger's verify_chain sees nothing rather than a false verdict.
await asUser(BOB);
{
  const [v] = await q(`select * from public.verify_chain($1)`, [m1.id]);
  check(Number(v.checked) === 0, 'a stranger verifying a chain checks zero rows (RLS, not a lie)');
}

// ---------------------------------------------------------------------------
// 10. Triggers: acl.changed and seal.changed.
// ---------------------------------------------------------------------------
console.log('\n--- acl.changed / seal.changed -----------------------------------');
await asSuperuser();
const aclBefore = (await q(
  `select count(*)::int as n from public.events where kind = 'acl.changed'`))[0].n;
await q(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,'viewer')`, [m2.id, CARA]);
await q(`update public.matterspace_members set role = 'member' where matterspace_id = $1 and user_id = $2`, [m2.id, CARA]);
await q(`delete from public.matterspace_members where matterspace_id = $1 and user_id = $2`, [m2.id, CARA]);
const aclRows = await q(
  `select payload from public.events where kind='acl.changed' and matterspace_id = $1 order by seq`, [m2.id]);
check(aclRows.length === 3, 'insert / update / delete on matterspace_members each write acl.changed',
  `${aclRows.length} events`);
check(aclRows[0].payload.op === 'insert' && aclRows[0].payload.new_role === 'viewer'
   && aclRows[1].payload.old_role === 'viewer' && aclRows[1].payload.new_role === 'member'
   && aclRows[2].payload.op === 'delete' && aclRows[2].payload.new_role === null,
  'and each one records the role it moved from and to');

await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'viewer')`, [s1.id, BOB]);
const [ssAcl] = await q(`
  select * from public.events
   where kind = 'acl.changed' and payload->>'table' = 'serverspace_members'
   order by ts desc limit 1`);
check(ssAcl && ssAcl.matterspace_id === null && ssAcl.serverspace_id === s1.id,
  'a serverspace membership change lands on the nil chain with the serverspace snapshotted');
await asUser(CARA);
const [ssVisible] = await q(`
  select count(*)::int as n from public.events
   where payload->>'table' = 'serverspace_members' and serverspace_id = $1`, [s1.id]);
check(ssVisible.n >= 1, 'and is readable by the serverspace\'s own people');
await asSuperuser();
await q(`delete from public.serverspace_members where serverspace_id = $1 and user_id = $2`, [s1.id, BOB]);
check((await q(`select count(*)::int as n from public.events where kind='acl.changed'`))[0].n
      >= aclBefore + 5, 'every membership move is recorded, not just the additions');

await asUser(ADA);
await q(`update public.matterspaces set ai_tier = 'B' where id = $1`, [m1.id]);
await q(`update public.matterspaces set name = name where id = $1`, [m1.id]);   // must NOT fire
const sealRows = await q(
  `select payload, actor_user_id from public.events where kind = 'seal.changed' and matterspace_id = $1`, [m1.id]);
check(sealRows.length === 1 && sealRows[0].payload.old_tier === 'A' && sealRows[0].payload.new_tier === 'B',
  'sealing a matter writes exactly one seal.changed (A → B)', `${sealRows.length} events`);
check(sealRows[0]?.actor_user_id === ADA, 'attributed to the person who sealed it');

// ---------------------------------------------------------------------------
// 11. The record outlives the matter and the account.
// ---------------------------------------------------------------------------
console.log('\n--- deletions ----------------------------------------------------');
await asUser(ADA);
await q(`select public.ledger_append(p_kind := 'completion.received', p_matter := $1,
           p_payload := '{"model":"kimi-k2.5","tier":"B"}'::jsonb)`, [mx.id]);
const [sess] = await q(
  `insert into public.ai_sessions (matterspace_id, tier, title)
   values ($1,'B','A sealed conversation') returning id, matter_name, owner_email, serverspace_id`, [mx.id]);
check(sess.matter_name === 'Doomed Matter' && sess.owner_email === 'ada@example.test'
  && sess.serverspace_id === s1.id,
  'a new ai_sessions row snapshots the matter name, the owner email and the serverspace');
await q(`insert into public.ai_messages (session_id, seq, role, content)
         values ($1, 0, 'user', '{"text":"hello"}'::jsonb)`, [sess.id]);

await asSuperuser();
await q(`delete from public.matterspaces where id = $1`, [mx.id]);
await asUser(ADA);
{
  const rows = await q(
    `select matter_name, matterspace_id, serverspace_id from public.events where matterspace_id = $1`, [mx.id]);
  check(rows.length === 1 && rows[0].matter_name === 'Doomed Matter',
    'the deleted matter\'s events are still there, still readable, still named');
  const [s] = await q(
    `select matterspace_id, matter_name, owner_email from public.ai_sessions where id = $1`, [sess.id]);
  check(s && s.matterspace_id === null && s.matter_name === 'Doomed Matter',
    'the ai_sessions row survived the matter and kept its name');
  const [msgs] = await q(`select count(*)::int as n from public.ai_messages where session_id = $1`, [sess.id]);
  check(msgs.n === 1, 'and so did its messages');
}
await asUser(CARA);
{
  const [r] = await q(`select count(*)::int as n from public.ai_sessions where id = $1`, [sess.id]);
  check(r.n === 1, 'a colleague in the serverspace can still read it — the record did not become unreadable');
}

// the owner may no longer erase it
await asUser(ADA);
const delSess = await attempt(`delete from public.ai_sessions where id = $1`, [sess.id]);
check(delSess !== null, 'the owner can no longer DELETE an ai_sessions row', delSess?.message?.slice(0, 60));
const delMsg = await attempt(`delete from public.ai_messages where session_id = $1`, [sess.id]);
check(delMsg !== null, 'nor an ai_messages row', delMsg?.message?.slice(0, 60));

// deleting the ACCOUNT
await asUser(DAN);
await q(`select public.ledger_append(p_kind := 'file.exported', p_matter := $1,
           p_payload := '{"destination":"drive","title":"Exhibit A"}'::jsonb)`, [m1.id]);
const [danBefore] = await q(
  `select count(*)::int as n from public.events where actor_user_id = $1`, [DAN]);
check(danBefore.n >= 1, 'co-counsel left events of their own before the account goes', `${danBefore.n} rows`);
await asSuperuser();
await q(`delete from auth.users where id = $1`, [DAN]);
await asUser(ADA);
{
  const [r] = await q(`select count(*)::int as n from public.events where actor_user_id = $1`, [DAN]);
  check(r.n === danBefore.n, 'deleting an account leaves its events exactly where they were',
    `${r.n} rows`);
  const [s] = await q(`select count(*)::int as n from public.ai_sessions where owner_email is not null`);
  check(s.n >= 1, 'and ai_sessions still names who owned the conversation');
}

// ---------------------------------------------------------------------------
// 12. The paste that gets run whenever permissions look wrong.
// ---------------------------------------------------------------------------
console.log('\n--- after a blanket re-grant -------------------------------------');
await asSuperuser();
await db.exec(BLANKET_GRANT);
await asService();
{
  const ins = await attempt(
    `insert into public.events (chain_key, seq, kind, actor_kind, actor_ref, prev_hash, hash)
     values ($1, 9999, 'tool.invoked', 'system', 'x', '', 'deadbeef')`, [m1.id]);
  check(ins !== null, 'service_role still cannot INSERT after `grant all … to service_role`',
    ins?.message?.slice(0, 70));
  const upd = await attempt(`update public.events set kind = 'ai.paused' where id = $1`, [app1.r.id]);
  check(upd !== null, 'still cannot UPDATE');
  const del = await attempt(`delete from public.events where id = $1`, [app1.r.id]);
  check(del !== null, 'still cannot DELETE');
}
await asUser(ADA);
{
  const [v] = await q(`select * from public.verify_chain($1)`, [m1.id]);
  check(v.ok === true, 'and the chain still verifies at the end of all of it', `checked ${v.checked}`);
}

// ---------------------------------------------------------------------------
// 13. The payload cap.
// ---------------------------------------------------------------------------
console.log('\n--- the 8 KB payload cap -----------------------------------------');
await asUser(ADA);
{
  const big = { tool: 'file_document', blob: 'x'.repeat(20000) };
  const [r] = await q(
    `select public.ledger_append(p_kind := 'tool.invoked', p_matter := $1, p_payload := $2::jsonb) as r`,
    [m1.id, JSON.stringify(big)]);
  const [row] = await q(`select payload from public.events where id = $1`, [r.r.id]);
  check(row.payload.truncated === true && !JSON.stringify(row.payload).includes('xxxx'),
    'a payload over 8 KB is replaced by its shape — the database will not store prose');
}

await db.exec('reset role');

// ===========================================================================
// PART B — lib/ledger.mjs and the sealed strict mode
// ===========================================================================
console.log('\n--- lib/ledger.mjs: redaction ------------------------------------');
const {
  redact, redactToolArgs, scrubArgValues, record, recordStrict, LedgerWriteError,
  isNotDeployed, isKindNotAdmitted, uuidList, EVENT_KINDS, KINDS_094, _resetWarnings,
} = await import('../lib/ledger.mjs');

{
  const out = redact({
    tool: 'file_document',
    matter: 'peloso',
    text: 'The witness testified that on the morning of...'.repeat(40),
    api_key: 'sk-live-abcdef',
    nested: { authorization: 'Bearer xyz', document_id: 'd-1' },
    query: 'z'.repeat(500),
    slides: [{ title: 'One' }, { title: 'Two' }],
    document_ids: ['a', 'b'],
  });
  check(out.tool === 'file_document' && out.matter === 'peloso',
    'metadata passes through untouched (tool name, matter)');
  check(typeof out.text === 'object' && out.text.chars > 0 && !JSON.stringify(out).includes('witness'),
    'a content key never survives — only its size', JSON.stringify(out.text));
  check(out.api_key === '[redacted]' && out.nested.authorization === '[redacted]',
    'secrets are redacted, nested ones too');
  check(out.nested.document_id === 'd-1', 'but ordinary ids inside the same object survive');
  check(typeof out.query === 'string' && out.query.length <= 201, 'a search query is hard-truncated');
  check(out.slides && out.slides.items === 2, 'a slide deck is recorded as a count, not as its words');
  check(Array.isArray(out.document_ids) && out.document_ids.length === 2, 'id arrays survive');
}
{
  const long = redact({ mystery: 'q'.repeat(5000) });
  check(typeof long.mystery === 'object' && long.mystery.chars === 5000,
    'and any long string under ANY key is replaced by its size (the default is refusal)');
}

// ---------------------------------------------------------------------------
// A NUMBER IS NEVER REDACTED, UNDER ANY KEY.
//
// SECRET_RE matches the word "token", and every one of the three redactors
// tests it against the KEY. So `input_tokens`, `output_tokens` and
// `max_tokens` — two of them columns of the Record's own published contract —
// were written as the string '[redacted]', and every reconciliation of a turn
// against its cost read a word where a count belonged. `estimated_cost`
// escaped only because its name happens not to match.
//
// Each redactor was fixed by putting the number/boolean branch AHEAD of the
// key test, and each has a comment saying so. The guard for it lived only in
// scripts/_verify-sealed-meetings.mjs, which asserts it of one payload on one
// route; this asserts it of the functions themselves, which is where the rule
// is. A secret-looking key with a STRING value must still be redacted, and
// that is checked in the same breath — the fix must not have opened the hole
// the rule exists to close.
// ---------------------------------------------------------------------------
console.log('\n--- token counts are never redacted ------------------------------');
{
  const { shapeOnly } = await import('../lib/ledger.mjs');

  const usage = {
    input_tokens: 1200,
    output_tokens: 30,
    cache_read_input_tokens: 0,
    max_tokens: 8192,
    estimated_cost_cents: 4,
    token_budget_exhausted: false,
    // The same key shapes, carrying what they are actually named for.
    api_key: 'sk-live-abcdef',
    authorization: 'Bearer xyz',
    session_token: 'st-123',
  };

  for (const [name, fn] of [['redact', redact], ['redactToolArgs', redactToolArgs], ['shapeOnly', shapeOnly]]) {
    const out = fn(usage);
    check(out.input_tokens === 1200 && out.output_tokens === 30,
      `${name}(): the pen's token counts survive as numbers`, JSON.stringify({ in: out.input_tokens, out: out.output_tokens }));
    check(out.cache_read_input_tokens === 0,
      `${name}(): a count of ZERO survives as 0, not as '[redacted]' and not as null`,
      JSON.stringify(out.cache_read_input_tokens));
    check(out.max_tokens === 8192,
      `${name}(): the ceiling a call asked for survives`, JSON.stringify(out.max_tokens));
    check(out.estimated_cost_cents === 4,
      `${name}(): and the cost beside them, so the two can be reconciled`);
    check(out.token_budget_exhausted === false,
      `${name}(): a boolean under a secret-looking key survives too — it cannot carry prose`,
      JSON.stringify(out.token_budget_exhausted));
    check(out.api_key === '[redacted]' && out.authorization === '[redacted]' && out.session_token === '[redacted]',
      `${name}(): but a STRING under a secret-bearing key is still redacted — the hole stays shut`,
      JSON.stringify({ k: out.api_key, a: out.authorization, s: out.session_token }));
    check(!JSON.stringify(out).includes('sk-live-abcdef') && !JSON.stringify(out).includes('Bearer xyz'),
      `${name}(): and no secret's VALUE appears anywhere in the result`);
  }

  // Nested, because a usage block arrives inside a payload rather than as one.
  const nested = redact({ tool: 'search', usage: { input_tokens: 512, output_tokens: 8, api_key: 'sk-1' } });
  check(nested.usage.input_tokens === 512 && nested.usage.output_tokens === 8
    && nested.usage.api_key === '[redacted]',
    'redact(): the rule holds at depth, where a usage block actually lives');

  // The source says why, so the ordering cannot be "tidied" back.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ledger.mjs'), 'utf8');
  /** One function's own text, up to wherever the next one starts. */
  const bodyOf = (fn) => {
    const rest = src.slice(src.indexOf(`export function ${fn}(`) + 1);
    const next = rest.search(/\n(export )?function /);
    return next === -1 ? rest : rest.slice(0, next);
  };
  for (const fn of ['redact', 'redactToolArgs']) {
    const body = bodyOf(fn);
    const numberAt = body.indexOf("typeof v === 'number' || typeof v === 'boolean'");
    const secretAt = body.indexOf('SECRET_RE.test(k)');
    check(numberAt !== -1 && secretAt !== -1 && numberAt < secretAt,
      `${fn}(): the number branch still comes BEFORE the secret-key test`,
      `${numberAt} < ${secretAt}`);
  }
  check(
    /SECRET_RE\.test\(k\) && typeof v !== 'number' && typeof v !== 'boolean'/.test(bodyOf('shapeOnly')),
    'shapeOnly(): its secret-key test still exempts numbers and booleans in the same expression',
  );
}

// ---------------------------------------------------------------------------
// The allow-list on tool arguments, driven through the REAL callTool hook.
//
// The Record's contract is metadata only, and redact() is a deny-list: it
// knows `query` and did not know `q`, which is the name `search` actually
// uses — so a lawyer's search string went verbatim into a row nobody can
// delete. The test below plants a unique sentinel in EVERY string argument of
// EVERY tool, drives the real hook, and greps the serialized payload. None may
// survive: an unknown argument must default to its shape, not to its words.
// ---------------------------------------------------------------------------
console.log('\n--- tool.invoked: the allow-list on a tool\'s arguments ------------');
{
  const { TOOLS, callTool } = await import('../lib/mcp-core.mjs');

  const MATTER = '11111111-1111-4111-8111-111111111111';
  const DOC_A = '22222222-2222-4222-8222-222222222222';
  const DOC_B = '33333333-3333-4333-8333-333333333333';
  const QUERY = 'did he know about the side letter before the closing';

  // Each sentinel is prose — it carries a space, so it can never pass for an
  // id or an enum and the allow-list has no honest reason to keep it. The
  // TOKEN is lowercase alphanumerics, so a handler that slugifies or
  // lower-cases the value before quoting it back still trips the grep.
  let n = 0;
  const sentinels = [];
  const sentinel = () => {
    const token = `zzsentinel${++n}zz`;
    sentinels.push(token);
    return `${token} privileged prose`;
  };

  /** A value for every leaf of a tool's JSON schema; every string a sentinel. */
  const fromSchema = (schema) => {
    if (!schema || typeof schema !== 'object') return sentinel();
    if (Array.isArray(schema.anyOf)) return fromSchema(schema.anyOf[schema.anyOf.length - 1]);
    if (schema.type === 'object') {
      const out = {};
      for (const [k, sub] of Object.entries(schema.properties ?? {})) out[k] = fromSchema(sub);
      return out;
    }
    if (schema.type === 'array') {
      const items = schema.items;
      if (items && Array.isArray(items.anyOf)) return items.anyOf.map(fromSchema);
      return [fromSchema(items), fromSchema(items)];
    }
    if (schema.type === 'number' || schema.type === 'integer') return 7;
    if (schema.type === 'boolean') return true;
    return sentinel();
  };

  // A Supabase shaped like the real one and holding no database: every query
  // resolves to an error, so each handler fails and callTool records the
  // failure path — the path that also carries the error message.
  const captured = [];
  const dead = { data: null, error: { message: 'no database in this harness' }, count: null };
  const chain = () => new Proxy(() => {}, {
    get: (_t, prop) => (prop === 'then' ? (resolve) => resolve(dead) : () => chain()),
    apply: () => chain(),
  });
  const stub = {
    from: () => chain(),
    storage: { from: () => chain() },
    auth: { getUser: async () => ({ data: { user: { id: 'u-1' } }, error: null }) },
    rpc: async (fn, params) => {
      if (fn !== 'ledger_append') return dead;
      captured.push(params);
      return { data: [{ id: 'evt', seq: captured.length, hash: 'h' }], error: null };
    },
  };
  const invoke = async (tool, args, actor) => {
    captured.length = 0;
    _resetWarnings();
    try {
      await callTool(stub, tool, args, { matterId: MATTER, actor });
    } catch { /* there is no database here; the recording happens either way */ }
    return captured.at(-1)?.p_payload ?? null;
  };

  const leaks = [];
  for (const tool of TOOLS) {
    const args = fromSchema(tool.inputSchema);
    args.zz_future_argument = sentinel();   // an argument nobody has invented yet
    const payload = await invoke(tool.name, args,
      { kind: 'connector', ref: 'client-1', label: 'Fixture Desktop' });
    if (!payload) { leaks.push(`${tool.name}: nothing was recorded at all`); continue; }
    const blob = JSON.stringify(payload);
    const hit = sentinels.filter((s) => blob.includes(s));
    if (hit.length) leaks.push(`${tool.name}: ${hit.join(',')}`);
  }
  check(leaks.length === 0 && TOOLS.length === 24,
    `all ${TOOLS.length} tools: ${sentinels.length} planted strings, not one survives into the payload`,
    leaks.join(' | '));

  {
    const p = await invoke('search', {
      matter: 'fixture-matter', q: QUERY, limit: 7, full_text: true,
      doc_types: ['deposition'], witnesses: ['Peloso', 'Ortega'],
      document_ids: [DOC_A, DOC_B],
    }, { kind: 'user', ref: 'u-1' });
    check(p?.args?.matter === 'fixture-matter' && p?.args?.limit === 7 && p?.args?.full_text === true,
      'the matter handle, the limit and the flag survive — the Record still says what was asked for');
    check(Array.isArray(p?.args?.document_ids) && p.args.document_ids.length === 2
      && p.args.document_ids[0] === DOC_A && Array.isArray(p?.document_ids),
      'document ids survive as ids, top-level and in the arguments');
    check(p?.args?.q?.present === true && p.args.q.length === QUERY.length
      && !JSON.stringify(p).includes('side letter'),
      'but the QUERY ITSELF is a length and nothing else — the hole #182 found, closed',
      JSON.stringify(p?.args?.q));
    check(p?.args?.doc_types?.items === 1 && p?.args?.witnesses?.items === 2,
      'a list of witness names is its count, never the names');
  }
  {
    const HEADLINE = 'Horski deposition 7/31 — outline in progress';
    const NOTE = 'client says settle';
    const p = await invoke('set_matter_state', {
      matter: 'fixture-matter', status: 'urgent',
      headline: HEADLINE, next_action: 'serve the subpoena', note: NOTE,
    }, { kind: 'charter', ref: 'charter-1', label: 'Deposition digest' });
    check(p?.args?.status === 'urgent', 'an enum the tool\'s own schema lists survives');
    check(p?.args?.headline?.present === true && p.args.headline.length === HEADLINE.length
      && p?.args?.note?.present === true && p.args.note.length === NOTE.length
      && !JSON.stringify(p).includes('Horski') && !JSON.stringify(p).includes('settle'),
      'while the matter\'s own words are a presence and a length',
      JSON.stringify(p?.args?.headline));
  }

  // The second hole, found by the loop above: several handlers quote the
  // argument back in the message they throw (resolveMatter's "No matterspace
  // with short_code '…'"), and the payload carries that message beside the
  // shaped arguments. Shaping the arguments alone would not have been enough.
  {
    const p = await invoke('list_matter_contents',
      { matter: 'Peloso arbitration — the unsigned side letter' }, { kind: 'user', ref: 'u-1' });
    check(p?.args?.matter?.present === true && !JSON.stringify(p).includes('side letter'),
      'a handler that quotes an argument back into its error does not reopen the hole',
      JSON.stringify(p?.error));
  }

  // The allow-list checks the VALUE, not only the key: a tool is free to put
  // prose in an argument it calls `id`.
  {
    const shaped = redactToolArgs({
      encoding: 'base64', doc_type: 'exhibit', type: 'bar',
      doc_type_unknown: 'transcript', id: 'not a uuid, a sentence',
      matter: 'Peloso v. Curtis — the 2019 arbitration', to_matter: 'sandbox_peloso',
      document_ids: [DOC_A, 'a note about the client'], context_pages: 2, regex: false,
      api_key: 'sk-live-abcdef',
    });
    check(shaped.encoding === 'base64' && shaped.doc_type === 'exhibit' && shaped.type === 'bar',
      'enum values pass; an unlisted one would not');
    check(shaped.id?.present === true && shaped.matter?.present === true,
      'an id-shaped KEY holding something that is not an id does not survive');
    check(shaped.to_matter === 'sandbox_peloso' && shaped.context_pages === 2 && shaped.regex === false,
      'a real handle, a number and a boolean do');
    check(shaped.document_ids?.items === 2 && !JSON.stringify(shaped).includes('client'),
      'one non-uuid in an id list collapses the whole list to its count');
    check(shaped.api_key === '[redacted]', 'and a secret is still a secret');
  }
  {
    const twice = redact({ tool: 'set_matter_state', args: redactToolArgs({ note: 'a private note' }) });
    check(twice.args.note.present === true && twice.args.note.length === 14,
      'redact() runs over the result and leaves an already-shaped value alone');
  }
  {
    const scrubbed = scrubArgValues(`search: syntax error in tsquery: "${QUERY}"`, { q: QUERY });
    check(!scrubbed.includes('side letter') && scrubbed.includes('[argument]'),
      'an error message that quotes an argument back is scrubbed before it is recorded');
  }

  // The negative control: this is what the code did before the fix.
  check(redact({ q: QUERY }).q === QUERY,
    'NEGATIVE CONTROL: redact() alone — the pre-fix path — stores args.q VERBATIM');
  check(redact({ query: QUERY }).query === QUERY && redactToolArgs({ query: QUERY }).query?.present === true,
    'and its `query` special case kept the text too; the allow-list keeps neither');
}

console.log('\n--- lib/ledger.mjs: failure modes --------------------------------');
const stubRpc = (error) => ({ rpc: async () => ({ data: null, error }) });
{
  _resetWarnings();
  const ok = await record({ rpc: async () => ({ data: [], error: null }) },
    { kind: 'tool.invoked', matterId: 'm', actor: { kind: 'user', ref: 'u' } });
  check(ok.ok === true, 'an RPC that answers with no error is a success, whatever shape it returns');

  const notDeployed = await record(stubRpc({ code: 'PGRST202', message: 'Could not find the function' }),
    { kind: 'tool.invoked', matterId: 'm' });
  check(notDeployed.ok === false && notDeployed.notDeployed === true,
    'PGRST202 is reported as NOT DEPLOYED, not as a failed write');
  check(isNotDeployed({ code: '42P01' }) && isNotDeployed({ message: 'relation "events" does not exist' }),
    'so are 42P01 and a missing relation');
  check(!isNotDeployed({ code: '42501', message: 'matter is not accessible' }),
    'a permission refusal is NOT mistaken for "not deployed"');

  const failed = await record(stubRpc({ code: '42501', message: 'nope' }), { kind: 'tool.invoked', matterId: 'm' });
  check(failed.ok === false && !failed.notDeployed, 'a real error is a failed write, and record() still does not throw');

  let threw = null;
  try {
    await recordStrict(stubRpc({ code: '42501', message: 'nope' }), { kind: 'completion.received', matterId: 'm' });
  } catch (e) { threw = e; }
  check(threw instanceof LedgerWriteError && threw.code === 'ledger_write_failed',
    'recordStrict throws LedgerWriteError on a real failure');

  let threw2 = null;
  try {
    await recordStrict(stubRpc({ code: 'PGRST202', message: 'Could not find the function' }),
      { kind: 'completion.received', matterId: 'm' });
  } catch (e) { threw2 = e; }
  check(threw2 === null, 'but NOT when the migration simply has not been pasted yet');

  const badKind = await record({ rpc: async () => ({ data: null, error: null }) }, { kind: 'nonsense' });
  check(badKind.ok === false, 'an unknown kind is refused before it reaches the database');
  // Read the constraint rather than counting to a literal: migration 072
  // widens the vocabulary (connector.connected), and a hard-coded count
  // would then fail for the one reason that is not a bug.
  const [kindDef] = await q(
    `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'events_kind_check'`);
  const dbKinds = [...String(kindDef.def).matchAll(/'([a-z]+\.[a-z]+)'/g)].map((m) => m[1]);
  const missing = dbKinds.filter((k) => !EVENT_KINDS.includes(k));
  const ahead = EVENT_KINDS.filter((k) => !dbKinds.includes(k));
  check(dbKinds.length === 14 && missing.length === 0,
    "the JS kind list covers every kind 064's CHECK constraint allows",
    missing.length ? `missing ${missing.join(' ')}` : `${dbKinds.length} kinds`);
  // 072 adds connector.connected; 073 adds completion.requested; 094 adds
  // the security build's fifteen (scripts/_verify-stepup-seal.mjs holds
  // those to the constraint). This database has only 064, so the JS list
  // legitimately runs ahead of the constraint by exactly those and by
  // nothing else.
  const LATER_MIGRATION_KINDS = ['connector.connected', 'completion.requested', ...KINDS_094];
  check(ahead.every((k) => LATER_MIGRATION_KINDS.includes(k)),
    'and runs ahead of it only by what a later migration adds (072, 073, 094)',
    ahead.join(' ') || 'none');

  // ── 073: a kind the CHECK constraint does not admit yet ──────────────────
  // The reason this classification exists: without it, merging the code that
  // writes completion.requested before Eden pastes 073 would make every
  // SEALED feature call refuse, because a 23514 is a real write failure and a
  // sealed matter withholds the answer on one. It is narrow on all three
  // axes, and each is asserted here.
  //
  // The insert guard fires BEFORE the constraint (a BEFORE ROW trigger always
  // does), so the flag _ledger_write raises is raised here too — otherwise
  // this would test the guard rather than the vocabulary.
  await db.exec(`set contextspaces.ledger_writing = 'on'`);
  const pre073 = await attempt(
    `insert into public.events (chain_key, seq, kind, actor_kind, actor_ref, payload, prev_hash, hash)
     values ('99999999-9999-4999-8999-999999999999', 1, 'completion.requested', 'user', 'u', '{}'::jsonb, '', 'h')`);
  check(pre073 !== null && String(pre073.code) === '23514',
    "before 073, 'completion.requested' is refused by events_kind_check",
    pre073 ? `${pre073.code}` : 'it was accepted');
  check(isKindNotAdmitted(pre073, 'completion.requested'),
    'and lib/ledger.mjs reads that as "the migration is not pasted yet", not as a failure');
  check(!isKindNotAdmitted(pre073, 'completion.received'),
    'but NEVER for a kind 064 itself admits — that would hide a real bug');
  check(!isKindNotAdmitted({ code: '23514', message: 'violates check constraint "events_payload_size_check"' },
    'completion.requested'),
    'and never for a different constraint on the same table');
  check(!isKindNotAdmitted({ code: '23503', message: 'events_kind_check' }, 'completion.requested'),
    'and never for a different SQLSTATE');

  // Now paste 073 and watch the same insert land.
  await db.exec(migration('073_completion_requested.sql'));
  const post073 = await attempt(
    `insert into public.events (chain_key, seq, kind, actor_kind, actor_ref, payload, prev_hash, hash)
     values ('99999999-9999-4999-8999-999999999999', 1, 'completion.requested', 'user', 'u', '{}'::jsonb, '', 'h')`);
  check(post073 === null, 'after 073, the same row is admitted', post073?.message ?? '');
  const [after073] = await q(
    `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'events_kind_check'`);
  const kinds073 = [...String(after073.def).matchAll(/'([a-z]+\.[a-z]+)'/g)].map((m) => m[1]);
  // Everything the JS knows except 094's fifteen, which 073 predates.
  const through073 = EVENT_KINDS.filter((k) => !KINDS_094.includes(k));
  check(through073.every((k) => kinds073.includes(k)) && kinds073.length === through073.length,
    "073's list is the UNION — 064's fourteen plus 072's kind plus its own, never a subset",
    `${kinds073.length} kinds`);
  check(kinds073.includes('connector.connected'),
    'so applying 073 to a 064-only database adds 072\'s kind rather than dropping anything');
  // Nothing is cleaned up, because nothing can be: the table refuses DELETE
  // to everybody, which is Part A's whole point. The two rows above therefore
  // sit on a chain of their own that no other assertion in this file reads.
  await db.exec(`set contextspaces.ledger_writing = 'off'`);
  const guarded = await attempt(
    `insert into public.events (chain_key, seq, kind, actor_kind, actor_ref, payload, prev_hash, hash)
     values ('99999999-9999-4999-8999-999999999999', 2, 'completion.requested', 'user', 'u', '{}'::jsonb, '', 'h')`);
  check(guarded !== null && String(guarded.code) === '42501',
    'and the insert guard is back on: a direct INSERT of the new kind is refused like any other');

  // uuidList: the same allow-list rule for a list a CLIENT supplied. redact()
  // would keep every one of these strings — they are under 256 characters.
  check(JSON.stringify(uuidList(['11111111-1111-4111-8111-111111111111'])) ===
    JSON.stringify(['11111111-1111-4111-8111-111111111111']),
    'uuidList keeps a list of uuids');
  check(JSON.stringify(uuidList(['11111111-1111-4111-8111-111111111111', 'Peloso arbitration'])) ===
    JSON.stringify({ items: 2 }),
    'and reduces the WHOLE list to its size as soon as one element is not a uuid');
  check(uuidList('not a list') === null && JSON.stringify(uuidList([])) === '[]',
    'a non-list is nothing at all; an empty list is an empty list');
}

console.log('\n--- sealed strict mode (lib/assistant-core.mjs) -------------------');
{
  const { runAssistantStream, bedrockCredsFromEnv } = await import('../lib/assistant-core.mjs');
  const CREDS = bedrockCredsFromEnv({
    BEDROCK_AWS_ACCESS_KEY_ID: 'AKIDTEST', BEDROCK_AWS_SECRET_ACCESS_KEY: 'testsecret',
  });
  const sse = (evts) => evts.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\ndata: [DONE]\n\n';
  // The default sealed pen (BEDROCK_MODEL = moonshotai.kimi-k2.5) takes the
  // OpenAI-compatible chat route; Tier A's first-party pen goes through the
  // Anthropic SDK and wants the Messages SSE with `event:` lines. Both say
  // exactly THE ANSWER TEXT and nothing else.
  const BEDROCK_ANSWER = sse([
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'THE ANSWER TEXT' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } },
  ]);
  const ANTHROPIC_ANSWER = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'THE ANSWER TEXT' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}`).join('\n\n') + '\n\n';

  // Enough supabase-js for matterTierWithClient + ai_sessions + rpc.
  const stub = ({ tier = 'B', rpcError = null, messageError = null } = {}) => {
    const table = (name) => {
      const t = {
        select: () => t, eq: () => t, in: () => t, order: () => t,
        limit: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: () => Promise.resolve(
          name === 'matterspaces'
            ? { data: { id: 'm-1', parent_matterspace_id: null, ai_tier: tier }, error: null }
            : { data: null, error: null }),
        single: () => Promise.resolve({ data: null, error: { message: 'stub' } }),
        insert() {
          const ins = {
            select: () => ins,
            single: () => (name === 'ai_sessions'
              ? Promise.resolve({ data: { id: 'sess-1', matterspace_id: 'm-1', tier, status: 'open' }, error: null })
              : Promise.resolve({ data: null, error: { message: 'stub' } })),
            then: (r) => Promise.resolve({
              data: null,
              error: name === 'ai_messages' ? messageError : null,
            }).then(r),
          };
          return ins;
        },
        update: () => ({ eq: () => Promise.resolve({ error: null }), then: (r) => Promise.resolve({ error: null }).then(r) }),
      };
      return t;
    };
    return { from: table, rpc: async () => ({ data: null, error: rpcError }) };
  };

  const realFetch = globalThis.fetch;
  let penCalls = 0;
  const run = async (supabase, tier = 'B') => {
    penCalls = 0;
    globalThis.fetch = async () => {
      penCalls += 1;
      return new Response(
        tier === 'A' ? ANTHROPIC_ANSWER : BEDROCK_ANSWER,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };
    const events = [];
    try {
      await runAssistantStream({
        supabase, anthropicKey: 'ak', bedrockCreds: CREDS, openaiApiKey: 'ok',
        messages: [{ role: 'user', content: 'What does the seal cover?' }],
        matterId: 'm-1', emit: (ev) => events.push(ev),
      });
    } finally { globalThis.fetch = realFetch; }
    const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    return { events, text, err: events.find((e) => e.type === 'error') };
  };

  _resetWarnings();
  {
    const r = await run(stub({ tier: 'B', rpcError: { code: '42501', message: 'ledger unavailable' } }));
    check(penCalls === 1 && r.events.some((e) => e.type === 'session'),
      'the sealed pen WAS asked and DID answer (so the next line is a withholding, not a failure)',
      `${penCalls} request(s)`);
    check(!r.text.includes('THE ANSWER TEXT'),
      'SEALED + the ledger write fails → the answer is NOT delivered', JSON.stringify(r.text).slice(0, 40));
    check(r.err?.code === 'exchange_unrecorded', 'and the turn ends in a plain-language refusal', r.err?.code);
    check(/could not be recorded/i.test(r.err?.message ?? '') && !/Nothing was sent/.test(r.err?.message ?? ''),
      'whose words are true of what happened (the pen WAS reached)');
  }
  _resetWarnings();
  {
    const r = await run(stub({ tier: 'B', messageError: { message: 'ai_messages write failed' } }));
    check(!r.text.includes('THE ANSWER TEXT') && r.err?.code === 'exchange_unrecorded',
      'the same when it is the ai_sessions record that fails — no longer swallowed on a sealed matter');
  }
  _resetWarnings();
  {
    const r = await run(stub({ tier: 'B', rpcError: { code: 'PGRST202', message: 'Could not find the function' } }));
    check(r.text.includes('THE ANSWER TEXT') && !r.err,
      'SEALED + the migration is NOT PASTED YET → the answer IS delivered (merge order is safe)',
      `${JSON.stringify(r.text).slice(0, 40)} ${r.err ? JSON.stringify(r.err).slice(0, 140) : ''}`);
  }
  _resetWarnings();
  {
    const r = await run(stub({ tier: 'A', rpcError: { code: '42501', message: 'ledger unavailable' } }), 'A');
    check(r.text.includes('THE ANSWER TEXT') && !r.err,
      'UNSEALED + the ledger write fails → the answer is delivered and the failure is logged',
      r.err ? JSON.stringify(r.err).slice(0, 120) : '');
  }
  _resetWarnings();
  {
    const r = await run(stub({ tier: 'B' }));
    check(r.text.includes('THE ANSWER TEXT') && !r.err,
      'SEALED + the ledger works → the answer is delivered as usual',
      `${JSON.stringify(r.text).slice(0, 40)} ${r.err ? JSON.stringify(r.err).slice(0, 140) : ''}`);
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
