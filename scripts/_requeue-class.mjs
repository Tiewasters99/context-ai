// Ledger repair: rows a --scan skipped as class_img_not_included / class_av_not_included become pending, so
// a later --run files them (Tier 2/3 after a documents-only Tier 1). Optionally re-points them at another matter.
// Read-only unless --apply. Usage: node scripts/_requeue-class.mjs <ledger.jsonl> --classes img,av [--matter <short_code>] [--apply]
import fs from 'node:fs';
const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith('--'));
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const classes = (opt('--classes') || 'img,av').split(',');
const matter = opt('--matter');
const APPLY = argv.includes('--apply');
const map = new Map();
for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (l.trim()) { const r = JSON.parse(l); map.set(r.key, r); } }
const hits = [...map.values()].filter(r => r.status === 'skipped' && classes.some(c => r.reason === `class_${c}_not_included`));
const by = {}; for (const r of hits) by[r.cls] = (by[r.cls] || 0) + 1;
if (APPLY) {
  const out = hits.map(r => JSON.stringify({ ...r, status: 'pending', reason: null, ...(matter ? { matter } : {}), ts: new Date().toISOString() })).join('\n') + '\n';
  fs.appendFileSync(file, out);
}
console.log(`${APPLY ? 'requeued' : 'would requeue'} ${hits.length} ${JSON.stringify(by)}${matter ? ` → ${matter}` : ''} in ${file.split(/[\\/]/).pop()}`);
