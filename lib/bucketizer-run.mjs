// The server-side Bucketizer runner: one document of a run, on the Fly worker.
//
// THE POINT
// ---------------------------------------------------------------------------
// Bulk classification was a browser loop. PR #168 made it whole-document and
// resumable, but it only ADVANCES while the tab is open, and the real Fleming
// run was therefore done with a local CLI holding a service-role key. The
// ship-readiness audit's Definition of Done is "500 documents classify
// server-side, resumable, tab closed". This module is the server half of that.
//
// WHAT IT IS NOT
// ---------------------------------------------------------------------------
// It is NOT a second classifier. The plan, the prompts, the contract, the
// repair turn, the merge and the "never touch a decided row" rule are the same
// modules the browser uses (`lib/bucketizer-windows.mjs`,
// `lib/bucketizer-document.mjs`, `lib/bucketizer-writes.mjs`). What this file
// contributes is the four things the browser gets for free and the worker does
// not: where progress is kept, whose money is spent, whose name is on the
// Record, and what happens when the answer is "no".
//
// ONE JOB PER DOCUMENT, AT BULK PRIORITY
// ---------------------------------------------------------------------------
// A 500-document run is 500 ordinary `processing_jobs` rows at
// JOB_PRIORITY.BULK (-10). Nothing about claim_discovery_job or the 057/071
// priority rules changes, and the consequence is the one that matters: a
// lawyer's single deposition upload in another matter is claimed AHEAD of all
// 500, because that is what strict priority already does.
//
// Concurrency is bounded twice, without a new mechanism: the worker runs one
// job at a time per machine (two machines today), and migration 079's partial
// unique index allows one ACTIVE run per matter per act — so a person cannot
// start the same four hundred documents four times and pay four times.
//
// WHEN THE ANSWER IS NO
// ---------------------------------------------------------------------------
// A policy refusal is not a job failure, and this handler never lets one become
// one. The RUN takes the status and the SERVER's own sentence, its remaining
// queued jobs are deleted so they do not sit in front of everybody else's
// uploads, and the job itself completes:
//
//   402 / 429     run → paused, with the meter's sentence and its retry-after.
//                 Resume when the person says so; nothing finished is re-paid.
//   AI paused     run → paused, with the gate's own sentence (who, and since
//                 when). Migration 070.
//   sealed, no    run → held, with the product's sentence. Nothing was sent,
//   pen           to any provider, and there is no fallback — ever.
//   cancelled     the run was already stopped; this job is a no-op.
//
// Anything else is about ONE document: it is recorded against that document in
// plain language and the run carries on, exactly as the browser loop does.

import {
  planClassificationWrites, sentinelAfterRun,
} from './bucketizer-writes.mjs';
import {
  CLASSIFY_TOOL_NAME, CLASSIFY_TOOL_DESCRIPTION, CLASSIFY_SCHEMA,
} from './bucketizer-core.mjs';
import { classifyDocumentWindowed } from './bucketizer-document.mjs';
import { buildStructuredParams, extractStructuredOutput } from './structured-anthropic.mjs';
import { serverLlmCall } from './llm-server-call.mjs';
import { LlmCallError } from './llm-call-error.mjs';
import { haltRun } from './bucketizer-run-queue.mjs';
import { assertJobBelongsToMatter } from './job-scope.mjs';

// The queue half — the job type, the BULK priority, the browser/server
// threshold and the enqueue — lives in lib/bucketizer-run-queue.mjs so the
// Vercel handler can import it without this module's Anthropic SDK. Re-exported
// here because the worker imports one module, not two.
export {
  BUCKETIZER_JOB_TYPE,
  BUCKETIZER_JOB_PRIORITY,
  SERVER_RUN_MIN_DOCUMENTS,
  ACTIVE_RUN_STATUSES,
  enqueueRunJobs,
  haltRun,
} from './bucketizer-run-queue.mjs';

/** Read ceiling for one document's passages. Past this it is not classified. */
const PASSAGE_CEILING = 50_000;
const PAGE_SIZE = 1_000;

/**
 * Run one document of one run.
 *
 * @param {object} o
 * @param {object} o.supabase  the worker's service-role supabase-js client.
 * @param {object} o.job       the claimed processing_jobs row.
 * @param {object} [o.env]
 * @param {Function} [o.log]
 * @param {Function} [o.progress]  (pct, note) => Promise, the worker's own.
 * @param {Function} [o.callModel] injectable for harnesses; defaults to the
 *                                 real gate → seal → meter → clamp → record →
 *                                 send entry.
 */
export async function runBucketizerDocumentJob({
  supabase, job, env = process.env, log = () => {}, progress = null, callModel = null,
}) {
  const runId = job?.payload?.run_id;
  const documentId = job?.payload?.document_id;
  if (!runId || !documentId) throw new Error('bucketizer job payload needs run_id and document_id');
  // 097 round 3: the run and the document belong to the JOB's matter, and the
  // run lists the document — before a passage is read or a model is called.
  // Without this a member of one matter, with a run of their own, could name
  // a sealed document of another; the model call judges the seal by the RUN's
  // matter. The worker asks the same first (lib/job-scope.mjs); this is the
  // handler refusing on its own account.
  await assertJobBelongsToMatter(supabase, job, { runId, documentId, documentScope: 'subtree' });

  const { data: run, error: runErr } = await supabase
    .from('bucketizer_runs').select('*').eq('id', runId).maybeSingle();
  if (runErr) throw new Error(`run lookup: ${runErr.message}`);
  if (!run) { log(`  run ${runId} is gone — nothing to do`); return { skipped: 'no_run' }; }

  // A run that is paused, held, cancelled, failed or done does not advance.
  // This is what makes a stale job harmless rather than expensive: it is the
  // FIRST thing checked, before a passage is read or a token is spent.
  if (!['queued', 'running'].includes(run.status)) {
    log(`  run ${runId} is ${run.status} — this job is a no-op`);
    return { skipped: run.status };
  }
  if (run.kind !== 'classify') {
    log(`  run ${runId} is a '${run.kind}' run — this handler only classifies`);
    return { skipped: 'wrong_kind' };
  }

  if (run.status === 'queued') {
    await supabase.from('bucketizer_runs')
      .update({ status: 'running', started_at: run.started_at ?? new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', runId).eq('status', 'queued');
  }

  const { data: doc, error: docErr } = await supabase
    .from('documents').select('id, title, doc_type, metadata').eq('id', documentId).maybeSingle();
  if (docErr) throw new Error(`document lookup: ${docErr.message}`);

  const { data: rowBefore } = await supabase
    .from('bucketizer_run_documents')
    .select('id, attempts, title').eq('run_id', runId).eq('document_id', documentId).maybeSingle();
  await supabase.from('bucketizer_run_documents')
    .update({ status: 'running', attempts: Number(rowBefore?.attempts ?? 0) + 1, started_at: new Date().toISOString() })
    .eq('run_id', runId).eq('document_id', documentId);

  const title = doc?.title ?? rowBefore?.title ?? 'this document';
  if (!doc) {
    await finishDocument(supabase, runId, documentId, {
      status: 'skipped',
      note: `${title}: the document is no longer in this workspace, so it was not classified.`,
    });
    return { skipped: 'no_document' };
  }

  // The tree. It belongs to the run's matter, and it is re-read per document on
  // purpose: the attorney edits node descriptions while a run is going — that
  // is the feature — and the NEXT document should see the edit.
  const { data: nodes, error: nodesErr } = await supabase
    .from('bucketizer_nodes')
    .select('id, parent_id, kind, label, description, position')
    .eq('matterspace_id', run.matterspace_id)
    .order('position');
  if (nodesErr) throw new Error(`tree: ${nodesErr.message}`);
  if (!nodes?.length) {
    await haltRun(supabase, runId, 'failed', null, null, 'The case-theory tree is empty, so there was nothing to classify into.');
    return { skipped: 'no_tree' };
  }

  const deps = serverRunDeps({ supabase, run, env, callModel });

  try {
    const outcome = await classifyDocumentWindowed({
      doc: { id: doc.id, title, doc_type: doc.doc_type ?? null },
      nodes,
      modelId: run.model_id,
      deps,
      signal: deps.signal,
      onWindow: (p) => {
        if (progress && p.total) progress(Math.round((p.done / p.total) * 100), `${title} — part ${p.done} of ${p.total}`).catch(() => {});
      },
    });

    // A POLICY refusal — the seal, the pause, a tier violation — is not this
    // document's problem and is not going to be different on the next window,
    // so `callWindow` aborts the loop the moment one arrives (`deps.signal`)
    // rather than asking the same question of every remaining part. Everything
    // finished is already written down; the run takes the server's sentence.
    const refused = deps.policyRefusal();
    if (refused) {
      log(`  run ${runId} → ${refused.status}: ${refused.reason}`);
      await supabase.from('bucketizer_run_documents')
        .update({ status: 'queued', started_at: null })
        .eq('run_id', runId).eq('document_id', documentId);
      await haltRun(supabase, runId, refused.status, refused.reason, refused.retryAfterSeconds ?? null, null);
      return { halted: refused.status };
    }

    await finishDocument(supabase, runId, documentId, {
      status: outcome.status === 'classified' ? 'done'
        : outcome.status === 'no_text' ? 'skipped'
          : 'failed',
      note: outcome.status === 'no_text'
        ? `${title}: no text to read — an image-only scan, a recording, or a file still awaiting OCR. It was not classified.`
        : (outcome.notes[0] ?? null),
      windowsTotal: outcome.windowsTotal,
      windowsCalled: outcome.windowsCalled,
      windowsResumed: outcome.windowsResumed,
      windowsFailed: outcome.windowsFailed,
      proposed: outcome.proposed,
    });
    return { status: outcome.status, proposed: outcome.proposed };
  } catch (err) {
    const halt = haltFor(err);
    if (halt) {
      // A policy answer, not a fault. The RUN takes the status and the
      // server's own sentence; this document goes back into the queue for a
      // Resume; the job completes, because nothing here is retryable.
      log(`  run ${runId} → ${halt.status}: ${halt.reason}`);
      await supabase.from('bucketizer_run_documents')
        .update({ status: 'queued', started_at: null })
        .eq('run_id', runId).eq('document_id', documentId);
      await haltRun(supabase, runId, halt.status, halt.reason, halt.retryAfterSeconds ?? null, null);
      return { halted: halt.status };
    }
    // One document's problem. Recorded against it in plain language; the run
    // carries on, exactly as the browser loop does.
    await finishDocument(supabase, runId, documentId, {
      status: 'failed',
      note: `${title}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 800),
    });
    return { status: 'failed' };
  }
}

/**
 * Which refusals stop the whole run, and with which word.
 *
 * `paused` is resumable by the person and keeps everything finished.
 * `held` is the seal: nothing was sent, to anybody, and there is no fallback.
 */
function haltFor(err) {
  if (!(err instanceof LlmCallError)) return null;
  if (err.isUsagePause) {
    return { status: 'paused', reason: err.message, retryAfterSeconds: err.retryAfterSeconds };
  }
  if (err.code === 'ai_paused' || err.code === 'ai_pause_unknown') {
    return { status: 'paused', reason: err.message };
  }
  if (err.code === 'sealed_pen_unavailable' || err.code === 'sealed_route_untranslatable'
    || err.code === 'tier_violation' || err.code === 'exchange_unrecorded') {
    return { status: 'held', reason: err.message };
  }
  if (err.code === 'no_api_key' || err.code === 'auth_not_configured') {
    return { status: 'held', reason: err.message };
  }
  return null;
}

async function finishDocument(supabase, runId, documentId, {
  status, note = null, windowsTotal = 0, windowsCalled = 0,
  windowsResumed = 0, windowsFailed = 0, proposed = 0,
}) {
  const { error } = await supabase.rpc('bucketizer_run_finish_document', {
    p_run: runId,
    p_document: documentId,
    p_status: status,
    p_note: note,
    p_windows_total: windowsTotal,
    p_windows_called: windowsCalled,
    p_windows_resumed: windowsResumed,
    p_windows_failed: windowsFailed,
    p_proposed: proposed,
  });
  if (error) throw new Error(`run bookkeeping: ${error.message}`);
}

// ---------------------------------------------------------------------------
// The effects
// ---------------------------------------------------------------------------

/**
 * The service-role effects `classifyDocumentWindowed` needs.
 *
 * Deliberately the same SHAPE as `supabaseRunDeps` in the browser
 * (src/lib/bucketizer/index.ts), because they feed the same loop. The two
 * differ in exactly three places, and each difference is the point of this
 * lane:
 *
 *   * `loadRun`/`saveRun` keep progress in `bucketizer_run_windows` rows
 *     (migration 079) rather than in `documents.metadata`, so it survives the
 *     laptop being shut rather than the tab being open. `loadRun` still SEEDS
 *     itself from the browser's record when the plan hash matches, so a run
 *     abandoned in a tab and picked up by the worker does not pay twice;
 *   * `callWindow` goes through `lib/llm-server-call.mjs` in process rather
 *     than `/api/llm` over HTTP — the same gate, seal, meter, clamp and Record,
 *     with the requesting user's id;
 *   * every read and write is service-role, which is why the API checked the
 *     caller's own access before any of these rows existed.
 */
export function serverRunDeps({ supabase, run, env = process.env, callModel = null }) {
  // Which window rows this process has already written, so a save costs one
  // upsert rather than re-writing every window finished so far.
  const persisted = new Set();

  // A policy refusal stops the DOCUMENT immediately, using the loop's own
  // abort contract rather than a new one. Without this, a sealed matter or a
  // paused one would be asked the same question once per remaining window —
  // refused every time, before any provider is contacted, but still a hundred
  // pointless round trips to the gate for a four-hundred-document run.
  const stop = new AbortController();
  let refusal = null;

  return {
    signal: stop.signal,
    /** The refusal that stopped this document, if any. Read by the caller. */
    policyRefusal: () => refusal,

    async fetchPassages(documentId) {
      const rows = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase
          .from('passages')
          .select('id, text, page_start, page_end, sequence_number')
          .eq('document_id', documentId)
          .order('sequence_number')
          .order('id')
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw new Error(`passages: ${error.message}`);
        rows.push(...(data ?? []));
        if ((data?.length ?? 0) < PAGE_SIZE) break;
        // Returning a prefix here would be the very silence this whole lane
        // removes — a half-read document classified as if it were whole.
        if (rows.length >= PASSAGE_CEILING) {
          throw new Error(
            `this document has more than ${PASSAGE_CEILING.toLocaleString()} passages, `
            + 'which is past what the classifier will read in one pass; it was not classified.',
          );
        }
      }
      return rows;
    },

    /**
     * What has already been finished for this document.
     *
     * Rows first. If there are none, the browser's own record for the same
     * plan is read instead: a run the lawyer started in a tab, got bored of and
     * closed has real finished windows in `documents.metadata.bucketizer.run`,
     * and asking for them again would be money spent on work already done.
     */
    async loadRun(documentId) {
      const { data, error } = await supabase
        .from('bucketizer_run_windows')
        .select('plan_hash, window_index, done_at, first_page, last_page, assignments, failed, model_id')
        .eq('document_id', documentId)
        .order('done_at', { ascending: false });
      if (error) throw new Error(`window progress: ${error.message}`);

      if (data?.length) {
        // Newest plan wins. An older plan's windows describe text this
        // document no longer has, and the loop discards a mismatched hash.
        const hash = data[0].plan_hash;
        const group = data.filter((r) => r.plan_hash === hash);
        for (const r of group) persisted.add(r.window_index);
        return {
          v: 1,
          hash,
          windows_total: group.length,
          started_at: group[group.length - 1].done_at,
          model: group[0].model_id ?? run.model_id,
          w: group.map((r) => ({
            i: r.window_index,
            done_at: r.done_at,
            fp: r.first_page,
            lp: r.last_page,
            a: Array.isArray(r.assignments) ? r.assignments : [],
            ...(r.failed ? { failed: r.failed } : {}),
          })),
        };
      }

      const { data: docRow } = await supabase
        .from('documents').select('metadata').eq('id', documentId).maybeSingle();
      const fromTab = docRow?.metadata?.bucketizer?.run;
      return fromTab && fromTab.v === 1 && Array.isArray(fromTab.w) ? fromTab : null;
    },

    async saveRun(documentId, stored) {
      const fresh = stored.w.filter((w) => !persisted.has(w.i));
      if (!fresh.length) return;
      const { error } = await supabase
        .from('bucketizer_run_windows')
        .upsert(fresh.map((w) => ({
          matterspace_id: run.matterspace_id,
          document_id: documentId,
          plan_hash: stored.hash,
          window_index: w.i,
          run_id: run.id,
          done_at: w.done_at,
          first_page: w.fp ?? null,
          last_page: w.lp ?? null,
          assignments: w.a ?? [],
          failed: w.failed ?? null,
          model_id: stored.model ?? run.model_id,
        })), { onConflict: 'document_id,plan_hash,window_index', ignoreDuplicates: true });
      if (error) throw new Error(`window progress: ${error.message}`);
      for (const w of fresh) persisted.add(w.i);
    },

    /**
     * Write the document's rows — and only what a re-run is allowed to.
     *
     * `planClassificationWrites` is the SAME function the browser uses, and the
     * `status = 'proposed'` filter rides on the UPDATE itself. A row an
     * attorney confirmed at four in the afternoon is not overwritten by a
     * refresh this run planned at three: the update simply matches nothing.
     */
    async finish(documentId, result) {
      const { data: existing, error: exErr } = await supabase
        .from('bucketizer_classifications')
        .select('id, node_id, status')
        .eq('document_id', documentId);
      if (exErr) throw new Error(`existing rows: ${exErr.message}`);

      const proposed = result.rows.map((r) => ({
        node_id: r.node_id,
        confidence: r.confidence,
        rationale: r.rationale,
        passage_ids: r.passage_ids,
      }));
      const plan = planClassificationWrites(existing ?? [], proposed);

      if (plan.insert.length) {
        const { error } = await supabase
          .from('bucketizer_classifications')
          .upsert(plan.insert.map((r) => ({
            ...r,
            matterspace_id: run.matterspace_id,
            document_id: documentId,
            status: 'proposed',
            model_id: run.model_id,
          })), { onConflict: 'document_id,node_id', ignoreDuplicates: true });
        if (error) throw new Error(`insert: ${error.message}`);
      }

      for (const { id, row } of plan.refresh) {
        const { error } = await supabase
          .from('bucketizer_classifications')
          .update({
            confidence: row.confidence,
            rationale: row.rationale,
            passage_ids: row.passage_ids,
            model_id: run.model_id,
            proposed_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('status', 'proposed');
        if (error) throw new Error(`refresh: ${error.message}`);
      }

      // The coverage record — how much of the document was actually read — is
      // written where the browser writes it, because the trial-outline lane
      // reads it there and does not care which machine did the reading. The
      // working `run` key is cleared for the same reason: the window rows are
      // the authority now.
      const sentinel = sentinelAfterRun({
        existingRows: (existing ?? []).length,
        writtenRows: result.rows.length,
        completedAt: result.coverage.completed_at,
      });
      const { data: docRow, error: readErr } = await supabase
        .from('documents').select('metadata').eq('id', documentId).maybeSingle();
      if (readErr) throw new Error(`metadata: ${readErr.message}`);
      const meta = { ...(docRow?.metadata ?? {}) };
      const bucketizer = { ...(meta.bucketizer ?? {}), coverage: result.coverage };
      delete bucketizer.run;
      if (sentinel) bucketizer.no_buckets_at = sentinel;
      else delete bucketizer.no_buckets_at;
      const { error: upErr } = await supabase
        .from('documents').update({ metadata: { ...meta, bucketizer } }).eq('id', documentId);
      if (upErr) throw new Error(`metadata: ${upErr.message}`);
    },

    /**
     * One window, through every guard the product has.
     *
     * The body is built by the SAME helper scripts/bucketize.mjs uses, so the
     * bytes that reach Anthropic are the shape this feature has always sent,
     * and the feature label and document id ride in the ENVELOPE — never in
     * the body, so no prompt or excerpt can reach the Record.
     */
    async callWindow(call) {
      const params = buildStructuredParams({
        model: run.model_id,
        system: call.system,
        userContent: call.userContent,
        toolName: CLASSIFY_TOOL_NAME,
        toolDescription: CLASSIFY_TOOL_DESCRIPTION,
        inputSchema: CLASSIFY_SCHEMA,
        maxTokens: call.maxTokens,
      });
      const send = callModel ?? serverLlmCall;
      let json;
      try {
        ({ json } = await send({
          supabaseUrl: env.VITE_SUPABASE_URL || env.SUPABASE_URL,
          serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
          userId: run.requested_by,
          matterId: run.matterspace_id,
          provider: 'anthropic',
          model: run.model_id,
          body: JSON.stringify(params),
          // Every window of a document is one call, so a long deposition leaves
          // several rows naming the same document — which is what happened, and
          // is what the Record should say.
          feature: 'bucketizer.classify',
          documentIds: [call.documentId],
          ledger: supabase,
          env,
        }));
      } catch (err) {
        // The seal, the pause, a spent wallet, a tier violation: the same
        // answer awaits every other window of every other document, so stop
        // asking. The loop's own abort path returns at once and keeps every
        // window already finished — which is exactly the shape wanted, so the
        // refusal rides out alongside it rather than as a second mechanism.
        const halt = haltFor(err);
        if (halt) { refusal = halt; stop.abort(); }
        throw err;
      }
      const raw = extractStructuredOutput(json);
      if (raw == null) throw new Error('Model did not return structured output.');
      return raw;
    },
  };
}

