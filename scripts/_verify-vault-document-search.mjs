// Migration 081, EXECUTED — document search, categories, and the matter
// boundary that has to hold across all of it.
//
// Why this shape
// ---------------------------------------------------------------------------
// 081 does the same thing 078 does: it moves the access check off the per-row
// policy and into an INVOKER wrapper, and then does the real work inside a
// SECURITY DEFINER function where no policy runs at all. A harness that ran as
// the superuser could not tell that being safe apart from that being a data
// leak, because RLS never applied to it in the first place. So this one creates
// `anon` / `authenticated` / `service_role` for real, enables RLS with the real
// `can_access_matter` policy from 016, and does every isolation assertion from
// inside `SET ROLE authenticated` with `request.jwt.claims` set the way
// PostgREST sets it.
//
// Two users. Three matters:
//   * Fleming          — shared with both (B is a member)
//   * Teman            — A's alone, never shared
//   * Teman — annex    — A's alone AND sealed (ai_tier 'B')
// plus a fourth matter in a serverspace neither of them can see at all.
//
//   npm i --no-save @electric-sql/pglite @electric-sql/pglite-pgvector
//   node scripts/_verify-vault-document-search.mjs
//
// No .env, no network, no prod.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let PGlite, pg_trgm;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm'));
} catch {
  console.error('Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = (name) => path.resolve(__dirname, '..', 'supabase', 'migrations', name);
const migration = (name) => {
  console.log(`  executing ${path.relative(process.cwd(), migrationPath(name))}`);
  return fs.readFileSync(migrationPath(name), 'utf8');
};
const M081 = '081_vault_document_search_and_category.sql';

// PGlite attaches its whole bundled module source to a thrown error, which
// turns one bad statement into a megabyte of unreadable CI log.
process.on('uncaughtException', (e) => {
  console.error(`\n  SQL ERROR: ${e?.message ?? e}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(`\n  SQL ERROR: ${e?.message ?? e}\n`);
  process.exit(1);
});

const db = new PGlite({ extensions: { pg_trgm } });
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------------------
// Schema: enough of 001/002/005/016/051 that the REAL policy can run.
// ---------------------------------------------------------------------------
console.log('\n--- schema, roles, RLS ---------------------------------------');
await db.exec(`
  create schema if not exists auth;
  create role anon;
  create role authenticated;
  -- BYPASSRLS, exactly as production has it.
  create role service_role bypassrls;

  create table public.serverspaces (id uuid primary key default gen_random_uuid(), name text);
  create table public.matterspaces (
    id uuid primary key default gen_random_uuid(),
    serverspace_id uuid,
    parent_matterspace_id uuid,
    name text,
    -- migration 051: 'A' open, 'B' sealed, 'C' silo. The seal inherits down.
    ai_tier text not null default 'A'
  );
  create table public.serverspace_members (
    serverspace_id uuid, user_id uuid, role text, primary key (serverspace_id, user_id));
  create table public.matterspace_members (
    matterspace_id uuid, user_id uuid, role text, primary key (matterspace_id, user_id));
  create table public.documents (
    id uuid primary key default gen_random_uuid(),
    matterspace_id uuid not null,
    title text not null,
    doc_type text not null default 'other',
    source_filename text,
    file_size_bytes bigint,
    page_count int,
    storage_path text,
    processing_status text not null default 'ready',
    processing_error text,
    metadata jsonb not null default '{}',
    created_by uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create index idx_documents_matterspace on public.documents(matterspace_id);
`);

await db.exec(`
  create function auth.uid() returns uuid language sql stable as $fn$
    select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
  $fn$;

  create function public.matter_ancestry(p_matter_id uuid)
  returns table(id uuid) language sql stable security definer set search_path to 'public' as $fn$
    with recursive a(id, parent_matterspace_id) as (
      select id, parent_matterspace_id from public.matterspaces where id = p_matter_id
      union all
      select m.id, m.parent_matterspace_id
        from public.matterspaces m join a on m.id = a.parent_matterspace_id
    )
    select id from a
  $fn$;

  create function public.matter_role(p_matter_id uuid)
  returns text language plpgsql stable security definer set search_path to 'public' as $fn$
  declare
    uid uuid := auth.uid();
    best text;
  begin
    if uid is null then return null; end if;
    select role into best from (
      select mm.role from public.matterspace_members mm
        where mm.user_id = uid
          and mm.matterspace_id in (select id from public.matter_ancestry(p_matter_id))
      union all
      select sm.role from public.matterspaces m
        join public.serverspace_members sm on sm.serverspace_id = m.serverspace_id
       where m.id = p_matter_id and sm.user_id = uid
    ) r
    order by case role when 'owner' then 4 when 'admin' then 3
                       when 'member' then 2 when 'viewer' then 1 else 0 end desc
    limit 1;
    return best;
  end $fn$;

  create function public.can_access_matter(p_matter_id uuid)
  returns boolean language sql stable security definer set search_path to 'public' as $fn$
    select public.matter_role(p_matter_id) is not null
  $fn$;

  create function public.can_write_matter(p_matter_id uuid)
  returns boolean language sql stable security definer set search_path to 'public' as $fn$
    select public.matter_role(p_matter_id) in ('owner','admin','member')
  $fn$;

  alter table public.documents   enable row level security;
  alter table public.matterspaces enable row level security;
  create policy d_sel on public.documents for select using (can_access_matter(matterspace_id));
  create policy d_upd on public.documents for update using (can_write_matter(matterspace_id));
  create policy m_sel on public.matterspaces for select using (can_access_matter(id));

  grant usage on schema public to anon, authenticated, service_role;
  grant select, update on all tables in schema public to anon, authenticated, service_role;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`);
console.log('  real pg_trgm, real RLS, real anon/authenticated/service_role');

// ---------------------------------------------------------------------------
// 081 itself.
// ---------------------------------------------------------------------------
console.log('\n--- migration 081 --------------------------------------------');
await db.exec(migration(M081));
check(true, '081 executes against a database that has never seen it');

const cols = await q(`
  select column_name, is_generated from information_schema.columns
   where table_name = 'documents'
     and column_name in ('category','category_source','category_at','sort_key','category_rank')
   order by column_name`);
check(cols.length === 5, 'all five columns exist', cols.map((c) => c.column_name).join(', '));
// NOT generated, on purpose. `copy_document` in lib/mcp-core.mjs reads a
// document with select('*'), strips six keys and inserts the rest; a generated
// column in that row is rejected outright (428C9), so copying a document would
// start failing the moment 081 was applied. The trigger in section 6 keeps
// them true instead — see the round-trip check below.
check(
  cols.every((c) => c.is_generated !== 'ALWAYS'),
  'no column is GENERATED — a full-row round trip must keep working',
  cols.map((c) => `${c.column_name}:${c.is_generated}`).join(' '),
);

const idx = (await q(
  `select indexname from pg_indexes where tablename = 'documents' order by indexname`))
  .map((r) => r.indexname);
for (const want of [
  'idx_documents_sortkey_prefix',
  'idx_documents_matter_sortkey',
  'idx_documents_matter_category',
  'idx_documents_matter_created',
  'idx_documents_name_trgm',
]) check(idx.includes(want), `index ${want} was built`);

// ---------------------------------------------------------------------------
// Corpus.
// ---------------------------------------------------------------------------
console.log('\n--- corpus ---------------------------------------------------');
const ALICE = '4b9d1b0e-0000-4000-8000-00000000a11c';
const BOB   = '4b9d1b0e-0000-4000-8000-00000000b0b0';
const MALLORY = '4b9d1b0e-0000-4000-8000-00000000dead';

const mkServer = async (name) =>
  (await one(`insert into public.serverspaces (name) values ($1) returning id`, [name])).id;
const mkMatter = async (ss, name, tier = 'A', parent = null) =>
  (await one(
    `insert into public.matterspaces (serverspace_id, name, ai_tier, parent_matterspace_id)
     values ($1,$2,$3,$4) returning id`, [ss, name, tier, parent])).id;
const mkDoc = async (m, filename, title = null, when = null) =>
  (await one(
    `insert into public.documents (matterspace_id, title, source_filename, created_at, created_by)
     values ($1,$2,$3, coalesce($4, now()), $5) returning id`,
    [m, title ?? filename, filename, when, ALICE])).id;

// Alice owns her firm's serverspace; Bob is a member of ONE matter inside it.
const ssMine = await mkServer('Quainton Law');
const ssTheirs = await mkServer('Someone Else LLP');
await q(`insert into public.serverspace_members values ($1,$2,'owner')`, [ssMine, ALICE]);
await q(`insert into public.serverspace_members values ($1,$2,'owner')`, [ssTheirs, MALLORY]);

const mShared = await mkMatter(ssMine, 'Fleming v. City of New York');
const mPrivate = await mkMatter(ssMine, 'Teman v. ClearHome');
const mSealed = await mkMatter(ssMine, 'Teman — sealed annex', 'B');
const mSealedKid = await mkMatter(ssMine, 'Teman — annex, sub', 'A', mSealed);
const mForeign = await mkMatter(ssTheirs, 'Not our matter');
await q(`insert into public.matterspace_members values ($1,$2,'member')`, [mShared, BOB]);

const SHARED_NAMES = [
  'Watson v Long Island RCo.pdf',
  'Glasstech Inc v Freund.pdf',
  'Fed. R. Civ. P. 26.pdf',
  '2026-09-08 Decl of Smith in Support of Motion to Dismiss.docx',
  'Ex. 7 - Watson v. Long Island R. Co..pdf',
  'Memorandum of Law in Opposition.docx',
  '29 U.S.C. § 216(b).pdf',
  'Wright & Miller, Federal Practice § 1391.pdf',
  'photo of the gate.jpg',
  'The Watsonville Report.pdf',
];
for (const n of SHARED_NAMES) await mkDoc(mShared, n);
// A recency spread for the date filter, all tied on created_at inside a day so
// the paging assertions exercise the tiebreaker.
await mkDoc(mShared, 'Watson supplemental letter.pdf', null, '2024-01-01T00:00:00Z');
await mkDoc(mShared, 'Watson reply letter.pdf', null, '2024-01-01T00:00:00Z');

const SECRET = 'Watson privileged analysis.docx';
await mkDoc(mPrivate, SECRET);
await mkDoc(mSealed, 'Watson sealed annex.pdf');
await mkDoc(mSealedKid, 'Watson sealed annex child.pdf');
await mkDoc(mForeign, 'Watson someone elses file.pdf');
console.log(`  ${(await one(`select count(*)::int n from public.documents`)).n} documents, 5 matters, 3 users`);

// ---------------------------------------------------------------------------
// Running as somebody.
// ---------------------------------------------------------------------------
// `commit: true` for the writes whose EFFECT a later assertion reads; the
// default rolls back, which keeps a read-only probe from disturbing the corpus.
const as = async (uid, sql, params = [], role = 'authenticated', commit = false) => {
  await db.exec('begin');
  await db.query(`select set_config('role', $1, true)`, [role]);
  await db.query(
    `select set_config('request.jwt.claims', $1, true)`,
    [uid ? JSON.stringify({ sub: uid, role }) : ''],
  );
  let out;
  try {
    out = (await db.query(sql, params)).rows;
  } catch (e) {
    await db.exec('rollback');
    throw e;
  }
  await db.exec(commit ? 'commit' : 'rollback');
  return out;
};
const search = (uid, args = {}) => as(uid, `
  select * from public.search_documents($1,$2,$3,$4,$5,$6,$7)`, [
  args.q ?? '', args.matters ?? null, args.categories ?? null,
  args.from ?? null, args.to ?? null, args.limit ?? 20, args.offset ?? 0,
]);

// ---------------------------------------------------------------------------
// A. Strict matter isolation, for every filter.
// ---------------------------------------------------------------------------
console.log('\n--- A. isolation ---------------------------------------------');

const aliceAll = await search(ALICE, { q: 'watson', limit: 100 });
check(aliceAll.length >= 6, 'Alice, who owns all of it, finds her documents', `${aliceAll.length} hits`);
check(
  aliceAll.some((r) => r.source_filename === SECRET),
  'CONTROL — the private document IS reachable, by the person it belongs to',
);

const bobAll = await search(BOB, { q: 'watson', limit: 100 });
check(bobAll.length > 0, 'Bob finds the matter he was actually shared', `${bobAll.length} hits`);
check(
  bobAll.every((r) => r.matterspace_id === mShared),
  'and NOTHING from any other matter — not the private one, not the sealed one',
  [...new Set(bobAll.map((r) => r.matterspace_name))].join(' | '),
);

// The same question with every filter, one at a time. Each must stay inside
// the boundary; a filter is not an authorization.
const filtered = [
  ['no query at all', { q: '', limit: 100 }],
  ['a category filter', { q: '', categories: ['case', 'supporting', 'other'], limit: 100 }],
  ['a date range', { q: '', from: '2000-01-01T00:00:00Z', to: '2099-01-01T00:00:00Z', limit: 100 }],
  ['a two-character query (prefix branch)', { q: 'wa', limit: 100 }],
  ['a long query (trigram branch)', { q: 'watson', limit: 100 }],
  ['deep paging', { q: '', limit: 100, offset: 0 }],
];
for (const [label, args] of filtered) {
  const rows = await search(BOB, args);
  check(
    rows.every((r) => r.matterspace_id === mShared),
    `Bob stays inside his one matter with ${label}`,
    `${rows.length} rows`,
  );
}

// Naming the ids directly is the attack that matters: the wrapper must drop
// them, not trust them.
const spoof = await search(BOB, {
  q: 'watson', matters: [mShared, mPrivate, mSealed, mSealedKid, mForeign], limit: 100,
});
check(
  spoof.length > 0 && spoof.every((r) => r.matterspace_id === mShared),
  'Bob naming every matter id by hand still gets only his own',
  `${spoof.length} rows from ${[...new Set(spoof.map((r) => r.matterspace_name))].join(' | ')}`,
);
const spoofOnly = await search(BOB, { q: 'watson', matters: [mPrivate, mForeign], limit: 100 });
check(spoofOnly.length === 0, 'naming ONLY matters he cannot read returns nothing at all');

const anon = await search(null, { q: 'watson', limit: 100 });
check(anon.length === 0, 'anon — a JWT with no subject — gets nothing, and never reaches the core');

const stranger = await search(MALLORY, { q: 'watson', limit: 100 });
check(
  stranger.every((r) => r.matterspace_id === mForeign),
  'the other firm sees only the other firm',
  `${stranger.length} rows`,
);

// The core is DEFINER, so the only thing standing between a caller and every
// document on the deployment is that it has no REST endpoint and no grant to
// anon. Assert both.
const exposed = await q(
  `select nspname from pg_namespace where nspname = 'vault_internal'`);
check(exposed.length === 1, 'the core lives in vault_internal, not in public');
const anonGrant = await q(`
  select has_function_privilege('anon',
    'vault_internal.search_documents_core(uuid[],text,text[],timestamptz,timestamptz,int,int)',
    'execute') as ok`);
check(anonGrant[0].ok === false, 'anon cannot execute the DEFINER core even by name');

// A caller that bypasses RLS must name its scope or be refused — otherwise a
// script that forgot an argument searches every tenant on the deployment.
let bypassErr = null;
try {
  await as(null, `select * from public.search_documents('watson')`, [], 'service_role');
} catch (e) { bypassErr = e; }
check(
  bypassErr !== null && /p_matterspace_ids is required/.test(bypassErr.message ?? ''),
  'service_role with no scope is REFUSED, not given the whole deployment',
  bypassErr?.message?.slice(0, 80),
);
const bypassScoped = await as(
  null, `select * from public.search_documents('watson', $1)`, [[mPrivate]], 'service_role');
check(bypassScoped.length === 1, 'service_role naming its scope still works', `${bypassScoped.length} rows`);

// ---------------------------------------------------------------------------
// B. Nothing but metadata ever comes back.
// ---------------------------------------------------------------------------
console.log('\n--- B. metadata only -----------------------------------------');
const returned = (await q(`
  select unnest(proargnames) as n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'search_documents'`)).map((r) => r.n);
const forbidden = returned.filter((n) => /^(text|body|passage|content|tsv|embedding|preview)/.test(n));
check(forbidden.length === 0, 'no result column could carry body text', forbidden.join(', ') || 'none');

// ---------------------------------------------------------------------------
// C. Ranking.
// ---------------------------------------------------------------------------
console.log('\n--- C. ranking -----------------------------------------------');
const ranked = await search(ALICE, { q: 'watson', limit: 100 });
const order = ranked.map((r) => r.source_filename);
const at = (name) => order.findIndex((n) => n === name);
check(
  at('Watson v Long Island RCo.pdf') < at('Ex. 7 - Watson v. Long Island R. Co..pdf'),
  'a title that STARTS with the word beats one where it appears mid-string',
  order.slice(0, 4).join(' | '),
);
check(
  at('Watson v Long Island RCo.pdf') < at('The Watsonville Report.pdf'),
  'an exact word beats a longer word that merely contains it',
);
check(
  ranked.every((r, i) => i === 0 || Number(ranked[i - 1].rank) >= Number(r.rank)),
  'rank is monotonically non-increasing down the list',
);
const exact = await search(ALICE, { q: 'watson v long island rco.pdf', limit: 10 });
check(
  exact[0]?.source_filename === 'Watson v Long Island RCo.pdf' && Number(exact[0].rank) >= 4,
  'typing the whole name puts that document first, at the exact-match tier',
  `${exact[0]?.source_filename} rank ${exact[0]?.rank}`,
);
const short = await search(ALICE, { q: 'wa', limit: 50 });
check(
  short.length > 0 && short.every((r) => r.sort_key === undefined || true),
  'a two-character query still answers (prefix branch)',
  `${short.length} hits`,
);
check(
  short.every((r) => /^(the )?wa/i.test(r.source_filename ?? '') || /^wa/i.test(r.source_filename ?? '')),
  'and only with names that START with it — not every name containing "wa"',
  short.map((r) => r.source_filename).join(' | '),
);
// LIKE metacharacters are characters, not wildcards.
const pct = await search(ALICE, { q: '%', limit: 50 });
check(pct.length === 0, 'a bare % matches nothing — it is escaped, not a wildcard');
const under = await search(ALICE, { q: 'w_tson', limit: 50 });
check(under.length === 0, 'an underscore is a literal underscore, not "any character"');

// ---------------------------------------------------------------------------
// D. Paging is stable, and the bounds hold.
// ---------------------------------------------------------------------------
console.log('\n--- D. paging and bounds -------------------------------------');
const whole = await search(ALICE, { q: '', limit: 100 });
const pages = [];
for (let off = 0; off < whole.length; off += 3) {
  pages.push(...await search(ALICE, { q: '', limit: 3, offset: off }));
}
check(
  pages.map((r) => r.document_id).join() === whole.map((r) => r.document_id).join(),
  'three-at-a-time paging reproduces the single-page order exactly — nothing duplicated, nothing dropped',
  `${pages.length} paged vs ${whole.length} whole`,
);
check(
  new Set(pages.map((r) => r.document_id)).size === pages.length,
  'every document appears exactly once across the pages',
);
const huge = await search(ALICE, { q: '', limit: 100000 });
check(huge.length <= 100, 'a caller asking for 100,000 rows gets at most 100', `${huge.length}`);
const deep = await search(ALICE, { q: '', limit: 10, offset: 999999 });
check(Array.isArray(deep) && deep.length === 0, 'an absurd offset is clamped and returns empty, not an error');
const zero = await search(ALICE, { q: '', limit: 0 });
check(zero.length === 1, 'limit 0 is clamped up to 1 rather than meaning "no bound"', `${zero.length}`);

// The date filter.
const old = await search(ALICE, {
  q: '', from: '2023-12-01T00:00:00Z', to: '2024-02-01T00:00:00Z', limit: 100 });
check(old.length === 2, 'the date range returns the two 2024 documents and nothing else', `${old.length}`);

// ---------------------------------------------------------------------------
// E. The sealed flag.
// ---------------------------------------------------------------------------
console.log('\n--- E. sealed matters ----------------------------------------');
const sealedRows = aliceAll.filter((r) => r.sealed === true);
check(
  sealedRows.length === 2,
  'both the sealed matter AND its open-tiered child are flagged — the seal inherits downward',
  sealedRows.map((r) => r.matterspace_name).join(' | '),
);
check(
  aliceAll.filter((r) => r.matterspace_id === mShared).every((r) => r.sealed === false),
  'an unsealed matter is not flagged',
);
check(
  aliceAll.some((r) => r.matterspace_id === mSealed),
  'a sealed matter is INCLUDED for the person whose matter it is — the in-app rule, not the connector one',
);

// ---------------------------------------------------------------------------
// F. Categories: deterministic, and a person's choice is untouchable.
// ---------------------------------------------------------------------------
console.log('\n--- F. categories --------------------------------------------');
// Real-shaped names: Westlaw exports, PACER filenames, scanned exhibits.
const FIXTURE = [
  ['Glasstech Inc v Freund.pdf', 'case'],
  ['Watson v Long Island RCo.pdf', 'case'],
  ['Eletson Holdings v Levona.pdf', 'case'],
  ['In re Teligent, Inc..pdf', 'case'],
  ['Soft Drink Workers Local 812 v. Pepsi.pdf', 'case'],
  ['Baker v. Carr, 369 U.S. 186.pdf', 'case'],
  ['550 F.3d 1222 opinion.pdf', 'case'],
  ['Fed. R. Civ. P. 26.pdf', 'rule'],
  ['Fed. R. Evid. 803.pdf', 'rule'],
  ['FRCP 37 sanctions text.pdf', 'rule'],
  ['Local Civil Rule 37.2.pdf', 'rule'],
  ['Rule 11 text.pdf', 'rule'],
  ['29 U.S.C. § 216(b).pdf', 'statute'],
  ['CPLR 3101 text.pdf', 'statute'],
  ['17 C.F.R. 240.10b-5.pdf', 'statute'],
  ['NYC Admin Code 8-107.pdf', 'statute'],
  ['Wright & Miller, Federal Practice § 1391.pdf', 'secondary'],
  ['Harvard Law Review - Spoliation.pdf', 'secondary'],
  ['Restatement (Second) of Torts § 402A.pdf', 'secondary'],
  ['76 Yale L. Rev. 101.pdf', 'secondary'],
  ['Complaint.pdf', 'pleading'],
  ['Amended Answer and Counterclaims.pdf', 'pleading'],
  ['Motion to Dismiss.pdf', 'pleading'],
  ['Memorandum of Law in Opposition.docx', 'pleading'],
  ['Reply Brief.docx', 'pleading'],
  ['Notice of Appeal.pdf', 'pleading'],
  ['Order granting protective order.pdf', 'pleading'],
  ['Decl. of Ari Teman.pdf', 'supporting'],
  ['Declaration of Eden Quainton in Support of Motion.docx', 'supporting'],
  ['Affidavit of Service.pdf', 'supporting'],
  ['Ex 7 MRI report 2019.pdf', 'supporting'],
  ['Exhibit A - lease.pdf', 'supporting'],
  ['Deposition of Felix Ezekwe - FULL SIZE.pdf', 'supporting'],
  ['Transcript Aug 16 AMKC.txt', 'supporting'],
  ['2026-09-08 Decl of Smith in Support of Motion to Dismiss.docx', 'supporting'],
  ['Letter to Judge Gorenstein.pdf', 'supporting'],
  ['email thread re production.eml', 'supporting'],
  // A photograph IS supporting material — an exhibit by another name. The
  // three below have nothing in their names to go on at all, which is what
  // "other" is for.
  ['photo of the gate.jpg', 'supporting'],
  ['IMG_2291.HEIC', 'other'],
  ['scan0001.pdf', 'other'],
  ['Fleming AMKC intake.xlsx', 'other'],
];
let wrong = [];
for (const [name, want] of FIXTURE) {
  const got = (await one(`select public.document_category_rule($1, $1) as c`, [name])).c;
  if (got !== want) wrong.push(`${name} → ${got} (wanted ${want})`);
}
check(wrong.length === 0, `all ${FIXTURE.length} real-shaped names land on the right shelf`,
  wrong.slice(0, 5).join(' ; '));

// The sort key: what the A–Z list actually orders by.
const SORT = [
  ['2026-09-08 04 - Watson v Long Island RCo.pdf', 'watson v long island rco'],
  ['The Watsonville Report.pdf', 'watsonville report'],
  ['In re Teligent, Inc..pdf', 'teligent, inc.'],
  ['Watson v. Long Island R.Co', 'watson v. long island r.co'],
  ['12. Glasstech Inc v Freund.pdf', 'glasstech inc v freund'],
  ['09.08.26 Decl of Smith.docx', 'decl of smith'],
  ['   Baker   v.  Carr  .pdf', 'baker v. carr'],
];
let badKeys = [];
for (const [name, want] of SORT) {
  const got = (await one(`select public.document_sort_key($1) as k`, [name])).k;
  if (got !== want) badKeys.push(`${name} → "${got}" (wanted "${want}")`);
}
check(badKeys.length === 0, 'the A–Z key strips extensions, leading dates, indices and articles',
  badKeys.join(' ; '));

// The insert trigger.
const fresh = await mkDoc(mShared, 'Motion for Summary Judgment.pdf');
const freshRow = await one(
  `select category, category_source, sort_key, category_rank
     from public.documents where id = $1`, [fresh]);
check(freshRow.category === 'pleading' && freshRow.category_source === 'rule',
  'a newly uploaded document is already on a shelf', `${freshRow.category}/${freshRow.category_source}`);
check(freshRow.sort_key === 'motion for summary judgment' && freshRow.category_rank === 5,
  'and its sort key and shelf order were computed for it',
  `${freshRow.sort_key} / ${freshRow.category_rank}`);

// THE `copy_document` CASE. lib/mcp-core.mjs reads a row with select('*'),
// deletes six keys and inserts the rest. Everything 081 adds travels in that
// row, so this is the exact shape that a GENERATED column would have broken —
// and the trigger has to put the derived values back for the new matter.
const roundTrip = await one(`
  with src as (select * from public.documents where id = $1)
  insert into public.documents
    (matterspace_id, title, doc_type, source_filename, file_size_bytes, page_count,
     processing_status, metadata, category, category_source, category_at,
     sort_key, category_rank, created_by)
  select $2, title, doc_type, source_filename, file_size_bytes, page_count,
         processing_status, metadata, category, category_source, category_at,
         'DELIBERATELY WRONG', 99, created_by
    from src
  returning id, sort_key, category_rank, category`, [fresh, mPrivate]);
check(roundTrip.sort_key === 'motion for summary judgment' && roundTrip.category_rank === 5,
  'a whole row written back (copy_document) is accepted, and the derived columns are recomputed',
  `${roundTrip.sort_key} / ${roundTrip.category_rank}`);
check(roundTrip.category === 'pleading',
  'while the copy keeps the category the original carried');
await db.query(`delete from public.documents where id = $1`, [roundTrip.id]);

// A rename re-files the sort key; a status tick does not wake the trigger.
await db.query(
  `update public.documents set source_filename = 'Zulu final order.pdf' where id = $1`, [fresh]);
const renamed = await one(`select sort_key, category, category_source from public.documents where id = $1`, [fresh]);
check(renamed.sort_key === 'zulu final order',
  'renaming a document moves it in the A–Z list', renamed.sort_key);
check(renamed.category === 'pleading' && renamed.category_source === 'rule',
  'but the trigger never RE-DECIDES the category on an update',
  `${renamed.category}/${renamed.category_source}`);

// The organize pass, as Alice. Every row in this matter already has a category
// (the insert trigger gave it one), so first put the matter back into the state
// an EXISTING deployment is in the moment 081 is pasted: no categories at all,
// because 081 deliberately does not backfill.
await db.query(
  `update public.documents set category = null, category_source = null, category_at = null
    where matterspace_id = $1`, [mShared]);
const runOrganize = (uid, matters, commit = false) => as(uid,
  `select * from public.organize_matter_documents($1)`, [matters], 'authenticated', commit);
const first = await runOrganize(ALICE, [mShared], true);
const assigned = first.reduce((n, r) => n + Number(r.assigned), 0);
check(assigned >= 12, 'the organize pass files the whole matter in one statement',
  `${assigned} documents`);
const secondRun = await runOrganize(ALICE, [mShared], true);
check(secondRun.length === 0,
  'a SECOND pass updates zero rows — it is free, not a rewrite of the matter',
  `${secondRun.length} groups`);

const shelved = await q(
  `select category, count(*)::int n from public.documents
    where matterspace_id = $1 group by category order by category`, [mShared]);
check(shelved.every((r) => r.category !== null), 'every document in the matter now has a category',
  shelved.map((r) => `${r.category}:${r.n}`).join(' '));

// A person's choice.
const target = (await one(
  `select id from public.documents where matterspace_id = $1 and source_filename like 'Ex. 7%'`,
  [mShared])).id;
await db.query(`select public.set_document_category($1, 'case')`, [target]);
await db.query(`select * from public.organize_matter_documents($1)`, [[mShared]]);
const kept = await one(
  `select category, category_source from public.documents where id = $1`, [target]);
check(kept.category === 'case' && kept.category_source === 'user',
  'a category a person set survives the organize pass, unchanged',
  `${kept.category}/${kept.category_source}`);

// Clearing it hands the row back to the rule.
await db.query(`select public.set_document_category($1, null)`, [target]);
const cleared = await one(
  `select category, category_source from public.documents where id = $1`, [target]);
check(cleared.category === 'supporting' && cleared.category_source === 'rule',
  'clearing it returns the row to the automatic answer', `${cleared.category}/${cleared.category_source}`);

let badCat = null;
try { await db.query(`select public.set_document_category($1, 'nonsense')`, [target]); }
catch (e) { badCat = e; }
check(badCat !== null, 'an invented category is refused');

// Somebody else's document. The UPDATE policy hides the row, so the function
// must SAY it refused rather than return null, which the surface would paint
// as "Unfiled".
const secretDoc = (await one(
  `select id from public.documents where matterspace_id = $1 limit 1`, [mPrivate])).id;
let refused = null;
try {
  await as(BOB, `select public.set_document_category($1, 'case')`, [secretDoc]);
} catch (e) { refused = e; }
check(refused !== null && /not one you can re-file/.test(refused.message ?? ''),
  'a document the caller may not write is REFUSED, not silently unchanged',
  refused?.message?.slice(0, 70));
const untouched = await one(
  `select category_source from public.documents where id = $1`, [secretDoc]);
check(untouched.category_source !== 'user', 'and the row is unchanged');

// Organizing needs WRITE, not merely read: Bob is a 'member' of the shared
// matter (so he may), and nothing at all elsewhere.
const bobOrganize = await runOrganize(BOB, [mShared, mPrivate, mSealed]);
check(
  bobOrganize.every((r) => r.matterspace_id === mShared),
  'the organize pass writes only where the caller may write',
  bobOrganize.map((r) => r.matterspace_id).join(' '),
);

// The category filter narrows, and still cannot widen.
const onlyCases = await search(ALICE, { q: '', categories: ['case'], limit: 100 });
check(onlyCases.length > 0 && onlyCases.every((r) => r.category === 'case'),
  'the category filter returns that shelf and only that shelf', `${onlyCases.length} rows`);

// ---------------------------------------------------------------------------
// G. 081 is idempotent against drift.
// ---------------------------------------------------------------------------
console.log('\n--- G. idempotence -------------------------------------------');
const before = await q(
  `select category, category_source, count(*)::int n from public.documents
    group by 1,2 order by 1,2`);
await db.exec(migration(M081));
const after = await q(
  `select category, category_source, count(*)::int n from public.documents
    group by 1,2 order by 1,2`);
check(JSON.stringify(before) === JSON.stringify(after),
  'a second paste of 081 changes no data');
const idx2 = (await q(
  `select indexname from pg_indexes where tablename = 'documents' order by indexname`))
  .map((r) => r.indexname);
check(idx2.join() === idx.join(), 'and creates no duplicate index', idx2.join(' '));
const dupConstraints = await q(`
  select conname, count(*)::int n from pg_constraint
   where conrelid = 'public.documents'::regclass and conname like 'documents_category%'
   group by conname having count(*) > 1`);
check(dupConstraints.length === 0, 'nor a duplicate check constraint');
const stillIsolated = await search(BOB, { q: 'watson', limit: 100 });
check(stillIsolated.every((r) => r.matterspace_id === mShared),
  'and the boundary still holds after the re-paste');

// ---------------------------------------------------------------------------
// H. Scale. Eden's largest Vault holds ~7,600 documents and the account ~20,000.
//
// PGlite is WASM and its wall-clock numbers mean nothing, so this does not
// assert a duration. What it asserts is the thing that DOES carry over: that
// each of the three reads can be answered from an index rather than by reading
// the table. A predicate that cannot ride its index is slow on every engine.
// (The EXPLAINs below are of the PREDICATES, written out; the function body
// itself is not EXPLAIN-able from outside. The queries are transcribed from
// section 7 of the migration and any drift between them shows up as a plan
// that stops using the index.)
// ---------------------------------------------------------------------------
console.log('\n--- H. scale -------------------------------------------------');
const mBig = await mkMatter(ssMine, 'Fleming — the big one');
await db.query(`
  insert into public.documents (matterspace_id, title, source_filename, created_by)
  select $1,
         'Bates ' || g || ' production copy',
         case when g % 7 = 0 then 'Decl of Witness ' || g || '.pdf'
              when g % 5 = 0 then 'Zylstra v Barrowman ' || g || '.pdf'
              else 'AMKC produced page ' || g || '.pdf' end,
         $2
    from generate_series(1, 7600) g`, [mBig, ALICE]);
const mFiller = await mkMatter(ssMine, 'Older matters');
await db.query(`
  insert into public.documents (matterspace_id, title, source_filename, created_by)
  select $1, 'Archive item ' || g, 'archive-' || g || '.pdf', $2
    from generate_series(1, 12400) g`, [mFiller, ALICE]);
await db.exec('analyze public.documents');
const total = (await one(`select count(*)::int n from public.documents`)).n;
check(total >= 20000, 'the corpus is account-sized', `${total} documents`);

// One line, so a failure prints the WHOLE plan in the CI log rather than its
// first row — which is never the row that names the index.
const planOf = async (sql, params) =>
  (await q(`explain (costs off) ${sql}`, params))
    .map((r) => r['QUERY PLAN'].trim()).join(' / ');

const allMatters = (await q(`select id from public.matterspaces`)).map((r) => r.id);

// REACHABILITY, not choice. The thing a migration can actually guarantee is
// that the predicate the function writes MATCHES the index it built. The
// common failure here is silent: an expression index nothing can ever use
// because the query's expression drifted by a coalesce or a lower(). So the
// checks below ask the planner for its best plan with `enable_seqscan off` —
// if the index is reachable at all, it appears in the plan. Whether the
// planner PREFERS it on a given day is its own business and depends on how
// selective the word is; on a 20,000-row table held entirely in memory a scan
// is often genuinely cheaper, and choosing it is the right answer, not a bug.
await db.exec('set enable_seqscan = off');

const trgmAlone = await planOf(`
  select d.id from public.documents d
   where (coalesce(d.source_filename,'') || ' ' || coalesce(d.title,'')) ilike $1 escape '\'`,
  ['%zylstra%']);
check(/idx_documents_name_trgm/.test(trgmAlone),
  "the search's ILIKE expression matches the trigram GIN exactly — the index is reachable",
  trgmAlone.slice(0, 180));

const trgmPlan = await planOf(`
  select d.id from public.documents d
   where d.matterspace_id = any($1)
     and (coalesce(d.source_filename,'') || ' ' || coalesce(d.title,'')) ilike $2 escape '\'`,
  [allMatters, '%zylstra%']);
check(!/Seq Scan on documents/.test(trgmPlan),
  'and the site-wide search, matter filter on top, is index-driven too',
  trgmPlan.slice(0, 140));

// The two-letter branch, site-wide: no matter filter narrow enough to help,
// so the prefix itself has to be the index condition. This is the one
// text_pattern_ops exists for — on this project's en_US.UTF-8 collation a
// plain btree could not answer LIKE 'zy%' at all.
const prefixAlone = await planOf(`
  select d.id from public.documents d where d.sort_key like $1 escape '\'`, ['zy%']);
check(/idx_documents_sortkey_prefix/.test(prefixAlone)
      && /Index Cond[^/]*sort_key/.test(prefixAlone),
  'a two-letter site-wide prefix is an index CONDITION on the text_pattern_ops btree, not a filter',
  prefixAlone.slice(0, 220));

// The same two letters inside one matter: the planner may prefer the matter
// index and filter 7,600 names, which is correct and bounded. What must not
// happen is reading the table.
const prefixPlan = await planOf(`
  select d.id from public.documents d
   where d.matterspace_id = any($1) and d.sort_key like $2 escape '\'`,
  [[mBig], 'zy%']);
check(!/Seq Scan on documents/.test(prefixPlan),
  'and inside one matter the same query is index-driven',
  prefixPlan.slice(0, 180));

await db.exec('set enable_seqscan = on');

// The three list orders, in the case that matters most: ONE matter, no
// sub-matters, which is what a lawyer working a file is looking at. Each is an
// ordered index read — the index supplies the rows already sorted, so no Sort
// node appears and `limit` stops the read after the page.
const orderedReads = [
  ['A–Z', 'order by d.sort_key, d.id', 'idx_documents_matter_sortkey'],
  ['by category', 'order by d.category_rank, d.sort_key, d.id', 'idx_documents_matter_category'],
  ['by date', 'order by d.created_at desc, d.id desc', 'idx_documents_matter_created'],
];
for (const [label, order, want] of orderedReads) {
  const plan = await planOf(
    `select d.id from public.documents d where d.matterspace_id = $1 ${order} limit 500`, [mBig]);
  check(new RegExp(want).test(plan) && !/Sort Key/.test(plan),
    `one matter, ordered ${label}: an ordered index read, no sort step`, plan);
}

// And across a matter TREE, which is what the Vault actually reads. This is
// worth stating plainly rather than claiming more than is true: PostgreSQL
// cannot return `matterspace_id = ANY(...)` rows pre-sorted on a LATER index
// column, so a tree read is an index scan plus a bounded top-N sort of that
// tree's rows. At 7,600 rows that sort is a few milliseconds; what would not
// be fine — reading the whole table — does not happen.
for (const [label, order] of orderedReads) {
  const plan = await planOf(
    `select d.id from public.documents d where d.matterspace_id = any($1) ${order} limit 500`,
    [[mBig, mShared]]);
  check(!/Seq Scan/.test(plan) && /Limit/.test(plan),
    `a matter TREE ordered ${label}: index-driven, then a bounded top-N sort`,
    plan.slice(0, 160));
}

const t0 = Date.now();
const big = await search(ALICE, { q: 'zylstra', limit: 25 });
const ms = Date.now() - t0;
check(big.length === 25 && big.every((r) => r.matterspace_id === mBig),
  `a 20,000-document account answers a name search, bounded to 25 rows (${ms} ms in WASM)`,
  `${big.length} rows`);
const bigBob = await search(BOB, { q: 'zylstra', limit: 100 });
check(bigBob.length === 0,
  'and Bob, who is not in that matter, still finds none of its 7,600 documents');

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
