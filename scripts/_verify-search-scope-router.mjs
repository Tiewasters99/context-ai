// Execute 056, then 061, then 074 against a real Postgres with real pgvector,
// and hold 074 to the promise it makes: the same answers, faster, with nothing
// that was excluded creeping back in.
//
// Why this shape
// ---------------------------------------------------------------------------
// 074 changes HOW stage A is retrieved, not WHAT search means. So the central
// assertion is a comparison, not a spot check: the 061 function and the 074
// function are run over the same corpus with the same arguments, and every
// returned row must match — same ids, same order, same scores to the bit. A
// retrieval change that is allowed to "improve" results cannot be verified at
// all, because there is nothing it could fail.
//
// The second thing 074 does is choose between two branches by measuring the
// scope. A harness that only ever exercises one of them is worth very little,
// so the threshold is pushed down with the GUC 074 reads
// (`contextspaces.search_exact_max`) and the whole battery runs again on the
// other side of it.
//
// The third thing is the thing that must never break: matter isolation. The
// corpus contains a matter that is deliberately the BEST match for every query
// — nearest vector, densest text — and is simply absent from the id array, the
// way lib/mcp-core.mjs leaves a sealed or paused descendant out (PRs #181 and
// #179). If either branch can reach it, that is a seal failure, and it is
// asserted separately on each branch rather than once.
//
//   npm i --no-save @electric-sql/pglite @electric-sql/pglite-pgvector
//   node scripts/_verify-search-scope-router.mjs
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

const db = new PGlite({ extensions: { vector } });
const q = async (sql, params) => (await db.query(sql, params)).rows;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------------------
// Schema: the parts of 002 the search function touches, with the three indexes
// 056 declares it depends on.
// ---------------------------------------------------------------------------
console.log('\n--- schema ---------------------------------------------------');
await db.exec(`
  create extension if not exists vector;

  create table public.matterspaces (id uuid primary key default gen_random_uuid(), name text);
  create table public.documents (
    id uuid primary key default gen_random_uuid(),
    matterspace_id uuid,
    title text,
    doc_type text
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
console.log('  stub schema built (real pgvector, real HNSW + GIN)');

// ---------------------------------------------------------------------------
// Corpus. Three matters:
//   OPEN   — 24 passages, the ordinary case.
//   BULK   — 300 passages, enough that a low threshold sends the whole scope
//            down the ANN branch.
//   HIDDEN — 8 passages that are the closest vectors AND the strongest text
//            matches in the database, and that no caller ever puts in scope.
// ---------------------------------------------------------------------------
console.log('\n--- corpus ---------------------------------------------------');
const OPENAI = 'text-embedding-3-small';
const SEALED = 'voyage-law-3';
const DIM = 1024;
// Vectors differ only in their first coordinate, so cosine distance is a
// simple, predictable function of that one number — which makes "is this the
// true top-K" a question with an arithmetic answer rather than a vibe.
const vec = (head) => `[${[head, ...Array(DIM - 1).fill(0.05)].join(',')}]`;
const QUERY_VEC = vec(1.0);

const newMatter = async (name) =>
  (await q(`insert into public.matterspaces (name) values ($1) returning id`, [name]))[0].id;
const newDoc = async (matterId, title, docType) =>
  (await q(
    `insert into public.documents (matterspace_id, title, doc_type) values ($1,$2,$3) returning id`,
    [matterId, title, docType]))[0].id;

const addPassage = (docId, matterId, seq, text, head, model = OPENAI, witness = null) => q(
  `insert into public.passages
     (document_id, matterspace_id, sequence_number, page_start, page_end,
      line_start, line_end, text, passage_type, embedding, embedding_model, witness_name)
   values ($1,$2,$3,$4,$4,1,5,$5,'paragraph',$6,$7,$8) returning id`,
  [docId, matterId, seq, seq, text, head === null ? null : vec(head), model, witness]);

const mOpen = await newMatter('Vashti v. Ormsby');
const mBulk = await newMatter('Vashti v. Ormsby — Production');
const mHidden = await newMatter('Vashti v. Ormsby — sealed annex');

const dOpen = await newDoc(mOpen, 'Correspondence', 'other');
const dBulk = await newDoc(mBulk, 'Production volume 1', 'other');
const dHidden = await newDoc(mHidden, 'Annex', 'other');
const dWitness = await newDoc(mOpen, 'Deposition of Ormsby', 'deposition');

// OPEN: 20 ordinary passages, decreasing vector similarity down the list.
for (let i = 0; i < 20; i++) {
  await addPassage(dOpen, mOpen, i + 1,
    `Ormsby letter ${i + 1}: the receipt was never produced and the dispute turns on it.`,
    0.95 - i * 0.02);
}
// OPEN: one passage in a different embedding space, numerically very close to
// the query vector — 061's Bug 2 trap. It must be returned (text found it) and
// must score 0 on vector.
await addPassage(dOpen, mOpen, 21,
  'Ormsby was served at his registered office on the ninth of March.', 0.999, SEALED);
// OPEN: one sealed-and-unembedded passage — Phase A leaves these.
await addPassage(dOpen, mOpen, 22,
  'Ormsby produced no acknowledgement of any kind.', null, SEALED);
// OPEN: two passages inside a deposition, tagged with a witness, so the
// narrow-scope branch (p_document_ids / p_witness_names) has something to find.
await addPassage(dWitness, mOpen, 23,
  'Q. Did Ormsby receive the letter? A. He did not.', 0.30, OPENAI, 'Ormsby');
await addPassage(dWitness, mOpen, 24,
  'Q. And the receipt? A. There is no receipt in evidence, none at all.', 0.28, OPENAI, 'Ormsby');

// BULK: 300 passages, all weaker matches than OPEN's best.
for (let i = 0; i < 300; i++) {
  await addPassage(dBulk, mBulk, i + 1,
    `Production item ${i + 1} concerning Ormsby and the missing receipt.`,
    0.50 - i * 0.001);
}

// HIDDEN: the best matches in the database, in a matter no caller puts in scope.
for (let i = 0; i < 8; i++) {
  await addPassage(dHidden, mHidden, i + 1,
    `SEALED ANNEX ${i + 1}: Ormsby receipt letter dispute produced acknowledgement.`,
    1.0);
}

const counts = await q(`select matterspace_id, count(*)::int as n from public.passages group by 1`);
const byMatter = Object.fromEntries(counts.map((r) => [r.matterspace_id, r.n]));
check(byMatter[mOpen] === 24 && byMatter[mBulk] === 300 && byMatter[mHidden] === 8,
  'corpus seeded',
  `open=${byMatter[mOpen]} bulk=${byMatter[mBulk]} hidden=${byMatter[mHidden]}`);

// The excluded matter really is the strongest candidate — otherwise the
// isolation assertions below would pass for the wrong reason.
const [nearest] = await q(
  `select matterspace_id from public.passages
    where embedding is not null and embedding_model = $1
    order by embedding <=> $2::vector limit 1`, [OPENAI, QUERY_VEC]);
check(nearest.matterspace_id === mHidden,
  'the EXCLUDED matter holds the nearest vector in the database (so isolation is actually tested)');

// ---------------------------------------------------------------------------
// The call. `scope` is what lib/mcp-core.mjs passes after removing sealed and
// paused descendants: the hidden matter is simply not in the array.
// ---------------------------------------------------------------------------
const SCOPE = [mOpen, mBulk];
const search = (opts = {}) => q(
  `select passage_id, document_id, document_title, doc_type, page_start, page_end,
          line_start, line_end, witness_name, examination_type, passage_type, text,
          hybrid_score, text_rank, vector_score
     from public.search_passages($1::uuid[], $2, $3::vector, $4::text[], $5::text[],
                                 $6::uuid[], $7, $8, $9, $10)`,
  [
    opts.scope ?? SCOPE,
    opts.qText ?? 'Ormsby receipt',
    opts.embedding === undefined ? QUERY_VEC : opts.embedding,
    opts.docTypes ?? null,
    opts.witnesses ?? null,
    opts.documentIds ?? null,
    0,
    opts.limit ?? 10,
    opts.model ?? OPENAI,
    1,
  ]);

// Every case below runs on both sides of the threshold, so write them once.
const CASES = [
  ['hybrid', {}],
  ['text only', { embedding: null, model: SEALED }],
  ['vector only', { qText: '' }],
  ['limit 25', { limit: 25 }],
  ['doc_types filter', { docTypes: ['deposition'] }],
  ['witness filter', { witnesses: ['Ormsby'] }],
  ['document_ids filter', { documentIds: [dWitness] }],
];
const runAll = async () => {
  const out = {};
  for (const [label, opts] of CASES) out[label] = await search(opts);
  return out;
};
// Compare two result sets exactly: same rows, same order, same numbers.
const sameRows = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// 1. Baseline: what 061 answers today.
// ---------------------------------------------------------------------------
console.log('\n--- 061: the baseline these answers must be preserved from ----');
await db.exec(migration('056_search_passages_two_stage.sql'));
await db.exec(migration('061_search_model_scoped_vectors.sql'));
const baseline = await runAll();
check(Object.values(baseline).every((rows) => rows.length > 0),
  '[061] every case returns rows to compare against',
  Object.entries(baseline).map(([k, v]) => `${k}=${v.length}`).join(' '));
check(baseline.hybrid.every((r) => r.text.startsWith('Ormsby') || r.text.startsWith('Q.') || r.text.startsWith('Production')),
  '[061] and no result comes from the excluded matter');

// ---------------------------------------------------------------------------
// 2. 074, default threshold (20,000): the whole 324-passage corpus is under it,
//    so every case takes the EXACT branch. Exact must equal exact.
// ---------------------------------------------------------------------------
console.log('\n--- 074: exact branch — identical answers ---------------------');
await db.exec(migration('074_search_scope_aware_ann.sql'));
const [{ exact_max }] = await q(
  `select coalesce(nullif(current_setting('contextspaces.search_exact_max', true),'')::int, 15000) as exact_max`);
check(Number(exact_max) === 15000
  && /nullif\(current_setting\('contextspaces\.search_exact_max', true\), ''\)::int,\s*\n\s*15000\)/
    .test(fs.readFileSync(migrationPath('074_search_scope_aware_ann.sql'), 'utf8')),
  'the default threshold is 15,000 passages in scope', `got ${exact_max}`);

const afterExact = await runAll();
for (const [label] of CASES) {
  check(sameRows(baseline[label], afterExact[label]),
    `[074 exact] "${label}" is byte-identical to 061`,
    `${baseline[label].length} row(s)`);
}

// The exact branch is exact: its top-K really is the top-K, computed
// independently of the function.
const [{ best }] = await q(
  `select p.id as best from public.passages p
    where p.matterspace_id = any($1::uuid[]) and p.embedding is not null
      and p.embedding_model = $2
    order by p.embedding <=> $3::vector limit 1`, [SCOPE, OPENAI, QUERY_VEC]);
const vectorOnly = afterExact['vector only'];
check(vectorOnly[0]?.passage_id === best,
  '[074 exact] vector-only search returns the true nearest neighbour in scope');
check(vectorOnly.every((r) => Number(r.vector_score) > 0),
  '[074 exact] and every vector-only hit is scored in the query\'s own space');

// ---------------------------------------------------------------------------
// 3. 074, threshold pushed below the corpus: the ANN branch, same corpus.
// ---------------------------------------------------------------------------
console.log('\n--- 074: ANN branch — same guarantees ------------------------');
await db.exec(`set contextspaces.search_exact_max = '50'`);
const [{ exact_max: lowered }] = await q(
  `select coalesce(nullif(current_setting('contextspaces.search_exact_max', true),'')::int, 20000) as exact_max`);
check(Number(lowered) === 50, 'threshold lowered to 50, so a 324-passage scope crosses it', `got ${lowered}`);

const afterAnn = await runAll();
check(Object.values(afterAnn).every((rows) => rows.length > 0),
  '[074 ANN] every case still returns rows',
  Object.entries(afterAnn).map(([k, v]) => `${k}=${v.length}`).join(' '));

// Narrow searches take the exact branch whatever the threshold says, because
// document_ids / witness_names starve an ANN scan. So those three cases must
// still be identical to 061.
for (const label of ['text only', 'witness filter', 'document_ids filter']) {
  check(sameRows(baseline[label], afterAnn[label]),
    `[074 ANN] "${label}" still takes the exact branch and is identical to 061`);
}

// ---------------------------------------------------------------------------
// 4. Matter isolation, asserted on each branch separately.
// ---------------------------------------------------------------------------
console.log('\n--- isolation: the excluded matter, both branches -------------');
const hiddenDocs = new Set([dHidden]);
const leaked = (rows) => rows.filter((r) => hiddenDocs.has(r.document_id) || /SEALED ANNEX/.test(r.text));
for (const [label] of CASES) {
  check(leaked(afterExact[label]).length === 0,
    `[074 exact] "${label}" returns nothing from the excluded matter`);
  check(leaked(afterAnn[label]).length === 0,
    `[074 ANN] "${label}" returns nothing from the excluded matter`);
}
// And the negative control: put it in scope and it is found immediately, so the
// silence above is the filter working, not the corpus being unreachable.
const withHidden = await search({ scope: [mOpen, mBulk, mHidden] });
check(leaked(withHidden).length > 0,
  'negative control: add the excluded matter to the array and its passages return at once',
  `${leaked(withHidden).length} row(s)`);

// ---------------------------------------------------------------------------
// 5. Model scope (061's two bugs) survives 074, on both branches.
// ---------------------------------------------------------------------------
console.log('\n--- model scope: 061 still holds under 074 --------------------');
for (const [branch, rows] of [['exact', afterExact.hybrid], ['ANN', afterAnn.hybrid]]) {
  const cross = rows.find((r) => /registered office/.test(r.text));
  if (cross) {
    check(Number(cross.vector_score) === 0,
      `[074 ${branch}] the other-space passage scores 0 on vector — no cross-space cosine`,
      `vector_score=${cross.vector_score}`);
  } else {
    check(true, `[074 ${branch}] the other-space passage is not a candidate for this query`);
  }
}
await db.exec(`set contextspaces.search_exact_max = '15000'`);
const textOnlyDefault = await search({ embedding: null, model: SEALED });
const textOnlyOpenai = await search({ embedding: null, model: OPENAI });
check(sameRows(textOnlyDefault, textOnlyOpenai),
  '[074] text-only search is model-agnostic — the same rows under either model name');

// ---------------------------------------------------------------------------
// 6. The plan. The exact branch must not be able to reach the HNSW index —
//    that is what `+ 0.0` is for, and it is the one line whose removal would
//    silently reintroduce the worst case (a tiny scope grinding the graph).
// ---------------------------------------------------------------------------
console.log('\n--- plans: the branches use the access paths they claim -------');
const src = fs.readFileSync(migrationPath('074_search_scope_aware_ann.sql'), 'utf8');
check(/order by \(p\.embedding <=> p_query_embedding\) \+ 0\.0, p\.id/.test(src),
  '074 still contains the exact branch\'s unindexable ORDER BY');
check((src.match(/order by p\.embedding <=> p_query_embedding\s*\n\s*limit v_k/g) ?? []).length === 1,
  '074 still contains exactly one bare-operator ORDER BY (the ANN branch)');

const planOf = async (sql, params) =>
  (await q(sql, params)).map((r) => r['QUERY PLAN']).join('\n');
// Both alternatives are made as unattractive as the planner allows, so what is
// left is the question actually being asked: CAN this ORDER BY reach the HNSW
// index at all? A synthetic corpus is far too small for cost to decide it, and
// cost is not the claim — pathkey matching is.
await db.exec(`set enable_seqscan = off`);
await db.exec(`set enable_sort = off`);
const exactPlan = await planOf(
  `explain select p.id from public.passages p
     where p.embedding is not null and p.matterspace_id = any($1::uuid[])
     order by (p.embedding <=> $2::vector) + 0.0, p.id limit 200`, [SCOPE, QUERY_VEC]);
const annPlan = await planOf(
  `explain select p.id from public.passages p
     where p.embedding is not null and p.matterspace_id = any($1::uuid[])
     order by p.embedding <=> $2::vector limit 200`, [SCOPE, QUERY_VEC]);
await db.exec(`set enable_sort = on`);
await db.exec(`set enable_seqscan = on`);
check(!/idx_passages_embedding_hnsw/.test(exactPlan) && /Sort/.test(exactPlan),
  'the exact branch\'s ORDER BY cannot reach the HNSW index — it must sort, even with sorting penalised');
check(/idx_passages_embedding_hnsw/.test(annPlan),
  'the ANN branch\'s ORDER BY does reach the HNSW index');

// ---------------------------------------------------------------------------
// 7. Contract and drift.
// ---------------------------------------------------------------------------
console.log('\n--- contract -------------------------------------------------');
const cols = await q(
  `select p.proargnames, pg_get_function_identity_arguments(p.oid) as sig
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'search_passages'`);
check(cols.length === 1, 'exactly one search_passages — no overload was created');
check(cols[0].sig === 'p_matterspace_ids uuid[], p_query_text text, p_query_embedding vector, '
  + 'p_doc_types text[], p_witness_names text[], p_document_ids uuid[], p_summary_level integer, '
  + 'p_limit integer, p_embedding_model text, p_embedding_version integer',
  'the ten argument names and types are unchanged, in order', cols[0].sig);
check(Object.keys(baseline.hybrid[0]).length === 15,
  'all fifteen result columns are still returned', `${Object.keys(baseline.hybrid[0]).length}`);

// Idempotent against drift: running it again changes nothing.
await db.exec(migration('074_search_scope_aware_ann.sql'));
const twice = await runAll();
for (const [label] of CASES) {
  check(sameRows(afterExact[label], twice[label]), `[074 applied twice] "${label}" is unchanged`);
}

// And it does not depend on 061 having been applied first: a database still on
// 056 gets the same function, 061's guarantees included.
console.log('\n--- 056 -> 074 directly (no 061 in between) -------------------');
const db2 = new PGlite({ extensions: { vector } });
await db2.exec(fs.readFileSync(path.resolve(__dirname, '..', 'supabase', 'migrations', '056_search_passages_two_stage.sql'), 'utf8')
  .replace(/^/, `create extension if not exists vector;
  create table public.documents (id uuid primary key default gen_random_uuid(), matterspace_id uuid, title text, doc_type text);
  create table public.passages (
    id uuid primary key default gen_random_uuid(),
    document_id uuid references public.documents(id) on delete cascade,
    matterspace_id uuid, sequence_number int,
    page_start int, page_end int, line_start int, line_end int,
    witness_name text, examination_type text, speaker text,
    text text not null, passage_type text, embedding vector(1024),
    tsv tsvector generated always as (to_tsvector('english', text)) stored,
    summary_level int not null default 0,
    embedding_model text not null default 'text-embedding-3-small',
    embedding_version int not null default 1);
  create index idx_passages_tsv on public.passages using gin(tsv);
  create index idx_passages_embedding_hnsw on public.passages using hnsw (embedding vector_cosine_ops);
  create index idx_passages_matterspace_level on public.passages(matterspace_id, summary_level);
`));
await db2.exec(src);
const d2 = (await db2.query(
  `insert into public.documents (matterspace_id, title, doc_type)
   values (gen_random_uuid(), 'Letter', 'other') returning id, matterspace_id`)).rows[0];
await db2.query(
  `insert into public.passages (document_id, matterspace_id, sequence_number, page_start, page_end,
     line_start, line_end, text, passage_type, embedding, embedding_model)
   values ($1,$2,1,1,1,1,5,'Ormsby denied receiving the letter.','paragraph',$3,$4)`,
  [d2.id, d2.matterspace_id, vec(0.999), SEALED]);
const crossOnly = (await db2.query(
  `select vector_score from public.search_passages($1::uuid[], 'Ormsby', $2::vector, null, null, null, 0, 10, $3, 1)`,
  [[d2.matterspace_id], QUERY_VEC, OPENAI])).rows;
check(crossOnly.length === 1 && Number(crossOnly[0].vector_score) === 0,
  '[056 -> 074] 061\'s guarantees arrive with 074: found by text, scored 0 across spaces',
  crossOnly.length ? `vector_score=${crossOnly[0].vector_score}` : 'no rows');

console.log(`\n${failures === 0
  ? '074 verified: same answers on the exact branch, same guarantees on the ANN branch, isolation intact on both.'
  : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
