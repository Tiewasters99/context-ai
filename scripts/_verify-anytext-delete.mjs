// Probe: deleting a reading scrubs its scan folder (pages + ocr sidecars)
// under a real user JWT — mirrors the deleteSession/removeScanFolder logic in
// src/lib/student-hub.ts against live RLS (storage 038: owner DELETE).
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);
const BUCKET = 'student-hub-scans';

const { data: auth, error: aErr } = await supabase.auth.signInWithPassword({
  email: 'tts-probe@yopmail.com', password: 'Probe-2026-tts!',
});
if (aErr) throw new Error(aErr.message);
const uid = auth.user.id;
const prefix = `${uid}/text-delprobe`;

// Stage: one fake page + one ocr sidecar + the session row.
const jpeg = new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
for (const [path, blob, type] of [
  [`${prefix}/page_0001.jpg`, jpeg, 'image/jpeg'],
  [`${prefix}/ocr/page_0001.txt`, new Blob(['probe text'], { type: 'text/plain' }), 'text/plain'],
]) {
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: type });
  if (error && !/already exists/i.test(error.message)) throw new Error(`upload ${path}: ${error.message}`);
}
const { data: row, error: iErr } = await supabase.from('student_hub_sessions').insert({
  owner_id: uid, title: '_delete probe', citation: '', source_label: 'probe',
  reading: 'probe', model_id: 'claude-opus-4-8', pages: [`${prefix}/page_0001.jpg`],
}).select('id').single();
if (iErr) throw new Error(iErr.message);
console.log('staged: 2 storage objects + session', row.id);

// Mirror removeScanFolder + deleteSession.
const paths = [];
for (const folder of [prefix, `${prefix}/ocr`]) {
  const { data } = await supabase.storage.from(BUCKET).list(folder, { limit: 1000 });
  for (const e of data ?? []) if (e.id) paths.push(`${folder}/${e.name}`);
}
console.log('listed for scrub:', JSON.stringify(paths));
const { error: rErr } = await supabase.storage.from(BUCKET).remove(paths);
if (rErr) throw new Error(`storage remove: ${rErr.message}`);
const { error: dErr } = await supabase.from('student_hub_sessions').delete().eq('id', row.id);
if (dErr) throw new Error(`row delete: ${dErr.message}`);

// Verify nothing is left.
const { data: left1 } = await supabase.storage.from(BUCKET).list(prefix, { limit: 10 });
const { data: left2 } = await supabase.storage.from(BUCKET).list(`${prefix}/ocr`, { limit: 10 });
const leftovers = [...(left1 ?? []), ...(left2 ?? [])].filter((e) => e.id);
const { data: rows } = await supabase.from('student_hub_sessions').select('id').eq('id', row.id);
const ok = paths.length === 2 && leftovers.length === 0 && (rows ?? []).length === 0;
console.log(ok ? 'PASS: scrub removed both objects and the row under user JWT'
               : `FAIL: leftovers=${leftovers.length} rows=${(rows ?? []).length} listed=${paths.length}`);
process.exit(ok ? 0 : 1);
