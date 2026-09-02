// Generate an admin recovery link for quaintonlaw@gmail.com and show which
// redirect_to GoTrue actually accepted (reveals the allow-list state).
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';

const ENV = 'C:/Users/equai/context-ai/.env';
const text = await fs.readFile(ENV, 'utf8');
for (const line of text.split('\n')) {
  const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && !process.env[m[1]]) {
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
const sb = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data, error } = await sb.auth.admin.generateLink({
  type: 'recovery',
  email: 'quaintonlaw@gmail.com',
  options: { redirectTo: 'https://contextspaces.ai/auth/reset' },
});
if (error) { console.error('generateLink:', error.message); process.exit(1); }

const link = data.properties?.action_link || data.action_link;
const u = new URL(link);
console.log('requested redirect_to : https://contextspaces.ai/auth/reset');
console.log('accepted  redirect_to :', u.searchParams.get('redirect_to'));
console.log('');
console.log('ACTION LINK (classic verify redirect, one-time):');
console.log(link);
console.log('');
console.log('CONFIRM LINK (tests the new /auth/confirm route, one-time):');
console.log(`https://www.contextspaces.ai/auth/confirm?token_hash=${data.properties.hashed_token}&type=recovery`);
console.log('');
console.log('NOTE: generating a link invalidates all earlier recovery links/emails,');
console.log('and the two links above share ONE token - use one or the other.');
