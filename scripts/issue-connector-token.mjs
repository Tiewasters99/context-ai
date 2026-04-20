// Issue a new connector_tokens row for a user.
//
// Usage:
//   node scripts/issue-connector-token.mjs --user-email <email> [--name "..."] [--expires-in <days>]
//   node scripts/issue-connector-token.mjs --user-id <uuid>    [--name "..."] [--expires-in <days>]
//
// Prints the opaque token exactly once. Store it immediately — it is never
// recoverable from the database (only its SHA-256 hash is stored). If you
// lose the token, revoke the row and issue a new one.
//
// This is a developer-only admin utility using service_role. The Contextspaces
// web UI will replace it with a user-facing "Connect to Claude" page in Phase 1b.
//
// Env required (from ../.env):
//   VITE_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));

const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
const SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

const args = parseArgs(process.argv.slice(2));

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Resolve target user
let user_id;
if (args['user-id']) {
  user_id = args['user-id'];
} else if (args['user-email']) {
  const { data, error } = await sb
    .from('profiles')
    .select('id')
    .eq('email', args['user-email'])
    .maybeSingle();
  if (error) die(`lookup: ${error.message}`);
  if (!data) die(`no profile with email ${args['user-email']}`);
  user_id = data.id;
} else {
  die('specify --user-email <email> or --user-id <uuid>');
}

// Mint opaque token: csp_ + 32 bytes base64url (≈43 chars) → ~47 char total
const secret = randomBytes(32).toString('base64url');
const token = `csp_${secret}`;
const tokenHash = createHash('sha256').update(token).digest('hex');
const tokenPrefix = token.slice(0, 16);

// Optional expiry
let expires_at = null;
if (args['expires-in']) {
  const days = parseInt(args['expires-in'], 10);
  if (!Number.isFinite(days) || days < 1) die('--expires-in must be a positive integer (days)');
  expires_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

const { data: row, error } = await sb
  .from('connector_tokens')
  .insert({
    user_id,
    token_hash: tokenHash,
    token_prefix: tokenPrefix,
    name: args.name || 'Unnamed connector',
    expires_at,
  })
  .select('id, created_at, expires_at')
  .single();
if (error) die(`insert: ${error.message}`);

// One-time display. User MUST copy now.
process.stdout.write(
  '\nConnector token issued. Copy this exactly — it will not be shown again:\n\n' +
  `  ${token}\n\n` +
  `  row id:     ${row.id}\n` +
  `  user_id:    ${user_id}\n` +
  `  name:       ${args.name || 'Unnamed connector'}\n` +
  `  created_at: ${row.created_at}\n` +
  `  expires_at: ${row.expires_at || 'never'}\n` +
  '\nTo revoke later, update connector_tokens set revoked_at = now() where id = ' +
  `'${row.id}'.\n`
);


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
      if (next === undefined || next.startsWith('--')) {
        out[k] = true;
      } else {
        out[k] = next;
        i++;
      }
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
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
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
  process.stderr.write(`issue-connector-token: ${msg}\n`);
  process.exit(1);
}
