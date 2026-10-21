// Trademark Clearance, slice 2 (migration 122) — executed, not read.
//
//   A. 122 refuses to run without 121; runs twice cleanly on top of the real
//      121; creates no SECURITY DEFINER function; adds its columns.
//   B. events_kind_check after 122 is lib/ledger.mjs's EVENT_KINDS exactly
//      (every slice-2 tm.* kind admitted, nothing dropped).
//   C. the column checks: proposals / application are objects; tsdr is an
//      object or null; a status record's document link nulls on delete.
//   D. the sign-off rules, as `authenticated` with real RLS: under a
//      connector JWT (cs_via: 'connector') no stage is signed and no bin
//      decided; a browser JWT signs; 6 needs 5; 9 needs 8, 6 done or skipped,
//      and its document; awaiting_review is not a sign-off and a connector
//      may set it.
//
// The behaviour through the tools is in scripts/_verify-trademark-connector.mjs
// (sections H–L); this file holds the migration itself.
//
//   npm i --no-save @electric-sql/pglite@0.5.8
//   node scripts/_verify-trademark-122.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness, makeDb, su, u, ADA, OPEN } from './_tm-connector-fixture.mjs';

const { check, section, done } = harness();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIG = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '122_trademark_slice2.sql'), 'utf8');
const { EVENT_KINDS, KINDS_122 } = await import('../lib/ledger.mjs');

let PGlite;
({ PGlite } = await import('@electric-sql/pglite'));

const attempt = async (db, sql, params = []) => { try { if (params.length) await db.query(sql, params); else await db.exec(sql); return null; } catch (e) { return e; } };

// ===========================================================================
section('A. preconditions, re-runnable, INVOKER only');
// ===========================================================================
{
  const bare = new PGlite();
  await bare.exec(`create schema if not exists auth; create or replace function auth.jwt() returns jsonb language sql as $f$ select '{}'::jsonb $f$;`);
  const e = await attempt(bare, MIG);
  check(e && /needs migration 121/.test(e.message), 'without 121, 122 refuses with a sentence', e?.message);
}
const db = await makeDb();   // 121 then 122 (the fixture)
{
  const again = await attempt(db, MIG);
  check(again === null, 'applied a second time: no error', again?.message);
  const definer = await su(db, `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like '\\_tm%' and p.prosecdef`);
  check(definer.length === 0, 'no SECURITY DEFINER function among the _tm_* functions', definer.map((x) => x.proname).join(' '));
  const cols = await su(db, `select table_name || '.' || column_name c from information_schema.columns
    where table_schema = 'public' and table_name in ('tm_clearances', 'tm_hits') and column_name in ('proposals', 'application', 'deep_check', 'tsdr', 'tsdr_checked_at', 'tsdr_document_id')`);
  check(cols.length === 6, 'the six columns exist', cols.map((x) => x.c).join(' '));
}

// ===========================================================================
section('B. the Record vocabulary');
// ===========================================================================
{
  const { rows } = await db.query(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'events_kind_check'`);
  const kinds = [...String(rows[0].def).matchAll(/'([a-z][a-z_]*(?:\.[a-z_]+)+)'/g)].map((m) => m[1]);
  check(kinds.length === EVENT_KINDS.length && EVENT_KINDS.every((k) => kinds.includes(k)),
    'after 122: events_kind_check is EVENT_KINDS exactly — never a subset either way', `${kinds.length} vs ${EVENT_KINDS.length}`);
  check(KINDS_122.length === 6 && KINDS_122.every((k) => k.startsWith('tm.')), 'KINDS_122 is the six slice-2 tm.* kinds', KINDS_122.join(' '));
}

// ===========================================================================
section('C. column checks');
// ===========================================================================
const CL = u();
await su(db, `insert into public.tm_clearances (id, matterspace_id, mark, created_by) values ($1, $2, 'QUALLET', $3)`, [CL, OPEN, ADA]);
{
  const e1 = await attempt(db, `update public.tm_clearances set proposals = '[]'::jsonb where id = $1`, [CL]);
  const e2 = await attempt(db, `update public.tm_clearances set application = '"x"'::jsonb where id = $1`, [CL]);
  check(e1 && e2, 'proposals and application must be objects');
  await su(db, `insert into public.tm_hits (clearance_id, serial, mark) values ($1, '97111111', 'QUALLETTA')`, [CL]);
  const e3 = await attempt(db, `update public.tm_hits set tsdr = '[1]'::jsonb where clearance_id = $1`, [CL]);
  check(e3, 'tsdr must be an object (or null)');
  const doc = u();
  await su(db, `insert into public.documents (id, matterspace_id, title) values ($1, $2, 'TSDR status')`, [doc, OPEN]);
  await su(db, `update public.tm_hits set tsdr = '{"live": false}'::jsonb, tsdr_document_id = $2 where clearance_id = $1`, [CL, doc]);
  await su(db, `delete from public.documents where id = $1`, [doc]);
  const [h] = await su(db, `select tsdr, tsdr_document_id from public.tm_hits where clearance_id = $1`, [CL]);
  check(h.tsdr.live === false && h.tsdr_document_id === null, 'the status stays when its filed record is deleted; the link nulls');
}

// ===========================================================================
section('D. who can sign');
// ===========================================================================
async function as(claims, sql, params = []) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec('set role authenticated');
  try { await db.query(sql, params); return null; } catch (e) { return e; } finally { await db.exec('reset role'); }
}
const BOT = { sub: ADA, role: 'authenticated', cs_via: 'connector' };
const ME = { sub: ADA, role: 'authenticated', aal: 'aal2' };
const sign = (n, extra = '') => `update public.tm_stages set status = 'done', initials = 'EQ'${extra} where clearance_id = '${CL}' and stage = ${n}`;
{
  const b1 = await as(BOT, sign(1));
  check(b1 && b1.code === '42501' && /connected assistant cannot sign/.test(b1.message), 'connector JWT: stage 1 sign-off refused (42501)', b1?.message);
  const b2 = await as(BOT, `update public.tm_stages set status = 'skipped', initials = 'EQ' where clearance_id = '${CL}' and stage = 6`);
  check(b2 && /cannot sign/.test(b2.message), 'connector JWT: skipping a stage is a sign-off too: refused');
  const b3 = await as(BOT, `update public.tm_stages set status = 'awaiting_review' where clearance_id = '${CL}' and stage = 9`);
  check(b3 === null, 'connector JWT: awaiting_review (not a sign-off) is allowed', b3?.message);
  const b4 = await as(BOT, `update public.tm_hits set bin = 'dismiss', initials = 'EQ' where clearance_id = '${CL}'`);
  check(b4 && /cannot decide a bin/.test(b4.message), 'connector JWT: a bin decision refused');
  const b5 = await as(BOT, `insert into public.tm_hits (clearance_id, serial, bin, initials) values ('${CL}', '97222222', 'flag', 'EQ')`);
  check(b5 && /cannot decide a bin/.test(b5.message), 'connector JWT: inserting a decided hit refused');
  const b6 = await as(BOT, `update public.tm_hits set tsdr = '{"live": true}'::jsonb where clearance_id = '${CL}'`);
  check(b6 === null, 'connector JWT: storing a status on a hit is allowed (it is not a decision)', b6?.message);

  const m1 = await as(ME, sign(1));
  check(m1 === null, 'browser JWT: stage 1 signs', m1?.message);
  const m6 = await as(ME, sign(6));
  check(m6 && /stage 5 must be done first/.test(m6.message), 'stage 6 before stage 5: refused', m6?.message);
  await as(ME, `update public.tm_hits set bin = 'note', initials = 'EQ' where clearance_id = '${CL}'`);
  for (const n of [2, 3, 4, 5]) await as(ME, sign(n));
  const m9a = await as(ME, sign(9, `, output_document_id = null`));
  check(m9a && /stage 8 must be done first/.test(m9a.message), 'stage 9 before stage 8: refused', m9a?.message);
  const doc = u();
  await su(db, `insert into public.documents (id, matterspace_id, title) values ($1, $2, 'report')`, [doc, OPEN]);
  await as(ME, sign(8, `, output_document_id = '${doc}'`));
  const m9b = await as(ME, sign(9, `, output_document_id = '${doc}'`));
  check(m9b && /stage 6 \(deep check\) must be done or skipped/.test(m9b.message), 'stage 9 before stage 6 is done or skipped: refused', m9b?.message);
  const m6b = await as(ME, sign(6));
  check(m6b === null, 'stage 6 signs once 5 is done', m6b?.message);
  await su(db, `update public.tm_stages set output_document_id = null where clearance_id = $1 and stage = 9`, [CL]);
  const m9c = await as(ME, sign(9));
  check(m9c && /needs the reviewed document/.test(m9c.message), 'stage 9 without its document: refused', m9c?.message);
  const m9d = await as(ME, sign(9, `, output_document_id = '${doc}'`));
  const [s9] = await su(db, `select status, initials, done_by from public.tm_stages where clearance_id = $1 and stage = 9`, [CL]);
  check(m9d === null && s9.status === 'done' && s9.done_by === ADA, 'then stage 9 signs, stamped by the database', m9d?.message);
}

done();
