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
//
// What it does about it:
//   default        report only
//   --fix          requeue the classes marked retryable (bounded by --max-fix)
//   --email        send the digest to GMAIL_ADDRESS
//   --quiet        print/send nothing when everything is healthy (cron mode)
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

import { classifyError, summarize, describe } from '../lib/ingest-triage.mjs';
import { JOB_PRIORITY, SUPPORTED_EXTENSIONS, IMAGE_EXTENSIONS, MEDIA_EXTENSIONS } from '../lib/ingest-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Known, deliberately-parked backlogs. These are not news — reporting them
// every run trains the reader to ignore the digest, which defeats the purpose.
// Anything listed here is counted but not escalated.
const MUTED = {
  documents: [
    '82c752fa-0000-0000-0000-000000000000', // placeholder shape; see --mute-doc
  ],
  reasons: ['no_text', 'duplicate_of_indexed', 'stored_without_text'],  // stored-and-viewable is their normal resting state
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

main().catch((e) => { console.error(e.message); process.exit(2); });

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

  const [errored, stalled, jobs, readyEmpty] = await Promise.all([
    fetchDocs(sb, matterId, (q) => q.eq('processing_status', 'error')),
    fetchDocs(sb, matterId, (q) => q.in('processing_status', TRANSIENT).lt('updated_at', cutoff)),
    fetchStuckJobs(sb, cutoff),
    args['no-empty-check']
      ? Promise.resolve({ rows: [], note: 'skipped (--no-empty-check)' })
      : fetchReadyEmpty(sb, matterId),
  ]);

  const rows = [
    ...errored.map((d) => ({
      id: d.id, name: d.source_filename || d.title, matter: d.matterspace_id,
      error: d.processing_error, cls: classifyError(d.processing_error),
    })),
    ...stalled.map((d) => ({
      id: d.id, name: d.source_filename || d.title, matter: d.matterspace_id,
      error: `stuck in '${d.processing_status}' since ${d.updated_at}`, cls: 'stuck',
    })),
    ...readyEmpty.rows.map((d) => ({
      id: d.document_id, name: d.source_filename || d.title, matter: d.matterspace_id,
      error: 'ready with zero passages', cls: classifyEmpty(d),
    })),
  ].filter((r) => !MUTED.documents.includes(r.id));

  const report = summarize(rows);
  const escalate = report.groups.filter((g) => !MUTED.reasons.includes(g.cls));
  const needsAttention = escalate.some((g) => g.severity === 'blocking') || jobs.length > 0;

  if (QUIET && !needsAttention && report.total === 0) process.exit(0);

  const text = render({ report, escalate, jobs, matter: args.matter, staleMin: STALE_MIN, emptyNote: readyEmpty.note });
  if (!QUIET || needsAttention) console.log(text);

  if (args.fix) await autoFix(sb, rows, report);
  if (args.email && (needsAttention || !QUIET)) await emailDigest(text, needsAttention);

  process.exit(needsAttention ? 1 : 0);
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
      .select('id, title, source_filename, processing_status, processing_error, updated_at, matterspace_id')
      .range(from, from + 999);
    if (matterId) q = q.eq('matterspace_id', matterId);
    const { data, error } = await apply(q);
    if (error) throw new Error(`query documents: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

async function fetchStuckJobs(sb, cutoff) {
  const { data, error } = await sb.from('processing_jobs')
    .select('id, job_type, status, created_at, updated_at, payload')
    .in('status', ['queued', 'running'])
    .lt('created_at', cutoff)
    .limit(200);
  if (error) return [];   // table may not exist in older environments
  return data || [];
}

// The audit's headline class, as one RPC (migration 059): every `ready`
// document with zero passages, each carrying has_indexed_twin so a duplicate
// whose canonical copy IS searchable folds into known-benign. Classification
// lives here, next to the extension lists. Degrades gracefully when 059 has
// not been pasted — a watchdog that dies on a missing dependency protects
// nothing.
async function fetchReadyEmpty(sb, matterId) {
  // PostgREST caps ANY response — a set-returning RPC included — at 1,000 rows,
  // and it truncates SILENTLY. The first live run of this check reported
  // exactly 1,000 empty documents out of ~4,000 and looked healthy doing it —
  // the precise failure mode this monitor exists to end. Page until the short
  // page; .order() makes the walk stable across pages.
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.rpc('ready_but_empty')
      .order('document_id')
      .range(from, from + 999);
    if (error) {
      const missing = /could not find|does not exist|PGRST202|404/i.test(error.message);
      return { rows: [], note: missing ? 'unavailable — paste migration 059' : `failed: ${error.message}` };
    }
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return { rows: rows.filter((d) => !matterId || d.matterspace_id === matterId), note: null };
}

function classifyEmpty(d) {
  if (d.has_indexed_twin) return 'duplicate_of_indexed';
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
  const targets = rows
    .filter((r) => describe(r.cls).retryable && !MUTED.reasons.includes(r.cls))
    .slice(0, MAX_FIX);
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
    if (error) { console.log(`  ! ${t.name}: ${error.message}`); continue; }
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
  if (report.total > MAX_FIX) {
    console.log(`  ${report.total - MAX_FIX} remain — re-run --fix, or raise --max-fix.`);
  }
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------
function render({ report, escalate, jobs, matter, staleMin, emptyNote }) {
  const L = [];
  const scope = matter ? `matter "${matter}"` : 'all matters';
  L.push(`Contextspaces ingestion health — ${scope}`);
  L.push(new Date().toISOString());
  L.push('');

  // The headline counts only what needs eyes. Before 059 this said "All
  // documents are ready" over an index that was 60.5% searchable — the benign
  // classes are still COUNTED, but they no longer masquerade as health.
  const escalatedTotal = escalate.reduce((s, g) => s + g.count, 0);
  if (escalatedTotal === 0 && jobs.length === 0) {
    L.push('All documents are ready, and every text-bearing document is searchable.');
    const mutedG = report.groups.filter((g) => MUTED.reasons.includes(g.cls));
    if (mutedG.length) L.push('Known-benign: ' + mutedG.map((g) => `${g.label} ×${g.count}`).join(', '));
    if (emptyNote) L.push(`(ready-but-empty check ${emptyNote})`);
    return L.join('\n');
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

  for (const g of escalate) {
    L.push('');
    L.push(`[${g.severity.toUpperCase()}] ${g.label} — ${g.count} document(s)`);
    L.push(`  What to do: ${g.action}`);
    for (const ex of g.examples.slice(0, 4)) {
      L.push(`    · ${trunc(ex.name, 68)}`);
    }
    if (g.count > 4) L.push(`    …and ${g.count - 4} more`);
  }

  const muted = report.groups.filter((g) => MUTED.reasons.includes(g.cls));
  if (muted.length) {
    L.push('');
    L.push('Known-benign (not escalated): ' + muted.map((g) => `${g.label} ×${g.count}`).join(', '));
  }
  return L.join('\n');
}

async function emailDigest(text, needsAttention) {
  const to = process.env.GMAIL_ADDRESS;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!to || !pass) return console.log('\n(--email skipped: GMAIL_ADDRESS / GMAIL_APP_PASSWORD not set)');
  const { default: nodemailer } = await import('nodemailer');
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: to, pass } });
  const subject = needsAttention
    ? 'Contextspaces: ingestion needs attention'
    : 'Contextspaces: ingestion healthy';
  await t.sendMail({ from: to, to, subject, text });
  console.log(`\nDigest emailed to ${to}`);
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
