// Read and triage the Orchestrator's early-adopter feedback queue.
//
// The in-app assistant captures product feedback into public.orchestrator_feedback
// (see migration 031 + lib/assistant-core.mjs `relay_feedback`). This is the
// owner-side sweep: list what's come in, then mark rows as you act on them. Run
// it on demand, or wire it to a daily schedule so feedback turns into fixes fast.
//
// Usage:
//   node scripts/orchestrator-feedback.mjs                 # list new feedback
//   node scripts/orchestrator-feedback.mjs --all           # every row, any status
//   node scripts/orchestrator-feedback.mjs --status triaged
//   node scripts/orchestrator-feedback.mjs --triage <id> shipped
//                                                          # set one row's status
//   node scripts/orchestrator-feedback.mjs --json          # machine-readable
//
// Statuses: new | triaged | shipped | declined
//
// Developer-only admin utility using service_role (bypasses RLS to see the whole
// queue). Env required (from ../.env): VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));

const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
const SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const STATUSES = ['new', 'triaged', 'shipped', 'declined'];

const args = parseArgs(process.argv.slice(2));

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// --triage <id> <status>: update one row, then exit.
if (args.triage) {
  const id = args.triage === true ? args._[0] : args.triage;
  const status = args.triage === true ? args._[1] : args._[0];
  if (!id || !status) die('Usage: --triage <id> <status>');
  if (!STATUSES.includes(status)) die(`status must be one of: ${STATUSES.join(', ')}`);
  const { data, error } = await sb
    .from('orchestrator_feedback')
    .update({ status })
    .eq('id', id)
    .select('id, status')
    .maybeSingle();
  if (error) die(`update: ${error.message}`);
  if (!data) die(`no feedback row with id ${id}`);
  console.log(`Marked ${data.id} → ${data.status}`);
  process.exit(0);
}

// Otherwise: list.
let query = sb
  .from('orchestrator_feedback')
  .select('id, body, category, route, tab, matter_name, status, created_at')
  .order('created_at', { ascending: false });

if (!args.all) {
  const status = typeof args.status === 'string' ? args.status : 'new';
  if (!STATUSES.includes(status)) die(`--status must be one of: ${STATUSES.join(', ')}`);
  query = query.eq('status', status);
}

const { data: rows, error } = await query;
if (error) die(`query: ${error.message}`);

if (args.json) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

if (!rows || rows.length === 0) {
  console.log(args.all ? 'No feedback yet.' : `No ${args.status || 'new'} feedback.`);
  process.exit(0);
}

console.log(`${rows.length} item(s):\n`);
for (const r of rows) {
  const where = [r.matter_name && `matter: ${r.matter_name}`, r.tab && `tab: ${r.tab}`, r.route]
    .filter(Boolean)
    .join(' · ');
  console.log(`  [${r.category}] ${r.body}`);
  console.log(`    ${r.id}  ${r.status}  ${r.created_at}${where ? `\n    ${where}` : ''}\n`);
}
console.log(`Triage: node scripts/orchestrator-feedback.mjs --triage <id> <${STATUSES.join('|')}>`);


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
  process.stderr.write(`orchestrator-feedback: ${msg}\n`);
  process.exit(1);
}
