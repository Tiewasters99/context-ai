// Ledger repair: rows that errored on a transient network failure become pending so the next --run retries them.
// Read-only unless --apply. Usage: node scripts/_requeue-errors.mjs <ledger.jsonl> [--match "fetch failed"] [--apply]
import fs from 'node:fs';
const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith('--'));
const mi = argv.indexOf('--match'); const match = mi >= 0 ? argv[mi + 1] : 'fetch failed';
const APPLY = argv.includes('--apply');
const map = new Map();
for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (l.trim()) { const r = JSON.parse(l); map.set(r.key, r); } }
const errs = [...map.values()].filter(r => r.status === 'error');
const hits = errs.filter(r => (String(r.reason || '') + ' ' + String(r.error || '')).includes(match));
for (const r of hits.slice(0, 3)) console.log('  ', r.rel, '—', String(r.reason || r.error || '').slice(0, 80));
if (APPLY) {
  fs.appendFileSync(file, hits.map(r => JSON.stringify({ ...r, status: 'pending', reason: null, error: null, ts: new Date().toISOString() })).join('\n') + '\n');
}
console.log(`${APPLY ? 'requeued' : 'would requeue'} ${hits.length} of ${errs.length} errored rows matching "${match}"`);
