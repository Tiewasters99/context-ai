// The Model Comparator, slice 1 (migration 120) — executed, not read.
//
// A comparison lives in a Sandbox box; candidates are graded blind and the
// key (who made each one) is held by the DATABASE until every candidate has a
// grade card. This proves, against a real Postgres (PGlite) with the three
// real roles and RLS, as `authenticated`:
//
//   A. 120 refuses to run without 098 / 012 / 048, runs twice cleanly, and
//      creates no SECURITY DEFINER function.
//   B. the type drop-down is six data rows; a signed-in user reads them and
//      cannot add one (a type is a row the service role inserts).
//   C. a box writer creates a comparison; the packet must be filed in the box
//      and its hash is the database's; a reader-only member cannot create;
//      an outsider cannot see; a bad rubric is refused.
//   D. candidates: a document outside the box is refused; an upload that
//      names a model is refused (it would break the blind).
//   E. THE KEY: filed by the writer, then unreadable — to the writer, to a
//      reader, by `select *`, by an upsert — and never updatable.
//   F. grade cards: every rubric dimension scored 1–10 and nothing else;
//      initials required.
//   G. THE REVEAL: refused with no candidates, refused while one candidate is
//      ungraded, accepted when all are; the time and revealer are stamped by
//      the database; it never changes again; only then is the key readable.
//   H. after the reveal: grades, candidates and the rubric are frozen.
//   I. the rubric is frozen once the first grade exists, even before reveal.
//   J. document_annotations.tag exists, length-checked.
//   K. events_kind_check after 120 is lib/ledger.mjs's EVENT_KINDS (through 120) exactly;
//      without public.events, 120 skips the vocabulary and still applies.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-comparator-120.mjs
//
// Offline and secret-free. 012, 048 and 098 are represented by stubs of what
// 120 relies on (matterspace_descendants, document_annotations,
// can_access_matter / can_write_matter as SECURITY INVOKER functions).

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
const MIG = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '120_model_comparator.sql'), 'utf8');
const { EVENT_KINDS: ALL_KINDS, KINDS_120, KINDS_121, KINDS_122 } = await import('../lib/ledger.mjs');
// Through 120: this harness never applies 121, whose nine kinds (Trademark
// Clearance) scripts/_verify-trademark-121.mjs holds to the constraint.
const EVENT_KINDS = ALL_KINDS.filter((k) => !KINDS_121.includes(k) && !KINDS_122.includes(k));

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${(!ok || process.env.VERBOSE) && detail ? '  — ' + detail : ''}`);
};

const u = () => crypto.randomUUID();
const BOX = u(); const BOX_FOLDER = u(); const OTHER = u();
const WRITER = u(); const READER = u(); const OUTSIDER = u();
const packet1 = u(); const packet2 = u(); const candDocA = u(); const candDocB = u(); const candDocC = u();
const foreignDoc = u();

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
  -- 098's helpers are SECURITY INVOKER plpgsql; here the member may read the
  -- matters in test.read and write the matters in test.write.
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
// The Record's table as 100 leaves it (the constraint 120 re-declares).
const STUB_EVENTS = `
  create table public.events (id bigserial primary key, kind text not null,
    constraint events_kind_check check (kind in ('tool.invoked', 'draft.snapshot')));
`;

const kindsOf = async (db) => {
  const { rows } = await db.query(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'events_kind_check'`);
  return [...String(rows[0].def).matchAll(/'([a-z]+\.[a-z_]+)'/g)].map((m) => m[1]);
};

// ---------------------------------------------------------------------------
console.log('\n--- A. prerequisites, re-runnable, no SECURITY DEFINER ------------------');
const db = new PGlite();
await db.exec(STUBS);
{
  let e1 = null; try { await db.exec(MIG); } catch (e) { e1 = e; }
  check(Boolean(e1) && /needs migration 098/.test(e1.message), '120 before 098: refuses with a sentence naming 098', e1?.message);
  await db.exec(STUB_098);
  let e2 = null; try { await db.exec(MIG); } catch (e) { e2 = e; }
  check(Boolean(e2) && /needs migration 012/.test(e2.message), '120 before 012: refuses with a sentence naming 012', e2?.message);
  await db.exec(STUB_012);
  let e3 = null; try { await db.exec(MIG); } catch (e) { e3 = e; }
  check(Boolean(e3) && /needs migration 048/.test(e3.message), '120 before 048: refuses with a sentence naming 048', e3?.message);
  await db.exec(STUB_048);
  await db.exec(STUB_EVENTS);

  const definersBefore = (await db.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef`)).rows[0].n;
  await db.exec(MIG);
  let rerun = null; try { await db.exec(MIG); } catch (e) { rerun = e; }
  check(!rerun, '120 is re-runnable (pasted twice)', rerun?.message);
  const definersAfter = (await db.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef`)).rows[0].n;
  check(definersAfter === definersBefore, '120 creates no SECURITY DEFINER function', `${definersBefore} → ${definersAfter}`);
  const rls = (await db.query(`select relname from pg_class where relname in ('comparison_types','comparisons','comparison_candidates','comparison_candidate_keys','candidate_grades') and relrowsecurity`)).rows;
  check(rls.length === 5, 'every new table has row-level security on', rls.map((r) => r.relname).join(' '));
}

// Data: BOX has a folder; OTHER is another matter. WRITER writes BOX; READER
// may read BOX but not write; OUTSIDER has nothing.
for (const p of [WRITER, READER, OUTSIDER]) await db.query('insert into public.profiles values ($1)', [p]);
await db.query('insert into public.matterspaces values ($1, null), ($2, $1), ($3, null)', [BOX, BOX_FOLDER, OTHER]);
const docs = [
  [packet1, BOX, 'complaint.pdf', 1000], [packet2, BOX_FOLDER, 'exhibit-1.pdf', 2000],
  [candDocA, BOX, 'candidate-a.md', 10], [candDocB, BOX, 'candidate-b.md', 11], [candDocC, BOX, 'candidate-c.md', 12],
  [foreignDoc, OTHER, 'elsewhere.pdf', 5],
];
for (const d of docs) await db.query('insert into public.documents values ($1,$2,$3,$4)', d);

const ACCESS = {
  [WRITER]: { read: [BOX, BOX_FOLDER], write: [BOX, BOX_FOLDER] },
  [READER]: { read: [BOX, BOX_FOLDER], write: [] },
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
console.log('\n--- B. the type drop-down is data -----------------------------------------');
{
  const t = await as(WRITER, 'select key, label, default_rubric from public.comparison_types order by sort');
  check(!t.err && rows(t).length === 6, 'six types are seeded and readable', t.err?.message ?? String(rows(t).length));
  check(rows(t).map((r) => r.key).join(',') === 'motion_brief,cite_check,statement_of_facts,deposition_summary,research_answer,custom',
    'in the spec\'s order', rows(t).map((r) => r.key).join(','));
  const mb = rows(t).find((r) => r.key === 'motion_brief');
  check(mb && mb.default_rubric.map((d) => d.label).join(' · ') === 'Strategy · Record accuracy · Authority · Prose · Form',
    'motion/brief default rubric: Strategy · Record accuracy · Authority · Prose · Form');
  const ins = await as(WRITER, `insert into public.comparison_types (key, label, default_rubric) values ('x_type','X','[{"key":"a","label":"A"},{"key":"b","label":"B"},{"key":"c","label":"C"}]')`);
  check(Boolean(ins.err), 'a signed-in user cannot add a type', ins.err?.message ?? 'inserted');
  await db.query(`insert into public.comparison_types (key, label, default_rubric, sort) values ('contract_review','Contract review','[{"key":"issues","label":"Issues spotted"},{"key":"accuracy","label":"Accuracy"},{"key":"drafting","label":"Drafting"}]', 60)`);
  const t2 = await as(READER, 'select count(*)::int n from public.comparison_types');
  check(rows(t2)[0]?.n === 7, 'adding a type is one INSERT by the service role — it appears in the drop-down');
  await db.query(`delete from public.comparison_types where key = 'contract_review'`);
}

// ---------------------------------------------------------------------------
console.log('\n--- C. creating a comparison ---------------------------------------------');
const RUBRIC = JSON.stringify([
  { key: 'strategy', label: 'Strategy' }, { key: 'authority', label: 'Authority' }, { key: 'prose', label: 'Prose' },
]);
const createCmp = (who, packet, rubric = RUBRIC, box = BOX) => as(who,
  `insert into public.comparisons (box_matter_id, type, title, instructions, packet_doc_ids, rubric, created_by)
   values ($1, 'motion_brief', 'Novak 702 motion', 'Draft the motion.', $2::uuid[], $3::jsonb, $4) returning id, packet_hash, created_by`,
  [box, packet, rubric, who]);
let CMP;
{
  const ok = await createCmp(WRITER, [packet1, packet2]);
  check(!ok.err, 'a box writer creates a comparison over two packet documents (one in a folder of the box)', ok.err?.message);
  CMP = rows(ok)[0]?.id;
  const expected = crypto.createHash('sha256').update(
    [[packet1, 'complaint.pdf', 1000], [packet2, 'exhibit-1.pdf', 2000]]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([i, f, s]) => `${i}:${f}:${s}`).join('\n'), 'utf8').digest('hex');
  check(rows(ok)[0]?.packet_hash === expected, 'packet_hash is computed by the database (sha256 over id:filename:size, sorted)', rows(ok)[0]?.packet_hash);
  const forged = await as(WRITER, `update public.comparisons set packet_hash = 'forged' where id = $1 returning packet_hash`, [CMP]);
  check(!forged.err && rows(forged)[0]?.packet_hash === expected, 'a client-sent packet_hash is ignored', forged.err?.message ?? rows(forged)[0]?.packet_hash);

  const foreign = await createCmp(WRITER, [packet1, foreignDoc]);
  check(Boolean(foreign.err) && foreign.err.code === '42501', 'refused — a packet document filed in another matter', foreign.err?.message ?? 'accepted');
  const reader = await createCmp(READER, [packet1]);
  check(Boolean(reader.err), 'refused — a member who may only read the box', reader.err?.message ?? 'accepted');
  const outsider = await as(OUTSIDER, 'select id from public.comparisons');
  check(!outsider.err && rows(outsider).length === 0, 'an outsider sees no comparison');
  const seen = await as(READER, 'select id from public.comparisons');
  check(rows(seen).length === 1, 'a reader of the box sees it');
  const two = await createCmp(WRITER, [], JSON.stringify([{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]));
  check(Boolean(two.err), 'refused — a rubric of two dimensions', two.err?.message ?? 'accepted');
  const dup = await createCmp(WRITER, [], JSON.stringify([{ key: 'a', label: 'A' }, { key: 'a', label: 'B' }, { key: 'c', label: 'C' }]));
  check(Boolean(dup.err), 'refused — a rubric with a repeated key', dup.err?.message ?? 'accepted');
  const spoof = await as(WRITER,
    `insert into public.comparisons (box_matter_id, type, title, rubric, created_by, revealed_at) values ($1,'custom','t',$2::jsonb,$3, now()) returning revealed_at`,
    [BOX, RUBRIC, WRITER]);
  check(!spoof.err && rows(spoof)[0]?.revealed_at === null, 'a comparison cannot be created already revealed', spoof.err?.message);
  await db.query('delete from public.comparisons where title = $1 and id <> $2', ['t', CMP]);
}

// ---------------------------------------------------------------------------
console.log('\n--- D. candidates ---------------------------------------------------------');
const addCand = (who, label, doc, extra = {}) => as(who,
  `insert into public.comparison_candidates (comparison_id, label, source, document_id, model, word_count, created_by)
   values ($1, $2, $3, $4, $5, $6, $7) returning id`,
  [CMP, label, extra.source ?? 'upload', doc, extra.model ?? null, extra.words ?? 100, who]);
const cand = {};
{
  for (const [l, d] of [['A', candDocA], ['B', candDocB]]) {
    const r = await addCand(WRITER, l, d);
    check(!r.err, `a writer adds Candidate ${l}`, r.err?.message);
    cand[l] = rows(r)[0]?.id;
  }
  const outside = await addCand(WRITER, 'C', foreignDoc);
  check(Boolean(outside.err) && outside.err.code === '42501', 'refused — a candidate document outside the box', outside.err?.message ?? 'accepted');
  const named = await addCand(WRITER, 'C', candDocC, { model: 'some-model' });
  check(Boolean(named.err), 'refused — an uploaded candidate that names a model (breaks the blind)', named.err?.message ?? 'accepted');
  const badLabel = await addCand(WRITER, 'Opus', candDocC);
  check(Boolean(badLabel.err), 'refused — a label that is not a blind letter', badLabel.err?.message ?? 'accepted');
  const byReader = await addCand(READER, 'C', candDocC);
  check(Boolean(byReader.err), 'refused — a candidate added by a reader-only member', byReader.err?.message ?? 'accepted');
}

// ---------------------------------------------------------------------------
console.log('\n--- E. the key is filed, and cannot be read back --------------------------');
{
  // First: an INSERT … RETURNING of a real key is refused as a whole (the
  // returned row would have to pass the SELECT policy), and writes nothing.
  const ret = await as(WRITER, 'insert into public.comparison_candidate_keys (candidate_id, revealed_label, created_by) values ($1,$2,$3) returning revealed_label', [cand.A, 'Model One', WRITER]);
  const wrote = await db.query('select count(*)::int n from public.comparison_candidate_keys');
  check(Boolean(ret.err) && wrote.rows[0].n === 0, 'an insert cannot smuggle the key back out (RETURNING refused, nothing written)', ret.err?.message ?? 'returned');
  for (const [l, name] of [['A', 'Model One'], ['B', 'Model Two']]) {
    const r = await as(WRITER, 'insert into public.comparison_candidate_keys (candidate_id, revealed_label, created_by) values ($1,$2,$3)', [cand[l], name, WRITER]);
    check(!r.err, `the writer files the key for Candidate ${l} (plain insert, no RETURNING)`, r.err?.message);
  }
  const w = await as(WRITER, 'select revealed_label from public.comparison_candidate_keys');
  check(!w.err && rows(w).length === 0, 'before the reveal the writer who filed the keys reads none of them', w.err?.message ?? JSON.stringify(rows(w)));
  const star = await as(READER, 'select * from public.comparison_candidate_keys');
  check(!star.err && rows(star).length === 0, 'before the reveal `select *` returns nothing to a reader', star.err?.message ?? JSON.stringify(rows(star)));
  const join = await as(WRITER, `select k.label, x.revealed_label from public.comparison_candidates k left join public.comparison_candidate_keys x on x.candidate_id = k.id`);
  check(!join.err && rows(join).every((r) => r.revealed_label === null), 'a join from the candidates returns no key either');
  const upd = await as(WRITER, `update public.comparison_candidate_keys set revealed_label = 'changed' returning revealed_label`);
  check(Boolean(upd.err) || rows(upd).length === 0, 'a key cannot be rewritten (no UPDATE grant)', upd.err?.message ?? 'updated');
  const ups = await as(WRITER,
    `insert into public.comparison_candidate_keys (candidate_id, revealed_label, created_by) values ($1,'probe',$2)
     on conflict (candidate_id) do update set revealed_label = excluded.revealed_label returning revealed_label`, [cand.A, WRITER]);
  check(Boolean(ups.err), 'an upsert cannot overwrite or read a key', ups.err?.message ?? JSON.stringify(rows(ups)));
  const svc = await db.query('select revealed_label from public.comparison_candidate_keys order by revealed_label');
  check(svc.rows.map((r) => r.revealed_label).join(',') === 'Model One,Model Two', 'the keys are held server-side, intact');
}

// ---------------------------------------------------------------------------
console.log('\n--- F. grade cards --------------------------------------------------------');
const grade = (who, l, scores, overall = 7, initials = 'eq') => as(who,
  `insert into public.candidate_grades (candidate_id, scores, overall, comment, initials, graded_by)
   values ($1, $2::jsonb, $3, 'Solid.', $4, $5)
   on conflict (candidate_id) do update set scores = excluded.scores, overall = excluded.overall,
     comment = excluded.comment, initials = excluded.initials, graded_by = excluded.graded_by
   returning initials, graded_by`,
  [cand[l], JSON.stringify(scores), overall, initials, who]);
{
  const FULL = { strategy: 7, authority: 6, prose: 8 };
  const missing = await grade(WRITER, 'A', { strategy: 7, authority: 6 });
  check(Boolean(missing.err), 'refused — a rubric dimension left unscored', missing.err?.message ?? 'accepted');
  const eleven = await grade(WRITER, 'A', { ...FULL, prose: 11 });
  check(Boolean(eleven.err), 'refused — a score of 11', eleven.err?.message ?? 'accepted');
  const half = await grade(WRITER, 'A', { ...FULL, prose: 7.5 });
  check(Boolean(half.err), 'refused — a score of 7.5', half.err?.message ?? 'accepted');
  const extra = await grade(WRITER, 'A', { ...FULL, vibes: 5 });
  check(Boolean(extra.err), 'refused — a score for a dimension not in the rubric', extra.err?.message ?? 'accepted');
  const noInit = await grade(WRITER, 'A', FULL, 7, '  ');
  check(Boolean(noInit.err), 'refused — a grade card without initials', noInit.err?.message ?? 'accepted');
  const byReader = await grade(READER, 'A', FULL);
  check(Boolean(byReader.err), 'refused — a grade card signed by a reader-only member', byReader.err?.message ?? 'accepted');
  const ok = await grade(WRITER, 'A', FULL);
  check(!ok.err && rows(ok)[0]?.initials === 'EQ' && rows(ok)[0]?.graded_by === WRITER,
    'the writer signs Candidate A\'s grade card (initials upper-cased, graded_by = auth.uid())', ok.err?.message);
  const resign = await grade(WRITER, 'A', { ...FULL, prose: 9 }, 8);
  check(!resign.err, 'and may revise it before the reveal', resign.err?.message);
}

// ---------------------------------------------------------------------------
console.log('\n--- G. the reveal ---------------------------------------------------------');
const reveal = (who, id = CMP) => as(who, 'update public.comparisons set revealed_at = now() where id = $1 returning revealed_at, revealed_by', [id]);
{
  const empty = await createCmp(WRITER, []);
  const emptyId = rows(empty)[0]?.id;
  const r0 = await reveal(WRITER, emptyId);
  check(Boolean(r0.err) && r0.err.code === '42501', 'refused — revealing a comparison with no candidates', r0.err?.message ?? 'revealed');
  await db.query('delete from public.comparisons where id = $1', [emptyId]);

  const r1 = await reveal(WRITER);
  check(Boolean(r1.err) && /1 of 2 graded/.test(r1.err.message), 'refused — Candidate B has no grade card ("1 of 2 graded")', r1.err?.message ?? 'revealed');
  const byReader = await reveal(READER);
  check(Boolean(byReader.err) || rows(byReader).length === 0, 'a reader-only member cannot reveal', byReader.err?.message ?? 'revealed');
  await grade(WRITER, 'B', { strategy: 5, authority: 5, prose: 5 }, 5);
  const r2 = await reveal(WRITER);
  check(!r2.err && rows(r2)[0]?.revealed_at && rows(r2)[0]?.revealed_by === WRITER,
    'accepted once every candidate has a grade card; the database stamps the time and the revealer', r2.err?.message);
  const again = await as(WRITER, `update public.comparisons set revealed_at = now() + interval '1 day' where id = $1`, [CMP]);
  check(Boolean(again.err), 'the reveal never changes again', again.err?.message ?? 'changed');
  const clear = await as(WRITER, 'update public.comparisons set revealed_at = null where id = $1', [CMP]);
  check(Boolean(clear.err), 'and cannot be undone', clear.err?.message ?? 'cleared');
  const keysW = await as(READER, `select k.label, x.revealed_label from public.comparison_candidates k join public.comparison_candidate_keys x on x.candidate_id = k.id order by k.label`);
  check(!keysW.err && rows(keysW).map((r) => `${r.label}=${r.revealed_label}`).join(',') === 'A=Model One,B=Model Two',
    'after the reveal every member who can read the box reads the key', keysW.err?.message ?? JSON.stringify(rows(keysW)));
  const keysO = await as(OUTSIDER, 'select * from public.comparison_candidate_keys');
  check(!keysO.err && rows(keysO).length === 0, 'an outsider still reads nothing');
}

// ---------------------------------------------------------------------------
console.log('\n--- H. frozen after the reveal --------------------------------------------');
{
  const g = await grade(WRITER, 'A', { strategy: 1, authority: 1, prose: 1 }, 1);
  check(Boolean(g.err), 'a grade card cannot be changed after the reveal', g.err?.message ?? 'changed');
  const del = await as(WRITER, 'delete from public.candidate_grades where candidate_id = $1', [cand.A]);
  check(Boolean(del.err), 'nor removed', del.err?.message ?? 'removed');
  const c = await addCand(WRITER, 'C', candDocC);
  check(Boolean(c.err), 'no candidate is added after the reveal', c.err?.message ?? 'added');
  const rm = await as(WRITER, 'delete from public.comparison_candidates where id = $1', [cand.B]);
  check(Boolean(rm.err), 'nor removed', rm.err?.message ?? 'removed');
  const rub = await as(WRITER, `update public.comparisons set rubric = $2::jsonb where id = $1`,
    [CMP, JSON.stringify([{ key: 'x', label: 'X' }, { key: 'y', label: 'Y' }, { key: 'z', label: 'Z' }])]);
  check(Boolean(rub.err), 'the rubric is frozen', rub.err?.message ?? 'changed');
  const kdel = await as(WRITER, 'delete from public.comparison_candidate_keys where candidate_id = $1 returning candidate_id', [cand.A]);
  check(Boolean(kdel.err) || rows(kdel).length === 0, 'and a key cannot be withdrawn after the reveal', kdel.err?.message ?? 'withdrawn');
}

// ---------------------------------------------------------------------------
console.log('\n--- I. the rubric freezes at the first grade ------------------------------');
{
  const c2 = await createCmp(WRITER, [packet1]);
  const id2 = rows(c2)[0]?.id;
  const NEW = JSON.stringify([{ key: 'fidelity', label: 'Fidelity' }, { key: 'coverage', label: 'Coverage' }, { key: 'use', label: 'Usefulness' }]);
  const pre = await as(WRITER, 'update public.comparisons set rubric = $2::jsonb where id = $1', [id2, NEW]);
  check(!pre.err, 'the rubric is editable while nothing is graded', pre.err?.message);
  const k = await as(WRITER, `insert into public.comparison_candidates (comparison_id, label, document_id, created_by) values ($1,'A',$2,$3) returning id`, [id2, candDocC, WRITER]);
  const kid = rows(k)[0]?.id;
  await as(WRITER, `insert into public.candidate_grades (candidate_id, scores, overall, initials, graded_by) values ($1, '{"fidelity":5,"coverage":5,"use":5}', 5, 'EQ', $2)`, [kid, WRITER]);
  const post = await as(WRITER, 'update public.comparisons set rubric = $2::jsonb where id = $1', [id2, RUBRIC]);
  check(Boolean(post.err), 'and frozen once a grade card exists', post.err?.message ?? 'changed');
  const del = await as(WRITER, 'delete from public.comparisons where id = $1', [id2]);
  check(!del.err, 'deleting an unrevealed comparison removes it', del.err?.message);
  const left = await db.query('select count(*)::int n from public.comparison_candidates where comparison_id = $1', [id2]);
  check(left.rows[0].n === 0, 'with its candidates, grade cards and keys (cascade)');
}

// ---------------------------------------------------------------------------
console.log('\n--- J. margin-note tags ---------------------------------------------------');
{
  const ins = await db.query(`insert into public.document_annotations (document_id, page, note, tag) values ($1, 1, 'Cites the packet as (Doc. 1).', 'authority') returning tag`, [candDocA]);
  check(ins.rows[0]?.tag === 'authority', 'document_annotations.tag holds a rubric key');
  let long = null; try { await db.query(`insert into public.document_annotations (document_id, tag) values ($1, $2)`, [candDocA, 'x'.repeat(65)]); } catch (e) { long = e; }
  check(Boolean(long), 'a tag longer than 64 characters is refused');
}

// ---------------------------------------------------------------------------
console.log('\n--- K. the Record\'s vocabulary ------------------------------------------');
{
  const kinds = await kindsOf(db);
  check(kinds.length === EVENT_KINDS.length && EVENT_KINDS.every((k) => kinds.includes(k)),
    'after 120: events_kind_check is EVENT_KINDS exactly — never a subset either way', `${kinds.length} vs ${EVENT_KINDS.length}`);
  check(KINDS_120.length === 5 && KINDS_120.every((k) => k.startsWith('comparison.')), 'KINDS_120 is the five comparison kinds', KINDS_120.join(' '));
  check(kinds.includes('draft.snapshot') && kinds.includes('file.opened'), 'the UNION keeps 094\'s and 100\'s kinds');

  const bare = new PGlite();
  await bare.exec(STUBS + STUB_098 + STUB_012 + STUB_048);
  let e = null; try { await bare.exec(MIG); } catch (err) { e = err; }
  check(!e, 'on a database without public.events, 120 skips the vocabulary and applies', e?.message);
  await bare.close();
}

await db.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
