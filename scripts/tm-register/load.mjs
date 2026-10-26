// Load USPTO trademark applications XML (a .zip or .xml; a daily file or an
// annual backfile piece) into the register copy, by serial.
//
//   node scripts/tm-register/load.mjs <file> [<file> …] --db <url> [--kind daily|backfile|fixture] [--as-of YYYY-MM-DD] [--stamp-as-of]
//
// The schema (db/tm-register/schema.sql) is applied first (re-runnable). A
// file already loaded with the same sha256 is skipped; a file that fails
// rolls back and leaves the copy as it was. --stamp-as-of moves the copy's
// as-of date to the file's date after a successful load (the daily script
// does this itself, and only for an unbroken run of days).
import { args, dbUrl } from './_args.mjs';
import { openRegisterDb } from '../../lib/trademark/register/db.mjs';
import { applySchema, loadFile, stampAsOf } from '../../lib/trademark/register/load.mjs';

const a = args();
if (!a._.length) { console.error('usage: node scripts/tm-register/load.mjs <file> [...] --db <url> [--kind …] [--as-of YYYY-MM-DD] [--stamp-as-of]'); process.exit(2); }
const db = await openRegisterDb(dbUrl(a));
await applySchema(db);
let failed = 0;
for (const file of a._) {
  const t = Date.now();
  try {
    const r = await loadFile(db, file, { kind: typeof a.kind === 'string' ? a.kind : undefined, asOf: typeof a['as-of'] === 'string' ? a['as-of'] : undefined, log: (s) => console.log(s) });
    if (a['stamp-as-of'] && !r.skipped) await stampAsOf(db, r.asOf);
    console.log(`${file}: done in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  } catch (err) {
    failed++;
    console.error(`${file}: FAILED, nothing from it was kept — ${err?.message ?? err}`);
  }
}
const n = (await db.query('select count(*)::int n, count(*) filter (where live)::int l from register_records')).rows[0];
const asOf = (await db.query("select value from register_meta where key = 'as_of'")).rows[0]?.value ?? 'unset';
console.log(`register copy: ${n.n} records (${n.l} live); as of ${asOf}.`);
await db.close();
process.exit(failed ? 1 : 0);
