// The recall gate: run a test set (format equazia-tm-recall/1) on the copy,
// print per-mark misses and the verdict, and with --store append the result
// to register_gate (the stored pass record the agent reads).
//
//   node scripts/tm-register/recall.mjs --db <url> --set <test-set.json> [--store] [--min-marks 50] [--json]
import fs from 'node:fs';
import { args, dbUrl } from './_args.mjs';
import { openRegisterDb } from '../../lib/trademark/register/db.mjs';
import { applySchema } from '../../lib/trademark/register/load.mjs';
import { runRecall, storeRecall, recallReport } from '../../lib/trademark/register/recall.mjs';

const a = args();
if (typeof a.set !== 'string') { console.error('usage: node scripts/tm-register/recall.mjs --db <url> --set <file> [--store] [--min-marks N]'); process.exit(2); }
const db = await openRegisterDb(dbUrl(a));
await applySchema(db);
const set = JSON.parse(fs.readFileSync(a.set, 'utf8'));
const asOf = (await db.query("select value from register_meta where key = 'as_of'")).rows[0]?.value ?? null;
const r = await runRecall(db, set, { minMarks: a['min-marks'] ? Number(a['min-marks']) : undefined, asOf });
console.log(a.json ? JSON.stringify(r, null, 2) : recallReport(r));
if (a.store) { const s = await storeRecall(db, r); console.log(`stored as register_gate #${s.id}`); }
await db.close();
process.exit(r.passed ? 0 : 1);
