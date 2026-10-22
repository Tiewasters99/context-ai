// The register copy's offline tests (node --test): normalization, the XML
// parser on the committed SYNTHETIC fixture, the loader's upsert and
// atomicity, every query type's SQL (and its parity with the matching rule the
// tests already pin, queries.mjs termMatchesMark), the stale rule, the gate
// rule, the daily update with a stub ODP (never the real one), and the recall
// harness on the seed set.
//
//   npm i --no-save @electric-sql/pglite@0.5.8
//   node --test scripts/_test-tm-register.mjs
//
// Nothing here downloads anything: every byte comes from
// scripts/fixtures/tm-register/ (see scripts/tm-register/make-fixture.mjs for
// what in them is real and what is invented).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { words, normalizeMark, joinedMark, numberWords, numeralVariant, cmVariants, cmText, quotedSegments } from '../lib/trademark/register/normalize.mjs';
import { streamRecords, xmlDate, liveFrom, RegisterXmlError, headerCollector } from '../lib/trademark/register/xml.mjs';
import { openRegisterDb } from '../lib/trademark/register/db.mjs';
import { applySchema, loadFile, stampAsOf, fileAsOfFromName } from '../lib/trademark/register/load.mjs';
import { parseQuery, toSql, runQuery, expressible, termRegex, RegisterQueryUnsupported } from '../lib/trademark/register/search.mjs';
import { isStale, daysBehind, gateState, offerState, registerStatus, PRELIMINARY_LABEL } from '../lib/trademark/register/meta.mjs';
import { runDaily, daysToFetch, dailyFileName, KEY_NEEDED } from '../lib/trademark/register/daily.mjs';
import { runRecall, storeRecall, testSetProblems, recallReport } from '../lib/trademark/register/recall.mjs';
import { generateQueries, termMatchesMark } from '../lib/trademark/queries.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = path.join(ROOT, 'scripts', 'fixtures', 'tm-register');
const BACKFILE = path.join(FX, 'apc-synthetic-backfile-20261018.xml');
const DAILY = path.join(FX, 'apc-synthetic-daily-20261019.xml');
const NODATA = path.join(FX, 'apc-synthetic-daily-20261020-nodata.xml');
const BROKEN = path.join(FX, 'apc-synthetic-daily-20261021-broken.xml');
const SEED = JSON.parse(fs.readFileSync(path.join(FX, 'recall-seed-2026-10-21.json'), 'utf8'));

async function collect(iter) { const out = []; for await (const x of iter) out.push(x); return out; }
async function* chunks(file, size) {
  const buf = fs.readFileSync(file);
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}
async function freshDb() {
  const db = await openRegisterDb('pglite:memory', { cached: false });
  await applySchema(db);
  return db;
}

// ---------------------------------------------------------------------------
test('normalization: case, punctuation, spacing, accents, apostrophes, symbols', () => {
  assert.deepEqual(words("  McDonald's  "), ['mcdonalds']);
  assert.deepEqual(words('E-QUAZIA.AI'), ['e', 'quazia', 'ai']);
  assert.equal(normalizeMark('CAFÉ  Équazione'), 'cafe equazione');
  assert.equal(normalizeMark('A&B + C@D'), 'a and b plus c at d');
  assert.equal(joinedMark('Equa Zia!'), 'equazia');
  assert.equal(normalizeMark('<=>'), '');
});

test('normalization: numerals to words only when there is no pseudo mark', () => {
  assert.equal(numberWords(4), 'four');
  assert.equal(numberWords(21), 'twenty one');
  assert.equal(numberWords(1984), 'one thousand nine hundred eighty four');
  assert.equal(numberWords(10000), null);
  assert.equal(numeralVariant('4U'), 'four u');
  assert.equal(numeralVariant('21ST CENTURY'), 'twenty one st century');
  assert.equal(numeralVariant('007 AGENT'), null, 'a leading zero stays digits');
  assert.equal(numeralVariant('EQUAZIA'), null);
  assert.deepEqual(cmVariants({ mark: '4U LEGAL' }), ['4u legal', '4ulegal', 'four u legal', 'fourulegal']);
  assert.deepEqual(cmVariants({ mark: '4U LEGAL', pseudoMarks: ['FOR YOU LEGAL'] }), ['4u legal', '4ulegal', 'for you legal', 'foryoulegal'],
    'the USPTO pseudo mark replaces the numeral guess');
});

test('normalization: translation segments and the searchable CM text', () => {
  assert.deepEqual(quotedSegments('The English translation of "LA EQUAZIONE" in the mark is "THE EQUATION".'), ['la equazione', 'the equation']);
  const v = cmVariants({ mark: 'LA EQUAZIONE', translations: ['The English translation of "LA EQUAZIONE" in the mark is "THE EQUATION".'] });
  assert.deepEqual(v, ['la equazione', 'laequazione', 'the equation', 'theequation']);
  assert.equal(cmText(v), ' la equazione | laequazione | the equation | theequation ');
});

// ---------------------------------------------------------------------------
test('XML: the synthetic backfile parses, streamed, into one row per case-file', async () => {
  const { h, onHeader } = headerCollector();
  const recs = await collect(streamRecords(fs.createReadStream(BACKFILE), { fileName: 'backfile', asOf: '2026-10-18', onHeader }));
  assert.equal(recs.length, 404);
  assert.equal(h.versionNo, '2.0-synthetic');
  const eqs = recs.find((r) => r.serial === '90562533');
  assert.equal(eqs.mark, 'EQUASITE');
  assert.equal(eqs.registration_number, '6816256');
  assert.deepEqual(eqs.int_classes, ['042']);
  assert.equal(eqs.owner, 'Equasite, Inc.');
  assert.equal(eqs.filing_date, '2021-03-05');
  assert.equal(eqs.live, true);
  assert.equal(eqs.goods[0].class, '042');
  assert.match(eqs.goods[0].text, /accessible websites/);
  assert.equal(eqs.as_of, '2026-10-18');
  const dead = recs.find((r) => r.serial === '76999904');
  assert.equal(dead.live, false, 'an abandonment date = dead');
  assert.equal(dead.abandonment_date, '2024-05-01');
  assert.deepEqual(recs.find((r) => r.serial === '76999901').pseudo_marks, ['EQUAZIA']);
  assert.deepEqual(recs.find((r) => r.serial === '76999905').design_codes, ['260101', '261121']);
  assert.match(recs.find((r) => r.serial === '76999903').translations[0], /THE EQUATION/);
  assert.deepEqual(recs.find((r) => r.serial === '72051347').int_classes, ['200'], 'collective membership class 200 kept');
});

test('XML: the same records whatever the chunk size (a record split across chunks)', async () => {
  const a = await collect(streamRecords(chunks(BACKFILE, 7), { fileName: 'x' }));
  const b = await collect(streamRecords(chunks(BACKFILE, 65536), { fileName: 'x' }));
  assert.equal(a.length, 404);
  assert.deepEqual(a.map((r) => r.serial), b.map((r) => r.serial));
  assert.deepEqual(a[17], b[17]);
});

test('XML: a no-data day is a valid empty file; a broken file is an error, never a short file', async () => {
  const { h, onHeader } = headerCollector();
  assert.deepEqual(await collect(streamRecords(fs.createReadStream(NODATA), { onHeader })), []);
  assert.equal(h.dataAvailable, false);
  await assert.rejects(collect(streamRecords(fs.createReadStream(BROKEN), { fileName: 'broken' })), RegisterXmlError);
  await assert.rejects(collect(streamRecords((async function* () { yield '<other-root/>'; })(), { fileName: 'other' })), /root element/);
});

test('XML: dates and the live rule', () => {
  assert.equal(xmlDate('20210305'), '2021-03-05');
  assert.equal(xmlDate('00000000'), null);
  assert.equal(xmlDate('20210000'), null);
  assert.equal(liveFrom({ statusCode: '602' }), true, 'a status code alone never makes a record dead until Table 1 is read');
  assert.equal(liveFrom({ statusCode: '602' }, { dead_codes: ['602'] }), false, 'a code listed in the table does');
  assert.equal(liveFrom({ statusCode: '630' }), true, '630: live in the fixture (EKWAZIA), and never dropped from LD:true');
  assert.equal(liveFrom({ statusCode: '700' }), true);
  assert.equal(liveFrom({ statusCode: '700', cancellationDate: '2020-01-01' }), false);
  assert.equal(liveFrom({ statusCode: null }), true, 'unknown = live (a false hit, never a missed conflict)');
});

// ---------------------------------------------------------------------------
test('loader: upsert by serial, idempotent, newer files win, a failed file changes nothing', async () => {
  const db = await freshDb();
  const first = await loadFile(db, BACKFILE, { kind: 'fixture', asOf: '2026-10-18' });
  assert.equal(first.records, 404);
  assert.equal(first.inserted, 404);
  const again = await loadFile(db, BACKFILE, { kind: 'fixture', asOf: '2026-10-18' });
  assert.equal(again.skipped, true, 'the same file (same sha256) is not loaded twice');

  const d = await loadFile(db, DAILY, { kind: 'fixture', asOf: '2026-10-19' });
  assert.equal(d.inserted, 1); assert.equal(d.updated, 1);
  const eq = (await db.query("select status_code, to_char(as_of, 'YYYY-MM-DD') a from register_records where serial = '98137428'")).rows[0];
  assert.deepEqual(eq, { status_code: '730', a: '2026-10-19' });

  // The old backfile again under another name: rows the daily already updated are kept.
  const tmp = path.join(os.tmpdir(), `tm-reg-${Date.now()}.xml`);
  fs.copyFileSync(BACKFILE, tmp);
  const old = await loadFile(db, tmp, { kind: 'fixture', asOf: '2026-10-18', fileName: 'backfile-again.xml' });
  fs.unlinkSync(tmp);
  assert.equal(old.unchanged, 1, 'EQUALL (as of 10-19) is not rolled back by a 10-18 file');
  assert.equal((await db.query("select status_code from register_records where serial = '98137428'")).rows[0].status_code, '730');

  const before = (await db.query('select count(*)::int n from register_records')).rows[0].n;
  const files = (await db.query('select count(*)::int n from register_files')).rows[0].n;
  await stampAsOf(db, '2026-10-19');
  await assert.rejects(loadFile(db, BROKEN, { kind: 'fixture', asOf: '2026-10-21' }), RegisterXmlError);
  assert.equal((await db.query('select count(*)::int n from register_records')).rows[0].n, before, 'no row from the broken file');
  assert.equal((await db.query("select count(*)::int n from register_records where serial = '76999908'")).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int n from register_files')).rows[0].n, files, 'and no register_files row');
  assert.equal((await db.query("select value from register_meta where key = 'as_of'")).rows[0].value, '2026-10-19', 'as_of did not move');

  await stampAsOf(db, '2026-10-01');
  assert.equal((await db.query("select value from register_meta where key = 'as_of'")).rows[0].value, '2026-10-19', 'as_of only moves forward');
  assert.deepEqual(fileAsOfFromName('apc261020.zip'), { kind: 'daily', asOf: '2026-10-20' });
  assert.deepEqual(fileAsOfFromName('apc18840407-20251231-07.zip'), { kind: 'backfile', asOf: '2025-12-31' });
  await db.close();
});

// ---------------------------------------------------------------------------
test('search: each query type translates to SQL, and unsupported ones are refused by name', () => {
  const sql = (q) => toSql(parseQuery(q));
  let r = sql('CM:equazia');
  assert.equal(r.sql, '(r.cm_text ~ $1)'); assert.deepEqual(r.params, ['(^|[ |])equazia([ |]|$)']);
  r = sql('CM:*equaz*');
  assert.deepEqual(r.params, ['(^|[ |])[a-z0-9]*equaz[a-z0-9]*([ |]|$)']);
  r = sql('CM:equa?ia AND LD:true');
  assert.equal(r.sql, '((r.cm_text ~ $1) and (r.live))'); assert.deepEqual(r.params, ['(^|[ |])equa[a-z0-9]ia([ |]|$)']);
  r = sql('CM:(equas* ekwaz*) AND LD:true AND IC:(009 042 a b 200)');
  assert.equal(r.sql, '(((r.cm_text ~ $1) or (r.cm_text ~ $2)) and (r.live) and ((r.int_classes @> array[$3]::text[]) or (r.int_classes @> array[$4]::text[]) or (r.int_classes @> array[$5]::text[]) or (r.int_classes @> array[$6]::text[]) or (r.int_classes @> array[$7]::text[])))');
  assert.deepEqual(r.params.slice(2), ['009', '042', 'A', 'B', '200']);
  r = sql('CM:equa* AND LD:true AND NOT CM:(equal* equit*)');
  assert.equal(r.sql, '((r.cm_text ~ $1) and (r.live) and (not ((r.cm_text ~ $2) or (r.cm_text ~ $3))))');
  r = sql('ON:"equall inc"');
  assert.equal(r.sql, '(r.owner_text ~ $1)'); assert.deepEqual(r.params, ['(^|[ |])equall inc([ |]|$)']);
  r = sql('SN:90562533'); assert.deepEqual(r.params, ['90562533']);
  r = sql('RN:0674341'); assert.deepEqual(r.params, ['674341']);
  r = sql('FD:[20230701 TO *]'); assert.equal(r.sql, '(r.filing_date >= $1::date)');
  r = sql('GS:software AND CM:"privacy equals"'); assert.equal(r.sql, '((r.gs_text ~ $1) and (r.cm_text ~ $2))');
  assert.throws(() => sql('CC:(009 042)'), /coordinated class/);
  assert.throws(() => sql('XX:foo'), RegisterQueryUnsupported);
  assert.throws(() => sql('CM:(equa'), /unbalanced/);
  assert.throws(() => termRegex('a.b'), RegisterQueryUnsupported);
  assert.deepEqual(expressible('CC:009'), { ok: false, reason: 'CC: (coordinated class) needs the USPTO coordination table, which is not in the bulk XML; run it on tmsearch' });
});

test('search: every generated EQUAZIA query is expressible, and the copy matches exactly what termMatchesMark says', async () => {
  const db = await freshDb();
  await loadFile(db, BACKFILE, { kind: 'fixture', asOf: '2026-10-18' });
  const { queries } = generateQueries({
    mark: 'EQUAZIA', decomposition: { opening: 'equa', hinge: 'z', ending: 'ia' }, searchClasses: ['009', '042', '045'],
    knownMarks: [{ name: 'EQUALL', owner: 'Equall Inc' }], foreignEquivalents: ['equazione', 'equacion'],
    exclusions: ['equal', 'equat', 'equator', 'equit'],
  });
  const all = (await db.query('select serial, mark, cm_text, live, int_classes, owner_text from register_records')).rows;
  for (const q of queries) {
    assert.ok(expressible(q.query).ok, `Q${q.seq} expressible`);
    if (!/^CM:/.test(q.query)) continue;
    // The JS rule: a CM term matches any variant (cm_text holds them) by termMatchesMark; LD / IC / AND NOT as written.
    const tree = parseQuery(q.query);
    const evalNode = (n, rec) => {
      if (n.op === 'and') return n.args.every((a) => evalNode(a, rec));
      if (n.op === 'or') return n.args.some((a) => evalNode(a, rec));
      if (n.op === 'not') return !evalNode(n.arg, rec);
      if (n.field === 'CM') {
        const t = n.kind === 'phrase' ? `"${normalizeMark(n.value)}"` : n.value.toLowerCase();
        return rec.cm_text.split('|').map((v) => v.trim()).filter(Boolean).some((v) => termMatchesMark(t, v));
      }
      if (n.field === 'LD') return rec.live === (n.value === 'true');
      if (n.field === 'IC') return rec.int_classes.includes(/^\d+$/.test(n.value) ? n.value.padStart(3, '0') : n.value.toUpperCase());
      throw new Error(`no JS rule for ${n.field}`);
    };
    const expected = all.filter((rec) => evalNode(tree, rec)).map((r) => r.serial).sort();
    const got = await runQuery(db, q.query, { mark: 'EQUAZIA', searchClasses: ['009', '042', '045'] });
    assert.equal(got.count, expected.length, `Q${q.seq} count: ${q.query}`);
    assert.deepEqual(got.rows.map((r) => r.serial).sort(), expected.slice(0, 500).sort(), `Q${q.seq} rows`);
  }
  await db.close();
});

test('search: results are run rows — live first, closeness, class overlap, source and as-of', async () => {
  const db = await freshDb();
  await loadFile(db, BACKFILE, { kind: 'fixture', asOf: '2026-10-18' });
  const q5 = await runQuery(db, 'CM:(equas* ekwaz*) AND LD:true AND IC:(009 042 045 a b 200)', { mark: 'EQUAZIA', searchClasses: ['009', '042', '045'], asOf: '2026-10-18' });
  const eqs = q5.rows.find((r) => r.serial === '90562533');
  assert.ok(eqs, 'EQUASITE is caught by the substituted stems (the 10-18 lesson)');
  assert.equal(eqs.live, true);
  assert.match(eqs.status, /^LIVE/);
  assert.deepEqual(eqs.classes, ['042']);
  assert.equal(eqs.raw.source, 'register_copy');
  assert.equal(eqs.raw.as_of, '2026-10-18');
  assert.equal(eqs.raw.class_overlap, '042');
  assert.ok(Number(eqs.raw.closeness) > 0);
  assert.ok(q5.rows.some((r) => r.serial === '76999905'), 'EKWAZIA (invented) by ekwaz*');
  const q2 = await runQuery(db, 'CM:*equaz*', { mark: 'EQUAZIA' });
  const order = q2.rows.map((r) => r.live);
  assert.deepEqual(order, [...order].sort((a, b) => Number(b) - Number(a)), 'live before dead');
  assert.ok(q2.rows.some((r) => r.serial === '76999904' && r.live === false && /^DEAD/.test(r.status)), 'a dead record comes back as dead (a note, kept in the log)');
  const pm = await runQuery(db, 'CM:equazia', { mark: 'EQUAZIA' });
  assert.deepEqual(pm.rows.map((r) => r.serial), ['76999901'], 'EQUAZYA is found through its pseudo mark');
  const num = await runQuery(db, 'CM:"four u legal"', { mark: '4U' });
  assert.deepEqual(num.rows.map((r) => r.serial), ['76999902'], '4U LEGAL through the numeral reading');
  const many = await runQuery(db, 'CM:equa* AND LD:true AND IC:(009 042 045 a b 200)', { limit: 10 });
  assert.ok(many.count > 10 && many.rows.length === 10, 'the count is the whole match set; the rows are capped');
  await db.close();
});

// ---------------------------------------------------------------------------
test('the stale rule', () => {
  assert.equal(daysBehind('2026-10-18', '2026-10-21'), 3);
  assert.equal(isStale('2026-10-18', '2026-10-21'), false, '3 days behind is not stale (threshold 3)');
  assert.equal(isStale('2026-10-17', '2026-10-21'), true);
  assert.equal(isStale('2026-10-17', '2026-10-21', 5), false, 'the threshold is configurable');
  assert.equal(isStale(null, '2026-10-21'), true, 'no as-of date = stale');
});

test('the gate rule', () => {
  const run = (o) => ({ id: 1, run_at: '2026-10-21T10:00:00Z', engine_version: 'tm-register-search/1', test_set_sha256: 'ab'.repeat(32), test_set_marks: 50, as_of: '2026-10-20', misses: 0, passed: true, ...o });
  assert.equal(gateState([]).passed, false);
  assert.equal(gateState([run({})]).passed, true);
  assert.equal(gateState([run({ test_set_marks: 1 })]).passed, false, 'a small seed set never opens the gate');
  assert.equal(gateState([run({ engine_version: 'tm-register-search/0' })]).passed, false, 'a pass on an older engine does not count');
  assert.equal(gateState([run({}), run({ id: 2, run_at: '2026-10-22T10:00:00Z', passed: false, misses: 2 })]).passed, false, 'a later failure closes it');
  assert.match(gateState([run({ id: 2, passed: false, misses: 2 })]).reason, /missed 2 live conflicts/);
  assert.deepEqual(offerState({ configured: false }).offered, false);
  assert.equal(offerState({ configured: true, reachable: true, stale: false, gate: { passed: false, reason: 'x' } }).default, false);
  assert.match(offerState({ configured: true, reachable: true, stale: false, gate: { passed: false, reason: 'x' } }).message, new RegExp(PRELIMINARY_LABEL));
  assert.equal(offerState({ configured: true, reachable: true, stale: false, gate: { passed: true } }).default, true);
  assert.equal(offerState({ configured: true, reachable: true, stale: true, gate: { passed: true } }).offered, false, 'stale = not offered, whatever the gate');
});

test('registerStatus: feature off, and on (stale threshold and gate read from the copy)', async () => {
  const off = await registerStatus({ env: {} });
  assert.equal(off.configured, false); assert.equal(off.offered, false); assert.match(off.message, /not available/);
  const db = await freshDb();
  await stampAsOf(db, '2026-10-20');
  const on = await registerStatus({ env: {}, db, today: '2026-10-21' });
  assert.equal(on.configured, true); assert.equal(on.offered, true); assert.equal(on.default, false); assert.equal(on.gate.passed, false);
  const stale = await registerStatus({ env: { TM_REGISTER_STALE_DAYS: '0' }, db, today: '2026-10-21' });
  assert.equal(stale.offered, false); assert.equal(stale.stale, true);
  await db.close();
});

// ---------------------------------------------------------------------------
test('daily update: no key = no download and as_of stays; a failed day stops the run there', async () => {
  const db = await freshDb();
  await stampAsOf(db, '2026-10-18');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-daily-'));
  const none = await runDaily({ db, through: '2026-10-20', key: null, dir, pauseMs: 0 });
  assert.equal(none.failed.day, '2026-10-19'); assert.equal(none.failed.error, KEY_NEEDED);
  assert.equal(none.asOfAfter, '2026-10-18');

  const calls = [];
  const bodies = { 'apc261019.zip': fs.readFileSync(DAILY), 'apc261020.zip': fs.readFileSync(NODATA) };
  const fetchImpl = async (url, init) => {
    calls.push({ url, key: init?.headers?.['X-API-KEY'] ?? null, redirect: init?.redirect });
    const u = new URL(url);
    if (u.host === 'api.uspto.gov') {
      const name = u.pathname.split('/').pop();
      if (!bodies[name]) return new Response('not found', { status: 404 });
      return new Response(null, { status: 302, headers: { location: `https://files.example.test/signed/${name}?sig=1` } });
    }
    return new Response(bodies[u.pathname.split('/').pop()], { status: 200 });
  };
  // Serve the XML as a .zip-named file: write a real zip with one entry.
  const JSZip = (await import('jszip')).default;
  for (const k of Object.keys(bodies)) {
    const z = new JSZip(); z.file(k.replace('.zip', '.xml'), bodies[k]);
    bodies[k] = await z.generateAsync({ type: 'nodebuffer' });
  }
  const r = await runDaily({ db, through: '2026-10-21', key: 'stub-odp-key', dir, fetchImpl, pauseMs: 0 });
  assert.deepEqual(r.loaded, ['2026-10-19', '2026-10-20']);
  assert.equal(r.failed.day, '2026-10-21'); assert.match(r.failed.error, /404/);
  assert.equal(r.asOfAfter, '2026-10-20', 'as_of stops at the last day of the unbroken run');
  const api = calls.filter((c) => c.url.startsWith('https://api.uspto.gov/'));
  const file = calls.filter((c) => !c.url.startsWith('https://api.uspto.gov/'));
  assert.ok(api.every((c) => c.key === 'stub-odp-key' && c.redirect === 'manual'), 'the key goes to api.uspto.gov only');
  assert.ok(file.length === 2 && file.every((c) => c.key === null), 'and never to the signed file host');
  assert.equal(api[0].url, 'https://api.uspto.gov/api/v1/datasets/products/files/TRTDXFAP/apc261019.zip');
  assert.deepEqual(daysToFetch('2026-10-18', '2026-10-21'), ['2026-10-19', '2026-10-20', '2026-10-21']);
  assert.deepEqual(daysToFetch(null, '2026-10-21'), ['2026-10-21']);
  assert.equal(dailyFileName('2026-01-05'), 'apc260105.zip');
  fs.rmSync(dir, { recursive: true, force: true });
  await db.close();
});

// ---------------------------------------------------------------------------
test('recall: the seed finds both live conflicts, reports the diagnostics, and does not open the gate', async () => {
  const db = await freshDb();
  await loadFile(db, BACKFILE, { kind: 'fixture', asOf: '2026-10-18' });
  await stampAsOf(db, '2026-10-18');
  assert.deepEqual(testSetProblems(SEED), []);
  const r = await runRecall(db, SEED, { asOf: '2026-10-18' });
  assert.equal(r.recall_ok, true); assert.equal(r.misses, 0); assert.equal(r.conflicts, 2);
  assert.equal(r.passed, false, 'one mark is not a gate set');
  const p = r.per_mark[0];
  assert.deepEqual(p.found.map((f) => f.serial).sort(), ['90562533', '98137428']);
  assert.ok(p.found.find((f) => f.serial === '90562533').by.includes('Q5'), 'EQUASITE by Q5');
  const q7 = p.diagnostics.find((d) => /^CM:equa\* AND LD:true AND IC/.test(d.query));
  assert.equal(q7.tmsearch_rows, 392);
  assert.ok(q7.tmsearch_only > 0, 'records tmsearch returned through fields the fixture lacks (pseudo marks, translations) are listed');
  assert.match(recallReport(r), /NOT A PASS/);
  const stored = await storeRecall(db, r);
  assert.ok(stored.id);
  await assert.rejects(db.query('delete from register_gate'), /append-only/);

  const withMiss = structuredClone(SEED);
  withMiss.marks[0].tmsearch.live_conflicts.push({ serial: '12345678', mark: 'NOT IN THE COPY' });
  const m = await runRecall(db, withMiss, { minMarks: 1 });
  assert.equal(m.passed, false); assert.deepEqual(m.per_mark[0].misses, [{ serial: '12345678', mark: 'NOT IN THE COPY' }]);
  assert.match(recallReport(m), /FAIL: 1 live conflict/);

  const ok = await runRecall(db, SEED, { minMarks: 1, asOf: '2026-10-18' });
  assert.equal(ok.passed, true);
  await storeRecall(db, ok);
  const st = await registerStatus({ env: { TM_REGISTER_GATE_MIN_MARKS: '1' }, db, today: '2026-10-19' });
  assert.equal(st.gate.passed, true); assert.equal(st.default, true);
  const st50 = await registerStatus({ env: {}, db, today: '2026-10-19' });
  assert.equal(st50.gate.passed, false, 'at the default minimum (50) the same pass does not open the gate');
  await db.close();
});
