// Execute 074, then 078, against a real Postgres with real pgvector, real RLS,
// the real policy function, and real `anon` / `authenticated` roles — and hold
// 078 to the only promise that matters: it moves WHERE the access check is
// asked, never WHAT it answers.
//
// Why this shape
// ---------------------------------------------------------------------------
// 078 makes a SECURITY DEFINER function do the searching, which means the
// policy on `passages` no longer runs inside it. A harness that runs as the
// superuser cannot see the difference between that being safe and that being a
// data leak, because RLS never applied to it in the first place. So this one
// creates the two PostgREST roles for real, enables RLS for real, installs
// `can_access_matter` / `matter_role` / `matter_ancestry` exactly as production
// has them, and does every assertion from inside `SET ROLE authenticated` with
// `request.jwt.claims` set the way PostgREST sets it.
//
// The reference is 074 UNDER RLS. 074 is slow for an authenticated caller but
// it is correct, so "078 returns what 074 returned, byte for byte, for the
// same caller" is the whole correctness argument, and the rest of the file is
// about the caller it must return NOTHING for.
//
//   npm i --no-save @electric-sql/pglite @electric-sql/pglite-pgvector
//   node scripts/_verify-search-rls-authorize.mjs
//
// No .env, no network, no prod.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let PGlite, vector;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ vector } = await import('@electric-sql/pglite-pgvector'));
} catch {
  console.error('Run:  npm i --no-save @electric-sql/pglite @electric-sql/pglite-pgvector');
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = (name) => path.resolve(__dirname, '..', 'supabase', 'migrations', name);
const migration = (name) => {
  console.log(`  executing ${path.relative(process.cwd(), migrationPath(name))}`);
  return fs.readFileSync(migrationPath(name), 'utf8');
};

// PGlite attaches its whole bundled module source to a thrown error, which
// turns one bad statement into a megabyte of unreadable CI log. Print the line
// that matters and nothing else.
process.on('uncaughtException', (e) => {
  console.error(`\n  SQL ERROR: ${e?.message ?? e}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(`\n  SQL ERROR: ${e?.message ?? e}\n`);
  process.exit(1);
});

const db = new PGlite({ extensions: { vector } });
const q = async (sql, params) => (await db.query(sql, params)).rows;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------------------
// Schema: enough of 002/005/016/022 that the real policy can run.
// ---------------------------------------------------------------------------
console.log('\n--- schema, roles, RLS ---------------------------------------');
await db.exec(`
  create extension if not exists vector;
  create schema if not exists auth;

  create role anon;
  create role authenticated;
  -- BYPASSRLS, exactly as production has it: this is the caller 078 must not
  -- start enforcing RLS on.
  create role service_role bypassrls;

  create table public.serverspaces (id uuid primary key default gen_random_uuid(), name text);
  create table public.matterspaces (
    id uuid primary key default gen_random_uuid(),
    serverspace_id uuid,
    parent_matterspace_id uuid,
    name text
  );
  create table public.serverspace_members (
    serverspace_id uuid, user_id uuid, role text, primary key (serverspace_id, user_id));
  create table public.matterspace_members (
    matterspace_id uuid, user_id uuid, role text, primary key (matterspace_id, user_id));
  create table public.documents (
    id uuid primary key default gen_random_uuid(),
    matterspace_id uuid, title text, doc_type text
  );
  create table public.passages (
    id uuid primary key default gen_random_uuid(),
    document_id uuid references public.documents(id) on delete cascade,
    matterspace_id uuid,
    sequence_number int,
    page_start int, page_end int, line_start int, line_end int,
    witness_name text, examination_type text, speaker text,
    text text not null,
    passage_type text,
    embedding vector(1024),
    tsv tsvector generated always as (to_tsvector('english', text)) stored,
    summary_level int not null default 0,
    embedding_model text not null default 'text-embedding-3-small',
    embedding_version int not null default 1
  );
  create index idx_passages_tsv on public.passages using gin(tsv);
  create index idx_passages_embedding_hnsw
    on public.passages using hnsw (embedding vector_cosine_ops);
  create index idx_passages_matterspace_level
    on public.passages(matterspace_id, summary_level);
  create index idx_passages_document_seq
    on public.passages(document_id, sequence_number);
`);

// auth.uid(), and the three access functions, transcribed from production's
// pg_proc (they are schema, not content).
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

  create function public.matterspace_descendants(p_root uuid)
  returns table(id uuid) language sql stable as $fn$
    with recursive tree as (
      select m.id from public.matterspaces m where m.id = p_root
      union all
      select c.id from public.matterspaces c join tree t on c.parent_matterspace_id = t.id
    )
    select id from tree;
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

  alter table public.passages  enable row level security;
  alter table public.documents enable row level security;
  create policy p_sel on public.passages  for select using (can_access_matter(matterspace_id));
  create policy d_sel on public.documents for select using (can_access_matter(matterspace_id));

  grant usage on schema public to anon, authenticated, service_role;
  grant select on all tables in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`);
console.log('  real pgvector, real RLS, real anon/authenticated roles');

// ---------------------------------------------------------------------------
// Corpus. One serverspace the test user owns, one they have nothing to do with.
// ---------------------------------------------------------------------------
console.log('\n--- corpus ---------------------------------------------------');
const OPENAI = 'text-embedding-3-small';
const DIM = 1024;
const vec = (head) => `[${[head, ...Array(DIM - 1).fill(0.05)].join(',')}]`;
const QUERY_VEC = vec(1.0);
const USER = '4b9d1b0e-0000-4000-8000-00000000beef';
const OTHER = '4b9d1b0e-0000-4000-8000-0000000000aa';

const one = async (sql, params) => (await q(sql, params))[0];
const mkServer = async (name) =>
  (await one(`insert into public.serverspaces (name) values ($1) returning id`, [name])).id;
const mkMatter = async (ss, name) =>
  (await one(`insert into public.matterspaces (serverspace_id, name) values ($1,$2) returning id`, [ss, name])).id;
const mkDoc = async (m, title, type) =>
  (await one(`insert into public.documents (matterspace_id, title, doc_type) values ($1,$2,$3) returning id`, [m, title, type])).id;
const addP = (doc, m, seq, text, head, witness = null) => q(
  `insert into public.passages
     (document_id, matterspace_id, sequence_number, page_start, page_end,
      line_start, line_end, text, passage_type, embedding, embedding_model, witness_name)
   values ($1,$2,$3,$4,$4,1,5,$5,'paragraph',$6,$7,$8)`,
  [doc, m, seq, seq, text, head === null ? null : vec(head), OPENAI, witness]);

const ssMine = await mkServer('Quainton Law');
const ssTheirs = await mkServer('Someone Else LLP');
await q(`insert into public.serverspace_members values ($1,$2,'owner')`, [ssMine, USER]);
await q(`insert into public.serverspace_members values ($1,$2,'owner')`, [ssTheirs, OTHER]);

const mOpen = await mkMatter(ssMine, 'Vashti v. Ormsby');
const mBulk = await mkMatter(ssMine, 'Vashti v. Ormsby — Production');
const mSealed = await mkMatter(ssMine, 'Vashti v. Ormsby — sealed annex');
const mForbidden = await mkMatter(ssTheirs, 'Not our matter');

const dOpen = await mkDoc(mOpen, 'Correspondence', 'other');
const dWit = await mkDoc(mOpen, 'Deposition of Ormsby', 'deposition');
const dBulk = await mkDoc(mBulk, 'Production volume 1', 'other');
const dSealed = await mkDoc(mSealed, 'Annex', 'other');
const dForbidden = await mkDoc(mForbidden, 'Their annex', 'other');

for (let i = 0; i < 20; i++) {
  await addP(dOpen, mOpen, i + 1,
    `Ormsby letter ${i + 1}: the receipt was never produced and the dispute turns on it.`,
    0.95 - i * 0.02);
}
await addP(dOpen, mOpen, 21, 'Ormsby produced no acknowledgement of any kind.', null);
await addP(dWit, mOpen, 22, 'Q. Did Ormsby receive the letter? A. He did not.', 0.30, 'Ormsby');
await addP(dWit, mOpen, 23, 'Q. And the receipt? A. There is no receipt in evidence.', 0.28, 'Ormsby');
for (let i = 0; i < 300; i++) {
  await addP(dBulk, mBulk, i + 1,
    `Production item ${i + 1} concerning Ormsby and the missing receipt.`, 0.50 - i * 0.001);
}
// Both of these are the strongest matches in the database. One is authorized
// but left out of the array by the caller (a sealed or paused descendant); the
// other is not authorized at all. They must be invisible for different reasons.
for (let i = 0; i < 8; i++) {
  await addP(dSealed, mSealed, i + 1,
    `SEALED ANNEX ${i + 1}: Ormsby receipt letter dispute acknowledgement.`, 1.0);
  await addP(dForbidden, mForbidden, i + 1,
    `FOREIGN MATTER ${i + 1}: Ormsby receipt letter dispute acknowledgement.`, 1.0);
}

const [{ n: total }] = await q(`select count(*)::int as n from public.passages`);
check(total === 339, 'corpus seeded', `${total} passages`);
const [{ matterspace_id: nearest }] = await q(
  `select matterspace_id from public.passages where embedding is not null
    order by embedding <=> $1::vector limit 1`, [QUERY_VEC]);
check(nearest === mSealed || nearest === mForbidden,
  'the two matters that must never appear hold the nearest vectors');

// ---------------------------------------------------------------------------
// Running as a real role.
// ---------------------------------------------------------------------------
const asRole = async (role, uid) => {
  await db.exec(`reset role`);
  await db.exec(uid
    ? `set request.jwt.claims = '${JSON.stringify({ sub: uid, role })}'`
    : `set request.jwt.claims = '${JSON.stringify({ role })}'`);
  if (role !== 'postgres') await db.exec(`set role ${role}`);
};
const asOwner = async () => { await db.exec(`reset role`); await db.exec(`set request.jwt.claims = ''`); };

const SCOPE = [mOpen, mBulk];
const search = (opts = {}) => q(
  `select passage_id, document_id, document_title, doc_type, page_start, page_end,
          line_start, line_end, witness_name, examination_type, passage_type, text,
          hybrid_score, text_rank, vector_score
     from public.search_passages($1::uuid[], $2, $3::vector, $4::text[], $5::text[],
                                 $6::uuid[], $7, $8, $9, $10)`,
  [opts.scope ?? SCOPE, opts.qText ?? 'Ormsby receipt',
    opts.embedding === undefined ? QUERY_VEC : opts.embedding,
    opts.docTypes ?? null, opts.witnesses ?? null, opts.documentIds ?? null,
    0, opts.limit ?? 10, opts.model ?? OPENAI, 1]);

const CASES = [
  ['hybrid', {}],
  ['text only', { embedding: null }],
  ['vector only', { qText: '' }],
  ['limit 25', { limit: 25 }],
  ['doc_types filter', { docTypes: ['deposition'] }],
  ['witness filter', { witnesses: ['Ormsby'] }],
  ['document_ids filter', { documentIds: [dWit] }],
];
const runAll = async () => {
  const out = {};
  for (const [label, opts] of CASES) out[label] = await search(opts);
  return out;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const foreign = (rows) => rows.filter((r) => /SEALED ANNEX|FOREIGN MATTER/.test(r.text));

// ---------------------------------------------------------------------------
// 1. 074 under RLS — slow, correct, and the reference.
// ---------------------------------------------------------------------------
console.log('\n--- 074 under RLS: the reference ------------------------------');
await asOwner();
await db.exec(migration('074_search_scope_aware_ann.sql'));

await asRole('authenticated', USER);
const ref074 = await runAll();
check(Object.values(ref074).every((r) => r.length > 0),
  '[074/authenticated] every case returns rows',
  Object.entries(ref074).map(([k, v]) => `${k}=${v.length}`).join(' '));
const smuggled074 = await search({ scope: [...SCOPE, mForbidden] });
check(foreign(smuggled074).length === 0,
  '[074/authenticated] RLS already drops a forbidden matter smuggled into the array');

await asRole('anon', null);
check((await search()).length === 0, '[074/anon] anon sees nothing');

// The RLS-exempt reference, taken as the role that is actually exempt in
// production rather than as the superuser running the harness.
await asRole('service_role', null);
const ref074svc = await runAll();
check((await q(`select row_security_active('public.passages') as on`))[0].on === false,
  '[074/service_role] RLS is genuinely inactive for this caller — the exemption is real');

// ---------------------------------------------------------------------------
// 2. 078 — same answers for the same caller.
// ---------------------------------------------------------------------------
console.log('\n--- 078: same answers, one check per matter -------------------');
await asOwner();
await db.exec(migration('078_search_authorize_once.sql'));

await asRole('authenticated', USER);
const after = await runAll();
for (const [label] of CASES) {
  check(same(ref074[label], after[label]),
    `[078/authenticated] "${label}" is byte-identical to 074 under RLS`,
    `${ref074[label].length} row(s)`);
}

// The caller-applied exclusion (#181/#179) still holds: mSealed is authorized,
// and stays out purely because mcp-core left it out of the array.
for (const [label] of CASES) {
  check(foreign(after[label]).length === 0,
    `[078] "${label}" returns nothing from the excluded or the forbidden matter`);
}

// ---------------------------------------------------------------------------
// 3. The smuggled id — the case 078 exists to get right.
// ---------------------------------------------------------------------------
console.log('\n--- 078: an unauthorized matter in the array ------------------');
const smuggled = await search({ scope: [...SCOPE, mForbidden] });
check(foreign(smuggled).length === 0,
  '[078] a forbidden matter smuggled into p_matterspace_ids yields ZERO of its rows');
check(same(smuggled, after.hybrid),
  '[078] and the authorized part of that same call is untouched');
const onlyForbidden = await search({ scope: [mForbidden] });
check(onlyForbidden.length === 0,
  '[078] an array containing ONLY a forbidden matter returns no rows at all');
const mixedSealed = await search({ scope: [...SCOPE, mSealed] });
check(mixedSealed.some((r) => /SEALED ANNEX/.test(r.text)),
  'control: mSealed IS authorized — put it in the array deliberately and it returns',
  `${foreign(mixedSealed).length} row(s)`);

await asRole('anon', null);
check((await search()).length === 0, '[078/anon] anon still sees nothing');
check((await search({ scope: [mOpen, mBulk, mSealed, mForbidden] })).length === 0,
  '[078/anon] and sees nothing even when handed every matter id in the database');

// ---------------------------------------------------------------------------
// 4. The RLS-exempt callers must be unaffected.
// ---------------------------------------------------------------------------
console.log('\n--- 078: a caller RLS never applied to ------------------------');
await asRole('service_role', null);
const afterSvc = await runAll();
for (const [label] of CASES) {
  check(same(ref074svc[label], afterSvc[label]),
    `[078/service_role] "${label}" is byte-identical to 074 for a bypassing caller`);
}
const svcEverything = await search({ scope: [mOpen, mBulk, mSealed, mForbidden] });
check(foreign(svcEverything).length > 0,
  '[078/service_role] and it still reaches every matter it names — the array is passed through, not reduced',
  `${foreign(svcEverything).length} row(s)`);

// ---------------------------------------------------------------------------
// 5. Negative control: take the reduction out and watch it leak.
// ---------------------------------------------------------------------------
console.log('\n--- negative control -----------------------------------------');
const src = fs.readFileSync(migrationPath('078_search_authorize_once.sql'), 'utf8').replace(/\r\n/g, '\n');
const GUARD = 'where public.can_access_matter(m.id)';
const nocheck = src
  .replace('create or replace function public.search_passages(',
    'create or replace function public.search_passages_nocheck(')
  .replace(GUARD, 'where true');
check(src.includes(GUARD) && !nocheck.includes(GUARD) && nocheck.includes('search_passages_nocheck'),
  'derived an unguarded variant from the real 078 file (the reduction verifiably removed)');
await asOwner();
await db.exec(nocheck);
await asRole('authenticated', USER);
const leaked = await q(
  `select text from public.search_passages_nocheck($1::uuid[], $2, $3::vector,
     null, null, null, 0, 10, $4, 1)`,
  [[...SCOPE, mForbidden], 'Ormsby receipt', QUERY_VEC, OPENAI]);
check(leaked.some((r) => /FOREIGN MATTER/.test(r.text)),
  'WITHOUT the reduction the SECURITY DEFINER core leaks the forbidden matter — so the reduction is what stops it',
  `${leaked.filter((r) => /FOREIGN MATTER/.test(r.text)).length} foreign row(s)`);

// ---------------------------------------------------------------------------
// 6. Contract, privileges, both branches, idempotence.
// ---------------------------------------------------------------------------
console.log('\n--- contract and privileges ----------------------------------');
await asOwner();
const [sig] = await q(
  `select p.prosecdef, pg_get_function_identity_arguments(p.oid) as args
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'search_passages'`);
check(sig.args === 'p_matterspace_ids uuid[], p_query_text text, p_query_embedding vector, '
  + 'p_doc_types text[], p_witness_names text[], p_document_ids uuid[], p_summary_level integer, '
  + 'p_limit integer, p_embedding_model text, p_embedding_version integer',
  'the public signature is unchanged', sig.args);
check(sig.prosecdef === false, 'public.search_passages is still SECURITY INVOKER');
const [core] = await q(
  `select p.prosecdef, p.proconfig::text as cfg
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'search_internal' and p.proname = 'search_passages_core'`);
check(core.prosecdef === true, 'the core is SECURITY DEFINER');
check(/search_path=public/.test(core.cfg ?? ''), 'the core pins search_path', core.cfg ?? 'null');
check((await q(`select has_function_privilege('anon',
   'search_internal.search_passages_core(uuid[],text,vector,text[],text[],uuid[],int,int,text,int)',
   'execute') as ok`))[0].ok === false,
  'anon holds no EXECUTE on the core');
check((await q(`select has_schema_privilege('anon','search_internal','usage') as ok`))[0].ok === false,
  'anon holds no USAGE on the private schema');
check(Object.keys(ref074.hybrid[0]).length === 15, 'all fifteen result columns are still returned');

// Both of 074's branches, now under 078.
console.log('\n--- both branches, under 078 ---------------------------------');
await asRole('authenticated', USER);
await db.exec(`set contextspaces.search_exact_max = '50'`);
const annBranch = await runAll();
for (const [label] of CASES) {
  check(foreign(annBranch[label]).length === 0,
    `[078 ANN branch] "${label}" still returns nothing forbidden or excluded`);
}
check((await search({ scope: [...SCOPE, mForbidden] })).length > 0
  && foreign(await search({ scope: [...SCOPE, mForbidden] })).length === 0,
  '[078 ANN branch] the smuggled id still yields none of its rows');
await db.exec(`set contextspaces.search_exact_max = '15000'`);

// Idempotent.
await asOwner();
await db.exec(migration('078_search_authorize_once.sql'));
await asRole('authenticated', USER);
const twice = await runAll();
for (const [label] of CASES) {
  check(same(after[label], twice[label]), `[078 applied twice] "${label}" is unchanged`);
}

await asOwner();
console.log(`\n${failures === 0
  ? '078 verified: identical answers for an authorized caller, zero rows for an unauthorized matter, RLS-exempt callers untouched.'
  : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
