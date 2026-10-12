// Producing documents already in the matter (intake_documents, migration 110).
//
// A production can now draw on the matter's own Vault: the browser queues one
// job naming document ids, and the worker reads each file with the SERVICE
// ROLE and produces it. Service-role reads of ids a member chose are the class
// 097 closed, so this proves both layers for the new key:
//
//   A. 110 against a real Postgres (PGlite), as `authenticated`: a document in
//      the matter or anywhere below it is accepted; one in a sibling
//      sub-matter, a parent, another tree, a deleted id, a non-canonical
//      spelling, an empty / oversized / non-list payload, or a list without a
//      production is refused. 097's other rules still hold after 110. 110 is
//      re-runnable and refuses to run without 097.
//   B. lib/job-scope.mjs, as the service role, refuses the same set.
//   C. the seal rule the worker adds (lib/seal-crossing.mjs): a document from a
//      sub-matter sealed more tightly than the production's matter is refused.
//   D. the worker, held to its source: the job is scope-checked in dispatch,
//      the seal and the lock are checked before anything is written, each
//      stored path is checked before it is read, and a Vault document is linked,
//      never ingested a second time.
//
//   npm i --no-save @electric-sql/pglite
//   node scripts/_verify-intake-documents.mjs
//
// Offline and secret-free: no .env, no network, no production.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  console.error('PGlite is not installed. Run:  npm i --no-save @electric-sql/pglite');
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mig = (n) => fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', n), 'utf8');
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  — ' + detail : ''}`);
};

const u = () => crypto.randomUUID();
// A tree: A has a folder (A_CHILD) with its own folder (A_GRAND), and a
// sibling sub-matter (A_SIB). B is another firm's matter.
const A = u(); const A_CHILD = u(); const A_GRAND = u(); const A_SIB = u(); const B = u();
const parentOf = { [A]: null, [A_CHILD]: A, [A_GRAND]: A_CHILD, [A_SIB]: A, [B]: null };
const docA = u(); const docChild = u(); const docGrand = u(); const docSib = u(); const docB = u();
const docMatter = { [docA]: A, [docChild]: A_CHILD, [docGrand]: A_GRAND, [docSib]: A_SIB, [docB]: B };
const prodA = u(); const prodChild = u(); const prodB = u();
const prodMatter = { [prodA]: A, [prodChild]: A_CHILD, [prodB]: B };

// ---------------------------------------------------------------------------
console.log('\n--- A. migration 110, as authenticated ---------------------------------');
{
  const db = new PGlite();
  await db.exec(`
    do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
    do $$ begin create role anon; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;
    create table public.matterspaces (id uuid primary key, parent_matterspace_id uuid);
    create or replace function public.matter_ancestry(p_matter_id uuid)
    returns table (id uuid) language sql stable security definer set search_path = public as $f$
      with recursive a(id, parent_matterspace_id) as (
        select id, parent_matterspace_id from public.matterspaces where id = p_matter_id
        union all
        select m.id, m.parent_matterspace_id from public.matterspaces m join a on m.id = a.parent_matterspace_id
      )
      select id from a
    $f$;
    create table public.documents (id uuid primary key, matterspace_id uuid not null, title text, storage_path text);
    create table public.productions (id uuid primary key, matterspace_id uuid not null);
    create table public.processing_jobs (
      id uuid primary key default gen_random_uuid(), matterspace_id uuid not null,
      production_id uuid, job_type text not null, payload jsonb not null default '{}');
    grant usage on schema public to authenticated, anon, service_role;
    grant select, insert, update on public.processing_jobs to authenticated, service_role;
  `);

  let without097 = null;
  try { await db.exec(mig('110_intake_documents_scope.sql')); } catch (e) { without097 = e; }
  check(Boolean(without097) && /needs migration 097/.test(without097.message), '110 pasted before 097: refuses with a sentence naming 097', without097?.message);

  await db.exec(mig('097_storage_path_matter.sql'));
  await db.exec(mig('110_intake_documents_scope.sql'));
  let rerun = null;
  try { await db.exec(mig('110_intake_documents_scope.sql')); } catch (e) { rerun = e; }
  check(!rerun, '110 is re-runnable (pasted twice)', rerun?.message);

  for (const [id, parent] of Object.entries(parentOf)) await db.query('insert into public.matterspaces values ($1,$2)', [id, parent]);
  for (const [id, m] of Object.entries(docMatter)) await db.query('insert into public.documents values ($1,$2,$3,null)', [id, m, 'd']);
  for (const [id, m] of Object.entries(prodMatter)) await db.query('insert into public.productions values ($1,$2)', [id, m]);

  const asAuth = async (matter, prod, payload, jobType = 'intake_documents') => {
    await db.exec('set role authenticated');
    try {
      await db.query('insert into public.processing_jobs (matterspace_id, job_type, production_id, payload) values ($1,$2,$3,$4::jsonb)',
        [matter, jobType, prod, JSON.stringify(payload)]);
      return null;
    } catch (e) { return e; } finally { await db.exec('reset role'); }
  };

  const CASES = [
    ['documents in the matter, its folder and its folder\'s folder', A, prodA, { document_ids: [docA, docChild, docGrand] }, true],
    ['a production in a folder, drawing on that folder and below', A_CHILD, prodChild, { document_ids: [docChild, docGrand] }, true],
    ['a production in a folder, a document in its PARENT matter', A_CHILD, prodChild, { document_ids: [docChild, docA] }, false],
    ['a production in a folder, a document in a SIBLING sub-matter', A_CHILD, prodChild, { document_ids: [docSib] }, false],
    ['own documents plus one from another firm\'s matter', A, prodA, { document_ids: [docA, docB] }, false],
    ['a document id that does not exist', A, prodA, { document_ids: [u()] }, false],
    ['a non-canonical (upper-case) spelling of its own document', A, prodA, { document_ids: [docA.toUpperCase()] }, false],
    ['a non-string entry', A, prodA, { document_ids: [docA, 42] }, false],
    ['an empty list', A, prodA, { document_ids: [] }, false],
    ['a string instead of a list', A, prodA, { document_ids: docA }, false],
    ['5,001 ids', A, prodA, { document_ids: Array.from({ length: 5001 }, () => docA) }, false],
    ['a list with no production', A, null, { document_ids: [docA] }, false],
    ['own documents, but another matter\'s production', A, prodB, { document_ids: [docA] }, false],
  ];
  for (const [label, matter, prod, payload, ok] of CASES) {
    const e = await asAuth(matter, prod, payload);
    check(ok ? !e : (Boolean(e) && e.code === '42501'), `trigger — ${label}: ${ok ? 'accepted' : 'refused'}`, e?.message ?? 'accepted');
  }
  // 097's rules survive 110's restatement.
  check(Boolean(await asAuth(A, prodB, {}, 'stamp_production')), 'after 110, 097 still refuses a stamp of another matter\'s production');
  check(Boolean(await asAuth(A, null, { document_id: docB }, 'ingest_document')), 'after 110, 097 still refuses ingest of another matter\'s document');
  check(Boolean(await asAuth(A, prodA, { local_path: '/proc/self' }, 'intake_folder')), 'after 110, 097 still refuses a queued local folder');
  check(!(await asAuth(A, prodA, { storage_paths: [`${A}/${prodA}/intake/box.zip`] }, 'intake_zip')), 'after 110, 097 still accepts the production\'s own intake ZIP');
  {
    await db.query('insert into public.processing_jobs (matterspace_id, job_type, production_id, payload) values ($1,$2,$3,$4::jsonb)',
      [A, 'intake_documents', prodA, JSON.stringify({ document_ids: [docA] })]);
    await db.exec('set role authenticated');
    let e = null;
    try {
      await db.query("update public.processing_jobs set payload = $1::jsonb where job_type = 'intake_documents'", [JSON.stringify({ document_ids: [docB] })]);
    } catch (x) { e = x; } finally { await db.exec('reset role'); }
    check(Boolean(e) && e.code === '42501', 'an UPDATE re-pointing a queued job at another matter\'s document: refused');
  }
  await db.close();
}

// ---------------------------------------------------------------------------
console.log('\n--- B. lib/job-scope.mjs, as the service role --------------------------');
{
  const { assertJobBelongsToMatter, isJobScopeError, MAX_INTAKE_DOCUMENTS } = await import('../lib/job-scope.mjs');
  const tables = {
    documents: Object.entries(docMatter).map(([id, m]) => ({ id, matterspace_id: m })),
    productions: Object.entries(prodMatter).map(([id, m]) => ({ id, matterspace_id: m })),
  };
  const ancestryOf = (m) => { const out = []; for (let x = m; x; x = parentOf[x]) out.push({ id: x }); return out; };
  const fake = {
    async rpc(fn, args) {
      if (fn === 'matter_ancestry') return { data: ancestryOf(args.p_matter_id), error: null };
      return { data: null, error: { message: `no rpc ${fn}` } };
    },
    from(t) {
      const filters = [];
      const rows = () => (tables[t] ?? []).filter((r) => filters.every((f) => f(r)));
      const api = {
        select() { return api; },
        eq(k, v) { filters.push((r) => r[k] === v); return api; },
        in(k, vs) { filters.push((r) => vs.includes(r[k])); return api; },
        async maybeSingle() { return { data: rows()[0] ?? null, error: null }; },
        then(res, rej) { return Promise.resolve({ data: rows(), error: null }).then(res, rej); },
      };
      return api;
    },
  };
  const W = [
    ['the matter, its folder and its folder\'s folder', A, prodA, [docA, docChild, docGrand], true],
    ['a production in a folder, a document in its parent', A_CHILD, prodChild, [docA], false],
    ['a production in a folder, a document in a sibling sub-matter', A_CHILD, prodChild, [docSib], false],
    ['another firm\'s document', A, prodA, [docA, docB], false],
    ['a deleted document (the handler reports it, not a scope breach)', A, prodA, [docA, u()], true],
    ['a non-canonical id', A, prodA, [docA.toUpperCase()], false],
    ['an empty list', A, prodA, [], false],
    [`more than ${MAX_INTAKE_DOCUMENTS} ids`, A, prodA, Array.from({ length: MAX_INTAKE_DOCUMENTS + 1 }, () => docA), false],
    ['another matter\'s production', A, prodB, [docA], false],
  ];
  for (const [label, matter, prod, ids, ok] of W) {
    let e = null;
    try { await assertJobBelongsToMatter(fake, { matterspace_id: matter, production_id: prod }, { productionId: prod, documentIds: ids }); } catch (x) { e = x; }
    check(ok ? !e : isJobScopeError(e), `worker assert — ${label}: ${ok ? 'passes' : 'refused'}`, e?.message ?? 'passed');
  }
}

// ---------------------------------------------------------------------------
console.log('\n--- C. the seal rule the worker adds -----------------------------------');
{
  const { crossingRefusal } = await import('../lib/seal-crossing.mjs');
  check(Boolean(crossingRefusal('B', 'A', 'copy')), 'a document from a sealed (B) sub-matter into an open (A) matter\'s production: refused');
  check(Boolean(crossingRefusal('C', 'B', 'copy')), 'a document from a C sub-matter into a B matter\'s production: refused');
  check(!crossingRefusal('B', 'B', 'copy'), 'a sealed document into a production in the same sealed matter: allowed');
  check(!crossingRefusal('A', 'B', 'copy'), 'an open document into a sealed matter\'s production: allowed');
}

// ---------------------------------------------------------------------------
console.log('\n--- D. the worker, held to its source ----------------------------------');
{
  const w = fs.readFileSync(path.join(ROOT, 'worker', 'discovery-worker.mjs'), 'utf8');
  const scopeSrc = w.slice(w.indexOf('async function assertJobScope'), w.indexOf('async function dispatch(job)'));
  check(/case 'intake_documents':\s*return assertJobBelongsToMatter\(supabase, job, \{ productionId: job\.production_id, documentIds: p\.document_ids \?\? \[\] \}\);/.test(scopeSrc),
    'assertJobScope checks the production and every document id of an intake_documents job');
  check(/case 'intake_documents': return intakeDocuments\(job\);/.test(w), 'dispatch routes intake_documents to its handler (after assertJobScope)');

  const fn = w.slice(w.indexOf('async function intakeDocuments(job)'), w.indexOf('function vaultFilename('));
  const at = (s) => fn.indexOf(s);
  check(at('assertJobPaths(job, prod, [],') > -1 && at('assertJobPaths(job, prod, [],') < at("setProductionStatus(prod.id, 'processing')"),
    'the handler checks the job\'s matter against the production\'s in place');
  check(at("['stamped', 'packaged', 'delivered'].includes(prod.status)") > -1 && at("['stamped', 'packaged', 'delivered']") < at("setProductionStatus(prod.id, 'processing')"),
    'a stamped production is refused before anything is written');
  check(at('crossingRefusal(') > -1 && at('crossingRefusal(') < at("setProductionStatus(prod.id, 'processing')") && at('crossingRefusal(') < at('downloadFromBucket('),
    'the seal is judged for every document before any status changes or any file is read');
  // The lock and the seal refuse with JobRefusedError, which the catch treats
  // like a scope refusal: only the job row is marked. A plain Error would hit
  // the intake branch that flips the production to 'error' — and the
  // production a refused job names may be finished (packaged, delivered).
  check(/throw new JobRefusedError\('This production is already stamped/.test(fn)
    && /throw new JobRefusedError\(`\$\{d\.source_filename \?\? d\.title\} is in a sub-matter sealed more tightly/.test(fn),
    'the lock and the seal refuse with JobRefusedError, not a plain Error');
  const refusedAt = w.indexOf('if (isJobRefusedError(err))');
  const branch = refusedAt === -1 ? '' : w.slice(refusedAt, w.indexOf('continue;', refusedAt) + 'continue;'.length);
  check(branch.length > 0 && refusedAt + branch.length < w.indexOf("job.job_type.startsWith('intake')")
    && refusedAt + branch.length < w.indexOf('await recordDocumentFailure(job, err)')
    && branch.includes(".from('processing_jobs')")
    && !/recordDocumentFailure|from\('productions'\)/.test(branch),
    'a refused job marks only itself: it continues before recordDocumentFailure and before the production is flipped to error');
  {
    const { JobRefusedError, isJobRefusedError, isJobScopeError } = await import('../lib/job-scope.mjs');
    const e = new JobRefusedError('x');
    check(isJobRefusedError(e) && !isJobScopeError(e) && !isJobRefusedError(new Error('x')),
      'JobRefusedError is its own kind (not a scope error, not a plain error)');
  }
  check(at('pathInMatter(doc.storage_path, doc.matterspace_id)') > -1 && at('pathInMatter(doc.storage_path, doc.matterspace_id)') < at("downloadFromBucket('vault-documents', doc.storage_path)"),
    'each stored path is held to its own matter before it is read');
  check(at('MAX_VAULT_PICK_BYTES') > -1 && at('MAX_VAULT_PICK_BYTES') < at('downloadFromBucket('),
    'an oversized file is refused with a reason before it is read into memory');
  check(/documentId: id,\s*\}\);/.test(fn), 'each document is produced through intakeOneFile, linked to its own document row');
  check(/job\.payload\?\.ingest !== false && !documentId\) \{/.test(w),
    'a Vault document is never ingested a second time (no duplicate documents row, no second upload)');
  check(/\.\.\.\(documentId \? \{ document_id: documentId \} : \{\}\),/.test(w),
    'the production item points at the existing document, so the TEXT folder uses the matter\'s own OCR');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
