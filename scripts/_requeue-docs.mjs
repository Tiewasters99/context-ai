// Requeue specific documents on the worker by id — the monitor's own requeue (a BULK-priority
// ingest_document job + status back to pending), for rows whose stored error no triage rule can
// match (e.g. rows written before attemptFailureNote kept the raw error). Read-only unless --apply.
// Usage: node scripts/_requeue-docs.mjs --ids <id,id,…> [--apply]
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import { JOB_PRIORITY } from '../lib/ingest-core.mjs';
const env = Object.fromEntries(fs.readFileSync('.env', 'utf8').split(/\r?\n/)
  .filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
const sb = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const argv = process.argv.slice(2);
const ids = (argv[argv.indexOf('--ids') + 1] || '').split(',').map(s => s.trim()).filter(Boolean);
const APPLY = argv.includes('--apply');
if (!ids.length) { console.error('Usage: node scripts/_requeue-docs.mjs --ids <id,…> [--apply]'); process.exit(1); }
const { data: docs, error } = await sb.from('documents').select('id, title, matterspace_id, processing_status, processing_error').in('id', ids);
if (error) throw error;
for (const d of docs) {
  console.log(`${APPLY ? 'requeue' : 'would requeue'} ${d.id.slice(0, 8)} ${d.processing_status} — ${d.title} | ${(d.processing_error || '').slice(0, 70)}`);
  if (!APPLY) continue;
  const { error: jErr } = await sb.from('processing_jobs').insert({
    matterspace_id: d.matterspace_id, job_type: 'ingest_document', status: 'queued',
    priority: JOB_PRIORITY.BULK, payload: { document_id: d.id },
  });
  if (jErr) { console.error('  ! job insert failed:', jErr.message); continue; }
  const { error: uErr } = await sb.from('documents').update({ processing_status: 'pending', processing_error: null }).eq('id', d.id);
  if (uErr) console.error('  ! status update failed:', uErr.message);
}
console.log(`${docs.length} of ${ids.length} ids found`);
