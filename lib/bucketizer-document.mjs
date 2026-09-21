// The windowed classification of ONE document: resumable, per-window, and pure
// with respect to everything it touches.
//
// WHERE THIS CAME FROM, AND WHY IT IS IN lib/ NOW
// ---------------------------------------------------------------------------
// This was `src/lib/bucketizer/classify-run.ts` (PR #168). Every effect —
// reading passages, loading and saving progress, calling the model, writing the
// finished rows — already arrived as `RunDeps`, which is precisely what makes
// it portable: the browser builds a Supabase-and-`/api/llm` set of deps, the
// Fly worker builds a service-role-and-in-process set
// (`lib/bucketizer-run.mjs`), and the offline harness builds a set backed by
// arrays and a counter. Three callers, ONE loop — which is the only way "a run
// that moved to the worker is the same run" can be an assertion rather than a
// hope. So the loop moved here and `src/lib/bucketizer/classify-run.ts` is now
// a re-export.
//
// Nothing about the behaviour changed in the move: the types became JSDoc and a
// `.d.mts`. `scripts/_verify-bucketizer-scale.mjs` holds it unchanged.
//
// RESUMABILITY, AND WHERE IT IS RECORDED
// ---------------------------------------------------------------------------
// The loop does not know where progress is kept. It asks `deps.loadRun` for
// what has already been done and hands `deps.saveRun` a record after every
// window; WHERE that lands is the caller's business, and the two callers keep
// it in two places on purpose:
//
//   * the BROWSER writes `documents.metadata.bucketizer.run` (PR #168). One
//     round-trip per window, and it survives a different browser and a
//     different machine — but only while a tab is open somewhere;
//   * the WORKER writes `bucketizer_run_windows` rows (migration 079), which
//     is what survives the laptop being shut. It also SEEDS itself from the
//     browser's record when the plan hash matches, so a run abandoned in a tab
//     and picked up by the worker does not pay for its finished windows again.
//
// It is NOT a lock in either place. Two runners over the same document can each
// call the same undone window — the record makes the second resume what the
// first has FINISHED, not what it is in the middle of. The server side narrows
// that to almost nothing (one run per matter per kind, one job per document),
// and the honest position is stated rather than claimed away.
//
// WHAT IS NEVER PAID FOR TWICE
// ---------------------------------------------------------------------------
// A window is recorded the moment it returns, with its answers. On resume,
// any window carrying `done_at` is skipped — no call, no charge. The one
// exception, stated plainly rather than hidden: a window that was IN FLIGHT
// when the tab closed (or the worker died) was charged by the server and never
// recorded here, so it is asked again. That is one window, once, and the
// alternative (recording it before the answer arrives) would silently drop its
// content from the merge.
//
// No `node:` imports, deliberately: this module is bundled into the browser.

import { serializeOutline, CLASSIFY_SYSTEM } from './bucketizer-core.mjs';
import {
  planWindows,
  buildWindowUserContent,
  buildRepairUserContent,
  checkWindowContract,
  mergeWindowResults,
  WINDOW_SYSTEM_SUFFIX,
} from './bucketizer-windows.mjs';
import { LlmCallError } from './llm-call-error.mjs';

/** Output allowance per window. Unchanged from the single-call classifier. */
export const WINDOW_MAX_TOKENS = 4_000;

/**
 * Rationale characters kept in the saved progress. The table's own column
 * allows 2,000; twenty-four windows times six assignments times two thousand
 * would put a quarter of a megabyte of jsonb on one document row for the sake
 * of text the merge keeps only the best of. The prompt asks for one or two
 * sentences, so 600 loses nothing real.
 */
export const STORED_RATIONALE_CHARS = 600;

/**
 * Classify one document, whole.
 *
 * @param {import('./bucketizer-document.d.mts').RunDocumentInput} input
 * @returns {Promise<import('./bucketizer-document.d.mts').DocOutcome>}
 */
export async function classifyDocumentWindowed(input) {
  const { doc, nodes, deps, modelId, signal } = input;
  const now = deps.now ?? (() => new Date().toISOString());

  const { outline, refToId } = serializeOutline(nodes);
  if (!outline) throw new Error('The tree is empty — generate or add buckets first.');
  const knownRefs = new Set(refToId.keys());
  const knownNodeIds = new Set(refToId.values());

  const passages = await deps.fetchPassages(doc.id);
  const base = {
    status: 'classified', proposed: 0, windowsTotal: 0,
    windowsCalled: 0, windowsResumed: 0, windowsFailed: 0, notes: [],
  };
  if (!passages.length) return { ...base, status: 'no_text' };

  const plan = planWindows(passages);

  // Resume only a plan that describes the same text. A re-ingested deposition
  // has different passages, so window 3 of the old plan is not window 3 now.
  const prior = await deps.loadRun(doc.id);
  const run = prior && prior.hash === plan.hash && prior.v === 1
    ? { ...prior, windows_total: plan.windows.length, w: [...prior.w] }
    : { v: 1, hash: plan.hash, windows_total: plan.windows.length, started_at: now(), model: modelId, w: [] };

  const doneByIndex = new Map(run.w.map((w) => [w.i, w]));
  const outcome = { ...base, windowsTotal: plan.windows.length, notes: [] };
  let transient = 0;

  for (const window of plan.windows) {
    if (signal?.aborted) return { ...outcome, status: 'aborted' };

    const already = doneByIndex.get(window.index);
    if (already?.done_at) {
      outcome.windowsResumed += 1;
      if (already.failed) outcome.windowsFailed += 1;
      input.onWindow?.({ done: outcome.windowsResumed + outcome.windowsCalled, total: plan.windows.length, charged: false });
      continue;
    }

    let stored;
    try {
      stored = await runOneWindow({
        doc, plan, window, outline, knownRefs, refToId, deps, modelId, signal, now,
      });
    } catch (err) {
      if (signal?.aborted) return { ...outcome, status: 'aborted' };
      // 402 / 429: the wallet or the rate window. Everything finished so far
      // is saved; the run stops and the person is told when to come back.
      if (err instanceof LlmCallError && err.isUsagePause) throw err;

      // 413: this window is too big for the plan, and will be just as big
      // tomorrow. Recorded as a permanent failure on the window so the
      // document can still finish on its other parts, rather than pausing a
      // whole run behind one oversized stretch of text.
      if (err instanceof LlmCallError && err.isPermanentForThisRequest) {
        const refused = {
          i: window.index, done_at: now(), fp: window.firstPage, lp: window.lastPage,
          failed: `${err.message} These pages were not classified.`,
        };
        run.w.push(refused);
        doneByIndex.set(refused.i, refused);
        await deps.saveRun(doc.id, run);
        outcome.windowsCalled += 1;
        outcome.windowsFailed += 1;
        outcome.notes.push(`${doc.title}: part ${window.index + 1} of ${plan.windows.length} — ${refused.failed}`);
        input.onWindow?.({ done: outcome.windowsResumed + outcome.windowsCalled, total: plan.windows.length, charged: true });
        continue;
      }

      transient += 1;
      outcome.notes.push(`${doc.title}: part ${window.index + 1} of ${plan.windows.length} could not be read — ${messageOf(err)}`);
      outcome.windowsCalled += 1;
      input.onWindow?.({ done: outcome.windowsResumed + outcome.windowsCalled, total: plan.windows.length, charged: true });
      continue;
    }

    run.w.push(stored);
    doneByIndex.set(stored.i, stored);
    await deps.saveRun(doc.id, run);

    outcome.windowsCalled += 1;
    if (stored.failed) {
      outcome.windowsFailed += 1;
      outcome.notes.push(`${doc.title}: part ${window.index + 1} of ${plan.windows.length} — ${stored.failed}`);
    }
    input.onWindow?.({ done: outcome.windowsResumed + outcome.windowsCalled, total: plan.windows.length, charged: true });
  }

  // A window that could not be REACHED leaves the document unfinished on
  // purpose: no rows are written from a partial read, and the next run picks
  // up exactly the windows still missing.
  if (transient > 0) return { ...outcome, status: 'incomplete' };

  const results = run.w
    .filter((w) => !w.failed)
    .map((w) => ({
      index: w.i,
      firstPage: w.fp ?? null,
      lastPage: w.lp ?? null,
      assignments: (w.a ?? []).map((a) => ({
        node_id: a.n, confidence: a.c, rationale: a.r, passage_ids: a.p,
      })),
    }));

  const rows = mergeWindowResults(results, {
    windowsTotal: plan.windows.length,
    knownNodeIds,
  });

  await deps.finish(doc.id, {
    rows,
    coverage: {
      v: 1,
      windows: plan.windows.length,
      failed_windows: outcome.windowsFailed,
      passages: plan.totalPassages,
      chars: plan.totalChars,
      first_page: plan.firstPage,
      last_page: plan.lastPage,
      completed_at: now(),
      model: modelId,
    },
  });

  return { ...outcome, status: 'classified', proposed: rows.length };
}

// ---------------------------------------------------------------------------

async function runOneWindow(args) {
  const { doc, plan, window, outline, knownRefs, refToId, deps, now } = args;

  const built = buildWindowUserContent(
    { title: doc.title, docType: doc.doc_type ?? null },
    plan, window, outline,
  );
  // A one-window document is classified with exactly the prompt it always
  // was; the window rider only appears when there is more than one part.
  const system = `${CLASSIFY_SYSTEM}${plan.windows.length > 1 ? WINDOW_SYSTEM_SUFFIX : ''}`;

  let raw = await deps.callWindow({
    system,
    userContent: built.userContent,
    maxTokens: WINDOW_MAX_TOKENS,
    attempt: 1,
    documentId: doc.id,
    windowIndex: window.index,
  });

  let check = checkWindowContract(raw, knownRefs);
  if (!check.ok) {
    // One repair. A second misunderstanding of the same contract is not
    // going to be resolved by a third payment.
    const repairPrompt = buildRepairUserContent(built.userContent, check.reason, raw);
    raw = await deps.callWindow({
      system,
      userContent: repairPrompt,
      maxTokens: WINDOW_MAX_TOKENS,
      attempt: 2,
      documentId: doc.id,
      windowIndex: window.index,
    });
    const second = checkWindowContract(raw, knownRefs);
    if (!second.ok) {
      return {
        i: window.index,
        done_at: now(),
        fp: window.firstPage,
        lp: window.lastPage,
        failed:
          `the model's answer could not be used (${second.reason}), twice. `
          + `These pages are not in any bucket; file them by hand, or run again with a different model.`,
      };
    }
    check = second;
  }

  const seen = new Set();
  const assignments = [];
  for (const a of check.assignments) {
    const nodeId = refToId.get(a.ref);
    if (!nodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    assignments.push({
      n: nodeId,
      c: a.confidence,
      r: a.rationale.slice(0, STORED_RATIONALE_CHARS),
      p: a.passageRefs
        .map((r) => built.refToPassageId.get(r))
        .filter((id) => Boolean(id)),
    });
  }

  return {
    i: window.index,
    done_at: now(),
    fp: window.firstPage,
    lp: window.lastPage,
    a: assignments,
  };
}

function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}
