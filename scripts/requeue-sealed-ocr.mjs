// Re-run the scans a SecureSpace seal held, once the sealed OCR route exists
// (Phase 4 of the ingestion plan, 2026-09-04; docs/SEALED_OCR_SETUP.md step 7).
//
// Two kinds of row wait for the route:
//   * ready documents whose typed pages are indexed and whose scanned pages
//     are recorded as held (documents.metadata.ocr_pending.held = true) —
//     the worker's sweep never retries these, by design;
//   * documents parked in processing_status 'held' because the whole file
//     needed OCR (an image-only scan, a JPEG) and the seal refused the pipe.
// Both get one ingest_document job (deduped against jobs in flight) and go
// back to 'pending'; the worker OCRs them through Textract on its next claim.
//
//   node scripts/requeue-sealed-ocr.mjs                 # dry run: counts and titles
//   node scripts/requeue-sealed-ocr.mjs --apply         # queue them
//   node scripts/requeue-sealed-ocr.mjs --matter <short_code|uuid> [--apply]
//
// Refuses to --apply unless THIS environment resolves a Tier B route, as a
// guard against queueing a thousand documents that will only be held again;
// the worker's own env is what actually runs them (fly secrets), so check
// that first: node scripts/_verify-ocr-routes.mjs --live B.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { resolveOcrRoutes } from '../lib/ocr-routes.mjs';
import { JOB_PRIORITY } from '../lib/ingest-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
for (const l of fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  if (!/^[A-Z_]+=/.test(l)) continue;
  const i = l.indexOf('=');
  if (env[l.slice(0, i)] == null) env[l.slice(0, i)] = l.slice(i + 1).trim().replace(/^"|"$/g, '');
}
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const matterArg = args.includes('--matter') ? args[args.indexOf('--matter') + 1] : null;
let matterId = null;
if (matterArg) {
  const isUuid = /^[0-9a-f-]{36}$/i.test(matterArg);
  const { data, error } = await supabase.from('matterspaces').select('id, name').eq(isUuid ? 'id' : 'short_code', matterArg).single();
  if (error) throw new Error(`matter: ${error.message}`);
  matterId = data.id;
  console.log(`matter: ${data.name}`);
}

const plan = resolveOcrRoutes('B', env);
console.log(`Tier B route here: ${plan.routes.map((r) => r.id).join(', ') || 'NONE'}${plan.reason ? ` — ${plan.reason}` : ''}`);

// Held pages on ready documents.
let q1 = supabase.from('documents')
  .select('id, title, source_filename, matterspace_id, ocr_pending:metadata->ocr_pending')
  .eq('processing_status', 'ready')
  .eq('metadata->ocr_pending->>held', 'true')
  .limit(2000);
if (matterId) q1 = q1.eq('matterspace_id', matterId);
const { data: heldPages, error: e1 } = await q1;
if (e1) throw new Error(e1.message);

// Whole documents parked by the OCR pipe.
let q2 = supabase.from('documents')
  .select('id, title, source_filename, matterspace_id, processing_error')
  .eq('processing_status', 'held')
  .ilike('processing_error', '%Reading this scan (OCR)%')
  .limit(2000);
if (matterId) q2 = q2.eq('matterspace_id', matterId);
const { data: heldDocs, error: e2 } = await q2;
if (e2) throw new Error(e2.message);

console.log(`\n${heldPages.length} ready document(s) with scanned pages held by the seal`);
for (const d of heldPages.slice(0, 20)) console.log(`  ${d.title || d.source_filename}  (${(d.ocr_pending?.pages || []).length} page(s))`);
if (heldPages.length > 20) console.log(`  … and ${heldPages.length - 20} more`);
console.log(`${heldDocs.length} document(s) parked as 'held' by the OCR pipe`);
for (const d of heldDocs.slice(0, 20)) console.log(`  ${d.title || d.source_filename}`);
if (heldDocs.length > 20) console.log(`  … and ${heldDocs.length - 20} more`);

const targets = [...heldPages, ...heldDocs];
if (!targets.length) { console.log('\nNothing to requeue.'); process.exit(0); }
if (!apply) { console.log('\nDry run. Add --apply to queue them (after the worker has the TEXTRACT_* secrets).'); process.exit(0); }
if (!plan.routes.length) { console.log('\nRefusing to --apply: no sealed OCR route resolves from this environment, so these would only be held again.'); process.exit(2); }

let queued = 0;
let skipped = 0;
for (const d of targets) {
  const { data: inflight } = await supabase.from('processing_jobs')
    .select('id').eq('job_type', 'ingest_document').in('status', ['queued', 'running'])
    .contains('payload', { document_id: d.id }).limit(1);
  if (inflight?.length) { skipped++; continue; }
  // Any job row parked as 'held' for this document is retired first; the
  // new one carries the work.
  await supabase.from('processing_jobs').update({ status: 'done', finished_at: new Date().toISOString() })
    .eq('job_type', 'ingest_document').eq('status', 'held').contains('payload', { document_id: d.id });
  const { error: qErr } = await supabase.from('processing_jobs').insert({
    matterspace_id: d.matterspace_id, job_type: 'ingest_document', priority: JOB_PRIORITY.BULK,
    payload: { document_id: d.id, sealed_ocr_requeue: true },
  });
  if (qErr) { console.log(`  enqueue failed for ${d.title || d.source_filename}: ${qErr.message}`); continue; }
  await supabase.from('documents').update({ processing_status: 'pending', processing_error: null }).eq('id', d.id);
  queued++;
}
console.log(`\nqueued ${queued}, skipped ${skipped} already in flight. Follow with: node scripts/ingest-monitor.mjs`);
