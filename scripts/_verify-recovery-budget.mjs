// Live proof that document recovery now terminates (2026-08-22 ingestion
// audit, fix 1). Run AFTER pasting migration 055.
//
//   node scripts/_verify-recovery-budget.mjs
//   node scripts/_verify-recovery-budget.mjs --matter admin
//
// ⚠ THIS SCRIPT WRITES TO THE DATABASE. It creates three throwaway documents
// (titled __verify-recovery-budget__…, storage_path pointing at nothing) plus
// their queue rows, calls recover_stranded_documents(1), asserts on what it did,
// and deletes everything it made — including on failure. It never touches a
// real document, never deletes anything it did not create, and never uploads.
//
// What it pins, scenario by scenario:
//
//   A. budget spent      A document whose job has burned max_attempts must end
//                        TERMINAL and VISIBLE: processing_status 'error' with a
//                        readable processing_error — not requeued.
//   B. budget left       A document whose job has attempts remaining must be
//                        requeued BY REUSING THAT JOB ROW, attempts intact, and
//                        the number of job rows for that document must NOT grow.
//                        This is the regression: migration 044 inserted a fresh
//                        job every sweep, so max_attempts never fired and two
//                        documents reached 1,641 attempts each over 20 days.
//   C. no job at all     The original 044 case (a killed serverless function
//                        left no queue row) must still get exactly one job.
//
// B is the one that matters. Against 044's function it fails: the job count for
// that document goes from 1 to 2 in a single sweep.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SB = env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error('VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env'); process.exit(2); }
const supabase = createClient(SB, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

let wantMatter = null;
for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === '--matter') wantMatter = process.argv[++i];

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { console.log(`  FAIL  ${m}`); failures += 1; };
const ago = (mins) => new Date(Date.now() - mins * 60_000).toISOString();
const TAG = '__verify-recovery-budget__';
const created = { docs: [], jobs: [] };

async function cleanup() {
  if (created.jobs.length) await supabase.from('processing_jobs').delete().in('id', created.jobs);
  if (created.docs.length) {
    // Anything the sweep enqueued for our documents, too.
    for (const id of created.docs) {
      const { data: extra } = await supabase.from('processing_jobs')
        .select('id').eq('job_type', 'ingest_document').contains('payload', { document_id: id });
      if (extra?.length) await supabase.from('processing_jobs').delete().in('id', extra.map((j) => j.id));
    }
    await supabase.from('documents').delete().in('id', created.docs);
  }
  console.log(`\ncleaned up ${created.docs.length} document(s) and their queue rows.`);
}

process.on('unhandledRejection', async (e) => { console.error(e); await cleanup(); process.exit(2); });

try {
  // --- fixtures ------------------------------------------------------------
  let mq = supabase.from('matterspaces').select('id, name, short_code');
  if (wantMatter) mq = mq.eq('short_code', wantMatter);
  const { data: matters } = await mq.order('created_at', { ascending: true }).limit(1);
  const matter = matters?.[0];
  if (!matter) { console.error(wantMatter ? `no matter with short_code ${wantMatter}` : 'no matterspaces found'); process.exit(2); }

  const { data: profile } = await supabase.from('profiles').select('id').limit(1).single();
  if (!profile) { console.error('no profiles row to own the fixture documents'); process.exit(2); }
  console.log(`fixtures in "${matter.name}" (${matter.short_code ?? matter.id})\n`);

  async function makeDoc(suffix) {
    const { data, error } = await supabase.from('documents').insert({
      matterspace_id: matter.id,
      title: `${TAG} ${suffix}`,
      doc_type: 'other',
      source_filename: `${TAG}-${suffix}.txt`,
      storage_path: `${matter.id}/__verify__/${suffix}.txt`,   // deliberately points at nothing
      processing_status: 'embedding',                          // stranded mid-pipeline
      created_at: ago(180),
      created_by: profile.id,
    }).select('id').single();
    if (error) throw new Error(`fixture document: ${error.message}`);
    created.docs.push(data.id);
    return data.id;
  }

  async function makeJob(docId, { attempts, maxAttempts = 3, status = 'error' }) {
    const { data, error } = await supabase.from('processing_jobs').insert({
      matterspace_id: matter.id,
      job_type: 'ingest_document',
      payload: { document_id: docId },
      status,
      attempts,
      max_attempts: maxAttempts,
      error: 'fixture: pretend this file failed',
      created_at: ago(120),
      finished_at: ago(120),
    }).select('id').single();
    if (error) throw new Error(`fixture job: ${error.message}`);
    created.jobs.push(data.id);
    return data.id;
  }

  const jobsFor = async (docId) => {
    const { data } = await supabase.from('processing_jobs')
      .select('id, status, attempts, max_attempts')
      .eq('job_type', 'ingest_document')
      .contains('payload', { document_id: docId });
    return data ?? [];
  };
  const docOf = async (docId) => {
    const { data } = await supabase.from('documents')
      .select('processing_status, processing_error').eq('id', docId).single();
    return data;
  };

  const docA = await makeDoc('A-budget-spent');
  const jobA = await makeJob(docA, { attempts: 3, maxAttempts: 3 });
  const docB = await makeDoc('B-budget-left');
  const jobB = await makeJob(docB, { attempts: 1, maxAttempts: 3 });
  const docC = await makeDoc('C-no-job');

  // --- the sweep, exactly as the worker calls it ---------------------------
  const { data: recovered, error: rpcErr } = await supabase.rpc('recover_stranded_documents', { p_idle_minutes: 1 });
  if (rpcErr) {
    fail(`recover_stranded_documents: ${rpcErr.message}`);
    if (/could not choose|PGRST203/i.test(rpcErr.message)) {
      console.log('        (two overloads are live — 055 drops the single-argument version; re-apply it)');
    }
    throw new Error('sweep failed; nothing further can be asserted');
  }
  console.log(`recover_stranded_documents(1) returned ${recovered}\n`);

  // --- A: budget spent -> terminal and visible -----------------------------
  {
    const d = await docOf(docA);
    const jobs = await jobsFor(docA);
    if (d.processing_status === 'error') pass('A: exhausted document is terminal (processing_status = error)');
    else fail(`A: exhausted document is still "${d.processing_status}" — it will be retried forever`);
    if (d.processing_error && d.processing_error.length > 20) pass(`A: it says why — "${d.processing_error.slice(0, 70)}…"`);
    else fail('A: processing_error is empty, so the failure is invisible in the app');
    if (jobs.length === 1) pass('A: no new job was minted for it');
    else fail(`A: ${jobs.length} job rows for one exhausted document — the loop is still live`);
    if (jobs[0]?.status === 'error') pass('A: its job stays parked in error');
    else fail(`A: its job went to "${jobs[0]?.status}"`);
  }

  // --- B: budget left -> reuse the row, do not mint a new one --------------
  {
    const d = await docOf(docB);
    const jobs = await jobsFor(docB);
    if (jobs.length === 1) pass('B: the existing job row was reused, not duplicated');
    else fail(`B: ${jobs.length} job rows after one sweep — this is the 1,641-attempt bug`);
    const j = jobs.find((x) => x.id === jobB);
    if (j?.status === 'queued') pass('B: that row is back in the queue');
    else fail(`B: the original job is "${j?.status}" instead of queued`);
    if (j?.attempts === 1) pass('B: its attempt count survived the requeue (1 of 3 spent)');
    else fail(`B: attempts reset to ${j?.attempts} — the budget can never be spent`);
    if (d.processing_status === 'pending') pass('B: the document is pending again');
    else fail(`B: the document is "${d.processing_status}"`);
  }

  // --- C: no job at all -> exactly one is created --------------------------
  {
    const d = await docOf(docC);
    const jobs = await jobsFor(docC);
    if (jobs.length === 1) pass('C: a document with no queue row gets exactly one job');
    else fail(`C: ${jobs.length} jobs created for a document that had none`);
    if (jobs[0]?.attempts === 0) pass('C: it starts at attempt 0');
    else fail(`C: new job starts at attempts = ${jobs[0]?.attempts}`);
    if (d.processing_status === 'pending') pass('C: the document is pending');
    else fail(`C: the document is "${d.processing_status}"`);
  }

  // --- the loop itself: sweeping twice must not accumulate jobs ------------
  {
    const before = (await jobsFor(docA)).length + (await jobsFor(docB)).length + (await jobsFor(docC)).length;
    await supabase.rpc('recover_stranded_documents', { p_idle_minutes: 1 });
    const after = (await jobsFor(docA)).length + (await jobsFor(docB)).length + (await jobsFor(docC)).length;
    if (after === before) pass(`a second sweep created no new work (${before} jobs before and after)`);
    else fail(`a second sweep grew the queue from ${before} to ${after} jobs — the loop is still live`);
  }
} finally {
  await cleanup();
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
