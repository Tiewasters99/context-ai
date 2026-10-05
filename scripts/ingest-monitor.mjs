// Ingestion watchdog. Answers the question that keeps costing real time:
// "did everything I uploaded actually become searchable?"
//
// Deliberately deterministic — no model calls. Detection is a database query
// and a lookup table; the only judgement involved is which class an error
// string falls into, and that lives in lib/ingest-triage.mjs. Running an LLM
// agent loop on a mindless sweep is how you spend $90 finding nothing.
//
// What it looks for:
//   1. documents.processing_status = 'error'
//   2. documents stuck in a transient state (pending/extracting/chunking/
//      embedding) past --stale-minutes — the process handling them died
//   3. processing_jobs queued or running past the same window — the Fly worker
//      is down, or a job wedged
//   4. documents marked `ready` that hold ZERO passages — the audit's headline
//      class (99.3% said ready; 60.5% were searchable). Needs migration 059's
//      ready_but_empty(); degrades gracefully until it is pasted. Text-bearing
//      extensions escalate; images/media and deliberate duplicates count as
//      known-benign. --no-empty-check skips it.
//   5. no worker heartbeat for 10 minutes (migration 066's worker_heartbeats).
//      Checks 1–4 all infer the worker's health from its WORK, so on a quiet
//      night a dead worker and an empty queue are the same picture. A worker
//      beats whether or not it has a job, so this is the only check that fires
//      during the silence. Degrades to a note until 066 is pasted.
//
// What it does about it:
//   default        report only
//   --fix          requeue the classes marked retryable (bounded by --max-fix)
//   --email        send the digest to GMAIL_ADDRESS
//   --quiet        print/send nothing when everything is healthy (cron mode)
//
// WHOSE FILENAMES THIS MAY PRINT (2026-09-20)
// Until now every escalated row was listed by source_filename, and the digest
// goes to one mailbox — GMAIL_ADDRESS, the operator's. With one tenant that
// was a convenience. With paying users it is a leak: "Doe v. Archdiocese —
// settlement terms.pdf" in a stranger's matter would arrive in the operator's
// inbox six times a day, for no operational purpose, because a document id and
// a class say everything the operator can act on.
//
// So the digest now names documents by ID and groups them by OWNER, and it
// prints a filename ONLY for documents created by an account listed in
//
//   INGEST_MONITOR_FILENAME_OWNERS=<uuid>[,<uuid>…]
//
// which is EMPTY BY DEFAULT — out of the box no filename is printed at all,
// including the operator's own. The value is auth user ids (documents.
// created_by), not email addresses: an email would need a profiles lookup that
// can drift, and the point of this list is that it cannot quietly widen. Find
// yours in the Vault (any document you filed) or in Supabase → Authentication.
// An id that owns nothing simply matches nothing.
//
// Exit codes: 0 healthy · 1 needs attention · 2 could not run (bad creds etc.)
//
// Usage:
//   node scripts/ingest-monitor.mjs
//   node scripts/ingest-monitor.mjs --matter fleming
//   node scripts/ingest-monitor.mjs --fix --max-fix 50
//   node scripts/ingest-monitor.mjs --quiet --email      (Task Scheduler)

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyError, classifyTextStatus, classifyOcrPending, TEXT_STATUS_CLASSES, summarize, describe } from '../lib/ingest-triage.mjs';
import { JOB_PRIORITY, SUPPORTED_EXTENSIONS, IMAGE_EXTENSIONS, MEDIA_EXTENSIONS, describeOcrPending } from '../lib/ingest-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Known, deliberately-parked backlogs. These are not news — reporting them
// every run trains the reader to ignore the digest, which defeats the purpose.
// Anything listed here is counted but not escalated.
const MUTED = {
  documents: [
    '82c752fa-0000-0000-0000-000000000000', // placeholder shape; see --mute-doc
  ],
  // stored-and-viewable is their normal resting state — including every
  // row that RECORDED why it is empty (metadata.text_status, 2026-09-04).
  // ocr_held_sealed: scanned pages the SecureSpace seal kept in; the typed
  // pages are indexed, and nothing changes until a sealed OCR route exists.
  reasons: ['no_text', 'duplicate_of_indexed', 'stored_without_text', 'ocr_held_sealed', ...TEXT_STATUS_CLASSES],
};

const TRANSIENT = ['pending', 'extracting', 'chunking', 'embedding'];

// Extensions whose whole purpose is text. `ready` with zero passages on one of
// these is never benign. Images and media are excluded on purpose:
// store-and-display is a legitimate resting state for a photo or an
// untranscribed recording, and flagging thousands of them would train the
// reader to ignore the digest.
const TEXT_BEARING = SUPPORTED_EXTENSIONS.filter(
  (e) => !IMAGE_EXTENSIONS.includes(e) && !MEDIA_EXTENSIONS.includes(e));

const args = parseArgs(process.argv.slice(2));
const STALE_MIN = numOr(args['stale-minutes'], 45);
const MAX_FIX = numOr(args['max-fix'], 25);
const QUIET = !!args.quiet;

// Run only when invoked as a script. The redaction functions below are
// imported and asserted by scripts/_verify-ingest-day-one.mjs, which must not
// start a live sweep by importing this file. Compared case-insensitively:
// Windows hands the same path back with a different drive-letter case.
const samePath = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
if (process.argv[1] && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error(e.message); process.exit(2); });
}

async function main() {
  await loadEnv(path.resolve(__dirname, '..', '.env'));
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  if (/^PASTE_/.test(key)) {
    fail('SUPABASE_SERVICE_ROLE_KEY is still the PASTE_NEW_… placeholder.\n' +
         'New secret key: https://supabase.com/dashboard/project/glegjwxosocbyquzmtqs/settings/api-keys');
  }
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const matterId = args.matter ? await resolveMatter(sb, args.matter) : null;
  const cutoff = new Date(Date.now() - STALE_MIN * 60_000).toISOString();

  const workers = await fetchWorkerLiveness(sb);
  const seal = await fetchSealDrift(sb);

  const [errored, stalled, jobs, readyEmpty, ocrPending] = await Promise.all([
    fetchDocs(sb, matterId, (q) => q.eq('processing_status', 'error')),
    fetchDocs(sb, matterId, (q) => q.in('processing_status', TRANSIENT).lt('updated_at', cutoff)),
    fetchStuckJobs(sb, cutoff),
    args['no-empty-check']
      // Skipping is the operator's explicit choice, so it stays green — the
      // note says it was skipped. A check that FAILED is a different thing
      // (degraded), and it is not green.
      ? Promise.resolve({ rows: [], degraded: false, note: 'skipped (--no-empty-check)' })
      : fetchReadyEmpty(sb, matterId),
    fetchOcrPending(sb, matterId),
  ]);

  const rows = [
    ...errored.map((d) => ({
      id: d.id, name: d.source_filename || d.title, matter: d.matterspace_id, owner: d.created_by,
      error: d.processing_error, cls: classifyError(d.processing_error),
    })),
    ...stalled.map((d) => ({
      id: d.id, name: d.source_filename || d.title, matter: d.matterspace_id, owner: d.created_by,
      error: `stuck in '${d.processing_status}' since ${d.updated_at}`, cls: 'stuck',
    })),
    // A row whose emptiness IS the pending OCR is reported once, below, with
    // the fuller record (which pages, retrying or exhausted).
    ...readyEmpty.rows.filter((d) => d.text_status !== 'ocr_pending').map((d) => ({
      id: d.document_id, name: d.source_filename || d.title, matter: d.matterspace_id, owner: d.created_by,
      error: 'ready with zero passages', cls: classifyEmpty(d),
    })),
    ...ocrPending.map((d) => ({
      id: d.id, name: d.source_filename || d.title, matter: d.matterspace_id, owner: d.created_by,
      error: `${describeOcrPending(d.ocr_pending)?.label}: ${d.ocr_pending.reason || 'no reason recorded'}`,
      cls: classifyOcrPending(d.ocr_pending),
    })),
  ].filter((r) => !MUTED.documents.includes(r.id));

  const report = summarize(rows);
  const escalate = report.groups.filter((g) => !MUTED.reasons.includes(g.cls));
  const escalatedClasses = new Set(escalate.map((g) => g.cls));
  const escalatedRows = rows.filter((r) => escalatedClasses.has(r.cls));
  // A check that did not run is not a pass. Until 2026-09-20 a timed-out
  // ready-but-empty check left `rows: []`, so the digest printed "All
  // documents are ready" and exited 0 with the question unanswered — the same
  // silent-success shape as the scans this monitor was built after.
  const needsAttention = escalate.some((g) => g.severity === 'blocking') || jobs.length > 0 || workers.down
    || readyEmpty.degraded || seal.red;

  if (QUIET && !needsAttention && report.total === 0) process.exit(0);

  const text = [...sealDriftLines(seal), render({
    report, escalate, escalatedRows, jobs, matter: args.matter,
    staleMin: STALE_MIN, emptyNote: readyEmpty.note, emptyDegraded: readyEmpty.degraded,
    allowed: parseFilenameOwners(), workers,
  })].join('\n');
  if (!QUIET || needsAttention) console.log(text);

  if (args.fix) await autoFix(sb, rows, report);
  // A failed send must not turn a finished health check into "could not run"
  // (exit 2) — the digest is already printed above, and the exit code is the
  // only signal Task Scheduler keeps. Found 2026-09-04: Gmail refused the app
  // password ("534-5.7.9 Please log in with your web browser") and every
  // scheduled run would have reported 2 with the real answer thrown away.
  const alert = alertHeadline({ workers, stalledCount: stalled.length, staleMin: STALE_MIN, emptyDegraded: readyEmpty.degraded });
  if (args.email && (needsAttention || !QUIET)) {
    try { await emailDigest(text, needsAttention, alert); }
    catch (e) { console.error(`(--email failed: ${String(e.message || e).split('\n')[0]} — digest printed above, not sent)`); }
  }

  process.exit(needsAttention ? 1 : 0);
}

// -----------------------------------------------------------------------------
// The seal's own column (migration 098). matterspaces.sealed_effective is kept
// by triggers and read by every access check; sealed_effective_drift() lists
// any matter where it disagrees with the ancestry walk. One row is a matter
// whose seal the access checks are not applying (or are applying wrongly), so
// any row is red, and so is a check that could not run. Not deployed yet
// (PGRST202) is said once and is not red.
export async function fetchSealDrift(sb) {
  try {
    const { data, error } = await sb.rpc('sealed_effective_drift');
    if (error) {
      if (error.code === 'PGRST202' || /could not find the function/i.test(error.message ?? '')) {
        return { available: false, rows: [], red: false, note: 'not deployed (migration 098 not pasted)' };
      }
      return { available: true, rows: [], red: true, note: `could not run: ${error.message}` };
    }
    const rows = Array.isArray(data) ? data : [];
    return { available: true, rows, red: rows.length > 0, note: null };
  } catch (e) {
    return { available: true, rows: [], red: true, note: `could not run: ${e?.message ?? e}` };
  }
}

export function sealDriftLines(seal) {
  if (!seal) return [];
  if (!seal.available) return [`Seal column: ${seal.note}.`, ''];
  if (seal.note) {
    return [`SEAL CHECK NOT GREEN — sealed_effective_drift() ${seal.note}.`,
      '  Whether every sealed matter is being treated as sealed could not be established.', ''];
  }
  if (seal.rows.length === 0) return ['Seal column: agrees with the ancestry walk on every matter.', ''];
  return [
    `SEAL DRIFT: ${seal.rows.length} matter(s) where sealed_effective disagrees with the tier walk.`,
    '  The access checks read the column, so these matters are not protected as their tier says.',
    ...seal.rows.slice(0, 20).map((r) => `  ${r.matterspace_id}  column=${r.column_value}  walk=${r.walk_value}`),
    '  Fix (service role, SQL editor): update matterspaces set ai_tier = ai_tier where id in (…);',
    '  — the trigger recomputes each row and its children. Then find out how it drifted.',
    '',
  ];
}

// -----------------------------------------------------------------------------
// Queries — paginated past PostgREST's 1000-row default. The July sweep looked
// clean partly because nobody paged: check_ingest_status caps its error list at
// 30, so a matter with 300 failures reported 30 and looked survivable.
// -----------------------------------------------------------------------------
async function fetchDocs(sb, matterId, apply) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from('documents')
      .select('id, title, source_filename, processing_status, processing_error, updated_at, matterspace_id, created_by')
      .range(from, from + 999);
    if (matterId) q = q.eq('matterspace_id', matterId);
    const { data, error } = await apply(q);
    if (error) throw new Error(`query documents: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// Proof of life for the worker itself (migration 066). Every other check here
// infers the worker's health from its WORK — which cannot distinguish "the
// worker is down" from "nobody uploaded anything", and on a quiet night those
// look identical. A worker beats once a minute whether or not there is a job,
// so this is the one check that fires while the queue is empty, which is
// exactly when the damage is being done invisibly.
//
// Degrades the way fetchReadyEmpty does: a missing table is "unavailable —
// paste migration 066", never an alert. A watchdog that cries about its own
// dependencies gets muted, and then it protects nothing.
const WORKER_ALIVE_MINUTES = 10;
async function fetchWorkerLiveness(sb) {
  const { data, error } = await sb.from('worker_heartbeats')
    .select('worker_id, machine_id, worker_release, started_at, last_beat_at, last_job_at, jobs_done')
    .order('last_beat_at', { ascending: false })
    .limit(20);
  if (error) {
    const missing = /could not find|does not exist|PGRST205|42P01|404/i.test(error.message);
    return { available: false, down: false, rows: [], note: missing ? 'unavailable — paste migration 066' : `failed: ${error.message}` };
  }
  const rows = data || [];
  const cutoff = Date.now() - WORKER_ALIVE_MINUTES * 60_000;
  const alive = rows.filter((r) => Date.parse(r.last_beat_at) > cutoff);
  return {
    available: true,
    // Never beaten at all is not "down": it is a worker that has not yet been
    // deployed with the heartbeat. Saying "DOWN" there would make the first
    // alert a false one, which is how an alert channel dies.
    down: rows.length > 0 && alive.length === 0,
    everBeaten: rows.length > 0,
    alive: alive.length,
    rows,
    note: null,
  };
}

async function fetchStuckJobs(sb, cutoff) {
  // processing_jobs has no updated_at (it has claimed_at / heartbeat_at).
  // Until 2026-09-04 this select named updated_at, PostgREST answered 42703,
  // and the silent `return []` below meant the WORKER alert could never fire
  // — a monitor blind spot found while watching a requeue drain. A running
  // job whose heartbeat is fresh is working, not stuck (a 480-page OCR takes
  // longer than the staleness window); only jobs with no recent heartbeat
  // — or queued past the window — count.
  const { data, error } = await sb.from('processing_jobs')
    .select('id, job_type, status, created_at, claimed_at, heartbeat_at, payload')
    .in('status', ['queued', 'running'])
    .lt('created_at', cutoff)
    .limit(200);
  if (error) {
    // Say so rather than hiding it: "no stuck jobs" must not be the answer to
    // "the query failed".
    console.error(`(stuck-job check failed: ${error.message})`);
    return [];
  }
  return (data || []).filter((j) => !(j.status === 'running' && (j.heartbeat_at || j.claimed_at || '') > cutoff));
}

// The audit's headline class, as one RPC (migration 059): every `ready`
// document with zero passages, each carrying has_indexed_twin so a duplicate
// whose canonical copy IS searchable folds into known-benign. Classification
// lives here, next to the extension lists. Degrades gracefully when 059 has
// not been pasted — a watchdog that dies on a missing dependency protects
// nothing.
export async function fetchReadyEmpty(sb, matterId) {
  // PostgREST caps ANY response — a set-returning RPC included — at 1,000 rows,
  // and it truncates SILENTLY. The first live run of this check reported
  // exactly 1,000 empty documents out of ~4,000 and looked healthy doing it —
  // the precise failure mode this monitor exists to end. Page until the short
  // page; .order() makes the walk stable across pages.
  const rows = [];
  for (let from = 0; ; from += 1000) {
    // A statement timeout here is not an answer. The RPC sits near the 8s
    // ceiling at ~46k documents (it ran at 17:44Z on 2026-09-20 and timed out
    // at 19:35Z), and a timeout is usually load, not a broken query — so try
    // again before giving up. Migration 081 makes the query cheap; this keeps
    // a slow minute from costing the check.
    let data; let error;
    for (let attempt = 1; ; attempt++) {
      ({ data, error } = await sb.rpc('ready_but_empty').order('document_id').range(from, from + 999));
      if (!error || attempt >= 3 || !isTransient(error.message)) break;
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
    if (error) {
      const missing = /could not find|does not exist|PGRST202|404/i.test(error.message);
      // Either way the check did not run, so this monitor CANNOT say the
      // corpus is healthy: 'ready with zero passages' is precisely the class
      // it exists to catch. `degraded` makes the run not-green instead of
      // letting an unanswered question read as an all-clear (2026-09-20).
      return {
        rows: [],
        degraded: true,
        note: missing ? 'unavailable — paste migration 059' : `failed: ${error.message}`,
      };
    }
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const scoped = rows.filter((d) => !matterId || d.matterspace_id === matterId);
  await attachTextStatus(sb, scoped);
  return { rows: scoped, degraded: false, note: null };
}

// Worth another try: load, a cancelled statement, a dropped connection.
// Not a missing function, not a permission refusal.
export function isTransient(message) {
  return /statement timeout|canceling statement|57014|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|timeout/i.test(String(message || ''));
}

// The 059 RPC returns the raw fact (ready, zero passages) and nothing about
// WHY. Since 2026-09-04 ingest-core records the why on the row as
// metadata.text_status; read it here in batches so a row that said its reason
// is classified by that reason, and only the rows that said nothing fall back
// to the extension guess. Batched by id (200 per request, well under
// PostgREST's URL limit) rather than a new migration.
async function attachTextStatus(sb, rows) {
  const byId = new Map(rows.map((r) => [r.document_id, r]));
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    // created_by comes from here too: the 059 RPC returns the fact, not the
    // owner, and the digest groups by owner (see the privacy note at the top).
    const { data, error } = await sb.from('documents')
      .select('id, created_by, text_status:metadata->>text_status')
      .in('id', ids.slice(i, i + 200));
    if (error) return;   // classification degrades to the extension guess
    for (const d of data || []) {
      const r = byId.get(d.id);
      if (!r) continue;
      if (d.text_status) r.text_status = d.text_status;
      if (d.created_by) r.created_by = d.created_by;
    }
  }
}

// Documents whose scanned pages still await OCR (metadata.ocr_pending, Phase
// 2). They are 'ready' — the typed pages are indexed — so neither the error
// nor the stalled query sees them; read the record directly, paged like the
// rest. Retrying ones are transient (the worker's idle sweep owns the
// schedule), exhausted ones need a person, sealed ones are muted until a
// sealed OCR route exists.
async function fetchOcrPending(sb, matterId) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from('documents')
      .select('id, title, source_filename, matterspace_id, created_by, ocr_pending:metadata->ocr_pending')
      .eq('processing_status', 'ready')
      .not('metadata->ocr_pending', 'is', null)
      .order('id').range(from, from + 999);
    if (matterId) q = q.eq('matterspace_id', matterId);
    const { data, error } = await q;
    if (error) { console.error(`(ocr_pending check failed: ${error.message})`); break; }
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows.filter((d) => d.ocr_pending && typeof d.ocr_pending === 'object');
}

function classifyEmpty(d) {
  if (d.has_indexed_twin) return 'duplicate_of_indexed';
  const recorded = classifyTextStatus(d.text_status);
  if (recorded) return recorded;
  return TEXT_BEARING.includes(extOf(d.source_filename)) ? 'ready_but_empty' : 'stored_without_text';
}

function extOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i < 0 ? '' : s.slice(i).toLowerCase();
}

async function resolveMatter(sb, code) {
  const { data } = await sb.from('matterspaces').select('id')
    .or(`short_code.eq.${code},id.eq.${code}`).maybeSingle();
  if (!data) fail(`matter not found: ${code}`);
  return data.id;
}

// -----------------------------------------------------------------------------
// Auto-fix — requeue only what the triage table calls retryable, and only up to
// --max-fix per run. A watchdog that can start an unbounded amount of paid work
// is a worse problem than the one it solves.
// -----------------------------------------------------------------------------
async function autoFix(sb, rows, report) {
  const eligible = rows.filter((r) => describe(r.cls).retryable && !MUTED.reasons.includes(r.cls));
  const targets = eligible.slice(0, MAX_FIX);
  if (!targets.length) return console.log('\n--fix: nothing safely retryable.');

  console.log(`\n--fix: requeueing ${targets.length} document(s) (cap ${MAX_FIX})`);
  let queued = 0;
  for (const t of targets) {
    const { data: dupe } = await sb.from('processing_jobs')
      .select('id').eq('job_type', 'ingest_document').in('status', ['queued', 'running'])
      .contains('payload', { document_id: t.id }).limit(1);
    if (dupe?.length) continue;                       // already in flight

    // matterspace_id is NOT NULL on processing_jobs; this insert used to omit
    // it and fail every time. BULK priority: a sweep must never hold up a
    // person's single upload (migration 057).
    const { error } = await sb.from('processing_jobs').insert({
      matterspace_id: t.matter, job_type: 'ingest_document', status: 'queued',
      priority: JOB_PRIORITY.BULK, payload: { document_id: t.id },
    });
    if (error) { console.log(`  ! ${describeRow(t, parseFilenameOwners())}: ${error.message}`); continue; }
    await sb.from('documents')
      .update({ processing_status: 'pending', processing_error: null })
      .eq('id', t.id);
    queued++;
  }
  if (queued === 0) {
    // Announcing "requeueing 20" and then queueing none is the shape of a
    // silent no-op. Say so in the summary, not only in the scrolled-past rows.
    console.log(`  QUEUED NOTHING — all ${targets.length} insert(s) failed. See the ! lines above; nothing was retried.`);
    process.exitCode = 2;
    return;
  }
  console.log(`  queued ${queued}${queued < targets.length ? ` of ${targets.length} (${targets.length - queued} failed or already in flight)` : ''}. The worker picks these up within a poll cycle (~5s).`);
  // Count only what a re-run would actually queue. This used to print
  // report.total, which includes the thousands of known-benign rows, and so
  // said "4127 remain" after queueing everything retryable.
  if (eligible.length > MAX_FIX) {
    console.log(`  ${eligible.length - MAX_FIX} more retryable remain — re-run --fix, or raise --max-fix.`);
  }
}

// -----------------------------------------------------------------------------
// Rendering — and the privacy rule that decides what may appear in it
// -----------------------------------------------------------------------------

/**
 * The accounts whose filenames may be printed, read from
 * INGEST_MONITOR_FILENAME_OWNERS. Empty by default, which is the whole point:
 * a monitor that has to be told before it will name anything cannot widen by
 * accident when the second tenant arrives. Exported for the offline test.
 */
export function parseFilenameOwners(env = process.env) {
  return new Set(
    String(env.INGEST_MONITOR_FILENAME_OWNERS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** "a1b2c3d4" — enough to tell two owners apart, not enough to be an identifier. */
export function shortOwner(owner) {
  const s = String(owner || '');
  return s ? s.slice(0, 8) : 'unknown';
}

/**
 * One line for one escalated document. A document id is what the operator
 * acts on — every repair script, every re-run, every support reply takes an
 * id — so the id is always shown. The filename is shown only when the
 * document's owner is on the allow-list, because a filename is the client's
 * content: "Doe v. Archdiocese — settlement terms.pdf" says more about a
 * stranger's matter than any operator needs to know to requeue a job.
 * Exported for the offline test.
 */
export function describeRow(row, allowed) {
  const owner = String(row?.owner || '').toLowerCase();
  const id = row?.id || '(no id)';
  const who = `owner ${shortOwner(owner)}`;
  if (owner && allowed.has(owner)) return `${id}  (${who})  ${trunc(row?.name, 60)}`;
  return `${id}  (${who})`;
}

/**
 * How many escalated documents each owner has. Counts are safe to send
 * anywhere; they are what says "this is one tenant's bad night" rather than
 * "the pipeline is broken".
 */
export function ownerCounts(rows) {
  const byOwner = new Map();
  for (const r of rows) {
    const k = shortOwner(r?.owner);
    byOwner.set(k, (byOwner.get(k) || 0) + 1);
  }
  return [...byOwner.entries()]
    .map(([owner, count]) => ({ owner, count }))
    .sort((a, b) => b.count - a.count || a.owner.localeCompare(b.owner));
}

export function render({ report, escalate, escalatedRows = [], jobs, matter, staleMin, emptyNote, emptyDegraded = false, allowed = new Set(), workers = null }) {
  const L = [];
  const scope = matter ? `matter "${matter}"` : 'all matters';
  L.push(`Contextspaces ingestion health — ${scope}`);
  L.push(new Date().toISOString());
  L.push('');

  // Said FIRST, and said even on an otherwise perfectly green night: a dead
  // worker with an empty queue produces no stuck documents and no stuck jobs,
  // so every other line below would read "healthy" while nothing at all was
  // being processed. That silence is the failure this block exists to break.
  if (workers && workers.available) {
    if (workers.down) {
      const newest = workers.rows[0];
      const mins = newest ? Math.round((Date.now() - Date.parse(newest.last_beat_at)) / 60_000) : null;
      L.push(`WORKER DOWN: no ingestion worker has reported in for ${mins ?? '?'} minutes.`);
      L.push('  Nothing is being processed. Every upload since then is sitting in the queue.');
      L.push('  Check:   flyctl status -a contextspaces-worker');
      L.push('  Restart: flyctl machine restart -a contextspaces-worker');
      if (newest) L.push(`  Last seen: ${newest.worker_id} (${newest.machine_id || '—'}) at ${newest.last_beat_at}`);
      L.push('');
    } else if (workers.everBeaten) {
      const newest = workers.rows[0];
      L.push(`Worker: ${workers.alive} alive · last beat ${newest.last_beat_at}${newest.worker_release ? ` · ${newest.worker_release}` : ''}`);
      L.push('');
    } else {
      L.push('Worker: no heartbeat has ever been recorded — deploy the Fly worker with the 066 heartbeat.');
      L.push('');
    }
  } else if (workers && workers.note) {
    L.push(`Worker liveness: ${workers.note}`);
    L.push('');
  }

  // The headline counts only what needs eyes. Before 059 this said "All
  // documents are ready" over an index that was 60.5% searchable — the benign
  // classes are still COUNTED, but they no longer masquerade as health.
  const escalatedTotal = escalate.reduce((s, g) => s + g.count, 0);
  if (escalatedTotal === 0 && jobs.length === 0) {
    // Nothing escalated — but say so only if the check that finds the
    // silent class actually ran. Otherwise the honest headline is "I could
    // not look", and the run is not green.
    if (emptyDegraded) {
      L.push('NOT GREEN — health could not be established this run.');
      L.push(`The ready-but-empty check ${emptyNote}, so documents that are 'ready' with zero passages`);
      L.push('(a scan nobody read, an upload that indexed nothing) could not be seen. Nothing below rules them out.');
      L.push('');
      L.push('Re-run the monitor; if it keeps timing out, ready_but_empty() needs migration 081 (it makes the query cheap).');
      L.push('');
    } else {
      L.push('All documents are ready, and every text-bearing document is searchable.');
    }
    const mutedG = report.groups.filter((g) => MUTED.reasons.includes(g.cls));
    if (mutedG.length) L.push('Known-benign: ' + mutedG.map((g) => `${g.label} ×${g.count}`).join(', '));
    if (emptyNote && !emptyDegraded) L.push(`(ready-but-empty check ${emptyNote})`);
    return L.join('\n');
  }
  if (emptyDegraded) {
    L.push(`NOT GREEN — the ready-but-empty check ${emptyNote}; ready-with-zero-passages documents are NOT covered by the counts below.`);
    L.push('');
  }

  L.push(`${escalatedTotal} document(s) not searchable${report.total > escalatedTotal ? ` (+${report.total - escalatedTotal} known-benign)` : ''}.`);
  if (emptyNote) L.push(`(ready-but-empty check ${emptyNote})`);
  L.push(`  ${report.needsHuman} need a decision from you`);
  L.push(`  ${report.autoRetryable} should clear on a re-run (--fix)`);

  if (jobs.length) {
    L.push('');
    L.push(`WORKER: ${jobs.length} job(s) queued/running for over ${staleMin} min.`);
    L.push('  The Fly worker may be down. Check: flyctl status -a contextspaces-worker');
    L.push('  Restart:                        flyctl machine restart -a contextspaces-worker');
  }

  {
    // Whose documents these are, in counts, over EVERY escalated row (not the
    // five kept as examples). Printed before the classes so the first question
    // a multi-tenant digest raises — "is this one account?" — is answered
    // without naming anything.
    const owners = ownerCounts(escalatedRows);
    if (owners.length) {
      L.push('');
      L.push(`By owner: ${owners.map((o) => `${o.owner} ×${o.count}`).join(', ')}`);
    }
  }

  for (const g of escalate) {
    L.push('');
    L.push(`[${g.severity.toUpperCase()}] ${g.label} — ${g.count} document(s)`);
    L.push(`  What to do: ${g.action}`);
    for (const ex of g.examples.slice(0, 4)) {
      L.push(`    · ${describeRow(ex, allowed)}`);
    }
    if (g.count > 4) L.push(`    …and ${g.count - 4} more`);
  }
  if (!allowed.size) {
    L.push('');
    L.push('Documents are named by id only. To see filenames for your own account, set');
    L.push('INGEST_MONITOR_FILENAME_OWNERS=<your auth user id> in .env (never another tenant\'s).');
  }

  const muted = report.groups.filter((g) => MUTED.reasons.includes(g.cls));
  if (muted.length) {
    L.push('');
    L.push('Known-benign (not escalated): ' + muted.map((g) => `${g.label} ×${g.count}`).join(', '));
  }
  return L.join('\n');
}

// The two conditions that are worth waking someone for — a worker that has
// stopped, and a document nobody is processing — go out on the SAME Gmail
// transport as the routine digest, with the fact in the SUBJECT line. No new
// vendor, no paid tier, and nothing to rotate.
//
// The subject matters more than the body here: set
//
//   INGEST_ALERT_TO=5551234567@vtext.com        (or any other address)
//
// and an urgent digest also goes there. Carrier email-to-SMS gateways deliver
// the subject and truncate the body, which is why the subject carries the
// whole fact. Unset, everything goes where it goes today. Comma-separated for
// more than one. Routine digests never go to this list — an alert channel that
// carries routine traffic is an alert channel that gets muted.
export function alertHeadline({ workers, stalledCount, staleMin, emptyDegraded = false }) {
  if (emptyDegraded) return 'ready-but-empty check did NOT run — health unverified';
  if (workers && workers.available && workers.down) {
    const newest = workers.rows[0];
    const mins = newest ? Math.round((Date.now() - Date.parse(newest.last_beat_at)) / 60_000) : null;
    return `WORKER DOWN ${mins ?? '?'}m — nothing is processing`;
  }
  if (stalledCount > 0) return `${stalledCount} document(s) stuck > ${staleMin}m`;
  return null;
}

async function emailDigest(text, needsAttention, alert = null) {
  const to = process.env.GMAIL_ADDRESS;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!to || !pass) return console.log('\n(--email skipped: GMAIL_ADDRESS / GMAIL_APP_PASSWORD not set)');
  const { default: nodemailer } = await import('nodemailer');
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: to, pass } });
  const subject = alert
    ? `Contextspaces ALERT: ${alert}`
    : needsAttention
      ? 'Contextspaces: ingestion needs attention'
      : 'Contextspaces: ingestion healthy';
  const extra = alert
    ? String(process.env.INGEST_ALERT_TO || '').split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const recipients = [to, ...extra];
  await t.sendMail({ from: to, to: recipients.join(', '), subject, text });
  console.log(`\nDigest emailed to ${recipients.join(', ')}`);
}

// -----------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2), next = argv[i + 1];
      if (!next || next.startsWith('--')) out[k] = true;
      else { out[k] = next; i++; }
    } else out._.push(a);
  }
  return out;
}
async function loadEnv(file) {
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return; }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = t.slice(i + 1).trim();
  }
}
function numOr(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function trunc(s, n) { s = String(s || '(untitled)'); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function fail(m) { console.error(`\n${m}\n`); process.exit(2); }
