// Verification for migration 062 (document_animations — living illustrations).
//
//   npm i --no-save @electric-sql/pglite     # never a repo dependency
//   node scripts/_verify-document-animations.mjs
//
// Runs the REAL migration file in PGlite (Postgres compiled to WASM), on top
// of stubs for the things it leans on — auth.uid(), public.documents, and
// 048's SECURITY INVOKER wrapper _docann_doc_access() — and then checks the
// parts that would only fail in production:
//   * the table, its indexes, RLS, and the four policies exist;
//   * the shape rules (turn is a quarter turn, page is positive, defaults);
//   * cascades (deleting the book, or the clip, takes the animation with it);
//   * the policies themselves, as a NON-SUPERUSER role, which is the only way
//     row-level security is actually exercised: another user cannot see or
//     write your animations, and nobody can point an animation at a clip they
//     have no access to (the cross-matter leak this table must not allow).
//
// Not covered: the real _docann_doc_access / _mtspc_select_check chain, which
// needs the production schema — verify that with a real session after the
// migration is applied (see scripts/_verify-marginalia-rls.mjs).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(HERE, '..', 'supabase', 'migrations', '062_document_animations.sql');

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m, d) => {
  console.log(`  FAIL  ${m}${d !== undefined ? `\n        ${String(d).slice(0, 400)}` : ''}`);
  failures++;
};

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.log('\n  PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite\n');
  process.exit(2);
}

const db = new PGlite();
const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';
const BOOK = 'aaaaaaaa-0000-0000-0000-000000000001';
const CLIP = 'aaaaaaaa-0000-0000-0000-000000000002';
const OTHER_CLIP = 'aaaaaaaa-0000-0000-0000-000000000003';   // in a matter nobody here can reach

// SET LOCAL only lives inside a transaction, and PGlite commits statement by
// statement — so the role must be set for the session and reset afterwards,
// or everything runs as superuser and RLS is never exercised.
const asUser = async (uid, sql, params) => {
  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${uid}';`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec('reset role;');
  }
};

// ── stubs: what 062 leans on ────────────────────────────────────────────
await db.exec(`
  create schema if not exists auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  create table public.documents (id uuid primary key, matterspace_id uuid);

  -- Stands in for 048's wrapper: who may reach which document.
  create table public.test_access (user_id uuid, document_id uuid);
  create function public._docann_doc_access(p_document_id uuid)
    returns boolean language sql security invoker stable as $$
      select exists (
        select 1 from public.test_access
        where user_id = auth.uid() and document_id = p_document_id
      ) $$;

  create role authenticated;
  grant usage on schema public, auth to authenticated;
  grant select on public.documents, public.test_access to authenticated;
  grant execute on function public._docann_doc_access(uuid), auth.uid() to authenticated;

  insert into auth.users (id) values ('${ALICE}'), ('${BOB}');
  insert into public.documents (id) values ('${BOOK}'), ('${CLIP}'), ('${OTHER_CLIP}');
  -- Alice can reach the book and the clip; Bob can reach nothing.
  insert into public.test_access (user_id, document_id)
    values ('${ALICE}', '${BOOK}'), ('${ALICE}', '${CLIP}');
`);

// ── the real migration ──────────────────────────────────────────────────
console.log('\nmigration 062');
try {
  await db.exec(await fs.readFile(MIGRATION, 'utf8'));
  pass('062_document_animations.sql executes on Postgres');
} catch (e) {
  fail('the migration did not execute', e.message);
  console.log(`\n${failures} failure(s)\n`);
  process.exit(1);
}
await db.exec('grant select, insert, update, delete on public.document_animations to authenticated;');

// ── structure ───────────────────────────────────────────────────────────
console.log('\nstructure');
{
  const { rows } = await db.query(
    `select indexname from pg_indexes where tablename = 'document_animations' order by indexname`);
  const names = rows.map((r) => r.indexname);
  if (names.some((n) => n.includes('document_page')) && names.some((n) => n.includes('media')))
    pass(`indexes on (document_id, page) and (media_document_id) — ${names.length} total`);
  else fail('expected indexes are missing', names.join(', '));
}
{
  const { rows } = await db.query(
    `select relrowsecurity from pg_class where relname = 'document_animations'`);
  if (rows[0]?.relrowsecurity) pass('row-level security is enabled');
  else fail('RLS is NOT enabled — every row would be world-readable');
}
{
  const { rows } = await db.query(
    `select cmd, count(*)::int as n from pg_policies
      where tablename = 'document_animations' group by cmd order by cmd`);
  const byCmd = Object.fromEntries(rows.map((r) => [r.cmd, r.n]));
  const want = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
  if (want.every((c) => byCmd[c] === 1)) pass('one policy each for select / insert / update / delete');
  else fail('policy set is wrong', JSON.stringify(byCmd));
}

// ── shape rules ─────────────────────────────────────────────────────────
console.log('\nshape');
const insertAs = (uid, cols) => asUser(uid,
  `insert into public.document_animations (document_id, media_document_id, user_id, page, rect${cols.extra ?? ''})
   values ($1, $2, $3, $4, $5${cols.extraVals ?? ''}) returning id, turn, loops`,
  [cols.doc ?? BOOK, cols.media ?? CLIP, cols.user ?? uid, cols.page ?? 12, cols.rect ?? { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }]);

{
  const { rows } = await insertAs(ALICE, {});
  if (rows[0]?.turn === 0 && rows[0]?.loops === true) pass('defaults: turn 0, loops true');
  else fail('defaults are wrong', JSON.stringify(rows[0]));
  await db.exec('delete from public.document_animations;');
}
for (const [what, bad] of [['a turn that is not a quarter turn', { extra: ', turn', extraVals: ', 45' }],
                           ['page 0', { page: 0 }]]) {
  try {
    await insertAs(ALICE, bad);
    fail(`${what} was accepted`);
  } catch { pass(`${what} is refused`); }
}

// ── cascades ────────────────────────────────────────────────────────────
console.log('\ncascades');
for (const [what, victim] of [['the book', BOOK], ['the clip', CLIP]]) {
  await db.exec(`insert into public.documents (id) values ('${BOOK}'), ('${CLIP}') on conflict do nothing;`);
  await insertAs(ALICE, {});
  await db.exec(`delete from public.documents where id = '${victim}';`);
  const { rows } = await db.query('select count(*)::int as n from public.document_animations');
  if (rows[0].n === 0) pass(`deleting ${what} takes its animations with it`);
  else fail(`deleting ${what} left ${rows[0].n} orphan row(s)`);
  await db.exec(`insert into public.documents (id) values ('${BOOK}'), ('${CLIP}') on conflict do nothing;
                 delete from public.document_animations;`);
}

// ── the policies, as a real non-superuser ───────────────────────────────
console.log('\npolicies (role authenticated, RLS enforced)');
{
  const { rows } = await insertAs(ALICE, {});
  if (rows[0]?.id) pass('the author may attach a clip to a document she can reach (insert … returning works)');
  else fail('the author could not insert');
}
{
  try {
    await insertAs(ALICE, { media: OTHER_CLIP });
    fail('an animation was allowed to point at a clip from another matter');
  } catch { pass('pointing at a clip outside her reach is refused — no cross-matter leak'); }
}
{
  try {
    await insertAs(BOB, {});
    fail('a stranger was allowed to attach an animation');
  } catch { pass('a user without document access cannot attach'); }
}
{
  const { rows } = await asUser(BOB, 'select id from public.document_animations');
  if (rows.length === 0) pass("a stranger sees none of the author's animations");
  else fail(`a stranger saw ${rows.length} row(s)`);
}
{
  const { rows } = await asUser(BOB,
    `delete from public.document_animations returning id`);
  if (rows.length === 0) pass("a stranger cannot delete the author's animations");
  else fail(`a stranger deleted ${rows.length} row(s)`);
}
{
  const { rows } = await asUser(ALICE, 'select id, page from public.document_animations');
  if (rows.length === 1) pass('the author still sees her own animation');
  else fail(`the author saw ${rows.length} rows`);
}

await db.close();
console.log(failures ? `\n${failures} failure(s)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
