// Post-hoc: rename Facebook post rows that landed as "index" before the importer learned to title them.
// The folder (2020_06_22__22_50_40) is only in the ledger, so map document_id → rel through the ledgers.
// Read-only unless --apply. Usage: node scripts/_retitle-posts.mjs [--apply]
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
const env = Object.fromEntries(fs.readFileSync('.env', 'utf8').split(/\r?\n/)
  .filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
const sb = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const APPLY = process.argv.includes('--apply');
const LEDGERS = [
  '.import-state/c-users-equai-demo-import-sec-communication-facebook-ekim-kaya.jsonl',
  '.import-state/c-users-equai-demo-import-sec-communication-facebook-kaya-online.jsonl',
];
const byDoc = new Map();
for (const f of LEDGERS) {
  if (!fs.existsSync(f)) continue;
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    const r = JSON.parse(l);
    if (r.document_id) byDoc.set(r.document_id, r.rel);
  }
}
const MATTERS = ['9d144a3c-b354-4d25-a3d4-a10f010909d2', 'ba183c48-0d00-4f81-b53a-155b5409ec67']; // Facebook — Ekim Kaya, Facebook — Kaya Online
const { data, error } = await sb.from('documents').select('id, title').in('matterspace_id', MATTERS).eq('title', 'index');
if (error) throw error;
let n = 0;
for (const d of data) {
  if (!byDoc.has(d.id)) continue;
  const folder = path.basename(path.dirname(byDoc.get(d.id)));
  const m = folder.match(/^(\d{4})_(\d{2})_(\d{2})__(\d{2})_(\d{2})_(\d{2})$/);
  const title = m ? `Post ${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : `${folder} — index`;
  if (n < 3) console.log(d.id.slice(0, 8), '→', title);
  if (APPLY) { const { error: e } = await sb.from('documents').update({ title }).eq('id', d.id); if (e) console.error('ERR', d.id, e.message); }
  n++;
}
console.log(`${APPLY ? 'renamed' : 'would rename'} ${n} of ${data.length} "index" rows (ledger knows ${byDoc.size} documents)`);
