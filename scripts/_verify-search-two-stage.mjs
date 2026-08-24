// Read-only proof that search_passages actually returns, and returns the same
// shape, on the matters that broke it (2026-08-22 ingestion audit, fix 3).
//
// Run it BEFORE applying migration 056 and it fails: Fleming — 100,723
// passages, the largest body of text in the practice — cannot be searched at
// all. Migration 012's function computes a 1024-dimension cosine for every
// passage in scope and orders by a blended expression, so neither the HNSW nor
// the GIN index can be used, and the 8-second statement timeout arrives first.
//
// Run it AFTER applying 056 and the same call answers from two indexed
// candidate queries. Same RPC, same arguments, same fifteen result columns —
// which is the other half of what this checks, because lib/mcp-core.mjs, the
// app and the Orchestrator all bind to that shape.
//
//   node scripts/_verify-search-two-stage.mjs
//   node scripts/_verify-search-two-stage.mjs --matter fleming --q "excessive force"
//   node scripts/_verify-search-two-stage.mjs --matter fleming --matter webster --budget 4000
//
// Reads only: matterspaces, a passage HEAD count, and the search_passages RPC.
// It writes nothing, requeues nothing and touches no storage. Safe on prod at
// any time.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '..', '.env');
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SB = env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI = env.OPENAI_API_KEY;
if (!SB || !KEY) { console.error('VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required'); process.exit(2); }

// ---------------------------------------------------------------------------
const args = { matter: [], q: 'excessive force during the arrest', limit: 5, budget: 5000 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--matter') args.matter.push(process.argv[++i]);
  else if (a === '--q') args.q = process.argv[++i];
  else if (a === '--limit') args.limit = Number(process.argv[++i]);
  else if (a === '--budget') args.budget = Number(process.argv[++i]);
}
if (args.matter.length === 0) args.matter = ['fleming', 'ai-personhood'];

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.log(`  FAIL  ${m}`); failures += 1; };

async function rest(qs, { head = false, count = null } = {}) {
  const h = { ...H };
  if (count) h.Prefer = `count=${count}`;
  const r = await fetch(`${SB}/rest/v1/${qs}`, { method: head ? 'HEAD' : 'GET', headers: h });
  const cr = r.headers.get('content-range');
  return { status: r.status, total: cr ? Number(cr.split('/')[1]) : null, body: head ? null : await r.json().catch(() => null) };
}

async function rpc(name, body) {
  const t = Date.now();
  const r = await fetch(`${SB}/rest/v1/rpc/${name}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const raw = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, ms: Date.now() - t, body: parsed, raw };
}

// A real query embedding when a key is present, so the ANN stage is exercised
// with a vector that has real neighbours. Otherwise a deterministic unit
// vector — the plan under test is the same either way.
async function queryEmbedding(q) {
  if (OPENAI) {
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { authorization: `Bearer ${OPENAI}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', dimensions: 1024, input: q }),
    });
    if (r.ok) return (await r.json()).data[0].embedding;
    console.log(`  note  embeddings API said ${r.status}; falling back to a synthetic vector`);
  }
  let seed = 20260822;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  const v = Array.from({ length: 1024 }, rnd);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

const SHAPE = [
  'passage_id', 'document_id', 'document_title', 'doc_type',
  'page_start', 'page_end', 'line_start', 'line_end',
  'witness_name', 'examination_type', 'passage_type', 'text',
  'hybrid_score', 'text_rank', 'vector_score',
];

function checkShape(rows, label) {
  if (!Array.isArray(rows) || rows.length === 0) { fail(`${label}: no rows to check the shape of`); return; }
  const keys = Object.keys(rows[0]).sort();
  const want = [...SHAPE].sort();
  if (JSON.stringify(keys) !== JSON.stringify(want)) {
    fail(`${label}: result columns changed\n        got  ${keys.join(',')}\n        want ${want.join(',')}`);
    return;
  }
  let ordered = true;
  let blended = true;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const expect = 0.4 * (r.text_rank ?? 0) + 0.6 * (r.vector_score ?? 0);
    if (Math.abs(expect - (r.hybrid_score ?? 0)) > 1e-4) blended = false;
    if (i > 0 && rows[i - 1].hybrid_score < r.hybrid_score - 1e-6) ordered = false;
  }
  if (!blended) fail(`${label}: hybrid_score is no longer 0.4*text_rank + 0.6*vector_score`);
  if (!ordered) fail(`${label}: rows are not ordered by hybrid_score descending`);
  const ids = new Set(rows.map((r) => r.passage_id));
  if (ids.size !== rows.length) fail(`${label}: duplicate passages in the result set`);
  if (blended && ordered && ids.size === rows.length) pass(`${label}: 15 columns, blended score, descending, no duplicates`);
}

// ---------------------------------------------------------------------------
console.log(`search_passages verification — query "${args.q}", limit ${args.limit}, budget ${args.budget}ms\n`);
const emb = await queryEmbedding(args.q);

for (const short of args.matter) {
  const m = await rest(`matterspaces?select=id,name,short_code&short_code=eq.${encodeURIComponent(short)}&limit=1`);
  const matter = m.body?.[0];
  if (!matter) { fail(`matter "${short}" not found`); continue; }

  const desc = await rpc('matterspace_descendants', { p_root: matter.id });
  const ids = (Array.isArray(desc.body) ? desc.body : []).map((r) => r.id);
  const scope = ids.length ? ids : [matter.id];
  const cnt = await rest(
    `passages?select=id&matterspace_id=in.(${scope.join(',')})&summary_level=eq.0&limit=0`,
    { count: 'exact' },
  );

  console.log(`\n${matter.name} (${short}) — ${scope.length} matter(s) in scope, ${cnt.total ?? '?'} passages`);

  const base = {
    p_matterspace_ids: scope,
    p_doc_types: null,
    p_witness_names: null,
    p_document_ids: null,
    p_summary_level: 0,
    p_limit: args.limit,
  };

  const cases = [
    ['hybrid (text + vector)', { ...base, p_query_text: args.q, p_query_embedding: emb }],
    ['text only',              { ...base, p_query_text: args.q, p_query_embedding: null }],
    ['vector only',            { ...base, p_query_text: '',     p_query_embedding: emb }],
  ];

  for (const [label, body] of cases) {
    const r = await rpc('search_passages', body);
    if (r.status !== 200) {
      const msg = typeof r.body === 'object' ? JSON.stringify(r.body).slice(0, 200) : String(r.raw).slice(0, 200);
      fail(`${label}: HTTP ${r.status} after ${r.ms}ms — ${msg}`);
      continue;
    }
    const rows = r.body ?? [];
    console.log(`        ${label}: ${rows.length} rows in ${r.ms}ms`);
    if (r.ms > args.budget) fail(`${label}: ${r.ms}ms exceeds the ${args.budget}ms budget`);
    else pass(`${label}: answered in ${r.ms}ms`);
    if (label === 'hybrid (text + vector)') {
      if (rows.length === 0) fail(`${label}: returned no results at all`);
      checkShape(rows, label);
    }
  }
}

console.log(failures === 0
  ? '\nAll checks passed.'
  : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
