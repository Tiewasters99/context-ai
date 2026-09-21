// POST /api/bucketizer-run  —  start / status / cancel / resume a server-side
// Bucketizer classification run.
//
// WHAT IT IS FOR
// ---------------------------------------------------------------------------
// A lawyer chooses four hundred documents, sees what it will cost, presses the
// button, and shuts the laptop. This endpoint turns the second half of that
// sentence into a row (migration 079) and a queue of ordinary jobs at BULK
// priority, which the Fly worker drains whether or not anybody is watching.
//
// TWO IDENTITIES, ON PURPOSE
// ---------------------------------------------------------------------------
//   * Everything the CALLER is allowed to do is checked with the CALLER's own
//     token, through their own RLS. Which matter, which documents, whether
//     there is a tree — all of it. The document ids arrive from a browser, and
//     a browser must never be able to file another matter's documents into a
//     tree it can see (feedback: strict-matter-isolation).
//   * Only then does the service role write the rows, because migration 079
//     gives `authenticated` no INSERT or UPDATE policy at all: a client that
//     could write these could say a run had finished.
//
// THE DARK SWITCH, AND WHY IT IS HERE
// ---------------------------------------------------------------------------
// Between merging this and deploying the Fly worker there is a window in which
// the OLD worker is running. It would claim a `bucketizer_classify_document`
// job, not recognise the type, and mark it `error` — four hundred times, in
// front of everybody's uploads. So `start` refuses until BUCKETIZER_SERVER_RUNS
// is set on Vercel, with a plain sentence, and the surface falls back to the
// browser path it has always had. The order is: merge → apply 079 → deploy the
// worker → set the variable.
//
// Request body: { action, matterId, ... }
//   start   { matterId, documentIds: uuid[], modelId, estimateCents }
//   status  { matterId }                     the current run, or null
//   cancel  { matterId, runId }
//   resume  { matterId, runId }
// Response: { ok, run, ... } or { error, message } with a status code.

import { createClient } from '@supabase/supabase-js';
import {
  ACTIVE_RUN_STATUSES, SERVER_RUN_MIN_DOCUMENTS, BUCKETIZER_JOB_TYPE,
  enqueueRunJobs, haltRun,
} from '../lib/bucketizer-run-queue.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

/**
 * The most documents one run may carry. Not a performance limit — the queue
 * copes — but a bound on how much a single click can commit, and on how big
 * `document_ids` may grow on one row.
 */
const MAX_RUN_DOCUMENTS = 5_000;

const RUN_COLUMNS =
  'id, matterspace_id, kind, requested_by, model_id, status, estimate_cents, '
  + 'documents_total, documents_done, documents_skipped, documents_failed, '
  + 'windows_called, windows_resumed, proposed, pause_reason, retry_after_seconds, '
  + 'last_error, created_at, started_at, finished_at';

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !serviceKey) {
    return json(res, 500, {
      error: 'config_error',
      message: 'This server is not configured to run classifications in the background.',
    });
  }

  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return json(res, 401, { error: 'missing_bearer' });
  }
  const token = authHeader.slice(7).trim();
  // The CALLER's client: every access question below is answered by their RLS.
  const asUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const svc = createClient(SUPABASE_URL, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const body = typeof req.body === 'string' ? safeJsonParse(req.body) : req.body;
  const action = body?.action;
  const matterId = body?.matterId;
  if (!matterId) return json(res, 400, { error: 'matterId required' });

  const { data: auth } = await asUser.auth.getUser();
  const userId = auth?.user?.id;
  if (!userId) return json(res, 401, { error: 'auth_required' });

  // RLS answers this: a matter the caller cannot see is simply not there.
  const { data: matter, error: matterErr } = await asUser
    .from('matterspaces').select('id').eq('id', matterId).maybeSingle();
  if (matterErr) return json(res, 500, { error: `matter: ${matterErr.message}` });
  if (!matter) return json(res, 404, { error: 'matter_not_found' });

  try {
    if (action === 'status') return await statusAction();
    if (action === 'start') return await startAction();
    if (action === 'cancel') return await stopAction('cancelled', 'Stopped by the person who started it.');
    if (action === 'resume') return await resumeAction();
    return json(res, 400, { error: 'unknown_action' });
  } catch (err) {
    return json(res, 500, { error: 'run_failed', message: err?.message || String(err) });
  }

  // -------------------------------------------------------------------------

  /**
   * The current run on this matter, as the progress line reads it after a
   * reload — when all the browser knows is the matter.
   *
   * It also answers the one thing the row alone cannot: whether a run that
   * says `running` still has any jobs. A worker that died between claiming a
   * job and settling it leaves a document mid-flight and nothing to finish it;
   * saying so, and offering Resume, is better than a progress line that never
   * moves.
   */
  async function statusAction() {
    const run = await currentRun();
    if (!run) return json(res, 200, { ok: true, run: null });

    const { data: docs } = await asUser
      .from('bucketizer_run_documents')
      .select('document_id, title, status, note, proposed')
      .eq('run_id', run.id)
      .neq('status', 'queued')
      .order('finished_at', { ascending: true })
      .limit(1000);

    let stalled = false;
    if (run.status === 'running' || run.status === 'queued') {
      const { count } = await svc
        .from('processing_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('job_type', BUCKETIZER_JOB_TYPE)
        .in('status', ['queued', 'running'])
        .filter('payload->>run_id', 'eq', run.id);
      stalled = (count ?? 0) === 0;
    }

    return json(res, 200, { ok: true, run, documents: docs ?? [], stalled });
  }

  async function startAction() {
    if (process.env.BUCKETIZER_SERVER_RUNS !== '1') {
      return json(res, 503, {
        error: 'server_runs_not_enabled',
        message:
          'Background classification is not switched on for this server yet — the worker that '
          + 'runs it has not been deployed. This run will go on in this window instead; keep it open.',
      });
    }

    const modelId = typeof body?.modelId === 'string' ? body.modelId : null;
    if (!modelId) return json(res, 400, { error: 'modelId required' });

    const asked = Array.isArray(body?.documentIds) ? [...new Set(body.documentIds)] : [];
    if (!asked.length) return json(res, 400, { error: 'documentIds required' });
    if (asked.length > MAX_RUN_DOCUMENTS) {
      return json(res, 400, {
        error: 'too_many_documents',
        message: `A single run takes at most ${MAX_RUN_DOCUMENTS.toLocaleString()} documents. Choose fewer.`,
      });
    }

    // STRICT MATTER ISOLATION. The ids came from a browser. Every one of them
    // must be visible to THIS caller and must live inside THIS matter's tree —
    // otherwise a person could file a matter they can see into a tree they can
    // also see, and the tree would then hold documents from somewhere else.
    const { data: scope, error: scopeErr } = await asUser
      .rpc('matterspace_descendants', { p_root: matterId });
    if (scopeErr) return json(res, 500, { error: `scope: ${scopeErr.message}` });
    const allowed = new Set([...(scope ?? []).map((r) => r.id), matterId]);

    const visible = [];
    for (let i = 0; i < asked.length; i += 200) {
      const { data, error } = await asUser
        .from('documents')
        .select('id, matterspace_id, title')
        .in('id', asked.slice(i, i + 200));
      if (error) return json(res, 500, { error: `documents: ${error.message}` });
      for (const d of data ?? []) if (allowed.has(d.matterspace_id)) visible.push(d);
    }
    if (visible.length !== asked.length) {
      return json(res, 403, {
        error: 'documents_out_of_scope',
        message:
          `${asked.length - visible.length} of the chosen documents are not in this matter, `
          + 'so nothing was started.',
      });
    }

    // The tree, with the caller's own RLS.
    const { data: nodes, error: nodesErr } = await asUser
      .from('bucketizer_nodes').select('id').eq('matterspace_id', matterId).limit(1);
    if (nodesErr) return json(res, 500, { error: `tree: ${nodesErr.message}` });
    if (!nodes?.length) {
      return json(res, 400, {
        error: 'no_tree',
        message: 'This matter has no case-theory tree yet — generate or add buckets first.',
      });
    }

    const already = await currentRun();
    if (already) {
      return json(res, 409, {
        error: 'run_in_progress',
        message: `There is already a classification run on this matter (${already.status}).`,
        run: already,
      });
    }

    const ids = visible.map((d) => d.id);
    const { data: run, error: insErr } = await svc
      .from('bucketizer_runs')
      .insert({
        matterspace_id: matterId,
        kind: 'classify',
        requested_by: userId,
        model_id: modelId,
        document_ids: ids,
        estimate_cents: Math.max(0, Math.round(Number(body?.estimateCents) || 0)),
        documents_total: ids.length,
        status: 'queued',
      })
      .select(RUN_COLUMNS)
      .single();
    // The one-active-run index is the authority, not the read above: two
    // clicks a second apart both pass that read and only one may win.
    if (insErr) {
      return json(res, 409, {
        error: 'run_in_progress',
        message: 'A classification run on this matter has just been started.',
      });
    }

    const { error: rowsErr } = await svc.from('bucketizer_run_documents').insert(
      visible.map((d) => ({
        run_id: run.id,
        matterspace_id: matterId,
        document_id: d.id,
        title: d.title ?? null,
      })),
    );
    if (rowsErr) {
      await haltRun(svc, run.id, 'failed', null, null, `could not stage the run: ${rowsErr.message}`);
      return json(res, 500, { error: `run_documents: ${rowsErr.message}` });
    }

    const queued = await enqueueRunJobs(svc, { runId: run.id, matterId, documentIds: ids });
    return json(res, 200, { ok: true, run, queued });
  }

  async function stopAction(status, reason) {
    const run = await runById(body?.runId);
    if (!run) return json(res, 404, { error: 'run_not_found' });
    await haltRun(svc, run.id, status, reason, null, null);
    return json(res, 200, { ok: true, run: await runById(run.id) });
  }

  /**
   * Put a paused, held or stalled run back to work.
   *
   * Explicit, never automatic: a run paused because the month's usage is spent
   * would otherwise re-pause itself every few seconds, and a run held by the
   * seal would ask a question that already has an answer. The person says when.
   */
  async function resumeAction() {
    const run = await runById(body?.runId);
    if (!run) return json(res, 404, { error: 'run_not_found' });
    if (!ACTIVE_RUN_STATUSES.includes(run.status)) {
      return json(res, 409, { error: 'run_finished', message: 'That run has already finished.' });
    }

    const { data: left, error } = await asUser
      .from('bucketizer_run_documents')
      .select('document_id')
      .eq('run_id', run.id)
      .in('status', ['queued', 'running'])
      .limit(MAX_RUN_DOCUMENTS);
    if (error) return json(res, 500, { error: `resume: ${error.message}` });
    if (!left?.length) {
      await haltRun(svc, run.id, 'done', null, null, null);
      return json(res, 200, { ok: true, run: await runById(run.id), queued: 0 });
    }

    // Clear anything still queued for this run first, so a Resume pressed
    // twice does not classify a document twice.
    await svc.from('processing_jobs').delete()
      .eq('job_type', BUCKETIZER_JOB_TYPE)
      .eq('status', 'queued')
      .filter('payload->>run_id', 'eq', run.id);

    await svc.from('bucketizer_runs')
      .update({ status: 'queued', pause_reason: null, retry_after_seconds: null, updated_at: new Date().toISOString() })
      .eq('id', run.id);
    await svc.from('bucketizer_run_documents')
      .update({ status: 'queued', started_at: null })
      .eq('run_id', run.id).in('status', ['queued', 'running']);

    const queued = await enqueueRunJobs(svc, {
      runId: run.id, matterId, documentIds: left.map((r) => r.document_id),
    });
    return json(res, 200, { ok: true, run: await runById(run.id), queued });
  }

  /** The newest run on this matter that has not finished. Read as the CALLER. */
  async function currentRun() {
    const { data, error } = await asUser
      .from('bucketizer_runs')
      .select(RUN_COLUMNS)
      .eq('matterspace_id', matterId)
      .eq('kind', 'classify')
      .in('status', ACTIVE_RUN_STATUSES)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(`run: ${error.message}`);
    return data?.[0] ?? null;
  }

  async function runById(id) {
    if (!id) return null;
    const { data, error } = await asUser
      .from('bucketizer_runs').select(RUN_COLUMNS)
      .eq('id', id).eq('matterspace_id', matterId).maybeSingle();
    if (error) throw new Error(`run: ${error.message}`);
    return data ?? null;
  }
}

/** Exported for the surface and the harness — one constant, one threshold. */
export { SERVER_RUN_MIN_DOCUMENTS };

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
