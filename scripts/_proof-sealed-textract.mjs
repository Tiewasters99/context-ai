// Live proof that the SEALED OCR route works end to end on the DEPLOYED worker:
// files a two-page fictional scan (marker words "marmalade" / "quixotic") into
// a Tier-B (SecureSpace) matter through the real queue, waits for the worker,
// and checks that the pages were read by AWS Textract inside the seal.
//
//   node scripts/_proof-sealed-textract.mjs <matterspace uuid> [--keep]
//
// Reads .env from the repo root (service role). Cleans up the document unless
// --keep. Exit 0 = PASS, 1 = FAIL.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { subsetPdf, JOB_PRIORITY } from '../lib/ingest-core.mjs';
import { mixedPdf } from './_fixtures-ingest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0 && !line.startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const args = process.argv.slice(2);
const matterId = args.find((a) => !a.startsWith('--'));
const keep = args.includes('--keep');
if (!matterId) { console.log('usage: node scripts/_proof-sealed-textract.mjs <matterspace uuid> [--keep]'); process.exit(2); }

const { data: matter, error: mErr } = await supabase.from('matterspaces').select('id, name, ai_tier').eq('id', matterId).single();
if (mErr || !matter) { console.log('matter not found:', mErr?.message); process.exit(2); }
console.log(`matter: "${matter.name}"  tier ${matter.ai_tier}`);
if (matter.ai_tier !== 'B') { console.log('FAIL: not a Tier-B (sealed) matter — refusing to run the proof anywhere else'); process.exit(1); }

const { data: anyDoc } = await supabase.from('documents').select('created_by').eq('matterspace_id', matterId).not('created_by', 'is', null).limit(1);
const createdBy = anyDoc?.[0]?.created_by;
if (!createdBy) { console.log('FAIL: no created_by available in this matter'); process.exit(1); }

const tag = Math.random().toString(36).slice(2, 8);
const bytes = await subsetPdf(await mixedPdf({ marker4: 'marmalade', marker5: 'quixotic' }), [4, 5]);
const filename = `sealed-ocr-proof-${tag}.pdf`;
const title = `Sealed OCR proof (fictional) ${tag}`;

const { data: row, error: iErr } = await supabase.from('documents').insert({
  matterspace_id: matterId, title, doc_type: 'other', source_filename: filename,
  file_size_bytes: bytes.length, processing_status: 'pending', created_by: createdBy,
}).select('id').single();
if (iErr) { console.log('FAIL insert:', iErr.message); process.exit(1); }
const docId = row.id;
const storagePath = `${matterId}/${docId}/${filename}`;
const { error: upErr } = await supabase.storage.from('vault-documents').upload(storagePath, bytes, { contentType: 'application/pdf', upsert: true });
if (upErr) { console.log('FAIL upload:', upErr.message); process.exit(1); }
await supabase.from('documents').update({ storage_path: storagePath }).eq('id', docId);
const { error: qErr } = await supabase.from('processing_jobs').insert({
  matterspace_id: matterId, job_type: 'ingest_document', priority: JOB_PRIORITY.BULK, payload: { document_id: docId, sealed_ocr_proof: true },
});
if (qErr) { console.log('FAIL enqueue:', qErr.message); process.exit(1); }
console.log(`filed ${title} (${(bytes.length / 1024).toFixed(0)} KB, 2 scanned pages) as ${docId}; waiting on the deployed worker …`);

const t0 = Date.now();
let doc = null; let last = '';
while (Date.now() - t0 < 5 * 60_000) {
  const { data } = await supabase.from('documents').select('processing_status, processing_error, metadata').eq('id', docId).single();
  if (data?.processing_status !== last) { console.log(`  ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s  ${data?.processing_status}`); last = data?.processing_status; }
  if (['ready', 'error', 'held'].includes(data?.processing_status)) { doc = data; break; }
  await new Promise((r) => setTimeout(r, 3000));
}
if (!doc) { console.log('FAIL: timed out after 5 minutes'); process.exit(1); }

const { data: passages } = await supabase.from('passages').select('*').eq('document_id', docId).limit(50);
const blob = JSON.stringify(passages || []);
const m = doc.metadata || {};
console.log('\nstatus      =', doc.processing_status, doc.processing_error ? `(${doc.processing_error})` : '');
console.log('text_status =', m.text_status);
console.log('ocr_pending =', JSON.stringify(m.ocr_pending));
console.log('ocr_route   =', JSON.stringify(m.ocr_route));
console.log('passages    =', passages?.length ?? 0, ' marmalade:', /marmalade/i.test(blob), ' quixotic:', /quixotic/i.test(blob));

const ok = doc.processing_status === 'ready' && m.ocr_route?.id === 'aws-textract' && m.ocr_route?.sealed === true
  && (passages?.length ?? 0) >= 2 && /marmalade/i.test(blob) && /quixotic/i.test(blob) && !m.ocr_pending;
console.log(ok ? '\nPASS  both scanned pages read by AWS Textract inside the seal, indexed and searchable' : '\nFAIL');

if (!keep) {
  await supabase.from('passages').delete().eq('document_id', docId);
  await supabase.storage.from('vault-documents').remove([storagePath]);
  await supabase.from('processing_jobs').delete().eq('job_type', 'ingest_document').contains('payload', { document_id: docId });
  await supabase.from('documents').delete().eq('id', docId);
  console.log('cleaned up (document, passages, file, job rows)');
} else console.log(`kept: document ${docId}`);
process.exit(ok ? 0 : 1);
