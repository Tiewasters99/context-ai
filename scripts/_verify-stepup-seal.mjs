// Execute migration 094 against a real Postgres and prove the sealed-matter
// gate does what S1 says it does — at matter entry and in the search scope —
// and nothing else.
//
// Why this exists
// ---------------------------------------------------------------------------
// docs/specs/SECURITY-BUILD-2026-09-26.md §S1: "second factor required for
// anyone opening sealed material", enforced in the database. The claim is a
// sentence a firm will repeat to a bar questionnaire, so it has to be shown
// from the outside, as a caller: `SET ROLE authenticated` with
// request.jwt.claims set the way PostgREST sets them, against the real
// policy, the real 016/022 helpers and the real 051 tier column.
//
// Seven parts (F and G are the devices list and the two endpoints):
//   A. the negative control — every migration up to 093's shape, NO 094: an
//      aal1 session reads a sealed matter. (If it did not, nothing below
//      would prove 094 is the thing that refuses.) And the JS reads a pre-094
//      account-chain refusal as "not pasted yet", not as a failure.
//   B. 094, twice. The gate: aal1 refused on a sealed matter, on a sealed
//      sub-matter under an open parent, and on an OPEN-tier matter under a
//      sealed one (inherited — even for someone who cannot see the parent);
//      aal2 reads all of them; a connector token stamped by our own server is
//      not gated (the seal governs it); a token with neither is refused
//      (fails closed); the grace for people with no factor, by sign-in time.
//   C. the probe the matter page asks (matter_entry) and the status the
//      banner asks (second_factor_status) — including that the probe is not
//      an oracle for matters the caller is not a member of.
//   D. the search scope: search_passages / search_documents /
//      search_conversations hand their definer core only what the gate
//      allows. THE WITNESS IS THE SCOPE, NOT THE RESULT: each core here is a
//      stub that echoes the matter ids it was handed, so a sealed id that
//      reached a core is visible even if a later filter would have hidden it.
//   E. the Record: every one of the fifteen new kinds is admitted, an unknown
//      one is refused, the JS lists match the database's exactly, the account
//      chain takes auth.stepup and still refuses a matter-bound kind, the
//      actor_ref index exists.
//   F. the devices functions are service-role only and touch only the
//      named account's sessions.
//   G. api/account-sessions.mjs and api/account-factor-event.mjs, driven
//      with fetch stubbed: bearer first, the verified id always, and a
//      factor row only when Supabase Auth's own view agrees.
//
//   npm i --no-save @electric-sql/pglite @electric-sql/pglite-pgvector
//   node scripts/_verify-stepup-seal.mjs
//
// Touches nothing outside this process. No .env, no network, no production.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let PGlite, uuid_ossp, vector;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
  ({ vector } = await import('@electric-sql/pglite-pgvector'));
} catch {
  console.error('Run:  npm i --no-save @electric-sql/pglite @electric-sql/pglite-pgvector');
  process.exit(2);
}

const {
  EVENT_KINDS, ACCOUNT_EVENT_KINDS, KINDS_094, KINDS_100, isAccountKindNotAdmitted, isKindNotAdmitted,
} = await import('../lib/ledger.mjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationSql = (name) =>
  fs.readFileSync(path.resolve(__dirname, '..', 'supabase', 'migrations', name), 'utf8');

// PGlite attaches its bundled source to a thrown error; print the line only.
process.on('uncaughtException', (e) => { console.error(`\n  SQL ERROR: ${e?.message ?? e}\n`); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(`\n  SQL ERROR: ${e?.message ?? e}\n`); process.exit(1); });

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------------------
// A database with the bits of Supabase the migrations assume — the same
// preamble as _verify-ledger-account.mjs, plus auth.jwt(), auth.mfa_factors,
// auth.sessions, pgvector, and three definer "cores" that echo their scope.
// ---------------------------------------------------------------------------
const db = new PGlite({ extensions: { uuid_ossp, vector } });
await db.exec(`
  create extension if not exists vector;
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

  -- Supabase's own definition.
  create or replace function auth.jwt() returns jsonb
  language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
  $$;

  -- The two auth tables 094 reads, with production's column types (the
  -- enums are text here; 094 compares through ::text either way).
  create table auth.mfa_factors (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    friendly_name text,
    factor_type text not null,
    status text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create table auth.sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    factor_id uuid,
    aal text,
    not_after timestamptz,
    refreshed_at timestamp without time zone,
    user_agent text,
    ip inet,
    tag text
  );

  create table public.documents (
    id uuid primary key default gen_random_uuid(), matterspace_id uuid, created_by uuid);
  create table public.passages (
    id uuid primary key default gen_random_uuid(), matterspace_id uuid);
  create table storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  create or replace function storage.foldername(p_name text)
  returns text[] language sql immutable as $$ select string_to_array(p_name, '/') $$;

  grant usage on schema public, auth, storage to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`);
for (const m of ['001_initial_schema.sql', '005_fix_rls_recursion.sql', '008_submatters.sql',
                 '016_matterspace_members.sql', '022_matterspaces_rls_invoker_wrappers.sql',
                 '051_securespace.sql', '064_events_ledger.sql',
                 '072_account_chain_and_session_immutability.sql', '073_completion_requested.sql']) {
  console.log(`  executing supabase/migrations/${m}`);
  await db.exec(migrationSql(m));
}
await db.exec(`
  grant select, insert, update, delete on all tables in schema public
    to anon, authenticated, service_role;`);

// The three cores. Real ones are SECURITY DEFINER and perform NO access check
// (078/081/091 say so in their comments), which is exactly why the stubs are
// definer too and return one row per matter id they were handed: whatever
// reaches them is what would have been searched.
await db.exec(`
  create schema if not exists search_internal;
  create schema if not exists vault_internal;
  create schema if not exists conversations_internal;
  grant usage on schema search_internal, vault_internal, conversations_internal
    to authenticated, service_role;

  create function search_internal.search_passages_core(
    p_matterspace_ids uuid[], p_query_text text, p_query_embedding vector(1024),
    p_doc_types text[] default null, p_witness_names text[] default null,
    p_document_ids uuid[] default null, p_summary_level int default 0,
    p_limit int default 20, p_embedding_model text default 'text-embedding-3-small',
    p_embedding_version int default 1)
  returns table (passage_id uuid, document_id uuid, document_title text, doc_type text,
    page_start int, page_end int, line_start int, line_end int, witness_name text,
    examination_type text, passage_type text, text text, hybrid_score real,
    text_rank real, vector_score real)
  language sql stable security definer set search_path = public as $$
    select gen_random_uuid(), s.id, 'scope witness', null::text, 1, 1, 1, 1,
           null::text, null::text, null::text, 'scope', 0::real, 0::real, 0::real
      from unnest(p_matterspace_ids) s(id)
  $$;

  -- 081's core, as a scope echo. (094 creates the public wrapper when this exists.)
  create function vault_internal.search_documents_core(
    p_matterspace_ids uuid[], p_query text, p_categories text[],
    p_from timestamptz, p_to timestamptz, p_limit int, p_offset int)
  returns table (document_id uuid, title text, source_filename text, matterspace_id uuid,
    matterspace_name text, category text, doc_type text, processing_status text,
    page_count int, file_size_bytes bigint, created_at timestamptz, updated_at timestamptz,
    sealed boolean, rank real)
  language sql stable security definer set search_path = public as $$
    select gen_random_uuid(), 'scope witness', null::text, s.id, null::text, null::text,
           null::text, null::text, 1, 1::bigint, now(), now(), false, 0::real
      from unnest(p_matterspace_ids) s(id)
  $$;

  -- With a NULL scope the real core searches every matter the person can
  -- open, as the owner. The stub does the same over EVERY matter, so a NULL
  -- that reached it unresolved would show the sealed ones.
  create function conversations_internal.search_core(
    p_matterspace_ids uuid[], p_query text, p_limit int, p_for_ai boolean,
    p_grep_pattern text, p_grep_regex boolean, p_grep_case_sensitive boolean)
  returns table (comment_id uuid, conversation_id uuid, conversation_title text,
    matterspace_id uuid, matter_name text, audience text, ai_readable boolean, kind text,
    author_id uuid, author_name text, created_at timestamptz, email_from text, email_to text,
    email_cc text, email_subject text, email_date timestamptz, body text, snippet text, rank real)
  language sql stable security definer set search_path = public as $$
    select gen_random_uuid(), null::uuid, null::text, m.id, m.name, 'matter', true, 'comment',
           null::uuid, null::text, now(), null::text, null::text, null::text, null::text,
           null::timestamptz, 'scope', 'scope', 0::real
      from public.matterspaces m
     where p_matterspace_ids is null or m.id = any(p_matterspace_ids)
  $$;
  grant execute on all functions in schema search_internal, vault_internal, conversations_internal
    to authenticated, service_role;

  -- The public wrappers as 078 / 081 / 091 left them (the parts 094 replaces).
  create function public.search_passages(
    p_matterspace_ids uuid[], p_query_text text, p_query_embedding vector(1024),
    p_doc_types text[] default null, p_witness_names text[] default null,
    p_document_ids uuid[] default null, p_summary_level int default 0,
    p_limit int default 20, p_embedding_model text default 'text-embedding-3-small',
    p_embedding_version int default 1)
  returns table (passage_id uuid, document_id uuid, document_title text, doc_type text,
    page_start int, page_end int, line_start int, line_end int, witness_name text,
    examination_type text, passage_type text, text text, hybrid_score real,
    text_rank real, vector_score real)
  language plpgsql stable as $fn$
  #variable_conflict use_column
  declare
    v_uid uuid := auth.uid();
    v_rls boolean := row_security_active('public.passages');
    v_allowed uuid[];
  begin
    if not v_rls then v_allowed := p_matterspace_ids;
    elsif v_uid is null then return;
    else
      select coalesce(array_agg(m.id), '{}'::uuid[]) into v_allowed
        from unnest(coalesce(p_matterspace_ids, '{}'::uuid[])) as m(id)
       where public.can_access_matter(m.id);
    end if;
    if v_allowed is null or cardinality(v_allowed) = 0 then return; end if;
    return query select * from search_internal.search_passages_core(
      v_allowed, p_query_text, p_query_embedding, p_doc_types, p_witness_names,
      p_document_ids, p_summary_level, p_limit, p_embedding_model, p_embedding_version);
  end $fn$;
  alter table public.passages enable row level security;
  create policy p_sel on public.passages for select using (public.can_access_matter(matterspace_id));
  alter table public.documents enable row level security;
  create policy d_sel on public.documents for select using (public.can_access_matter(matterspace_id));
`);
console.log('  schema, roles, RLS, and scope-echoing search cores in place');

const q = async (sql, params) => (await db.query(sql, params)).rows;
const attempt = async (sql, params) => {
  try { await db.query(sql, params); return null; } catch (err) { return err; }
};

// ---------------------------------------------------------------------------
// Who is asking. PostgREST sets request.jwt.claims; these are the four shapes
// a claim set can take here.
// ---------------------------------------------------------------------------
const epoch = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const BEFORE_DATE = '2026-10-01T12:00:00Z';   // signed in during the grace
const AFTER_DATE = '2026-10-20T12:00:00Z';    // signed in after it ended

const setClaims = async (claims) => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec('set role authenticated');
};
// A Supabase Auth browser session: always carries aal, session_id and amr.
const asBrowser = (uid, aal, signedIn = BEFORE_DATE) => setClaims({
  sub: uid, role: 'authenticated', aal, session_id: '5e551011-0000-4000-8000-000000000001',
  amr: [{ method: 'password', timestamp: epoch(signedIn) }],
});
// lib/supabase-user-jwt.mjs's minted token, as it now reads.
const asConnector = (uid) => setClaims({ sub: uid, role: 'authenticated', aud: 'authenticated', cs_via: 'connector' });
// Neither: no aal, no stamp. Must be gated.
const asBare = (uid) => setClaims({ sub: uid, role: 'authenticated' });
const asService = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  await db.exec('set role service_role');
};
const asSuperuser = async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
};

const visible = async () => new Set((await q('select id from public.matterspaces')).map((r) => r.id));

// ---------------------------------------------------------------------------
// The firm. A fictional dispute; no client names.
// ---------------------------------------------------------------------------
console.log('\n--- a firm ------------------------------------------------------');
await asSuperuser();
const signup = async (email) => (await q(
  `insert into auth.users (email) values ($1) returning id`, [email]))[0].id;
const ADA = await signup('ada@example.test');    // owns the serverspace; has a factor
const DAN = await signup('dan@example.test');    // member of the open parent only; has a factor
const EVE = await signup('eve@example.test');    // member of the sealed matter; NO factor
const FRAN = await signup('fran@example.test');  // member of the sealed matter's child only; has a factor
const BOB = await signup('bob@example.test');    // a stranger

const [space] = await q(
  `insert into public.serverspaces (clientspace_id, name)
   select id, 'Fixture Law' from public.clientspaces where user_id = $1 returning id`, [ADA]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner')`, [space.id, ADA]);
const matter = async (name, parent = null, tier = 'A') => {
  const [m] = await q(
    `insert into public.matterspaces (serverspace_id, name, parent_matterspace_id, ai_tier)
     values ($1,$2,$3,$4) returning id`, [space.id, name, parent, tier]);
  return m.id;
};
const OPEN = await matter('Vashti v. Ormsby');
const SEALED = await matter('Ormsby privileged', null, 'B');
const SEALED_KID = await matter('Ormsby privileged / memos', SEALED, 'A');    // open tier, sealed by inheritance
const PARENT = await matter('Calder v. Atlas');
const OPEN_CHILD = await matter('Calder / pleadings', PARENT);
const SEALED_CHILD = await matter('Calder / advice', PARENT, 'C');              // sealed room in an open building
const ALL = [OPEN, SEALED, SEALED_KID, PARENT, OPEN_CHILD, SEALED_CHILD];
const SEALED_SET = [SEALED, SEALED_KID, SEALED_CHILD];
const name = { [OPEN]: 'OPEN', [SEALED]: 'SEALED', [SEALED_KID]: 'SEALED_KID', [PARENT]: 'PARENT',
  [OPEN_CHILD]: 'OPEN_CHILD', [SEALED_CHILD]: 'SEALED_CHILD' };
const names = (ids) => [...ids].map((i) => name[i] ?? i.slice(0, 8)).sort().join(' ') || '(none)';

await q(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,'member')`, [PARENT, DAN]);
await q(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,'member')`, [SEALED, EVE]);
await q(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,'member')`, [SEALED_KID, FRAN]);
for (const u of [ADA, DAN, FRAN]) {
  await q(`insert into auth.mfa_factors (user_id, friendly_name, factor_type, status)
           values ($1, 'Phone', 'totp', 'verified')`, [u]);
}
// An unverified factor is not a factor: EVE started enrolling and stopped.
await q(`insert into auth.mfa_factors (user_id, friendly_name, factor_type, status)
         values ($1, 'Phone', 'totp', 'unverified')`, [EVE]);
console.log('  Ada owns it; Dan is on the open parent; Eve on the sealed matter (no factor);');
console.log('  Fran on the sealed matter\'s open-tier child only; Bob is a stranger');

// ===========================================================================
console.log('\n--- A. negative control: no 094 ----------------------------------');
// ===========================================================================
{
  await asBrowser(ADA, 'aal1');
  const seen = await visible();
  check(SEALED_SET.every((id) => seen.has(id)),
    'WITHOUT 094 an aal1 session reads every sealed matter', names(seen));

  // The JS half of "merging before pasting is safe": 072's account list
  // refuses auth.stepup with 22023, and lib/ledger.mjs must read that as
  // "094 is not pasted", not as a failed write.
  const pre = await attempt(`select public.ledger_append_account(p_kind := 'auth.stepup')`);
  check(pre !== null && String(pre.code) === '22023', "before 094 the account chain refuses 'auth.stepup'",
    pre ? `${pre.code}` : 'accepted');
  check(isAccountKindNotAdmitted(pre, 'auth.stepup'),
    'and lib/ledger.mjs classifies that as not-deployed');
  check(!isAccountKindNotAdmitted(pre, 'completion.received'),
    'but never for a kind 094 does not add');
  await asSuperuser();
  await db.exec(`set contextspaces.ledger_writing = 'on'`);
  const preKind = await attempt(
    `insert into public.events (chain_key, seq, kind, actor_kind, actor_ref, payload, prev_hash, hash)
     values ('00000000-0000-0000-0000-000000000000', 9999, 'file.opened', 'user', 'u', '{}'::jsonb, '', 'h')`);
  await db.exec(`set contextspaces.ledger_writing = 'off'`);
  check(preKind !== null && String(preKind.code) === '23514' && isKindNotAdmitted(preKind, 'file.opened'),
    "before 094 events_kind_check refuses 'file.opened', read as not-deployed");
}

// ===========================================================================
console.log('\n--- B. 094, applied twice ------------------------------------------');
// ===========================================================================
await asSuperuser();
for (const pass of [1, 2]) {
  console.log(`  executing supabase/migrations/094_security_kinds_and_stepup.sql (pass ${pass})`);
  await db.exec(migrationSql('094_security_kinds_and_stepup.sql'));
}
check(true, '094 runs twice end to end');

{
  await asBrowser(ADA, 'aal1');
  const seen = await visible();
  check(seen.has(OPEN) && seen.has(PARENT) && seen.has(OPEN_CHILD),
    'aal1: the owner reads every open matter', names(seen));
  check(!seen.has(SEALED), 'aal1: the owner is REFUSED the sealed matter');
  check(!seen.has(SEALED_CHILD), 'aal1: a sealed sub-matter under an open parent is refused');
  check(!seen.has(SEALED_KID), 'aal1: an open-tier matter under a sealed one is refused (inherited)');

  await asBrowser(ADA, 'aal2');
  const seen2 = await visible();
  check(ALL.every((id) => seen2.has(id)), 'aal2: the owner reads all six', names(seen2));

  await asBrowser(DAN, 'aal1');
  const dan1 = await visible();
  check(dan1.has(PARENT) && dan1.has(OPEN_CHILD) && !dan1.has(SEALED_CHILD),
    'aal1: a member of the open parent reads it and its open child, not the sealed child', names(dan1));
  await asBrowser(DAN, 'aal2');
  const dan2 = await visible();
  check(dan2.has(SEALED_CHILD) && !dan2.has(SEALED),
    'aal2: and then the sealed child too — but still nothing outside his membership', names(dan2));

  // Fran is a member of SEALED_KID only. She cannot see SEALED, so a walk
  // that ran under her own RLS would find no sealed ancestor and let her in.
  await asBrowser(FRAN, 'aal1');
  const fran1 = await visible();
  check(!fran1.has(SEALED_KID), 'aal1: the inherited seal holds even when the sealed parent is invisible to the caller',
    names(fran1));
  await asBrowser(FRAN, 'aal2');
  const fran2 = await visible();
  check(fran2.has(SEALED_KID) && !fran2.has(SEALED), 'aal2: Fran reads her matter, and still not its parent', names(fran2));

  await asConnector(ADA);
  const conn = await visible();
  check(ALL.every((id) => conn.has(id)),
    'a token our server minted for a connector is NOT gated (the seal governs connectors)', names(conn));

  await asBare(ADA);
  const bare = await visible();
  check(!bare.has(SEALED) && !bare.has(SEALED_CHILD) && bare.has(OPEN),
    'a token with neither aal2 nor the connector stamp is gated — it fails closed', names(bare));

  await asBrowser(BOB, 'aal2');
  const bob = await visible();
  check(bob.size === 0, 'aal2 opens nothing that membership does not: a stranger still reads none', names(bob));

  // E2's grace: Eve has no verified factor.
  await asBrowser(EVE, 'aal1', BEFORE_DATE);
  const eveBefore = await visible();
  check(eveBefore.has(SEALED) && eveBefore.has(SEALED_KID),
    'grace: someone with NO factor, signed in before the date, still reads her sealed matter', names(eveBefore));
  await asBrowser(EVE, 'aal1', AFTER_DATE);
  const eveAfter = await visible();
  check(!eveAfter.has(SEALED),
    'grace over: the same person, signed in after the date, is refused', names(eveAfter));
  const [{ d }] = await q(`select public.second_factor_required_from()::text as d`);
  check(d.startsWith('2026-10-1'), 'the date lives in one function', d);

  // Service role is not an RLS subject and must stay that way.
  await asService();
  const svc = await visible();
  check(ALL.every((id) => svc.has(id)), 'service_role (the worker) is untouched', names(svc));
}

// ===========================================================================
console.log('\n--- C. the probe and the status -----------------------------------');
// ===========================================================================
{
  const entry = async (id) => (await q(`select public.matter_entry($1) as e`, [id]))[0].e;
  await asBrowser(ADA, 'aal1');
  check(await entry(SEALED) === 'stepup', "aal1 owner, sealed matter → 'stepup'");
  check(await entry(SEALED_CHILD) === 'stepup', "aal1 owner, sealed child → 'stepup'");
  check(await entry(OPEN) === 'open', "aal1 owner, open matter → 'open'");
  check(await entry('00000000-0000-4000-8000-00000000dead') === 'none', "no such matter → 'none'");
  await asBrowser(ADA, 'aal2');
  check(await entry(SEALED) === 'open', "aal2 owner, sealed matter → 'open'");
  await asBrowser(BOB, 'aal1');
  check(await entry(SEALED) === 'none',
    "a stranger asking about a sealed matter → 'none' (not an oracle for which matters are sealed)");
  await asBrowser(EVE, 'aal1', AFTER_DATE);
  check(await entry(SEALED) === 'enrol', "no factor, after the date → 'enrol'");

  const status = async () => (await q(`select public.second_factor_status() as s`))[0].s;
  await asBrowser(ADA, 'aal1');
  const a1 = await status();
  check(a1.required === true && a1.has_factor === true && a1.sealed_waiting === true && a1.aal2 === false,
    'status, owner at aal1: required, has a factor, sealed matters waiting', JSON.stringify(a1));
  await asBrowser(ADA, 'aal2');
  const a2 = await status();
  check(a2.sealed_waiting === false && a2.aal2 === true, 'status, owner at aal2: nothing waiting');
  await asBrowser(FRAN, 'aal1');
  const f1 = await status();
  check(f1.required === true, 'status: a member of a sealed matter\'s child is required to enrol (reaches the seal)');
  await asBrowser(DAN, 'aal1');
  const d1 = await status();
  check(d1.required === true, 'status: so is a member of an open parent that holds a sealed child');
  await asBrowser(EVE, 'aal1');
  const e1 = await status();
  check(e1.has_factor === false && e1.required === true, 'status: an unverified factor is not a factor');
  await asBrowser(BOB, 'aal1');
  const b1 = await status();
  check(b1.required === false && b1.sealed_waiting === false, 'status: a stranger is offered, not required');
}

// ===========================================================================
console.log('\n--- D. the search scope ---------------------------------------------');
// ===========================================================================
{
  const zero = `'[${Array(1024).fill(0).join(',')}]'::vector`;
  const passagesScope = async (ids) => new Set((await q(
    `select document_id from public.search_passages($1::uuid[], 'x', ${zero})`, [ids])).map((r) => r.document_id));
  const documentsScope = async (ids) => new Set((await q(
    `select matterspace_id from public.search_documents('x', $1::uuid[])`, [ids])).map((r) => r.matterspace_id));
  const conversationsScope = async (ids) => new Set((await q(
    `select matterspace_id from public.search_conversations($1::uuid[], 'x')`, [ids])).map((r) => r.matterspace_id));

  await asBrowser(ADA, 'aal1');
  const p1 = await passagesScope(ALL);
  check(!SEALED_SET.some((id) => p1.has(id)) && p1.has(OPEN) && p1.has(OPEN_CHILD),
    'search_passages at aal1: no sealed matter reaches the core', names(p1));
  const d1 = await documentsScope(ALL);
  check(!SEALED_SET.some((id) => d1.has(id)) && d1.has(OPEN),
    'search_documents at aal1, named scope: no sealed matter reaches the core', names(d1));
  const dn = await documentsScope(null);
  check(!SEALED_SET.some((id) => dn.has(id)) && dn.has(OPEN),
    'search_documents at aal1, "everywhere": no sealed matter reaches the core', names(dn));
  const c1 = await conversationsScope(null);
  check(!SEALED_SET.some((id) => c1.has(id)) && c1.has(OPEN),
    'search_conversations at aal1, "everywhere": the NULL is resolved before the core', names(c1));
  const c1n = await conversationsScope([SEALED, OPEN]);
  check(!c1n.has(SEALED) && c1n.has(OPEN), 'search_conversations at aal1, named scope: sealed dropped', names(c1n));

  await asBrowser(ADA, 'aal2');
  const p2 = await passagesScope(ALL);
  check(ALL.every((id) => p2.has(id)), 'search_passages at aal2: all six', names(p2));
  const d2 = await documentsScope(ALL);
  check(ALL.every((id) => d2.has(id)), 'search_documents at aal2: all six', names(d2));
  const c2 = await conversationsScope(null);
  check(SEALED_SET.every((id) => c2.has(id)), 'search_conversations at aal2: sealed included', names(c2));

  await asConnector(ADA);
  const pc = await passagesScope(ALL);
  check(ALL.every((id) => pc.has(id)),
    'search_passages for a stamped connector token: ungated here (mcp-core\'s seal filters it first)', names(pc));

  await asBrowser(BOB, 'aal2');
  const pb = await passagesScope(ALL);
  check(pb.size === 0, 'search_passages for a stranger: nothing, at any aal');

  await asService();
  const ps = await passagesScope(ALL);
  check(ALL.every((id) => ps.has(id)), 'search_passages as service_role: scope passes through as before');

  // The rule sits in the scope check, not on passages: the passages policy is
  // still exactly the one line 002/016 gave it.
  await asSuperuser();
  const [pol] = await q(`select qual from pg_policies where tablename = 'passages' and policyname = 'p_sel'`);
  check(!/sealed|aal/i.test(pol?.qual ?? ''), 'no per-row clause was added to passages', pol?.qual ?? '');
}

// ===========================================================================
console.log('\n--- E. the Record ---------------------------------------------------');
// ===========================================================================
{
  await asSuperuser();
  const [def] = await q(
    `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'events_kind_check'`);
  const dbKinds = [...String(def.def).matchAll(/'([a-z]+\.[a-z_]+)'/g)].map((m) => m[1]);
  const specKinds = [
    'auth.factor_enrolled', 'auth.factor_unenrolled', 'auth.stepup', 'auth.new_device',
    'account.locked', 'account.unlocked', 'matter.disconnected',
    'file.filed', 'file.integrity', 'file.opened', 'file.flagged',
    'share.expired', 'share.reviewed', 'tripwire.tripped', 'tripwire.cleared',
  ];
  check(specKinds.every((k) => dbKinds.includes(k)), 'the constraint admits all fifteen of spec §3',
    specKinds.filter((k) => !dbKinds.includes(k)).join(' ') || '15/15');
  check(KINDS_094.length === 15 && specKinds.every((k) => KINDS_094.includes(k)),
    'KINDS_094 in lib/ledger.mjs is the same fifteen');
  // Through 094: this database never sees 100, whose three kinds (the Brief
  // Desk) scripts/_verify-brief-md-roundtrip.mjs holds to the constraint.
  const through094 = EVENT_KINDS.filter((k) => !KINDS_100.includes(k));
  check(dbKinds.length === through094.length && through094.every((k) => dbKinds.includes(k)),
    'EVENT_KINDS (through 094) and the constraint are the same list — never a subset either way', `${dbKinds.length} kinds`);

  // Every new kind lands, through the real append path, on a matter.
  await asBrowser(ADA, 'aal2');
  let landed = 0;
  for (const k of specKinds) {
    const err = await attempt(
      `select public.ledger_append(p_kind := $1, p_matter := $2, p_actor_kind := 'user', p_actor_ref := $3)`,
      [k, OPEN, ADA]);
    if (err) console.log(`        ${k}: ${err.message}`);
    else landed += 1;
  }
  check(landed === 15, 'ledger_append accepts each of the fifteen', `${landed}/15`);
  const unknown = await attempt(
    `select public.ledger_append(p_kind := 'auth.nonsense', p_matter := $1)`, [OPEN]);
  check(unknown !== null, 'and refuses a kind nobody defined', unknown?.message?.slice(0, 70));

  // The sealed gate reaches the append path too: at aal1 a sealed matter is
  // not visible, so nothing can be written into its Record by that session.
  await asBrowser(ADA, 'aal1');
  const sealedWrite = await attempt(
    `select public.ledger_append(p_kind := 'tool.invoked', p_matter := $1)`, [SEALED]);
  check(sealedWrite !== null && String(sealedWrite.code) === '42501',
    'at aal1 a write into a sealed matter\'s Record is refused like the read', sealedWrite?.code ?? 'accepted');

  // The account chain.
  const [acct] = await q(`select public.ledger_append_account(p_kind := 'auth.stepup',
    p_actor_ref := $1, p_payload := '{"factor_type":"totp"}'::jsonb) as r`, [ADA]);
  check(acct.r?.chain_key === ADA, 'auth.stepup lands on the person\'s own account chain', acct.r?.chain_key);
  for (const k of ['auth.factor_enrolled', 'auth.factor_unenrolled']) {
    const e = await attempt(`select public.ledger_append_account(p_kind := $1)`, [k]);
    check(e === null, `${k} is account-legal`, e?.message ?? '');
  }
  const matterBound = await attempt(`select public.ledger_append_account(p_kind := 'file.opened')`);
  check(matterBound !== null && String(matterBound.code) === '22023',
    'file.opened is still refused on an account chain (matter-bound)');
  const stillBound = await attempt(`select public.ledger_append_account(p_kind := 'completion.received')`);
  check(stillBound !== null, 'and completion.received still is');

  await asSuperuser();
  const [fn] = await q(`select pg_get_functiondef('public._ledger_append_account_checked(text,uuid,text,text,text,jsonb)'::regprocedure) as d`);
  const listed = String(fn.d).match(/not in \(([\s\S]*?)\)/)?.[1] ?? '';
  const sqlAccount = [...listed.matchAll(/'([a-z]+\.[a-z_]+)'/g)].map((m) => m[1]);
  check(sqlAccount.length === ACCOUNT_EVENT_KINDS.length && ACCOUNT_EVENT_KINDS.every((k) => sqlAccount.includes(k)),
    'ACCOUNT_EVENT_KINDS and the database\'s account-legal list are the same list', `${sqlAccount.length} kinds`);

  const [idx] = await q(`select indexdef from pg_indexes where indexname = 'events_actor_ref_ts_idx'`);
  check(/\(actor_ref, ts DESC\)/.test(idx?.indexdef ?? ''), 'index events (actor_ref, ts desc) exists', idx?.indexdef ?? 'missing');
}

// ===========================================================================
console.log('\n--- F. devices: service role only -------------------------------------');
// ===========================================================================
{
  await asSuperuser();
  const [s1] = await q(`insert into auth.sessions (user_id, aal, user_agent, ip, refreshed_at)
    values ($1, 'aal1', 'Mozilla/5.0 (iPhone)', '203.0.113.7', now() at time zone 'UTC') returning id`, [ADA]);
  const [s2] = await q(`insert into auth.sessions (user_id, aal, user_agent, ip)
    values ($1, 'aal2', 'Mozilla/5.0 (Windows NT 10.0)', '198.51.100.4') returning id`, [ADA]);
  const [sb] = await q(`insert into auth.sessions (user_id, aal, user_agent, ip)
    values ($1, 'aal1', 'curl', '192.0.2.1') returning id`, [BOB]);

  await asBrowser(ADA, 'aal2');
  const denied = await attempt(`select * from public.account_sessions($1)`, [ADA]);
  check(denied !== null, 'a signed-in browser cannot call account_sessions, even for itself',
    denied?.message?.slice(0, 50));
  const denied2 = await attempt(`select public.account_session_revoke($1, $2)`, [ADA, s1.id]);
  check(denied2 !== null, 'nor account_session_revoke');

  await asService();
  const rows = await q(`select * from public.account_sessions($1)`, [ADA]);
  check(rows.length === 2 && rows.every((r) => r.ip && r.user_agent), 'service_role lists the account\'s own sessions',
    rows.map((r) => `${r.ip} ${r.aal}`).join(', '));
  const [{ ok: wrong }] = await q(`select public.account_session_revoke($1, $2) as ok`, [ADA, sb.id]);
  check(wrong === false, 'revoking another person\'s session id under your own user id does nothing');
  const [{ ok: right }] = await q(`select public.account_session_revoke($1, $2) as ok`, [ADA, s1.id]);
  check(right === true, 'revoking your own session removes it');
  const left = await q(`select id from public.account_sessions($1)`, [ADA]);
  check(left.length === 1 && left[0].id === s2.id, 'and leaves the others');
}

// ===========================================================================
console.log('\n--- G. the two endpoints, offline --------------------------------------');
// ===========================================================================
// The real handlers, with fetch replaced by a stand-in for Supabase Auth and
// PostgREST. What is being held: the bearer is checked first, the user id
// sent to the service-role functions is the one Supabase Auth returned (never
// one the browser named), the current session cannot be signed out here, and
// a factor event is written only when Supabase Auth's own view agrees.
{
  process.env.VITE_SUPABASE_URL = 'https://fixture.supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'anon-fixture';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-fixture';
  const { default: sessionsHandler } = await import('../api/account-sessions.mjs');
  const { default: factorHandler } = await import('../api/account-factor-event.mjs');

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = (claims) => `${b64({ alg: 'ES256' })}.${b64(claims)}.sig`;
  const CURRENT = '5e551011-0000-4000-8000-00000000c0de';
  const OTHER = '5e551011-0000-4000-8000-00000000beef';
  const FACTOR = 'fac70000-0000-4000-8000-000000000001';
  const good = token({ sub: ADA, aal: 'aal1', session_id: CURRENT });
  const stepped = token({ sub: ADA, aal: 'aal2', session_id: CURRENT,
    amr: [{ method: 'password', timestamp: 1 }, { method: 'totp', timestamp: 2 }] });

  let factors = [{ id: FACTOR, status: 'verified', factor_type: 'totp' }];
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const auth = init.headers?.authorization ?? '';
    calls.push({ u, body: init.body ? JSON.parse(init.body) : null, auth });
    if (u.endsWith('/auth/v1/user')) {
      if (auth !== `Bearer ${good}` && auth !== `Bearer ${stepped}`) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ id: ADA, email: 'ada@example.test', factors }), { status: 200 });
    }
    if (u.endsWith('/rest/v1/rpc/account_sessions')) {
      return new Response(JSON.stringify([
        { id: CURRENT, user_agent: 'Mozilla/5.0 (Macintosh) Safari/605.1', ip: '203.0.113.7', aal: 'aal1', refreshed_at: '2026-09-26T10:00:00Z' },
        { id: OTHER, user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/140', ip: '198.51.100.4', aal: 'aal2', refreshed_at: '2026-09-20T10:00:00Z' },
      ]), { status: 200 });
    }
    if (u.endsWith('/rest/v1/rpc/account_session_revoke')) return new Response('true', { status: 200 });
    throw new Error(`unexpected fetch ${u}`);
  };
  const run = async (handler, { method = 'GET', bearer = null, body = undefined, deps = {} } = {}) => {
    const out = { status: 0, body: null };
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(text) { out.status = this.statusCode; out.body = text ? JSON.parse(text) : null; },
    };
    const req = { method, headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, body };
    await handler(req, res, { fetchImpl, ...deps });
    return out;
  };

  const none = await run(sessionsHandler);
  check(none.status === 401, 'devices: no bearer → 401');
  const forged = await run(sessionsHandler, { bearer: token({ sub: BOB, session_id: OTHER }) });
  check(forged.status === 401, 'devices: a token Supabase Auth does not accept → 401 (claims are not trusted on their own)');

  calls.length = 0;
  const list = await run(sessionsHandler, { bearer: good });
  const rpc = calls.find((c) => c.u.endsWith('/account_sessions'));
  check(list.status === 200 && list.body.sessions.length === 2, 'devices: lists the account\'s sessions');
  check(rpc?.body?.p_user === ADA && rpc.auth === 'Bearer service-fixture',
    'devices: the service-role call carries the id Supabase Auth returned');
  check(list.body.sessions.find((s) => s.id === CURRENT)?.current === true
    && list.body.sessions.find((s) => s.id === OTHER)?.current === false,
    'devices: the session the request came from is marked current');
  check(list.body.sessions.find((s) => s.id === OTHER)?.device === 'Chrome on Windows',
    'devices: the user agent is named in words', list.body.sessions.map((s) => s.device).join(', '));

  const self = await run(sessionsHandler, { method: 'POST', bearer: good, body: { session_id: CURRENT } });
  check(self.status === 400 && self.body.error === 'current_session', 'devices: this device cannot be signed out here');
  calls.length = 0;
  const other = await run(sessionsHandler, { method: 'POST', bearer: good, body: { session_id: OTHER, p_user: BOB } });
  const rev = calls.find((c) => c.u.endsWith('/account_session_revoke'));
  check(other.status === 200 && other.body.signed_out === true, 'devices: another device is signed out');
  check(rev?.body?.p_user === ADA, 'devices: a p_user in the body is ignored — the verified id is used');

  // Factor events: a fake ledger client records what would have been written.
  const written = [];
  const ledgerClient = { async rpc(fn, args) { written.push({ fn, args }); return { data: { id: 'e1' }, error: null }; } };
  const report = (bearer, body) => run(factorHandler, { method: 'POST', bearer, body, deps: { ledgerClient } });

  const enrolled = await report(good, { kind: 'auth.factor_enrolled', factor_id: FACTOR });
  check(enrolled.status === 200 && written.at(-1)?.args?.p_kind === 'auth.factor_enrolled'
    && written.at(-1)?.fn === 'ledger_append_account',
    'factor: an enrolment Supabase Auth confirms is written to the account chain');
  const n = written.length;
  const bogus = await report(good, { kind: 'auth.factor_enrolled', factor_id: 'fac70000-0000-4000-8000-0000000000ff' });
  check(bogus.status === 409 && written.length === n, 'factor: an enrolment Supabase Auth does not show is refused, nothing written');
  const stillThere = await report(good, { kind: 'auth.factor_unenrolled', factor_id: FACTOR });
  check(stillThere.status === 409 && written.length === n, 'factor: a removal of a factor still on the account is refused');
  factors = [];
  const removed = await report(good, { kind: 'auth.factor_unenrolled', factor_id: FACTOR, factor_type: 'totp' });
  check(removed.status === 200 && written.at(-1)?.args?.p_kind === 'auth.factor_unenrolled',
    'factor: a real removal is written');
  const notStepped = await report(good, { kind: 'auth.stepup', matter_id: SEALED });
  check(notStepped.status === 409, 'factor: a step-up claimed by an aal1 token is refused');
  const step = await report(stepped, { kind: 'auth.stepup', matter_id: SEALED });
  check(step.status === 200 && written.at(-1)?.args?.p_kind === 'auth.stepup'
    && written.at(-1)?.args?.p_payload?.factor_type === 'totp'
    && written.at(-1)?.args?.p_payload?.matter_id === SEALED,
    'factor: a step-up on an aal2 token is written, with the method from amr', JSON.stringify(written.at(-1)?.args?.p_payload));
  const junk = await report(good, { kind: 'file.opened' });
  check(junk.status === 400, 'factor: any other kind is refused before anything is asked');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
