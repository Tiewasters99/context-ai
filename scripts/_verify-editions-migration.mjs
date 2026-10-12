// Migration 112 — the Grapheon Reader's editions — against a real Postgres.
//
// Executes supabase/migrations/112_grapheon_editions.sql in PGlite with the
// same Supabase stubs _verify-entitlements.mjs uses (roles, auth.uid() from
// the JWT claims GUC, a storage schema), twice (idempotence), then drives
// the policies as the publisher, a stranger, a buyer, anon and the service
// role: a draft is the publisher's alone; the bucket folder is theirs to
// write and nobody's to read; publishing needs an active publisher account,
// a rights attestation and a book, returns version 1 and stamps the files
// and illustrations; a later illustration is a draft until the next
// publish; a free published edition is readable by anyone signed in, a paid
// one by owners; a refund closes the book; a withdrawn edition leaves the
// store but stays with its owners; nobody reads edition_assets or anyone
// else's purchases or marks.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-editions-migration.mjs
import fs from 'node:fs';
import path from 'node:path';

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const ROOT = process.cwd();
const SQL = path.resolve(ROOT, 'supabase', 'migrations', '112_grapheon_editions.sql');
const db = new PGlite();
const q = async (sql, params) => (await db.query(sql, params)).rows;
const attempt = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e; } };
const execAttempt = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e; } };
let fails = 0;
const check = (ok, label, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  ' + extra}`); if (!ok) fails++; };

const asUser = async (uid) => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec('set role authenticated');
};
const asAnon = async () => { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claims', '', false)`); await db.exec('set role anon'); };
const asService = async () => { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claims', '', false)`); await db.exec('set role service_role'); };
const asOwner = async () => { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claims', '', false)`); };

console.log('--- supabase stubs');
await db.exec(`
  do $$ begin create role anon;                     exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated;            exception when duplicate_object then null; end $$;
  do $$ begin create role service_role bypassrls;   exception when duplicate_object then null; end $$;
  create schema if not exists auth;
  create schema if not exists storage;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text not null);
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid $$;
  create table public.documents (id uuid primary key default gen_random_uuid(), matterspace_id uuid);
  create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
  alter table storage.objects enable row level security;
  create or replace function storage.foldername(p_name text) returns text[] language sql immutable as $$ select string_to_array(p_name, '/') $$;
  -- 001's trigger function
  create or replace function public.update_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at = now(); return new; end $$;
  grant usage on schema public, auth, storage to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  grant all on all tables in schema storage to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
`);
console.log('  roles, auth.uid(), storage and the stub tables are in place');

console.log('--- migration 112');
const err = await execAttempt(fs.readFileSync(SQL, 'utf8'));
check(!err, 'the file runs top to bottom', err?.message);
if (err) process.exit(1);
// Supabase grants these by default privileges; the stub schema needs it said.
await db.exec(`grant all on all tables in schema public to anon, authenticated, service_role;`);
const idem = await execAttempt(fs.readFileSync(SQL, 'utf8'));
check(!idem, 'running it a second time is harmless (if not exists / drop policy if exists)', idem?.message);

console.log('--- people');
await asOwner();
const [pub] = await q(`insert into auth.users (email) values ('publisher@example.test') returning id`);
const [buyer] = await q(`insert into auth.users (email) values ('buyer@example.test') returning id`);
const [stranger] = await q(`insert into auth.users (email) values ('stranger@example.test') returning id`);

console.log('--- a draft');
await asUser(pub.id);
const [ed] = await q(`insert into public.editions (slug, title, author, publisher_user_id) values ('innocents-abroad-i', 'The Innocents Abroad, Vol. I', 'Mark Twain', $1) returning id, version, status`, [pub.id]);
check(ed && ed.version === 0 && ed.status === 'draft', 'anyone signed in starts a draft (INSERT … RETURNING passes the SELECT policy)');
check(!!(await attempt(`insert into public.editions (slug, title, publisher_user_id) values ('Bad Slug', 'x', $1)`, [pub.id])), 'a slug with capitals or spaces is refused');
check(!!(await attempt(`insert into public.editions (slug, title, publisher_user_id) values ('spoof', 'x', $1)`, [stranger.id])), "you cannot start an edition in someone else's name");

const [book] = await q(`insert into public.edition_assets (edition_id, kind, storage_path, bytes, mime) values ($1::uuid, 'book', $1::text || '/book.pdf', 123, 'application/pdf') returning id, version_from`, [ed.id]);
check(book && book.version_from === null, 'the book file is a draft asset (version_from null)');
check(!!(await attempt(`insert into public.edition_assets (edition_id, kind, storage_path) values ($1, 'media', '00000000-0000-0000-0000-000000000000/clip.mp4')`, [ed.id])), "an asset cannot point at another edition's folder");
check(!!(await attempt(`insert into public.edition_assets (edition_id, kind, storage_path) values ($1::uuid, 'book', $1::text || '/book2.pdf')`, [ed.id])), 'one book per edition');
const [clip] = await q(`insert into public.edition_assets (edition_id, kind, storage_path, mime) values ($1::uuid, 'media', $1::text || '/clip.mp4', 'video/mp4') returning id`, [ed.id]);

const [snip] = await q(`insert into public.edition_bench_items (edition_id, user_id, page, kind, rect) values ($1, $2, 12, 'snip', '{"x":0.1,"y":0.1,"w":0.5,"h":0.4}') returning id`, [ed.id, pub.id]);
check(!!snip, 'a snip goes on the bench');
check(!!(await attempt(`insert into public.edition_bench_items (edition_id, user_id, page, kind) values ($1, $2, 12, 'media')`, [ed.id, pub.id])), 'a media item without an asset is refused (shape constraint)');
const [media] = await q(`insert into public.edition_bench_items (edition_id, user_id, page, kind, asset_id, parent_id) values ($1, $2, 12, 'media', $3, $4) returning id`, [ed.id, pub.id, clip.id, snip.id]);
check(!!media, 'a media item under its snip');
const [ill] = await q(`insert into public.edition_illustrations (edition_id, asset_id, user_id, page, rect) values ($1, $2, $3, 12, '{"x":0.1,"y":0.1,"w":0.5,"h":0.4}') returning id, version_from`, [ed.id, clip.id, pub.id]);
check(ill && ill.version_from === null, 'an illustration laid on a draft has no version yet');

console.log('--- the bucket');
const obj = await attempt(`insert into storage.objects (bucket_id, name) values ('editions', $1::text || '/clip.mp4')`, [ed.id]);
check(!obj, "the publisher may write under their edition's folder", obj?.message);
check(!!(await attempt(`insert into storage.objects (bucket_id, name) values ('editions', '00000000-0000-0000-0000-000000000000/clip.mp4')`)), 'and not under another folder');
const [bucket] = await q(`select public from storage.buckets where id = 'editions'`);
check(bucket && bucket.public === false, 'the bucket is private');

console.log('--- a stranger, before publication');
await asUser(stranger.id);
check((await q(`select id from public.editions where id = $1`, [ed.id])).length === 0, 'a draft is invisible to a stranger');
check((await q(`select id from public.edition_illustrations where edition_id = $1`, [ed.id])).length === 0, 'so are its illustrations');
check((await q(`select id from public.edition_bench_items where edition_id = $1`, [ed.id])).length === 0, 'and its bench');
check((await q(`select id from public.edition_assets where edition_id = $1`, [ed.id])).length === 0, 'and its files');
check(!!(await attempt(`insert into storage.objects (bucket_id, name) values ('editions', $1::text || '/x.bin')`, [ed.id])), 'a stranger cannot write into the folder');
check(!!(await attempt(`insert into public.edition_marks (user_id, edition_id, page, rects) values ($1, $2, 1, '[]')`, [stranger.id, ed.id])), 'a stranger cannot mark a draft');

console.log('--- publishing');
await asUser(pub.id);
const noAcct = await attempt(`select public.publish_edition($1)`, [ed.id]);
check(!!noAcct && /cannot publish/.test(noAcct.message), 'publishing without an active publisher account is refused', noAcct?.message);
await asService();
await q(`insert into public.publisher_accounts (user_id, status) values ($1, 'active')`, [pub.id]);
await asUser(pub.id);
const noRights = await attempt(`select public.publish_edition($1)`, [ed.id]);
check(!!noRights && /rights/.test(noRights.message), 'publishing without a rights attestation is refused', noRights?.message);
await q(`update public.editions set rights = 'public_domain', rights_note = 'First published 1869' where id = $1`, [ed.id]);
const [v1] = await q(`select public.publish_edition($1) as v`, [ed.id]);
check(v1.v === 1, 'publish_edition returns version 1');
const [after] = await q(`select status, version, published_at from public.editions where id = $1`, [ed.id]);
check(after.status === 'published' && after.version === 1 && !!after.published_at, 'the edition is published at version 1');
const stamped = await q(`select kind, version_from from public.edition_assets where edition_id = $1 order by kind`, [ed.id]);
check(stamped.length === 2 && stamped.every((r) => r.version_from === 1), 'both files are stamped version_from = 1', JSON.stringify(stamped));
const [ill1] = await q(`select version_from from public.edition_illustrations where id = $1`, [ill.id]);
check(ill1.version_from === 1, 'the illustration is stamped version_from = 1');
const [ill2] = await q(`insert into public.edition_illustrations (edition_id, asset_id, user_id, page, rect) values ($1, $2, $3, 40, '{"x":0.2,"y":0.2,"w":0.3,"h":0.3}') returning id, version_from`, [ed.id, clip.id, pub.id]);
check(ill2.version_from === null, 'an illustration laid after publishing is a draft again');

console.log('--- a stranger, after publication (a free edition)');
await asUser(stranger.id);
check((await q(`select id from public.editions where id = $1`, [ed.id])).length === 1, 'a published edition is visible');
const seen = await q(`select id from public.edition_illustrations where edition_id = $1`, [ed.id]);
check(seen.length === 1 && seen[0].id === ill.id, 'a reader sees the shipped illustration and not the unpublished one');
check((await q(`select id from public.edition_assets where edition_id = $1`, [ed.id])).length === 0, 'a reader never reads edition_assets directly');
check((await q(`select id from public.edition_bench_items where edition_id = $1`, [ed.id])).length === 0, 'nor the bench');
const freeMark = await attempt(`insert into public.edition_marks (user_id, edition_id, page, rects) values ($1, $2, 1, '[{"x":0,"y":0,"w":1,"h":0.1}]')`, [stranger.id, ed.id]);
check(!freeMark, 'a signed-in reader may mark a free published edition', freeMark?.message);
const freeProg = await attempt(`insert into public.edition_progress (user_id, edition_id, page) values ($1, $2, 7)`, [stranger.id, ed.id]);
check(!freeProg, 'and keep their place', freeProg?.message);

console.log('--- anon');
await asAnon();
check((await q(`select id from public.editions where id = $1`, [ed.id])).length === 1, 'anon can see a published edition (the store)');
check((await q(`select id from public.edition_illustrations where edition_id = $1`, [ed.id])).length === 0, 'anon sees no illustrations (sign-in is needed to read)');

console.log('--- a paid edition');
await asUser(pub.id);
await q(`update public.editions set price_cents = 999 where id = $1`, [ed.id]);
await asUser(buyer.id);
check(!!(await attempt(`insert into public.edition_marks (user_id, edition_id, page, rects) values ($1, $2, 1, '[]')`, [buyer.id, ed.id])), 'before buying, a reader cannot mark a paid edition');
check((await q(`select id from public.edition_illustrations where edition_id = $1`, [ed.id])).length === 0, 'nor see its illustrations');
check(!!(await attempt(`insert into public.edition_purchases (user_id, edition_id, amount_cents, currency) values ($1, $2, 999, 'usd')`, [buyer.id, ed.id])), 'a buyer cannot write their own purchase row');
await asService();
await q(`insert into public.edition_purchases (user_id, edition_id, stripe_session_id, amount_cents, currency) values ($1, $2, 'cs_test_1', 999, 'usd')`, [buyer.id, ed.id]);
await asUser(buyer.id);
check((await q(`select id from public.edition_purchases where edition_id = $1`, [ed.id])).length === 1, 'the buyer sees their purchase');
check((await q(`select id from public.edition_illustrations where edition_id = $1`, [ed.id])).length === 1, 'and now the shipped illustration');
const paidMark = await attempt(`insert into public.edition_marks (user_id, edition_id, page, rects) values ($1, $2, 1, '[]')`, [buyer.id, ed.id]);
check(!paidMark, 'and may mark the book', paidMark?.message);
await asUser(stranger.id);
check((await q(`select id from public.edition_purchases where edition_id = $1`, [ed.id])).length === 0, "a stranger sees nobody else's purchases");
const marks = await q(`select user_id from public.edition_marks where edition_id = $1`, [ed.id]);
check(marks.length === 1 && marks[0].user_id === stranger.id, 'and only their own marks');

console.log('--- refund and withdrawal');
await asService();
await q(`update public.edition_purchases set refunded_at = now() where stripe_session_id = 'cs_test_1'`);
await asUser(buyer.id);
check((await q(`select id from public.edition_illustrations where edition_id = $1`, [ed.id])).length === 0, 'after a refund the illustrations are gone for that reader');
await asService();
await q(`update public.edition_purchases set refunded_at = null where stripe_session_id = 'cs_test_1'`);
await asUser(pub.id);
await q(`update public.editions set status = 'withdrawn' where id = $1`, [ed.id]);
await asUser(buyer.id);
check((await q(`select id from public.editions where id = $1`, [ed.id])).length === 1, 'an owner still sees a withdrawn edition (My Library)');
check((await q(`select id from public.edition_illustrations where edition_id = $1`, [ed.id])).length === 1, 'and keeps its illustrations');
await asUser(stranger.id);
check((await q(`select id from public.editions where id = $1`, [ed.id])).length === 0, 'a withdrawn edition leaves the store');

console.log('--- publish again');
await asUser(pub.id);
const [v2] = await q(`select public.publish_edition($1) as v`, [ed.id]);
check(v2.v === 2, 'publishing again gives version 2');
const [ill2b] = await q(`select version_from from public.edition_illustrations where id = $1`, [ill2.id]);
const [ill1b] = await q(`select version_from from public.edition_illustrations where id = $1`, [ill.id]);
check(ill2b.version_from === 2 && ill1b.version_from === 1, 'only the new illustration is stamped 2; the first keeps 1');
await asUser(stranger.id);
check(!!(await attempt(`select public.publish_edition($1)`, [ed.id])), "a stranger cannot publish someone else's edition");

console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
