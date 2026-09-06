// Prove the parked-endpoint HOLD for sealed embeddings (2026-09-06).
//
// The sealed route (voyage-4 on SageMaker in our own AWS account,
// lib/embed-routes.mjs) is switched OFF between sealed sessions to stop its
// hourly meter. While it is off the runtime answers 400 NO_SUCH_ENDPOINT.
// Until this fix the worker read that as an ordinary failure — three
// attempts, then 'error' — which is what the audit fixture hit on 09-05. Now:
//
//   ingest   → ready; text indexed and searchable by words; vectors null;
//              metadata.embedding_pending recorded; no attempts burned
//   search   → full text, with a note in the endpoint's own words
//   backfill → scripts/reembed-matter.mjs fills the vectors, clears the record
//
//   node scripts/_verify-embed-hold.mjs                          # offline: fetch stubbed, no network
//   node scripts/_verify-embed-hold.mjs --live <matter uuid>     # this checkout's lib against prod
//   node scripts/_verify-embed-hold.mjs --deployed <matter uuid> # through the queue: the Fly worker
//
// --live and --deployed file ONE fictional .txt into the given Tier-B matter
// (the SecureSpace audit fixture — never a client matter; the script refuses
// an unsealed matter), assert, and delete it. The real credentials are used:
// the text goes only to the SageMaker runtime in our own account, which
// answers NO_SUCH_ENDPOINT while parked. If the endpoint IS in service the
// document simply embeds — the live section says so and the hold is not
// exercised (exit 0, clearly labelled).
//
// Exit 0 = every check passed; 1 = a check failed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const mode = args.includes('--deployed') ? 'deployed' : args.includes('--live') ? 'live' : 'offline';
const matterId = args.find((a) => /^[0-9a-f-]{36}$/i.test(a)) || null;
if (mode !== 'offline' && !matterId) {
  console.error(`usage: node scripts/_verify-embed-hold.mjs --${mode} <sealed matter uuid>`);
  process.exit(2);
}

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

// The body the worker logged on 2026-09-05, verbatim shape (account id elided).
const PARKED_BODY = '{"ErrorCode":"NO_SUCH_ENDPOINT","Message":"Endpoint voyage-4-embed of account 123456789012 not found."}';
const OTHER_400 = '{"error":{"message":"Invalid \'input\': expected a list of strings","type":"invalid_request_error"}}';

// ---------------------------------------------------------------------------
// 1. Offline — the classifier, embedBatch and embedOne, with fetch stubbed
// ---------------------------------------------------------------------------
console.log('\n[1] offline: the route knows its parked state, and both embed paths type it');
const { ROUTES, isEmbedRouteUnavailable, EmbedRouteUnavailableError } = await import('../lib/embed-routes.mjs');
const { embedBatch } = await import('../lib/ingest-core.mjs');
const { embedOne } = await import('../lib/mcp-core.mjs');
const sage = ROUTES['voyage-4-sagemaker'];

const reason = sage.unavailable(400, PARKED_BODY, { env: { SAGEMAKER_VOYAGE_ENDPOINT: 'voyage-4-embed', AWS_REGION: 'us-east-1' } });
check(typeof reason === 'string' && /not in service/.test(reason) && /voyage-4-embed/.test(reason),
  'NO_SUCH_ENDPOINT → a reason in words', reason);
check(sage.unavailable(400, OTHER_400) === null, 'a different 400 is not "parked"');
check(sage.unavailable(500, PARKED_BODY) === null, 'a 5xx is never "parked" (that is an outage, retried as before)');
check(sage.unavailable(403, PARKED_BODY) === null, 'a 403 is never "parked" (that is a key problem)');
check(typeof ROUTES['openai-3-small'].unavailable !== 'function', 'the OpenAI route has no parked state — Tier A is unchanged');

const err = new EmbedRouteUnavailableError(sage, reason);
check(isEmbedRouteUnavailable(err) && err.route === 'voyage-4-sagemaker' && err.model === 'voyage-4',
  'EmbedRouteUnavailableError carries route + model and is recognised');
check(!isEmbedRouteUnavailable(new Error(reason)), 'a plain Error with the same text is NOT recognised (typed, not string-matched)');

// A signed request needs credentials to build; the stub never lets it leave.
const fakeEnv = { AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKEFAKE', AWS_SECRET_ACCESS_KEY: 'fake/secret', AWS_REGION: 'us-east-1', SAGEMAKER_VOYAGE_ENDPOINT: 'voyage-4-embed' };
const savedEnv = {};
for (const k of Object.keys(fakeEnv)) { savedEnv[k] = process.env[k]; if (!process.env[k] || process.env[k] === 'PASTE') process.env[k] = fakeEnv[k]; }
const realFetch = globalThis.fetch;
let calls = 0;
const stub = (status, body) => async () => { calls += 1; return new Response(body, { status, headers: { 'content-type': 'application/json' } }); };

globalThis.fetch = stub(400, PARKED_BODY);
let caught = null;
try { await embedBatch('unused', ['a fictional passage'], { route: sage, limiter: null }); } catch (e) { caught = e; }
check(isEmbedRouteUnavailable(caught), 'embedBatch throws the typed error on NO_SUCH_ENDPOINT', caught?.message?.slice(0, 80));
check(calls === 1, 'and does so after ONE call — no retry loop against a parked endpoint', `${calls} call(s)`);

globalThis.fetch = stub(400, OTHER_400); calls = 0; caught = null;
try { await embedBatch('unused', ['a fictional passage'], { route: sage, limiter: null }); } catch (e) { caught = e; }
check(caught && !isEmbedRouteUnavailable(caught) && /embed 400/.test(caught.message), 'a different 400 is still a plain, fast error');

globalThis.fetch = stub(400, PARKED_BODY); caught = null;
try { await embedOne('unused', 'a fictional query', sage); } catch (e) { caught = e; }
check(isEmbedRouteUnavailable(caught), 'embedOne (search) throws the typed error too');

globalThis.fetch = realFetch;
for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

if (mode === 'offline') finish();

// ---------------------------------------------------------------------------
// 2. Live — one fictional .txt through the real pipeline into a SEALED matter
// ---------------------------------------------------------------------------
const { createClient } = await import('@supabase/supabase-js');
const env = Object.fromEntries(
  fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }),
);
for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'SAGEMAKER_VOYAGE_ENDPOINT']) {
  if (env[k] && !process.env[k]) process.env[k] = env[k];
}
const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const { matterSeal } = await import('../lib/seal-pipes.mjs');
const { processDocument } = await import('../lib/ingest-core.mjs');
const { handleCheckIngestStatus, handleSearch } = await import('../lib/mcp-core.mjs');
const { routeReady } = await import('../lib/embed-routes.mjs');

// The SageMaker credentials live on Fly and Vercel, not necessarily in this
// checkout's .env. Without them --live would take the "route not configured"
// branch, which is the OLD sealed behaviour and proves nothing about the
// hold. So when the route is not configured here, --live SIMULATES the parked
// endpoint: fake credentials so the route resolves, and a fetch that answers
// runtime.sagemaker.* with the exact NO_SUCH_ENDPOINT body while every other
// request (Supabase) passes through untouched. Nothing reaches AWS. The real
// endpoint's absence is proved by --deployed, where the worker has the keys.
let simulated = false;
if (mode === 'live' && !routeReady(sage, process.env)) {
  simulated = true;
  Object.assign(process.env, fakeEnv);
  const passthrough = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (/runtime\.sagemaker\./.test(String(url))) {
      return new Response(PARKED_BODY, { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return passthrough(input, init);
  };
  console.log('\n  NOTE  sealed route not configured in this checkout\'s .env — SIMULATING the parked endpoint (runtime.sagemaker.* → 400 NO_SUCH_ENDPOINT, nothing reaches AWS). --deployed proves the real one.');
}

const seal = await matterSeal(supabase, matterId);
if (!seal.sealed) {
  console.error(`\nRefusing: matter ${matterId} is not sealed (tier ${seal.tier ?? '?'}). This proof only ever runs inside a Tier-B/C fixture.`);
  process.exit(2);
}
console.log(`\n[2] ${mode}${simulated ? ' (simulated parked endpoint)' : ''}: "${seal.name}" (Tier ${seal.tier}) — one fictional .txt, then cleanup`);

const tag = crypto.randomUUID().slice(0, 8);
const marker = `zephyrquill${tag}`;
const text = [
  `Fictional memorandum ${tag} — SecureSpace embedding hold proof.`,
  `The parties agreed that the ${marker} clause governs delivery of the marmalade shipment.`,
  'Nothing in this file refers to any real person, matter, or client. It exists to be indexed and deleted.',
].join('\n\n');
const bytes = Buffer.from(text, 'utf8');
const filename = `embed-hold-${tag}.txt`;

const { data: owner } = await supabase.from('documents').select('created_by').not('created_by', 'is', null)
  .order('created_at', { ascending: false }).limit(1);
const createdBy = process.env.SMOKE_CREATED_BY || owner?.[0]?.created_by;
if (!createdBy) { console.error('no created_by to borrow — set SMOKE_CREATED_BY'); process.exit(2); }

const { data: row, error: insErr } = await supabase.from('documents').insert({
  matterspace_id: matterId, title: `Embed hold proof ${tag}`, doc_type: 'other', source_filename: filename,
  file_size_bytes: bytes.length, processing_status: 'pending', created_by: createdBy,
}).select('id').single();
if (insErr) { console.error(`insert: ${insErr.message}`); process.exit(2); }
const docId = row.id;
const storagePath = `${matterId}/${docId}/${filename}`;

try {
  const { error: upErr } = await supabase.storage.from('vault-documents').upload(storagePath, bytes, { contentType: 'text/plain', upsert: true });
  if (upErr) throw new Error(`upload: ${upErr.message}`);
  await supabase.from('documents').update({ storage_path: storagePath }).eq('id', docId);

  let result = null;
  if (mode === 'live') {
    result = await processDocument(supabase, {
      documentId: docId, fileBuf: bytes, ext: '.txt', openaiApiKey: env.OPENAI_API_KEY,
      onProgress: ({ stage, message }) => console.log(`       ${stage.padEnd(10)} ${message.slice(0, 160)}`),
    });
  } else {
    const { error: qErr } = await supabase.from('processing_jobs').insert({
      matterspace_id: matterId, job_type: 'ingest_document', payload: { document_id: docId },
    });
    if (qErr) throw new Error(`enqueue: ${qErr.message}`);
    const t0 = Date.now();
    let last = '';
    for (;;) {
      const { data: d } = await supabase.from('documents').select('processing_status, processing_error').eq('id', docId).maybeSingle();
      const line = `${d?.processing_status}${d?.processing_error ? ' | ' + d.processing_error.slice(0, 120) : ''}`;
      if (line !== last) { console.log(`       ${new Date().toISOString().slice(11, 19)} ${line}`); last = line; }
      if (d && (d.processing_status === 'ready' || d.processing_status === 'error' || d.processing_status === 'held')) break;
      if (Date.now() - t0 > 5 * 60_000) throw new Error('timeout waiting for the worker (5 min)');
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  const { data: doc } = await supabase.from('documents')
    .select('processing_status, processing_error, metadata').eq('id', docId).single();
  const { data: passages } = await supabase.from('passages')
    .select('id, embedding, embedding_model, text').eq('document_id', docId);
  const n = passages?.length ?? 0;
  const pending = doc?.metadata?.embedding_pending ?? null;

  if (doc?.processing_status === 'ready' && !pending && n > 0 && passages.every((p) => p.embedding)) {
    console.log('\n  NOTE  the sealed endpoint is IN SERVICE: the document embedded normally, so the hold was not exercised.');
    check(passages.every((p) => p.embedding_model === 'voyage-4'), 'vectors are in the voyage-4 space');
  } else {
    check(doc?.processing_status === 'ready', 'document is ready (not error, not held)', `${doc?.processing_status}${doc?.processing_error ? ' | ' + doc.processing_error.slice(0, 100) : ''}`);
    check(!doc?.processing_error, 'no processing_error on the row');
    check(n > 0, 'passages were indexed', `${n} passage(s)`);
    check(n > 0 && passages.every((p) => p.embedding === null), 'every passage has a NULL vector — nothing embedded');
    check(n > 0 && passages.every((p) => p.embedding_model === 'voyage-4'), 'rows are stamped with the space they will join (voyage-4)');
    check(pending && pending.route === 'voyage-4-sagemaker' && pending.model === 'voyage-4' && Number(pending.passages) === n,
      'metadata.embedding_pending names the route, the model and the passages owed', JSON.stringify(pending)?.slice(0, 160));
    check(pending && /not in service/.test(String(pending.reason)), 'and the reason is the endpoint\'s answer, in words');
    if (mode === 'live') {
      check(result && result.embedded === false && result.embeddingPending?.route === 'voyage-4-sagemaker',
        'processDocument reports embedded:false + embeddingPending');
    } else {
      const { data: jobs } = await supabase.from('processing_jobs').select('status, attempts, error')
        .eq('job_type', 'ingest_document').contains('payload', { document_id: docId }).order('created_at', { ascending: false }).limit(1);
      const job = jobs?.[0];
      check(job && job.status === 'done' && Number(job.attempts ?? 1) <= 1, 'the worker finished the job in ONE attempt', JSON.stringify(job));
    }

    // The MCP status says it in words.
    const st = await handleCheckIngestStatus(supabase, { document_id: docId });
    check(st?.embedding_pending && st.searchable === true && st.semantic_search === false && /awaiting sealed embeddings/.test(st.note || ''),
      'check_ingest_status: searchable by words, semantic_search:false, note says vectors are owed', (st?.note || '').slice(0, 120));

    // Search still finds it, on words, with the endpoint's note.
    const found = await handleSearch(supabase, { q: marker, matter: matterId, limit: 5 }, {});
    const hits = Array.isArray(found?.results) ? found.results : [];
    const hit = hits.some((h) => JSON.stringify(h).includes(marker));
    const noteText = String(found?.note ?? '');
    check(hit, 'sealed search finds the passage by its words', `${hits.length} hit(s)`);
    check(/not in service/.test(noteText), 'and the search note says the endpoint is not in service', noteText.slice(0, 140));
  }
} catch (e) {
  check(false, `${mode} section threw`, e.message);
} finally {
  await supabase.from('passages').delete().eq('document_id', docId);
  await supabase.from('processing_jobs').delete().eq('job_type', 'ingest_document').contains('payload', { document_id: docId });
  await supabase.from('documents').delete().eq('id', docId);
  await supabase.storage.from('vault-documents').remove([storagePath]);
  console.log('\n  cleanup: document, passages, job and storage object removed');
}

finish();

function finish() {
  console.log(failures ? `\nFAIL — ${failures} check(s) failed` : '\nPASS');
  process.exit(failures ? 1 : 0);
}
