// Execute migration 119 against a real Postgres (PGlite) and prove its rules.
//
// There is no psql or Docker on the dev machine, so a migration ships
// parse-checked only unless a script like this runs it. This one builds the
// minimum of the schema 119 references (documents, matterspaces, auth.uid(),
// can_write_matter), runs the REAL file, then checks:
//   - the three tables and the partial unique index exist;
//   - a second in-flight analysis for the same document is refused;
//   - a finished one does not block a new one;
//   - the status and finding check constraints hold;
//   - RLS: a member who can write sees and inserts; a stranger sees nothing
//     and cannot insert; a reader cannot start an analysis.
//
//   npm i --no-save @electric-sql/pglite     # once; not a repo dependency
//   node scripts/_verify-video-discovery-119.mjs
//
// Touches nothing outside this process. No .env, no network, no prod.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let PGlite;
try { ({ PGlite } = await import('@electric-sql/pglite')); } catch {
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = (name) => fs.readFileSync(path.resolve(__dirname, '..', 'supabase', 'migrations', name), 'utf8');

const db = new PGlite();
const q = async (sql, params) => (await db.query(sql, params)).rows;
let failures = 0;
const check = (ok, label, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures += 1; };
const refused = async (sql, label) => {
  try { await db.exec(sql); check(false, label, 'statement succeeded'); }
  catch (e) { check(true, label, String(e.message).split('\n')[0].slice(0, 90)); }
};

const WRITER = '11111111-1111-1111-1111-111111111111';
const READER = '22222222-2222-2222-2222-222222222222';
const STRANGER = '33333333-3333-3333-3333-333333333333';
const MATTER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DOC = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

console.log('1. stub schema');
await db.exec(`
  create schema if not exists auth;
  create table auth.users (id uuid primary key);
  create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role authenticated nologin;
  create table public.matterspaces (id uuid primary key, name text);
  create table public.matter_members (matter_id uuid, user_id uuid, role text);
  create table public.documents (
    id uuid primary key, matterspace_id uuid not null references public.matterspaces(id), title text, source_filename text, storage_path text
  );
  alter table public.documents enable row level security;
  create policy doc_members on public.documents for select using (
    exists (select 1 from public.matter_members m where m.matter_id = documents.matterspace_id and m.user_id = auth.uid()));
  grant select on public.documents to authenticated;
  grant select on public.matter_members, public.matterspaces to authenticated;
  grant usage on schema public to authenticated;
  create or replace function public.can_write_matter(p_matter_id uuid) returns boolean language sql stable security definer as $$
    select exists (select 1 from public.matter_members m where m.matter_id = p_matter_id and m.user_id = auth.uid() and m.role = 'writer') $$;
  insert into public.matterspaces values ('${MATTER}', 'Test matter');
  insert into public.matter_members values ('${MATTER}', '${WRITER}', 'writer'), ('${MATTER}', '${READER}', 'reader');
  insert into public.documents values ('${DOC}', '${MATTER}', 'A recording', 'clip.mp4', '${MATTER}/clip.mp4');
`);

console.log('2. executing supabase/migrations/119_video_discovery.sql');
await db.exec(migration('119_video_discovery.sql'));

console.log('3. shape');
const tables = (await q(`select table_name from information_schema.tables where table_schema='public' and table_name like 'video_%' order by 1`)).map((r) => r.table_name);
check(JSON.stringify(tables) === JSON.stringify(['video_analyses', 'video_analysis_reviews', 'video_interrogations']), 'three tables', tables.join(', '));
const idx = await q(`select indexname from pg_indexes where tablename='video_analyses' and indexname='uq_video_analyses_inflight'`);
check(idx.length === 1, 'partial unique index on in-flight analyses');

console.log('4. constraints (as the owner)');
await db.exec(`insert into public.video_analyses (id, document_id, matterspace_id, status, created_by) values ('${'1'.repeat(8)}-0000-0000-0000-000000000001', '${DOC}', '${MATTER}', 'queued', '${WRITER}')`);
await refused(`insert into public.video_analyses (document_id, matterspace_id, status, created_by) values ('${DOC}', '${MATTER}', 'queued', '${WRITER}')`, 'a second queued analysis for the same document is refused');
await db.exec(`update public.video_analyses set status='ready' where document_id='${DOC}'`);
await db.exec(`insert into public.video_analyses (document_id, matterspace_id, status, created_by) values ('${DOC}', '${MATTER}', 'queued', '${WRITER}')`);
check(true, 'a new analysis may start once the earlier one is ready');
await refused(`update public.video_analyses set status='done' where document_id='${DOC}'`, 'status outside the list is refused');
await refused(`insert into public.video_interrogations (document_id, matterspace_id, user_id, question, outcome) values ('${DOC}', '${MATTER}', '${WRITER}', 'q', 'weird')`, 'interrogation outcome outside the list is refused');
await refused(`insert into public.video_analysis_reviews (analysis_id, document_id, status, initials, user_id) select id, '${DOC}', 'maybe', 'EQ', '${WRITER}' from public.video_analyses limit 1`, 'review status outside the list is refused');
await refused(`insert into public.video_analysis_reviews (analysis_id, document_id, status, initials, user_id) select id, '${DOC}', 'reviewed', '', '${WRITER}' from public.video_analyses limit 1`, 'empty initials refused');

console.log('5. RLS');
const as = async (uid, fn) => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
};
const ready = (await q(`select id from public.video_analyses where status='ready' limit 1`))[0].id;
await db.exec(`update public.video_analyses set status='error' where status='queued'`);

await as(WRITER, async () => {
  const rows = await q(`select id from public.video_analyses where document_id='${DOC}'`);
  check(rows.length === 2, 'writer sees the analyses of a document they can see');
  await db.exec(`insert into public.video_analyses (document_id, matterspace_id, status, created_by) values ('${DOC}', '${MATTER}', 'queued', '${WRITER}')`);
  check(true, 'writer starts an analysis as themselves');
  await refused(`insert into public.video_analyses (document_id, matterspace_id, status, created_by) values ('${DOC}', '${MATTER}', 'queued', '${READER}')`, 'writer cannot start one as someone else');
  await refused(`insert into public.video_analyses (document_id, matterspace_id, status, created_by) values ('${DOC}', '${MATTER}', 'ready', '${WRITER}')`, 'a member cannot insert a row already marked ready');
  await refused(`update public.video_analyses set status='ready' where document_id='${DOC}'`, 'a member cannot update an analysis');
  await db.exec(`insert into public.video_interrogations (analysis_id, document_id, matterspace_id, user_id, question) values ('${ready}', '${DOC}', '${MATTER}', '${WRITER}', 'What is visible?')`);
  check(true, 'writer logs a question as themselves');
  await db.exec(`insert into public.video_analysis_reviews (analysis_id, document_id, status, initials, user_id) values ('${ready}', '${DOC}', 'reviewed', 'EQ', '${WRITER}')`);
  check(true, 'writer reviews as themselves');
  await refused(`delete from public.video_analysis_reviews`, 'nobody deletes a review');
});

await as(READER, async () => {
  const rows = await q(`select id from public.video_analyses where document_id='${DOC}'`);
  check(rows.length === 3, 'reader sees the analyses too');
  await refused(`insert into public.video_analyses (document_id, matterspace_id, status, created_by) values ('${DOC}', '${MATTER}', 'queued', '${READER}')`, 'reader cannot start an analysis');
  await db.exec(`insert into public.video_interrogations (analysis_id, document_id, matterspace_id, user_id, question) values ('${ready}', '${DOC}', '${MATTER}', '${READER}', 'Who speaks?')`);
  check(true, 'reader may ask a question (a read of the footage)');
  await refused(`insert into public.video_analysis_reviews (analysis_id, document_id, status, initials, user_id) values ('${ready}', '${DOC}', 'reviewed', 'RD', '${READER}')`, 'reader cannot review');
});

await as(STRANGER, async () => {
  const a = await q(`select id from public.video_analyses`);
  const i = await q(`select id from public.video_interrogations`);
  const r = await q(`select id from public.video_analysis_reviews`);
  check(a.length === 0 && i.length === 0 && r.length === 0, 'a stranger sees nothing');
  await refused(`insert into public.video_interrogations (analysis_id, document_id, matterspace_id, user_id, question) values ('${ready}', '${DOC}', '${MATTER}', '${STRANGER}', 'x')`, 'a stranger cannot log a question');
});

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
