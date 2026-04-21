// Admin utility: set or reset a user's password directly via Supabase Auth
// admin API. Used when email-based forgot-password isn't available yet.
//
// Usage (recommended — password via env var, no CLI history exposure):
//   NEWPASS='MyNewPassword123' node scripts/set-password.mjs --user-email equainton@gmail.com
//
// After running, remove the command from shell history:
//   history -d $(history 1 | awk '{print $1}')
//
// Requires SUPABASE_SERVICE_ROLE_KEY in ../.env.

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));

const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
const SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

const args = parseArgs(process.argv.slice(2));
if (!args['user-email']) die('usage: NEWPASS=... node scripts/set-password.mjs --user-email <email>');

const password = process.env.NEWPASS;
if (!password) die('set the NEWPASS environment variable to your desired password');
if (password.length < 8) die('password must be at least 8 characters');

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: list, error: listErr } = await sb.auth.admin.listUsers();
if (listErr) die(`lookup: ${listErr.message}`);
const user = list.users.find((u) => u.email?.toLowerCase() === args['user-email'].toLowerCase());
if (!user) die(`no user with email ${args['user-email']}`);

const { error: updateErr } = await sb.auth.admin.updateUserById(user.id, { password });
if (updateErr) die(`update failed: ${updateErr.message}`);

console.log(`Password set for ${user.email} (${user.id}).`);
console.log('Sign in at https://www.contextspaces.ai/auth with this email + your new password.');


// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true;
      else { out[k] = next; i++; }
    }
  }
  return out;
}

async function loadEnv(envPath) {
  try {
    const text = await fs.readFile(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = val;
    }
  } catch {}
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) die(`missing env: ${name}`);
  return v;
}

function die(msg) {
  process.stderr.write(`set-password: ${msg}\n`);
  process.exit(1);
}
