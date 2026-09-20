// Grapheon Discovery — LIVE end-to-end test against the real Supabase project.
//
// ⚠ NOT RUN as part of the change that last edited it (2026-09-20). This file
//   was brought up to today's worker contract and left UNRUN on purpose: it
//   writes to the production database with the service role. The offline
//   equivalent — real migrations in PGlite, real lib/discovery, stubbed
//   storage — is `node scripts/_verify-discovery-pipeline.mjs`, and it is what
//   CI runs. Read "HOW TO RUN THIS SAFELY" below before the first live run.
//
// What it proves that the offline harness cannot
// ---------------------------------------------------------------------------
//   * that the DEPLOYED worker (two Fly machines) still claims and completes
//     Discovery's job types after 044/045/055/057/058/059/060;
//   * that Supabase Storage, the discovery-files bucket policies and the signed
//     download actually work;
//   * that lib/ingest-core.mjs's processDocument still indexes a production's
//     display PDFs into the matter corpus.
//
// HOW TO RUN THIS SAFELY
// ---------------------------------------------------------------------------
//   node worker/e2e-live-test.mjs --plan          # prints the procedure, touches nothing
//   node worker/e2e-live-test.mjs                 # DEFAULT: through the deployed worker
//   node worker/e2e-live-test.mjs --local-worker  # drive an UNDEPLOYED checkout instead
//
// Default (queue) mode is the one to use. It uploads the fixtures to
// discovery-files exactly as the browser does, enqueues intake_files, and then
// POLLS each job to a terminal status. It never spawns a worker, so it tests
// what is actually deployed and it cannot race a Fly machine for its own job.
//
// --local-worker reproduces the original 2026-06 behaviour (`--intake` then
// `--once`) for testing a branch that is not deployed yet. Two hazards, both
// created by migrations that landed after this file was written:
//
//   1. `--once` drains the WHOLE queue, every tenant's jobs, using this
//      checkout's code and this machine's .env keys. On a branch that changes
//      ingestion, that means strangers' documents are processed by unreviewed
//      code. Only ever do this knowing the queue is empty.
//   2. (CLOSED 2026-09-20, migration 071 + worker.) `--intake` used to insert
//      its job as status 'running' outside withHeartbeat, so one slow file let
//      044's reaper requeue it and a Fly machine then claimed an intake_folder
//      job whose payload.local_path exists only on this laptop. It now runs
//      under withHeartbeat and carries requires_worker = this machine's
//      WORKER_ID, which no other worker's claim will take. Verify with:
//        select requires_worker, status from processing_jobs
//         where job_type = 'intake_folder' order by created_at desc limit 1;
//
// WHAT A PASS DOES *NOT* PROVE
// ---------------------------------------------------------------------------
// Queue mode drives the worker that is DEPLOYED on Fly. Worker-side code —
// everything under lib/discovery/ and worker/ — only reaches production through
// `flyctl deploy`, never through a Vercel merge. So a green run here says the
// deployed image works; it says nothing about a fix sitting on main and not yet
// deployed. The fixtures below are all ASCII, which in particular means this
// test would have passed both before and after the 2026-09-20 WinAnsi fix in
// lib/discovery/bates-stamp.mjs. `scripts/_verify-discovery-pipeline.mjs` is
// what covers that, against the checkout rather than the deployment.
//
// WHAT IT LEAVES BEHIND, permanently
// ---------------------------------------------------------------------------
// Every run consumes Bates numbers in the sandbox matter and they can never be
// reused: bates_registry is unique on (matterspace_id, bates_number) and its
// production/item references are ON DELETE RESTRICT (migration 030:167-177),
// which is the malpractice guard, not a bug. --cleanup removes the storage
// objects, the corpus documents and the job rows; it deliberately does NOT
// touch bates_registry, productions or production_items.
//
// Everything lands in the sandbox matter (short_code disc-sandbox) inside the
// serverspace named by DISCOVERY_E2E_SERVERSPACE. There is no `limit(1)` guess
// at which tenant to use.

import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { loadEnv } from '../lib/discovery/util.mjs';
import { parseDat, canonicalizeDatRecord } from '../lib/discovery/loadfile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const LOCAL_WORKER = flag('local-worker');
const CLEANUP = flag('cleanup');
const JOB_TIMEOUT_MS = Number(process.env.E2E_JOB_TIMEOUT_MINUTES ?? 20) * 60_000;

const PLAN = `
Discovery live E2E — the procedure
==================================================================

WHO CAN RUN IT   Anyone with context-ai/.env holding a live
                 SUPABASE_SERVICE_ROLE_KEY. OPENAI_API_KEY is optional; without
                 it the corpus-ingestion checks SKIP rather than fail.

BEFORE           0. Migration 071 must be applied, and the Fly worker must be
                    redeployed from a checkout that has it. The stamp path's
                    FIRST write is allocate_production_bates(); against a
                    database without 071 the job errors immediately with
                    "function does not exist" — having spent no Bates number,
                    which is the point, but the run tells you nothing.
                 1. Set DISCOVERY_E2E_SERVERSPACE to the name of YOUR
                    serverspace. The test refuses to guess.
                 2. Confirm the Fly workers are up and the queue is short:
                       select status, count(*) from processing_jobs
                        where status in ('queued','running') group by 1;
                    A long queue only makes the test slower; it is not unsafe.

WHAT IT WRITES   In the sandbox matter 'Discovery Sandbox' (disc-sandbox),
                 created on first run inside your serverspace:
                   - 1 productions row + 6 production_items
                   - 1 production_bates_allocations row (071)
                   - 7 bates_registry rows (PERMANENT — see below)
                   - up to 4 documents + their passages in that matter's corpus
                   - 4 document_tag_defs, 4 document_tags, 2 privilege_log_entries
                   - ~4 processing_jobs rows
                   - objects under discovery-files/<matter>/<production>/
                   - 1 deliveries row
                 It writes NOTHING outside that matter. It never deletes or
                 modifies another tenant's rows.

HOW LONG         5-12 minutes in queue mode: three round trips through the
                 shared worker, each waiting for whichever Fly machine is free.
                 Under a minute of that is actual work. --local-worker is
                 faster (~90 s) and less representative.

PASS LOOKS LIKE  a line per check, then
                   All live E2E checks passed (N checks, M skipped).
                   Sandbox production: <uuid> in matter 'Discovery Sandbox'.
                 Any FAIL line names the check and the reason; exit code 1.

IF IT FAILS MIDWAY, in production
                 - Between intake and stamp: the production sits at 'review' or
                   'error' in the sandbox matter. Harmless; delete it in the UI.
                 - DURING stamping (changed 2026-09-20, F1): the job dies
                   part-way, 044's reaper hands it back, and the re-run RESUMES.
                   The range was allocated once, in one transaction, before any
                   page was stamped (production_bates_allocations), so the
                   re-run re-stamps only the documents that have no registry
                   rows yet and produces byte-for-byte the same numbers. It no
                   longer dies on "Bates collision", and no number is burned.
                   What still costs something: if you change the production's
                   CONTENTS (tag a document) after some numbers are registered,
                   the next attempt refuses rather than renumbering — those
                   numbers are spent and the honest answer is a supplemental
                   production. If NOTHING was registered yet, the reservation is
                   given back automatically and the new set is allocated.
                 - DURING packaging: the production stays 'stamped'. Re-running
                   package_production is safe and idempotent.
                 - The worker itself: a failed job goes to 'error' after its
                   attempt budget and the worker moves on. It does not wedge the
                   queue. A job that hangs past JOB_TIMEOUT_MINUTES restarts the
                   machine, which is the designed behaviour.

AFTERWARDS       node worker/e2e-live-test.mjs --cleanup
                 removes this run's storage objects, corpus documents and job
                 rows. It cannot remove bates_registry rows (ON DELETE RESTRICT,
                 migration 030:167-177) and does not try — reusing a Bates
                 number is the thing that table exists to prevent.
`;

if (flag('plan')) { console.log(PLAN); process.exit(0); }

await loadEnv(path.resolve(__dirname, '..', '.env'));

const SERVERSPACE_NAME = process.env.DISCOVERY_E2E_SERVERSPACE;
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

let failures = 0;
let passes = 0;
let skips = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : `  <- ${detail}`}`);
  if (cond) passes++; else failures++;
};
const skip = (name, why) => { console.log(`skip ${name}  (${why})`); skips++; };
const die = (msg) => { console.error(`e2e: ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 0. Schema sanity — every table and every column the worker writes today.
// ---------------------------------------------------------------------------
for (const table of ['productions', 'production_items', 'document_tag_defs',
  'document_tags', 'bates_registry', 'privilege_log_entries', 'deliveries', 'processing_jobs']) {
  const { error } = await supabase.from(table).select('id', { head: true, count: 'exact' }).limit(1);
  check(`table ${table} exists`, !error, error?.message);
}
if (failures) die('schema missing — was migration 030 applied?');

// Columns the queue grew after Discovery shipped. A production run against a
// database that never received 044/057 would fail in confusing ways later.
{
  const { error } = await supabase.from('processing_jobs')
    .select('id, priority, serverspace_id, attempts, max_attempts, heartbeat_at').limit(1);
  check('processing_jobs has 044 + 057 columns (attempts, heartbeat_at, priority, serverspace_id)',
    !error, error?.message);
}

// ---------------------------------------------------------------------------
// 1. Sandbox matter — in a serverspace NAMED by the operator, never guessed.
// ---------------------------------------------------------------------------
if (CLEANUP) {
  await cleanup();
  process.exit(0);
}
if (!SERVERSPACE_NAME) {
  die('set DISCOVERY_E2E_SERVERSPACE to the name of the serverspace to use.\n'
    + '     This test used to take the first serverspace in the table, which in a\n'
    + '     multi-tenant database is somebody else\'s. Run --plan for the procedure.');
}

let { data: matter } = await supabase.from('matterspaces')
  .select('id, name, serverspace_id').eq('short_code', 'disc-sandbox').maybeSingle();
const { data: ss, error: ssErr } = await supabase.from('serverspaces')
  .select('id, name').eq('name', SERVERSPACE_NAME).maybeSingle();
if (ssErr || !ss) die(`no serverspace named "${SERVERSPACE_NAME}"${ssErr ? `: ${ssErr.message}` : ''}`);
if (matter && matter.serverspace_id !== ss.id) {
  die(`the disc-sandbox matter lives in a different serverspace than "${SERVERSPACE_NAME}". Refusing to write across tenants.`);
}
if (!matter) {
  const { data: created, error: mErr } = await supabase.from('matterspaces').insert({
    serverspace_id: ss.id,
    name: 'Discovery Sandbox',
    description: 'Test matter for the Grapheon Discovery module (safe to delete).',
    short_code: 'disc-sandbox',
  }).select('id, name, serverspace_id').single();
  if (mErr) die(`create sandbox matter: ${mErr.message}`);
  matter = created;
}
console.log(`     sandbox matter: ${matter.name} (${matter.id}) in "${ss.name}"`);

// A sealed matter would hold the ingestion half (lib/seal-pipes.mjs) rather
// than run it; say so up front instead of failing four checks later.
const { data: tierRow } = await supabase.from('matterspaces').select('ai_tier').eq('id', matter.id).maybeSingle();
const SANDBOX_SEALED = tierRow?.ai_tier === 'B' || tierRow?.ai_tier === 'C';
if (SANDBOX_SEALED) console.log(`     NOTE: the sandbox matter is SEALED (Tier ${tierRow.ai_tier}); OCR/embedding checks will skip.`);

const { data: owner } = await supabase.from('serverspace_members')
  .select('user_id').eq('serverspace_id', matter.serverspace_id).eq('role', 'owner').limit(1).maybeSingle();

// ---------------------------------------------------------------------------
// 2. Sample discovery files
// ---------------------------------------------------------------------------
const fixtures = path.join(os.tmpdir(), `disc-e2e-${crypto.randomUUID().slice(0, 8)}`);
await fs.mkdir(fixtures, { recursive: true });

async function makePdf(file, title, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(title, { x: 72, y: 710, size: 14, font });
    p.drawText(`Page ${i + 1} of ${pages}. This document concerns the widget supply `
      + `agreement between Acme Corp and Webster Industries, including delivery `
      + `schedules and indemnification obligations.`, { x: 72, y: 680, size: 10, font, maxWidth: 470, lineHeight: 14 });
  }
  await fs.writeFile(path.join(fixtures, file), await doc.save());
}
await makePdf('001_Supply_Agreement.pdf', 'WIDGET SUPPLY AGREEMENT', 3);
await makePdf('002_Board_Minutes.pdf', 'BOARD MINUTES - Q3', 2);
await makePdf('003_Counsel_Memo.pdf', 'MEMO FROM OUTSIDE COUNSEL RE LITIGATION RISK', 2);

const sharp = (await import('sharp')).default;
await fs.writeFile(path.join(fixtures, '004_Warehouse_Scan.tif'),
  await sharp({ create: { width: 850, height: 1100, channels: 3, background: { r: 248, g: 246, b: 240 } } })
    .tiff().toBuffer());

await fs.writeFile(path.join(fixtures, '005_Damages_Model.xlsx'),
  Buffer.from('PK\x03\x04 fake xlsx for e2e'));

await fs.writeFile(path.join(fixtures, '006_Privileged_Email.eml'), Buffer.from(
  'From: Alice Counsel <acounsel@firmllp.com>\r\n'
  + 'To: Dan Director <dan@websterind.com>\r\n'
  + 'Cc: Carol GC <carol@websterind.com>\r\n'
  + 'Subject: Legal advice re indemnification exposure\r\n'
  + 'Date: Tue, 4 Mar 2025 10:00:00 -0500\r\n\r\n'
  + 'Privileged and confidential legal advice follows.\r\n'));
console.log(`     fixtures: ${fixtures}`);

// ---------------------------------------------------------------------------
// 3. Production + intake
// ---------------------------------------------------------------------------
const { data: prod, error: prodErr } = await supabase.from('productions').insert({
  matterspace_id: matter.id,
  direction: 'outgoing',
  name: `E2E Test Production ${new Date().toISOString().slice(0, 16)}`,
  receiving_party: 'Smith & Jones LLP',
  request_refs: 'RFP Nos. 1-12',
  bates_position: 'lower_right',
  created_by: owner?.user_id ?? null,
}).select().single();
if (prodErr) die(`create production: ${prodErr.message}`);
console.log(`     production: ${prod.id}`);

function runWorker(args) {
  const r = spawnSync(process.execPath, ['worker/discovery-worker.mjs', ...args], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 600000,
  });
  if (r.stdout) process.stdout.write(r.stdout.split('\n').map((l) => `       ${l}`).join('\n') + '\n');
  if (r.status !== 0) {
    process.stderr.write(r.stderr ?? '');
    die(`worker exited ${r.status}`);
  }
}

// Wait for a job to settle. This is the change that makes the test valid with
// two always-on Fly machines: before, it enqueued a job and then ran a local
// worker, assuming the local one would take it. Either machine may claim first,
// and a local `--once` that finds an empty queue exits 0 having done nothing.
async function waitForJob(jobId, label) {
  const t0 = Date.now();
  let lastNote = null;
  for (;;) {
    const { data, error } = await supabase.from('processing_jobs')
      .select('id, status, error, progress, progress_note, claimed_by, attempts, priority, serverspace_id')
      .eq('id', jobId).single();
    if (error) die(`poll ${label}: ${error.message}`);
    if (['done', 'error', 'held'].includes(data.status)) {
      console.log(`       ${label}: ${data.status} after ${Math.round((Date.now() - t0) / 1000)}s `
        + `(worker ${data.claimed_by ?? '—'}, attempt ${data.attempts})`);
      return data;
    }
    const note = `${data.status} ${data.progress}% ${data.progress_note ?? ''}`.trim();
    if (note !== lastNote) { console.log(`       ${label}: ${note}`); lastNote = note; }
    if (Date.now() - t0 > JOB_TIMEOUT_MS) {
      console.log(`       ${label}: STILL ${data.status} after ${Math.round(JOB_TIMEOUT_MS / 60000)} min — giving up on the poll`);
      return { ...data, status: 'timeout' };
    }
    await sleep(5000);
  }
}

// Assertions that apply to every job this test enqueues, and that only exist
// because of 057 and 060.
function checkJobShape(job, label) {
  check(`${label}: tenant stamped by 057's trigger`, !!job.serverspace_id, String(job.serverspace_id));
  check(`${label}: not parked by the seal`, job.status !== 'held', job.error ?? '');
  check(`${label}: priority is 0 or the bulk demotion, never above 0`,
    Number(job.priority) <= 0, `priority=${job.priority}`);
}

let intakeJobRow = null;
if (LOCAL_WORKER) {
  console.log('     -- intake (LOCAL worker --intake; see the hazards in the header) --');
  runWorker(['--intake', fixtures, '--production', prod.id]);
} else {
  console.log('     -- intake (upload + intake_files, through the deployed worker) --');
  const storagePaths = [];
  for (const name of (await fs.readdir(fixtures)).sort()) {
    const p = `${matter.id}/${prod.id}/intake/${name}`;
    const { error } = await supabase.storage.from('discovery-files')
      .upload(p, await fs.readFile(path.join(fixtures, name)), { upsert: true });
    if (error) die(`upload ${name}: ${error.message}`);
    storagePaths.push(p);
  }
  const { data: job, error: jErr } = await supabase.from('processing_jobs').insert({
    matterspace_id: matter.id, production_id: prod.id, job_type: 'intake_files',
    payload: { storage_paths: storagePaths, ingest: true },
  }).select().single();
  if (jErr) die(`enqueue intake_files: ${jErr.message}`);
  intakeJobRow = await waitForJob(job.id, 'intake_files');
  check('intake job done', intakeJobRow.status === 'done', intakeJobRow.error ?? intakeJobRow.status);
  checkJobShape(intakeJobRow, 'intake job');
}

const { data: items } = await supabase.from('production_items')
  .select('*').eq('production_id', prod.id).order('sort_order');
check('6 items intaken', items.length === 6, `got ${items.length}`);
check('all items ready', items.every((i) => i.status === 'ready'),
  items.filter((i) => i.status !== 'ready').map((i) => `${i.original_filename}: ${i.error}`).join('; '));
const byName = Object.fromEntries(items.map((i) => [i.original_filename, i]));
check('PDF item has display path', !!byName['001_Supply_Agreement.pdf']?.display_storage_path);
check('PDF page_count', byName['001_Supply_Agreement.pdf']?.page_count === 3);
check('TIFF converted to display PDF',
  byName['004_Warehouse_Scan.tif']?.kind === 'display_pdf' && !!byName['004_Warehouse_Scan.tif']?.display_storage_path);
check('xlsx stayed native', byName['005_Damages_Model.xlsx']?.kind === 'native');
check('eml metadata extracted', byName['006_Privileged_Email.eml']?.source_metadata?.author?.includes('acounsel@firmllp.com'));
check('sha256 recorded on all items', items.every((i) => /^[0-9a-f]{64}$/.test(i.sha256 ?? '')));

const { data: prodAfterIntake } = await supabase.from('productions').select('status').eq('id', prod.id).single();
check('production status -> review', prodAfterIntake.status === 'review', prodAfterIntake.status);

// Corpus ingestion is optional: processDocument throws without an OpenAI key
// (lib/ingest-core.mjs:262), and a sealed matter holds it by design.
//
// Whose key matters. In queue mode the work ran on a Fly machine, so the
// machine's OPENAI_API_KEY decides whether documents were linked — this
// laptop's .env says nothing about it, and skipping on its absence would hide a
// real failure of the deployed worker. Only --local-worker mode, where this
// process IS the worker, may skip for a missing local key.
const docIds = items.map((i) => i.document_id).filter(Boolean);
if (LOCAL_WORKER && !process.env.OPENAI_API_KEY) {
  skip('display PDFs ingested into corpus', 'no local OPENAI_API_KEY and this run used the local worker');
} else if (SANDBOX_SEALED) {
  skip('display PDFs ingested into corpus', 'sandbox matter is sealed; the seal holds indexing');
} else {
  check('display PDFs ingested into corpus', docIds.length >= 4, `${docIds.length} documents linked`);
  const { data: docs } = await supabase.from('documents')
    .select('id, processing_status, processing_error, metadata').in('id', docIds.length ? docIds : [crypto.randomUUID()]);
  check('no produced document was left mid-pipeline',
    (docs ?? []).every((d) => ['ready', 'held', 'error'].includes(d.processing_status)),
    (docs ?? []).map((d) => d.processing_status).join(','));
  // PR #153 (2026-09-18) records how each PDF was read. A production document
  // with no record is a document indexed by the old path.
  const withOutcome = (docs ?? []).filter((d) => d.metadata?.ingest_outcome || d.metadata?.text_status);
  check('each produced PDF carries a record of how it was read (ingest_outcome / text_status)',
    withOutcome.length === (docs ?? []).length, `${withOutcome.length} of ${(docs ?? []).length}`);
  check('the production backlink survived ingestion',
    (docs ?? []).every((d) => d.metadata?.production_id === prod.id),
    'documents.metadata.production_id');
}

// ---------------------------------------------------------------------------
// 4. Tags (presets seeded like the frontend does) + privilege log
// ---------------------------------------------------------------------------
const PRESETS = [
  { name: 'Privileged', color: '#b91c1c', is_endorsement: true, endorsement_text: 'PRIVILEGED', behavior: 'privileged', is_preset: true },
  { name: 'Hot Doc', color: '#d97706', is_endorsement: false, behavior: null, is_preset: true },
  { name: 'Confidential', color: '#1d4ed8', is_endorsement: true, endorsement_text: 'CONFIDENTIAL', behavior: null, is_preset: true },
  { name: 'Non-Responsive', color: '#6b7280', is_endorsement: false, behavior: 'non_responsive', is_preset: true },
];
for (const p of PRESETS) {
  await supabase.from('document_tag_defs')
    .upsert({ ...p, matterspace_id: matter.id }, { onConflict: 'matterspace_id,name', ignoreDuplicates: true });
}
const { data: defs } = await supabase.from('document_tag_defs')
  .select('*').eq('matterspace_id', matter.id);
const defByName = Object.fromEntries(defs.map((d) => [d.name, d]));
check('preset tag defs seeded', ['Privileged', 'Hot Doc', 'Confidential', 'Non-Responsive'].every((n) => defByName[n]));

async function tag(item, defName) {
  const { error } = await supabase.from('document_tags').insert({
    tag_def_id: defByName[defName].id, production_item_id: item.id, matterspace_id: matter.id,
  });
  if (error && !/duplicate/i.test(error.message)) die(`tag ${defName}: ${error.message}`);
}
await tag(byName['003_Counsel_Memo.pdf'], 'Privileged');        // withheld
await tag(byName['006_Privileged_Email.eml'], 'Privileged');    // withheld (native)
await tag(byName['002_Board_Minutes.pdf'], 'Confidential');     // endorsed
await tag(byName['001_Supply_Agreement.pdf'], 'Hot Doc');       // internal only

for (const it of [byName['003_Counsel_Memo.pdf'], byName['006_Privileged_Email.eml']]) {
  const m = it.source_metadata ?? {};
  await supabase.from('privilege_log_entries').upsert({
    matterspace_id: matter.id, production_id: prod.id, production_item_id: it.id,
    author: m.author ?? 'Alice Counsel', addressee: m.to ?? 'Dan Director', cc: m.cc ?? '',
    subject_matter: m.subject ?? 'Legal advice regarding litigation risk',
    basis: 'attorney_client',
    description: 'Communication seeking/providing legal advice.',
  }, { onConflict: 'production_item_id' });
}

// ---------------------------------------------------------------------------
// 5. Stamp
// ---------------------------------------------------------------------------
// Continue from the matter's own high-water mark. The original version of this
// file always started at the registry's next free number implicitly; saying it
// out loud matters because a previous run's numbers are still there and cannot
// be deleted (030:167-177).
const { data: hw } = await supabase.from('bates_registry')
  .select('bates_seq').eq('matterspace_id', matter.id)
  .order('bates_seq', { ascending: false }).limit(1).maybeSingle();
const startSeq = (hw?.bates_seq ?? 0) + 1;
console.log(`     bates start: SBX_${String(startSeq).padStart(7, '0')} (matter high-water mark ${hw?.bates_seq ?? 0})`);

await supabase.from('productions')
  .update({ bates_prefix: 'SBX_', bates_pad: 7, bates_start: startSeq }).eq('id', prod.id);
const { data: stampJob } = await supabase.from('processing_jobs').insert({
  matterspace_id: matter.id, production_id: prod.id, job_type: 'stamp_production', payload: {},
}).select().single();
console.log(LOCAL_WORKER ? '     -- stamp (LOCAL worker --once) --' : '     -- stamp (deployed worker) --');
if (LOCAL_WORKER) runWorker(['--once']);
const stampJobAfter = await waitForJob(stampJob.id, 'stamp_production');
check('stamp job done', stampJobAfter.status === 'done', stampJobAfter.error ?? stampJobAfter.status);
checkJobShape(stampJobAfter, 'stamp job');

const { data: prodStamped } = await supabase.from('productions').select('*').eq('id', prod.id).single();
check('production stamped + locked', prodStamped.status === 'stamped' && !!prodStamped.locked_at);
// Included: 001 (3pp) + 002 (2pp) + 004 tif (1p) + 005 xlsx slip (1p) = 7 pages
const { data: registry } = await supabase.from('bates_registry')
  .select('bates_number, bates_seq, page_number').eq('production_id', prod.id).order('bates_seq');
check('registry rows = 7 pages', registry.length === 7, `got ${registry.length}`);
check('bates range recorded', prodStamped.bates_end - prodStamped.bates_start === 6,
  `${prodStamped.bates_start}-${prodStamped.bates_end}`);
check('the numbering is gapless',
  registry.every((r, i) => i === 0 || Number(r.bates_seq) === Number(registry[i - 1].bates_seq) + 1),
  registry.map((r) => r.bates_seq).join(','));
check('this run continued from the matter high-water mark, reusing nothing',
  Number(prodStamped.bates_start) === startSeq, `${prodStamped.bates_start} vs ${startSeq}`);

const { data: itemsStamped } = await supabase.from('production_items')
  .select('original_filename, bates_first, bates_last').eq('production_id', prod.id).order('sort_order');
const stampedByName = Object.fromEntries(itemsStamped.map((i) => [i.original_filename, i]));
check('privileged PDF NOT stamped', stampedByName['003_Counsel_Memo.pdf'].bates_first === null);
check('privileged eml NOT stamped', stampedByName['006_Privileged_Email.eml'].bates_first === null);
check('native xlsx got one bates number',
  stampedByName['005_Damages_Model.xlsx'].bates_first === stampedByName['005_Damages_Model.xlsx'].bates_last
  && stampedByName['005_Damages_Model.xlsx'].bates_first !== null);

// Lock guard: adding an item to a stamped production must fail.
const { error: lockErr } = await supabase.from('production_items').insert({
  production_id: prod.id, matterspace_id: matter.id, sort_order: 99,
  original_filename: 'late_addition.pdf',
});
check('lock guard blocks late additions', !!lockErr, 'insert unexpectedly succeeded');

// Registry immutability: a second stamp over the same range must collide.
const { data: collideJob } = await supabase.from('processing_jobs').insert({
  matterspace_id: matter.id, production_id: prod.id, job_type: 'stamp_production', payload: {},
}).select().single();
if (LOCAL_WORKER) runWorker(['--once']);
const collideAfter = await waitForJob(collideJob.id, 're-stamp (expected to fail)');
check('re-stamp rejected (already stamped)', collideAfter.status === 'error', collideAfter.error ?? collideAfter.status);

// ---------------------------------------------------------------------------
// 6. Package + audit the ZIP
// ---------------------------------------------------------------------------
const { data: pkgJob } = await supabase.from('processing_jobs').insert({
  matterspace_id: matter.id, production_id: prod.id, job_type: 'package_production',
  payload: { include_privilege_log: true },
}).select().single();
console.log(LOCAL_WORKER ? '     -- package (LOCAL worker --once) --' : '     -- package (deployed worker) --');
if (LOCAL_WORKER) runWorker(['--once']);
const pkgJobAfter = await waitForJob(pkgJob.id, 'package_production');
check('package job done', pkgJobAfter.status === 'done', pkgJobAfter.error ?? pkgJobAfter.status);
checkJobShape(pkgJobAfter, 'package job');

const { data: prodPkg } = await supabase.from('productions').select('*').eq('id', prod.id).single();
check('production packaged', prodPkg.status === 'packaged');
check('package sha256 recorded', /^[0-9a-f]{64}$/.test(prodPkg.package_sha256 ?? ''));

const { data: pkgBlob, error: dlErr } = await supabase.storage.from('discovery-files').download(prodPkg.package_storage_path);
check('package downloads', !dlErr, dlErr?.message);
const pkgBuf = Buffer.from(await pkgBlob.arrayBuffer());
check('package sha256 matches download',
  crypto.createHash('sha256').update(pkgBuf).digest('hex') === prodPkg.package_sha256);

// The signed URL is what the browser's Download button actually uses.
const { data: signed, error: signErr } = await supabase.storage.from('discovery-files')
  .createSignedUrl(prodPkg.package_storage_path, 60);
check('a signed download URL can be minted for the package', !signErr && !!signed?.signedUrl, signErr?.message);

const tmpPkg = path.join(os.tmpdir(), `disc-e2e-pkg-${crypto.randomUUID().slice(0, 8)}.zip`);
await fs.writeFile(tmpPkg, pkgBuf);
const StreamZip = (await import('node-stream-zip')).default;
const zip = new StreamZip.async({ file: tmpPkg });
const names = Object.keys(await zip.entries());
const images = names.filter((n) => /\/IMAGES\//.test(n));
const natives = names.filter((n) => /\/NATIVES\//.test(n));
check('IMAGES has 4 stamped PDFs', images.length === 4, images.join(', '));
check('NATIVES has the xlsx', natives.length === 1 && natives[0].endsWith('.xlsx'), natives.join(', '));
check('privileged docs NOT in package',
  !names.some((n) => /Counsel_Memo|Privileged_Email/i.test(n)));
check('load file present', names.some((n) => n.endsWith('DATA/loadfile.dat')));
check('privilege log present', names.some((n) => n.endsWith('PrivilegeLog.pdf')));
check('production letter present', names.some((n) => n.endsWith('ProductionLetter.pdf')));

const datEntry = names.find((n) => n.endsWith('DATA/loadfile.dat'));
const { records } = parseDat(await zip.entryData(datEntry));
check('DAT has 4 records', records.length === 4, `got ${records.length}`);
const confRec = records.map(canonicalizeDatRecord)
  .find((r) => r.filename === '002_Board_Minutes.pdf');
check('CONFIDENTIAL designation in DAT', confRec?.dat?.confidentiality === 'CONFIDENTIAL');

// The accounting the package now has to carry (F7, 2026-09-20). These
// fixtures produce cleanly, so the two CSVs are header-only — which is itself
// the statement: nothing was left out, and it says so rather than being silent.
const excEntry = names.find((n) => n.endsWith('DATA/EXCEPTIONS.csv'));
check('exceptions report present', !!excEntry, names.join(', ').slice(0, 200));
if (excEntry) {
  const exc = (await zip.entryData(excEntry)).toString('utf8').trim().split(/\r?\n/);
  check('exceptions report is header-only for a clean production', exc.length === 1, exc.join(' | ').slice(0, 200));
}
const dupEntry = names.find((n) => n.endsWith('DATA/DUPLICATES.csv'));
check('duplicates report present', !!dupEntry);
const recEntry = names.find((n) => n.endsWith('DATA/RECONCILIATION.txt'));
check('reconciliation statement present', !!recEntry);
if (recEntry) {
  const recon = (await zip.entryData(recEntry)).toString('utf8');
  check('the package reconciles: received = produced + withheld + duplicates + exceptions',
    /These figures reconcile\./.test(recon), recon.split(/\r?\n/).slice(10, 18).join(' | '));
}

// The allocation row 071 writes, and its agreement with the registry.
const { data: allocRow } = await supabase.from('production_bates_allocations')
  .select('start_seq, end_seq, total_pages, item_plan').eq('production_id', prod.id).maybeSingle();
check('071 recorded one Bates allocation for this production',
  !!allocRow && Number(allocRow.total_pages) === 7,
  allocRow ? `${allocRow.start_seq}-${allocRow.end_seq} (${allocRow.total_pages}pp)` : 'no allocation row');
const { count: regRows } = await supabase.from('bates_registry')
  .select('id', { count: 'exact', head: true }).eq('production_id', prod.id);
check('the registry holds exactly the pages that were allocated',
  regRows === Number(allocRow?.total_pages ?? -1), `${regRows} rows`);

// Stamped PDF spot check: first image loads and has the right page count.
const firstImg = await zip.entryData(images.sort()[0]);
check('first stamped PDF loads (3pp)', (await PDFDocument.load(firstImg)).getPageCount() === 3);
await zip.close();
await fs.unlink(tmpPkg).catch(() => {});

// ---------------------------------------------------------------------------
// 7. Delivery record
// ---------------------------------------------------------------------------
const { error: delErr } = await supabase.from('deliveries').insert({
  matterspace_id: matter.id, production_id: prod.id,
  recipient_name: 'Smith & Jones LLP', recipient_email: 'discovery@smithjones.example',
  method: 'download', package_storage_path: prodPkg.package_storage_path,
  package_sha256: prodPkg.package_sha256,
  bates_range: `SBX_${String(prodPkg.bates_start).padStart(7, '0')}-SBX_${String(prodPkg.bates_end).padStart(7, '0')}`,
});
check('delivery recorded', !delErr, delErr?.message);

await fs.rm(fixtures, { recursive: true, force: true });
console.log(failures === 0
  ? `\nAll live E2E checks passed (${passes} checks, ${skips} skipped).`
    + `\nSandbox production: ${prod.id} in matter 'Discovery Sandbox'.`
    + `\nBates ${prodPkg.bates_start}-${prodPkg.bates_end} are now permanently spent in that matter.`
    + `\nTidy up with:  node worker/e2e-live-test.mjs --cleanup`
  : `\n${failures} FAILURES (${passes} passed, ${skips} skipped)`);
process.exit(failures === 0 ? 0 : 1);

// ---------------------------------------------------------------------------
// --cleanup: remove what CAN be removed, and say plainly what cannot.
// ---------------------------------------------------------------------------
async function cleanup() {
  const { data: m } = await supabase.from('matterspaces')
    .select('id, name').eq('short_code', 'disc-sandbox').maybeSingle();
  if (!m) { console.log('nothing to clean: no disc-sandbox matter'); return; }
  const { data: prods } = await supabase.from('productions')
    .select('id, name, status').eq('matterspace_id', m.id).like('name', 'E2E Test Production%');
  console.log(`cleanup: ${prods?.length ?? 0} E2E production(s) in ${m.name}`);

  // Storage is nested deeper than two levels: the per-item folder holds
  // native/<file> as well as display.pdf and stamped.pdf, so a two-level walk
  // leaves the natives behind. Walk it properly — a Supabase list() entry with
  // no id is a folder.
  async function removeTree(bucket, prefix) {
    const { data: entries, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
    if (error || !entries?.length) return 0;
    const files = entries.filter((e) => e.id).map((e) => `${prefix}/${e.name}`);
    let n = 0;
    if (files.length) {
      const { error: rmErr } = await supabase.storage.from(bucket).remove(files);
      if (!rmErr) n += files.length;
    }
    for (const dir of entries.filter((e) => !e.id)) n += await removeTree(bucket, `${prefix}/${dir.name}`);
    return n;
  }

  for (const p of prods ?? []) {
    const removed = await removeTree('discovery-files', `${m.id}/${p.id}`);
    const { data: pItems } = await supabase.from('production_items')
      .select('document_id').eq('production_id', p.id).not('document_id', 'is', null);
    const docIds = (pItems ?? []).map((i) => i.document_id);
    // intake mirrors every ingested display PDF into vault-documents so the
    // Reader and the MCP tools can see it (worker:579-581). Those objects are
    // in a different bucket and would otherwise be missed entirely.
    let mirrored = 0;
    for (const id of docIds) mirrored += await removeTree('vault-documents', `${m.id}/${id}`);
    if (docIds.length) {
      await supabase.from('passages').delete().in('document_id', docIds);
      await supabase.from('documents').delete().in('id', docIds);
    }
    await supabase.from('processing_jobs').delete().eq('production_id', p.id);
    console.log(`  ${p.name}: ${removed} discovery-files object(s), ${mirrored} vault-documents object(s), `
      + `${docIds.length} corpus document(s), jobs removed`);
  }
  console.log('\nNOT removed, deliberately:');
  console.log('  * production_bates_allocations rows (071) — the reservation is the record of which');
  console.log('    numbers this matter has spent. release_production_bates() gives one back, and');
  console.log('    only while not a single number of it has reached bates_registry.');
  console.log('  * bates_registry rows — production_id/production_item_id are ON DELETE RESTRICT');
  console.log('    (migration 030:167-177). A Bates number that has been assigned in a matter must');
  console.log('    never be reusable; that constraint is the point of the table.');
  console.log('  * the productions / production_items / privilege_log_entries / deliveries rows they');
  console.log('    reference, for the same reason. Leave them, or delete the whole sandbox matter.');
}
