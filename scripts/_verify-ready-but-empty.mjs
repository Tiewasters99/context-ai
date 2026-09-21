// Execute migration 059 against a real Postgres and prove ready_but_empty()
// returns exactly the right rows.
//
// Standard drill (see _verify-job-priority.mjs / _verify-recovery-sweep.mjs):
// no Docker on this machine, so PGlite — real Postgres in WASM — runs the
// ACTUAL migration file, and the seed includes the shapes that matter:
//
//   * an indexed document            -> not returned
//   * a text doc, ready, 0 passages  -> returned, has_indexed_twin = false
//   * a duplicate pair where one copy is indexed and one is empty
//                                    -> the empty twin returned with
//                                       has_indexed_twin = true
//   * two empty copies of the same file (NO indexed twin)
//                                    -> both returned, has_indexed_twin = false
//   * a non-ready document, 0 passages -> not returned (error/pending are the
//                                       monitor's other checks, not this one)
//   * null filenames group without crashing
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-ready-but-empty.mjs
//
// Touches nothing outside this process.

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
// Stubs: only what 059 touches. passages carries just the FK it probes.
// ---------------------------------------------------------------------------
console.log('\n--- schema ---------------------------------------------------');
await db.exec(`
  do $$ begin create role anon;          exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role;  exception when duplicate_object then null; end $$;

  create table public.documents (
    id uuid primary key default gen_random_uuid(),
    matterspace_id uuid,
    source_filename text,
    title text,
    file_size_bytes bigint,
    processing_status text not null default 'pending',
    created_at timestamptz not null default now()
  );
  create table public.passages (
    id uuid primary key default gen_random_uuid(),
    document_id uuid references public.documents(id) on delete cascade,
    text text
  );
  create index idx_passages_document_seq on public.passages(document_id);
`);
console.log('  stub schema built');
await db.exec(migration('059_ready_but_empty.sql'));

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
const M = '11111111-1111-1111-1111-111111111111';
const doc = async (name, size, status = 'ready') =>
  (await q(`insert into public.documents (matterspace_id, source_filename, file_size_bytes, processing_status)
            values ($1, $2, $3, $4) returning id`, [M, name, size, status]))[0].id;
const passage = (id) => q(`insert into public.passages (document_id, text) values ($1, 'x')`, [id]);

const indexed = await doc('brief.pdf', 100);        await passage(indexed);
const emptyText = await doc('exhibit.pdf', 200);    // ready, no passages, no twin
const twinFull = await doc('BMC_1.tif', 300);       await passage(twinFull);
const twinEmpty = await doc('BMC_1.tif', 300);      // the deliberately-skipped duplicate
const orphanA = await doc('scan.tif', 400);         // two empty copies, NO indexed twin
const orphanB = await doc('scan.tif', 400);
const notReady = await doc('failed.pdf', 500, 'error');
const nullName = await doc(null, 600);              // null filename must not crash
// A same-name, same-size copy in ANOTHER matter is not a twin (081 looks it
// up by key rather than grouping, so prove the matter still bounds it).
const otherMatter = '22222222-2222-2222-2222-222222222222';
const foreignIndexed = (await q(`insert into public.documents (matterspace_id, source_filename, file_size_bytes, processing_status)
                                 values ($1, 'lonely.pdf', 700, 'ready') returning id`, [otherMatter]))[0].id;
await passage(foreignIndexed);
const lonely = await doc('lonely.pdf', 700);        // empty; its only indexed namesake is elsewhere
// Null size: the key uses coalesce(size, -1), so two null-size copies group.
const nullSizeIndexed = await doc('nosize.pdf', null); await passage(nullSizeIndexed);
const nullSizeEmpty = await doc('nosize.pdf', null);

const rows = await q(`select * from public.ready_but_empty() order by source_filename nulls first`);
console.log(`\n--- results (${rows.length} rows) ------------------------------`);
for (const r of rows) console.log(`   ${String(r.source_filename).padEnd(14)} twin=${r.has_indexed_twin}`);

const byId = Object.fromEntries(rows.map((r) => [r.document_id, r]));
check(!byId[indexed], 'indexed document not returned');
check(!byId[notReady], "non-ready document not returned (that's the error check's job)");
check(byId[emptyText] && byId[emptyText].has_indexed_twin === false, 'empty text doc returned, twin=false');
check(!byId[twinFull], 'the indexed copy of the duplicate pair not returned');
check(byId[twinEmpty] && byId[twinEmpty].has_indexed_twin === true, 'the empty duplicate returned with twin=TRUE');
check(byId[orphanA]?.has_indexed_twin === false && byId[orphanB]?.has_indexed_twin === false,
  'two empty copies with no indexed twin both returned, twin=false');
check(byId[nullName] && byId[nullName].has_indexed_twin === false, 'null filename handled, twin=false');
check(byId[lonely]?.has_indexed_twin === false, 'a same-name copy in ANOTHER matter is not a twin');
check(byId[nullSizeEmpty]?.has_indexed_twin === true, 'null file_size groups with its indexed namesake, twin=TRUE');
check(!byId[nullSizeIndexed], 'the indexed null-size copy not returned');
check(rows.length === 7, 'exactly the seven empty-ready rows returned', `got ${rows.length}`);

// ---------------------------------------------------------------------------
// 081: the same answers, without grouping the whole corpus. Run the real file
// over the same seed and compare row for row — a cheaper query that changed
// the answer would be worse than a slow one.
// ---------------------------------------------------------------------------
console.log('\n--- migration 081 (cheaper, must be identical) ----------------');
const before = await q(`select * from public.ready_but_empty() order by document_id`);
await db.exec(migration('081_ready_but_empty_cheaper.sql'));
const after = await q(`select * from public.ready_but_empty() order by document_id`);
const norm = (rs) => JSON.stringify(rs.map((r) => [r.document_id, r.matterspace_id, r.source_filename, r.title, String(r.file_size_bytes), r.has_indexed_twin]));
check(norm(before) === norm(after), '081 returns exactly what 059 returned, row for row',
  `\n      059: ${norm(before)}\n      081: ${norm(after)}`);
for (const r of after) console.log(`   ${String(r.source_filename).padEnd(14)} twin=${r.has_indexed_twin}`);
check((await q(`select 1 from pg_indexes where indexname = 'idx_documents_ready_dedupe_key'`)).length === 1,
  'the dedupe-key index exists after 081');
// Printed, not asserted: PGlite has no production statistics, so the plan
// here says nothing about cost. The timing claim belongs in production.
console.log('\n   plan (informational — seven seed rows, not a cost measurement):');
for (const r of await q(`explain (costs off) select * from public.ready_but_empty()`)) console.log(`     ${r['QUERY PLAN']}`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
