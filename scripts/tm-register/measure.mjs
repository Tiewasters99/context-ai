// Phase 0 measurement: the loaded size of the register copy per 100,000
// records, with every index, and the load and query times — on SYNTHETIC
// records (no USPTO file was available: the ODP download needs a key).
//
//   node scripts/tm-register/measure.mjs [--n 100000] [--db pglite:memory]
//
// The records are the committed fixture's 404 rows (392 of them carry real
// tmsearch-export text: marks, owners, goods truncated by tmsearch at about
// 1,000 characters), cloned with new serials and lightly varied marks. Real
// records carry the FULL goods text and more statements, so a real row is
// larger: read the result as a floor, and see the spec (§11) for the range
// used in the hosting estimate.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { args } from './_args.mjs';
import { openRegisterDb } from '../../lib/trademark/register/db.mjs';
import { applySchema, rowFor, UPSERT_SQL } from '../../lib/trademark/register/load.mjs';
import { streamRecords } from '../../lib/trademark/register/xml.mjs';
import { runQuery } from '../../lib/trademark/register/search.mjs';
import { generateQueries } from '../../lib/trademark/queries.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const a = args();
const N = Number(a.n ?? 100000);
const db = await openRegisterDb(typeof a.db === 'string' ? a.db : 'pglite:memory');
await applySchema(db);

const base = [];
for await (const r of streamRecords(fs.createReadStream(path.join(ROOT, 'scripts', 'fixtures', 'tm-register', 'apc-synthetic-backfile-20261018.xml')), { asOf: '2026-10-18', fileName: 'measure' })) base.push(r);
const SYL = ['ka', 'lo', 'mi', 'ne', 'ru', 'ta', 'vo', 'zi', 'qu', 'bel', 'dor', 'fen'];
const vary = (mark, i) => {
  if (!mark) return mark;
  const s = SYL[i % SYL.length] + SYL[(i * 7) % SYL.length];
  return i % 3 === 0 ? `${mark} ${s.toUpperCase()}` : i % 3 === 1 ? `${s.toUpperCase()}${mark}` : mark.replace(/[AEIOU]/, s[0].toUpperCase());
};

const t0 = Date.now();
let batch = [];
for (let i = 0; i < N; i++) {
  const r = base[i % base.length];
  batch.push(rowFor({ ...r, serial: String(10000000 + i), mark: vary(r.mark, i), source_file: 'measure', as_of: '2026-10-18' }));
  if (batch.length === 500) { await db.query(UPSERT_SQL, [JSON.stringify(batch)]); batch = []; }
}
if (batch.length) await db.query(UPSERT_SQL, [JSON.stringify(batch)]);
const loadS = (Date.now() - t0) / 1000;
await db.exec('analyze register_records');

const size = (await db.query(`select pg_relation_size('register_records') heap,
  pg_total_relation_size('register_records') total, pg_indexes_size('register_records') idx,
  (select count(*) from register_records)::int n`)).rows[0];
const idx = (await db.query(`select c.relname, pg_relation_size(c.oid) b from pg_index i join pg_class c on c.oid = i.indexrelid
  where i.indrelid = 'register_records'::regclass order by 2 desc`)).rows;

const { queries } = generateQueries({ mark: 'EQUAZIA', decomposition: { opening: 'equa', hinge: 'z', ending: 'ia' }, searchClasses: ['009', '042', '045'], knownMarks: [{ name: 'EQUALL', owner: 'Equall Inc' }], foreignEquivalents: ['equazione'] });
const times = [];
for (const q of queries) {
  const t = Date.now();
  const r = await runQuery(db, q.query, { mark: 'EQUAZIA', searchClasses: ['009', '042', '045'] });
  times.push({ q: `Q${q.seq}`, ms: Date.now() - t, count: r.count });
}
const per100k = (b) => (Number(b) / Number(size.n)) * 100000;
const mb = (b) => `${(Number(b) / 1048576).toFixed(1)} MB`;
console.log(JSON.stringify({
  records: size.n, load_seconds: loadS,
  heap: mb(size.heap), indexes: mb(size.idx), total: mb(size.total),
  per_100k: { heap: mb(per100k(size.heap)), indexes: mb(per100k(size.idx)), total: mb(per100k(size.total)), bytes_per_record: Math.round(Number(size.total) / Number(size.n)) },
  indexes_by_size: idx.map((x) => `${x.relname} ${mb(x.b)}`),
  query_ms: times,
  engine: (await db.query('select version()')).rows[0].version.split(' on ')[0],
}, null, 2));
await db.close();
