// Review tags on matter documents (Discovery R1, migration 113).
//
// A tag now sits on the DOCUMENT, so the Review tab and every later production
// see one tag. This proves:
//
//   A. 113 against a real Postgres (PGlite), as `authenticated`:
//      - a member tags documents in the matter, its folder and its folder's
//        folder; the same tag twice is refused by the unique key;
//      - refused: a document in another firm's matter, a document in the
//        PARENT of a folder's tag list, a tag definition from another matter,
//        a re-pointing UPDATE to a foreign document, and any row in a matter
//        the member cannot open (RLS); rows there are invisible;
//      - deleting a document or a tag definition removes its review tags;
//      - 113 is re-runnable and refuses to run without 030 / 012;
//      - 113 creates no SECURITY DEFINER function (the migration-022 rule).
//   B. the app, held to its source: Discovery has a Review tab, the Review
//      Room writes a production tag through to the matter document, and the
//      bulk calls go to document_review_tags.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-review-tags.mjs
//
// Offline and secret-free: no .env, no network, no production. 030 and 012
// are represented by stubs of the two functions 113 relies on
// (_disc_matter_access, matterspace_descendants) and the tables it references.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const MIG = read('supabase', 'migrations', '113_document_review_tags.sql');
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  — ' + detail : ''}`);
};

const u = () => crypto.randomUUID();
// A has a folder (A_CHILD) with its own folder (A_GRAND). B is another firm's.
const A = u(); const A_CHILD = u(); const A_GRAND = u(); const B = u();
const parentOf = { [A]: null, [A_CHILD]: A, [A_GRAND]: A_CHILD, [B]: null };
const docA = u(); const docChild = u(); const docGrand = u(); const docB = u(); const docGone = u();
const docMatter = { [docA]: A, [docChild]: A_CHILD, [docGrand]: A_GRAND, [docB]: B, [docGone]: A };
const defA = u(); const defA2 = u(); const defChild = u(); const defB = u();
const defMatter = { [defA]: A, [defA2]: A, [defChild]: A_CHILD, [defB]: B };
const USER = u();

// ---------------------------------------------------------------------------
console.log('\n--- A. migration 113, as authenticated ---------------------------------');
{
  const db = new PGlite();
  await db.exec(`
    do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
    do $$ begin create role anon; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid language sql stable as
      $f$ select nullif(current_setting('test.uid', true), '')::uuid $f$;
    create table public.profiles (id uuid primary key);
    create table public.matterspaces (id uuid primary key, parent_matterspace_id uuid);
    create table public.documents (id uuid primary key, matterspace_id uuid not null references public.matterspaces(id));
    grant usage on schema public, auth to authenticated, anon, service_role;
    grant select on public.matterspaces, public.documents, public.profiles to authenticated;
  `);

  let early = null;
  try { await db.exec(MIG); } catch (e) { early = e; }
  check(Boolean(early) && /needs migration 030/.test(early.message), '113 pasted before 030: refuses with a sentence naming 030', early?.message);

  // Stand-ins for what 030 provides: tag definitions and the INVOKER access
  // wrapper (here: the member may open the matters listed in test.allowed).
  await db.exec(`
    create table public.document_tag_defs (id uuid primary key, matterspace_id uuid not null, name text not null);
    grant select on public.document_tag_defs to authenticated;
    create or replace function public._disc_matter_access(p_matter uuid) returns boolean
      language sql stable security invoker as
      $f$ select auth.uid() is not null and p_matter::text = any (string_to_array(current_setting('test.allowed', true), ',')) $f$;
    grant execute on function public._disc_matter_access(uuid) to authenticated;
  `);
  let no012 = null;
  try { await db.exec(MIG); } catch (e) { no012 = e; }
  check(Boolean(no012) && /needs migration 012/.test(no012.message), '113 pasted before 012: refuses with a sentence naming 012', no012?.message);

  await db.exec(`
    create or replace function public.matterspace_descendants(p_root uuid)
    returns table (id uuid) language sql stable as $f$
      with recursive tree as (
        select m.id from public.matterspaces m where m.id = p_root
        union all
        select c.id from public.matterspaces c join tree t on c.parent_matterspace_id = t.id
      ) select id from tree $f$;
    grant execute on function public.matterspace_descendants(uuid) to authenticated;
  `);

  await db.exec(MIG);
  let rerun = null;
  try { await db.exec(MIG); } catch (e) { rerun = e; }
  check(!rerun, '113 is re-runnable (pasted twice)', rerun?.message);

  const definers = await db.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef and p.proname like '%review%'`);
  check(definers.rows.length === 0, '113 creates no SECURITY DEFINER function', JSON.stringify(definers.rows));

  await db.query('insert into public.profiles values ($1)', [USER]);
  for (const [id, parent] of Object.entries(parentOf)) await db.query('insert into public.matterspaces values ($1,$2)', [id, parent]);
  for (const [id, m] of Object.entries(docMatter)) await db.query('insert into public.documents values ($1,$2)', [id, m]);
  for (const [id, m] of Object.entries(defMatter)) await db.query('insert into public.document_tag_defs values ($1,$2,$3)', [id, m, 't']);

  // The member may open A and its folders, never B.
  const allowed = [A, A_CHILD, A_GRAND].join(',');
  const asMember = async (sql, params = []) => {
    await db.exec(`set test.uid = '${USER}'; set test.allowed = '${allowed}'; set role authenticated`);
    try { return { res: await db.query(sql, params), err: null }; }
    catch (e) { return { res: null, err: e }; }
    finally { await db.exec('reset role'); }
  };
  const tag = (def, doc, matter) => asMember(
    'insert into public.document_review_tags (tag_def_id, document_id, matterspace_id, created_by) values ($1,$2,$3,$4) returning id',
    [def, doc, matter, USER]);

  const ACCEPT = [
    ['a document in the matter itself', defA, docA, A],
    ['a document in the matter\'s folder', defA, docChild, A],
    ['a document in the folder\'s folder', defA, docGrand, A],
    ['a folder\'s own tag list, a document below it', defChild, docGrand, A_CHILD],
    ['a second tag on the same document', defA2, docA, A],
  ];
  for (const [label, def, doc, matter] of ACCEPT) {
    const { err } = await tag(def, doc, matter);
    check(!err, `accepted — ${label}`, err?.message);
  }

  const REFUSE = [
    ['the same tag on the same document twice', defA, docA, A, '23505'],
    ['a document in another firm\'s matter', defA, docB, A, '42501'],
    ['a folder\'s tag list, a document in its PARENT matter', defChild, docA, A_CHILD, '42501'],
    ['a tag definition from another matter', defB, docA, A, '42501'],
    ['a tag definition from the folder, filed under the parent', defChild, docChild, A, '42501'],
    ['a document id that does not exist', defA, u(), A, null],
    ['a row in a matter the member cannot open (B)', defB, docB, B, null],
  ];
  for (const [label, def, doc, matter, code] of REFUSE) {
    const { err } = await tag(def, doc, matter);
    check(Boolean(err) && (!code || err.code === code), `refused — ${label}`, err ? `${err.code} ${err.message}` : 'accepted');
  }

  // A row in B written by the service role stays invisible to the member.
  await db.query('insert into public.document_review_tags (tag_def_id, document_id, matterspace_id) values ($1,$2,$3)', [defB, docB, B]);
  const seen = await asMember('select matterspace_id from public.document_review_tags');
  check(!seen.err && seen.res.rows.length === 5 && seen.res.rows.every((r) => r.matterspace_id !== B),
    'the member sees their 5 rows and none of B\'s', seen.err?.message ?? JSON.stringify(seen.res.rows.length));

  const repoint = await asMember('update public.document_review_tags set document_id = $1 where document_id = $2 and tag_def_id = $3', [docB, docGrand, defA]);
  check(Boolean(repoint.err) && repoint.err.code === '42501', 'refused — re-pointing a tag at another firm\'s document', repoint.err?.message ?? 'updated');

  const upsert = await asMember(
    'insert into public.document_review_tags (tag_def_id, document_id, matterspace_id) values ($1,$2,$3) on conflict (tag_def_id, document_id) do nothing',
    [defA, docA, A]);
  check(!upsert.err, 'bulk tagging (on conflict do nothing) skips an existing tag', upsert.err?.message);

  const del = await asMember('delete from public.document_review_tags where tag_def_id = $1 and document_id = any($2::uuid[]) returning id', [defA2, [docA]]);
  check(!del.err && del.res.rows.length === 1, 'the member removes a tag', del.err?.message);

  await tag(defA, docGone, A);
  await db.query('delete from public.documents where id = $1', [docGone]);
  const afterDoc = await db.query('select 1 from public.document_review_tags where document_id = $1', [docGone]);
  check(afterDoc.rows.length === 0, 'deleting a document removes its review tags');
  await db.query('delete from public.document_tag_defs where id = $1', [defChild]);
  const afterDef = await db.query('select 1 from public.document_review_tags where tag_def_id = $1', [defChild]);
  check(afterDef.rows.length === 0, 'deleting a tag definition removes its review tags');

  const anon = await (async () => {
    await db.exec('set role anon');
    try { await db.query('select 1 from public.document_review_tags'); return null; }
    catch (e) { return e; } finally { await db.exec('reset role'); }
  })();
  check(Boolean(anon), 'anon cannot read review tags');
}

// ---------------------------------------------------------------------------
console.log('\n--- B. the app, held to its source -------------------------------------');
{
  const lib = read('src', 'lib', 'discovery.ts');
  const home = read('src', 'pages', 'discovery', 'DiscoveryHome.tsx');
  const room = read('src', 'pages', 'discovery', 'ReviewRoom.tsx');
  const tab = read('src', 'pages', 'discovery', 'ReviewTab.tsx');

  check(/import ReviewTab from '\.\/ReviewTab'/.test(home) && /<ReviewTab matterId=\{matter\.id\} \/>/.test(home),
    'Discovery renders the Review tab for the matter');
  check(/from\('document_review_tags'\)[\s\S]{0,80}\.upsert\(/.test(lib) && /onConflict: 'tag_def_id,document_id'/.test(lib),
    'bulk tagging upserts into document_review_tags, skipping existing tags');
  check(/from\('document_review_tags'\)[\s\S]{0,40}\.delete\(\)/.test(lib), 'untagging deletes from document_review_tags');
  check(/if \(selected\.document_id\)[\s\S]{0,200}applyReviewTag\(def\.id, \[selected\.document_id\], production\.matterspace_id\)/.test(room)
    && /removeReviewTag\(def\.id, \[selected\.document_id\]\)/.test(room),
    'the Review Room writes a production tag through to the matter document');
  check(/listReviewDocuments\(matterId\)/.test(tab) && /listReviewTags\(matterId\)/.test(tab),
    'the Review tab lists every matter document with its review tags');
  check(/isReviewTagsMissing/.test(tab) && /isReviewTagsMissing/.test(room),
    'before 113 is pasted, the Review tab and Review Room say so instead of failing');
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
