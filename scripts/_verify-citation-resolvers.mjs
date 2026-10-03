// Migration 101 and the Brief Desk, slice D2 (docs/specs/BRIEF-DESK-2026-09-26.md
// §3.4): the two resolvers, executed.
//
//   node --import ./scripts/_node-src-loader.mjs scripts/_verify-citation-resolvers.mjs
//
//   A. the reporter grammar, one spelling both ways: a Westlaw header parsed
//      at ingest (parseWestlawCase → westlawCaseSummary → documentCitationRows)
//      and the same cite as a brief writes it (parseReporterCites, which
//      src/lib/brief/resolve.ts calls) give the same reporter string —
//      "F. App'x" included, which normalizeReporter used to cut to "F. App".
//      Pins, parallel cites, star levels; the SQL caveat is PDF_INDEX_CAVEAT.
//   B. migration 101 in PGlite, twice, over the real 001 → 016 → 022 → 051
//      schema with real roles and real RLS. The rows are written by the real
//      upsertDocumentCitations (lib/ingest-core.mjs) through a PostgREST-shaped
//      client, from westlaw_case metadata plus levels read back from passages
//      (the backfill's path), as the member's own session (api/ingest.mjs's).
//   C. resolve_citation through the real src/lib/brief/resolve.ts: a reporter
//      hit; a parallel reporter; two copies; the name fallback (including a
//      Westlaw case with no category); a reporter that parsed and missed is
//      NOT answered by name; a document in another matter is not returned;
//      a sealed sub-matter only at aal2; no uid → nothing; service_role
//      passes through.
//   D. passage_for_printed_page: printed; parallel via star_pages; a pin
//      outside the star pages; a reporter no level carries; pdf_index_declined
//      with the caveat word for word; nothing recorded; out-of-scope → nothing.
//   E. document_citations RLS, the private core, the backfill's idempotence.
//   F. mutation check: the same checks against 101 with its scope check
//      removed, and with its reporter-miss rule removed, must FAIL by name.
//
// 094's sealed gate is STUBBED here with production's semantics
// (sealed_entry_allowed = the session is aal2; effective_tier_is_sealed = the
// matter or an ancestor is tier B/C). 094 itself is _verify-stepup-seal.mjs's
// to prove; this harness proves 101 asks it, once per matter.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const migrationSql = (name) => fs.readFileSync(path.join(root, 'supabase', 'migrations', name), 'utf8');

let failures = 0;
const failed = [];
let quiet = false;
const check = (ok, label, detail = '') => {
  if (!quiet) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) { failures += 1; failed.push(label); }
};

const {
  parseWestlawCase, westlawCaseSummary, documentCitationRows, starLevelsFromPassages, parseReporterCites, bluebookCitesFor,
} = await import('../lib/bluebook.mjs');
const { westlawStarPages, westlawPageMeta } = await import('../lib/westlaw-pages.mjs');
const { PDF_INDEX_CAVEAT } = await import('../lib/cite-page.mjs');
const { upsertDocumentCitations } = await import('../lib/ingest-core.mjs');
const { resolveEntry, passageForPrintedPage, pinPage, caseNameOf, citeMarkAttrs } = await import('../src/lib/brief/resolve.ts');

// ===========================================================================
console.log('\n--- A. one reporter spelling, both directions ------------------------');
// ===========================================================================
{
  // Westlaw's closed-up header, as a download opens.
  const head = (cites) => ({ headText: `Doe v. Roe, ${cites} (2019)\nUnited States Court of Appeals, Second Circuit.\nJane DOE, Plaintiff-Appellant, v. Richard ROE\nDecided: March 4, 2019`, sourceFilename: 'Doe v. Roe.pdf' });
  const cases = [
    ['143 F.3d 1219', 'Doe v. Roe, 143 F.3d 1219, 1221 (2d Cir. 1998)'],
    ['12 F.Supp.2d 45', 'Doe v. Roe, 12 F. Supp. 2d 45, 47 (S.D.N.Y. 1998)'],
    ["770 Fed.Appx. 12", "Doe v. Roe, 770 F. App'x 12, 14 (2d Cir. 2019)"],
    ['180 A.D.3d 609', 'Doe v. Roe, 180 A.D.3d 609, 610 (1st Dep\'t 2020)'],
    ['8 N.Y.S.3d 618', 'Doe v. Roe, 8 N.Y.S.3d 618 (2015)'],
  ];
  for (const [westlaw, brief] of cases) {
    const info = parseWestlawCase(head(westlaw));
    const stored = documentCitationRows(westlawCaseSummary(info), {})[0];
    const asked = parseReporterCites(brief)[0];
    check(stored && asked && stored.reporter === asked.reporter && stored.volume === asked.volume && stored.page === asked.page,
      `Westlaw "${westlaw}" is stored as the brief's "${asked?.volume} ${asked?.reporter} ${asked?.page}"`,
      `stored ${JSON.stringify(stored?.reporter)} asked ${JSON.stringify(asked?.reporter)}`);
  }
  const iq = parseReporterCites('Ashcroft v. Iqbal, 556 U.S. 662, 678, 129 S. Ct. 1937, 1949 (2009)');
  check(iq.length === 2 && iq[0].pin === 678 && iq[1].reporter === 'S. Ct.' && iq[1].pin === 1949,
    'a parallel cite gives both reporters, each with its own pin', JSON.stringify(iq.map((c) => [c.reporter, c.pin])));
  const two = parseReporterCites('12 F.3d 45, 129 S. Ct. 1937');
  check(two.length === 2 && two[0].pin === null, 'the next cite\'s volume is never read as a pin');
  const rng = parseReporterCites('Roe, 180 A.D.3d 609, 610–11')[0];
  check(rng.pin === 610 && rng.pin_end === 611, 'a pin range "610–11" is 610 to 611');
  check(parseReporterCites('Smith v. Acme Corp., 2020 WL 12345, at *3').length === 0, 'a WL cite is not a reporter cite');
  check(pinPage('at 1221') === 1221 && pinPage('1221–22') === 1221 && pinPage('*3') === null,
    'the extractor\'s pin field: "at 1221" and "1221–22" read 1221; a WL star page "*3" reads nothing');
  check(caseNameOf({ citation: '*Smith v. Acme Corp.*, 2020 WL 12345', case_name: null, pin: null }) === 'Smith v. Acme Corp.',
    'with no extracted case name, the name before the first comma (italics stripped)');

  // Star levels: which level carries which reporter, from the passages alone.
  const metas = [
    { printed_page: 609, printed_page_end: 609, star_pages: { 2: [239, 240] } },
    { printed_page: 610, printed_page_end: 611, star_pages: { 2: [240, 241] } },
  ];
  const levels = starLevelsFromPassages(metas);
  check(levels[1]?.first === 609 && levels[1]?.last === 611 && levels[2]?.first === 239 && levels[2]?.last === 241,
    'starLevelsFromPassages reads each level\'s run back from passages.metadata', JSON.stringify(levels));
  const rows = documentCitationRows({ kind: 'case', case_name: 'Roe v. Doe', reporters: [
    { volume: 180, reporter: 'A.D.3d', page: 609 }, { volume: 117, reporter: 'N.Y.S.3d', page: 239 },
    { volume: 9, reporter: 'N.E.3d', page: 500 }] }, levels);
  check(rows.map((r) => r.star_level).join(',') === '1,2,',
    'each reporter gets the level its pages are marked at; one no level starts at gets null, never a guess',
    rows.map((r) => `${r.reporter}:${r.star_level}`).join(' '));
  check(rows[0].case_name === 'roe v. doe', 'case_name is stored lowercased');
  check(documentCitationRows({ kind: 'other', reason: 'x' }, {}).length === 0, 'a non-case header gives no rows');

  // The seam between ingest and the backfill: ingest ties reporters to levels
  // with westlawStarPages().levels; the backfill reads the levels back from
  // the passage metadata ingest wrote. Same document → same rows, or a later
  // re-index would silently flip what the backfill wrote.
  {
    const FOOT = '© 2026 Thomson Reuters. No claim to original U.S. Government Works.';
    const passages = [
      { text: `People v. Doe (fictional)\n45 N.Y.2d 560, 400 N.E.2d 1100\nCourt of Appeals of New York.\nDecided March 4, 1980\n${FOOT}` },
      { text: 'The statutes at issue are designed to prevent *561 very different kinds of harm.' },
      { text: 'The defendant argues otherwise. **1101 We disagree. *562\n\nThe Criminal Procedure Law does not bar the second prosecution.' },
      { text: 'Nor do the offenses merge. *563 Order affirmed.' },
    ];
    const westlaw = westlawStarPages(passages);
    const { info } = bluebookCitesFor(passages, westlaw, 'People v. Doe.pdf');
    const wcase = westlawCaseSummary(info);
    const atIngest = documentCitationRows(wcase, westlaw.levels);
    const metas = westlaw.pages.map((pg, i) => westlawPageMeta(pg, i + 1)).filter(Boolean);
    const atBackfill = documentCitationRows(wcase, starLevelsFromPassages(metas));
    check(atIngest.length === 2 && JSON.stringify(atIngest) === JSON.stringify(atBackfill)
      && atIngest.map((r) => `${r.reporter}:${r.star_level}`).join(' ') === 'N.Y.2d:1 N.E.2d:2',
    'ingest (westlawStarPages levels) and the backfill (levels read back from passages) write the same rows',
    `${atIngest.map((r) => `${r.reporter}:${r.star_level}`).join(' ')} | ${atBackfill.map((r) => `${r.reporter}:${r.star_level}`).join(' ')}`);
  }

  const sql = migrationSql('101_citation_resolvers.sql');
  check(sql.includes(`'${PDF_INDEX_CAVEAT.replace(/'/g, "''")}'`),
    'the pdf_index_declined caveat in 101 is lib/cite-page.mjs PDF_INDEX_CAVEAT, word for word', PDF_INDEX_CAVEAT);
}

// ===========================================================================
// The database
// ===========================================================================
let PGlite, uuid_ossp;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
} catch {
  console.error('Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const descendantsFn = (() => {
  const s = migrationSql('012_matter_descendants_search.sql');
  const start = s.indexOf('create or replace function public.matterspace_descendants');
  const end = s.indexOf('$$;', s.indexOf('as $$', start)) + 3;
  return s.slice(start, end);
})();

async function freshDb() {
  const db = new PGlite({ extensions: { uuid_ossp } });
  await db.exec(`
    do $$ begin create role anon;                   exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated;          exception when duplicate_object then null; end $$;
    do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
    create schema if not exists auth;
    create schema if not exists storage;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text not null,
      raw_user_meta_data jsonb not null default '{}'::jsonb);
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid $$;
    create or replace function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
    -- documents and passages with the columns 101 reads (002 / 081 / 095 shape).
    create table public.documents (id uuid primary key default gen_random_uuid(), matterspace_id uuid, created_by uuid,
      title text, category text, doc_type text, metadata jsonb not null default '{}'::jsonb);
    create table public.passages (id uuid primary key default gen_random_uuid(), document_id uuid references public.documents(id) on delete cascade,
      matterspace_id uuid, summary_level int not null default 0, sequence_number int, page_start int, metadata jsonb);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    create or replace function storage.foldername(p_name text)
      returns text[] language sql immutable as $$ select string_to_array(p_name, '/') $$;
    grant usage on schema public, auth, storage to anon, authenticated, service_role;
    grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  for (const m of ['001_initial_schema.sql', '005_fix_rls_recursion.sql', '008_submatters.sql',
    '016_matterspace_members.sql', '022_matterspaces_rls_invoker_wrappers.sql', '051_securespace.sql']) {
    await db.exec(migrationSql(m));
  }
  await db.exec(descendantsFn);
  await db.exec(`
    alter table public.documents enable row level security;
    alter table public.passages enable row level security;
    create policy "passages with their matter" on public.passages for select using (public.can_access_matter(matterspace_id));
    -- 094, STUBBED with production's semantics (see the header).
    create or replace function public.sealed_entry_allowed() returns boolean language sql stable as $$
      select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' $$;
    create or replace function public.effective_tier_is_sealed(p_matter uuid) returns boolean
      language sql stable security definer set search_path = public as $$
      select exists (select 1 from public.matter_ancestry(p_matter) a join public.matterspaces m on m.id = a.id
                      where m.ai_tier in ('B', 'C')) $$;
  `);
  return db;
}

// A PostgREST-shaped client over the one PGlite connection, as whichever role
// is set: enough of supabase-js for upsertDocumentCitations and resolve.ts.
const ARG_TYPES = { p_matter: 'uuid', p_reporter: 'text', p_volume: 'int', p_page: 'int', p_case_name: 'text',
  p_document: 'uuid', p_reporter_ordinal: 'int' };
function clientFor(db) {
  const wrap = async (fn) => { try { return { data: await fn(), error: null }; } catch (e) { return { data: null, error: { message: e.message, code: e.code } }; } };
  return {
    from(table) {
      return {
        delete: () => ({ eq: (col, v) => wrap(async () => (await db.query(`delete from public.${table} where ${col} = $1 returning 1`, [v])).rows) }),
        insert: (rows) => wrap(async () => {
          for (const r of [].concat(rows)) {
            const cols = Object.keys(r);
            await db.query(`insert into public.${table} (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((c) => r[c]));
          }
          return null;
        }),
        // resolve.ts reads the parsed header of name-matched documents (same case, same year).
        select: (cols) => ({
          in: (col, ids) => wrap(async () => (await db.query(`select ${cols} from public.${table} where ${col} = any($1::uuid[])`, [ids])).rows),
        }),
      };
    },
    rpc: (fn, args) => wrap(async () => {
      const names = Object.keys(args);
      return (await db.query(`select * from public.${fn}(${names.map((n, i) => `${n} => $${i + 1}::${ARG_TYPES[n]}`).join(', ')})`,
        names.map((n) => args[n]))).rows;
    }),
  };
}

// ===========================================================================
// The scenario: run on the real 101, and on two mutants (section F).
// ===========================================================================
async function scenario(sql101, { verbose }) {
  quiet = !verbose;
  const db = await freshDb();
  const q = async (text, params) => (await db.query(text, params)).rows;
  const attempt = async (text, params) => { try { await db.query(text, params); return null; } catch (e) { return e; } };
  const client = clientFor(db);
  const asUser = async (uid, aal = 'aal1') => {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated', aal })]);
    await db.exec('set role authenticated');
  };
  const asRole = async (role) => { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claims', '', false)`); await db.exec(`set role ${role}`); };
  const asSuper = async () => { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claims', '', false)`); };

  // Before 101: the ingest helper says so, and does not throw.
  {
    await asSuper();
    const r = await upsertDocumentCitations(client, '00000000-0000-0000-0000-000000000000', { kind: 'case', reporters: [] }, {});
    check(r.skipped && /101 not applied/.test(r.skipped), 'before 101, upsertDocumentCitations reports "not applied" and does not fail the ingest', r.skipped ?? '');
  }

  if (verbose) console.log('\n--- B. migration 101, twice ----------------------------------------');
  await db.exec(sql101);
  const again = await db.exec(sql101).then(() => null, (e) => e);
  check(again === null, '101 applies a second time without error', again?.message ?? '');
  await db.exec(`grant select, insert, update, delete on public.documents, public.passages to authenticated, service_role;`);

  const signup = async (email) => (await q(`insert into auth.users (email) values ($1) returning id`, [email]))[0].id;
  const ADA = await signup('ada@example.test');   // owns the firm's serverspace
  const MEL = await signup('mel@example.test');   // member of the matter
  const VIC = await signup('vic@example.test');   // viewer of the matter
  const STR = await signup('str@example.test');   // another firm entirely
  const space = async (owner, name) => {
    const [s] = await q(`insert into public.serverspaces (clientspace_id, name)
      select id, $2 from public.clientspaces where user_id = $1 returning id`, [owner, name]);
    await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner')`, [s.id, owner]);
    return s.id;
  };
  const S1 = await space(ADA, 'Fixture Law');
  const S2 = await space(STR, 'Elsewhere LLP');
  const matter = async (s, name, parent = null, tier = 'A') =>
    (await q(`insert into public.matterspaces (serverspace_id, name, parent_matterspace_id, ai_tier) values ($1,$2,$3,$4) returning id`, [s, name, parent, tier]))[0].id;
  const M = await matter(S1, 'Vashti v. Ormsby');
  const M2 = await matter(S1, 'Research', M);
  const MS = await matter(S1, 'Sealed exhibits', M, 'B');
  const X = await matter(S2, 'Unrelated');
  await q(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,'member'), ($1,$3,'viewer')`, [M, MEL, VIC]);

  // Case documents, with the metadata ingest writes and passages carrying the page keys.
  const doc = async (m, title, westlawCase, passages, extra = {}) => {
    const [{ id }] = await q(`insert into public.documents (matterspace_id, created_by, title, category, metadata)
      values ($1,$2,$3,$4,$5) returning id`, [m, ADA, title, extra.category ?? null, JSON.stringify(westlawCase ? { westlaw_case: westlawCase } : {})]);
    let seq = 0;
    for (const meta of passages) {
      await q(`insert into public.passages (document_id, matterspace_id, sequence_number, page_start, metadata) values ($1,$2,$3,$4,$5)`,
        [id, m, seq, seq + 1, meta === null ? null : JSON.stringify(meta)]);
      seq += 1;
    }
    return id;
  };
  const wc = (name, reporters) => ({ kind: 'case', case_name: name, reporters });
  // A Westlaw Supreme Court file that opens with the S. Ct. cite only (Pioneer,
  // 09-28): the index never learns "507 U.S. 380"; the single-star pages are
  // the U.S. Reports pages, unnamed.
  const PIONEER = await doc(M, 'Pioneer Inv Services Co v Brunswick Associates Ltd Partnership', {
    ...wc("Pioneer Inv. Servs. Co. v. Brunswick Assocs., Ltd. P'ship", [{ volume: 113, reporter: 'S. Ct.', page: 1489 }]),
    date: { year: 1993, month: 3, day: 24 }, court: { level: 'scotus', line: 'Supreme Court of the United States' },
  }, [
    { printed_page: 380, printed_page_end: 382, page_source: 'printed', star_pages: { 2: [1489, 1490] } },
    { printed_page: 394, printed_page_end: 396, page_source: 'printed', star_pages: { 2: [1497, 1498] } },
  ]);
  const ROE = await doc(M, 'Roe v. Doe', wc('Roe v. Doe', [
    { volume: 180, reporter: 'A.D.3d', page: 609 }, { volume: 117, reporter: 'N.Y.S.3d', page: 239 }, { volume: 9, reporter: 'N.E.3d', page: 500 }]), [
    { printed_page: 609, printed_page_end: 609, page_source: 'printed', star_pages: { 2: [239, 239] } },
    { printed_page: 609, printed_page_end: 610, page_source: 'printed', star_pages: { 2: [239, 240] } },
    { printed_page: 610, printed_page_end: 611, page_source: 'printed', star_pages: { 2: [240, 241] } },
  ]);
  const OWEN1 = await doc(M, 'Owen v. Jones (Westlaw)', wc('Owen v. Jones', [{ volume: 143, reporter: 'F.3d', page: 1219 }]),
    [{ printed_page: 1219, printed_page_end: 1220 }, { printed_page: 1221, printed_page_end: 1222 }]);
  const OWEN2 = await doc(M2, 'Owen v. Jones (court copy)', wc('Owen v. Jones', [{ volume: 143, reporter: 'F.3d', page: 1219 }]),
    [{ printed_page: 1219, printed_page_end: 1222 }]);
  const OWENX = await doc(X, 'Owen v. Jones', wc('Owen v. Jones', [{ volume: 143, reporter: 'F.3d', page: 1219 }]),
    [{ printed_page: 1219, printed_page_end: 1222 }]);
  const ONLYX = await doc(X, 'Only v. Elsewhere', wc('Only v. Elsewhere', [{ volume: 20, reporter: 'F.3d', page: 300 }]),
    [{ printed_page: 300, printed_page_end: 305 }]);
  const SEALED = await doc(MS, 'Sealed v. Case', wc('Sealed v. Case', [{ volume: 10, reporter: 'F.4th', page: 100 }]),
    [{ printed_page: 100, printed_page_end: 104 }]);
  const PDFIDX = await doc(M, 'Pdf v. Index', wc('Pdf v. Index', [{ volume: 99, reporter: 'F.3d', page: 10 }]),
    [{ page_source: 'pdf_index', printed_page_confidence: 'none' }, { page_source: 'pdf_index' }]);
  const BARE = await doc(M, 'Bare v. Copy', wc('Bare v. Copy', [{ volume: 98, reporter: 'F.3d', page: 20 }]), [null, null]);
  const SMITH = await doc(M, 'Smith v. Acme Corp.', null, [{}], { category: 'case' });   // a WL-only case, filed as a case
  const APPX = await doc(M, "Lee v. Park", wc('Lee v. Park', [{ volume: 770, reporter: "F. App'x", page: 12 }]),
    [{ printed_page: 12, printed_page_end: 15 }]);
  const all = { ROE, OWEN1, OWEN2, OWENX, ONLYX, SEALED, PDFIDX, BARE, APPX, PIONEER };

  // The rows: the backfill's path (levels read back from passages), through
  // the real upsertDocumentCitations — as the member's own session for the
  // firm's matter (api/ingest.mjs indexes as the uploader), service_role for
  // the others.
  const index = async (id) => {
    const metas = (await q(`select metadata from public.passages where document_id = $1 and summary_level = 0`, [id])).map((r) => r.metadata);
    const [{ metadata }] = await q(`select metadata from public.documents where id = $1`, [id]);
    return upsertDocumentCitations(client, id, metadata.westlaw_case, starLevelsFromPassages(metas));
  };
  await asUser(MEL);
  const melWrote = await index(ROE);
  check(melWrote.rows === 3, 'a matter member indexes a case in her own matter (the api/ingest.mjs session)', JSON.stringify(melWrote));
  await asRole('service_role');
  for (const id of Object.values(all)) if (id !== ROE) await index(id);
  const snapshot = async () => JSON.stringify(await q(`select document_id, reporter, volume, page, case_name, star_level
    from public.document_citations order by document_id, reporter`));
  const first = await snapshot();
  for (const id of Object.values(all)) await index(id);
  check(first === await snapshot(), 'the backfill run twice writes the same rows (idempotent)');
  const roeRows = await q(`select reporter, star_level from public.document_citations where document_id = $1 order by reporter`, [ROE]);
  check(JSON.stringify(roeRows) === JSON.stringify([{ reporter: 'A.D.3d', star_level: 1 }, { reporter: 'N.E.3d', star_level: null }, { reporter: 'N.Y.S.3d', star_level: 2 }]),
    'Roe: A.D.3d at level 1, N.Y.S.3d at level 2, N.E.3d at none', JSON.stringify(roeRows));
  await upsertDocumentCitations(client, BARE, { kind: 'other', reason: 're-read: not a case' }, {});
  check((await q(`select 1 from public.document_citations where document_id = $1`, [BARE])).length === 0,
    'a re-index whose header is no longer a case clears the document\'s rows');
  await index(BARE);

  if (verbose) console.log('\n--- C. resolve_citation, through src/lib/brief/resolve.ts -----------');
  const entry = (citation, pin = null, case_name = null) => ({ citation, pin, case_name });
  await asUser(MEL);
  {
    const r = await resolveEntry(client, M, entry('Roe v. Doe, 180 A.D.3d 609, 610 (1st Dep\'t 2020)'));
    check(r.status === 'resolved' && r.hits[0].document_id === ROE && r.hits[0].how === 'reporter',
      'a reporter hit: the one document in the matter that carries the cite', `${r.status} ${r.hits.length}`);
    check(r.passage?.basis === 'printed' && r.passage.printed_page <= 610 && r.passage.printed_page_end >= 610,
      '… opened at the passage on printed page 610', JSON.stringify(r.passage));
    const attrs = citeMarkAttrs(r);
    check(attrs.authority_document_id === ROE && attrs.passage_id === r.passage.passage_id && attrs.pin === '610',
      '… and the cite mark gets the document, the passage and the pin');
  }
  {
    const r = await resolveEntry(client, M, entry("Lee v. Park, 770 F. App'x 12, 14 (2d Cir. 2019)"));
    check(r.status === 'resolved' && r.hits[0].document_id === APPX, "F. App'x as a brief writes it finds the stored F. App'x", r.status);
  }
  {
    // The brief cites the U.S. Reports; the file opened with the S. Ct. cite only.
    const r = await resolveEntry(client, M, entry("Pioneer Inv. Servs. Co. v. Brunswick Assocs. Ltd. P'ship, 507 U.S. 380, 395 (1993)"));
    check(r.status === 'resolved' && r.hits[0].document_id === PIONEER && r.hits[0].how === 'name',
      'every reporter cite missed: the same case name AND year in the parsed header is the case (Pioneer)', `${r.status} ${r.hits[0]?.how}`);
    check(r.passage?.basis === 'printed' && r.passage.printed_page <= 395 && r.passage.printed_page_end >= 395,
      '… and a U.S. pin opens at the single-star (U.S. Reports) page of the Supreme Court file', JSON.stringify(r.passage));
    const wrongYear = await resolveEntry(client, M, entry("Pioneer Inv. Servs. Co. v. Brunswick Assocs. Ltd. P'ship, 507 U.S. 380, 395 (1994)"));
    check(wrongYear.status === 'not_in_corpus', 'the same name with another year is not that case — not in corpus', wrongYear.status);
    const noYear = await resolveEntry(client, M, entry("Pioneer Inv. Servs. Co. v. Brunswick Assocs. Ltd. P'ship, 507 U.S. 380, 395"));
    check(noYear.status === 'not_in_corpus', 'no year to check against: no name guess', noYear.status);
  }
  {
    const r = await resolveEntry(client, M, entry('Owen v. Jones, 143 F.3d 1219, 1221 (2d Cir. 1998)'));
    const ids = r.hits.map((h) => h.document_id).sort();
    check(r.status === 'two_copies' && ids.length === 2 && ids.includes(OWEN1) && ids.includes(OWEN2),
      'two copies (the matter and its sub-matter) → both, and the row says pick one', `${r.status} ${ids.length}`);
    check(!ids.includes(OWENX), 'the third copy, in another firm\'s matter, is not returned');
  }
  {
    const r = await resolveEntry(client, M, entry('Only v. Elsewhere, 20 F.3d 300, 301 (2d Cir. 1994)'));
    check(r.status === 'not_in_corpus', 'a document in another matter is not returned — not in corpus', r.status);
    const direct = (await client.rpc('resolve_citation', { p_matter: X, p_reporter: 'F.3d', p_volume: 20, p_page: 300, p_case_name: null })).data;
    check(direct.length === 0, 'naming the other firm\'s matter directly returns nothing either', `${direct.length} rows`);
    await asUser(STR);
    const pos = (await client.rpc('resolve_citation', { p_matter: X, p_reporter: 'F.3d', p_volume: 20, p_page: 300, p_case_name: null })).data;
    check(pos.length === 1 && pos[0].document_id === ONLYX, 'positive control: its own firm finds it', `${pos.length} rows`);
    await asUser(MEL);
  }
  {
    const r = await resolveEntry(client, M, entry('Smith v. Acme Corp., 2020 WL 12345, at *3 (S.D.N.Y. 2020)'));
    check(r.status === 'resolved' && r.hits[0].document_id === SMITH && r.hits[0].how === 'name',
      'no reporter cite → the name fallback finds the case filed as a case', `${r.status} ${r.hits[0]?.how}`);
    check(r.pin === null, '… and a WL star page is not taken for a reporter page');
    const w = await resolveEntry(client, M, entry('Roe v. Doe, 2019 WL 99999'));
    check(w.status === 'resolved' && w.hits[0].document_id === ROE,
      'the name fallback also finds a Westlaw case with no category (917 of these in production, 234 with one)', w.status);
    check(w.passage?.basis === 'printed' && w.passage.printed_page === 609,
      '… opened where the case begins (no pin, level 1)', JSON.stringify(w.passage));
  }
  {
    const r = await resolveEntry(client, M, entry('Roe v. Doe, 999 F.3d 1, 5 (2d Cir. 2021)'));
    check(r.status === 'not_in_corpus' && r.hits.length === 0,
      'a reporter cite that parsed and missed is NOT answered by a same-named document', `${r.status} ${r.hits[0]?.how ?? ''}`);
  }
  {
    const r = await resolveEntry(client, M, entry('Sealed v. Case, 10 F.4th 100, 102 (2d Cir. 2022)'));
    check(r.status === 'not_in_corpus', 'a sealed sub-matter is out of scope at aal1', r.status);
    await asUser(MEL, 'aal2');
    const r2 = await resolveEntry(client, M, entry('Sealed v. Case, 10 F.4th 100, 102 (2d Cir. 2022)'));
    check(r2.status === 'resolved' && r2.hits[0].document_id === SEALED, '… and in scope at aal2', r2.status);
    await asUser(MEL);
  }
  {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
    await db.exec('set role authenticated');
    const r = (await client.rpc('resolve_citation', { p_matter: M, p_reporter: 'A.D.3d', p_volume: 180, p_page: 609, p_case_name: null })).data;
    check(r.length === 0, 'an authenticated call with no uid returns nothing (never falls open)', `${r.length} rows`);
    await asRole('anon');
    const a = await client.rpc('resolve_citation', { p_matter: M, p_reporter: 'A.D.3d', p_volume: 180, p_page: 609, p_case_name: null });
    check(a.error !== null, 'anon may not call resolve_citation', a.error?.message ?? 'no error');
    await asRole('service_role');
    const s = (await client.rpc('resolve_citation', { p_matter: M, p_reporter: 'F.4th', p_volume: 10, p_page: 100, p_case_name: null })).data;
    check(s.length === 1 && s[0].document_id === SEALED, 'service_role passes through (row_security_active false), as 078 arranged for search');
    await asUser(VIC);
    const v = (await client.rpc('resolve_citation', { p_matter: M, p_reporter: 'A.D.3d', p_volume: 180, p_page: 609, p_case_name: null })).data;
    check(v.length === 1, 'a viewer of the matter resolves too (reading is enough)');
  }

  if (verbose) console.log('\n--- D. passage_for_printed_page --------------------------------------');
  await asUser(MEL);
  {
    const r = await resolveEntry(client, M, entry('Roe v. Doe, 117 N.Y.S.3d 239, 241 (2020)'));
    check(r.status === 'resolved' && r.hits[0].star_level === 2 && r.passage?.basis === 'parallel'
      && r.passage.printed_page <= 241 && r.passage.printed_page_end >= 241,
    'a parallel reporter\'s pin resolves through star_pages["2"]', JSON.stringify(r.passage));
    const all3 = await q(`select id from public.passages where document_id = $1 order by sequence_number`, [ROE]);
    check(r.passage.passage_id === all3[2].id, '… to the passage that carries page 241 (the third)');
    const par = await resolveEntry(client, M, entry('Roe v. Doe, 999 A.D.3d 1, 5, 117 N.Y.S.3d 239, 241 (2020)', '5'));
    check(par.status === 'resolved' && par.pin === 241 && par.passage?.passage_id === all3[2].id,
      'a parallel cite found by its second reporter pins with that reporter\'s page (241), not the extractor\'s first-reporter "5"',
      `${par.status} pin ${par.pin} ${par.passage?.basis}`);
    const r2 = await resolveEntry(client, M, entry('Roe v. Doe, 9 N.E.3d 500, 502 (2020)'));
    check(r2.status === 'resolved' && r2.passage?.basis === 'unknown' && /does not mark this reporter/.test(r2.passage.caveat)
      && r2.passage.passage_id === all3[0].id,
    'a reporter no star level carries → the first passage, and the caveat says this copy does not mark its pages', r2.passage?.caveat ?? '');
    const r3 = await resolveEntry(client, M, entry('Roe v. Doe, 180 A.D.3d 609, 650 (2020)'));
    check(r3.passage?.basis === 'pin_not_found' && /Page 650 .*609–611/.test(r3.passage.caveat) && r3.passage.passage_id === all3[0].id,
      'a pin outside the star pages → pin_not_found, first passage, the range in words', r3.passage?.caveat ?? '');
    const r4 = await passageForPrintedPage(client, ROE, 609, 1);
    check(r4.passage_id === all3[0].id, 'a page two passages share opens at the first of them');
  }
  {
    const p = await passageForPrintedPage(client, PDFIDX, 12, 1);
    check(p?.basis === 'pdf_index_declined' && p.caveat === PDF_INDEX_CAVEAT,
      'pdf_index_declined → the first passage with lib/cite-page.mjs\'s caveat, exactly', JSON.stringify(p));
    const b = await passageForPrintedPage(client, BARE, 21, 1);
    check(b?.basis === 'unknown' && b.caveat === 'No star pages in this copy — showing page 1', 'nothing recorded → unknown, "No star pages in this copy — showing page 1"', b?.caveat ?? '');
    const n = await passageForPrintedPage(client, BARE, 21, null);
    check(n?.basis === 'unknown' && /does not mark/.test(n.caveat), 'a null ordinal is never read as level 1');
  }
  {
    await asUser(STR);
    const p = await passageForPrintedPage(client, ROE, 610, 1);
    check(p === null, 'another firm cannot read a passage of this matter\'s document');
    await asUser(MEL);
    const s = await passageForPrintedPage(client, SEALED, 102, 1);
    check(s === null, 'a sealed document\'s passage is out of scope at aal1');
    await asUser(MEL, 'aal2');
    const s2 = await passageForPrintedPage(client, SEALED, 102, 1);
    check(s2?.basis === 'printed', '… and in scope at aal2');
    await asUser(MEL);
  }

  if (verbose) console.log('\n--- E. the table, the core, the grants -------------------------------');
  {
    await asUser(MEL);
    const seen = (await q(`select distinct document_id from public.document_citations`)).map((r) => r.document_id);
    check(!seen.includes(OWENX) && !seen.includes(ONLYX) && seen.includes(ROE),
      'document_citations: a member sees her matter\'s rows, never another firm\'s', `${seen.length} documents`);
    const ins = await attempt(`insert into public.document_citations (document_id, reporter, volume, page) values ($1,'F.3d',1,1)`, [OWENX]);
    check(ins !== null, 'she cannot index another firm\'s document');
    await asUser(VIC);
    const vins = await attempt(`insert into public.document_citations (document_id, reporter, volume, page) values ($1,'F.3d',1,1)`, [ROE]);
    check(vins !== null, 'a viewer cannot write the index');
    const vdel = await q(`delete from public.document_citations where document_id = $1 returning 1`, [ROE]);
    check(vdel.length === 0, 'a viewer\'s delete matches nothing');
    await asUser(STR);
    const sdel = await q(`delete from public.document_citations where document_id = $1 returning 1`, [ROE]);
    check(sdel.length === 0, 'another firm\'s delete matches nothing');
    await asRole('anon');
    const an = await attempt(`select 1 from public.document_citations`);
    check(an !== null, 'anon cannot read the table');
    const core = await attempt(`select * from brief_internal.resolve_citation_core(array[$1::uuid], 'F.3d', 20, 300, null)`, [X]);
    check(core !== null, 'anon cannot reach the private core', core?.message ?? '');
    await asSuper();
    const [{ secdef }] = await q(`select bool_and(p.prosecdef) filter (where n.nspname = 'brief_internal' and p.proname like '%_core')
        and not bool_or(p.prosecdef) filter (where n.nspname = 'public' and p.proname in ('resolve_citation','passage_for_printed_page')) as secdef
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace`);
    check(secdef === true, 'the cores are SECURITY DEFINER; both public wrappers are INVOKER');
  }
  await db.close();
  quiet = false;
}

// ===========================================================================
console.log('\n--- B–E. the real migration 101 -------------------------------------');
// ===========================================================================
const REAL = migrationSql('101_citation_resolvers.sql');
await scenario(REAL, { verbose: true });
const realFailures = failures;

// ===========================================================================
console.log('\n--- F. mutation check: a weakened 101 must fail by name ------------');
// ===========================================================================
const mutants = [
  {
    name: 'no scope check (every descendant, accessible or not)',
    from: `     where public.can_access_matter(t.id)\n       and (v_open or not public.effective_tier_is_sealed(t.id));`,
    to: `     where true;`,
    expect: ['a sealed sub-matter is out of scope at aal1'],
  },
  {
    name: 'the name fallback runs after a reporter miss',
    from: `     where (p_reporter is null or p_volume is null or p_page is null)\n       and p_case_name is not null`,
    to: `     where p_case_name is not null`,
    expect: null,   // resolve.ts only sends a name with no reporter — see below
  },
  {
    name: 'passage_for_printed_page skips its scope check',
    from: `    if v_matter is null\n       or not public.can_access_matter(v_matter)\n       or (not public.sealed_entry_allowed() and public.effective_tier_is_sealed(v_matter)) then\n      return;\n    end if;`,
    to: `    null;`,
    expect: ['a sealed document\'s passage is out of scope at aal1'],
  },
];
const normalized = REAL.replace(/\r\n/g, '\n');
for (const m of mutants) {
  if (!m.expect) continue;
  if (!normalized.includes(m.from)) { check(false, `mutant "${m.name}" applies to the migration text`); continue; }
  const before = failed.length;
  await scenario(normalized.replace(m.from, m.to), { verbose: false });
  const caught = failed.slice(before);
  failed.length = before;
  failures = realFailures;
  const named = m.expect.every((label) => caught.includes(label));
  console.log(`  ${named ? 'PASS' : 'FAIL'}  mutant "${m.name}" is caught${named ? ` (${caught.length} named FAILs, e.g. "${m.expect[0]}")` : ` — expected "${m.expect.join('", "')}", got ${JSON.stringify(caught)}`}`);
  if (!named) { failures += 1; }
}
// The reporter-miss rule is the SQL's, not only resolve.ts's (which never
// sends both): call the core the way a later caller (check.ts corpus-first)
// might, with a reporter AND a name, on the real 101 and on the mutant.
{
  const missThenName = async (sql) => {
    const db = await freshDb();
    await db.exec(sql);
    const MID = '22222222-2222-2222-2222-222222222222';
    await db.exec(`insert into public.documents (matterspace_id, title, category) values ('${MID}', 'Roe v. Doe', 'case')`);
    const ok = (await db.query(`select * from brief_internal.resolve_citation_core(array['${MID}'::uuid], null, null, null, 'Roe v. Doe')`)).rows.length;
    const miss = (await db.query(`select * from brief_internal.resolve_citation_core(array['${MID}'::uuid], 'F.3d', 999, 1, 'Roe v. Doe')`)).rows.length;
    await db.close();
    return { ok, miss };
  };
  const real = await missThenName(REAL);
  check(real.ok === 1 && real.miss === 0,
    'the SQL itself never answers a parsed reporter cite by name, whatever the caller sends (control: the name alone finds it)', JSON.stringify(real));
  const mut = normalized.replace(mutants[1].from, mutants[1].to);
  const weak = mut === normalized ? null : await missThenName(mut);
  check(weak !== null && weak.miss === 1, `mutant "${mutants[1].name}" is caught by the check above`, JSON.stringify(weak));
}

console.log(`\n${failures ? `FAIL (${failures})` : 'PASS'}`);
process.exit(failures ? 1 : 0);
