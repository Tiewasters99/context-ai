// Bring a matter's vectors into the space its tier currently permits.
//
// Why this exists
// ---------------------------------------------------------------------------
// A matter's embedding space is a consequence of its SecureSpace tier, and a
// tier can change. Three situations leave a matter with vectors that no longer
// match the route it is entitled to:
//
//   1. Sealed under Phase A. Its passages were stored with NULL embeddings —
//      searchable by text, invisible to meaning-based retrieval. When a
//      zero-retention route is permitted for its tier, those nulls should be
//      filled.
//
//   2. Unsealed again. A matter that was sealed and is now Tier A can use the
//      normal provider, but its passages are still null from step 1.
//
//   3. Re-tiered from A to B. Its passages hold OpenAI vectors, which the
//      sealed route may not extend and must not be compared against. Those
//      rows need re-embedding into the sealed space — and, until they are,
//      migration 061 makes them behave correctly rather than badly: they are
//      still found by text, they simply score 0 on vector.
//
// That last point is what makes this script a background chore rather than an
// emergency. Nothing is broken while it has not run; the matter is merely
// searching on words instead of meaning. Run it when convenient, interrupt it
// freely, run it again — it is idempotent and resumable by construction,
// because "needs re-embedding" is a query, not a checklist.
//
// It UPDATES rows in place rather than inserting new ones. One passage row is
// one chunk of text with whatever vector currently applies to it; a second row
// per model would duplicate every hit in full-text search, which after 061 is
// model-agnostic.
//
//   node scripts/reembed-matter.mjs --matter fleming
//   node scripts/reembed-matter.mjs --matter fleming --dry-run
//   node scripts/reembed-matter.mjs --matter fleming --limit 500
//
// Service role: RLS-independent, so it sees the whole tree. Never point it at
// a matter you do not intend to send to that matter's provider.

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { embedBatch } from '../lib/ingest-core.mjs';
import { resolveRoute } from '../lib/embed-routes.mjs';
import { matterTierWithClient } from '../lib/ai-tier-policy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));

const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
const SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const args = parseArgs(process.argv.slice(2));
if (!args.matter) die('Usage: node scripts/reembed-matter.mjs --matter <short_code|uuid> [--dry-run] [--limit N]');
const dryRun = args['dry-run'] === true || args['dry-run'] === 'true';
const limit = args.limit ? Number(args.limit) : Infinity;

// -- 1. The matter, its tree, and the tier that governs all of it ------------
const matter = await resolveMatter(args.matter);
const { data: descRows, error: descErr } = await supabase
  .rpc('matterspace_descendants', { p_root: matter.id });
if (descErr) die(`matter scope: ${descErr.message}`);
const scope = (descRows ?? []).map((r) => r.id);
if (scope.length === 0) scope.push(matter.id);

const tier = await matterTierWithClient(supabase, matter.id);
const { route, key, reason } = resolveRoute(tier);

log(`Matter "${matter.name}" (${matter.short_code}) — tier ${tier}, ${scope.length} matter(s) in scope`);

if (!route) {
  log(`\n${reason}`);
  log('Nothing to do: this tier embeds nothing by policy, and its passages are');
  log('searched on full text alone. That is the sealed state, not a failure.');
  process.exit(0);
}
log(`Target space: ${route.model} (${route.provider})`);

// -- 2. What is out of space -------------------------------------------------
// "Needs re-embedding" = no vector at all, or a vector from another model.
// PostgREST caps every response at 1,000 rows, so page — and page by id rather
// than offset, because the set shrinks underneath us as we fix it.
async function* outOfSpacePassages() {
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const { data, error } = await supabase
      .from('passages')
      .select('id, text, embedding_model')
      .in('matterspace_id', scope)
      .eq('summary_level', 0)
      .or(`embedding.is.null,embedding_model.neq.${route.model}`)
      .gt('id', after)
      .order('id', { ascending: true })
      .limit(500);
    if (error) die(`scan passages: ${error.message}`);
    if (!data || data.length === 0) return;
    for (const row of data) yield row;
    after = data[data.length - 1].id;
    if (data.length < 500) return;
  }
}

// -- 3. Count first, so the operator knows the size of what they started ------
const { count, error: countErr } = await supabase
  .from('passages')
  .select('id', { count: 'exact', head: true })
  .in('matterspace_id', scope)
  .eq('summary_level', 0)
  .or(`embedding.is.null,embedding_model.neq.${route.model}`);
if (countErr) die(`count: ${countErr.message}`);

if (!count) {
  log('\nEvery passage in this matter is already in the right space. Nothing to do.');
  process.exit(0);
}
const target = Math.min(count, limit);
log(`\n${count} passage(s) are out of space${limit < count ? ` — re-embedding the first ${target}` : ''}.`);
if (dryRun) {
  log('--dry-run: stopping before sending anything to the provider.');
  process.exit(0);
}

// -- 4. Re-embed, in the same batch size ingestion uses ---------------------
let done = 0;
let batchNo = 0;
let pending = [];

const flush = async () => {
  if (pending.length === 0) return;
  batchNo += 1;
  const vectors = await embedBatch(key, pending.map((p) => p.text), { route });
  // One UPDATE per row: the vector differs per row, so there is nothing to
  // batch. These are small, indexed by primary key, and interruptible.
  for (let i = 0; i < pending.length; i++) {
    const { error } = await supabase
      .from('passages')
      .update({ embedding: vectors[i], embedding_model: route.model })
      .eq('id', pending[i].id);
    if (error) die(`update passage ${pending[i].id}: ${error.message}`);
  }
  done += pending.length;
  log(`  batch ${batchNo}: ${done}/${target} re-embedded`);
  pending = [];
};

for await (const row of outOfSpacePassages()) {
  if (done + pending.length >= target) break;
  pending.push(row);
  // The same per-request count bound ingestion uses. No token accounting is
  // needed here: if the estimate is ever wrong, embedBatch reads the API's own
  // 'request too large' verdict and halves the batch itself.
  if (pending.length >= 96) await flush();
}
await flush();

log(`\nDone. ${done} passage(s) now in ${route.model}.`);
const { count: remaining } = await supabase
  .from('passages')
  .select('id', { count: 'exact', head: true })
  .in('matterspace_id', scope)
  .eq('summary_level', 0)
  .or(`embedding.is.null,embedding_model.neq.${route.model}`);
if (remaining) log(`${remaining} still out of space — re-run to continue.`);

// ---------------------------------------------------------------------------
async function resolveMatter(key_) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key_);
  const { data, error } = await supabase
    .from('matterspaces')
    .select('id, name, short_code')
    .eq(isUuid ? 'id' : 'short_code', key_)
    .maybeSingle();
  if (error) die(`resolve matter: ${error.message}`);
  if (!data) die(`No matterspace '${key_}'.`);
  return data;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    out[k] = v;
  }
  return out;
}

async function loadEnv(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) die(`Missing ${name} in .env`);
  return v;
}

function log(msg) { console.log(msg); }
function die(msg) { console.error(msg); process.exit(1); }
