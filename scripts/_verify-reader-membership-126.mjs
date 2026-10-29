// Migration 126 — the Library membership's entitlement — against a real Postgres.
//
// Executes 112 (editions) and then 126 in PGlite with the same Supabase stubs
// _verify-editions-migration.mjs uses, runs 126 a second time WITH a Library
// edition already in place (the backfill must leave it alone), then proves:
//
//   * no regression in 112's gate once _edition_can_read is replaced: a free
//     published edition reads for anyone signed in, a paid one for owners,
//     a refund closes it, a withdrawn one stays with its owners;
//   * access follows price for a non-Library edition (0 → free, 999 → paid),
//     on insert and on update, so the Reader's "0 is free" dialog keeps its
//     word; a publisher cannot put their own book into the Library; the
//     service role can;
//   * the membership matrix: active before the period end reads and marks;
//     active past it does not; cancel_at_period_end still reads to the end;
//     past_due within 7 days reads, at 8 days not; canceled, unpaid and
//     incomplete do not; a lapsed member keeps old marks, cannot make new
//     ones, and the illustrations are gone; a withdrawn Library edition
//     leaves even a member;
//   * reader_subscriptions: the owner sees their row, a stranger sees
//     nothing, nobody signed in can write one; _reader_is_member about
//     someone else is false under RLS.
//
//   npm i --no-save @electric-sql/pglite@0.5.8
//   node scripts/_verify-reader-membership-126.mjs
import fs from 'node:fs';
import path from 'node:path';

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite@0.5.8');
  process.exit(2);
}

const ROOT = process.cwd();
const SQL_112 = path.resolve(ROOT, 'supabase', 'migrations', '112_grapheon_editions.sql');
const SQL_126 = path.resolve(ROOT, 'supabase', 'migrations', '126_reader_membership.sql');
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
  create or replace function public.update_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at = now(); return new; end $$;
  grant usage on schema public, auth, storage to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  grant all on all tables in schema storage to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
`);
console.log('  roles, auth.uid(), storage and the stub tables are in place');

console.log('--- migration 112, then 126');
const e112 = await execAttempt(fs.readFileSync(SQL_112, 'utf8'));
check(!e112, '112 runs', e112?.message);
if (e112) process.exit(1);
await db.exec(`grant all on all tables in schema public to anon, authenticated, service_role;`);
const e126 = await execAttempt(fs.readFileSync(SQL_126, 'utf8'));
check(!e126, '126 runs top to bottom', e126?.message);
if (e126) process.exit(1);
await db.exec(`grant all on all tables in schema public to anon, authenticated, service_role;`);
await asUser('00000000-0000-4000-8000-000000000001');
const [whoami] = await q(`select current_user as u`);
check(whoami.u === 'authenticated', 'current_user reports the SET ROLE name (the trigger relies on it)', whoami.u);

console.log('--- people');
await asOwner();
const [pub] = await q(`insert into auth.users (email) values ('publisher@example.test') returning id`);
const [eden] = await q(`insert into auth.users (email) values ('library@example.test') returning id`);
const [member] = await q(`insert into auth.users (email) values ('member@example.test') returning id`);
const [buyer] = await q(`insert into auth.users (email) values ('buyer@example.test') returning id`);
const [stranger] = await q(`insert into auth.users (email) values ('stranger@example.test') returning id`);
await asService();
await q(`insert into public.publisher_accounts (user_id, status) values ($1, 'active'), ($2, 'active')`, [pub.id, eden.id]);

/** A published edition with a book and a shipped illustration, as its publisher. */
async function published(ownerId, slug, priceCents) {
  await asUser(ownerId);
  const [ed] = await q(`insert into public.editions (slug, title, publisher_user_id, rights, rights_note, price_cents) values ($1, $2, $3, 'public_domain', 'test', $4) returning id, access`, [slug, slug, ownerId, priceCents]);
  await q(`insert into public.edition_assets (edition_id, kind, storage_path, mime) values ($1::uuid, 'book', $1::text || '/book.pdf', 'application/pdf')`, [ed.id]);
  const [clip] = await q(`insert into public.edition_assets (edition_id, kind, storage_path, mime) values ($1::uuid, 'media', $1::text || '/clip.mp4', 'video/mp4') returning id`, [ed.id]);
  await q(`insert into public.edition_illustrations (edition_id, asset_id, user_id, page, rect) values ($1, $2, $3, 3, '{"x":0.1,"y":0.1,"w":0.5,"h":0.4}')`, [ed.id, clip.id, ownerId]);
  await q(`select public.publish_edition($1)`, [ed.id]);
  return ed;
}
const canRead = async (editionId) => (await q(`select public._edition_can_read($1) as ok`, [editionId]))[0].ok === true;
const seesIllustrations = async (editionId) => (await q(`select id from public.edition_illustrations where edition_id = $1`, [editionId])).length;
const canMark = async (uid, editionId) => !(await attempt(`insert into public.edition_marks (user_id, edition_id, page, rects) values ($1, $2, 1, '[]')`, [uid, editionId]));

console.log('--- access follows price for an ordinary edition');
const free = await published(pub.id, 'free-book', 0);
check(free.access === 'free', 'a draft made at $0 is access = free (the dialog says "0 is free")', free.access);
const paid = await published(pub.id, 'paid-book', 999);
check(paid.access === 'paid', 'a draft made at $9.99 is access = paid', paid.access);
await asUser(pub.id);
await q(`update public.editions set price_cents = 0 where id = $1`, [paid.id]);
check((await q(`select access from public.editions where id = $1`, [paid.id]))[0].access === 'free', 'dropping the price to 0 makes it free');
await q(`update public.editions set price_cents = 999 where id = $1`, [paid.id]);
check((await q(`select access from public.editions where id = $1`, [paid.id]))[0].access === 'paid', 'raising it again makes it paid');
await q(`update public.editions set access = 'free' where id = $1`, [paid.id]);
check((await q(`select access from public.editions where id = $1`, [paid.id]))[0].access === 'paid', 'a publisher cannot declare a priced book free: access is derived, not chosen');
const sneak = await attempt(`update public.editions set access = 'library' where id = $1`, [paid.id]);
check(!!sneak && /Library mirror/.test(sneak.message), 'a publisher cannot put their own book into the Library', sneak?.message);
const sneakIns = await attempt(`insert into public.editions (slug, title, publisher_user_id, access) values ('sneak-in', 'x', $1, 'library')`, [pub.id]);
check(!!sneakIns, 'nor start one there');

console.log('--- a Library edition (the mirror, with the service role)');
await asService();
const [lib] = await q(`insert into public.editions (slug, title, publisher_user_id, rights, rights_note, access, collection_key, volume, release_on) values ('leaves-of-grass-i', 'Leaves of Grass, Vol. I', $1, 'public_domain', 'Leaves of Grass Vol I - Cleaned.pdf', 'library', 'Leaves of Grass', 1, current_date) returning id, access, price_cents`, [eden.id]);
check(lib.access === 'library' && lib.price_cents === 0, 'the service role places an edition in the Library at price 0');
await q(`update public.editions set price_cents = 0, description = 'x' where id = $1`, [lib.id]);
check((await q(`select access from public.editions where id = $1`, [lib.id]))[0].access === 'library', 'a later update does not derive it back to free');
await q(`insert into public.edition_assets (edition_id, kind, storage_path, mime) values ($1::uuid, 'book', $1::text || '/book.pdf', 'application/pdf')`, [lib.id]);
const [libClip] = await q(`insert into public.edition_assets (edition_id, kind, storage_path, mime) values ($1::uuid, 'media', $1::text || '/clip.mp4', 'video/mp4') returning id`, [lib.id]);
await q(`insert into public.edition_illustrations (edition_id, asset_id, user_id, page, rect) values ($1, $2, $3, 3, '{"x":0.1,"y":0.1,"w":0.5,"h":0.4}')`, [lib.id, libClip.id, eden.id]);
await asUser(eden.id);
const [libV] = await q(`select public.publish_edition($1) as v`, [lib.id]);
check(libV.v === 1, "the Library's publisher account publishes it (version 1)");
check(await canRead(lib.id), 'the publisher of record reads it');

console.log('--- 126 a second time, with the Library row in place');
await asOwner();
const again = await execAttempt(fs.readFileSync(SQL_126, 'utf8'));
check(!again, 'running 126 again is harmless', again?.message);
const after = await q(`select slug, access from public.editions order by slug`);
check(after.find((r) => r.slug === 'leaves-of-grass-i')?.access === 'library', 'the backfill leaves a Library edition alone', JSON.stringify(after));
check(after.find((r) => r.slug === 'free-book')?.access === 'free' && after.find((r) => r.slug === 'paid-book')?.access === 'paid', 'and the free and paid rows as they were');

console.log("--- 112's gate still holds after 126 replaced _edition_can_read");
await asUser(stranger.id);
check(await canRead(free.id), 'a free published edition reads for anyone signed in');
check((await seesIllustrations(free.id)) === 1, 'with its shipped illustration');
check(await canMark(stranger.id, free.id), 'and may be marked');
check(!(await canRead(paid.id)), 'a paid edition does not read before buying');
check(!(await canMark(stranger.id, paid.id)), 'nor mark');
await asService();
await q(`insert into public.edition_purchases (user_id, edition_id, stripe_session_id, amount_cents, currency) values ($1, $2, 'cs_test_1', 999, 'usd')`, [buyer.id, paid.id]);
await asUser(buyer.id);
check(await canRead(paid.id), 'an unrefunded purchase opens it');
await asService();
await q(`update public.edition_purchases set refunded_at = now() where stripe_session_id = 'cs_test_1'`);
await asUser(buyer.id);
check(!(await canRead(paid.id)), 'a refund closes it');
await asService();
await q(`update public.edition_purchases set refunded_at = null where stripe_session_id = 'cs_test_1'`);
await asUser(pub.id);
await q(`update public.editions set status = 'withdrawn' where id = $1`, [paid.id]);
await asUser(buyer.id);
check(await canRead(paid.id), 'a withdrawn paid edition stays with its owner');
await asUser(stranger.id);
check(!(await canRead(paid.id)), 'and not with anyone else');
await asAnon();
check(!(await canRead(free.id)), 'anon reads nothing through the gate (the sample is served another way)');

console.log('--- the membership matrix');
const sub = async (uid, status, periodEndSql, extra = {}) => {
  await asService();
  await q(`delete from public.reader_subscriptions where user_id = $1`, [uid]);
  await q(`insert into public.reader_subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end, price_id, consent_session_id, consented_at)
           values ($1, 'cus_test', 'sub_' || gen_random_uuid()::text, $2, ${periodEndSql}, $3, 'price_test', 'cs_consent', now())`, [uid, status, extra.cancel === true]);
};
await asUser(member.id);
check(!(await canRead(lib.id)), 'a signed-in reader without a membership cannot read a Library book');
check(!(await canMark(member.id, lib.id)), 'nor mark it');
check((await seesIllustrations(lib.id)) === 0, 'nor see its illustrations');
check((await q(`select id from public.editions where id = $1`, [lib.id])).length === 1, 'but sees it in the Store (published)');

await sub(member.id, 'active', `now() + interval '20 days'`);
await asUser(member.id);
check(await canRead(lib.id), 'active, period not ended → reads');
check(await canMark(member.id, lib.id), 'and marks');
check((await seesIllustrations(lib.id)) === 1, 'and sees the shipped illustration');
const [mine] = await q(`select status, current_period_end, cancel_at_period_end from public.reader_subscriptions where user_id = $1`, [member.id]);
check(mine && mine.status === 'active', 'the member sees their own row ("Member until …")');

await sub(member.id, 'active', `now() + interval '20 days'`, { cancel: true });
await asUser(member.id);
check(await canRead(lib.id), 'cancelled at period end, period not ended → still reads');

await sub(member.id, 'active', `now() - interval '1 hour'`);
await asUser(member.id);
check(!(await canRead(lib.id)), 'active but the period has ended (webhook late) → does not read');

await sub(member.id, 'past_due', `now() - interval '6 days'`);
await asUser(member.id);
check(await canRead(lib.id), 'past_due, 6 days after the period end → reads (7-day grace, D16)');

await sub(member.id, 'past_due', `now() - interval '8 days'`);
await asUser(member.id);
check(!(await canRead(lib.id)), 'past_due, 8 days after → does not');

await sub(member.id, 'trialing', `now() + interval '3 days'`);
await asUser(member.id);
check(await canRead(lib.id), 'trialing (not offered in 2S, but Stripe may say it) → reads');

for (const st of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
  await sub(member.id, st, `now() + interval '20 days'`);
  await asUser(member.id);
  check(!(await canRead(lib.id)), `${st} → does not read, whatever the period end says`);
}

console.log('--- lapse keeps the marks');
await sub(member.id, 'canceled', `now() - interval '1 day'`);
await asUser(member.id);
check((await q(`select id from public.edition_marks where edition_id = $1 and user_id = $2`, [lib.id, member.id])).length === 1, 'a lapsed member still sees the mark they made');
check(!(await canMark(member.id, lib.id)), 'but cannot make a new one');
check((await seesIllustrations(lib.id)) === 0, 'and the illustrations are gone until they return');
await sub(member.id, 'active', `now() + interval '30 days'`);
await asUser(member.id);
check(await canMark(member.id, lib.id), 'a returning member marks again');

console.log('--- withdrawal from the Library');
await asUser(eden.id);
await q(`update public.editions set status = 'withdrawn' where id = $1`, [lib.id]);
await asUser(member.id);
check(!(await canRead(lib.id)), 'a withdrawn Library book leaves the Library for members too');
check((await q(`select id from public.editions where id = $1`, [lib.id])).length === 0, 'and the Store');
await asUser(eden.id);
await q(`select public.publish_edition($1)`, [lib.id]);
await asUser(member.id);
check(await canRead(lib.id), 'published again, it is back for members');

console.log('--- reader_subscriptions is the webhook\'s to write');
await asUser(stranger.id);
check((await q(`select user_id from public.reader_subscriptions`)).length === 0, "a stranger sees nobody's membership");
check(!!(await attempt(`insert into public.reader_subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, price_id) values ($1, 'cus_x', 'sub_x', 'active', now() + interval '1 year', 'price_x')`, [stranger.id])), 'a signed-in reader cannot write themselves a membership');
check((await q(`select public._reader_is_member($1) as ok`, [member.id]))[0].ok === false, "_reader_is_member about someone else is false under RLS (their row is invisible)");
check(!(await canRead(lib.id)), 'so a stranger still cannot read a Library book');
await asUser(member.id);
// No update or delete policy: Postgres touches zero rows and raises nothing,
// so the proof is the row afterwards, read with the service role.
const [before] = await q(`select current_period_end from public.reader_subscriptions where user_id = $1`, [member.id]);
await attempt(`update public.reader_subscriptions set current_period_end = now() + interval '10 years' where user_id = $1`, [member.id]);
await attempt(`delete from public.reader_subscriptions where user_id = $1`, [member.id]);
await asService();
const [still] = await q(`select current_period_end from public.reader_subscriptions where user_id = $1`, [member.id]);
check(!!still && String(still.current_period_end) === String(before.current_period_end), 'a member cannot extend their own membership (the row is untouched)');
check(!!still, 'nor delete it');
await asService();
check((await q(`select public._reader_is_member($1) as ok`, [member.id]))[0].ok === true, 'the service role (webhook, crons) can ask about anyone');

console.log('--- the sample');
await asService();
const sample = await attempt(`insert into public.edition_assets (edition_id, kind, storage_path, mime) values ($1::uuid, 'sample', $1::text || '/1.pdf', 'application/pdf')`, [lib.id]);
check(!sample, "a 'sample' asset row is accepted", sample?.message);
check(!!(await attempt(`insert into public.edition_assets (edition_id, kind, storage_path, mime) values ($1::uuid, 'sample', $1::text || '/2.pdf', 'application/pdf')`, [lib.id])), 'one sample per edition');
check(!!(await attempt(`insert into public.edition_assets (edition_id, kind, storage_path) values ($1::uuid, 'poster', $1::text || '/p.png')`, [lib.id])), 'an unknown kind is still refused');
const [sb] = await q(`select public from storage.buckets where id = 'edition-samples'`);
check(sb && sb.public === true, 'the edition-samples bucket exists and is public');
await asUser(stranger.id);
check(!!(await attempt(`insert into storage.objects (bucket_id, name) values ('edition-samples', $1::text || '/1.pdf')`, [lib.id])), 'a signed-in user cannot write into the samples bucket');
check((await q(`select id from public.edition_assets where edition_id = $1 and kind = 'sample'`, [lib.id])).length === 0, 'the sample row itself is not readable by a stranger (the file is public; the table is not)');

console.log('--- columns for the mirror and the queue');
await asOwner();
const cols = await q(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'editions' and column_name in ('access','collection_key','volume','release_on') order by 1`);
check(cols.length === 4, 'editions has access, collection_key, volume, release_on', JSON.stringify(cols));
check(!!(await attempt(`update public.editions set volume = 0 where id = $1`, [lib.id])), 'volume 0 is refused (1-based)');
const idx = await q(`select indexname from pg_indexes where tablename = 'editions' and indexname in ('editions_release_queue_idx','editions_access_status_idx','editions_collection_idx')`);
check(idx.length === 3, 'the queue, access and collection indexes exist', JSON.stringify(idx));

console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
process.exit(fails ? 1 : 0);
