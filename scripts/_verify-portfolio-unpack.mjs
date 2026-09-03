// End-to-end check of the portfolio unpack against a real document row, run
// with the service role from this machine (the Fly worker still runs the
// previous build, so it only sees the plain-PDF children this produces).
//
//   node scripts/_verify-portfolio-unpack.mjs <document_id>            # unpack + watch
//   node scripts/_verify-portfolio-unpack.mjs <document_id> --cleanup  # delete what the unpack made
//
// Cleanup removes the folder the unpack created, every child in it (storage
// objects included; passages cascade), and the wrapper itself.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }),
);
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const docId = process.argv[2];
const cleanup = process.argv.includes('--cleanup');
if (!docId) { console.error('usage: <document_id> [--cleanup]'); process.exit(2); }

const { data: doc, error } = await supabase.from('documents')
  .select('id, title, source_filename, matterspace_id, storage_path, processing_status, metadata')
  .eq('id', docId).single();
if (error) throw new Error(error.message);
console.log('wrapper:', JSON.stringify({ ...doc, metadata: undefined }));

if (cleanup) {
  const folderId = doc.metadata?.portfolio?.folder_id;
  const childIds = (doc.metadata?.portfolio?.children || []).map((c) => c.id);
  console.log(`cleanup: folder ${folderId || '(none)'}, ${childIds.length} children, wrapper ${doc.id}`);
  const ids = [...childIds, doc.id];
  const { data: rows } = await supabase.from('documents').select('id, storage_path').in('id', ids);
  const paths = (rows || []).map((r) => r.storage_path).filter(Boolean);
  if (paths.length) {
    const { error: rmErr } = await supabase.storage.from('vault-documents').remove(paths);
    console.log(`  storage removed ${paths.length}${rmErr ? ' — ' + rmErr.message : ''}`);
  }
  const { error: dErr } = await supabase.from('documents').delete().in('id', ids);
  console.log(`  documents deleted${dErr ? ' — ' + dErr.message : ''}`);
  if (folderId) {
    const { count } = await supabase.from('documents').select('id', { count: 'exact', head: true }).eq('matterspace_id', folderId);
    if (count === 0) {
      const { error: fErr } = await supabase.from('matterspaces').delete().eq('id', folderId);
      console.log(`  folder deleted${fErr ? ' — ' + fErr.message : ''}`);
    } else {
      console.log(`  folder kept: still holds ${count} document(s)`);
    }
  }
  process.exit(0);
}

const { processDocument } = await import('../lib/ingest-core.mjs');
const { ocrPdf } = await import('../lib/ocr-gemini.mjs');

console.log('downloading', doc.storage_path);
const { data: blob, error: dlErr } = await supabase.storage.from('vault-documents').download(doc.storage_path);
if (dlErr) throw new Error(`download: ${dlErr.message}`);
const fileBuf = Buffer.from(await blob.arrayBuffer());
console.log(`${(fileBuf.length / 1048576).toFixed(1)} MB`);

const t0 = Date.now();
const result = await processDocument(supabase, {
  documentId: doc.id,
  fileBuf,
  ext: '.' + doc.source_filename.split('.').pop().toLowerCase(),
  openaiApiKey: env.OPENAI_API_KEY,
  ocr: (buf) => ocrPdf(buf, { apiKey: env.GOOGLE_API_KEY }),
  onProgress: ({ stage, message }) => console.log(`  [${stage}] ${message}`),
});
console.log(`processDocument → ${JSON.stringify(result).slice(0, 600)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const summary = result.portfolio;
if (!summary) { console.log('NOT a portfolio — nothing to watch'); process.exit(0); }

const { data: after } = await supabase.from('documents')
  .select('matterspace_id, processing_status, page_count, storage_path')
  .eq('id', doc.id).single();
console.log('wrapper after:', JSON.stringify(after));

// Watch the children through the live worker.
const ids = summary.children.map((c) => c.id);
const deadline = Date.now() + 15 * 60_000;
while (Date.now() < deadline) {
  const { data: rows } = await supabase.from('documents')
    .select('id, title, processing_status, page_count, processing_error')
    .in('id', ids).order('title');
  const line = rows.map((r) => `${r.processing_status}${r.page_count ? ':' + r.page_count + 'pp' : ''}`).join(' | ');
  console.log(new Date().toISOString().slice(11, 19), line);
  if (rows.every((r) => r.processing_status === 'ready' || r.processing_status === 'error')) {
    for (const r of rows) {
      const { count } = await supabase.from('passages').select('id', { count: 'exact', head: true }).eq('document_id', r.id);
      console.log(`  ${r.processing_status.padEnd(6)} ${String(r.page_count).padStart(4)} pp ${String(count).padStart(4)} passages | ${r.title}${r.processing_error ? ' | ' + r.processing_error : ''}`);
    }
    break;
  }
  await new Promise((r) => setTimeout(r, 20_000));
}
