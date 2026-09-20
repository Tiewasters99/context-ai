// Execute migration 068 against a real Postgres and prove what it claims.
//
// There is no Docker and no psql on the dev machine, so a migration that is
// only parse-checked is a migration nobody has run. PGlite is Postgres
// compiled to WebAssembly — real plpgsql, real policies, real foreign keys —
// inside this process. This script builds the minimum schema 036 references,
// runs the ACTUAL migration files (036 then 068, in the order production would
// receive them), and then asks the database questions.
//
// What is asserted, and why each one matters:
//
//   1. 068 APPLIES on top of 036, and applies AGAIN as a no-op. The live
//      database is not the migrations folder (project-dev-environment-
//      cautions): a file that cannot be re-pasted is a file that will be
//      pasted wrong once.
//   2. THE PAIR-LEVEL RUN STATE landed on bucketizer_classifications, which is
//      the row that already keys (document, node). That is the whole argument
//      for not creating a second table for it.
//   3. ONE QUOTATION PER PASSAGE PER ISSUE — the unique key the outline relies
//      on to avoid printing the same citation twice.
//   4. THE CASCADE ON passage_id. Re-ingesting a deposition replaces its
//      passages; the quotations recorded against them must disappear with
//      them rather than sit in the outline citing a page that has moved
//      (feedback: deposition-fidelity). This is the assertion this file exists
//      for.
//   5. RLS IS ON, and every policy goes through the SECURITY INVOKER wrapper
//      _bktz_matter_access — never a SECURITY DEFINER helper in a policy
//      expression (feedback: rls-security-invoker-wrappers).
//
// What it cannot prove: PGlite has one connection and no auth schema of its
// own, so _mtspc_select_check is stubbed here. Whether a stranger's JWT is
// refused is migration 022's question and is exercised by
// _verify-marginalia-rls.mjs against the live database.
//
//   npm i --no-save @electric-sql/pglite     # not a repo dependency
//   node scripts/_verify-bucketizer-evidence.mjs
//
// Touches nothing outside this process. No .env, no network, no prod.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = (name) => {
  const p = path.resolve(__dirname, '..', 'supabase', 'migrations', name);
  console.log(`  executing ${path.relative(process.cwd(), p)}`);
  return fs.readFileSync(p, 'utf8');
};

const db = new PGlite();
const q = async (sql, params) => (await db.query(sql, params)).rows;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------------------
// 1. The schema 036 references. Minimal, and named exactly as production.
// ---------------------------------------------------------------------------
console.log('\n--- schema ---------------------------------------------------');
await db.exec(`
  do $$ begin create role anon;          exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role;  exception when duplicate_object then null; end $$;

  create schema if not exists auth;
  -- Stubbed: PGlite has no GoTrue. Every policy below resolves through
  -- _bktz_matter_access, and what is under test is that they resolve through
  -- it at all, not what GoTrue returns.
  create or replace function auth.uid() returns uuid language sql stable
    as $$ select '00000000-0000-0000-0000-0000000000aa'::uuid $$;

  create or replace function public.update_updated_at() returns trigger
    language plpgsql as $$
    begin new.updated_at = now(); return new; end $$;

  create table public.serverspaces (
    id uuid primary key default gen_random_uuid(),
    name text
  );
  create table public.matterspaces (
    id uuid primary key default gen_random_uuid(),
    serverspace_id uuid not null references public.serverspaces(id) on delete cascade,
    parent_matterspace_id uuid references public.matterspaces(id) on delete cascade,
    name text
  );
  create table public.profiles (id uuid primary key default gen_random_uuid());
  create table public.documents (
    id uuid primary key default gen_random_uuid(),
    matterspace_id uuid references public.matterspaces(id) on delete cascade,
    title text
  );
  create table public.passages (
    id uuid primary key default gen_random_uuid(),
    document_id uuid not null references public.documents(id) on delete cascade,
    matterspace_id uuid not null references public.matterspaces(id) on delete cascade,
    sequence_number int not null,
    page_start int, page_end int, line_start int, line_end int,
    witness_name text,
    text text not null,
    metadata jsonb not null default '{}'
  );

  -- Migration 022's SECURITY INVOKER access check, stubbed permissive.
  create or replace function public._mtspc_select_check(
    p_matter uuid, p_serverspace uuid, p_parent uuid
  ) returns boolean language sql security invoker stable as $$ select true $$;
`);
check(true, 'stub schema built');

// ---------------------------------------------------------------------------
// 2. The real migrations, in order.
// ---------------------------------------------------------------------------
console.log('\n--- migrations -----------------------------------------------');
await db.exec(migration('036_bucketizer.sql'));
check(true, '036 applied');

await db.exec(migration('068_bucketizer_evidence.sql'));
check(true, '068 applied on top of 036');

// The file has to survive a second paste. Every object in it is `if not
// exists` / `create or replace`, and every policy is dropped first, precisely
// so re-running against a database that has drifted is a no-op rather than a
// 42P07 in the middle of a session.
let rerunError = null;
try {
  await db.exec(migration('068_bucketizer_evidence.sql'));
} catch (e) {
  rerunError = e?.message ?? String(e);
}
check(rerunError === null, '068 is idempotent — a second paste is a no-op', rerunError ?? '');

// ---------------------------------------------------------------------------
// 3. Pair-level run state landed on the row that already keys the pair.
// ---------------------------------------------------------------------------
console.log('\n--- pair-level run state -------------------------------------');
const cols = await q(`
  select column_name, data_type from information_schema.columns
  where table_schema = 'public' and table_name = 'bucketizer_classifications'
    and column_name in ('evidence_run_at', 'evidence_model', 'evidence_failed')
  order by column_name
`);
check(cols.length === 3, 'evidence_run_at / evidence_model / evidence_failed are on bucketizer_classifications',
  cols.map((c) => c.column_name).join(', ') || 'none found');
check(
  cols.find((c) => c.column_name === 'evidence_run_at')?.data_type === 'timestamp with time zone',
  'evidence_run_at is a timestamptz',
);

const todoIdx = await q(`
  select indexdef from pg_indexes
  where schemaname = 'public' and indexname = 'bucketizer_classifications_evidence_todo_idx'
`);
check(todoIdx.length === 1, 'the "not yet read for evidence" index exists');
check(
  /where \(evidence_run_at is null\)/i.test(todoIdx[0]?.indexdef ?? ''),
  'and it is PARTIAL on evidence_run_at is null — the pass lists what is LEFT',
  todoIdx[0]?.indexdef ?? '',
);

// ---------------------------------------------------------------------------
// 4. Fixtures, and the behaviour.
// ---------------------------------------------------------------------------
console.log('\n--- behaviour ------------------------------------------------');
const [{ id: ss }] = await q(`insert into public.serverspaces (name) values ('S') returning id`);
const [{ id: matter }] = await q(
  `insert into public.matterspaces (serverspace_id, name) values ($1, 'Fleming') returning id`, [ss]);
const [{ id: doc }] = await q(
  `insert into public.documents (matterspace_id, title) values ($1, 'Ezekwe FULL SIZE') returning id`, [matter]);
const [{ id: passage }] = await q(`
  insert into public.passages (document_id, matterspace_id, sequence_number, page_start, page_end, line_start, line_end, text)
  values ($1, $2, 1, 42, 42, 11, 14, 'Q. Did you observe the pen?  A. I did, at approximately 0930.')
  returning id`, [doc, matter]);
const [{ id: otherPassage }] = await q(`
  insert into public.passages (document_id, matterspace_id, sequence_number, page_start, text)
  values ($1, $2, 2, 43, 'A. The intake sheet was not completed.') returning id`, [doc, matter]);
const [{ id: node }] = await q(`
  insert into public.bucketizer_nodes (matterspace_id, kind, label, description, position)
  values ($1, 'element', 'Objective unreasonableness', 'Graham factors.', 0) returning id`, [matter]);

await q(`
  insert into public.bucketizer_classifications (matterspace_id, document_id, node_id, status, confidence, passage_ids)
  values ($1, $2, $3, 'confirmed', 0.94, array[$4::uuid, $5::uuid])`,
[matter, doc, node, passage, otherPassage]);

const [{ id: ev }] = await q(`
  insert into public.bucketizer_evidence
    (matterspace_id, node_id, document_id, passage_id, quote, quote_offset, rationale, model_id)
  values ($1, $2, $3, $4, 'I did, at approximately 0930', 28, 'Fixes the time of the observation.', 'claude-opus-4-8')
  returning id`, [matter, node, doc, passage]);
check(Boolean(ev), 'an evidence row inserts');

const born = await q(`select status, position, decided_at from public.bucketizer_evidence where id = $1`, [ev]);
check(born[0].status === 'proposed', 'evidence is born "proposed" — only an attorney decision moves it');
check(born[0].decided_at === null, 'and carries no decision until one is made');

// One quotation per passage per issue.
let dupError = null;
try {
  await q(`
    insert into public.bucketizer_evidence (matterspace_id, node_id, document_id, passage_id, quote)
    values ($1, $2, $3, $4, 'at approximately 0930')`, [matter, node, doc, passage]);
} catch (e) {
  dupError = e?.message ?? String(e);
}
check(dupError !== null, 'a second quotation from the same passage under the same issue is refused',
  dupError ? 'unique (node_id, passage_id)' : 'IT WAS ACCEPTED');

// The same passage under a DIFFERENT issue is fine — one passage often bears
// on two elements, and both should cite it.
const [{ id: node2 }] = await q(`
  insert into public.bucketizer_nodes (matterspace_id, kind, label, position)
  values ($1, 'subissue', 'Pre-assault status', 1) returning id`, [matter]);
const second = await q(`
  insert into public.bucketizer_evidence (matterspace_id, node_id, document_id, passage_id, quote)
  values ($1, $2, $3, $4, 'I did, at approximately 0930') returning id`, [matter, node2, doc, passage]);
check(second.length === 1, 'the same passage may be cited under a different issue');

// -- the assertion this file exists for -------------------------------------
// Re-ingesting a document replaces its passages. Every quotation recorded
// against the old ones points at text the database no longer holds, and a
// citation that cannot be turned to is not a citation. It must go.
await q(`delete from public.passages where id = $1`, [passage]);
const afterReingest = await q(`select id from public.bucketizer_evidence where passage_id = $1`, [passage]);
check(afterReingest.length === 0,
  'deleting a passage (what a re-ingest does) takes its quotations with it',
  `${afterReingest.length} orphaned quotation(s) left behind`);

// A deleted bucket takes its evidence too — the attorney removed the issue.
const [{ id: passage3 }] = await q(`
  insert into public.passages (document_id, matterspace_id, sequence_number, page_start, text)
  values ($1, $2, 3, 44, 'A. No one signed the log.') returning id`, [doc, matter]);
await q(`
  insert into public.bucketizer_evidence (matterspace_id, node_id, document_id, passage_id, quote)
  values ($1, $2, $3, $4, 'No one signed the log.')`, [matter, node2, doc, passage3]);
await q(`delete from public.bucketizer_nodes where id = $1`, [node2]);
const afterNodeDelete = await q(`select id from public.bucketizer_evidence where node_id = $1`, [node2]);
check(afterNodeDelete.length === 0, 'deleting a bucket takes its quotations with it');

// ---------------------------------------------------------------------------
// 5. RLS, through the INVOKER wrapper and nothing else.
// ---------------------------------------------------------------------------
console.log('\n--- RLS ------------------------------------------------------');
const [rls] = await q(`
  select relrowsecurity from pg_class where oid = 'public.bucketizer_evidence'::regclass`);
check(rls.relrowsecurity === true, 'row level security is enabled on bucketizer_evidence');

const policies = await q(`
  select policyname, cmd, qual, with_check from pg_policies
  where schemaname = 'public' and tablename = 'bucketizer_evidence'
  order by policyname`);
check(policies.length === 4, 'select / insert / update / delete policies all exist',
  policies.map((p) => p.cmd).join(', '));

const expressions = policies.flatMap((p) => [p.qual, p.with_check]).filter(Boolean);
check(
  expressions.length > 0 && expressions.every((e) => /_bktz_matter_access/.test(e)),
  'every policy expression goes through the SECURITY INVOKER wrapper _bktz_matter_access',
  expressions.join(' | '),
);
check(
  !expressions.some((e) => /_mtspc_select_check/.test(e)),
  'and none of them calls the underlying helper directly',
);

const [wrapper] = await q(`
  select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = '_bktz_matter_access'`);
check(wrapper?.prosecdef === false, 'the wrapper itself is SECURITY INVOKER');

console.log(failures ? `\n${failures} FAILURES` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
