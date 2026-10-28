// Production links (migration 115) against a real Postgres (PGlite).
//
//   - refuses to run without 030; re-runnable; no SECURITY DEFINER function;
//   - the row itself refuses a sealed 'anyone' link, a 'people' link that
//     names nobody, a token that is not a sha256, an unknown event kind;
//   - a member SEES their matter's links (every column but the two hashes)
//     and events; the hash columns are refused to them outright; another
//     matter's links are invisible;
//   - a member can neither make, edit, revoke nor delete a link through the
//     table (only the API, with the service role, writes): that is what
//     keeps a sealed link protected;
//   - codes are not readable by members at all; anon reads nothing;
//   - deleting a production removes its links, their codes and events.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-share-links-115.mjs
//
// Offline and secret-free. 030's tables are stubbed to the columns 115 uses.

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
const M115 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '115_production_share_links.sql'), 'utf8');
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  — ' + detail : ''}`);
};

const u = () => crypto.randomUUID();
const A = u(); const B = u(); const USER = u();
const prodA = u(); const prodB = u(); const delA = u();
const hex = () => crypto.randomBytes(32).toString('hex');

console.log('\n--- migration 115 ------------------------------------------------------');
const db = new PGlite();
await db.exec(`
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as
    $f$ select nullif(current_setting('test.uid', true), '')::uuid $f$;
  create table public.profiles (id uuid primary key);
  create table public.matterspaces (id uuid primary key);
  create table public.productions (id uuid primary key, matterspace_id uuid not null references public.matterspaces(id));
`);

let early = null;
try { await db.exec(M115); } catch (e) { early = e; }
check(Boolean(early) && /needs migration 030/.test(early.message), '115 pasted before 030: refuses with a sentence naming 030', early?.message);

await db.exec(`
  create table public.deliveries (id uuid primary key, matterspace_id uuid not null, production_id uuid not null references public.productions(id) on delete cascade);
  create or replace function public._disc_matter_access(p_matter uuid) returns boolean
    language sql stable security invoker as
    $f$ select auth.uid() is not null and p_matter::text = any (string_to_array(current_setting('test.allowed', true), ',')) $f$;
  grant usage on schema public, auth to authenticated, anon, service_role;
  grant execute on function public._disc_matter_access(uuid) to authenticated;
`);
await db.exec(M115);
let rerun = null;
try { await db.exec(M115); } catch (e) { rerun = e; }
check(!rerun, '115 is re-runnable (pasted twice)', rerun?.message);

const definers = await db.query(`
  select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef`);
check(definers.rows.length === 0, '115 creates no SECURITY DEFINER function', JSON.stringify(definers.rows));

await db.query('insert into public.profiles values ($1)', [USER]);
await db.query('insert into public.matterspaces values ($1),($2)', [A, B]);
await db.query('insert into public.productions values ($1,$2),($3,$4)', [prodA, A, prodB, B]);
await db.query('insert into public.deliveries values ($1,$2,$3)', [delA, A, prodA]);

const insertLink = (vals) => db.query(
  `insert into public.production_share_links
     (matterspace_id, production_id, delivery_id, token_hash, audience, allowed_emails, password_hash, sealed, expires_at, created_by)
   values ($1,$2,$3,$4,$5,$6,$7,$8, now() + interval '2 days', $9) returning id`,
  [vals.matter ?? A, vals.prod ?? prodA, vals.del ?? null, vals.hash ?? hex(), vals.audience, vals.emails ?? [],
    vals.password ?? null, vals.sealed ?? false, USER]);
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const e1 = await refused(() => insertLink({ audience: 'anyone', sealed: true }));
check(Boolean(e1) && /sealed_names_people/.test(e1.message), 'a sealed "anyone" link is refused by the row itself', e1?.message ?? 'accepted');
const e2 = await refused(() => insertLink({ audience: 'people', emails: [] }));
check(Boolean(e2) && /people_named/.test(e2.message), 'a "people" link that names nobody is refused', e2?.message ?? 'accepted');
const e3 = await refused(() => insertLink({ audience: 'anyone', hash: 'not-a-hash' }));
check(Boolean(e3), 'a token hash that is not a sha256 is refused', 'accepted');

const linkA = (await insertLink({ audience: 'people', emails: ['oc@example.com'], password: 'scrypt$x', sealed: true, del: delA })).rows[0].id;
const linkOpen = (await insertLink({ audience: 'anyone' })).rows[0].id;
const linkB = (await insertLink({ matter: B, prod: prodB, audience: 'anyone' })).rows[0].id;
const hp = await db.query('select has_password from public.production_share_links where id = $1', [linkA]);
check(hp.rows[0]?.has_password === true, 'has_password follows password_hash');

await db.query(`insert into public.production_share_codes (link_id, email, code_hash, expires_at) values ($1,'oc@example.com',$2, now() + interval '10 minutes')`, [linkA, hex()]);
await db.query(`insert into public.production_share_events (link_id, matterspace_id, kind) values ($1,$2,'downloaded'),($3,$4,'downloaded')`, [linkA, A, linkB, B]);
const e4 = await refused(() => db.query(`insert into public.production_share_events (link_id, matterspace_id, kind) values ($1,$2,'teleported')`, [linkA, A]));
check(Boolean(e4), 'an unknown event kind is refused', 'accepted');

const as = async (role, sql, params = []) => {
  await db.exec(`set test.uid = '${role === 'anon' ? '' : USER}'; set test.allowed = '${A}'; set role ${role}`);
  try { return { res: await db.query(sql, params), err: null }; }
  catch (e) { return { res: null, err: e }; }
  finally { await db.exec('reset role'); }
};

const seen = await as('authenticated', 'select id, audience, allowed_emails, has_password, sealed, expires_at from public.production_share_links order by created_at');
check(!seen.err && seen.res.rows.length === 2 && seen.res.rows.every((r) => [linkA, linkOpen].includes(r.id)),
  "a member sees their matter's links and not another matter's", seen.err?.message ?? JSON.stringify(seen.res?.rows?.map((r) => r.id)));
const hashCol = await as('authenticated', 'select token_hash from public.production_share_links');
check(Boolean(hashCol.err) && /permission denied/.test(hashCol.err.message), 'token_hash is refused to members', hashCol.err?.message ?? 'readable');
const pwCol = await as('authenticated', 'select password_hash from public.production_share_links');
check(Boolean(pwCol.err) && /permission denied/.test(pwCol.err.message), 'password_hash is refused to members', pwCol.err?.message ?? 'readable');
const star = await as('authenticated', 'select * from public.production_share_links');
check(Boolean(star.err), 'select * (which would include the hashes) is refused to members', 'readable');

const mkLink = await as('authenticated',
  `insert into public.production_share_links (matterspace_id, production_id, token_hash, audience, expires_at) values ($1,$2,$3,'anyone', now() + interval '1 day')`, [A, prodA, hex()]);
check(Boolean(mkLink.err), 'a member cannot make a link through the table', 'accepted');
const widen = await as('authenticated', `update public.production_share_links set audience = 'anyone', sealed = false where id = $1`, [linkA]);
check(Boolean(widen.err), 'a member cannot widen a sealed link by editing its row', 'accepted');
const extend = await as('authenticated', `update public.production_share_links set expires_at = now() + interval '1 year' where id = $1`, [linkA]);
check(Boolean(extend.err), 'a member cannot extend a link by editing its row', 'accepted');
const del = await as('authenticated', 'delete from public.production_share_links where id = $1', [linkA]);
check(Boolean(del.err), 'a member cannot delete a link through the table', 'accepted');

const codes = await as('authenticated', 'select id from public.production_share_codes');
check(Boolean(codes.err), 'members cannot read the code table at all', 'readable');
const evs = await as('authenticated', 'select link_id from public.production_share_events');
check(!evs.err && evs.res.rows.length === 1 && evs.res.rows[0].link_id === linkA, "a member sees their matter's events only", evs.err?.message ?? JSON.stringify(evs.res?.rows));
const evIns = await as('authenticated', `insert into public.production_share_events (link_id, matterspace_id, kind) values ($1,$2,'downloaded')`, [linkA, A]);
check(Boolean(evIns.err), 'a member cannot write an event', 'accepted');

for (const t of ['production_share_links', 'production_share_codes', 'production_share_events']) {
  const r = await as('anon', `select 1 from public.${t}`);
  check(Boolean(r.err), `anon reads nothing from ${t}`, 'readable');
}

const svc = await as('service_role', `update public.production_share_links set revoked_at = now() where id = $1 returning id`, [linkA]);
check(!svc.err && svc.res.rows.length === 1, 'the service role (the API) can revoke', svc.err?.message);

await db.query('delete from public.productions where id = $1', [prodA]);
const left = await db.query(`select
   (select count(*) from public.production_share_links where production_id = $1)::int as l,
   (select count(*) from public.production_share_codes where link_id = $2)::int as c,
   (select count(*) from public.production_share_events where link_id = $2)::int as e`, [prodA, linkA]);
check(left.rows[0].l === 0 && left.rows[0].c === 0 && left.rows[0].e === 0, 'deleting a production removes its links, codes and events', JSON.stringify(left.rows[0]));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
