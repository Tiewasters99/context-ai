// One-time cleanup, 2026-07-30: null processing_error on documents that are
// READY — leftovers from failed attempts a later retry recovered from (e.g.
// the Locke embed-429 in grapheon-libararian). The pipeline now clears the
// field on success (lib/ingest-core.mjs); this heals rows from before that fix.
//
//   node scripts/_clear_stale_processing_errors.mjs          # report only
//   node scripts/_clear_stale_processing_errors.mjs --apply  # fix them
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');

const t = await fs.readFile(path.resolve(__dirname, '..', '.env'), 'utf8');
for (const line of t.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2];
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data, error } = await supabase
  .from('documents')
  .select('id, source_filename, processing_status, processing_error')
  .eq('processing_status', 'ready')
  .not('processing_error', 'is', null);
if (error) { console.error(error.message); process.exit(1); }

console.log(`${data.length} ready document(s) carrying a stale error:`);
for (const d of data) {
  console.log(`  ${d.id}  ${d.source_filename}  — ${String(d.processing_error).slice(0, 80).replace(/\s+/g, ' ')}`);
}

if (!APPLY) { console.log('\nDry run. Re-run with --apply to clear.'); process.exit(0); }

const { error: upErr } = await supabase
  .from('documents')
  .update({ processing_error: null })
  .eq('processing_status', 'ready')
  .not('processing_error', 'is', null);
if (upErr) { console.error(upErr.message); process.exit(1); }
console.log(`\nCleared ${data.length} stale error(s).`);
