// A queued job may touch only its own matter (097, round 3).
//
// processing_jobs rows are member-writable (032 checks only that the row's
// matterspace_id is a matter the member can reach), and `payload` is free-form
// jsonb — yet the worker acts on the ids and paths in it with the SERVICE
// ROLE. So every id a job names was, until this file, trusted:
//
//   bucketizer classify   payload.run_id + payload.document_id — a member of
//                         matter A with a run of their own could name a SEALED
//                         document; its text went to the run's (unsealed)
//                         model and the rationale was stored under A;
//   stamp / package       job.production_id — another matter's production
//                         stamped (Bates allocated and locked) or packaged;
//   ingest_document       payload.document_id — another tenant's document
//                         re-indexed at the worker's cost;
//   intake_zip / _files   job.production_id + payload.storage_paths (round 2).
//
// This is the one check every job handler runs FIRST: each reference the job
// makes must belong to `job.matterspace_id`. Migration 097's BEFORE INSERT /
// UPDATE trigger on processing_jobs asks the same of a signed-in caller, so
// the database refuses a cross-matter job before the worker ever sees it; this
// is the same rule in the worker, for rows that predate the trigger or reach
// the queue some other way. Both layers, as with 097's path rule.
//
// A refusal throws JobScopeError (code 'job_scope'). The worker marks the job
// 'error' with the sentence and touches NOTHING else — no document status, no
// production status — because the ids in a refused job are not the job's to
// touch.

import { pathInProduction } from './storage-path.mjs';

export const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class JobScopeError extends Error {
  constructor(what) {
    super(`Refused: ${what} does not belong to this job's matter. The job was not run.`);
    this.name = 'JobScopeError';
    this.code = 'job_scope';
  }
}

export const isJobScopeError = (err) => err?.code === 'job_scope';

// ROUND 4. "Belongs to the job's matter" is a TREE question, not an equality:
//   * a Bucketizer run over a matter includes documents from its folders and
//     sub-matters (api/bucketizer-run.mjs checks matterspace_descendants), and
//     its jobs are queued under the RUN's matter — so the document must sit in
//     the run matter's SUBTREE (and the run must list it);
//   * an upload queues ingest_document under the document's matter at that
//     moment; filing it into a folder afterwards must not strand the job — so
//     the document must be in the SAME TREE as the job (a common ancestor).
// Either is enough to stop what the check exists for: an id from someone
// else's tree. matter_ancestry (016) is the definer walk: self + ancestors.
async function ancestry(supabase, matterId) {
  const { data, error } = await supabase.rpc('matter_ancestry', { p_matter_id: matterId });
  if (error) throw new Error(`matter ancestry: ${error.message}`);
  return new Set((data ?? []).map((r) => r.id));
}

/** Is `matterId` the root matter or anywhere below it? */
export async function matterWithin(supabase, matterId, rootId) {
  if (!matterId || !rootId) return false;
  if (matterId === rootId) return true;
  return (await ancestry(supabase, matterId)).has(rootId);
}

/** Do the two matters share an ancestor (the same top-level matter)? */
export async function sameMatterTree(supabase, a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [x, y] = await Promise.all([ancestry(supabase, a), ancestry(supabase, b)]);
  for (const id of x) if (y.has(id)) return true;
  return false;
}

/**
 * A move carries the document's queued ingest jobs with it (round 4). The
 * member's own client cannot update processing_jobs (032 has no UPDATE
 * policy), so callers pass the SERVICE-ROLE client, after they have moved the
 * document as the user. Best effort: a job left behind is still accepted by
 * the worker while the move stayed within one tree.
 */
export async function repointDocumentJobs(serviceClient, documentIds, matterId) {
  if (!serviceClient || !documentIds?.length || !matterId) return;
  try {
    await serviceClient.from('processing_jobs')
      .update({ matterspace_id: matterId })
      .eq('job_type', 'ingest_document')
      .in('status', ['queued', 'running', 'held'])
      .in('payload->>document_id', documentIds);
  } catch { /* the worker's tree rule still covers a move inside one tree */ }
}

/**
 * Throw JobScopeError unless every reference belongs to job.matterspace_id.
 * Reads with the given (service-role) client. Returns what it loaded, so a
 * handler can use the rows it has just proved are the job's own.
 *
 * @param {object} supabase
 * @param {object} job                   the claimed processing_jobs row
 * @param {object} refs
 * @param {string} [refs.documentId]
 * @param {'exact'|'subtree'|'tree'} [refs.documentScope]  how the document's
 *                                       matter must relate to the job's: the
 *                                       same matter (default), inside its
 *                                       subtree (Bucketizer), or in the same
 *                                       tree (ingest_document)
 * @param {string} [refs.runId]          a bucketizer run; with documentId, the
 *                                       run must list that document
 * @param {string} [refs.productionId]
 * @param {string[]} [refs.storagePaths] discovery-files paths of that production
 */
export async function assertJobBelongsToMatter(supabase, job, refs = {}) {
  const matter = job?.matterspace_id;
  if (typeof matter !== 'string' || !CANONICAL_UUID.test(matter)) throw new JobScopeError('the job itself (it names no matter)');
  const out = {};

  if (refs.productionId !== undefined) {
    if (typeof refs.productionId !== 'string' || !CANONICAL_UUID.test(refs.productionId)) throw new JobScopeError('the production');
    const { data: prod, error } = await supabase.from('productions').select('*').eq('id', refs.productionId).maybeSingle();
    if (error) throw new Error(`production lookup: ${error.message}`);
    if (!prod || prod.matterspace_id !== matter) throw new JobScopeError('the production');
    out.prod = prod;
  }

  if (refs.storagePaths !== undefined) {
    if (!Array.isArray(refs.storagePaths) || !out.prod) throw new JobScopeError('a storage path');
    for (const p of refs.storagePaths) {
      if (!pathInProduction(p, matter, out.prod.id)) throw new JobScopeError('a storage path');
    }
  }

  if (refs.documentId !== undefined) {
    if (typeof refs.documentId !== 'string' || !CANONICAL_UUID.test(refs.documentId)) throw new JobScopeError('the document');
    const { data: doc, error } = await supabase.from('documents').select('id, matterspace_id').eq('id', refs.documentId).maybeSingle();
    if (error) throw new Error(`document lookup: ${error.message}`);
    // A document that has since been deleted is not a scope violation; the
    // handler reports it in its own words. One in another matter is.
    if (doc && doc.matterspace_id !== matter) {
      const scope = refs.documentScope ?? 'exact';
      const ok = scope === 'subtree' ? await matterWithin(supabase, doc.matterspace_id, matter)
        : scope === 'tree' ? await sameMatterTree(supabase, doc.matterspace_id, matter)
          : false;
      if (!ok) throw new JobScopeError('the document');
    }
    out.doc = doc ?? null;
  }

  if (refs.runId !== undefined) {
    if (typeof refs.runId !== 'string' || !CANONICAL_UUID.test(refs.runId)) throw new JobScopeError('the Bucketizer run');
    const { data: run, error } = await supabase.from('bucketizer_runs').select('id, matterspace_id').eq('id', refs.runId).maybeSingle();
    if (error) throw new Error(`run lookup: ${error.message}`);
    if (run && run.matterspace_id !== matter) throw new JobScopeError('the Bucketizer run');
    out.run = run ?? null;
    if (run && refs.documentId !== undefined) {
      const { data: rd, error: rdErr } = await supabase
        .from('bucketizer_run_documents').select('id').eq('run_id', refs.runId).eq('document_id', refs.documentId).maybeSingle();
      if (rdErr) throw new Error(`run document lookup: ${rdErr.message}`);
      if (!rd) throw new JobScopeError('the document (it is not in this run)');
    }
  }
  return out;
}
