// The Brief Desk, slice D1 — prove the brief is text we own and can take out.
//
// docs/specs/BRIEF-DESK-2026-09-26.md §3.1–§3.2, §4 D1 harness. Five parts:
//
//   A. the master.md dialect (lib/brief-md.mjs): a Webster-style master with
//      footnotes, flags, a blockquote, a hard break, a passthrough line and a
//      signature block round-trips BYTE-IDENTICAL; a non-canonical spelling
//      of the same brief parses to the same document; input the house-style
//      build would refuse (undefined / doubly defined / unused footnote
//      labels) loses nothing; escapes and star pages survive; working marks
//      (highlight, cite) never reach the .md; every serialised footnote
//      reference has exactly one definition (the build stops otherwise);
//      toPlainText — what the cite-check reads — has no markup in it.
//   B. the TipTap schema (src/lib/brief/schema.ts): every document the parser
//      produces loads into the real ProseMirror schema, passes check(), and
//      comes back as the same JSON.
//   C. Word in (src/lib/brief/import-docx.ts): a generated .docx with bold
//      part headings, two footnotes, a numbered list, a table, a tracked
//      change and a TOC field imports with the notes back in place and a
//      loss list that names exactly what did not survive — and nothing that
//      did.
//   D. Word out (src/lib/brief/export-docx.ts): one w:footnoteReference per
//      footnote, each backed by a note in word/footnotes.xml; the DRAFT line;
//      flags bold red.
//   E. migration 100 in PGlite: RLS as a real `authenticated` caller —
//      member / viewer / stranger on draft_bodies, draft_snapshots and
//      cite_notes; a snapshot cannot be updated or deleted by anyone through
//      the API; its fingerprint is the database's, whatever the client sent;
//      the optimistic lock; the three Record kinds land and an unknown one is
//      refused; applied to a pre-094 database it adds 094's kinds rather than
//      dropping them; applied twice it is a no-op.
//
//   npm i --no-save @electric-sql/pglite
//   node --import ./scripts/_node-src-loader.mjs scripts/_verify-brief-md-roundtrip.mjs
//
// No .env, no network, no production.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};
const same = (a, b) => isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));

const { parse, serialize, serializeWithReport, toPlainText, footnotesOf } = await import('../lib/brief-md.mjs');

// ===========================================================================
console.log('\n--- A. the master.md dialect --------------------------------------');
// ===========================================================================
const MASTER = read('scripts/fixtures/brief-desk/webster-master.md');
const doc = parse(MASTER);
{
  const out = serialize(doc);
  check(out === MASTER, 'the Webster-style master round-trips byte-identical', out === MASTER ? `${MASTER.length} bytes` : firstDiff(MASTER, out));
  check(same(parse(out), doc), 'parse(serialize(doc)) ≡ doc');

  const kinds = doc.content.map((b) => b.type + (b.attrs?.level ? b.attrs.level : ''));
  check(kinds.filter((k) => k === 'heading1').length === 3, 'three part headings (## PRELIMINARY STATEMENT / ARGUMENT / CONCLUSION)', kinds.join(' '));
  check(kinds.includes('heading2') && kinds.filter((k) => k === 'heading3').length === 2, '### I. is a point heading; **A. …** and **B. …** are sub-points');
  check(kinds[kinds.length - 1] === 'signatureBlock' && doc.content.at(-1).content.length === 4,
    'Dated: starts the signature block, which runs to the end (four lines)');
  check(kinds.filter((k) => k === 'blockquote').length === 2 && kinds.filter((k) => k === 'passthrough').length === 2,
    'blockquotes are blockquotes; `# title` and `- item` are kept verbatim as passthrough');
  const notes = footnotesOf(doc);
  check(notes.length === 2, 'two footnotes, each an inline node where its reference was', `${notes.length}`);
  check(notes[0].content?.[0]?.marks?.[0]?.type === 'italic' && notes[0].content[0].text === 'Owen v. Jones',
    "a note's own markup survives (the case name inside note 1 is italic)");
  const flags = [];
  const walk = (n) => { for (const m of n.marks ?? []) if (m.type === 'flag') flags.push(m.attrs.kind); (n.content ?? []).forEach(walk); };
  walk(doc);
  check(same(flags, ['STAR', 'OPP', 'verify']), 'flags carry their kind', flags.join(' '));
  const starPara = JSON.stringify(doc);
  check(starPara.includes('at *2 (S.D.N.Y.'), 'a Westlaw star page ("at *2") stays literal text, never italic');
  check(JSON.stringify(doc).includes('"hardBreak"'), 'a trailing backslash is a hard break');
}

{
  // The same brief, spelled the way a hurried master is: no blank lines,
  // CRLF, bold-bracket flags, labels that are words, definitions in the middle.
  const messy = MASTER
    .replace(/\n\n/g, '\n')
    .replace('[OPP: they will say the declaration is hearsay]', '**[OPP: they will say the declaration is hearsay]**')
    .replace(/\[\^1\]/g, '[^owen]').replace(/\[\^2\]/g, '[^roe]')
    .replace(/\n/g, '\r\n');
  const d2 = parse(messy);
  // Without blank lines two adjacent `>` lines merge into one blockquote and
  // the signature swallows nothing new; compare what must be identical.
  check(same(footnotesOf(d2), footnotesOf(doc)), 'non-canonical spelling (CRLF, word labels, no blank lines): the same footnotes');
  check(serialize(d2).includes('[^1]') && serialize(d2).includes('[^2]') && !serialize(d2).includes('[^owen]'),
    'footnote labels are renumbered 1..n on the way out');
  check(serialize(d2).includes('[OPP: they will say the declaration is hearsay]') && !serialize(d2).includes('**[OPP'),
    '`**[OPP …]**` and `[OPP …]` are the same flag; the canonical form is bare');
}

{
  const md = 'One.[^1] Two.[^9] Three.[^1]\n\n[^1]: First.\n\n[^1]: Second definition.\n\n[^7]: Nobody cites me.\n';
  const d = parse(md);
  const text = JSON.stringify(d);
  check(text.includes('Two.[^9] Three.') && footnotesOf(d).length === 2,
    'an undefined label stays as its literal text (the build would stop on it); the two defined references are notes');
  check(text.includes('[^1]: Second definition.') && text.includes('[^7]: Nobody cites me.'),
    'a doubly defined label and an unused definition are kept as literal paragraphs — nothing is dropped');
  const out = serialize(d);
  const refs = [...out.matchAll(/(?<!\\)\[\^(\d+)\](?!:)/g)].map((m) => m[1]);
  const defs = [...out.matchAll(/^\[\^(\d+)\]:/gm)].map((m) => m[1]);
  check(same(refs, defs) && new Set(defs).size === defs.length,
    'every serialised reference has exactly one definition, and none is defined twice', `refs ${refs} defs ${defs}`);
  check(same(parse(out), parse(serialize(parse(out)))), 'and the result is stable');
}

{
  const tricky = [
    'Literal asterisks: 5 * 3 and a_b and __init__ and [^not a note] and [STARTING] words.',
    '# not a heading when escaped',
    '1. not a list item',
    '- not a bullet',
    '> not a quote',
    'A backslash \\ in the middle and one at the end \\',
  ];
  const d = { type: 'doc', content: tricky.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) };
  const back = parse(serialize(d));
  check(same(back, d), 'text that looks like markup is escaped and comes back as the same words', same(back, d) ? '' : serialize(d));
}

{
  const d = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'Highlighted', marks: [{ type: 'highlight', attrs: { color: null } }] },
    { type: 'text', text: ' and ' },
    { type: 'text', text: 'Owen v. Jones', marks: [{ type: 'italic' }, { type: 'cite', attrs: { cite_key: 'k', raw: 'Owen' } }] },
  ] }] };
  const { md, losses } = serializeWithReport(d);
  check(md === 'Highlighted and *Owen v. Jones*\n' && losses.length === 0,
    'highlight and cite are working marks: the .md carries the words and the italics only, and that is not a loss', JSON.stringify(md));
}

{
  const d = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'The ', marks: [{ type: 'bold' }] },
    { type: 'text', text: 'Owen', marks: [{ type: 'bold' }, { type: 'italic' }] },
  ] }] };
  const { md, losses } = serializeWithReport(d);
  check(losses.length === 1 && /italic dropped/.test(losses[0]) && same(parse(md), parse(serialize(parse(md)))),
    'bold-italic at the edge of a bold span (not expressible to the build) is written without the italic and REPORTED', JSON.stringify(md));
  const mid = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'The ', marks: [{ type: 'bold' }] },
    { type: 'text', text: 'Owen', marks: [{ type: 'bold' }, { type: 'italic' }] },
    { type: 'text', text: ' rule', marks: [{ type: 'bold' }] },
  ] }] };
  const r2 = serializeWithReport(mid);
  check(r2.losses.length === 0 && same(parse(r2.md), mid), 'bold-italic inside a bold span round-trips', JSON.stringify(r2.md));
}

{
  const plain = toPlainText(doc);
  check(!/[*_]{1,2}\S/.test(plain.replace(/at \*2/, '')) && !plain.includes('[^'),
    'toPlainText has no markup and no footnote labels (what the cite-check reads)');
  check(plain.includes('that Owen v. Jones, 123 F.3d 456, 460 (2d Cir. 1999), forecloses the claim. It does not.'),
    'an italicised case name reads as plain words, and the note reference is zero-width');
  const tail = plain.split('\n\n').slice(-2);
  check(tail[0].startsWith('Owen v. Jones, 123 F.3d 456 (2d Cir. 1999), was decided') && tail[1].startsWith('See Decl.'),
    'footnote bodies follow the body, in document order');
  check(toPlainText(doc) === plain, 'deterministic');
}

// ===========================================================================
console.log('\n--- B. the TipTap schema -------------------------------------------');
// ===========================================================================
const { getSchema } = await import('@tiptap/core');
const { Node: PMNode } = await import('@tiptap/pm/model');
const { briefExtensions } = await import('../src/lib/brief/schema.ts');
const schema = getSchema(briefExtensions());
check(same(Object.keys(schema.marks), ['bold', 'italic', 'underline', 'highlight', 'flag', 'cite']),
  'marks in the rank lib/brief-md.mjs sorts by', Object.keys(schema.marks).join(' '));
for (const bad of ['bulletList', 'orderedList', 'codeBlock', 'horizontalRule']) {
  if (schema.nodes[bad]) check(false, `the schema has no ${bad} (a paste cannot bring one in)`);
}
check(!schema.marks.strike && !schema.marks.link && !schema.marks.code, 'no strike, link or code marks');
const loadable = (label, json) => {
  try {
    const node = PMNode.fromJSON(schema, json);
    node.check();
    check(same(node.toJSON(), json), `${label}: loads into the schema, passes check(), and comes back identical`);
  } catch (e) {
    check(false, `${label}: loads into the schema`, e.message);
  }
};
loadable('the Webster master', doc);

// ===========================================================================
console.log('\n--- C. Word in -----------------------------------------------------');
// ===========================================================================
const { makeFixtureDocx } = await import('./fixtures/brief-desk/make-fixture-docx.mjs');
const { importDocx } = await import('../src/lib/brief/import-docx.ts');
{
  const bytes = await makeFixtureDocx();
  const { doc: wd, losses } = await importDocx(bytes);
  loadable('the imported Word brief', wd);
  const expect = [
    /^Fonts, spacing/, /numbering/, /Tracked changes/, /table of contents/, /Tables became/,
  ];
  check(expect.every((re) => losses.some((l) => re.test(l))), 'the loss list names numbering, tracked changes, the TOC field, tables and styles',
    losses.map((l) => l.slice(0, 30)).join(' | '));
  check(!losses.some((l) => /Comments|Images|Headers|Endnotes/.test(l)),
    'and nothing the file did not have (no comments, images, headers or endnotes claimed)');
  const md = serialize(wd);
  check(/^## PRELIMINARY STATEMENT$/m.test(md) && /^## ARGUMENT$/m.test(md) && /^### I\. THE COMPLAINT STATES A CLAIM$/m.test(md)
    && /^\*\*A\. The Standard Is Met\.\*\*$/m.test(md),
    'bold part / point / sub-point lines become the three heading levels');
  check(md.includes('Defendant relies on *Owen v. Jones*, 123 F.3d 456, 460 (2d Cir. 1999).[^1] It does not help him.'),
    'italics kept, and footnote 1 sits exactly where its reference was');
  check(md.includes('[^1]: *Owen v. Jones*, 123 F.3d 456 (2d Cir. 1999).') && md.includes('[^2]: See Decl. of J. Roe'),
    "the notes' text, with their own italics");
  check(md.includes('Every witness readily agreed.[^2]') && !md.includes('reluctantly'),
    'a tracked insertion is kept and a tracked deletion is not (as the loss list says)');
  check(md.includes('| Exhibit | ECF No. |'), 'a table row is kept as a line');
  check(wd.content.at(-1).type === 'signatureBlock', 'Dated: starts the signature block');
}

// ===========================================================================
console.log('\n--- D. Word out ----------------------------------------------------');
// ===========================================================================
const { Packer } = await import('docx');
const JSZip = (await import('jszip')).default;
const { buildBriefDocument, DRAFT_LINE } = await import('../src/lib/brief/export-docx.ts');
{
  const buf = await Packer.toBuffer(buildBriefDocument(doc, 'Reply Memorandum'));
  const zip = await JSZip.loadAsync(buf);
  const body = await zip.file('word/document.xml').async('string');
  const notesXml = (await zip.file('word/footnotes.xml')?.async('string')) ?? '';
  const refIds = [...body.matchAll(/<w:footnoteReference w:id="(\d+)"/g)].map((m) => m[1]);
  const noteIds = [...notesXml.matchAll(/<w:footnote (?:w:type="[^"]*" )?w:id="(-?\d+)"/g)].map((m) => m[1]);
  check(refIds.length === footnotesOf(doc).length, 'one w:footnoteReference per footnote', `${refIds.length}`);
  check(refIds.every((id) => noteIds.includes(id)), 'each reference is backed by a note in word/footnotes.xml', `refs ${refIds} notes ${noteIds}`);
  check(notesXml.includes('Owen v. Jones') && notesXml.includes('Rule 12(b)(6)'), "the notes' words are in the notes part, not the body");
  const headers = await Promise.all(Object.keys(zip.files).filter((n) => /^word\/header\d*\.xml$/.test(n)).map((n) => zip.file(n).async('string')));
  check(headers.some((h) => h.includes(DRAFT_LINE.slice(0, 20))), 'the DRAFT line is in the header');
  check(/<w:color w:val="C00000"\/>[\s\S]{0,200}\[STAR: confirm/.test(body) || /\[STAR: confirm[\s\S]{0,10}/.test(body) && /C00000/.test(body),
    'flags are printed red');
  check(body.includes('Times New Roman') || (await zip.file('word/styles.xml').async('string')).includes('Times New Roman'), 'Times New Roman');
}

// ===========================================================================
console.log('\n--- E. migration 100 -----------------------------------------------');
// ===========================================================================
let PGlite, uuid_ossp;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
} catch {
  console.error('Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}
const { EVENT_KINDS, KINDS_094, KINDS_100 } = await import('../lib/ledger.mjs');
const migrationSql = (name) => fs.readFileSync(path.join(root, 'supabase', 'migrations', name), 'utf8');

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
    create table public.documents (id uuid primary key default gen_random_uuid(), matterspace_id uuid, created_by uuid);
    create table public.passages (id uuid primary key default gen_random_uuid(), matterspace_id uuid);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    create or replace function storage.foldername(p_name text)
      returns text[] language sql immutable as $$ select string_to_array(p_name, '/') $$;
    grant usage on schema public, auth, storage to anon, authenticated, service_role;
    grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  for (const m of ['001_initial_schema.sql', '005_fix_rls_recursion.sql', '008_submatters.sql',
    '016_matterspace_members.sql', '022_matterspaces_rls_invoker_wrappers.sql', '051_securespace.sql',
    '064_events_ledger.sql', '072_account_chain_and_session_immutability.sql', '073_completion_requested.sql']) {
    await db.exec(migrationSql(m));
  }
  await db.exec(`
    alter table public.documents enable row level security;
    create table public.cite_check_runs (id uuid primary key default gen_random_uuid(), document_id uuid);
    create table public.document_annotations (id uuid primary key default gen_random_uuid());
  `);
  return db;
}

const kindsOf = async (db) => {
  const [row] = (await db.query(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'events_kind_check'`)).rows;
  return [...String(row.def).matchAll(/'([a-z]+\.[a-z_]+)'/g)].map((m) => m[1]);
};
// 094's vocabulary block, executed from the real file (the rest of 094 —
// the seal gate — is _verify-stepup-seal.mjs's to prove).
const vocab094 = (() => {
  const sql = migrationSql('094_security_kinds_and_stepup.sql');
  const start = sql.indexOf('do $migration$');
  const end = sql.indexOf('end $migration$;', start) + 'end $migration$;'.length;
  return sql.slice(start, end);
})();

{
  // Order 1: 094 is on the database first (production's order).
  const db = await freshDb();
  await db.exec(vocab094);
  const before = await kindsOf(db);
  check(KINDS_100.every((k) => !before.includes(k)), 'before 100, the draft kinds are refused', `${before.length} kinds`);
  await db.exec(migrationSql('100_brief_desk.sql'));
  const after = await kindsOf(db);
  check(after.length === EVENT_KINDS.length && EVENT_KINDS.every((k) => after.includes(k)),
    'after 094 then 100: the constraint is EVENT_KINDS exactly — never a subset either way', `${after.length} kinds`);
  await db.exec(migrationSql('100_brief_desk.sql'));
  check(same(await kindsOf(db), after), '100 applied a second time changes nothing');
  await db.close();
}
{
  // Order 2: a database that never had 094 — 100 must ADD 094's kinds.
  const db = await freshDb();
  await db.exec(migrationSql('100_brief_desk.sql'));
  const after = await kindsOf(db);
  check(KINDS_094.every((k) => after.includes(k)) && after.length === EVENT_KINDS.length,
    'on a pre-094 database, 100 adds 094\'s fifteen too (the UNION rule) rather than dropping them');
  await db.close();
}

// The RLS proof, on a database in production's order.
const db = await freshDb();
await db.exec(vocab094);
await db.exec(migrationSql('100_brief_desk.sql'));
await db.exec(`grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;`);
const q = async (sql, params) => (await db.query(sql, params)).rows;
const attempt = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e; } };
const asUser = async (uid) => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated', aal: 'aal1' })]);
  await db.exec('set role authenticated');
};
const asSuper = async () => { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claims', '', false)`); };

await asSuper();
const signup = async (email) => (await q(`insert into auth.users (email) values ($1) returning id`, [email]))[0].id;
const ADA = await signup('ada@example.test');   // owns the serverspace
const MEL = await signup('mel@example.test');   // member of the matter
const VIC = await signup('vic@example.test');   // viewer of the matter
const STR = await signup('str@example.test');   // a stranger
const [space] = await q(`insert into public.serverspaces (clientspace_id, name)
  select id, 'Fixture Law' from public.clientspaces where user_id = $1 returning id`, [ADA]);
await q(`insert into public.serverspace_members (serverspace_id, user_id, role) values ($1,$2,'owner')`, [space.id, ADA]);
const [{ id: M }] = await q(`insert into public.matterspaces (serverspace_id, name) values ($1,'Vashti v. Ormsby') returning id`, [space.id]);
await q(`insert into public.matterspace_members (matterspace_id, user_id, role) values ($1,$2,'member'), ($1,$3,'viewer')`, [M, MEL, VIC]);
const [{ id: D }] = await q(`insert into public.documents (matterspace_id, created_by) values ($1,$2) returning id`, [M, MEL]);
const BODY = JSON.stringify(doc);

{
  await asUser(MEL);
  const ins = await attempt(`insert into public.draft_bodies (document_id, body, body_md, updated_by) values ($1,$2,$3,$4)`, [D, BODY, MASTER, MEL]);
  check(ins === null, 'a matter member creates the brief body', ins?.message ?? '');
  const [{ updated_at: t0 }] = await q(`select updated_at from public.draft_bodies where document_id = $1`, [D]);
  const moved = await q(`update public.draft_bodies set body_md = 'v2', updated_by = $2, updated_at = '2000-01-01'
    where document_id = $1 and updated_at = $3 returning updated_at`, [D, MEL, t0]);
  check(moved.length === 1 && new Date(moved[0].updated_at) > new Date(t0),
    'a save under the lock lands, and the DATABASE moves updated_at (a client cannot pin it)');
  const stale = await q(`update public.draft_bodies set body_md = 'v3', updated_by = $2
    where document_id = $1 and updated_at = $3 returning 1`, [D, MEL, t0]);
  check(stale.length === 0, 'a save carrying the old updated_at matches nothing — "changed elsewhere", never an overwrite');
  const forged = await attempt(`update public.draft_bodies set body_md = 'x', updated_by = $2 where document_id = $1`, [D, ADA]);
  check(forged !== null, 'nobody saves under someone else\'s name (updated_by must be the caller)');

  await asUser(VIC);
  check((await q(`select 1 from public.draft_bodies where document_id = $1`, [D])).length === 1, 'a viewer reads the brief');
  const vUp = await q(`update public.draft_bodies set body_md = 'viewer', updated_by = $2 where document_id = $1 returning 1`, [D, VIC]);
  check(vUp.length === 0, 'a viewer cannot edit it');

  await asUser(STR);
  check((await q(`select 1 from public.draft_bodies`)).length === 0, 'a stranger sees no brief body');
  const sIns = await attempt(`insert into public.draft_snapshots (document_id, body, body_md, sha256, created_by) values ($1,$2,'x','',$3)`, [D, BODY, STR]);
  check(sIns !== null, 'a stranger cannot snapshot it');
}

let SNAP;
{
  await asUser(MEL);
  const [s] = await q(`insert into public.draft_snapshots (document_id, label, body, body_md, sha256, created_by)
    values ($1,'v1',$2,$3,'client-said-this',$4) returning id, sha256`, [D, BODY, MASTER, MEL]);
  SNAP = s.id;
  const { createHash } = await import('node:crypto');
  const expected = createHash('sha256').update(MASTER, 'utf8').digest('hex');
  check(s.sha256 === expected, 'the snapshot fingerprint is sha256(body_md) computed by the database, not what the client sent', s.sha256.slice(0, 16));
  const up = await q(`update public.draft_snapshots set body_md = 'rewritten' where id = $1 returning 1`, [SNAP]);
  const del = await q(`delete from public.draft_snapshots where id = $1 returning 1`, [SNAP]);
  await asUser(ADA);
  const ownerDel = await q(`delete from public.draft_snapshots where id = $1 returning 1`, [SNAP]);
  await asSuper();
  const still = await q(`select body_md from public.draft_snapshots where id = $1`, [SNAP]);
  check(up.length === 0 && del.length === 0 && ownerDel.length === 0 && still.length === 1 && still[0].body_md === MASTER,
    'a snapshot is frozen: its author and the matter owner can neither rewrite nor delete it');
  await q(`insert into public.cite_check_runs (document_id) values ($1)`, [D]);
  const setRun = await attempt(`update public.cite_check_runs set snapshot_id = $1`, [SNAP]);
  check(setRun === null, 'cite_check_runs.snapshot_id exists and points at a snapshot');
}

{
  await asUser(MEL);
  const mine = await attempt(`insert into public.cite_notes (document_id, cite_key, user_id, note) values ($1,'owen v. jones 123 f.3d 456|460',$2,'weak support')`, [D, MEL]);
  check(mine === null, 'a member notes a cite');
  const long = await attempt(`insert into public.cite_notes (document_id, cite_key, user_id, note) values ($1,'k2',$2,$3)`, [D, MEL, 'x'.repeat(281)]);
  check(long !== null, 'a note is telegraphic: over 280 characters is refused');
  const asOther = await attempt(`insert into public.cite_notes (document_id, cite_key, user_id, note) values ($1,'k3',$2,'forged')`, [D, ADA]);
  check(asOther !== null, "nobody writes a note in someone else's name");
  await asUser(ADA);
  check((await q(`select note from public.cite_notes where document_id = $1`, [D])).length === 1, 'co-counsel reads the note');
  const edit = await q(`update public.cite_notes set note = 'hijacked' returning 1`);
  const drop = await q(`delete from public.cite_notes returning 1`);
  check(edit.length === 0 && drop.length === 0, "and cannot edit or delete another person's note");
  await asUser(MEL);
  check((await q(`delete from public.cite_notes returning 1`)).length === 1, 'its author can delete it');
  const hasFk = await q(`select 1 from pg_constraint where conname = 'cite_notes_annotation_id_fkey'`);
  check(hasFk.length === 1, 'cite_notes.annotation_id is a foreign key to document_annotations where that table exists');
}

{
  await asUser(MEL);
  let landed = 0;
  for (const k of KINDS_100) {
    const err = await attempt(`select public.ledger_append(p_kind := $1, p_matter := $2, p_actor_kind := 'user', p_actor_ref := $3, p_payload := $4)`,
      [k, M, MEL, JSON.stringify({ document_id: D, snapshot_id: SNAP })]);
    if (!err) landed += 1; else console.log('     ', k, err.message);
  }
  check(landed === 3, 'draft.snapshot, cite.checked and draft.exported land in the Record through the real append path', `${landed}/3`);
  const bad = await attempt(`select public.ledger_append(p_kind := 'draft.deleted', p_matter := $1, p_actor_kind := 'user', p_actor_ref := $2)`, [M, MEL]);
  check(bad !== null, 'an unknown kind is refused');
  await asUser(STR);
  const outsider = await attempt(`select public.ledger_append(p_kind := 'draft.snapshot', p_matter := $1, p_actor_kind := 'user', p_actor_ref := $2)`, [M, STR]);
  check(outsider !== null, "a stranger cannot write to the matter's Record");
}

{
  // A document deleted takes its body, snapshots and notes with it (cascade) —
  // the history lives and dies with the brief, not with an edit.
  await asSuper();
  await q(`delete from public.cite_check_runs`);
  await q(`delete from public.documents where id = $1`, [D]);
  const left = await q(`select (select count(*) from public.draft_bodies)::int b, (select count(*) from public.draft_snapshots)::int s`);
  check(left[0].b === 0 && left[0].s === 0, 'deleting the document removes its body and snapshots');
}
await db.close();

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `first difference at ${i}: ${JSON.stringify(a.slice(i, i + 40))} vs ${JSON.stringify(b.slice(i, i + 40))}`;
}

console.log(failures ? `\n${failures} FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
