// Grapheon Discovery worker — heavy processing for document productions.
//
// Claims jobs from the processing_jobs queue (atomic claim_discovery_job RPC,
// FOR UPDATE SKIP LOCKED) and executes them with the service role. Runs
// locally OR as a hosted long-running service (Railway/Fly) — config is
// entirely env-driven.
//
// Usage:
//   node worker/discovery-worker.mjs                  # poll loop (default)
//   node worker/discovery-worker.mjs --once           # drain queue, then exit
//   node worker/discovery-worker.mjs --intake <folder> --production <id>
//                                                     # direct local-disk intake
//                                                     # (bypasses browser upload
//                                                     #  limits for huge productions)
//
// Required env (read from ./.env at repo root):
//   VITE_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// Optional:
//   OPENAI_API_KEY   - enables full-text ingestion of display PDFs
//   GOOGLE_API_KEY   - Gemini: OCR route for unsealed matters + A/V transcription
//   ANTHROPIC_API_KEY - Anthropic vision: the other unsealed OCR route (fallback
//                      by default; OCR_TIER_A_ROUTES flips the order)
//   TEXTRACT_AWS_ACCESS_KEY_ID / TEXTRACT_AWS_SECRET_ACCESS_KEY /
//   TEXTRACT_AI_OPT_OUT_CONFIRMED - AWS Textract: the SEALED OCR route
//                      (docs/SEALED_OCR_SETUP.md)
//   WORKER_ID        - identifier recorded on claimed jobs
//
// Two machines run this loop (Phase 4, 2026-09-04): the claim is atomic
// (FOR UPDATE SKIP LOCKED), so two workers never take one job; the idle
// sweeps are jittered per process so they do not fire in lockstep.
//
// Job types: intake_zip | intake_files | intake_folder | stamp_production |
//            package_production | ingest_document
//
// ingest_document makes this the shared always-on worker for the whole app:
// /api/ingest enqueues documents too big for the serverless budget (large
// scans needing OCR, long recordings, .wma needing ffmpeg transcode) and this
// process runs them through the same lib/ingest-core.mjs pipeline with no
// timeout. payload: { document_id }.

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { processDocument } from '../lib/ingest-core.mjs';
import { pathInMatter, assertPathInProduction } from '../lib/storage-path.mjs';
import { assertJobBelongsToMatter, isJobScopeError, JobScopeError, sameMatterTree } from '../lib/job-scope.mjs';
import { BUCKETIZER_JOB_TYPE, runBucketizerDocumentJob } from '../lib/bucketizer-run.mjs';
import { createHeartbeat } from '../lib/worker-heartbeat.mjs';
import { HELD_STATUS, heldReason, isSealedPipeError } from '../lib/seal-pipes.mjs';
import { makeOcrProvider } from '../lib/ocr-routes.mjs';
import {
  sha256, formatBates, sanitizeStorageName, mimeFor, isJunkPath, extOf, loadEnv,
} from '../lib/discovery/util.mjs';
import { normalizeFile, pdfPageCount } from '../lib/discovery/normalize.mjs';
import {
  parseDat, datLookupByFilename, emitDat, emitOpt,
} from '../lib/discovery/loadfile.mjs';
import {
  stampPdf, makeSlipSheet, makeProductionLetter, makePrivilegeLogPdf, undrawableChars,
} from '../lib/discovery/bates-stamp.mjs';
import {
  exceptionsCsv, exceptionReason, duplicatesCsv, reconcile, reconciliationText,
} from '../lib/discovery/manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
await loadEnv(path.resolve(__dirname, '..', '.env'));

const SUPABASE_URL = requireEnv('VITE_SUPABASE_URL');
const SERVICE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || null;
// OCR by tier (lib/ocr-routes.mjs): reads the env on every job, so a key set
// on a running machine takes effect without a restart.
const ocrProvider = makeOcrProvider(process.env);
// Idle sweeps are offset by a per-process amount so two machines (Phase 4)
// do not scan the same rows in the same second.
const SWEEP_JITTER_MS = Math.floor(Math.random() * 60_000);
const WORKER_ID = process.env.WORKER_ID || `${os.hostname()}-${process.pid}`;
const BUCKET = 'discovery-files';
const POLL_MS = 5000;

// Liveness. Migration 044 lets claim_discovery_job reclaim a job whose worker
// stopped heartbeating for 5 minutes — which is only safe if a *living* worker
// actually heartbeats. Beat every 60s: frequent enough that the reaper never
// mistakes a long OCR pass for a corpse, rare enough to be free.
const HEARTBEAT_MS = 60_000;

// Watchdog. The queue is served by this one loop, one job at a time, so a job
// that never returns does not just lose itself — it stops every other matter's
// uploads behind it. That is the cross-matter stall: a wedged Gemini stream on
// one file froze intake for the whole practice. Nothing legitimate runs this
// long, so past the cap we stop trusting the process.
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MINUTES ?? 120) * 60_000;

// How often the idle loop sweeps for documents the queue lost track of
// entirely (killed serverless function → no job row at all → nothing to reap).
const RECOVER_EVERY_MS = 15 * 60_000;
const RECOVER_IDLE_MINUTES = 15;

// How often the idle loop looks for documents whose scanned pages are still
// awaiting OCR (documents.metadata.ocr_pending, Phase 2) and whose retry time
// has come. The retry SCHEDULE lives on the row (next_retry_at, set by
// ingest-core from ingest-formats' OCR_RETRY_DELAYS_MS); this is only how
// promptly a due retry is noticed.
const OCR_RETRY_SWEEP_MS = 5 * 60_000;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const args = parseArgs(process.argv.slice(2));

if (args.intake) {
  await directFolderIntake(args.intake, args.production);
  process.exit(0);
}

log(`Discovery worker ${WORKER_ID} started (poll ${POLL_MS}ms${args.once ? ', --once' : ''})`);
let lastRecoverAt = 0;
let lastOcrSweepAt = 0;

// Proof of life (migration 066). `processing_jobs.heartbeat_at` only beats
// while a job is held, so an idle worker and a dead one look identical — which
// is why an uploaded document could sit in 'pending' forever with nobody
// alerted. This writes one row per worker process, ~every 60 s and on every
// completion. beat() is synchronous, never throws and is never awaited: a
// heartbeat that cannot be written (066 not pasted yet, network blip) must
// never stop the worker, and one that hangs must never stall the queue. The
// rules live in lib/worker-heartbeat.mjs, where they can be tested.
const heartbeat = createHeartbeat({
  client: supabase,
  workerId: WORKER_ID,
  machineId: process.env.FLY_MACHINE_ID || os.hostname(),
  release: process.env.FLY_IMAGE_REF || process.env.FLY_RELEASE_VERSION || null,
  log,
});
heartbeat.beat({ force: true });

for (;;) {
  const job = await claimJob();
  if (!job) {
    if (args.once) break;
    heartbeat.beat();
    await recoverStrandedIfDue();
    await requeueOcrPendingIfDue();
    await sleep(POLL_MS);
    continue;
  }
  log(`[job ${job.id}] ${job.job_type} (production ${job.production_id ?? '—'}${job.priority ? `, priority ${job.priority}` : ''})`);
  try {
    await withHeartbeat(job, () => withWatchdog(job, dispatch(job)));
    await supabase.from('processing_jobs')
      .update({ status: 'done', progress: 100, finished_at: new Date().toISOString() })
      .eq('id', job.id);
    heartbeat.beat({ force: true, jobDone: true });
    log(`[job ${job.id}] done`);
  } catch (err) {
    if (err?.isWatchdog) {
      // Deliberately do NOT mark the job failed here. The work is still running
      // somewhere in this process and we cannot cancel it; writing passages
      // after a requeue would duplicate them. Stop the process instead. Fly
      // restarts us, and 044's reaper reclaims the abandoned claim under the
      // job's own attempt budget — so a genuinely poisonous file fails loudly
      // after max_attempts instead of wedging the queue forever.
      log(`[job ${job.id}] WATCHDOG: no completion after ${JOB_TIMEOUT_MS / 60_000}m — restarting worker so the claim can be reclaimed`);
      process.exit(1);
    }
    // The SecureSpace seal (lib/seal-pipes.mjs) is a decision, not a fault.
    // Parking is the whole point: an error would be retried, and a retry that
    // can only ever be refused again is how two documents turned into 1,641
    // failed jobs apiece over twenty days (the 2026-08-22 ingestion audit).
    // 'held' is claimed by nothing and swept by nothing; Phase B requeues it.
    if (isSealedPipeError(err)) {
      log(`[job ${job.id}] HELD: ${err.message}`);
      await holdJob(job, err);
      continue;
    }
    // A job that named something outside its own matter (lib/job-scope.mjs).
    // The job row takes the sentence and NOTHING else is touched: the document
    // or production it named is not this job's to mark failed or pending.
    if (isJobScopeError(err)) {
      log(`[job ${job.id}] REFUSED (scope): ${err.message}`);
      await supabase.from('processing_jobs')
        .update({ status: 'error', error: String(err.message), finished_at: new Date().toISOString() })
        .eq('id', job.id);
      continue;
    }
    log(`[job ${job.id}] ERROR: ${err.message}`);
    await supabase.from('processing_jobs')
      .update({ status: 'error', error: String(err.message ?? err), finished_at: new Date().toISOString() })
      .eq('id', job.id);
    await recordDocumentFailure(job, err);
    if (job.production_id && job.job_type.startsWith('intake')) {
      await supabase.from('productions').update({ status: 'error' }).eq('id', job.production_id);
    }
  }
}
log('Queue drained; exiting.');

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
// Every reference a queued job makes is checked against the job's own matter
// FIRST, before any handler reads anything (097 round 3, lib/job-scope.mjs):
//
//   intake_zip, intake_files      job.production_id, payload.storage_paths[]
//   stamp_production,
//   package_production            job.production_id
//   ingest_document               payload.document_id
//   bucketizer classify           payload.run_id, payload.document_id (and the
//                                 run must list the document)
//   intake_folder                 refused from the queue outright (below)
//
// The payload keys read after this point — ingest, force, ocr_retry,
// include_privilege_log — are flags, not references.
async function assertJobScope(job) {
  const p = job.payload ?? {};
  switch (job.job_type) {
    case 'intake_zip':
    case 'intake_files':
      return assertJobBelongsToMatter(supabase, job, { productionId: job.production_id, storagePaths: p.storage_paths ?? [] });
    case 'stamp_production':
    case 'package_production':
      return assertJobBelongsToMatter(supabase, job, { productionId: job.production_id });
    // Round 4: the document's CURRENT matter in the same tree as the job's —
    // an upload filed into a folder after it was queued is still this job's.
    case 'ingest_document':
      return p.document_id === undefined ? null
        : assertJobBelongsToMatter(supabase, job, { documentId: p.document_id, documentScope: 'tree' });
    // Round 4: a run over a matter includes its folders and sub-matters.
    case BUCKETIZER_JOB_TYPE:
      return assertJobBelongsToMatter(supabase, job, { runId: p.run_id, documentId: p.document_id, documentScope: 'subtree' });
    default:
      return null;
  }
}

async function dispatch(job) {
  await assertJobScope(job);
  switch (job.job_type) {
    case 'intake_zip': return intakeZip(job);
    case 'intake_files': return intakeFiles(job);
    // A folder on THIS machine's disk. It exists for the operator's CLI
    // (`--intake`, which calls intakeFolder directly and never comes through
    // here). From the queue it is refused: processing_jobs rows are
    // member-writable (032), and a payload naming a local path would have the
    // worker read its own filesystem — /proc/self/environ included — into a
    // production the member can download.
    case 'intake_folder': return refuseQueuedFolderIntake(job);
    case 'stamp_production': return stampProduction(job);
    case 'package_production': return packageProduction(job);
    case 'ingest_document': return ingestDocument(job);
    // One document of a Bucketizer run (migration 079). Everything it needs —
    // the run row, the per-window progress, the seal, the pause, the meter and
    // the matter's Record — is in lib/bucketizer-run.mjs; a policy refusal
    // stops the RUN there and returns normally, so nothing here has to know
    // about it.
    case BUCKETIZER_JOB_TYPE:
      return runBucketizerDocumentJob({
        supabase, job, log, progress: (pct, note) => progress(job, pct, note),
      });
    default: throw new Error(`Unknown job_type '${job.job_type}'`);
  }
}

async function claimJob() {
  const { data, error } = await supabase.rpc('claim_discovery_job', { p_worker: WORKER_ID });
  if (error) {
    log(`claim error: ${error.message}`);
    return null;
  }
  return Array.isArray(data) ? data[0] ?? null : data ?? null;
}

// Visible progress is also proof of life, so fold the heartbeat into it. The
// timer below is the guarantee; this just means a job reporting steadily is
// never one poll away from looking dead.
async function progress(job, pct, note) {
  await supabase.from('processing_jobs')
    .update({
      progress: Math.min(99, Math.round(pct)),
      progress_note: note ?? null,
      heartbeat_at: new Date().toISOString(),
    })
    .eq('id', job.id);
}

// Beat for as long as the job runs, and stop the moment it settles either way.
// A failed beat is logged, not thrown: losing one beat to a blip should not
// fail a job that is otherwise working, and 5 minutes is five beats of slack.
async function withHeartbeat(job, run) {
  const timer = setInterval(() => {
    supabase.rpc('heartbeat_job', { p_job: job.id })
      .then(({ error }) => { if (error) log(`[job ${job.id}] heartbeat failed: ${error.message}`); });
    // And the WORKER's own beat (066), on the same timer. Without this line a
    // worker that is busy is a worker that is silent: the idle branch is the
    // only other periodic caller, and a single job may run for up to
    // JOB_TIMEOUT_MINUTES (120). A two-hour OCR would otherwise raise "WORKER
    // DOWN" about a worker that is working — and a false alarm is how an alert
    // channel dies.
    heartbeat.beat();
  }, HEARTBEAT_MS);
  timer.unref?.();
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}

// A losing race against the clock. The work is not cancellable — the caller's
// job is to stop the process, not to pretend this promise went away.
function withWatchdog(job, work) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`job exceeded ${JOB_TIMEOUT_MS / 60_000} minutes`);
      err.isWatchdog = true;
      reject(err);
    }, JOB_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

// Park a job the seal refused, and the document with it. Both rows land in
// 'held': terminal for claim_discovery_job (which claims only 'queued') and
// invisible to 055/058's recovery sweep (which revives only pending /
// extracting / chunking / embedding). Nothing here burns the attempt budget,
// because nothing here is an attempt — the answer will be the same until a
// sealed route exists or the matter is unsealed.
async function holdJob(job, err) {
  const reason = heldReason(err);
  await supabase.from('processing_jobs')
    .update({ status: HELD_STATUS, error: reason, finished_at: new Date().toISOString() })
    .eq('id', job.id);

  // F5 (2026-09-20 re-verification): until migration 071 this function wrote
  // nothing to `productions`, and the main loop's `continue` skips the branch
  // that would have set the production to 'error'. A held intake therefore
  // left the production at 'processing' with no worker, no error and nothing
  // for the UI to say — forever. A held production is not an error and is
  // certainly not still processing, so it says 'held' and says why.
  if (job.production_id && String(job.job_type ?? '').startsWith('intake')) {
    const { error: prodErr } = await supabase.from('productions')
      .update({ status: HELD_STATUS, status_reason: `Held: ${reason}` })
      .eq('id', job.production_id)
      .not('status', 'in', '("stamped","packaged","delivered")');
    if (prodErr) log(`  could not hold production ${job.production_id}: ${prodErr.message}`);
  }

  const docId = job.payload?.document_id;
  if (!docId) return;
  const { error: updErr } = await supabase.from('documents')
    .update({ processing_status: HELD_STATUS, processing_error: reason })
    .eq('id', docId)
    .neq('processing_status', 'ready');
  if (updErr) log(`  could not hold document ${docId}: ${updErr.message}`);
}

// When an ingest job fails, the job row records it — but until 2026-08-22 the
// *document* was left wherever the pipeline dropped it, typically 'embedding'
// with processing_error null. Invisible in the app, and the fuel for the
// twenty-day recovery loop the ingestion audit found: recovery kept finding a
// non-terminal document with no open job and kept minting fresh jobs.
//
// Migration 055 makes recovery reuse the job row so its attempt budget is
// really spent. This closes the other half in code: on the attempt that
// exhausts the budget, park the document with a reason a human can read,
// drawn from lib/ingest-triage.mjs — which has always written the plain
// English and was simply never reached from here.
//
// Attempts are incremented by claim_discovery_job at claim time, so
// job.attempts is the number of this attempt. While attempts remain the
// document goes back to 'pending' — the state migration 058's recovery sweep
// requeues from under the same budget — carrying a processing_error that
// says what failed and that a retry is coming, so the app shows "Retrying"
// with the cause instead of an uploading spinner (a 23-second Gemini billing
// 403 looked like a 45-minute upload on 2026-09-03). The sweep clears the
// note when it requeues; a repeat failure writes the next attempt's note.
async function recordDocumentFailure(job, err) {
  if (job.job_type !== 'ingest_document') return;
  const docId = job.payload?.document_id;
  if (!docId) return;
  const attempts = Number(job.attempts ?? 0);
  const maxAttempts = Number(job.max_attempts ?? 3);
  const exhausted = attempts >= maxAttempts;

  const raw = String(err?.message ?? err ?? '');
  let note = null;
  try {
    const { attemptFailureNote } = await import('../lib/ingest-triage.mjs');
    note = attemptFailureNote(raw, attempts, maxAttempts);
  } catch { /* triage is advisory — the raw error is still better than null */ }
  const reason = exhausted
    ? (note?.exhausted || raw.slice(0, 400))
    : (note?.retrying || `Attempt ${attempts} of ${maxAttempts} failed (${raw.slice(0, 160)}). Retrying automatically.`);

  const { error: updErr } = await supabase.from('documents')
    .update({
      processing_status: exhausted ? 'error' : 'pending',
      processing_error: reason.slice(0, 800),
    })
    .eq('id', docId)
    .neq('processing_status', 'ready');
  if (updErr) log(`  could not record failure on document ${docId}: ${updErr.message}`);
  else if (exhausted) log(`  document ${docId} marked failed after ${attempts} attempts`);
  else log(`  document ${docId}: attempt ${attempts} of ${maxAttempts} noted, awaiting retry`);
}

// Documents stranded with no job row at all — the killed-serverless-function
// case, which no amount of reaping finds because there is nothing to reap.
// Runs only while idle, so it never competes with real work.
async function recoverStrandedIfDue() {
  if (Date.now() - lastRecoverAt < RECOVER_EVERY_MS + SWEEP_JITTER_MS) return;
  lastRecoverAt = Date.now();
  const { data, error } = await supabase.rpc('recover_stranded_documents', {
    p_idle_minutes: RECOVER_IDLE_MINUTES,
  });
  if (error) { log(`recover_stranded_documents failed: ${error.message}`); return; }
  if (data) log(`recovered ${data} stranded document(s) back into the queue`);
}

// Documents whose scanned pages are still awaiting OCR (metadata.ocr_pending,
// Phase 2 of the ingestion plan, 2026-09-04). When OCR fails, processDocument
// no longer fails the document: it indexes the typed pages and records the
// scanned ones — which pages, why, and a next_retry_at on the schedule in
// ingest-formats (5 min, 15 min, 1 h, 3 h, 6 h, then give up). Nothing in the
// queue remembers them, because processing_jobs has no run-after column; the
// idle loop does. Any ready document whose retry time has passed gets one
// ingest_document job (deduped against jobs in flight), and the full re-run
// re-reads the file, OCRs the waiting pages and re-embeds — cheap next to a
// second table for partial passages. Held records (the SecureSpace seal) wait
// for a sealed route; exhausted ones wait for a person. Idle-only, like the
// stranded sweep: it never competes with real work.
async function requeueOcrPendingIfDue() {
  if (Date.now() - lastOcrSweepAt < OCR_RETRY_SWEEP_MS + SWEEP_JITTER_MS) return;
  lastOcrSweepAt = Date.now();
  const { data, error } = await supabase.from('documents')
    .select('id, matterspace_id, source_filename, ocr_pending:metadata->ocr_pending')
    .eq('processing_status', 'ready')
    .not('metadata->ocr_pending', 'is', null)
    .limit(500);
  if (error) { log(`ocr_pending sweep failed: ${error.message}`); return; }
  const now = Date.now();
  const due = (data || []).filter((d) => {
    const p = d.ocr_pending;
    if (!p || typeof p !== 'object' || p.held || p.exhausted || !p.next_retry_at) return false;
    return new Date(p.next_retry_at).getTime() <= now;
  });
  if (!due.length) return;
  let queued = 0;
  for (const d of due) {
    const { data: inflight } = await supabase.from('processing_jobs')
      .select('id').eq('job_type', 'ingest_document').in('status', ['queued', 'running'])
      .contains('payload', { document_id: d.id }).limit(1);
    if (inflight?.length) continue;
    const { error: qErr } = await supabase.from('processing_jobs').insert({
      matterspace_id: d.matterspace_id,
      job_type: 'ingest_document',
      payload: { document_id: d.id, ocr_retry: (Number(d.ocr_pending.attempts) || 0) + 1 },
    });
    if (qErr) { log(`  ocr retry enqueue failed for ${d.source_filename}: ${qErr.message}`); continue; }
    await supabase.from('documents')
      .update({ processing_status: 'pending', processing_error: null })
      .eq('id', d.id);
    queued++;
  }
  if (queued) log(`ocr_pending sweep: queued ${queued} document(s) for another OCR attempt`);
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------
// A job is a member-writable row (032 checks only that its matterspace_id is
// theirs) and its payload is free-form jsonb, yet the worker reads what it
// names with the service role. So a job may only read files inside its OWN
// production: the job's matter is the production's matter, and every path is
// "<matter>/<production>/…" with no traversal (lib/storage-path.mjs; 097).
function assertJobPaths(job, prod, paths, label) {
  if (!job.matterspace_id || job.matterspace_id !== prod.matterspace_id) {
    throw new JobScopeError(`the production (${label})`);
  }
  for (const p of paths) {
    try {
      assertPathInProduction(p, prod.matterspace_id, prod.id);
    } catch {
      throw new JobScopeError(`a storage path (${label})`);
    }
  }
}

async function intakeZip(job) {
  const prod = await getProduction(job.production_id);
  const paths = job.payload?.storage_paths ?? [];
  if (paths.length === 0) throw new Error('intake_zip: payload.storage_paths is empty');
  assertJobPaths(job, prod, paths, 'intake_zip');
  await setProductionStatus(prod.id, 'processing');

  const StreamZip = (await import('node-stream-zip')).default;
  let fileIndex = 0;

  for (const storagePath of paths) {
    await progress(job, 1, `Downloading ${path.basename(storagePath)}…`);
    const zipBuf = await downloadFromStorage(storagePath);
    const tmp = path.join(os.tmpdir(), `disc-intake-${crypto.randomUUID()}.zip`);
    await fs.writeFile(tmp, zipBuf);

    try {
      const zip = new StreamZip.async({ file: tmp });
      const entries = Object.values(await zip.entries())
        .filter((e) => !e.isDirectory && !isJunkPath(e.name));

      // Pass 1: load files. Opposing counsel's own Bates numbers and document
      // breaks are trusted over filename guessing.
      let datLookup = new Map();
      for (const e of entries.filter((e) => /\.dat$/i.test(e.name))) {
        const { records } = parseDat(await zip.entryData(e.name));
        datLookup = new Map([...datLookup, ...datLookupByFilename(records)]);
        await uploadToStorage(
          `${prod.matterspace_id}/${prod.id}/loadfiles/${sanitizeStorageName(path.basename(e.name))}`,
          await zip.entryData(e.name), 'application/octet-stream',
        );
      }

      const contentEntries = entries
        .filter((e) => !/\.(dat|opt|lfp)$/i.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const e of contentEntries) {
        fileIndex += 1;
        await progress(job, (fileIndex / contentEntries.length) * 100, e.name);
        const buf = await zip.entryData(e.name);
        await intakeOneFile(prod, job, {
          buf, originalPath: e.name, sortOrder: fileIndex, datLookup,
        });
      }
      await zip.close();
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }

  await setProductionStatus(prod.id, 'review');
}

async function intakeFiles(job) {
  const prod = await getProduction(job.production_id);
  const paths = job.payload?.storage_paths ?? [];
  if (paths.length === 0) throw new Error('intake_files: payload.storage_paths is empty');
  assertJobPaths(job, prod, paths, 'intake_files');
  await setProductionStatus(prod.id, 'processing');

  for (const [i, storagePath] of paths.entries()) {
    const filename = path.basename(storagePath);
    await progress(job, ((i + 1) / paths.length) * 100, filename);
    const buf = await downloadFromStorage(storagePath);
    await intakeOneFile(prod, job, {
      buf, originalPath: filename, sortOrder: i + 1, datLookup: new Map(),
    });
  }
  await setProductionStatus(prod.id, 'review');
}

async function intakeFolder(job) {
  const prod = await getProduction(job.production_id);
  await setProductionStatus(prod.id, 'processing');
  const root = job.payload?.local_path;
  if (!root) throw new Error('intake_folder: payload.local_path missing');

  const files = [];
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const parent = e.parentPath || e.path || root;
    const full = path.join(parent, e.name);
    const rel = path.relative(root, full).replaceAll('\\', '/');
    if (isJunkPath(rel)) continue;
    files.push({ full, rel });
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));

  // Load files first.
  let datLookup = new Map();
  for (const f of files.filter((f) => /\.dat$/i.test(f.rel))) {
    const buf = await fs.readFile(f.full);
    const { records } = parseDat(buf);
    datLookup = new Map([...datLookup, ...datLookupByFilename(records)]);
    await uploadToStorage(
      `${prod.matterspace_id}/${prod.id}/loadfiles/${sanitizeStorageName(path.basename(f.rel))}`,
      buf, 'application/octet-stream',
    );
  }

  const content = files.filter((f) => !/\.(dat|opt|lfp)$/i.test(f.rel));
  for (const [i, f] of content.entries()) {
    await progress(job, ((i + 1) / content.length) * 100, f.rel);
    const buf = await fs.readFile(f.full);
    await intakeOneFile(prod, job, {
      buf, originalPath: f.rel, sortOrder: i + 1, datLookup,
    });
  }
  await setProductionStatus(prod.id, 'review');
}

/**
 * Normalize one file into the image/native/metadata triplet, store it,
 * record the production_items row, and (optionally) ingest the display PDF
 * into the matter's searchable corpus.
 */
async function intakeOneFile(prod, job, { buf, originalPath, sortOrder, datLookup }) {
  const filename = path.basename(originalPath);
  const hash = sha256(buf);

  // F6 (2026-09-20 re-verification). idx_production_items_sha
  // (matterspace_id, sha256) has existed since 030:122 and was never once
  // queried, so two byte-identical files became two produced documents with
  // two Bates ranges — the receiving party paying to review the same document
  // twice, and the producing party swearing to a count that double-counts.
  // Scoped to THIS production: a supplemental production legitimately
  // re-produces a document, and cross-production de-duplication would be a
  // different (and wrong) decision.
  const { data: sameBytes, error: dupLookupErr } = await supabase.from('production_items')
    .select('id, original_path, original_filename, sort_order, status, kind, page_count, '
      + 'native_storage_path, display_storage_path, duplicate_of_item_id')
    .eq('matterspace_id', prod.matterspace_id)
    .eq('sha256', hash)
    .eq('production_id', prod.id)
    .order('sort_order');
  if (dupLookupErr) throw new Error(`duplicate lookup (${filename}): ${dupLookupErr.message}`);
  const twins = sameBytes ?? [];

  // Same bytes at the same path is not a duplicate — it is this job running a
  // second time. 044's reaper requeues a crashed intake exactly as it requeues
  // a crashed stamp, and without this an intake that died two thirds of the
  // way through would file every document again and label each re-filing a
  // duplicate of its own first pass.
  //
  // A finished row is skipped. A row left MID-FLIGHT by the attempt that died
  // — inserted, never marked ready — is resumed in place under its own id:
  // skipping it would leave a 'pending' row that the manifest then has to
  // report as an exception forever, which is a hole the retry itself created.
  // 'ready' and 'error' are both settled: normalization is deterministic, so
  // re-running a file that failed it would only write the same error again.
  // 'pending' is the only state that means "an attempt died holding this".
  const already = twins.find((t) => (t.original_path ?? t.original_filename) === originalPath);
  if (already && already.status !== 'pending') {
    log(`  ${filename}: already intaken in this production (${already.status}) — skipping`);
    return;
  }
  const resumeId = already?.id ?? null;
  if (resumeId) log(`  ${filename}: resuming the row a previous attempt left mid-flight`);

  // Write this file's row: update the mid-flight one if there is one, insert
  // otherwise. Either way there is exactly one row per original_path.
  const identity = {
    production_id: prod.id,
    matterspace_id: prod.matterspace_id,
    sort_order: sortOrder,
    original_filename: filename,
    original_path: originalPath,
    sha256: hash,
    file_size_bytes: buf.length,
  };
  const writeItem = async (fields) => {
    if (resumeId) {
      const { error: updErr } = await supabase.from('production_items').update(fields).eq('id', resumeId);
      if (updErr) throw new Error(`resume production_item (${filename}): ${updErr.message}`);
      return { id: resumeId };
    }
    const { data, error: insErr } = await supabase.from('production_items')
      .insert({ ...identity, ...fields }).select().single();
    if (insErr) throw new Error(`insert production_item (${filename}): ${insErr.message}`);
    return data;
  };

  // An empty file is not a document that can be "produced once": every
  // zero-byte file in existence shares one sha256, so de-duplicating them
  // would collapse a blank .pdf and a blank .txt into the same document. They
  // each get their own row and their own slip sheet.
  const first = buf.length === 0 ? null
    : twins.find((t) => t.id !== resumeId && t.status !== 'error' && !t.duplicate_of_item_id) ?? null;
  if (first) {
    // The ZIP really did contain this file twice, and that is part of the
    // record, so the row stays. It points at the first instance's stored
    // objects — identical bytes by definition — is never stamped, and is
    // listed in DATA/DUPLICATES.csv under the Bates number it WAS produced at.
    await writeItem({
      kind: first.kind,
      page_count: first.page_count,
      native_storage_path: first.native_storage_path,
      display_storage_path: first.display_storage_path,
      duplicate_of_item_id: first.id,
      source_metadata: { duplicate_of: first.original_filename },
      status: 'ready',
      error: null,
    });
    log(`  ${filename}: byte-identical to ${first.original_filename} — produced once, listed as a duplicate`);
    return;
  }

  let norm;
  try {
    norm = await normalizeFile(buf, filename);
  } catch (err) {
    await writeItem({
      kind: 'native', duplicate_of_item_id: null,
      status: 'error', error: `normalize: ${err.message}`,
    });
    return;
  }

  // Attach load-file metadata when the production's DAT references this file.
  const datRec = datLookup.get(filename.toLowerCase());
  const metadata = { ...norm.metadata, ...(datRec ?? {}) };

  const item = await writeItem({
    kind: norm.kind,
    page_count: norm.pageCount,
    bates_first: datRec?.bates_first ?? null,
    bates_last: datRec?.bates_last ?? null,
    source_metadata: metadata,
    duplicate_of_item_id: null,
    status: 'pending',
    error: null,
  });

  try {
    const base = `${prod.matterspace_id}/${prod.id}/${item.id}`;
    const ext = extOf(filename);

    // Native: the original bytes, always retained.
    const nativePath = `${base}/native/${sanitizeStorageName(filename)}`;
    await uploadToStorage(nativePath, buf, mimeFor(ext));

    // Display PDF: passthrough PDFs reuse the native object; conversions
    // (TIFF/image -> PDF) get their own object.
    let displayPath = null;
    if (norm.kind === 'display_pdf') {
      if (norm.displayPdf === buf) {
        displayPath = nativePath;
      } else {
        displayPath = `${base}/display.pdf`;
        await uploadToStorage(displayPath, norm.displayPdf, 'application/pdf');
      }
    }

    await supabase.from('production_items').update({
      native_storage_path: nativePath,
      display_storage_path: displayPath,
      status: 'ready',
    }).eq('id', item.id);

    // Full-text ingestion into the matter corpus (per-page extraction, OCR
    // fallback, embeddings) — the production becomes searchable matter-wide.
    if (norm.kind === 'display_pdf' && OPENAI_API_KEY && job.payload?.ingest !== false) {
      await ingestDisplayPdf(prod, item, norm.displayPdf, filename);
    }
  } catch (err) {
    await supabase.from('production_items')
      .update({ status: 'error', error: err.message })
      .eq('id', item.id);
  }
}

async function ingestDisplayPdf(prod, item, pdfBuf, filename) {
  const { data: docRow, error } = await supabase.from('documents').insert({
    matterspace_id: prod.matterspace_id,
    title: filename,
    doc_type: 'other',
    source_filename: filename,
    file_size_bytes: pdfBuf.length,
    processing_status: 'pending',
    created_by: prod.created_by,
    metadata: { production_id: prod.id, production_item_id: item.id },
  }).select().single();
  if (error) throw new Error(`insert document: ${error.message}`);

  // Mirror into vault-documents so DocumentReader and the MCP tools see it
  // through the standard path convention.
  const storagePath = `${prod.matterspace_id}/${docRow.id}/${sanitizeStorageName(filename.replace(/\.[^.]+$/, ''))}.pdf`;
  await supabase.storage.from('vault-documents')
    .upload(storagePath, pdfBuf, { contentType: 'application/pdf', upsert: true });
  await supabase.from('documents').update({ storage_path: storagePath }).eq('id', docRow.id);

  try {
    await processDocument(supabase, {
      documentId: docRow.id,
      fileBuf: pdfBuf,
      ext: '.pdf',
      openaiApiKey: OPENAI_API_KEY,
      ocr: ocrProvider,
    });
  } catch (err) {
    // A sealed matter refusing the pipe is not an ingestion failure — the item
    // is filed, stored and reviewable; it is only unindexed, and 'held' says
    // exactly that instead of crying error over a working document.
    await supabase.from('documents')
      .update({
        processing_status: isSealedPipeError(err) ? HELD_STATUS : 'error',
        processing_error: isSealedPipeError(err) ? heldReason(err) : err.message,
      })
      .eq('id', docRow.id);
    // Ingestion failure is non-fatal: the item is still reviewable.
  }
  await supabase.from('production_items').update({ document_id: docRow.id }).eq('id', item.id);
}

// ---------------------------------------------------------------------------
// Vault document ingestion (the shared-worker job type)
// ---------------------------------------------------------------------------
// Same pipeline as /api/ingest, but with no serverless timeout and with
// ffmpeg available — so 1,000-page scans OCR fully and .wma/.m4a recordings
// transcode before transcription. The Vault UI needs no special handling:
// it polls documents.processing_status, which processDocument updates
// stage-by-stage exactly as the inline path does.
async function ingestDocument(job) {
  const docId = job.payload?.document_id;
  if (!docId) throw new Error('ingest_document: payload.document_id missing');

  const { data: doc, error } = await supabase.from('documents')
    .select('id, storage_path, source_filename, matterspace_id, processing_status, text_status:metadata->>text_status, ocr_pending:metadata->ocr_pending')
    .eq('id', docId).single();
  if (error) throw new Error(`document ${docId}: ${error.message}`);
  if (!doc.storage_path) throw new Error('document has no storage_path');
  // 097 round 3/4: a job re-indexes only a document of its own matter's tree.
  if (!(await sameMatterTree(supabase, doc.matterspace_id, job.matterspace_id))) throw new JobScopeError('the document');
  // 097: the worker reads with the service role, so a row pointing at another
  // matter's object would be indexed into this one. Refused (lib/storage-path.mjs).
  if (!pathInMatter(doc.storage_path, doc.matterspace_id)) {
    throw new Error('document storage_path is filed under a different matter; not read');
  }
  // A ready document with a recorded text_status is stored-without-text, and
  // one with ocr_pending still owes OCR on some pages; a queued re-run of
  // either is deliberate. Only a fully indexed document is skipped — unless
  // the job was queued with force (ingest_document force: true), which is how
  // a document indexed with the wrong text gets repaired (2026-09-18).
  const forced = job.payload?.force === true;
  if (doc.processing_status === 'ready' && !doc.text_status && !doc.ocr_pending && !forced) { log(`  ${doc.source_filename}: already ready, skipping`); return; }
  if (job.payload?.ocr_retry) log(`  ${doc.source_filename}: OCR retry ${job.payload.ocr_retry} for ${Array.isArray(doc.ocr_pending?.pages) ? doc.ocr_pending.pages.length + ' page(s)' : 'the scan'}`);

  await progress(job, 5, `Downloading ${doc.source_filename}`);
  const fileBuf = await downloadFromBucket('vault-documents', doc.storage_path);
  const ext = doc.source_filename?.includes('.')
    ? '.' + doc.source_filename.split('.').pop().toLowerCase() : '';

  // A forced re-run swaps rather than wipes: the current passages stay
  // searchable until the new run succeeds, and a run that fails leaves the row
  // exactly as it was (lib/reprocess.mjs). Every forced job swaps, not only
  // one that finds the row 'ready': a forced run whose worker died mid-way
  // (the watchdog, an OOM on an 800-page re-run) is reclaimed with the row at
  // 'embedding', and wiping then would take the originals with it. The swap
  // handles that too — the crashed run's partial passages are newer than the
  // originals, so success removes both and failure keeps the originals.
  // Unforced jobs are documents that never finished, whose partial passages
  // are clutter — so idempotency there is the old way: clear, then run.
  const swap = forced;
  if (!swap) await supabase.from('passages').delete().eq('document_id', docId);

  // OCR goes through the tier's routes (ocrProvider). Transcription stays on
  // Gemini; a recording longer than twenty minutes is cut into parts by
  // ffmpeg and transcribed part by part with the timestamps shifted back
  // (lib/media-segments.mjs, Phase 4) — one request per recording ran past
  // the model's output ceiling on hour-long calls.
  let transcribe = null;
  if (GOOGLE_API_KEY) {
    transcribe = async (buf, { ext: mediaExt, kind, onProgress }) => {
      const { transcribeMedia, mimeForMediaExt } = await import('../lib/transcribe-gemini.mjs');
      // Video too, not only audio: a whole hour of video is ~1.06M input tokens
      // (263/s of frames + 32/s of audio), past the model's 1,048,576 ceiling —
      // two one-hour recordings failed that way on 2026-09-16 while every
      // shorter one passed. The segmenter takes any container ffmpeg reads and
      // hands back 20-minute mp3 parts, so speech is what gets transcribed
      // either way; under twenty minutes the whole file still goes as-is.
      {
        const { transcribeInSegments } = await import('../lib/media-segments.mjs');
        const inParts = await transcribeInSegments(buf, mediaExt, {
          onProgress,
          transcribeSegment: (mp3, { index, total }) =>
            transcribeMedia(mp3, { apiKey: GOOGLE_API_KEY, mimeType: 'audio/mp3', kind, onProgress, displayName: `part ${index + 1} of ${total}` }),
        });
        if (inParts) {
          log(`  ${doc.source_filename}: transcribed in ${inParts.segments} parts (${Math.round(inParts.durationSec / 60)} min)`);
          return inParts.pages;
        }
      }
      let mediaBuf = buf;
      let mimeType = mimeForMediaExt(mediaExt);
      // .wma has no Gemini support and .m4a is unreliable — transcode both to
      // speech-grade mp3 (16 kHz mono 32k: small enough that long recordings
      // upload without drops).
      if (!mimeType || mediaExt === '.m4a' || mediaExt === '.wma') {
        await progress(job, 15, 'Transcoding for transcription (ffmpeg)');
        mediaBuf = await transcodeToMp3(buf, mediaExt);
        mimeType = 'audio/mp3';
      }
      return transcribeMedia(mediaBuf, { apiKey: GOOGLE_API_KEY, mimeType, kind, onProgress });
    };
  }

  // Rough stage → progress mapping so the queue row tells a human story.
  const stagePct = { extracting: 20, chunking: 55, embedding: 75, ready: 99 };
  const run = () => processDocument(supabase, {
    documentId: docId,
    fileBuf,
    ext,
    openaiApiKey: OPENAI_API_KEY,
    ocr: ocrProvider,
    transcribe,
    onProgress: ({ stage, message }) => {
      progress(job, stagePct[stage] ?? 40, message).catch(() => {});
    },
  });
  if (swap) {
    const { reprocessInPlace } = await import('../lib/reprocess.mjs');
    const { passageCount, replacedPassages } = await reprocessInPlace(supabase, docId, run);
    log(`  ${doc.source_filename}: forced re-run — ${passageCount} passages, ${replacedPassages} old passage(s) replaced`);
    return;
  }
  const { passageCount } = await run();
  log(`  ${doc.source_filename}: ${passageCount} passages`);
}

// 16 kHz mono 32k mp3 — speech-grade and small (see scripts/transcribe-av.mjs).
async function transcodeToMp3(buf, ext) {
  const { spawn } = await import('node:child_process');
  const tag = crypto.randomUUID().slice(0, 8);
  const inPath = path.join(os.tmpdir(), `wrk_${tag}${ext || '.bin'}`);
  const outPath = path.join(os.tmpdir(), `wrk_${tag}.mp3`);
  try {
    await fs.writeFile(inPath, buf);
    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', ['-y', '-i', inPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '32k', outPath], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      ff.stderr.on('data', (d) => { err += d.toString(); });
      ff.on('error', reject);
      ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-300)}`))));
    });
    return await fs.readFile(outPath);
  } finally {
    await fs.unlink(inPath).catch(() => {});
    await fs.unlink(outPath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Stamping
// ---------------------------------------------------------------------------
// Stamping, made crash-safe (F1, 2026-09-20 re-verification).
//
// What used to happen: the range was re-derived from prod.bates_start on every
// run and the registry rows were written as the loop went. Since 044 a worker
// that dies mid-stamp is no longer wedged — the reaper requeues it — so the
// re-run re-derived the SAME start, walked into its own half-written rows and
// died on "Bates collision" (three times, until the budget was spent). The
// numbers already written can never be recovered: 030:330-335 gives
// bates_registry no DELETE policy, on purpose. One crash burned a permanent
// hole in the matter's numbering and told nobody why.
//
// What happens now, in three separated phases:
//
//   PRE-FLIGHT  every page of every document is proved stampable — the prefix
//               and every endorsement drawable, every display PDF readable and
//               counted — BEFORE a single number is allocated. Anything that
//               fails here becomes an exception (F7) and is simply not in the
//               range. Zero numbers spent.
//   ALLOCATE    migration 071's allocate_production_bates: one row per
//               production, one transaction, a per-matter advisory lock, and
//               the exact per-item plan recorded. Asking twice returns the
//               first answer, so a re-run cannot drift.
//   REGISTER    migration 071's register_bates_pages, per document: ON
//               CONFLICT DO NOTHING plus a proof that every row in the range
//               belongs to this document. Re-runnable to the byte.
//
// A requeued job therefore re-stamps only what is missing and produces exactly
// the same numbers; a second production in the same matter continues from the
// high-water mark, counting numbers already reserved as well as numbers
// already registered.
async function stampProduction(job) {
  const prod = await getProduction(job.production_id);
  assertJobPaths(job, prod, [], 'stamp_production');   // the job's matter is the production's
  if (['packaged', 'delivered'].includes(prod.status)) {
    throw new Error(`Production already ${prod.status}; create a supplemental production instead`);
  }
  if (!prod.bates_prefix && prod.bates_prefix !== '') {
    throw new Error('stamp_production: bates_prefix not configured on the production');
  }
  // A job re-delivered after its first run finished must be a no-op, not an
  // error — and must certainly not renumber anything.
  const locked = prod.status === 'stamped';

  const { included, excluded, exceptions, duplicates, endorsementsByItem } = await partitionItems(prod);
  if (included.length === 0) throw new Error('No documents to stamp (all excluded?)');

  await progress(job, 1, `Checking ${included.length} document(s) before any Bates number is spent…`);
  const { plan, failed } = await preflightStamp(prod, included, endorsementsByItem, { locked });
  for (const f of failed) {
    log(`  EXCEPTION ${f.item.original_filename}: ${f.reason}`);
    exceptions.push({ ...f.item, status: 'error', error: f.reason });
  }
  if (plan.length === 0) {
    throw new Error(`Nothing in this production can be stamped: all ${failed.length} document(s) failed pre-flight`);
  }

  const { data: alloc, error: allocErr } = await supabase.rpc('allocate_production_bates', {
    p_production: prod.id,
    p_items: plan.map((e) => ({ item_id: e.item.id, pages: e.pages })),
  });
  if (allocErr) throw new Error(allocErr.message);

  const prefix = alloc.bates_prefix ?? '';
  const pad = Number(alloc.bates_pad);
  const slots = new Map((alloc.item_plan ?? []).map((e) => [e.item_id, e]));
  log(`  Bates ${formatBates(prefix, pad, Number(alloc.start_seq))}–${formatBates(prefix, pad, Number(alloc.end_seq))}`
    + ` allocated to this production (${alloc.total_pages} page(s))`);

  let stamped = 0;
  let resumed = 0;
  for (const [i, entry] of plan.entries()) {
    const item = entry.item;
    const slot = slots.get(item.id);
    if (!slot) throw new Error(`the Bates allocation has no slot for ${item.original_filename}`);
    const seq = Number(slot.start_seq);
    const pages = Number(slot.pages);
    if (pages !== entry.pages) {
      throw new Error(`${item.original_filename} was allocated ${pages} page(s) but now pre-flights at ${entry.pages}`);
    }
    const base = `${prod.matterspace_id}/${prod.id}/${item.id}`;
    await progress(job, (i / plan.length) * 100, `Stamping ${item.original_filename} (${slot.bates_first})`);

    // Already done by an earlier attempt? Leave it exactly as it is.
    if (item.bates_first === slot.bates_first && item.bates_last === slot.bates_last
        && (await registeredPagesFor(item.id)) === pages
        && (await storageObjectExists(`${base}/stamped.pdf`))) {
      resumed += 1;
      continue;
    }
    if (locked) {
      throw new Error(
        `Production is already stamped, but ${item.original_filename} carries no Bates number. `
        + 'Its numbers cannot be reassigned; produce it in a supplemental production.');
    }

    const endorsements = endorsementsByItem.get(item.id) ?? [];
    if (item.kind === 'native') {
      const sheet = await makeSlipSheet({
        batesNumber: slot.bates_first, filename: item.original_filename,
        endorsements, position: prod.bates_position,
      });
      await uploadToStorage(`${base}/stamped.pdf`, sheet, 'application/pdf');
    } else {
      // Member-writable while the production is a draft (030); read with the
      // service role — so only from inside this production (097).
      assertPathInProduction(item.display_storage_path, prod.matterspace_id, prod.id);
      const pdfBuf = await downloadFromStorage(item.display_storage_path);
      const out = await stampPdf(pdfBuf, {
        prefix, pad, startSeq: seq, position: prod.bates_position, endorsements,
      });
      // The burned-on numbers and the registry are the same representation.
      // If they could ever disagree, stop before either is written.
      if (out.pageCount !== pages) {
        throw new Error(
          `${item.original_filename} pre-flighted at ${pages} page(s) but stamped ${out.pageCount}; `
          + 'its range would run into the next document. Nothing was written for it.');
      }
      if (out.batesFirst !== slot.bates_first || out.batesLast !== slot.bates_last) {
        throw new Error(
          `${item.original_filename} stamped ${out.batesFirst}–${out.batesLast} but was allocated `
          + `${slot.bates_first}–${slot.bates_last}`);
      }
      await uploadToStorage(`${base}/stamped.pdf`, out.buf, 'application/pdf');
    }

    await supabase.from('production_items')
      .update({ bates_first: slot.bates_first, bates_last: slot.bates_last, page_count: pages })
      .eq('id', item.id);

    const { error: regErr } = await supabase.rpc('register_bates_pages', {
      p_production: prod.id, p_item: item.id, p_start_seq: seq, p_pages: pages,
    });
    if (regErr) throw new Error(`bates_registry: ${regErr.message}`);
    stamped += 1;
  }

  await supabase.from('productions').update({
    bates_start: Number(alloc.start_seq),
    bates_end: Number(alloc.end_seq),
    status: 'stamped',
    status_reason: null,
    locked_at: prod.locked_at ?? new Date().toISOString(),
  }).eq('id', prod.id);

  log(`  stamped ${stamped} doc(s)${resumed ? ` (+${resumed} already done by an earlier attempt)` : ''}`
    + ` / ${alloc.total_pages} pages (${formatBates(prefix, pad, Number(alloc.start_seq))}–`
    + `${formatBates(prefix, pad, Number(alloc.end_seq))}); ${excluded.length} withheld, `
    + `${duplicates.length} duplicate(s), ${exceptions.length} exception(s)`);
}

// Prove every page of every document is stampable before a single number is
// allocated. This is what turns F0's residual ("an undrawable endorsement
// refuses at item N, and items 1…N−1 are already in the registry") into a
// refusal at item 0 that costs nothing.
//
// It reads each display PDF to count its pages rather than trusting
// production_items.page_count: the count decides which numbers every LATER
// document gets, so a stale one would not merely mis-stamp this document, it
// would shift the whole production.
async function preflightStamp(prod, included, endorsementsByItem, { locked }) {
  const badPrefix = undrawableChars(prod.bates_prefix ?? '');
  if (badPrefix.length) {
    throw new Error(
      `Bates prefix contains character(s) a standard PDF font cannot draw: ${badPrefix.join(' ')}. `
      + 'The page has to read exactly what bates_registry records. No number has been spent.');
  }
  for (const item of included) {
    for (const text of endorsementsByItem.get(item.id) ?? []) {
      const bad = undrawableChars(text);
      if (bad.length) {
        throw new Error(
          `The endorsement "${text}" on ${item.original_filename} contains character(s) a standard PDF `
          + `font cannot draw: ${bad.join(' ')}. An endorsement is a legal designation and must burn `
          + 'onto the page exactly as recorded. No number has been spent.');
      }
    }
  }

  const plan = [];
  const failed = [];
  for (const item of included) {
    if (item.kind === 'native') { plan.push({ item, pages: 1 }); continue; }
    try {
      if (!item.display_storage_path) throw new Error('no display PDF was stored for this document');
      assertPathInProduction(item.display_storage_path, prod.matterspace_id, prod.id);
      const pages = await pdfPageCount(await downloadFromStorage(item.display_storage_path));
      if (!Number.isInteger(pages) || pages < 1) throw new Error('its display PDF has no pages');
      if (pages !== item.page_count && !locked) {
        await supabase.from('production_items').update({ page_count: pages }).eq('id', item.id);
      }
      plan.push({ item, pages });
    } catch (err) {
      const reason = `stamp pre-flight: ${err.message}`;
      if (!locked) {
        await supabase.from('production_items').update({ status: 'error', error: reason }).eq('id', item.id);
      }
      failed.push({ item, reason });
    }
  }
  return { plan, failed };
}

async function registeredPagesFor(itemId) {
  const { count } = await supabase.from('bates_registry')
    .select('id', { count: 'exact', head: true })
    .eq('production_item_id', itemId);
  return count ?? 0;
}

async function registeredPagesForProduction(productionId) {
  const { count } = await supabase.from('bates_registry')
    .select('id', { count: 'exact', head: true })
    .eq('production_id', productionId);
  return count ?? 0;
}

// Split a production's items into the four buckets a manifest has to
// reconcile, and collect endorsement text per item.
//
// Until 2026-09-20 this selected status='ready' and returned two buckets, so a
// document that failed normalization was silently absent from the stamp, from
// the package and from the load file — a production delivered with holes
// nobody knew about (F7). It now reads EVERY row and accounts for each one
// exactly once, by the precedence set out in lib/discovery/manifest.mjs:
// exception > withheld > duplicate > produced.
//
// Ordered by (sort_order, id), not sort_order alone: two intake passes into
// one production can hand out the same sort_order, and Bates numbers are
// derived from this order.
async function partitionItems(prod) {
  const { data: items, error: itemsErr } = await supabase.from('production_items')
    .select('*').eq('production_id', prod.id)
    .order('sort_order').order('id');
  if (itemsErr) throw new Error(itemsErr.message);

  const { data: tags, error: tagsErr } = await supabase.from('document_tags')
    .select('production_item_id, document_tag_defs(name, behavior, is_endorsement, endorsement_text)')
    .eq('matterspace_id', prod.matterspace_id)
    .in('production_item_id', items.map((i) => i.id));
  if (tagsErr) throw new Error(tagsErr.message);

  const excludedIds = new Set();
  const endorsementsByItem = new Map();
  const confidentialIds = new Set();
  for (const t of tags ?? []) {
    const def = t.document_tag_defs;
    if (!def) continue;
    if (def.behavior === 'privileged' || def.behavior === 'non_responsive') {
      excludedIds.add(t.production_item_id);
    }
    if (def.is_endorsement && def.endorsement_text) {
      const list = endorsementsByItem.get(t.production_item_id) ?? [];
      list.push(def.endorsement_text);
      endorsementsByItem.set(t.production_item_id, list);
      if (/confidential/i.test(def.endorsement_text)) confidentialIds.add(t.production_item_id);
    }
  }

  const included = [];
  const withheld = [];
  const duplicates = [];
  const exceptions = [];
  for (const it of items) {
    if (it.status !== 'ready') { exceptions.push(it); continue; }
    if (excludedIds.has(it.id)) { withheld.push(it); continue; }
    if (it.duplicate_of_item_id) { duplicates.push(it); continue; }
    included.push(it);
  }

  return {
    items,
    byId: new Map(items.map((i) => [i.id, i])),
    included,
    excluded: withheld,
    duplicates,
    exceptions,
    endorsementsByItem,
    confidentialIds,
  };
}

// The matter's Bates high-water mark now lives in migration 071's
// allocate_production_bates, which takes it together with the numbers already
// RESERVED by another production that is mid-stamp — a distinction this
// function could not make, and the reason two productions stamping in the same
// minute could overlap.

// ---------------------------------------------------------------------------
// Packaging
// ---------------------------------------------------------------------------
async function packageProduction(job) {
  const prod = await getProduction(job.production_id);
  assertJobPaths(job, prod, [], 'package_production');   // the job's matter is the production's
  if (prod.status !== 'stamped' && prod.status !== 'packaged') {
    throw new Error(`package_production: production must be stamped first (status: ${prod.status})`);
  }

  const {
    items, byId, included, excluded, duplicates, exceptions, confidentialIds,
  } = await partitionItems(prod);
  const produced = included.filter((i) => i.bates_first);
  if (produced.length === 0) throw new Error('Nothing stamped to package');

  // ---- The arithmetic, BEFORE a byte of the package is written (F7).
  //
  //   received = produced + privileged-withheld + duplicates + exceptions
  //
  // plus the two independent checks the buckets cannot make for themselves:
  // every produced document carries a Bates number, and the registry holds
  // exactly as many rows for this production as the package claims pages.
  // A production that does not add up is not delivered — it is stopped here,
  // where it is still a job failure rather than a representation to a court.
  const producedPages = produced.reduce(
    (n, i) => n + (i.kind === 'native' ? 1 : (i.page_count ?? 1)), 0);
  const counts = {
    received: items.length,
    produced: produced.length,
    withheld: excluded.length,
    duplicates: duplicates.length,
    exceptions: exceptions.length,
    unnumbered: included.length - produced.length,
    producedPages,
    registeredPages: await registeredPagesForProduction(prod.id),
  };
  const balance = reconcile(counts);
  if (!balance.ok) {
    await supabase.from('productions')
      .update({ status_reason: `Packaging stopped: ${balance.problems.join('; ')}` })
      .eq('id', prod.id);
    throw new Error(
      `This production does not reconcile, so it was not packaged: ${balance.problems.join('; ')}.`);
  }

  const matterName = await matterNameOf(prod.matterspace_id);
  const volumeName = sanitizeStorageName(prod.name.replace(/\s+/g, '_')) || 'PRODUCTION';

  const archiver = (await import('archiver')).default;
  const tmpZip = path.join(os.tmpdir(), `disc-pkg-${crypto.randomUUID()}.zip`);
  const out = createWriteStream(tmpZip);
  const archive = archiver('zip', { zlib: { level: 6 } });
  const archiveDone = new Promise((resolve, reject) => {
    out.on('close', resolve);
    archive.on('error', reject);
  });
  archive.pipe(out);

  const datRows = [];
  let totalPages = 0;
  for (const [i, item] of produced.entries()) {
    await progress(job, (i / produced.length) * 80, `Packaging ${item.bates_first}`);
    const base = `${prod.matterspace_id}/${prod.id}/${item.id}`;
    const stamped = await downloadFromStorage(`${base}/stamped.pdf`);
    const imagePath = `IMAGES/${item.bates_first}.pdf`;
    archive.append(stamped, { name: `${volumeName}/${imagePath}` });

    let nativeLink = '';
    if (item.kind === 'native') {
      const ext = extOf(item.original_filename);
      assertPathInProduction(item.native_storage_path, prod.matterspace_id, prod.id);
      const nativeBuf = await downloadFromStorage(item.native_storage_path);
      nativeLink = `NATIVES/${item.bates_first}${ext}`;
      archive.append(nativeBuf, { name: `${volumeName}/${nativeLink}` });
    }

    const m = item.source_metadata ?? {};
    const pages = item.kind === 'native' ? 1 : (item.page_count ?? 1);
    totalPages += pages;
    datRows.push({
      bates_first: item.bates_first,
      bates_last: item.bates_last,
      pages,
      custodian: m.custodian ?? '',
      author: m.author ?? '',
      to: m.to ?? '',
      cc: m.cc ?? '',
      subject: m.subject ?? '',
      date: m.date ?? '',
      filename: item.original_filename,
      native_link: nativeLink,
      confidentiality: confidentialIds.has(item.id) ? 'CONFIDENTIAL' : '',
      image_path: imagePath,
    });
  }

  if (totalPages !== producedPages) {
    throw new Error(
      `The package holds ${totalPages} page(s) but the production reconciled at ${producedPages}; `
      + 'it was not finalized.');
  }

  await progress(job, 85, 'Writing load files and cover documents…');
  archive.append(emitDat(datRows), { name: `${volumeName}/DATA/loadfile.dat` });
  archive.append(emitOpt(datRows, volumeName), { name: `${volumeName}/DATA/loadfile.opt` });

  // The exceptions report: every document taken into this production that
  // could not be produced, by original path, hash and reason. It ships even
  // when it is empty, because an empty one is itself a statement — and it is
  // deliberately NOT the privilege log: nothing here was withheld as a
  // judgment, these are documents the software could not render.
  archive.append(exceptionsCsv(exceptions), { name: `${volumeName}/DATA/EXCEPTIONS.csv` });

  archive.append(duplicatesCsv(duplicates.map((d) => {
    const f = byId.get(d.duplicate_of_item_id);
    return {
      original_path: d.original_path, original_filename: d.original_filename, sha256: d.sha256,
      firstFilename: f?.original_filename ?? '',
      firstBatesFirst: f?.bates_first ?? '', firstBatesLast: f?.bates_last ?? '',
    };
  })), { name: `${volumeName}/DATA/DUPLICATES.csv` });

  archive.append(reconciliationText(counts, {
    matterName,
    productionName: prod.name,
    batesFirst: formatBates(prod.bates_prefix, prod.bates_pad, prod.bates_start),
    batesLast: formatBates(prod.bates_prefix, prod.bates_pad, prod.bates_end),
    dateStr: new Date().toISOString().slice(0, 10),
  }), { name: `${volumeName}/DATA/RECONCILIATION.txt` });

  if (job.payload?.include_privilege_log) {
    const { data: entries } = await supabase.from('privilege_log_entries')
      .select('*').eq('production_id', prod.id).order('doc_date', { ascending: true, nullsFirst: false });
    if (entries?.length) {
      const privLog = await makePrivilegeLogPdf({ matterName, productionName: prod.name, entries });
      archive.append(privLog, { name: `${volumeName}/PrivilegeLog.pdf` });
    }
  }

  const letter = await makeProductionLetter({
    productionName: prod.name,
    matterName,
    receivingParty: prod.receiving_party,
    batesFirst: formatBates(prod.bates_prefix, prod.bates_pad, prod.bates_start),
    batesLast: formatBates(prod.bates_prefix, prod.bates_pad, prod.bates_end),
    docCount: produced.length,
    pageCount: totalPages,
    nativeCount: produced.filter((i) => i.kind === 'native').length,
    confidentialCount: confidentialIds.size,
    requestRefs: prod.request_refs,
    dateStr: new Date().toISOString().slice(0, 10),
  });
  archive.append(letter, { name: `${volumeName}/ProductionLetter.pdf` });

  await archive.finalize();
  await archiveDone;

  await progress(job, 92, 'Hashing and uploading package…');
  const pkgSha = await sha256File(tmpZip);
  const pkgStoragePath = `${prod.matterspace_id}/${prod.id}/package/${volumeName}.zip`;
  const zipBuf = await fs.readFile(tmpZip);
  await uploadToStorage(pkgStoragePath, zipBuf, 'application/zip');
  await fs.unlink(tmpZip).catch(() => {});

  await supabase.from('productions').update({
    package_storage_path: pkgStoragePath,
    package_sha256: pkgSha,
    status: 'packaged',
  }).eq('id', prod.id);

  for (const e of exceptions) log(`  EXCEPTION in package: ${e.original_path ?? e.original_filename} — ${exceptionReason(e)}`);
  log(`  packaged ${produced.length} docs / ${producedPages} pages -> ${pkgStoragePath} `
    + `(sha256 ${pkgSha.slice(0, 12)}…); ${counts.withheld} withheld, ${counts.duplicates} duplicate(s), `
    + `${counts.exceptions} exception(s) — received ${counts.received}, reconciled`);
}

// ---------------------------------------------------------------------------
// Direct local-disk intake (CLI mode for very large productions)
// ---------------------------------------------------------------------------
// F2 (2026-09-20 re-verification). This path used to insert its job as
// `status: 'running'` and then call intakeFolder directly — NOT through
// withHeartbeat. Only the per-file progress() call refreshed heartbeat_at, so
// one slow file (a 2,000-page scan going through OCR) exceeded 044's
// five-minute staleness window, the reaper requeued the job, and one of the
// two always-on Fly machines then claimed an intake_folder job whose
// payload.local_path is a folder on the operator's laptop. It failed on a
// missing path, and the whole production was set to 'error'.
//
// Two things close it, and both are needed:
//   * withHeartbeat, so a living intake never looks dead in the first place;
//   * requires_worker (migration 071), so that even if it does — the laptop
//     is closed, the process is killed — no other machine can be handed a job
//     it has no way to run. The reaper takes such a job straight to a terminal
//     error and writes a sentence on the production that names the machine.
async function refuseQueuedFolderIntake(job) {
  throw new Error(
    `intake_folder runs only from the worker CLI (--intake), never from the queue; job ${job.id} refused`);
}

async function directFolderIntake(folder, productionId) {
  if (!productionId) die('--intake requires --production <production uuid>');
  const root = path.resolve(folder);
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) die(`Not a folder: ${root}`);

  const prod = await getProduction(productionId);
  const { data: job, error } = await supabase.from('processing_jobs').insert({
    matterspace_id: prod.matterspace_id,
    production_id: prod.id,
    job_type: 'intake_folder',
    payload: { local_path: root, ingest: true },
    status: 'running',
    claimed_by: WORKER_ID,
    claimed_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    requires_worker: WORKER_ID,
  }).select().single();
  if (error) die(`create job: ${error.message}`);

  log(`Direct intake of ${root} into production "${prod.name}" (pinned to ${WORKER_ID})`);
  try {
    await withHeartbeat(job, () => intakeFolder(job));
    await supabase.from('processing_jobs')
      .update({ status: 'done', progress: 100, finished_at: new Date().toISOString() })
      .eq('id', job.id);
    log('Done.');
  } catch (err) {
    if (isSealedPipeError(err)) {
      await holdJob(job, err);
      die(err.message);
    }
    await supabase.from('processing_jobs')
      .update({ status: 'error', error: String(err.message ?? err), finished_at: new Date().toISOString() })
      .eq('id', job.id);
    await supabase.from('productions')
      .update({ status: 'error', status_reason: `Local intake on ${WORKER_ID} failed: ${String(err.message ?? err).slice(0, 400)}` })
      .eq('id', prod.id);
    die(err.message);
  }
}

// ---------------------------------------------------------------------------
// Storage + misc helpers
// ---------------------------------------------------------------------------
async function getProduction(id) {
  if (!id) throw new Error('job has no production_id');
  const { data, error } = await supabase.from('productions').select('*').eq('id', id).single();
  if (error) throw new Error(`production ${id}: ${error.message}`);
  return data;
}

// The reason travels with the status, and is cleared by any status that does
// not need one. Every intake begins by setting 'processing', so a stale
// "Held: …" or "The local intake on … stopped" never survives a re-run: the
// sentence on the production is always about the state it is actually in.
async function setProductionStatus(id, status, reason = null) {
  await supabase.from('productions').update({ status, status_reason: reason }).eq('id', id);
}

// Does this object exist in the discovery-files bucket? Used by a re-run of a
// crashed stamp to decide whether a document still needs its stamped PDF.
async function storageObjectExists(storagePath) {
  if (!storagePath) return false;
  const cut = storagePath.lastIndexOf('/');
  const dir = cut < 0 ? '' : storagePath.slice(0, cut);
  const name = storagePath.slice(cut + 1);
  const { data, error } = await supabase.storage.from(BUCKET).list(dir, { search: name, limit: 100 });
  if (error) return false;
  return (data ?? []).some((o) => o.name === name);
}

async function matterNameOf(matterspaceId) {
  const { data } = await supabase.from('matterspaces').select('name').eq('id', matterspaceId).single();
  return data?.name ?? '';
}

async function downloadFromStorage(storagePath, attempts = 3) {
  return downloadFromBucket(BUCKET, storagePath, attempts);
}

async function downloadFromBucket(bucket, storagePath, attempts = 3) {
  for (let i = 1; ; i++) {
    const { data, error } = await supabase.storage.from(bucket).download(storagePath);
    if (!error) return Buffer.from(await data.arrayBuffer());
    if (i >= attempts) throw new Error(`storage download ${bucket}/${storagePath}: ${error.message}`);
    await sleep(1000 * i);
  }
}

async function uploadToStorage(storagePath, buf, contentType, attempts = 3) {
  for (let i = 1; ; i++) {
    const { error } = await supabase.storage.from(BUCKET)
      .upload(storagePath, buf, { contentType, upsert: true });
    if (!error) return;
    if (i >= attempts) throw new Error(`storage upload ${storagePath}: ${error.message}`);
    await sleep(1000 * i);
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    createReadStream(filePath)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true;
      else { out[k] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) die(`Missing env: ${name}`);
  return v;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function log(msg) { process.stdout.write(`${msg}\n`); }
function die(msg) { process.stderr.write(`discovery-worker: ${msg}\n`); process.exit(1); }
