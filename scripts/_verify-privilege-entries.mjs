// The privilege log across the matter (Discovery R3, migration 116).
//
//   A. 116 against a real Postgres (PGlite):
//      - refuses to run without 113/114; re-runnable; no SECURITY DEFINER;
//      - tagging a document Privileged drafts ONE entry at the document, from
//        its metadata; tagging it again (another list, another time) does not
//        draft a second; removing the tag keeps the entry;
//      - a document outside the matter cannot have an entry;
//      - into an OUTGOING production the item's entry is copied from the
//        document's and linked; blanks are filled from the item's metadata,
//        a reviewer's words are never overwritten;
//      - until the production is stamped, an edit to the document's entry
//        reaches the copy and an edit to the copy reaches the document's
//        entry (and from there the other unstamped productions);
//      - once stamped, the copy is frozen to the document: edits on either
//        side no longer travel;
//      - a document moved out of the matter does not fail the production;
//      - the backfill drafts entries for documents tagged before 116 (seeded
//        from a production's entry when there is one) and links old copies;
//      - a member manages only their matter's entries.
//   B. the app, held to its source.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-privilege-entries.mjs
//
// Offline and secret-free. 030 / 012 are stubbed the way
// _verify-discovery-sets.mjs stubs them; 113, 114 and 116 run for real.

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
const M113 = read('supabase', 'migrations', '113_document_review_tags.sql');
const M114 = read('supabase', 'migrations', '114_discovery_sets.sql');
const M116 = read('supabase', 'migrations', '116_document_privilege_entries.sql');
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  — ' + detail : ''}`);
};

const u = () => crypto.randomUUID();
const A = u(); const A_CHILD = u(); const B = u(); const ELSEWHERE = u();
const docMail = u(); const docOld = u(); const docMoved = u(); const docB = u(); const docPlain = u();
const defPriv = u(); const defPrivChild = u(); const defConf = u(); const defPrivB = u();
const prod1 = u(); const prod2 = u(); const prodOld = u(); const prodIn = u();
const USER = u();

const STUBS = `
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as
    $f$ select nullif(current_setting('test.uid', true), '')::uuid $f$;
  do $$ begin create type privilege_basis as enum
    ('attorney_client', 'work_product', 'marital', 'physician_patient', 'pastor_parishioner', 'custom');
  exception when duplicate_object then null; end $$;
  create table public.profiles (id uuid primary key);
  create table public.matterspaces (id uuid primary key, parent_matterspace_id uuid);
  create table public.documents (id uuid primary key, matterspace_id uuid not null references public.matterspaces(id),
    metadata jsonb not null default '{}');
  create table public.document_tag_defs (id uuid primary key, matterspace_id uuid not null, name text not null, behavior text);
  create table public.productions (id uuid primary key, matterspace_id uuid not null, direction text not null,
    status text not null default 'review');
  create table public.production_items (
    id uuid primary key default gen_random_uuid(), production_id uuid not null references public.productions(id),
    matterspace_id uuid not null, document_id uuid, source_metadata jsonb not null default '{}');
  create table public.document_tags (
    id uuid primary key default gen_random_uuid(), tag_def_id uuid not null references public.document_tag_defs(id),
    production_item_id uuid not null references public.production_items(id) on delete cascade,
    matterspace_id uuid not null, created_by uuid, unique (tag_def_id, production_item_id));
  create table public.privilege_log_entries (
    id uuid primary key default gen_random_uuid(), matterspace_id uuid not null, production_id uuid not null,
    production_item_id uuid not null unique, doc_date date, author text, addressee text, cc text, subject_matter text,
    basis privilege_basis not null default 'attorney_client', basis_custom text, description text,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now());
  create or replace function public._disc_matter_access(p_matter uuid) returns boolean
    language sql stable security invoker as
    $f$ select auth.uid() is not null and p_matter::text = any (string_to_array(current_setting('test.allowed', true), ',')) $f$;
  create or replace function public.matterspace_descendants(p_root uuid)
  returns table (id uuid) language sql stable as $f$
    with recursive tree as (
      select m.id from public.matterspaces m where m.id = p_root
      union all
      select c.id from public.matterspaces c join tree t on c.parent_matterspace_id = t.id
    ) select id from tree $f$;
  grant usage on schema public, auth to authenticated, anon, service_role;
  grant select on public.matterspaces, public.documents, public.profiles, public.document_tag_defs, public.productions to authenticated;
  grant select, update on public.privilege_log_entries to authenticated;
  grant execute on function public._disc_matter_access(uuid), public.matterspace_descendants(uuid) to authenticated;
`;

console.log('\n--- A. migration 116 ---------------------------------------------------');
{
  const db = new PGlite();
  await db.exec(STUBS);

  let early = null;
  try { await db.exec(M116); } catch (e) { early = e; }
  check(Boolean(early) && /needs migrations 113 and 114/.test(early.message), '116 pasted before 113/114: refuses with a sentence naming them', early?.message);

  await db.exec(M113);
  await db.exec(M114);

  // Before 116: a document already tagged Privileged, already in a production
  // whose reviewer wrote the entry by hand.
  await db.query('insert into public.profiles values ($1)', [USER]);
  await db.query('insert into public.matterspaces values ($1,null),($2,$1),($3,null),($4,null)', [A, A_CHILD, B, ELSEWHERE]);
  await db.query(`insert into public.documents (id, matterspace_id, metadata) values
    ($1,$2,$3::jsonb),($4,$2,'{}'),($5,$6,'{}'),($7,$8,'{}'),($9,$2,'{}')`,
    [docMail, A, JSON.stringify({ date: 'Fri, 5 Jan 2024 09:12:00 -0800', author: 'J. Patel', to: 'R. Iyer (counsel)', subject: 'Bonus terms' }),
      docOld, docMoved, A_CHILD, docB, B, docPlain]);
  await db.query('insert into public.document_tag_defs values ($1,$2,$3,$4),($5,$2,$6,null),($7,$8,$3,$4),($9,$10,$3,$4)',
    [defPriv, A, 'Privileged', 'privileged', defConf, 'Confidential', defPrivChild, A_CHILD, defPrivB, B]);
  await db.query(`insert into public.productions values ($1,$2,'outgoing','review'),($3,$2,'outgoing','review'),
    ($4,$2,'outgoing','packaged'),($5,$2,'incoming','received')`, [prod1, A, prod2, prodOld, prodIn]);
  await db.query('insert into public.document_review_tags (tag_def_id, document_id, matterspace_id) values ($1,$2,$3)', [defPriv, docOld, A]);
  const oldItem = (await db.query(
    'insert into public.production_items (production_id, matterspace_id, document_id) values ($1,$2,$3) returning id',
    [prodOld, A, docOld])).rows[0].id;
  await db.query("update public.privilege_log_entries set description = 'Advice on the bonus (hand-written)', basis = 'work_product' where production_item_id = $1", [oldItem]);

  await db.exec(M116);
  let rerun = null;
  try { await db.exec(M116); } catch (e) { rerun = e; }
  check(!rerun, '116 is re-runnable (pasted twice)', rerun?.message);

  const definers = await db.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef`);
  check(definers.rows.length === 0, '113 + 114 + 116 create no SECURITY DEFINER function', JSON.stringify(definers.rows));

  const entryOf = async (doc, matter = A) => (await db.query(
    'select * from public.document_privilege_entries where document_id = $1 and matterspace_id = $2', [doc, matter])).rows;

  // Backfill.
  const old = await entryOf(docOld);
  check(old.length === 1 && old[0].description === 'Advice on the bonus (hand-written)' && old[0].basis === 'work_product',
    'backfill: a document tagged before 116 gets its entry, seeded from the reviewer\'s production entry', JSON.stringify(old));
  const oldCopy = (await db.query('select document_entry_id, description from public.privilege_log_entries where production_item_id = $1', [oldItem])).rows[0];
  check(oldCopy.document_entry_id === old[0]?.id && oldCopy.description === 'Advice on the bonus (hand-written)',
    'backfill: the old production entry is linked, its words unchanged', JSON.stringify(oldCopy));

  // Tagging drafts one entry, from the document's metadata.
  await db.query('insert into public.document_review_tags (tag_def_id, document_id, matterspace_id) values ($1,$2,$3),($4,$2,$3)', [defPriv, docMail, A, defConf]);
  const mail = await entryOf(docMail);
  check(mail.length === 1 && mail[0].author === 'J. Patel' && mail[0].addressee === 'R. Iyer (counsel)'
    && mail[0].subject_matter === 'Bonus terms' && mail[0].doc_date && new Date(mail[0].doc_date).toISOString().startsWith('2024-01-05'),
    'tagging Privileged drafts the document\'s entry from its metadata (an email date parses)', JSON.stringify(mail));
  await db.query('insert into public.document_review_tags (tag_def_id, document_id, matterspace_id) values ($1,$2,$3)', [defConf, docPlain, A]);
  check((await entryOf(docPlain)).length === 0, 'tagging Confidential drafts nothing');
  await db.query('insert into public.document_review_tags (tag_def_id, document_id, matterspace_id) values ($1,$2,$3)', [defPrivChild, docMoved, A_CHILD]);
  check((await entryOf(docMoved, A_CHILD)).length === 1 && (await entryOf(docMoved, A)).length === 0,
    'a folder\'s own Privileged tag drafts the folder\'s entry, not the parent\'s');

  let outside = null;
  try {
    await db.query('insert into public.document_privilege_entries (matterspace_id, document_id) values ($1,$2)', [A, docB]);
  } catch (e) { outside = e; }
  check(Boolean(outside) && /not filed in this matter/.test(outside.message), 'an entry for a document outside the matter is refused', outside?.message ?? 'accepted');

  await db.query("update public.document_privilege_entries set description = 'Seeks legal advice on bonus terms' where id = $1", [mail[0].id]);
  await db.query('delete from public.document_review_tags where tag_def_id = $1 and document_id = $2', [defPriv, docMail]);
  check((await entryOf(docMail)).length === 1, 'removing the Privileged tag keeps the entry (the work is not lost)');
  await db.query('insert into public.document_review_tags (tag_def_id, document_id, matterspace_id) values ($1,$2,$3)', [defPriv, docMail, A]);
  const again = await entryOf(docMail);
  check(again.length === 1 && again[0].description === 'Seeks legal advice on bonus terms', 'tagging it again does not draft a second entry or wipe the first');

  // Into productions.
  const insertItem = async (prod, doc, meta = {}) => (await db.query(
    'insert into public.production_items (production_id, matterspace_id, document_id, source_metadata) values ($1,$2,$3,$4::jsonb) returning id',
    [prod, A, doc, JSON.stringify(meta)])).rows[0].id;
  const copyOf = async (item) => (await db.query('select * from public.privilege_log_entries where production_item_id = $1', [item])).rows[0];

  const i1 = await insertItem(prod1, docMail, { author: 'Someone Else', cc: 'K. Shah' });
  const c1 = await copyOf(i1);
  check(c1 && c1.document_entry_id === again[0].id && c1.description === 'Seeks legal advice on bonus terms' && c1.author === 'J. Patel',
    'into an outgoing production: the entry is copied from the document\'s and linked; the document\'s author wins', JSON.stringify(c1));
  check(c1?.cc === 'K. Shah' && (await entryOf(docMail))[0].cc === 'K. Shah', 'a blank (cc) is filled from the item\'s metadata, on both');
  const i2 = await insertItem(prod2, docMail);
  const iIn = await insertItem(prodIn, docMail);
  check(!(await copyOf(iIn)), 'into an incoming production: no entry');

  await db.query("update public.document_privilege_entries set subject_matter = 'Bonus terms (2024)' where id = $1", [again[0].id]);
  check((await copyOf(i1)).subject_matter === 'Bonus terms (2024)' && (await copyOf(i2)).subject_matter === 'Bonus terms (2024)',
    'before stamping: an edit at the document reaches every production\'s copy');
  await db.query("update public.privilege_log_entries set basis = 'work_product' where production_item_id = $1", [i1]);
  check((await entryOf(docMail))[0].basis === 'work_product' && (await copyOf(i2)).basis === 'work_product',
    'before stamping: an edit in one production reaches the document and the other production');

  await db.query("update public.productions set status = 'stamped' where id = $1", [prod1]);
  await db.query("update public.document_privilege_entries set description = 'Changed after stamping' where id = $1", [again[0].id]);
  check((await copyOf(i1)).description === 'Seeks legal advice on bonus terms' && (await copyOf(i2)).description === 'Changed after stamping',
    'after stamping: the stamped production keeps its words; the unstamped one still follows');
  await db.query("update public.privilege_log_entries set author = 'Edited in the stamped production' where production_item_id = $1", [i1]);
  check((await entryOf(docMail))[0].author === 'J. Patel', 'after stamping: an edit in the stamped production stays in it');

  // A document that left the matter after it was tagged.
  await db.query('update public.documents set matterspace_id = $1 where id = $2', [ELSEWHERE, docOld]);
  await db.query('delete from public.document_privilege_entries where document_id = $1', [docOld]);
  let moved = null; let iMoved = null;
  try { iMoved = await insertItem(prod2, docOld, { author: 'From the item' }); } catch (e) { moved = e; }
  const cm = iMoved ? await copyOf(iMoved) : null;
  check(!moved && cm && cm.document_entry_id === null && cm.author === 'From the item',
    'a document moved out of the matter does not fail the production; its entry is drafted from the item', moved?.message ?? JSON.stringify(cm));

  // Tagged in the Review Room: the production's entry comes first (from the
  // item's metadata), then the tag reaches the document.
  const docRoom = u(); const docRoom2 = u();
  await db.query("insert into public.documents (id, matterspace_id) values ($1,$2),($3,$2)", [docRoom, A, docRoom2]);
  const iRoom = await insertItem(prod2, docRoom);
  await db.query(`insert into public.privilege_log_entries (matterspace_id, production_id, production_item_id, author, subject_matter)
    values ($1,$2,$3,'From the email header','Board minutes')`, [A, prod2, iRoom]);
  await db.query('insert into public.document_review_tags (tag_def_id, document_id, matterspace_id) values ($1,$2,$3)', [defPriv, docRoom, A]);
  const room = await entryOf(docRoom);
  const roomCopy = await copyOf(iRoom);
  check(room.length === 1 && room[0].author === 'From the email header' && roomCopy.document_entry_id === room[0].id,
    'Review Room order (item entry first, then the tag): the document entry takes the item\'s words and the copy is linked', JSON.stringify({ room, roomCopy }));

  // An item entry drafted for a document that already has its entry: linked
  // at insert, the document's words win, the item fills the blanks both ways.
  await db.query('insert into public.document_review_tags (tag_def_id, document_id, matterspace_id) values ($1,$2,$3)', [defPriv, docRoom2, A]);
  await db.query("update public.document_privilege_entries set author = 'Reviewer wrote this' where document_id = $1 and matterspace_id = $2", [docRoom2, A]);
  const iRoom2 = (await db.query(
    'insert into public.production_items (production_id, matterspace_id, document_id) values ($1,$2,$3) returning id',
    [prodIn, A, docRoom2])).rows[0].id; // incoming: the item trigger drafts nothing
  await db.query(`insert into public.privilege_log_entries (matterspace_id, production_id, production_item_id, author, cc)
    values ($1,$2,$3,'Item author','Item cc')`, [A, prod2, iRoom2]);
  const c2 = await copyOf(iRoom2);
  const d2 = (await entryOf(docRoom2))[0];
  check(c2.document_entry_id === d2.id && c2.author === 'Reviewer wrote this' && c2.cc === 'Item cc' && d2.cc === 'Item cc',
    'an entry drafted later is linked at insert: the document\'s author wins, the item\'s cc fills both', JSON.stringify({ c2, d2 }));
  await db.query("update public.document_privilege_entries set description = 'x' where id = $1", [d2.id]);
  check((await copyOf(iRoom2)).cc === 'Item cc', 'the next edit at the document does not blank what the item filled in');

  // RLS.
  const asMember = async (sql, params = []) => {
    await db.exec(`set test.uid = '${USER}'; set test.allowed = '${[A, A_CHILD].join(',')}'; set role authenticated`);
    try { return { res: await db.query(sql, params), err: null }; }
    catch (e) { return { res: null, err: e }; }
    finally { await db.exec('reset role'); }
  };
  await db.query('insert into public.document_review_tags (tag_def_id, document_id, matterspace_id) values ($1,$2,$3)', [defPrivB, docB, B]);
  const seen = await asMember('select matterspace_id from public.document_privilege_entries');
  check(!seen.err && seen.res.rows.length > 0 && seen.res.rows.every((r) => r.matterspace_id === A || r.matterspace_id === A_CHILD),
    'a member sees only their matter\'s entries', seen.err?.message ?? JSON.stringify(seen.res?.rows));
  const upd = await asMember("update public.document_privilege_entries set description = 'theirs' where matterspace_id = $1 returning id", [B]);
  check(!upd.err && upd.res.rows.length === 0, 'a member cannot edit another matter\'s entry');
  const ins = await asMember('insert into public.document_privilege_entries (matterspace_id, document_id) values ($1,$2)', [B, docB]);
  check(Boolean(ins.err), 'a member cannot add an entry in another matter', ins.err?.message ?? 'accepted');
  const own = await asMember("update public.document_privilege_entries set description = 'mine' where document_id = $1 and matterspace_id = $2 returning id", [docMail, A]);
  check(!own.err && own.res.rows.length === 1, 'a member edits their own matter\'s entry', own.err?.message);
}

console.log('\n--- B. the app, held to its source -------------------------------------');
{
  const lib = read('src', 'lib', 'discovery.ts');
  const tab = read('src', 'pages', 'discovery', 'PrivilegeLogTab.tsx');
  const panel = read('src', 'components', 'vault', 'ImportPanel.tsx');
  check(/from\('document_privilege_entries'\)/.test(lib), 'the app reads and writes document_privilege_entries');
  check(/privilegedDocIds/.test(tab) && /toCsv|privilegeLogCsv/.test(tab + lib), 'the matter log lists documents tagged Privileged now, and exports CSV');
  check(/listVaultReviewChips/.test(panel) && !/applyReviewTag|removeReviewTag/.test(panel),
    'the Vault shows tag chips read-only (no tagging there)');
  const chips = lib.slice(lib.indexOf('export async function listVaultReviewChips'));
  check(/\.in\('document_id'/.test(chips.slice(0, 1500)), 'Vault chips: one batched query per chunk of the listed documents');
}

if (failures) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall checks passed');
