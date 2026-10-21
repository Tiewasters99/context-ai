// Trademark Clearance, slice 1 (migration 121) — executed, not read.
//
// A clearance is one mark searched in one matter. The reviewer decides every
// bin and signs every stage; the database stamps who and when. This proves,
// against a real Postgres (PGlite) with the three real roles and RLS, as
// `authenticated`:
//
//   A. 121 refuses to run without 098, runs twice cleanly (on top of the real
//      120), creates no SECURITY DEFINER function, and turns RLS on for all
//      five tables.
//   B. a matter writer creates a clearance; the ten stage rows are seeded;
//      created_by is auth.uid(); a reader-only member reads it and cannot
//      write; an outsider reads nothing at all.
//   C. classes: filing must be a subset of search; codes are three digits.
//   D. the docket: done needs initials; done_by / done_at are the database's;
//      stage 2 before 1, and stage 8 before 5, are refused; the chain
//      1 → 2 → 3 → 4 → 5 → 8 signs off in order.
//   E. queries and runs: captured_count and gap are computed by the database
//      (reported ≠ captured, a duplicated serial, a failed run, no reported
//      count); runs are append-only; a query with a run is frozen and stays;
//      an un-run query can be replaced.
//   F. hits: unique (clearance, serial); a bin needs initials; decided_by is
//      auth.uid() whatever the client sends; query_seqs merges; a re-import
//      that does not send `bin` keeps the decision; hits cannot be deleted.
//   G. the Record: events_kind_check after 121 is lib/ledger.mjs's
//      EVENT_KINDS exactly (every tm.* kind admitted); without public.events,
//      121 skips the vocabulary and still applies.
//
//   npm i --no-save @electric-sql/pglite@0.5.8
//   node scripts/_verify-trademark-121.mjs
//
// Offline and secret-free. 012, 048 and 098 are represented by stubs of what
// 120 and 121 rely on.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite@0.5.8');
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mig = (name) => fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', name), 'utf8');
const MIG_120 = mig('120_model_comparator.sql');
const MIG = mig('121_trademark_clearance.sql');
const { EVENT_KINDS: ALL_KINDS, KINDS_121, KINDS_122 } = await import('../lib/ledger.mjs');
// 122 (slice 2) widens the list again; this file holds 121 to the kinds through 121.
const EVENT_KINDS = ALL_KINDS.filter((k) => !KINDS_122.includes(k));

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${(!ok || process.env.VERBOSE) && detail ? '  — ' + detail : ''}`);
};

const u = () => crypto.randomUUID();
const MATTER = u(); const OTHER = u();
const WRITER = u(); const READER = u(); const OUTSIDER = u();
const exportDoc = u();

const STUBS = `
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as
    $f$ select nullif(current_setting('test.uid', true), '')::uuid $f$;
  create table public.profiles (id uuid primary key);
  create table public.matterspaces (id uuid primary key, parent_matterspace_id uuid);
  create table public.documents (
    id uuid primary key, matterspace_id uuid not null references public.matterspaces(id),
    source_filename text, file_size_bytes bigint);
  grant usage on schema public, auth to authenticated, anon, service_role;
  grant select on public.matterspaces, public.documents, public.profiles to authenticated;
  grant all on all tables in schema public to service_role;
`;
const STUB_098 = `
  create or replace function public.can_access_matter(p uuid) returns boolean
    language plpgsql stable security invoker as
    $f$ begin return auth.uid() is not null and p::text = any (string_to_array(current_setting('test.read', true), ',')); end $f$;
  create or replace function public.can_write_matter(p uuid) returns boolean
    language plpgsql stable security invoker as
    $f$ begin return auth.uid() is not null and p::text = any (string_to_array(current_setting('test.write', true), ',')); end $f$;
  grant execute on function public.can_access_matter(uuid), public.can_write_matter(uuid) to authenticated;
`;
const STUB_012 = `
  create or replace function public.matterspace_descendants(p_root uuid)
  returns table (id uuid) language sql stable as $f$
    with recursive tree as (
      select m.id from public.matterspaces m where m.id = p_root
      union all
      select c.id from public.matterspaces c join tree t on c.parent_matterspace_id = t.id
    ) select id from tree $f$;
  grant execute on function public.matterspace_descendants(uuid) to authenticated;
`;
const STUB_048 = `
  create table public.document_annotations (
    id uuid primary key default gen_random_uuid(),
    document_id uuid not null references public.documents(id) on delete cascade,
    user_id uuid, page int not null default 1, note text, anchor_text text,
    rects jsonb not null default '[]'::jsonb, text_anchor jsonb);
  grant select, insert, update, delete on public.document_annotations to authenticated;
`;
const STUB_EVENTS = `
  create table public.events (id bigserial primary key, kind text not null,
    constraint events_kind_check check (kind in ('tool.invoked', 'draft.snapshot')));
`;

// Three-segment kinds (tm.clearance.created): the older harnesses' regex
// reads two segments only, so this one reads any dotted name.
const kindsOf = async (db) => {
  const { rows } = await db.query(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'events_kind_check'`);
  return [...String(rows[0].def).matchAll(/'([a-z][a-z_]*(?:\.[a-z_]+)+)'/g)].map((m) => m[1]);
};

// ---------------------------------------------------------------------------
console.log('\n--- A. prerequisites, re-runnable, no SECURITY DEFINER ------------------');
const db = new PGlite();
await db.exec(STUBS);
{
  let e1 = null; try { await db.exec(MIG); } catch (e) { e1 = e; }
  check(Boolean(e1) && /needs migration 098/.test(e1.message), '121 before 098: refuses with a sentence naming 098', e1?.message);
  await db.exec(STUB_098 + STUB_012 + STUB_048 + STUB_EVENTS);
  await db.exec(MIG_120);

  const definersBefore = (await db.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef`)).rows[0].n;
  let first = null; try { await db.exec(MIG); } catch (e) { first = e; }
  check(!first, '121 applies on top of the real 120', first?.message);
  let rerun = null; try { await db.exec(MIG); } catch (e) { rerun = e; }
  check(!rerun, '121 is re-runnable (pasted twice)', rerun?.message);
  const definersAfter = (await db.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef`)).rows[0].n;
  check(definersAfter === definersBefore, '121 creates no SECURITY DEFINER function', `${definersBefore} → ${definersAfter}`);
  const rls = (await db.query(`select relname from pg_class where relname in ('tm_clearances','tm_stages','tm_queries','tm_query_runs','tm_hits') and relrowsecurity`)).rows;
  check(rls.length === 5, 'every new table has row-level security on', rls.map((r) => r.relname).join(' '));
  const anon = (await db.query(`select count(*)::int n from information_schema.role_table_grants where grantee = 'anon' and table_name like 'tm\\_%'`)).rows[0].n;
  check(anon === 0, 'anon holds no grant on any tm_ table', String(anon));
}

for (const p of [WRITER, READER, OUTSIDER]) await db.query('insert into public.profiles values ($1)', [p]);
await db.query('insert into public.matterspaces values ($1, null), ($2, null)', [MATTER, OTHER]);
await db.query('insert into public.documents values ($1, $2, $3, $4)', [exportDoc, MATTER, 'tmsearch-export.csv', 1234]);

const ACCESS = {
  [WRITER]: { read: [MATTER], write: [MATTER] },
  [READER]: { read: [MATTER], write: [] },
  [OUTSIDER]: { read: [], write: [] },
};
const as = async (who, sql, params = []) => {
  const a = ACCESS[who];
  await db.exec(`set test.uid = '${who}'; set test.read = '${a.read.join(',')}'; set test.write = '${a.write.join(',')}'; set role authenticated`);
  try { return { res: await db.query(sql, params), err: null }; }
  catch (e) { return { res: null, err: e }; }
  finally { await db.exec('reset role'); }
};
const rows = (r) => r.res?.rows ?? [];

// ---------------------------------------------------------------------------
console.log('\n--- B. a clearance in a matter --------------------------------------------');
const SEARCH = JSON.stringify([{ code: '009', reason: 'downloadable software' }, { code: '042', reason: 'SaaS' }, { code: '045', reason: 'legal services' }]);
let CL;
{
  const id = u();
  // The browser mints the id and does not .select() after the insert.
  const ins = await as(WRITER,
    `insert into public.tm_clearances (id, matterspace_id, mark, search_classes, created_by) values ($1, $2, 'EQUAZIA', $3::jsonb, $4)`,
    [id, MATTER, SEARCH, READER]);
  check(!ins.err, 'a matter writer creates a clearance (client-minted id, no RETURNING)', ins.err?.message);
  CL = id;
  const svc = await db.query('select created_by from public.tm_clearances where id = $1', [CL]);
  check(svc.rows[0]?.created_by === WRITER, 'created_by is auth.uid(), not what the client sent', svc.rows[0]?.created_by);
  const st = await as(WRITER, 'select stage, status from public.tm_stages where clearance_id = $1 order by stage', [CL]);
  check(!st.err && rows(st).map((r) => r.stage).join(',') === '1,2,3,4,5,6,7,8,9,10' && rows(st).every((r) => r.status === 'pending'),
    'the ten stage rows are seeded, pending', st.err?.message ?? JSON.stringify(rows(st)));
  const rd = await as(READER, 'select mark from public.tm_clearances');
  check(rows(rd).length === 1 && rows(rd)[0].mark === 'EQUAZIA', 'a reader of the matter reads it');
  const rdw = await as(READER, `update public.tm_clearances set mark = 'X' where id = $1 returning id`, [CL]);
  check(Boolean(rdw.err) || rows(rdw).length === 0, 'a reader-only member cannot change it', rdw.err?.message ?? 'changed');
  const rdi = await as(READER, `insert into public.tm_clearances (matterspace_id, mark) values ($1, 'NOPE')`, [MATTER]);
  check(Boolean(rdi.err), 'nor create one', rdi.err?.message ?? 'created');
  for (const [t, label] of [['tm_clearances', 'clearances'], ['tm_stages', 'stages']]) {
    const o = await as(OUTSIDER, `select 1 from public.${t}`);
    check(!o.err && rows(o).length === 0, `an outsider reads no ${label}`);
  }
  const elsewhere = await as(WRITER, `insert into public.tm_clearances (matterspace_id, mark) values ($1, 'ELSEWHERE')`, [OTHER]);
  check(Boolean(elsewhere.err), 'a writer of one matter cannot create a clearance in another', elsewhere.err?.message ?? 'created');
  const move = await as(WRITER, 'update public.tm_clearances set matterspace_id = $2 where id = $1', [CL, OTHER]);
  check(Boolean(move.err), 'a clearance does not move between matters', move.err?.message ?? 'moved');
  const blank = await as(WRITER, `insert into public.tm_clearances (matterspace_id, mark) values ($1, '   ')`, [MATTER]);
  check(Boolean(blank.err), 'a blank mark is refused', blank.err?.message ?? 'accepted');
}

// ---------------------------------------------------------------------------
console.log('\n--- C. search classes and filing classes -----------------------------------');
{
  const bad = await as(WRITER, `update public.tm_clearances set filing_classes = '[{"code":"025","reason":"clothing"}]' where id = $1`, [CL]);
  check(Boolean(bad.err) && /filing class must also be a search class/.test(bad.err.message), 'a filing class outside the search classes is refused', bad.err?.message ?? 'accepted');
  const ok = await as(WRITER, `update public.tm_clearances set filing_classes = '[{"code":"009","reason":"dated product plan, 2026-09"}]' where id = $1`, [CL]);
  check(!ok.err, 'a filing class inside the search classes is accepted', ok.err?.message);
  const two = await as(WRITER, `update public.tm_clearances set search_classes = '[{"code":"9","reason":"x"}]', filing_classes = '[]' where id = $1`, [CL]);
  check(Boolean(two.err), 'a class code that is not three digits is refused', two.err?.message ?? 'accepted');
  const dup = await as(WRITER, `update public.tm_clearances set search_classes = '[{"code":"009"},{"code":"009"}]', filing_classes = '[]' where id = $1`, [CL]);
  check(Boolean(dup.err), 'a repeated class code is refused', dup.err?.message ?? 'accepted');
}

// ---------------------------------------------------------------------------
console.log('\n--- D. the docket: sign-offs and order ------------------------------------');
const sign = (who, stage, initials = 'eq', status = 'done') => as(who,
  `update public.tm_stages set status = $3, initials = $4, done_by = $5 where clearance_id = $1 and stage = $2 returning status, initials, done_by, done_at`,
  [CL, stage, status, initials, READER]);
{
  const s2 = await sign(WRITER, 2);
  check(Boolean(s2.err) && /stage 1 must be done first/.test(s2.err.message), 'stage 2 cannot be done before stage 1', s2.err?.message ?? 'accepted');
  const noInit = await sign(WRITER, 1, ' ');
  check(Boolean(noInit.err) && /initials/.test(noInit.err.message), 'done without initials is refused', noInit.err?.message ?? 'accepted');
  const byReader = await sign(READER, 1);
  check(Boolean(byReader.err) || rows(byReader).length === 0, 'a reader-only member cannot sign a stage', byReader.err?.message ?? 'signed');
  const s1 = await sign(WRITER, 1);
  check(!s1.err && rows(s1)[0]?.initials === 'EQ' && rows(s1)[0]?.done_by === WRITER && rows(s1)[0]?.done_at,
    'stage 1 signed: initials upper-cased, done_by = auth.uid() (not what the client sent), done_at stamped', s1.err?.message ?? JSON.stringify(rows(s1)));
  for (const n of [2, 3, 4]) {
    const r = await sign(WRITER, n);
    check(!r.err, `stage ${n} signs off after stage ${n - 1}`, r.err?.message);
  }
  const s8 = await sign(WRITER, 8);
  check(Boolean(s8.err) && /stage 5 must be done first/.test(s8.err.message), 'stage 8 cannot be done while stage 5 is not', s8.err?.message ?? 'accepted');
  const s5 = await sign(WRITER, 5);
  check(!s5.err, 'stage 5 signs off after stage 4', s5.err?.message);
  const s8b = await sign(WRITER, 8);
  check(!s8b.err, 'and then stage 8', s8b.err?.message);
  const skip = await sign(WRITER, 6, 'eq', 'skipped');
  check(!skip.err && rows(skip)[0]?.status === 'skipped' && rows(skip)[0]?.done_by === WRITER, 'stage 6 (slice 2) may be skipped, with initials', skip.err?.message);
  const reopen = await as(WRITER, `update public.tm_stages set status = 'in_progress' where clearance_id = $1 and stage = 8 returning initials, done_by`, [CL]);
  check(!reopen.err && rows(reopen)[0]?.initials === null && rows(reopen)[0]?.done_by === null, 'reopening a stage clears its signature', reopen.err?.message);
  const bogus = await as(WRITER, `insert into public.tm_stages (clearance_id, stage) values ($1, 11)`, [CL]);
  check(Boolean(bogus.err), 'there is no stage 11', bogus.err?.message ?? 'accepted');
  const del = await as(WRITER, 'delete from public.tm_stages where clearance_id = $1', [CL]);
  check(Boolean(del.err), 'stage rows cannot be deleted', del.err?.message ?? 'deleted');
}

// ---------------------------------------------------------------------------
console.log('\n--- E. queries and runs ---------------------------------------------------');
const addQuery = (seq, purpose, q, extra = {}) => as(WRITER,
  `insert into public.tm_queries (clearance_id, seq, purpose, query, class_filter, live_only, generator_version)
   values ($1, $2, $3, $4, $5::text[], $6, 'tm-queries/1') returning id`,
  [CL, seq, purpose, q, extra.classes ?? [], extra.live ?? false]);
const run = (queryId, source, reported, raw, who = WRITER) => as(who,
  `insert into public.tm_query_runs (query_id, source, reported_count, raw, run_by, captured_count, gap, export_document_id)
   values ($1, $2, $3, $4::jsonb, $5, 999, false, $6) returning captured_count, gap, run_by`,
  [queryId, source, reported, JSON.stringify(raw), READER, source === 'export' ? exportDoc : null]);
const Q = {};
{
  for (const [seq, purpose, q, extra] of [
    [0, 'selftest', 'SN:90562533'],
    [1, 'exact', 'CM:equazia'],
    [5, 'stems', 'CM:(equas* ekwaz*) AND LD:true AND IC:(009 042 045 a b 200)', { classes: ['009', '042', '045'], live: true }],
    [7, 'prefix', 'CM:equa* AND LD:true AND IC:(009 042 045 a b 200)', { classes: ['009', '042', '045'], live: true }],
  ]) {
    const r = await addQuery(seq, purpose, q, extra);
    check(!r.err, `query ${seq} (${purpose}) is added`, r.err?.message);
    Q[seq] = rows(r)[0]?.id;
  }
  const badPurpose = await addQuery(20, 'guess', 'CM:x');
  check(Boolean(badPurpose.err), 'an unknown purpose is refused', badPurpose.err?.message ?? 'accepted');
  const badClass = await addQuery(21, 'manual', 'CM:x', { classes: ['9'] });
  check(Boolean(badClass.err), 'a class filter that is not three digits is refused', badClass.err?.message ?? 'accepted');
  const dupSeq = await addQuery(1, 'manual', 'CM:y');
  check(Boolean(dupSeq.err), 'seq is unique within a clearance', dupSeq.err?.message ?? 'accepted');

  const selftest = await run(Q[0], 'manual', 1, [{ serial: '90562533', mark: 'EQUASITE', owner: 'Equasite, Inc.' }]);
  check(!selftest.err && rows(selftest)[0]?.captured_count === 1 && rows(selftest)[0]?.gap === false && rows(selftest)[0]?.run_by === WRITER,
    'the self-test run: captured 1 of reported 1, no gap, run_by = auth.uid() (client value ignored)', selftest.err?.message ?? JSON.stringify(rows(selftest)));
  const none = await run(Q[1], 'manual', 0, []);
  check(!none.err && rows(none)[0]?.captured_count === 0 && rows(none)[0]?.gap === false, 'reported 0, captured 0: a valid "no results" run', none.err?.message);
  const short = await run(Q[7], 'export', 392, [
    { serial: '98137428', mark: 'EQUALL' }, { serial: '90562533', mark: 'EQUASITE' }, { serial: '98137428', mark: 'EQUALL' },
  ]);
  check(!short.err && rows(short)[0]?.captured_count === 3 && rows(short)[0]?.gap === true,
    'reported 392, captured 3 with a duplicated serial: the database counts 3 and sets gap', short.err?.message ?? JSON.stringify(rows(short)));
  const dupOnly = await run(Q[5], 'manual', 2, [{ serial: '90562533' }, { serial: '90562533' }]);
  check(!dupOnly.err && rows(dupOnly)[0]?.gap === true, 'counts that agree but repeat a serial (pagination overlap) are a gap', dupOnly.err?.message);
  const failed = await run(Q[5], 'failed', null, []);
  check(!failed.err && rows(failed)[0]?.gap === true && rows(failed)[0]?.captured_count === 0, 'a failed run is a gap, never "no results"', failed.err?.message);
  const unknown = await run(Q[5], 'manual', null, [{ serial: '90562533' }]);
  check(!unknown.err && rows(unknown)[0]?.gap === true, 'a run with no reported count is a gap (it cannot be checked)', unknown.err?.message);
  const noSerial = await run(Q[5], 'manual', 1, [{ mark: 'NO SERIAL' }]);
  check(Boolean(noSerial.err), 'a captured row without a serial is refused', noSerial.err?.message ?? 'accepted');
  const byReader = await run(Q[5], 'manual', 0, [], READER);
  check(Boolean(byReader.err), 'a reader-only member cannot record a run', byReader.err?.message ?? 'recorded');

  const editRun = await as(WRITER, 'update public.tm_query_runs set reported_count = 3 returning id');
  check(Boolean(editRun.err) || rows(editRun).length === 0, 'a run cannot be edited', editRun.err?.message ?? 'edited');
  const delRun = await as(WRITER, 'delete from public.tm_query_runs returning id');
  check(Boolean(delRun.err) || rows(delRun).length === 0, 'nor deleted', delRun.err?.message ?? 'deleted');

  const frozen = await as(WRITER, `update public.tm_queries set query = 'CM:other' where id = $1`, [Q[7]]);
  check(Boolean(frozen.err) && /frozen/.test(frozen.err.message), 'a query with a recorded run is frozen', frozen.err?.message ?? 'changed');
  const keep = await as(WRITER, 'delete from public.tm_queries where id = $1', [Q[7]]);
  check(Boolean(keep.err) && /stays in the record/.test(keep.err.message), 'and cannot be deleted', keep.err?.message ?? 'deleted');
  const fresh = await addQuery(9, 'known', 'CM:equall');
  const delFresh = await as(WRITER, 'delete from public.tm_queries where id = $1 returning id', [rows(fresh)[0]?.id]);
  check(!delFresh.err && rows(delFresh).length === 1, 'an un-run query can be replaced (deleted) on regeneration', delFresh.err?.message);
  const o = await as(OUTSIDER, 'select 1 from public.tm_query_runs union all select 1 from public.tm_queries');
  check(!o.err && rows(o).length === 0, 'an outsider reads no queries and no runs');
  const rd = await as(READER, 'select count(*)::int n from public.tm_query_runs');
  check(rows(rd)[0]?.n === 6, 'a reader of the matter reads every run', String(rows(rd)[0]?.n));
}

// ---------------------------------------------------------------------------
console.log('\n--- F. hits: proposals and decisions --------------------------------------');
const upsertHit = (who, serial, fields) => as(who,
  `insert into public.tm_hits (clearance_id, serial, mark, owner, live, classes, query_seqs)
   values ($1, $2, $3, $4, $5, $6::text[], $7::int[])
   on conflict (clearance_id, serial) do update set mark = excluded.mark, owner = excluded.owner,
     live = excluded.live, classes = excluded.classes, query_seqs = excluded.query_seqs
   returning query_seqs, bin, initials, decided_by`,
  [CL, serial, fields.mark, fields.owner ?? null, fields.live ?? true, fields.classes ?? [], fields.seqs ?? []]);
{
  const a = await upsertHit(WRITER, '98137428', { mark: 'EQUALL', owner: 'Equall Inc.', classes: ['009', '042'], seqs: [7] });
  check(!a.err && rows(a)[0]?.bin === null, 'a hit is added without a bin', a.err?.message);
  const dupInsert = await as(WRITER, `insert into public.tm_hits (clearance_id, serial) values ($1, '98137428')`, [CL]);
  check(Boolean(dupInsert.err), 'unique (clearance_id, serial)', dupInsert.err?.message ?? 'accepted');
  const proposal = { bin: 'flag', similarity: { score: 5, reason: 'shared EQUA- opening' }, relatedness: { score: 5, reason: 'software' }, model: 'claude-opus-5-5', at: '2026-10-18T00:00:00Z' };
  const prop = await as(WRITER, `update public.tm_hits set proposed = $3::jsonb where clearance_id = $1 and serial = $2 returning bin, decided_by`, [CL, '98137428', JSON.stringify(proposal)]);
  check(!prop.err && rows(prop)[0]?.bin === null && rows(prop)[0]?.decided_by === null, 'a proposal is stored without deciding anything', prop.err?.message);

  const noInit = await as(WRITER, `update public.tm_hits set bin = 'flag' where clearance_id = $1 and serial = $2`, [CL, '98137428']);
  check(Boolean(noInit.err) && /initials/.test(noInit.err.message), 'a bin without initials is refused', noInit.err?.message ?? 'accepted');
  const dec = await as(WRITER,
    `update public.tm_hits set bin = 'flag', bin_reason = 'same opening, same classes', initials = 'eq', decided_by = $3, decided_at = '2000-01-01'
     where clearance_id = $1 and serial = $2 returning bin, initials, decided_by, decided_at`,
    [CL, '98137428', READER]);
  const d = rows(dec)[0];
  check(!dec.err && d?.bin === 'flag' && d?.initials === 'EQ' && d?.decided_by === WRITER && new Date(d?.decided_at).getFullYear() >= 2026,
    'the decision: decided_by = auth.uid() and decided_at = now(), whatever the client sent', dec.err?.message ?? JSON.stringify(d));
  const again = await upsertHit(WRITER, '98137428', { mark: 'EQUALL', owner: 'Equall Inc.', classes: ['009', '042'], seqs: [9] });
  check(!again.err && rows(again)[0]?.query_seqs.join(',') === '7,9' && rows(again)[0]?.bin === 'flag' && rows(again)[0]?.initials === 'EQ',
    're-import from another query: query_seqs merges to {7,9} and the decision stays', again.err?.message ?? JSON.stringify(rows(again)));
  const toNull = await as(WRITER, `update public.tm_hits set bin = null, initials = null where clearance_id = $1 and serial = $2`, [CL, '98137428']);
  check(Boolean(toNull.err), 'clearing a bin is a decision too: refused without initials', toNull.err?.message ?? 'accepted');
  const moved = await as(WRITER, `update public.tm_hits set bin = 'note', initials = 'ab' where clearance_id = $1 and serial = $2 returning initials`, [CL, '98137428']);
  check(!moved.err && rows(moved)[0]?.initials === 'AB', 'moving a hit to another bin is a new, signed decision', moved.err?.message);
  const byReader = await as(READER, `update public.tm_hits set bin = 'dismiss', initials = 'rr' where clearance_id = $1 returning id`, [CL]);
  check(Boolean(byReader.err) || rows(byReader).length === 0, 'a reader-only member cannot decide', byReader.err?.message ?? 'decided');
  const del = await as(WRITER, 'delete from public.tm_hits where clearance_id = $1', [CL]);
  check(Boolean(del.err), 'hits cannot be deleted (kept in the log)', del.err?.message ?? 'deleted');
  const reSerial = await as(WRITER, `update public.tm_hits set serial = '11111111' where clearance_id = $1`, [CL]);
  check(Boolean(reSerial.err), 'a hit keeps its serial', reSerial.err?.message ?? 'changed');
  const o = await as(OUTSIDER, 'select 1 from public.tm_hits');
  check(!o.err && rows(o).length === 0, 'an outsider reads no hits');
  const badSerial = await upsertHit(WRITER, 'SN-12', { mark: 'X' });
  check(Boolean(badSerial.err), 'a serial that is not digits is refused', badSerial.err?.message ?? 'accepted');
  const decidedOnInsert = await as(WRITER, `insert into public.tm_hits (clearance_id, serial, bin) values ($1, '99887921', 'dismiss')`, [CL]);
  check(Boolean(decidedOnInsert.err), 'a hit inserted with a bin needs initials too', decidedOnInsert.err?.message ?? 'accepted');
}

// ---------------------------------------------------------------------------
console.log('\n--- G. the Record\'s vocabulary ------------------------------------------');
{
  const kinds = await kindsOf(db);
  check(kinds.length === EVENT_KINDS.length && EVENT_KINDS.every((k) => kinds.includes(k)),
    'after 121: events_kind_check is EVENT_KINDS exactly — never a subset either way', `${kinds.length} vs ${EVENT_KINDS.length}`);
  check(KINDS_121.length === 9 && KINDS_121.every((k) => k.startsWith('tm.')), 'KINDS_121 is the nine tm.* kinds', KINDS_121.join(' '));
  check(kinds.includes('comparison.revealed') && kinds.includes('draft.snapshot') && kinds.includes('file.opened'),
    'the UNION keeps 094\'s, 100\'s and 120\'s kinds');
  await db.exec(`insert into public.events (kind) select unnest(array[${KINDS_121.map((k) => `'${k}'`).join(',')}])`);
  const n = (await db.query(`select count(*)::int n from public.events where kind like 'tm.%'`)).rows[0].n;
  check(n === 9, 'every tm.* kind is admitted by the constraint', String(n));

  const bare = new PGlite();
  await bare.exec(STUBS + STUB_098);
  let e = null; try { await bare.exec(MIG); } catch (err) { e = err; }
  check(!e, 'on a database without public.events, 121 skips the vocabulary and applies', e?.message);
  await bare.close();
}

// Cascade: deleting the clearance takes every row with it, frozen queries included.
{
  const del = await as(WRITER, 'delete from public.tm_clearances where id = $1', [CL]);
  check(!del.err, 'deleting a clearance is allowed to a writer', del.err?.message);
  const left = (await db.query(`select (select count(*) from public.tm_stages) + (select count(*) from public.tm_queries)
    + (select count(*) from public.tm_query_runs) + (select count(*) from public.tm_hits) as n`)).rows[0].n;
  check(Number(left) === 0, 'and cascades to its stages, queries, runs and hits', String(left));
}

await db.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
