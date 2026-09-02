import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const txt = await fs.readFile(path.resolve(__dirname, '..', '.env'), 'utf8');
for (const line of txt.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: docs, error: qErr } = await supabase.from('documents')
  .select('id, source_filename, storage_path')
  .ilike('source_filename', '%excess pages%');
if (qErr) { console.log('query err:', qErr.message); process.exit(1); }
for (const d of docs) {
  const { data: blob, error } = await supabase.storage.from('vault-documents').download(d.storage_path);
  const buf = blob ? Buffer.from(await blob.arrayBuffer()) : null;
  console.log(`"${d.source_filename}" id=${d.id} db_size=${d.file_size ?? '?'} actual_bytes=${buf?.length ?? 'DL_FAIL:' + error?.message} head=${buf ? JSON.stringify(buf.slice(0, 20).toString('latin1')) : ''}`);
}
