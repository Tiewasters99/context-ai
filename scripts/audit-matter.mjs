// Audit every document in a matter: processing status, error, page count,
// and actual passage count — to find docs that are "ready" but empty.
// Usage: node scripts/_audit-matter.mjs <matter_short_code_or_uuid>
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const txt = await fs.readFile(path.resolve(__dirname, '..', '.env'), 'utf8');
for (const line of txt.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const arg = process.argv[2];
const isUuid = /^[0-9a-f-]{36}$/i.test(arg);
const { data: m } = await supabase.from('matterspaces').select('id, name, short_code')
  .eq(isUuid ? 'id' : 'short_code', arg).maybeSingle();
if (!m) { console.error('matter not found:', arg); process.exit(1); }
console.log(`Matter: ${m.name} (${m.short_code}) ${m.id}\n`);

const { data: docs, error } = await supabase.from('documents')
  .select('id, title, source_filename, processing_status, processing_error, page_count, file_size_bytes, storage_path, created_at')
  .eq('matterspace_id', m.id).order('created_at');
if (error) { console.error(error.message); process.exit(1); }

const rows = [];
for (const d of docs) {
  const { count } = await supabase.from('passages')
    .select('id', { count: 'exact', head: true }).eq('document_id', d.id);
  rows.push({ ...d, passages: count ?? 0 });
}

const ext = (f) => (f && f.includes('.') ? '.' + f.split('.').pop().toLowerCase() : '(none)');
const empty = rows.filter((r) => r.passages === 0);
const errored = rows.filter((r) => r.processing_status === 'error');

console.log(`${rows.length} documents, ${empty.length} with ZERO passages, ${errored.length} in error status\n`);
console.log('--- All docs ---');
for (const r of rows) {
  const flag = r.processing_status === 'error' ? 'ERR' : r.passages === 0 ? 'EMPTY' : 'ok';
  console.log(`${flag.padEnd(6)} ${String(r.passages).padStart(5)}p  ${ext(r.source_filename).padEnd(7)} ${String(r.file_size_bytes ?? 0).padStart(9)}B  status=${r.processing_status}  ${r.title || r.source_filename}`);
  if (r.processing_error) console.log(`       error: ${r.processing_error}`);
  if (!r.storage_path) console.log('       WARNING: no storage_path (file bytes missing!)');
}

console.log('\n--- Empty doc ids by extension ---');
const byExt = {};
for (const r of empty) (byExt[ext(r.source_filename)] ??= []).push(r.id);
for (const [e, ids] of Object.entries(byExt)) console.log(`${e}: ${ids.length}\n${ids.join('\n')}`);
