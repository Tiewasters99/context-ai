// Discovery sets, and tags that follow a document into a production
// (Discovery R2, migration 114).
//
//   A. 114 against a real Postgres (PGlite):
//      - refuses to run without 113; re-runnable; no SECURITY DEFINER;
//      - a member saves a set in their matter; a set in a matter they cannot
//        open is refused and invisible; two sets may not share a name;
//      - when a production item is created for a matter document, the
//        document's review tags IN THE PRODUCTION'S MATTER are copied onto the
//        item (document_tags) — never another matter's tags; an item with no
//        document gets none;
//      - a Privileged tag copied into an OUTGOING production drafts its
//        privilege-log entry from the item's metadata (a junk date becomes
//        null, never an error); into an INCOMING production it drafts nothing;
//      - productions record source_set_id / source_set_rule; deleting the set
//        leaves the production and clears the link.
//   B. the app, held to its source: exclusion tags win over a set's rule;
//      Privileged documents go into the production (to be withheld and
//      logged); a set cannot be produced until 113 and 114 are both in.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-discovery-sets.mjs
//
// Offline and secret-free. 030 / 012 / 113's dependencies are stubbed the way
// _verify-review-tags.mjs stubs them; 113 itself is run for real.

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
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  — ' + detail : ''}`);
};

const u = () => crypto.randomUUID();
const A = u(); const A_CHILD = u(); const B = u();
const docA = u(); const docChild = u(); const docPriv = u(); const docB = u();
const defConf = u(); const defPriv = u(); const defChildConf = u(); const defB = u();
const prodOut = u(); const prodIn = u(); const prodChild = u();
const USER = u();

console.log('\n--- A. migration 114 ---------------------------------------------------');
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
    create table public.document_tag_defs (id uuid primary key, matterspace_id uuid not null, name text not null, behavior text);
    create table public.productions (id uuid primary key, matterspace_id uuid not null, direction text not null);
    create table public.production_items (
      id uuid primary key default gen_random_uuid(), production_id uuid not null references public.productions(id),
      matterspace_id uuid not null, document_id uuid, source_metadata jsonb not null default '{}');
    create table public.document_tags (
      id uuid primary key default gen_random_uuid(), tag_def_id uuid not null references public.document_tag_defs(id),
      production_item_id uuid not null references public.production_items(id) on delete cascade,
      matterspace_id uuid not null, created_by uuid, unique (tag_def_id, production_item_id));
    create table public.privilege_log_entries (
      id uuid primary key default gen_random_uuid(), matterspace_id uuid not null, production_id uuid not null,
      production_item_id uuid not null unique, doc_date date, author text, addressee text, cc text, subject_matter text);
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
    grant execute on function public._disc_matter_access(uuid), public.matterspace_descendants(uuid) to authenticated;
  `);

  let early = null;
  try { await db.exec(M114); } catch (e) { early = e; }
  check(Boolean(early) && /needs migration 113/.test(early.message), '114 pasted before 113: refuses with a sentence naming 113', early?.message);

  await db.exec(M113);
  await db.exec(M114);
  let rerun = null;
  try { await db.exec(M114); } catch (e) { rerun = e; }
  check(!rerun, '114 is re-runnable (pasted twice)', rerun?.message);

  const definers = await db.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef`);
  check(definers.rows.length === 0, '113 + 114 create no SECURITY DEFINER function', JSON.stringify(definers.rows));

  await db.query('insert into public.profiles values ($1)', [USER]);
  await db.query('insert into public.matterspaces values ($1,null),($2,$1),($3,null)', [A, A_CHILD, B]);
  await db.query('insert into public.documents values ($1,$2),($3,$4),($5,$2),($6,$7)', [docA, A, docChild, A_CHILD, docPriv, docB, B]);
  await db.query('insert into public.document_tag_defs values ($1,$2,$3,null),($4,$2,$5,$6),($7,$8,$3,null),($9,$10,$3,null)',
    [defConf, A, 'Confidential', defPriv, 'Privileged', 'privileged', defChildConf, A_CHILD, defB, B]);
  await db.query("insert into public.productions values ($1,$2,'outgoing'),($3,$2,'incoming'),($4,$5,'outgoing')",
    [prodOut, A, prodIn, prodChild, A_CHILD]);
  // Review tags: docA Confidential (A); docPriv Privileged + Confidential (A);
  // docChild tagged in A's list AND in the folder's own list.
  await db.query(`insert into public.document_review_tags (tag_def_id, document_id, matterspace_id) values
    ($1,$2,$3),($4,$5,$3),($1,$5,$3),($1,$6,$3),($7,$6,$8)`,
    [defConf, docA, A, defPriv, docPriv, docChild, defChildConf, A_CHILD]);

  const tagsOf = async (itemId) => (await db.query(
    'select tag_def_id from public.document_tags where production_item_id = $1 order by tag_def_id', [itemId])).rows.map((r) => r.tag_def_id);
  const insertItem = async (prod, matter, doc, meta = {}) => (await db.query(
    'insert into public.production_items (production_id, matterspace_id, document_id, source_metadata) values ($1,$2,$3,$4::jsonb) returning id',
    [prod, matter, doc, JSON.stringify(meta)])).rows[0].id;

  const i1 = await insertItem(prodOut, A, docA);
  check(JSON.stringify(await tagsOf(i1)) === JSON.stringify([defConf]), 'an item for a tagged document gets its tag (Confidential)');

  const i2 = await insertItem(prodOut, A, docPriv, { date: '2024-08-14', author: 'J. Patel', to: 'Counsel', subject: 'Acceleration bonus' });
  check(JSON.stringify(await tagsOf(i2)) === JSON.stringify([defConf, defPriv].sort()), 'an item for a Privileged + Confidential document gets both tags');
  const pl = (await db.query('select * from public.privilege_log_entries where production_item_id = $1', [i2])).rows[0];
  check(pl && pl.production_id === prodOut && pl.author === 'J. Patel' && pl.addressee === 'Counsel'
    && pl.subject_matter === 'Acceleration bonus' && pl.doc_date && new Date(pl.doc_date).toISOString().startsWith('2024-08-14'),
    'Privileged into an OUTGOING production drafts its privilege-log entry from the metadata', JSON.stringify(pl));

  const i3 = await insertItem(prodOut, A, docPriv, { date: 'sometime in August' });
  const pl3 = (await db.query('select doc_date from public.privilege_log_entries where production_item_id = $1', [i3])).rows[0];
  check(pl3 && pl3.doc_date === null, 'a junk metadata date drafts the entry with no date, not an error', JSON.stringify(pl3));

  const i4 = await insertItem(prodIn, A, docPriv);
  const pl4 = (await db.query('select 1 from public.privilege_log_entries where production_item_id = $1', [i4])).rows;
  check((await tagsOf(i4)).length === 2 && pl4.length === 0, 'into an INCOMING production: tags copied, no privilege-log draft');

  const i5 = await insertItem(prodChild, A_CHILD, docChild);
  check(JSON.stringify(await tagsOf(i5)) === JSON.stringify([defChildConf]), 'a folder\'s production copies only the folder\'s own tags, not the parent list\'s');

  const i6 = await insertItem(prodOut, A, null);
  check((await tagsOf(i6)).length === 0, 'an item with no document gets no tags');

  const i7 = await insertItem(prodOut, A, docB);
  check((await tagsOf(i7)).length === 0, 'another matter\'s document brings none of its tags');

  // Sets, as the member (A and its folder only).
  const asMember = async (sql, params = []) => {
    await db.exec(`set test.uid = '${USER}'; set test.allowed = '${[A, A_CHILD].join(',')}'; set role authenticated`);
    try { return { res: await db.query(sql, params), err: null }; }
    catch (e) { return { res: null, err: e }; }
    finally { await db.exec('reset role'); }
  };
  const ruleJson = JSON.stringify({ kind: 'filter', tags_has: [defConf], tags_not: [], folder: '', ext: '', text: '', from: '', to: '' });
  const s1 = await asMember('insert into public.discovery_sets (matterspace_id, name, rule) values ($1,$2,$3::jsonb) returning id', [A, 'RFP 1-12', ruleJson]);
  check(!s1.err, 'a member saves a set in their matter', s1.err?.message);
  const dup = await asMember('insert into public.discovery_sets (matterspace_id, name, rule) values ($1,$2,$3::jsonb)', [A, 'RFP 1-12', ruleJson]);
  check(Boolean(dup.err) && dup.err.code === '23505', 'two sets in a matter may not share a name', dup.err?.message ?? 'accepted');
  const bad = await asMember('insert into public.discovery_sets (matterspace_id, name, rule) values ($1,$2,$3::jsonb)', [A, 'x', '{"no":"kind"}']);
  check(Boolean(bad.err), 'a rule without a kind is refused', bad.err?.message ?? 'accepted');
  const other = await asMember('insert into public.discovery_sets (matterspace_id, name, rule) values ($1,$2,$3::jsonb)', [B, 'theirs', ruleJson]);
  check(Boolean(other.err), 'a set in a matter the member cannot open is refused', other.err?.message ?? 'accepted');
  await db.query('insert into public.discovery_sets (matterspace_id, name, rule) values ($1,$2,$3::jsonb)', [B, 'B set', ruleJson]);
  const seen = await asMember('select matterspace_id from public.discovery_sets');
  check(!seen.err && seen.res.rows.length === 1 && seen.res.rows[0].matterspace_id === A, 'the member sees only their matter\'s sets', JSON.stringify(seen.res?.rows));

  const setId = s1.res.rows[0].id;
  await db.query('update public.productions set source_set_id = $1, source_set_rule = $2::jsonb where id = $3', [setId, ruleJson, prodOut]);
  await db.query('delete from public.discovery_sets where id = $1', [setId]);
  const after = (await db.query('select source_set_id, source_set_rule from public.productions where id = $1', [prodOut])).rows[0];
  check(after && after.source_set_id === null && after.source_set_rule?.kind === 'filter',
    'deleting a set keeps the production and its frozen rule; only the link clears', JSON.stringify(after));
}

console.log('\n--- B. the app, held to its source -------------------------------------');
{
  const lib = read('src', 'lib', 'discovery.ts');
  const bar = read('src', 'pages', 'discovery', 'SetsBar.tsx');
  const split = lib.slice(lib.indexOf('export function splitForProduction'), lib.indexOf('export async function produceFromSet'));
  check(/if \(has\(keepOut\)\) out\.heldBack\.push\(d\);\s*else if \(d\.blocked\)/.test(split),
    'a Non-Responsive / Irrelevant tag wins over the set\'s rule and over everything else');
  check(/d\.behavior && d\.behavior !== 'privileged'/.test(split) && /else if \(has\(privileged\)\) out\.privileged\.push\(d\)/.test(split),
    'Privileged documents are split out, not dropped');
  check(/const sending = \[\.\.\.split\.produce, \.\.\.split\.privileged\]/.test(bar),
    'Privileged documents go into the production (withheld at stamping, logged), held-back and blocked ones do not');
  check(/if \(needsSql\) \{\s*return \(/.test(bar) && /disabled=\{!tagsReady\}/.test(bar),
    'no set can be produced before 114 (sets bar hidden) or 113 (button disabled)');
  check(/job_type: 'intake_documents'/.test(lib.slice(lib.indexOf('export async function produceFromSet'))),
    'producing a set uses the server-side intake_documents job (nothing downloaded)');

  // 2026-10-13: a set saved while the filters had been cleared (a set clicked,
  // "Stop using it") was an empty filter, and producing it took in the whole
  // matter. Saving now reads a copy taken at the click; an empty rule is refused.
  check(/const save = async \(\) => \{[\s\S]*?createSet\(matterId, saveName, pending\)/.test(bar)
    && !/createSet\(matterId, saveName, (rule|currentFilter)\)/.test(bar),
    'saving a set saves the copy taken when Save was clicked, never the live filters');
  check(/if \(isRuleEmpty\(pending\)\)/.test(bar)
    && /export async function createSet[\s\S]{0,200}if \(isRuleEmpty\(rule\)\)/.test(lib),
    'an empty rule (the whole matter) is refused in the bar and again in createSet');
  check(/disabled=\{busy \|\| sending\.length === 0 \|\| !name\.trim\(\) \|\| \(needsConfirm && !confirmed\)\}/.test(bar)
    && /const wholeMatter = docs\.length > 0 && docs\.length === matterTotal/.test(bar)
    && /sending\.length > LARGE_SET/.test(bar),
    'producing the whole matter, or over 1,000 documents, needs one more click');

  // The rule helpers themselves, run: the functions are lifted out of
  // discovery.ts and transpiled, so the test runs what the app runs.
  const ts = (await import('typescript')).default;
  const grab = (name) => {
    const at = lib.indexOf(`export function ${name}(`);
    let i = lib.indexOf('{', lib.indexOf(')', at)); let depth = 0;
    for (; i < lib.length; i++) { if (lib[i] === '{') depth++; else if (lib[i] === '}' && --depth === 0) break; }
    return lib.slice(at, i + 1).replace(/^export /, '');
  };
  const src = ['isFilterEmpty', 'isRuleEmpty', 'describeRule'].map(grab).join('\n')
    + '\nreturn { isFilterEmpty, isRuleEmpty, describeRule };';
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const { isRuleEmpty, describeRule } = new Function(js)();
  const EMPTY = { kind: 'filter', tags_has: [], tags_not: [], folder: '', ext: '', text: '', from: '', to: '' };
  const defs = [{ id: 'c', name: 'Confidential' }];
  check(isRuleEmpty(EMPTY) && isRuleEmpty({ ...EMPTY, text: '   ' }) && isRuleEmpty({ kind: 'list', document_ids: [] }),
    'the exact rule saved on 10-13 (and a blank name, and an empty list) counts as empty');
  check(!isRuleEmpty({ ...EMPTY, text: 'VOL-' }) && !isRuleEmpty({ ...EMPTY, tags_has: ['c'] }) && !isRuleEmpty({ kind: 'list', document_ids: ['x'] }),
    'a name, a tag or one ticked document is not empty');
  const words = describeRule({ ...EMPTY, text: 'VOL-', tags_has: ['c'], folder: 'Emails' }, defs);
  check(words === 'name contains "VOL-" · tagged Confidential · folder Emails', 'a filter is said in plain words', words);
  check(describeRule({ kind: 'list', document_ids: ['a', 'b'] }, defs) === '2 ticked documents'
    && describeRule(EMPTY, defs) === 'no filter (the whole matter)',
    'a list and an empty filter are said in plain words');
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
