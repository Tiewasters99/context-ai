// Trademark Clearance, register-copy runs (migration 123) — executed, not read.
//
//   A. 123 refuses to run without 121; runs twice cleanly on top of the real
//      121 + 122; creates no SECURITY DEFINER function; adds its columns.
//   B. the run log: 'register_copy' is a source; a register run must carry its
//      as-of date and preliminary flag, and no other run may; the database
//      still computes captured_count and the gap (a capped register run is a gap).
//   C. stage 4, as `authenticated` with real RLS: it cannot be signed while a
//      query's CURRENT run is a preliminary register run; a tmsearch re-run of
//      that query lifts it; a non-preliminary register run (gate passed) does
//      not block; 121's and 122's rules still hold (stage 3 first; no connector
//      sign-off).
//
//   npm i --no-save @electric-sql/pglite@0.5.8
//   node scripts/_verify-trademark-123.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness, makeDb, su, u, ADA, OPEN } from './_tm-connector-fixture.mjs';

const { check, section, done } = harness();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIG = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '123_trademark_register_copy.sql'), 'utf8');
const { PGlite } = await import('@electric-sql/pglite');
const attempt = async (db, sql, params = []) => { try { if (params.length) await db.query(sql, params); else await db.exec(sql); return null; } catch (e) { return e; } };

// ===========================================================================
section('A. preconditions, re-runnable, INVOKER only');
// ===========================================================================
{
  const bare = new PGlite();
  const e = await attempt(bare, MIG);
  check(e && /needs migration 121/.test(e.message), 'without 121, 123 refuses with a sentence', e?.message);
}
const db = await makeDb(); // 121 then 122
{
  const once = await attempt(db, MIG);
  const twice = await attempt(db, MIG);
  check(once === null && twice === null, 'applied on 121 + 122, then again: no error', (once ?? twice)?.message);
  const definer = await su(db, `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like '\\_tm%' and p.prosecdef`);
  check(definer.length === 0, 'no SECURITY DEFINER function among the _tm_* functions', definer.map((x) => x.proname).join(' '));
  const cols = await su(db, `select column_name c from information_schema.columns where table_schema = 'public' and table_name = 'tm_query_runs'
    and column_name in ('register_as_of', 'register_preliminary')`);
  check(cols.length === 2, 'tm_query_runs.register_as_of and register_preliminary exist');
  const trg = await su(db, `select tgname from pg_trigger where tgrelid = 'public.tm_stages'::regclass and not tgisinternal order by tgname`);
  check(trg.map((t) => t.tgname).join(' ') === 'tm_stages_guard tm_stages_guard_122 tm_stages_guard_123',
    'stage triggers fire in name order: 121, 122, then 123', trg.map((t) => t.tgname).join(' '));
}

// A clearance with three queries (Q0, Q1, Q7), stages 1–3 signed by the reviewer.
const CL = u();
const Q0 = u(); const Q1 = u(); const Q7 = u();
await su(db, `insert into public.tm_clearances (id, matterspace_id, mark, created_by) values ($1, $2, 'EQUAZIA', $3)`, [CL, OPEN, ADA]);
await su(db, `insert into public.tm_queries (id, clearance_id, seq, purpose, query) values
  ($1, $4, 0, 'selftest', 'SN:90562533'), ($2, $4, 1, 'exact', 'CM:equazia'), ($3, $4, 7, 'prefix', 'CM:equa* AND LD:true')`, [Q0, Q1, Q7, CL]);

async function as(claims, sql, params = []) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec('set role authenticated');
  try { await db.query(sql, params); return null; } catch (e) { return e; } finally { await db.exec('reset role'); }
}
const ME = { sub: ADA, role: 'authenticated', aal: 'aal2' };
const BOT = { sub: ADA, role: 'authenticated', cs_via: 'connector' };
const run = (q, source, { reported = 1, rows = [{ serial: '90562533', mark: 'EQUASITE' }], asOf = null, prelim = null } = {}) => as(ME,
  `insert into public.tm_query_runs (query_id, source, reported_count, raw, register_as_of, register_preliminary) values ($1, $2, $3, $4::jsonb, $5::date, $6)`,
  [q, source, reported, JSON.stringify(rows), asOf, prelim]);
const sign = (stage, claims = ME) => as(claims, `update public.tm_stages set status = 'done', initials = 'EQ' where clearance_id = $1 and stage = $2`, [CL, stage]);
const status4 = async () => (await su(db, 'select status from public.tm_stages where clearance_id = $1 and stage = 4', [CL]))[0].status;

// ===========================================================================
section('B. the run log');
// ===========================================================================
{
  check(await run(Q0, 'register_copy', { asOf: '2026-10-20', prelim: true }) === null, 'a register run with its as-of date and preliminary flag is recorded (as the user, RLS)');
  const e1 = await run(Q1, 'register_copy', { prelim: true });
  check(e1 && /register_fields_check/.test(e1.message), 'a register run without its as-of date is refused', e1?.message);
  const e2 = await run(Q1, 'manual', { asOf: '2026-10-20', prelim: false });
  check(e2 && /register_fields_check/.test(e2.message), 'a tmsearch run cannot carry register fields', e2?.message);
  const e3 = await run(Q1, 'scraped');
  check(e3 && /source_check/.test(e3.message), 'an unknown source is still refused', e3?.message);
  check(await run(Q1, 'manual') === null, 'a manual run is exactly as before (no register fields)');
  check(await run(Q7, 'register_copy', { reported: 392, rows: [{ serial: '90562533' }, { serial: '98137428' }], asOf: '2026-10-20', prelim: true }) === null, 'a capped register run is recorded');
  const r = await su(db, `select source, captured_count, gap, to_char(register_as_of, 'YYYY-MM-DD') a, register_preliminary p from public.tm_query_runs where query_id = $1`, [Q7]);
  check(r[0].captured_count === 2 && r[0].gap === true && r[0].a === '2026-10-20' && r[0].p === true,
    'the database counts the rows (2 of 392 reported) and marks the gap itself', JSON.stringify(r[0]));
}

// ===========================================================================
section('C. stage 4 and preliminary runs');
// ===========================================================================
{
  for (const s of [1, 2, 3]) await sign(s);
  const e = await sign(4);
  check(e && /Q0, Q7 ran only on Equazia's copy of the register/.test(e.message) && await status4() !== 'done',
    'stage 4 is refused while Q0 and Q7 have only preliminary register runs (named in the refusal)', e?.message);
  check(await run(Q0, 'manual') === null, 'Q0 re-run on tmsearch (manual)');
  const e2 = await sign(4);
  check(e2 && /Q7 ran only/.test(e2.message) && !/Q0/.test(e2.message), 'still refused for Q7 alone', e2?.message);
  check(await run(Q7, 'register_copy', { reported: 2, rows: [{ serial: '90562533' }, { serial: '98137428' }], asOf: '2026-10-21', prelim: false }) === null,
    'Q7 run again on the copy after its recall gate passed (preliminary false)');
  const eBot = await sign(4, BOT);
  check(eBot && /connected assistant cannot sign/.test(eBot.message), 'a connector still cannot sign stage 4 (122)', eBot?.message);
  check(await sign(4) === null && await status4() === 'done', 'the reviewer signs stage 4: no current run is preliminary');
}

done();
