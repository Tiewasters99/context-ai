// Create a new matterspace inside an existing serverspace.
//
// Usage:
//   node scripts/create-matter.mjs --serverspace <id_or_name> \
//     --name "Display Name" --short-code <slug> [--description "..."]
//
// Example:
//   node scripts/create-matter.mjs --serverspace "Quainton" \
//     --name "Quantum Physics History" --short-code quantum \
//     --description "Books and sources for the Opus + Eden quantum book project"
//
// Developer-only admin utility using service_role. The web UI doesn't have a
// matter-creation flow yet; this fills the gap so ingestion + MCP can target
// a fresh matter immediately.
//
// Env required (from ../.env):
//   VITE_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));

const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
const SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

const args = parseArgs(process.argv.slice(2));
if (!args.serverspace) die('Missing --serverspace <id_or_name>');
if (!args.name) die('Missing --name "<Display Name>"');
if (!args['short-code']) die('Missing --short-code <slug>');
if (!/^[a-z][a-z0-9_-]{0,63}$/.test(args['short-code'])) {
  die('--short-code must be lowercase letters/digits/_/-, starting with a letter');
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Resolve serverspace by id or name (case-insensitive)
let serverspace;
if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.serverspace)) {
  const { data, error } = await sb
    .from('serverspaces')
    .select('id, name')
    .eq('id', args.serverspace)
    .maybeSingle();
  if (error) die(`lookup serverspace: ${error.message}`);
  if (!data) die(`no serverspace with id ${args.serverspace}`);
  serverspace = data;
} else {
  const { data, error } = await sb
    .from('serverspaces')
    .select('id, name')
    .ilike('name', args.serverspace);
  if (error) die(`lookup serverspace: ${error.message}`);
  if (!data || data.length === 0) {
    die(`no serverspace with name ${JSON.stringify(args.serverspace)}`);
  }
  if (data.length > 1) {
    const ids = data.map((s) => `${s.id}: ${s.name}`).join('\n  ');
    die(`multiple serverspaces named ${JSON.stringify(args.serverspace)}:\n  ${ids}\nuse --serverspace <id> to disambiguate`);
  }
  serverspace = data[0];
}

// Check short_code isn't already taken
const { data: existing } = await sb
  .from('matterspaces')
  .select('id, name')
  .eq('short_code', args['short-code'])
  .maybeSingle();
if (existing) {
  die(`short_code '${args['short-code']}' already exists: ${existing.name} (${existing.id})`);
}

// Insert the matterspace
const { data: matter, error } = await sb
  .from('matterspaces')
  .insert({
    serverspace_id: serverspace.id,
    name: args.name,
    short_code: args['short-code'],
    description: args.description ?? null,
  })
  .select('id, name, short_code, description')
  .single();
if (error) die(`insert matterspace: ${error.message}`);

console.log(`Created matterspace`);
console.log(`  id:          ${matter.id}`);
console.log(`  name:        ${matter.name}`);
console.log(`  short_code:  ${matter.short_code}`);
console.log(`  serverspace: ${serverspace.name} (${serverspace.id})`);
if (matter.description) console.log(`  description: ${matter.description}`);
console.log();
console.log(`Next: ingest a document with`);
console.log(`  node scripts/ingest.mjs --matter ${matter.short_code} <file.pdf>`);


// -----------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
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
    } else {
      out._.push(a);
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
  if (!v) die(`Missing env: ${name}`);
  return v;
}

function die(msg) {
  process.stderr.write(`create-matter: ${msg}\n`);
  process.exit(1);
}
