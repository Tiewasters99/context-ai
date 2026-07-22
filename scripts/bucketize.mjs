// Bucketizer batch classifier — classify a matter's ready documents into its
// case-theory tree (bucketizer_nodes), writing AI-proposed rows the attorney
// reviews in the app. The service-role twin of the in-app classifier: same
// prompts and schemas (lib/bucketizer-core.mjs), so the two paths can't drift.
//
// The tree must already exist (generate it in the app from the pleadings, or
// hand-build it). Documents that already have any classification rows are
// skipped, so the script is safe to re-run as discovery comes in.
//
// Usage:
//   node scripts/bucketize.mjs --matter fleming --dry-run
//   node scripts/bucketize.mjs --matter fleming --limit 5          (pilot)
//   node scripts/bucketize.mjs --matter fleming                    (full run)
//   node scripts/bucketize.mjs --matter fleming --batch            (Batch API, 50% cheaper;
//                                                                   results usually <1h)
//   node scripts/bucketize.mjs --matter fleming --concurrency 4
//   node scripts/bucketize.mjs --matter fleming --doc <uuid>       (one doc)
//
// Env (./.env): VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLASSIFY_TOOL_NAME,
  CLASSIFY_TOOL_DESCRIPTION,
  CLASSIFY_SCHEMA,
  CLASSIFY_SYSTEM,
  serializeOutline,
  buildClassifyUserContent,
  decodeAssignments,
} from '../lib/bucketizer-core.mjs';
import {
  generateStructuredAnthropic,
  buildStructuredParams,
  extractStructuredOutput,
  runStructuredBatch,
} from '../lib/structured-anthropic.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));
const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
const SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const args = parseArgs(process.argv.slice(2));
const DRY = !!args['dry-run'];
const ANTHROPIC_API_KEY = DRY ? (process.env.ANTHROPIC_API_KEY || '') : requireEnv('ANTHROPIC_API_KEY');
const LIMIT = args.limit ? parseInt(args.limit, 10) : Infinity;
const CONCURRENCY = args.concurrency ? Math.max(1, parseInt(args.concurrency, 10)) : 2;
const MODEL = args.model || 'claude-opus-4-8';
if (!args.matter) die('Missing --matter');

const matter = await resolveMatter(args.matter);
log(`Matter: ${matter.name} (${matter.id})  |  model: ${MODEL}`);

// The tree.
const { data: nodes, error: nodesErr } = await supabase
  .from('bucketizer_nodes')
  .select('id, parent_id, kind, label, description, position')
  .eq('matterspace_id', matter.id)
  .order('position');
if (nodesErr) die(`tree: ${nodesErr.message}`);
if (!nodes.length) die('No case-theory tree for this matter yet — generate one in the app (Bucketizer tab) first.');
const { outline, refToId } = serializeOutline(nodes);
log(`Tree: ${nodes.length} buckets`);

// Candidate documents: ready, not yet classified.
let candidates;
if (args.doc) {
  const { data, error } = await supabase.from('documents')
    .select('id, title, doc_type').eq('id', args.doc).single();
  if (error) die(`--doc: ${error.message}`);
  candidates = [data];
} else {
  const docs = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('documents')
      .select('id, title, doc_type')
      .eq('matterspace_id', matter.id)
      .eq('processing_status', 'ready')
      .order('id')
      .range(from, from + 999);
    if (error) die(error.message);
    docs.push(...data);
    if (data.length < 1000) break;
  }
  const classified = new Set();
  for (let i = 0; i < docs.length; i += 200) {
    const ids = docs.slice(i, i + 200).map((d) => d.id);
    const { data, error } = await supabase.from('bucketizer_classifications')
      .select('document_id').in('document_id', ids);
    if (error) die(error.message);
    for (const r of data) classified.add(r.document_id);
  }
  candidates = docs.filter((d) => !classified.has(d.id));
}
log(`Unclassified ready documents: ${candidates.length}${LIMIT < Infinity ? `  (running first ${LIMIT})` : ''}`);

if (DRY) {
  for (const d of candidates.slice(0, 30)) log(`  would classify: ${d.title}`);
  if (candidates.length > 30) log(`  ... and ${candidates.length - 30} more`);
  log('\n(--dry-run; nothing changed)');
  process.exit(0);
}

const queue = candidates.slice(0, LIMIT === Infinity ? undefined : LIMIT);
const summary = { done: 0, proposed: 0, skippedNoText: 0, failed: [] };

// Build the model request for one document, or null if it has no text.
async function buildDocRequest(doc) {
  const { data: passages, error } = await supabase.from('passages')
    .select('id, text')
    .eq('document_id', doc.id)
    .order('sequence_number')
    .range(0, 199);
  if (error) throw new Error(`passages: ${error.message}`);
  if (!passages.length) return null;

  const { userContent, refToPassageId } = buildClassifyUserContent(
    { title: doc.title, docType: doc.doc_type }, passages, outline,
  );
  const params = buildStructuredParams({
    model: MODEL,
    system: CLASSIFY_SYSTEM,
    userContent,
    toolName: CLASSIFY_TOOL_NAME,
    toolDescription: CLASSIFY_TOOL_DESCRIPTION,
    inputSchema: CLASSIFY_SCHEMA,
  });
  return { params, refToPassageId };
}

async function persistResult(doc, result, refToPassageId) {
  const rows = decodeAssignments(result, refToId, refToPassageId).map((r) => ({
    ...r,
    matterspace_id: matter.id,
    document_id: doc.id,
    status: 'proposed',
    model_id: MODEL,
  }));
  if (rows.length) {
    const { error: insErr } = await supabase.from('bucketizer_classifications')
      .upsert(rows, { onConflict: 'document_id,node_id', ignoreDuplicates: true });
    if (insErr) throw new Error(`insert: ${insErr.message}`);
  }
  summary.proposed += rows.length;
}

if (args.batch) {
  // -- Batch API mode: 50% of synchronous pricing; results usually within
  // -- the hour. Prepare every request (the passage fetches), submit in
  // -- chunks, poll, persist.
  log('Preparing batch requests…');
  const prepared = [];
  for (const doc of queue) {
    try {
      const req = await buildDocRequest(doc);
      if (!req) { summary.skippedNoText++; continue; }
      prepared.push({ doc, ...req });
    } catch (e) {
      summary.failed.push({ title: doc.title, error: e.message });
    }
    if ((prepared.length + summary.skippedNoText) % 100 === 0) {
      log(`  prepared ${prepared.length}/${queue.length}`);
    }
  }
  log(`Prepared ${prepared.length} requests (${summary.skippedNoText} no-text skipped).`);

  const CHUNK = 500; // stay well under the 256MB per-batch cap
  const byId = new Map(prepared.map((p) => [p.doc.id, p]));
  for (let i = 0; i < prepared.length; i += CHUNK) {
    const chunk = prepared.slice(i, i + CHUNK);
    log(`\nSubmitting batch ${Math.floor(i / CHUNK) + 1}/${Math.ceil(prepared.length / CHUNK)} (${chunk.length} docs)…`);
    const { batchId, results } = await runStructuredBatch({
      apiKey: ANTHROPIC_API_KEY,
      entries: chunk.map((p) => ({ customId: p.doc.id, params: p.params })),
      onProgress: (b) => log(`  [${b.id}] ${b.processing_status} — ${b.request_counts.processing} processing, ${b.request_counts.succeeded} ok, ${b.request_counts.errored} err`),
    });
    for (const r of results) {
      const p = byId.get(r.custom_id);
      if (!p) continue;
      if (r.result.type === 'succeeded') {
        try {
          await persistResult(p.doc, extractStructuredOutput(r.result.message), p.refToPassageId);
          summary.done++;
        } catch (e) {
          summary.failed.push({ title: p.doc.title, error: e.message });
        }
      } else {
        summary.failed.push({ title: p.doc.title, error: r.result.type });
      }
    }
    log(`  batch done — ${summary.done} classified so far`);
  }
} else {
  async function classifyOne(doc) {
    const req = await buildDocRequest(doc);
    if (!req) { summary.skippedNoText++; return; }
    const result = await generateStructuredAnthropic({
      apiKey: ANTHROPIC_API_KEY,
      model: MODEL,
      system: CLASSIFY_SYSTEM,
      userContent: req.params.messages[0].content,
      toolName: CLASSIFY_TOOL_NAME,
      toolDescription: CLASSIFY_TOOL_DESCRIPTION,
      inputSchema: CLASSIFY_SCHEMA,
    });
    await persistResult(doc, result, req.refToPassageId);
  }

  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= queue.length) return;
      const doc = queue[i];
      try {
        await classifyOne(doc);
        summary.done++;
        log(`  [${summary.done}/${queue.length}] ${doc.title}`);
      } catch (e) {
        summary.failed.push({ title: doc.title, error: e.message });
        log(`  ! ${doc.title}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
}

log(`\nDone. classified: ${summary.done}  |  proposals written: ${summary.proposed}  |  no-text skipped: ${summary.skippedNoText}  |  failed: ${summary.failed.length}`);
for (const f of summary.failed) log(`  failed: ${f.title} — ${f.error}`);

async function resolveMatter(key) {
  const isUuid = /^[0-9a-f-]{36}$/i.test(key);
  const { data, error } = await supabase.from('matterspaces').select('id, name, short_code').eq(isUuid ? 'id' : 'short_code', key).maybeSingle();
  if (error || !data) die(`matter '${key}': ${error?.message ?? 'not found'}`);
  return data;
}
function parseArgs(argv) { const out = { _: [] }; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2), v = argv[i + 1]; if (v && !v.startsWith('--')) { out[k] = v; i++; } else out[k] = true; } else out._.push(a); } return out; }
async function loadEnv(file) { try { const t = await fs.readFile(file, 'utf8'); for (const line of t.split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (!m) continue; let v = m[2]; if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1); if (!process.env[m[1]]) process.env[m[1]] = v.trim(); } } catch {} }
function requireEnv(n) { const v = process.env[n]; if (!v) die(`Missing env ${n}`); return v; }
function log(...a) { console.log(...a); }
function die(m) { console.error(m); process.exit(1); }
