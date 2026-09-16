// Ledger repair: records skipped as duplicate_in_matter because every post is "index.html" and two posts
// happened to be the same size. Appends a pending record for each so the next --run picks them up.
// Read-only unless --apply. Usage: node scripts/_requeue-false-dupes.mjs <ledger.jsonl> [--apply]
import fs from 'node:fs';
const [file] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const APPLY = process.argv.includes('--apply');
const map = new Map();
for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (l.trim()) { const r = JSON.parse(l); map.set(r.key, r); } }
const hits = [...map.values()].filter(r => r.status === 'skipped' && r.reason === 'duplicate_in_matter');
for (const r of hits.slice(0, 5)) console.log('  ', r.rel, r.size);
if (APPLY) {
  const out = hits.map(r => JSON.stringify({ ...r, status: 'pending', reason: null, ts: new Date().toISOString() })).join('\n') + '\n';
  fs.appendFileSync(file, out);
}
console.log(`${APPLY ? 'requeued' : 'would requeue'} ${hits.length} false duplicates in ${file}`);
