// Execute migration 072 against a real Postgres and prove the two holes
// migration 064's own PR declared are closed — without opening a third.
//
// Why this exists
// ---------------------------------------------------------------------------
// #170 built the matter's Record and said, in its own §6, what it does not
// do: a connected assistant calling `search` with `matter` omitted — the
// broadest read a connector can make, and the one the MCP tool description
// advertises — resolves to no single matter and is therefore recorded
// nowhere; and `ai_sessions` could still be edited by the person the record
// is about. "Every AI action is recorded" was not true.
//
// 072 gives every ACCOUNT its own chain in the same table, fans a
// cross-matter call out into each matter it actually read from, and makes
// the AI session row immutable. The thing that has to be proved is not
// merely that rows appear: it is that they appear WITHOUT one matter's
// Record ever revealing that another matter exists.
//
// Three parts:
//   A. the negative control — 064 alone, on #170's exact schema, showing
//      both holes are real before 072 runs;
//   B. 072 applied twice, and everything it promises, including the JS in
//      lib/ledger.mjs driven END TO END against this database through a
//      supabase-shaped adapter, so the redaction and the fan-out are tested
//      as they actually run and not as a re-implementation;
//   C. a second, clean database with NO 064, where 072 must do nothing at
//      all and say so.
//
//   npm i --no-save @electric-sql/pglite     # once; not a repo dependency
//   node scripts/_verify-ledger-account.mjs
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

const {
  record, recordAccount, recordCrossMatter, verifyAccountChain,
  shapeOnly, mattersTouchedBy, redact, isNotDeployed,
  FANOUT_CEILING, FANOUT_VIA, ACCOUNT_EVENT_KINDS, EVENT_KINDS, _resetWarnings,
} = await import('../lib/ledger.mjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationSql = (name) =>
  fs.readFileSync(path.resolve(__dirname, '..', 'supabase', 'migrations', name), 'utf8');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

// The distinctive query text. It appears in no matter name, no tool name and
// no fixture: anything that echoes it into a stored payload is a leak, and
// §B9 greps every row for it.
const QUERY = 'zarquon errata sheet, §220 demand, and the Fleming carve-out';

// ---------------------------------------------------------------------------
// A database with the bits of Supabase the migrations assume.
// ---------------------------------------------------------------------------
async function freshDatabase({ withLedger }) {
  const db = new PGlite({ extensions: { uuid_ossp } });
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

    create table public.documents (
      id uuid primary key default gen_random_uuid(), matterspace_id uuid, created_by uuid);
    create table public.passages (
      id uuid primary key default gen_random_uuid(), matterspace_id uuid);
    create table storage.objects (
      id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    create or replace function storage.foldername(p_name text)
    returns text[] language sql immutable as $$ select string_to_array(p_name, '/') $$;

    grant usage on schema public, auth, storage to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  for (const m of ['001_initial_schema.sql', '005_fix_rls_recursion.sql', '008_submatters.sql',
                   '016_matterspace_members.sql', '022_matterspaces_rls_invoker_wrappers.sql',
                   '051_securespace.sql']) {
    await db.exec(migrationSql(m));
  }
  await db.exec(`
    grant select, insert, update, delete on all tables in schema public
      to anon, authenticated, service_role;`);
  if (withLedger) await db.exec(migrationSql('064_events_ledger.sql'));
  return db;
}

// ===========================================================================
// PART A + B — the database that has 064
// ===========================================================================
const db = await freshDatabase({ withLedger: true });
const q = async (sql, params) => (await db.query(sql, params)).rows;
const attempt = async (sql, params) => {
  try { await db.query(sql, params); return null; } catch (err) { return err; }
};
const attemptExec = async (sql) => {
  try { await db.exec(sql); return null; } catch (err) { return err; }
};

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

// ---------------------------------------------------------------------------
// The firm.
// ---------------------------------------------------------------------------
console.log('\n--- a firm ------------------------------------------------------');
await asSuperuser();
const signup = async (email, name) => {
  const [row] = await q(
    `insert into auth.users (email, raw_user_meta_data)
     values ($1, jsonb_build_object('display_name', $2::text)) returning id`, [email, name]);
  return row.id;
};
const ADA = await signup('ada@example.test', 'Ada');   // owns the serverspace
const DAN = await signup('dan@example.test', 'Dan');   // co-counsel on M1 ONLY
const BOB = await signup('bob@example.test', 'Bob');   // a stranger

const [s1] = await q(
  `insert into public.serverspaces (clientspace_id, name)
   select id, 'Quainton Law' from public.clientspaces where user_id = $1 returning id`, [ADA]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner')`, [s1.id, ADA]);
const newMatter = async (name) => {
  const [m] = await q(
    `insert into public.matterspaces (serverspace_id, name) values ($1,$2) returning id`, [s1.id, name]);
  return m.id;
};
const M1 = await newMatter('Peloso v. Curtis');
const M3 = await newMatter('DeCamara Appeal');
const MSEALED = await newMatter('Heppner (sealed)');
await q(`update public.matterspaces set ai_tier = 'B' where id = $1`, [MSEALED]);
await q(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,'member')`, [M1, DAN]);
console.log('  Ada owns everything; Dan is on M1 only; Bob is a stranger; one matter is sealed');

// ---------------------------------------------------------------------------
// PART A — the negative control, on #170's exact schema
// ---------------------------------------------------------------------------
console.log('\n--- A. the negative control: 064 alone, both holes open ---------');
{
  await asUser(ADA);
  const [before] = await q(
    `select public.ledger_append(p_kind := 'tool.invoked', p_matter := null,
       p_actor_kind := 'connector', p_actor_ref := 'claude.ai',
       p_payload := '{"tool":"search"}'::jsonb) as r`);
  const NIL = '00000000-0000-0000-0000-000000000000';
  check(before.r?.chain_key === NIL,
    'HOLE 1: a matter-less event lands on the shared NIL chain, not on an account chain',
    `chain_key ${before.r?.chain_key}`);

  const acct = await attempt(
    `select public.ledger_append_account(p_kind := 'tool.invoked')`);
  check(acct !== null, 'and there is no account chain to put it on (ledger_append_account absent)',
    acct?.message?.slice(0, 55));

  const [ses] = await q(
    `insert into public.ai_sessions (matterspace_id, tier, title)
     values ($1,'A','Research') returning id`, [M1]);
  const edit = await attempt(
    `update public.ai_sessions set tier = 'C', title = 'Something else' where id = $1`, [ses.id]);
  check(edit === null,
    'HOLE 2: the session owner can rewrite the tier that governed the session',
    'UPDATE succeeded');
  const [after] = await q(`select tier from public.ai_sessions where id = $1`, [ses.id]);
  check(after.tier === 'C', 'and the change sticks — the AI record is editable by its subject');
  await asSuperuser();
  await db.query(`select set_config('contextspaces.ledger_writing','on',true)`);
  await q(`update public.ai_sessions set tier = 'A' where id = $1`, [ses.id]);
}

// ---------------------------------------------------------------------------
// PART B — 072
// ---------------------------------------------------------------------------
console.log('\n--- B1. migration 072, applied twice ----------------------------');
await asSuperuser();
{
  const first = await attemptExec(migrationSql('072_account_chain_and_session_immutability.sql'));
  check(first === null, 'the file applies on top of 064', first?.message?.slice(0, 90));
  const second = await attemptExec(migrationSql('072_account_chain_and_session_immutability.sql'));
  check(second === null, 'and applies again over itself (drift-safe)', second?.message?.slice(0, 90));

  const [amb] = await q(`
    select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = '_ledger_write'`);
  check(amb.n === 1,
    '_ledger_write is REPLACED, not overloaded — an ambiguous call would break the acl triggers',
    `${amb.n} definition(s)`);

  const [kinds] = await q(`
    select count(*)::int as n from pg_constraint
     where conname = 'events_kind_check' and pg_get_constraintdef(oid) like '%connector.connected%'`);
  check(kinds.n === 1, "connector.connected is a legal kind for PR #166 to write (defined, not wired)");
  check(EVENT_KINDS.includes('connector.connected'),
    'and lib/ledger.mjs knows it too, so record() will not refuse it before the RPC');
}

console.log('\n--- B1b. 064\'s own triggers, through the delegate ----------------');
{
  // The ambiguity argument above is only worth as much as this section. After
  // 072, every one of 064's database-written events goes _ledger_write →
  // _ledger_write_scoped(…, null) → the new invariant trigger. If any of that
  // were wrong, adding a person to a matter would fail — in the product, not
  // here. So exercise all three, after 072, and look at where they landed.
  await asSuperuser();
  const ERIC = await signup('eric@example.test', 'Eric');
  const M4 = await newMatter('Trigger check matter');
  const NIL = '00000000-0000-0000-0000-000000000000';
  const newest = async () =>
    (await q(`select chain_key, kind, matterspace_id, serverspace_id, payload
                from public.events order by ts desc, seq desc limit 1`))[0];

  const acl = await attempt(
    `insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,'member')`,
    [M4, ERIC]);
  check(acl === null, 'a matter membership can still be granted after 072', acl?.message?.slice(0, 60));
  let e = await newest();
  check(e.kind === 'acl.changed' && e.chain_key === M4,
    "and its acl.changed lands on that matter's own chain", `chain ${e.chain_key === M4 ? 'M4' : e.chain_key}`);

  const sacl = await attempt(
    `insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'member')`,
    [s1.id, ERIC]);
  check(sacl === null, 'so can a serverspace membership', sacl?.message?.slice(0, 60));
  e = await newest();
  check(e.kind === 'acl.changed' && e.chain_key === NIL && e.serverspace_id === s1.id,
    "and its acl.changed still lands on 064's nil chain, which 072 left legal");

  const seal = await attempt(`update public.matterspaces set ai_tier = 'B' where id = $1`, [M4]);
  check(seal === null, 'and a matter can still be sealed', seal?.message?.slice(0, 60));
  e = await newest();
  check(e.kind === 'seal.changed' && e.chain_key === M4 && e.payload.new_tier === 'B',
    "with seal.changed on the matter's chain — the delegate is not a detour");
}

// The adapter: a supabase-shaped client backed by this database, so the REAL
// lib/ledger.mjs runs against the REAL migration. Nothing is re-implemented.
const clientFor = (uid) => ({
  rpc: async (fn, params = {}) => {
    try {
      if (uid === null) await asService(); else await asUser(uid);
      let rows;
      if (fn === 'ledger_append') {
        rows = await q(
          `select public.ledger_append($1::text,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,$7::text,$8::jsonb) as r`,
          [params.p_kind, params.p_matter, params.p_serverspace, params.p_session,
           params.p_actor_kind, params.p_actor_ref, params.p_actor_label,
           JSON.stringify(params.p_payload ?? {})]);
      } else if (fn === 'ledger_append_account') {
        rows = await q(
          `select public.ledger_append_account($1::text,$2::uuid,$3::text,$4::text,$5::text,$6::jsonb) as r`,
          [params.p_kind, params.p_session, params.p_actor_kind,
           params.p_actor_ref, params.p_actor_label, JSON.stringify(params.p_payload ?? {})]);
      } else if (fn === 'verify_account_chain') {
        rows = await q(`select * from public.verify_account_chain()`);
        return { data: rows, error: null };
      } else if (fn === 'verify_chain') {
        rows = await q(`select * from public.verify_chain($1::uuid)`, [params.p_chain_key]);
        return { data: rows, error: null };
      } else if (fn === 'ai_session_touch') {
        rows = await q(`select public.ai_session_touch($1::uuid,$2::text) as r`,
          [params.p_session, params.p_title]);
      } else {
        return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } };
      }
      return { data: rows[0]?.r ?? null, error: null };
    } catch (err) {
      return { data: null, error: { message: err?.message ?? String(err), code: err?.code } };
    }
  },
});

console.log('\n--- B2. the account chain ---------------------------------------');
const adaClient = clientFor(ADA);
{
  _resetWarnings();
  const r = await recordAccount(adaClient, {
    kind: 'tool.invoked',
    actor: { kind: 'connector', ref: 'cid-claude-desktop', label: 'Claude Desktop' },
    payload: { scope: 'account', tool: 'list_matters', result_count: 3 },
  });
  check(r.ok === true && r.seq >= 1, 'recordAccount writes a row and returns {seq, hash}', `seq ${r.seq}`);

  await asSuperuser();
  const [row] = await q(`select * from public.events where id = $1`, [r.id]);
  check(row.chain_key === ADA, "the chain key is the ACCOUNT's own id", row.chain_key === ADA ? '' : row.chain_key);
  check(row.matterspace_id === null && row.serverspace_id === null && row.matter_name === null,
    'and the row names no matter and no serverspace — there is nothing in it to leak');
  check(row.actor_user_id === ADA && row.actor_kind === 'connector',
    'the byline is auth.uid() with the connector named beside it');

  const v = await verifyAccountChain(adaClient);
  check(v.ok === true && v.checked >= 1, 'verify_account_chain verifies the caller their own chain',
    `checked ${v.checked}`);

  // The kinds that are matter-bound by definition.
  const bad = await recordAccount(adaClient, {
    kind: 'completion.received', actor: { kind: 'user', ref: ADA }, payload: {},
  });
  check(bad.ok === false, 'completion.received is refused on an account chain (it is matter-bound)');
  await asUser(ADA);
  const badSql = await attempt(
    `select public.ledger_append_account(p_kind := 'seal.changed')`);
  check(badSql !== null, 'and the database refuses it too, not only the JS',
    badSql?.message?.slice(0, 60));
  check(ACCOUNT_EVENT_KINDS.length === 6, 'six kinds are account-legal', ACCOUNT_EVENT_KINDS.join(' '));
}

console.log('\n--- B3. the account chain is a record, not a table ---------------');
{
  await asUser(ADA);
  const [mine] = await q(`select id from public.events where chain_key = $1 limit 1`, [ADA]);
  for (const [label, become] of [['its own owner', () => asUser(ADA)],
                                 ['service_role (BYPASSRLS)', asService],
                                 ['a SUPERUSER', asSuperuser]]) {
    await become();
    const upd = await attempt(`update public.events set payload = '{"x":1}'::jsonb where id = $1`, [mine.id]);
    const del = await attempt(`delete from public.events where id = $1`, [mine.id]);
    check(upd !== null && del !== null, `UPDATE and DELETE on an account row are refused as ${label}`,
      upd?.message?.slice(0, 45));
  }

  // The chain key cannot be aimed. Three ways of trying:
  await asUser(ADA);
  const aimed = await attempt(
    `select public._ledger_write_scoped('tool.invoked',null,null,null,'user','x',null,'{}'::jsonb,$1::uuid,$2::uuid)`,
    [ADA, BOB]);
  check(aimed !== null, '_ledger_write_scoped is not executable by a signed-in user at all',
    aimed?.message?.slice(0, 50));
  await asService();
  const aimedSvc = await attempt(
    `select public._ledger_write_scoped('tool.invoked',null,null,null,'user','x',null,'{}'::jsonb,$1::uuid,$2::uuid)`,
    [ADA, BOB]);
  check(aimedSvc !== null, 'nor by service_role', aimedSvc?.message?.slice(0, 50));
  await asSuperuser();
  const aimedSu = await attempt(
    `select public._ledger_write_scoped('tool.invoked',null,null,null,'user','x',null,'{}'::jsonb,$1::uuid,$2::uuid)`,
    [ADA, BOB]);
  check(aimedSu !== null && /own account/i.test(aimedSu?.message ?? ''),
    'and even a SUPERUSER cannot write a row into a chain that is not the writer\'s own account',
    aimedSu?.message?.slice(0, 60));

  // The last word is the trigger, because a future writer can route around a
  // function but not around a trigger. Raise 064's own insert flag by hand
  // and try to place a row in Ada's chain with Bob's byline.
  const forged = await attemptExec(`
    begin;
    select set_config('contextspaces.ledger_writing','on',true);
    insert into public.events (chain_key, seq, kind, actor_kind, actor_ref, actor_user_id, prev_hash, hash)
    values ('${ADA}', 9999, 'tool.invoked', 'user', 'x', '${BOB}', '', 'deadbeef');
    commit;`);
  check(forged !== null, 'the chain-key invariant is a TRIGGER: a hand-made insert is refused too',
    forged?.message?.slice(0, 60));
  await attemptExec('rollback');
}

console.log('\n--- B4. a cross-matter search, end to end ------------------------');
// What handleSearch actually returns when `matter` is omitted: each hit
// carries the matter it came from. Two hits from M1, one from M3.
const searchArgs = { q: QUERY, limit: 5, doc_types: ['deposition'], full_text: false };
const searchResult = {
  query: QUERY,
  matter: null,
  scope: 'all_matters',
  result_count: 3,
  results: [
    { matter: { id: M1, short_code: 'peloso', name: 'Peloso v. Curtis' }, passage_id: 'p1' },
    { matter: { id: M3, short_code: 'decamara', name: 'DeCamara Appeal' }, passage_id: 'p2' },
    { matter: { id: M1, short_code: 'peloso', name: 'Peloso v. Curtis' }, passage_id: 'p3' },
  ],
};
let fan;
{
  await asSuperuser();
  const [b] = await q(`select count(*)::int as n from public.events`);
  fan = await recordCrossMatter(adaClient, {
    tool: 'search', args: searchArgs, result: searchResult,
    actor: { kind: 'connector', ref: 'cid-claude-desktop', label: 'Claude Desktop' },
    primaryMatterId: null, connector: true, ok: true, ms: 812,
  });
  await asSuperuser();
  const [a] = await q(`select count(*)::int as n from public.events`);
  check(a.n - b.n === 3, 'one call writes 1 account row + 2 matter rows', `${a.n - b.n} rows`);
  check(fan.account?.ok === true && fan.fanout === 2 && fan.touched === 2 && fan.overflow === 0,
    'and reports what it wrote', JSON.stringify({ fanout: fan.fanout, overflow: fan.overflow }));

  const [acct] = await q(
    `select payload from public.events where chain_key = $1 order by seq desc limit 1`, [ADA]);
  check(acct.payload.scope === 'account' && acct.payload.tool === 'search',
    'the account row says a search was run');
  check(acct.payload.matters_touched === 2 && acct.payload.result_count === 3,
    'with COUNTS: 2 matters, 3 results', JSON.stringify(acct.payload.matters_touched));
  check(acct.payload.connector_client_id === 'cid-claude-desktop',
    'and the connector that ran it');
  const acctText = JSON.stringify(acct.payload);
  check(!acctText.includes(M1) && !acctText.includes(M3)
        && !acctText.includes('Peloso') && !acctText.includes('DeCamara'),
    'the account row carries NO matter id and NO matter name — counts are the whole of it');

  const rows = await q(
    `select matterspace_id, payload from public.events
      where (payload ->> 'via') = $1 order by matterspace_id`, [FANOUT_VIA]);
  check(rows.length === 2, `two matter rows carry via = '${FANOUT_VIA}'`, `${rows.length}`);
  const byMatter = new Map(rows.map((r) => [r.matterspace_id, r.payload]));
  check(byMatter.get(M1)?.result_count === 2 && byMatter.get(M3)?.result_count === 1,
    "each matter row carries THAT matter's own count and no other",
    `M1 ${byMatter.get(M1)?.result_count}, M3 ${byMatter.get(M3)?.result_count}`);
  check(byMatter.get(M1)?.scope === 'matter' && byMatter.get(M3)?.scope === 'matter',
    "and scope = 'matter', which is what the Record tab filters on");
  const m1Text = JSON.stringify(byMatter.get(M1));
  check(!m1Text.includes(M3) && !m1Text.includes('DeCamara'),
    "M1's row says nothing whatever about M3 — not its id, not its name, not its count");
}

console.log('\n--- B5. isolation, from the reader\'s side ------------------------');
{
  // Dan is on M1 and nowhere near M3. Everything he can see, he may see.
  await asUser(DAN);
  const danRows = await q(`select matterspace_id, matter_name, payload from public.events`);
  check(danRows.length > 0, 'Dan can read M1\'s Record', `${danRows.length} rows`);
  check(danRows.every((r) => r.matterspace_id !== M3),
    'and not one row of M3, although the same search touched both');
  const danText = JSON.stringify(danRows);
  check(!danText.includes(M3) && !danText.includes('DeCamara'),
    "M3's id and name appear NOWHERE in anything Dan can read — the fan-out did not leak sideways");
  const danSawFanout = danRows.some((r) => r.payload?.via === FANOUT_VIA && r.matterspace_id === M1);
  check(danSawFanout,
    'but Dan DOES see that a connected assistant read from M1 as part of an account-wide search');

  // Nobody reads anybody else's account chain.
  const danOnAda = await q(`select count(*)::int as n from public.events where chain_key = $1`, [ADA]);
  check(danOnAda[0].n === 0, "Dan sees zero rows of Ada's account chain");
  const danVerifyAda = await q(`select * from public.verify_chain($1::uuid)`, [ADA]);
  check(Number(danVerifyAda[0].checked) === 0,
    "and verify_chain on Ada's account chain checks 0 rows for him — it tells him nothing");
  const danOwn = await verifyAccountChain(clientFor(DAN));
  check(danOwn.checked === 0, 'Dan has no account chain of his own yet, and that reads as empty, not as broken');

  await asUser(BOB);
  const bobRows = await q(`select count(*)::int as n from public.events`);
  check(bobRows[0].n === 0, 'a stranger sees nothing at all');
}

console.log('\n--- B6. sealed matters ------------------------------------------');
{
  // The seal keeps a sealed matter out of the search SCOPE, so it can never
  // be in the result. This is the second line: if one ever appeared, the
  // Record must not be the thing that publishes it.
  await asSuperuser();
  const [b] = await q(`select count(*)::int as n from public.events`);
  const sealedResult = {
    result_count: 2,
    results: [
      { matter: { id: M1, name: 'Peloso v. Curtis' }, passage_id: 'p1' },
      { matter: { id: MSEALED, name: 'Heppner (sealed)' }, passage_id: 'p2' },
    ],
  };
  const r = await recordCrossMatter(adaClient, {
    tool: 'search', args: { q: QUERY }, result: sealedResult,
    actor: { kind: 'connector', ref: 'cid-claude-desktop', label: 'Claude Desktop' },
    primaryMatterId: null, connector: true, excludeMatterIds: new Set([MSEALED]), ok: true,
  });
  await asSuperuser();
  const [a] = await q(`select count(*)::int as n from public.events`);
  check(a.n - b.n === 2, 'a sealed matter in a result produces no row of its own', `${a.n - b.n} rows`);
  check(r.touched === 1 && r.fanout === 1,
    'it is not counted as touched either — the account row says one matter, not two');
  const sealedRows = await q(
    `select count(*)::int as n from public.events where matterspace_id = $1 and (payload->>'via') = $2`,
    [MSEALED, FANOUT_VIA]);
  check(sealedRows[0].n === 0, 'and the sealed matter\'s own Record shows no connector read');
}

console.log('\n--- B7. the fan-out ceiling -------------------------------------');
{
  const many = [];
  for (let i = 0; i < FANOUT_CEILING + 5; i += 1) {
    await asSuperuser();
    many.push(await newMatter(`Bulk matter ${i}`));
  }
  const bigResult = { result_count: many.length, results: many.map((id) => ({ matter: { id }, passage_id: id })) };
  await asSuperuser();
  const [b] = await q(`select count(*)::int as n from public.events`);
  const r = await recordCrossMatter(adaClient, {
    tool: 'search', args: { q: QUERY }, result: bigResult,
    actor: { kind: 'connector', ref: 'cid-claude-desktop', label: 'Claude Desktop' },
    primaryMatterId: null, connector: true, ok: true,
  });
  await asSuperuser();
  const [a] = await q(`select count(*)::int as n from public.events`);
  check(a.n - b.n === FANOUT_CEILING + 1,
    `past the ceiling the fan-out stops at ${FANOUT_CEILING} rows (+1 account row)`, `${a.n - b.n} rows`);
  check(r.overflow === 5 && r.touched === FANOUT_CEILING + 5,
    'and the overflow is counted, not dropped', `overflow ${r.overflow}`);
  const [acct] = await q(
    `select payload from public.events where chain_key = $1 order by seq desc limit 1`, [ADA]);
  check(acct.payload.matters_touched === FANOUT_CEILING + 5
        && acct.payload.matters_recorded === FANOUT_CEILING
        && acct.payload.matters_overflow === 5,
    'the account row states all three numbers, so a reader knows the record is partial and by how much',
    JSON.stringify([acct.payload.matters_touched, acct.payload.matters_recorded, acct.payload.matters_overflow]));
}

console.log('\n--- B8. tamper --------------------------------------------------');
{
  await asSuperuser();
  const [target] = await q(
    `select id, seq, payload from public.events where chain_key = $1 order by seq asc offset 1 limit 1`, [ADA]);
  await db.exec('alter table public.events disable trigger events_no_update');
  await q(`update public.events set payload = payload || '{"result_count":999}'::jsonb where id = $1`, [target.id]);
  await db.exec('alter table public.events enable trigger events_no_update');

  const v = await verifyAccountChain(adaClient);
  check(v.ok === false && Number(v.first_bad_seq) === Number(target.seq),
    'one altered byte on the account chain flips verify_account_chain to that exact first_bad_seq',
    `first_bad_seq ${v.first_bad_seq} (seq ${target.seq})`);

  await asSuperuser();
  const m1v = await q(`select * from public.verify_chain($1::uuid)`, [M1]);
  check(m1v[0].ok === true, "and M1's own chain is unaffected — the chains are independent");

  await db.exec('alter table public.events disable trigger events_no_update');
  await q(`update public.events set payload = $2::jsonb where id = $1`, [target.id, JSON.stringify(target.payload)]);
  await db.exec('alter table public.events enable trigger events_no_update');
  const back = await verifyAccountChain(adaClient);
  check(back.ok === true, 'restoring the byte restores the chain');
}

console.log('\n--- B9. redaction: the query text is nowhere ---------------------');
{
  await asSuperuser();
  const [hit] = await q(
    `select count(*)::int as n from public.events where payload::text ilike '%zarquon%'`);
  check(hit.n === 0,
    'no stored payload anywhere contains the query text — not the account row, not one fan-out row',
    `${hit.n} rows matched`);
  // M3's row, which only the B4 call wrote, so the argument shape is B4's.
  const [shape] = await q(
    `select payload from public.events where matterspace_id = $1 and (payload->>'via') = $2 limit 1`,
    [M3, FANOUT_VIA]);
  check(shape.payload.args?.q?.chars === QUERY.length,
    'what is kept is its LENGTH, which is metadata', `chars ${shape.payload.args?.q?.chars}`);
  check(shape.payload.matter_filter === false,
    'and whether a matter filter was given, which is the fact that matters');
  check(shape.payload.args?.doc_types?.items === 1 && shape.payload.args?.full_text === false,
    'array arguments become their size; booleans and numbers survive');
}

console.log('\n--- B10. the AI session record is uneditable ---------------------');
{
  await asUser(ADA);
  const [ses] = await q(
    `insert into public.ai_sessions (matterspace_id, tier, title)
     values ($1,'B','Sealed research') returning id, updated_at`, [M1]);
  check(ses.id != null, 'the app can still OPEN a session (insert is untouched)');

  const direct = await attempt(
    `update public.ai_sessions set title = 'Renamed' where id = $1`, [ses.id]);
  check(direct !== null, 'the owner cannot UPDATE the row directly any more',
    direct?.message?.slice(0, 55));

  const touched = await clientFor(ADA).rpc('ai_session_touch', { p_session: ses.id, p_title: null });
  check(touched.error === null, 'ai_session_touch moves updated_at', touched.error?.message?.slice(0, 50));
  await asSuperuser();
  const [moved] = await q(`select updated_at, title, tier from public.ai_sessions where id = $1`, [ses.id]);
  check(moved.updated_at > ses.updated_at && moved.title === 'Sealed research' && moved.tier === 'B',
    'and moves nothing else');

  const renamed = await clientFor(ADA).rpc('ai_session_touch', { p_session: ses.id, p_title: 'Renamed' });
  await asSuperuser();
  const [r2] = await q(`select title, tier from public.ai_sessions where id = $1`, [ses.id]);
  check(renamed.error === null && r2.title === 'Renamed' && r2.tier === 'B',
    'a title is a label and may be changed through the door; the tier is provenance and may not');

  const stranger = await clientFor(BOB).rpc('ai_session_touch', { p_session: ses.id, p_title: 'Mine now' });
  check(stranger.error !== null, "a stranger cannot touch somebody else's session",
    stranger.error?.message?.slice(0, 45));

  for (const [label, become] of [['service_role (BYPASSRLS)', asService], ['a SUPERUSER', asSuperuser]]) {
    await become();
    const tier = await attempt(`update public.ai_sessions set tier = 'A' where id = $1`, [ses.id]);
    check(tier !== null, `the tier cannot be rewritten by ${label} either`, tier?.message?.slice(0, 45));
  }

  await asSuperuser();
  await q(`insert into public.ai_messages (session_id, seq, role, content, model, provider,
             input_tokens, output_tokens, estimated_cost, within_policy)
           values ($1, 0, 'assistant', '[]'::jsonb, 'moonshotai.kimi-k2.5', 'aws-bedrock', 11, 22, 0.01, true)`,
    [ses.id]);
  for (const [label, become] of [['its owner', () => asUser(ADA)],
                                 ['service_role', asService], ['a SUPERUSER', asSuperuser]]) {
    await become();
    const msg = await attempt(
      `update public.ai_messages set model = 'something-else', within_policy = false where session_id = $1`,
      [ses.id]);
    check(msg !== null, `ai_messages: model / within_policy cannot be rewritten by ${label}`,
      msg?.message?.slice(0, 45));
  }

  await asSuperuser();
  const [pol] = await q(`
    select count(*)::int as n from pg_policies
     where schemaname = 'public' and tablename in ('ai_sessions','ai_messages') and cmd = 'UPDATE'`);
  check(pol.n === 0, 'no UPDATE policy is left on either table', `${pol.n}`);
}

console.log('\n--- B11. the blanket grant, re-applied AFTER 072 -----------------');
{
  await asSuperuser();
  await db.exec(`grant select, insert, update, delete on all tables in schema public
                   to anon, authenticated, service_role;`);
  // A signed-in user regains the table PRIVILEGE, so the refusal changes
  // shape rather than disappearing: with no UPDATE policy left, RLS matches
  // no rows and the statement touches nothing. What matters is the row.
  await asUser(ADA);
  const [mine] = await q(`select id, payload from public.events where chain_key = $1 limit 1`, [ADA]);
  await attempt(`update public.events set payload = '{"rewritten":true}'::jsonb where id = $1`, [mine.id]);
  const [ses] = await q(`select id, tier from public.ai_sessions order by created_at desc limit 1`);
  await attempt(`update public.ai_sessions set tier = 'A' where id = $1`, [ses.id]);
  await asSuperuser();
  const [stillMine] = await q(`select payload from public.events where id = $1`, [mine.id]);
  const [stillSes] = await q(`select tier from public.ai_sessions where id = $1`, [ses.id]);
  check(stillMine.payload.rewritten === undefined,
    'an account row is unchanged after a signed-in user tries, blanket grant and all');
  check(stillSes.tier === ses.tier, 'and so is the session tier', `tier ${stillSes.tier}`);

  // service_role has BYPASSRLS, so for it the trigger is the only thing
  // left — which is the whole reason the guard is a trigger.
  await asService();
  const svcEvent = await attempt(`update public.events set payload = '{}'::jsonb where id = $1`, [mine.id]);
  check(svcEvent !== null, 'service_role, which bypasses RLS, is refused by the trigger',
    svcEvent?.message?.slice(0, 40));
  const svcSes = await attempt(`update public.ai_sessions set tier = 'A' where id = $1`, [ses.id]);
  check(svcSes !== null, 'a session still cannot be edited by service_role', svcSes?.message?.slice(0, 40));
  const svcUpd = await attempt(`update public.ai_messages set model = 'x'`);
  check(svcUpd !== null, 'and it still cannot rewrite a turn', svcUpd?.message?.slice(0, 40));
}

// ===========================================================================
// PART C — a database that has never seen 064
// ===========================================================================
console.log('\n--- C. 072 without 064: a clean no-op ---------------------------');
{
  const db2 = await freshDatabase({ withLedger: false });
  const before = (await db2.query(
    `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'`)).rows[0].n;
  let err = null;
  try { await db2.exec(migrationSql('072_account_chain_and_session_immutability.sql')); }
  catch (e) { err = e; }
  check(err === null, '072 applies without error against a database that has no events table',
    err?.message?.slice(0, 80));

  const after = (await db2.query(
    `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'`)).rows[0].n;
  check(after === before, 'and creates NOTHING — not one function', `${after - before} added`);
  const [acct] = (await db2.query(
    `select to_regprocedure('public.ledger_append_account(text,uuid,text,text,text,jsonb)') is null as absent`)).rows;
  check(acct.absent === true, 'ledger_append_account is absent, as it must be');
  const [trg] = (await db2.query(`
    select count(*)::int as n from pg_trigger
     where tgname in ('ai_sessions_immutable','ai_messages_immutable')`)).rows;
  check(trg.n === 0, 'and ai_sessions keeps 051\'s behaviour untouched until 064 is pasted', `${trg.n} triggers`);

  // And the product keeps working in that state: the owner UPDATE policy is
  // still there, so assistant-core's session touch is not broken by a file
  // that decided to do nothing.
  const [pol] = (await db2.query(`
    select count(*)::int as n from pg_policies
     where schemaname='public' and tablename='ai_sessions' and cmd='UPDATE'`)).rows;
  check(pol.n === 1, "051's own UPDATE policy is left exactly as it was");
  await db2.close();
}

// ===========================================================================
// PART D — off the database
// ===========================================================================
console.log('\n--- D. lib/ledger.mjs on its own --------------------------------');
{
  const shaped = shapeOnly({
    q: 'a very particular question', limit: 5, full_text: true,
    document_ids: ['a', 'b'], api_key: 'sk-live-xxx', nested: { title: 'Peloso v. Curtis' },
  });
  check(shaped.q.chars === 26 && shaped.limit === 5 && shaped.full_text === true,
    'shapeOnly keeps lengths, numbers and booleans');
  check(shaped.document_ids.items === 2 && shaped.nested.title.chars === 16,
    'and reduces arrays and nested strings to sizes');
  check(shaped.api_key === '[redacted]', 'and redacts a secret-bearing key');
  check(!JSON.stringify(shaped).includes('Peloso'),
    'NO string value survives shapeOnly at any depth — that is the whole difference from redact()');
  check(redact({ q: 'Peloso v. Curtis' }).q === 'Peloso v. Curtis',
    'redact() by contrast keeps a short string, which is why the fan-out does not use it',
    '(#170: search\'s argument is `q`, not `query`, so redact would have stored it verbatim)');

  check(mattersTouchedBy('search', searchResult).size === 2, 'mattersTouchedBy reads a search result');
  check(mattersTouchedBy('list_matters', [{ id: M1 }, { id: M3 }]).size === 0,
    'and does NOT fan out list_matters — it enumerates matters, it does not read from them');
  check(mattersTouchedBy('search', { results: [{ passage_id: 'x' }] }).size === 0,
    'a matter-scoped search result attributes no matter, so it fans out nowhere');

  // 064 pasted, 072 not: the account roll-up is missing, every matter it
  // touched is still recorded. That is the right degradation and it is the
  // state Eden's machine will be in between two pastes.
  _resetWarnings();
  const halfDeployed = {
    rpc: async (fn) => (fn === 'ledger_append_account'
      ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.ledger_append_account in the schema cache' } }
      : { data: { id: 'x', seq: 1, hash: 'h' }, error: null }),
  };
  const half = await recordCrossMatter(halfDeployed, {
    tool: 'search', args: { q: QUERY }, result: searchResult,
    actor: { kind: 'connector', ref: 'cid' }, primaryMatterId: null,
  });
  check(half.account?.notDeployed === true && half.fanout === 2,
    '064 present + 072 absent: the account row is not-deployed, and both matter rows still write');

  _resetWarnings();
  const notDeployed = {
    rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function in the schema cache' } }),
  };
  const none = await recordCrossMatter(notDeployed, {
    tool: 'search', args: { q: QUERY }, result: searchResult,
    actor: { kind: 'connector', ref: 'cid' }, primaryMatterId: null,
  });
  check(none.account?.notDeployed === true && none.fanout === 0,
    'neither deployed: nothing is written, nothing throws — record() degrades exactly as #170 defined');
  check(isNotDeployed({ code: 'PGRST202' }) && !isNotDeployed({ code: '42501' }),
    'and "not deployed" is still distinguished from "refused"');

  const threw = { rpc: async () => { throw new Error('socket hang up'); } };
  const boom = await recordCrossMatter(threw, {
    tool: 'search', args: {}, result: searchResult, primaryMatterId: null,
  });
  check(boom.fanout === 0 && boom.account?.ok === false,
    'a thrown client error is swallowed: the Record is never the reason a tool call fails');

  const inMatter = await recordCrossMatter(notDeployed, {
    tool: 'get_passage', args: { id: 'x' }, result: { text: 'x' }, primaryMatterId: M1,
  });
  check(inMatter.account === null && inMatter.fanout === 0 && inMatter.touched === 0,
    'an ordinary in-matter call writes nothing here at all — #170 already records it');

  const assistantCrossMatter = await recordCrossMatter(notDeployed, {
    tool: 'search', args: { q: QUERY }, result: searchResult, primaryMatterId: M1,
  });
  check(assistantCrossMatter.account === null && assistantCrossMatter.touched === 1,
    'the in-app assistant sitting in M1 and searching everything still gives M3 its row, and no account row',
    'fan-out is keyed off the RESULT, never off the argument');
}

await db.close();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
