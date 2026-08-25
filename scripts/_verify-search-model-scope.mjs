// Execute 056 then 061 against a real Postgres with real pgvector, and show
// the two silent failures 061 exists to fix.
//
// Why this shape
// ---------------------------------------------------------------------------
// Both bugs return plausible output rather than an error: one returns an empty
// result set, the other returns a confident number computed across two
// incompatible embedding spaces. Neither is visible to a parse check, and
// neither is visible to a test that only ever uses one model — which, before
// Phase B, was every test we had.
//
// So this runs the SAME queries twice: once against 056 as production has it,
// asserting the bugs are present (if they are not, the premise of 061 is wrong
// and it should not ship), then against 061, asserting they are gone.
//
//   npm i --no-save @electric-sql/pglite @electric-sql/pglite-pgvector
//   node scripts/_verify-search-model-scope.mjs
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
const migration = (name) => {
  const p = path.resolve(__dirname, '..', 'supabase', 'migrations', name);
  console.log(`  executing ${path.relative(process.cwd(), p)}`);
  return fs.readFileSync(p, 'utf8');
};

const db = new PGlite({ extensions: { vector } });
const q = async (sql, params) => (await db.query(sql, params)).rows;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------------------
// Schema: the parts of 002/007 the search function touches.
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
`);
console.log('  stub schema built (real pgvector)');

// ---------------------------------------------------------------------------
// A matter mid-migration: the same three passages, half re-embedded.
// Vectors are deliberately crafted so a cross-space comparison looks GOOD —
// that is the trap. The "voyage" rows sit close to the openai query vector by
// raw cosine, while meaning nothing.
// ---------------------------------------------------------------------------
const OPENAI = 'text-embedding-3-small';
const SEALED = 'voyage-law-3';           // stand-in for whatever Phase B picks
const dim = 1024;
const vec = (fill) => `[${Array(dim).fill(fill).join(',')}]`;
const QUERY_VEC = vec(0.03);             // an "openai-space" query vector

const [m] = await q(`insert into public.matterspaces (name) values ('Vashti v. Ormsby') returning id`);
const [d] = await q(
  `insert into public.documents (matterspace_id, title, doc_type) values ($1,'Letter','other') returning id`,
  [m.id]);

const add = (seq, text, model, embFill) => q(
  `insert into public.passages
     (document_id, matterspace_id, sequence_number, page_start, page_end,
      line_start, line_end, text, passage_type, embedding, embedding_model)
   values ($1,$2,$3,1,1,1,5,$4,'paragraph',$5,$6) returning id`,
  [d.id, m.id, seq, text, embFill === null ? null : vec(embFill), model]);

// Still in the old space.
await add(1, 'Ormsby denied receiving the letter, which is the whole dispute.', OPENAI, 0.03);
// Already re-embedded into the sealed space — its vector is numerically very
// close to the query, but it is a different space, so that closeness is fake.
await add(2, 'Ormsby was served at his registered office on the ninth of March.', SEALED, 0.0301);
// Sealed and not yet embedded at all (Phase A leaves these).
await add(3, 'Ormsby produced no receipt and no acknowledgement of any kind.', SEALED, null);

const search = (model, embedding) => q(
  `select passage_id, text, hybrid_score, text_rank, vector_score
     from public.search_passages($1::uuid[], $2, $3::vector, null, null, null, 0, 10, $4, 1)`,
  [[m.id], 'Ormsby', embedding, model]);

// ---------------------------------------------------------------------------
// 1. 056 as production has it. Both bugs must be demonstrable.
// ---------------------------------------------------------------------------
console.log('\n--- 056: the bugs are real ------------------------------------');
await db.exec(migration('056_search_passages_two_stage.sql'));

// Bug 1: text search for the SEALED model's rows, with no embedding at all —
// exactly the Phase A path. It should find the two sealed passages.
let rows = await search(SEALED, null);
check(rows.length === 2,
  '[056] text-only search in the sealed space finds its 2 passages', `got ${rows.length}`);

// ...but a text-only search in the DEFAULT space cannot see them, and that is
// what every existing caller passes.
rows = await search(OPENAI, null);
check(rows.length === 1,
  '[056] BUG 1: the same text search under the default model sees only 1 of 3 — the sealed passages are invisible',
  `got ${rows.length}`);

// Under 056 the cross-space passage is not merely mis-scored, it is absent:
// stage B's model filter excludes it before stage C could score it. Bug 1
// MASKS bug 2 — which is why bug 2 has never been observed in production, and
// exactly why it has to be handled in the same migration that lifts the mask.
rows = await search(OPENAI, QUERY_VEC);
check(!rows.some((r) => /registered office/.test(r.text)),
  '[056] the sealed-space passage never even becomes a candidate (bug 1 hides bug 2)');

// ---------------------------------------------------------------------------
// 1b. The trap. Fix stage B ALONE — the obvious one-line fix — and the
//     cross-space scoring bug immediately becomes reachable. Derived from the
//     real 061 file by stripping only its stage-C guard, so this variant
//     cannot drift away from what it is arguing about.
// ---------------------------------------------------------------------------
console.log('\n--- the naive fix: stage B only, no stage C guard --------------');
const guarded = fs.readFileSync(
  path.resolve(__dirname, '..', 'supabase', 'migrations', '061_search_model_scoped_vectors.sql'), 'utf8');
const naive = guarded
  .replace(/create or replace function public\.search_passages\(/,
    'create or replace function public.search_passages_naive(')
  .replace(
    `      (case when v_has_vec and p.embedding is not null
             and p.embedding_model   = p_embedding_model
             and p.embedding_version = p_embedding_version
            then 1 - (p.embedding <=> p_query_embedding)`,
    `      (case when v_has_vec and p.embedding is not null
            then 1 - (p.embedding <=> p_query_embedding)`);
check(naive !== guarded && /search_passages_naive/.test(naive),
  'derived the unguarded variant from the real 061 file');
await db.exec(naive);

const naiveRows = await q(
  `select text, vector_score from public.search_passages_naive($1::uuid[], $2, $3::vector, null, null, null, 0, 10, $4, 1)`,
  [[m.id], 'Ormsby', QUERY_VEC, OPENAI]);
const faked = naiveRows.find((r) => /registered office/.test(r.text));
check(faked !== undefined && Number(faked.vector_score) > 0.9,
  'BUG 2 CONFIRMED: with stage B fixed but stage C unguarded, a passage from a DIFFERENT space scores as a near-perfect vector match',
  faked ? `vector_score=${Number(faked.vector_score).toFixed(4)}` : 'not returned');

// ---------------------------------------------------------------------------
// 2. 061. Same queries, correct answers.
// ---------------------------------------------------------------------------
console.log('\n--- 061: fixed -------------------------------------------------');
await db.exec(migration('061_search_model_scoped_vectors.sql'));

rows = await search(OPENAI, null);
check(rows.length === 3,
  '[061] text-only search finds ALL 3 passages regardless of model', `got ${rows.length}`);

rows = await search(SEALED, null);
check(rows.length === 3, '[061] and the same 3 from the sealed space', `got ${rows.length}`);

rows = await search(OPENAI, QUERY_VEC);
const still = rows.find((r) => /registered office/.test(r.text));
check(still !== undefined, '[061] the other-space passage is still RETURNED (text found it)');
check(still !== undefined && Number(still.vector_score) === 0,
  '[061] but it scores 0 on vector — no cross-space cosine',
  still ? `vector_score=${Number(still.vector_score)}` : 'missing');

const own = rows.find((r) => /whole dispute/.test(r.text));
check(own !== undefined && Number(own.vector_score) > 0.9,
  '[061] a passage in the query\'s own space still gets its real vector score',
  own ? `vector_score=${Number(own.vector_score).toFixed(4)}` : 'missing');

const unembedded = rows.find((r) => /no receipt/.test(r.text));
check(unembedded !== undefined && Number(unembedded.vector_score) === 0,
  '[061] the not-yet-embedded passage is returned on text alone');

// Ranking sanity: the passage in the query's own space should outrank the
// cross-space one, which is the practical point of the whole fix.
const iOwn = rows.findIndex((r) => /whole dispute/.test(r.text));
const iCross = rows.findIndex((r) => /registered office/.test(r.text));
check(iOwn < iCross, '[061] the genuinely-similar passage now ranks above the fake match',
  `own=#${iOwn + 1} cross=#${iCross + 1}`);

console.log(`\n${failures === 0 ? '061 verified: text is model-agnostic, vectors are model-scoped.' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
