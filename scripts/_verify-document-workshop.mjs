// Verification for migration 106 (document_workshop_items — the Workshop
// beside a book). Modelled on _verify-document-animations.mjs (062).
//
//   npm i --no-save @electric-sql/pglite     # never a repo dependency
//   node scripts/_verify-document-workshop.mjs
//
// Runs the REAL migration in PGlite on stubs for auth.uid(), public.documents,
// 001's update_updated_at() and 048's _docann_doc_access(), then checks:
//   * table, indexes, RLS, the four policies;
//   * the shape rule: a snip needs a rect, a snippet needs text, a media item
//     needs a file; a quarter turn only; page positive;
//   * cascades: deleting the book, the file, or the source takes the rows;
//   * the policies as a NON-SUPERUSER: a stranger sees and writes nothing, and
//     a media item cannot point at a file outside the author's reach.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(HERE, '..', 'supabase', 'migrations', '106_document_workshop.sql');

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
const OTHER_CLIP = 'aaaaaaaa-0000-0000-0000-000000000003';
const RECT = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };

const asUser = async (uid, sql, params) => {
  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${uid}';`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec('reset role;');
  }
};

await db.exec(`
  create schema if not exists auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table public.documents (id uuid primary key, matterspace_id uuid);
  create function public.update_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at = now(); return new; end $$;
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
  insert into public.test_access (user_id, document_id)
    values ('${ALICE}', '${BOOK}'), ('${ALICE}', '${CLIP}');
`);

console.log('\nmigration 106');
try {
  await db.exec(await fs.readFile(MIGRATION, 'utf8'));
  pass('106_document_workshop.sql executes on Postgres');
} catch (e) {
  fail('the migration did not execute', e.message);
  console.log(`\n${failures} failure(s)\n`);
  process.exit(1);
}
await db.exec('grant select, insert, update, delete on public.document_workshop_items to authenticated;');

console.log('\nstructure');
{
  const { rows } = await db.query(`select indexname from pg_indexes where tablename = 'document_workshop_items' order by indexname`);
  const names = rows.map((r) => r.indexname);
  if (['document_page', 'parent', 'media'].every((k) => names.some((n) => n.includes(k)))) pass(`indexes on (document_id, page), parent_id, media_document_id — ${names.length} total`);
  else fail('expected indexes are missing', names.join(', '));
}
{
  const { rows } = await db.query(`select relrowsecurity from pg_class where relname = 'document_workshop_items'`);
  if (rows[0]?.relrowsecurity) pass('row-level security is enabled');
  else fail('RLS is NOT enabled');
}
{
  const { rows } = await db.query(`select cmd, count(*)::int as n from pg_policies where tablename = 'document_workshop_items' group by cmd order by cmd`);
  const byCmd = Object.fromEntries(rows.map((r) => [r.cmd, r.n]));
  if (['SELECT', 'INSERT', 'UPDATE', 'DELETE'].every((c) => byCmd[c] === 1)) pass('one policy each for select / insert / update / delete');
  else fail('policy set is wrong', JSON.stringify(byCmd));
}

console.log('\nshape');
const ins = (uid, row) => asUser(uid,
  `insert into public.document_workshop_items (document_id, user_id, page, kind, rect, turn, text, media_document_id, parent_id)
   values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id, turn, sort_order, updated_at`,
  [row.doc ?? BOOK, row.user ?? uid, row.page ?? 3, row.kind, row.rect ?? null, row.turn ?? 0, row.text ?? null, row.media ?? null, row.parent ?? null]);

{
  const { rows } = await ins(ALICE, { kind: 'snip', rect: RECT });
  if (rows[0]?.turn === 0 && rows[0]?.sort_order === 0) pass('a snip: defaults turn 0, sort_order 0');
  else fail('defaults are wrong', JSON.stringify(rows[0]));
}
{
  const { rows } = await ins(ALICE, { kind: 'snippet', text: 'The coronation was postponed.' });
  if (rows[0]?.id) pass('a snippet with text');
  else fail('a snippet was refused');
}
for (const [what, bad] of [
  ['a snip without a rect', { kind: 'snip' }],
  ['a snippet without text', { kind: 'snippet' }],
  ['a media item without a file', { kind: 'media' }],
  ['a snip carrying a file', { kind: 'snip', rect: RECT, media: CLIP }],
  ['an unknown kind', { kind: 'plate', rect: RECT }],
  ['a turn that is not a quarter turn', { kind: 'snip', rect: RECT, turn: 45 }],
  ['page 0', { kind: 'snip', rect: RECT, page: 0 }],
]) {
  try { await ins(ALICE, bad); fail(`${what} was accepted`); }
  catch { pass(`${what} is refused`); }
}
{
  const { rows: before } = await db.query(`select id, updated_at from public.document_workshop_items where kind = 'snip' limit 1`);
  await new Promise((r) => setTimeout(r, 5));
  await db.query(`update public.document_workshop_items set turn = 90 where id = $1`, [before[0].id]);
  const { rows: after } = await db.query(`select updated_at from public.document_workshop_items where id = $1`, [before[0].id]);
  if (new Date(after[0].updated_at) > new Date(before[0].updated_at)) pass('updated_at moves on update (001 trigger)');
  else fail('updated_at did not move');
}
await db.exec('delete from public.document_workshop_items;');

console.log('\ncascades');
{
  const { rows: s } = await ins(ALICE, { kind: 'snip', rect: RECT });
  await ins(ALICE, { kind: 'media', media: CLIP, parent: s[0].id });
  await db.query('delete from public.document_workshop_items where id = $1', [s[0].id]);
  const { rows } = await db.query('select count(*)::int as n from public.document_workshop_items');
  if (rows[0].n === 0) pass('deleting a source takes what sits under it');
  else fail(`deleting the source left ${rows[0].n} row(s)`);
}
for (const [what, victim] of [['the book', BOOK], ['the file', CLIP]]) {
  await db.exec(`insert into public.documents (id) values ('${BOOK}'), ('${CLIP}') on conflict do nothing;`);
  await ins(ALICE, { kind: 'media', media: CLIP });
  await db.exec(`delete from public.documents where id = '${victim}';`);
  const { rows } = await db.query('select count(*)::int as n from public.document_workshop_items');
  if (rows[0].n === 0) pass(`deleting ${what} takes its workshop rows with it`);
  else fail(`deleting ${what} left ${rows[0].n} orphan row(s)`);
  await db.exec(`insert into public.documents (id) values ('${BOOK}'), ('${CLIP}') on conflict do nothing; delete from public.document_workshop_items;`);
}

console.log('\npolicies (role authenticated, RLS enforced)');
{
  const { rows } = await ins(ALICE, { kind: 'media', media: CLIP });
  if (rows[0]?.id) pass('the author may put a file she can reach on the bench (insert … returning works)');
  else fail('the author could not insert');
}
try { await ins(ALICE, { kind: 'media', media: OTHER_CLIP }); fail('a media item was allowed to point at a file from another matter'); }
catch { pass('pointing at a file outside her reach is refused — no cross-matter leak'); }
try { await ins(BOB, { kind: 'snip', rect: RECT }); fail('a stranger was allowed to snip'); }
catch { pass('a user without document access cannot write to the bench'); }
{
  const { rows } = await asUser(BOB, 'select id from public.document_workshop_items');
  if (rows.length === 0) pass("a stranger sees none of the author's bench");
  else fail(`a stranger saw ${rows.length} row(s)`);
}
{
  const { rows } = await asUser(BOB, 'delete from public.document_workshop_items returning id');
  if (rows.length === 0) pass("a stranger cannot clear the author's bench");
  else fail(`a stranger deleted ${rows.length} row(s)`);
}
{
  const { rows } = await asUser(ALICE, 'select id from public.document_workshop_items');
  if (rows.length === 1) pass('the author still sees her own item');
  else fail(`the author saw ${rows.length} rows`);
}

await db.close();
console.log(failures ? `\n${failures} failure(s)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
