// The daily update: fetch each missing day's applications file (TRTDXFAP,
// apcYYMMDD.zip) from the USPTO Open Data Portal, load it, and stamp the
// copy's as-of date — only through the last day of an unbroken run. A failed
// day leaves as_of where it was; the copy then reports itself stale.
//
//   node scripts/tm-register/daily.mjs --db <url> [--through YYYY-MM-DD] [--dir <download dir>]
//
// Needs USPTO_ODP_API_KEY in the environment (never on the command line).
import { args, dbUrl } from './_args.mjs';
import { openRegisterDb } from '../../lib/trademark/register/db.mjs';
import { applySchema } from '../../lib/trademark/register/load.mjs';
import { runDaily } from '../../lib/trademark/register/daily.mjs';

const a = args();
const db = await openRegisterDb(dbUrl(a));
await applySchema(db);
const dir = typeof a.dir === 'string' ? a.dir : (process.env.TM_REGISTER_DOWNLOAD_DIR || 'C:/Users/equai/context-ai-scratch/uspto-bulk/daily');
const r = await runDaily({ db, through: typeof a.through === 'string' ? a.through : undefined, dir, log: (s) => console.log(s) });
console.log(JSON.stringify(r, null, 2));
await db.close();
process.exit(r.failed ? 1 : 0);
