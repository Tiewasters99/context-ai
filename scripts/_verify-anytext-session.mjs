// Probe: the shelf's new any-text upload files a session with `pages` under a
// real user JWT (RLS 037/038). Signs in as the standing tts-probe user, inserts
// a session shaped exactly like StudentHubHome.fileUpload does, reads it back,
// and deletes it. No service role anywhere.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);

const { data: auth, error: authErr } = await supabase.auth.signInWithPassword({
  email: 'tts-probe@yopmail.com',
  password: 'Probe-2026-tts!',
});
if (authErr) throw new Error(`sign-in failed: ${authErr.message}`);
console.log('signed in as', auth.user.email, auth.user.id);

// The exact insert createSession() now performs for an upload with pages.
const fakePages = [`${auth.user.id}/text-probe/page_0001.jpg`, `${auth.user.id}/text-probe/page_0002.jpg`];
const { data: row, error: insErr } = await supabase
  .from('student_hub_sessions')
  .insert({
    owner_id: auth.user.id,
    title: '_anytext probe — delete me',
    citation: '',
    source_label: 'your own text',
    reading: 'Probe reading body. Two lines.\nSecond line.',
    model_id: 'claude-opus-4-8',
    pages: fakePages,
  })
  .select('*')
  .single();
if (insErr) throw new Error(`insert failed: ${insErr.message}`);
console.log('inserted', row.id, '| pages column round-trip:', JSON.stringify(row.pages));

const ok = Array.isArray(row.pages) && row.pages.length === 2 && row.pages[0] === fakePages[0];
const { error: delErr } = await supabase.from('student_hub_sessions').delete().eq('id', row.id);
if (delErr) throw new Error(`cleanup delete failed: ${delErr.message}`);
console.log('cleaned up.');
console.log(ok ? 'PASS: pages persists via user JWT' : 'FAIL: pages did not round-trip');
process.exit(ok ? 0 : 1);
