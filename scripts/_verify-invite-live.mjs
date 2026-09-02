// LIVE end-to-end probe of /api/student-hub-invite on production:
// as the standing tts-probe user, create a text + group + one unclaimed seat
// for a public yopmail inbox, call the deployed endpoint, then clean up.
// The email itself is checked by eye in the yopmail inbox afterward.
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const INVITEE = 'hub-invite-probe@yopmail.com';
const ENDPOINT = 'https://www.contextspaces.ai/api/student-hub-invite';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);

const { data: auth, error: aErr } = await supabase.auth.signInWithPassword({
  email: 'tts-probe@yopmail.com', password: 'Probe-2026-tts!',
});
if (aErr) throw new Error(aErr.message);
const uid = auth.user.id;
const token = auth.session.access_token;
console.log('signed in as tts-probe', uid);

// Stage: text -> group -> creator row + one unclaimed seat (the app's shape).
const { data: text, error: tErr } = await supabase
  .from('student_hub_texts')
  .insert({ owner_id: uid, title: '_invite probe text — delete me' })
  .select('id').single();
if (tErr) throw new Error(`text: ${tErr.message}`);
const { data: group, error: gErr } = await supabase
  .from('student_hub_groups')
  .insert({ text_id: text.id, name: 'Invite probe circle', created_by: uid })
  .select('id').single();
if (gErr) { await supabase.from('student_hub_texts').delete().eq('id', text.id); throw new Error(`group: ${gErr.message}`); }
const { error: mErr } = await supabase.from('student_hub_group_members').insert([
  { group_id: group.id, email: 'tts-probe@yopmail.com', user_id: uid, attested_at: new Date().toISOString() },
  { group_id: group.id, email: INVITEE, user_id: null },
]);
if (mErr) { await supabase.from('student_hub_groups').delete().eq('id', group.id); await supabase.from('student_hub_texts').delete().eq('id', text.id); throw new Error(`members: ${mErr.message}`); }
console.log('staged group', group.id, 'with unclaimed seat for', INVITEE);

// The call under test.
const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ groupId: group.id, email: INVITEE }),
});
const body = await res.text();
console.log('endpoint:', res.status, body);

// Clean up regardless (group delete cascades members).
await supabase.from('student_hub_groups').delete().eq('id', group.id);
await supabase.from('student_hub_texts').delete().eq('id', text.id);
console.log('cleaned up.');
console.log(res.status === 200 ? 'PASS: endpoint accepted and Resend sent' : 'FAIL: see status/body above');
process.exit(res.status === 200 ? 0 : 1);
