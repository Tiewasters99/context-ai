// The windowed classification run: resumable, per-window, and pure with
// respect to everything it touches.
//
// Every effect — reading passages, loading and saving progress, calling the
// model, writing the finished rows — arrives as `RunDeps`. `index.ts` builds
// the Supabase-backed set; the offline harness builds a set backed by arrays
// and a counter, which is how "a tab closed mid-run resumes without paying
// twice" can be an assertion rather than a hope.
//
// RESUMABILITY, AND WHY IT LIVES ON THE DOCUMENT
// ---------------------------------------------------------------------------
// Bulk classification is a browser loop today — moving it onto the Fly worker
// is a later lane that needs a job type and a migration, and this change is
// allowed neither. So the loop must survive the thing that actually happens:
// the lawyer closes the tab.
//
// Progress is written to `documents.metadata.bucketizer.run` after every
// window, using the column the classifier already writes for its
// "examined, no bucket" sentinel. That choice costs one round-trip per window
// and buys three things localStorage would not: it survives a different
// browser and a different machine (Eden works from four), it is visible to the
// worker lane that will eventually take this over, and it is per-document
// rather than per-tab, so two tabs cannot each pay for the same window.
//
// WHAT IS NEVER PAID FOR TWICE
// ---------------------------------------------------------------------------
// A window is recorded the moment it returns, with its answers. On resume,
// any window carrying `done_at` is skipped — no call, no charge. The one
// exception, stated plainly rather than hidden: a window that was IN FLIGHT
// when the tab closed was charged by the server and never recorded here, so it
// is asked again. That is one window, once, and the alternative (recording it
// before the answer arrives) would silently drop its content from the merge.

import { serializeOutline, CLASSIFY_SYSTEM } from '../../../lib/bucketizer-core.mjs';
import type { OutlineNode } from '../../../lib/bucketizer-core.mjs';
import {
  planWindows,
  buildWindowUserContent,
  buildRepairUserContent,
  checkWindowContract,
  mergeWindowResults,
  WINDOW_SYSTEM_SUFFIX,
  type WindowPassage,
  type WindowPlan,
  type WindowResult,
  type MergedAssignment,
} from './windows';
import { LlmCallError } from './llm-error';

/** Output allowance per window. Unchanged from the single-call classifier. */
export const WINDOW_MAX_TOKENS = 4_000;

/**
 * Rationale characters kept in the saved progress. The table's own column
 * allows 2,000; twenty-four windows times six assignments times two thousand
 * would put a quarter of a megabyte of jsonb on one document row for the sake
 * of text the merge keeps only the best of. The prompt asks for one or two
 * sentences, so 600 loses nothing real.
 */
const STORED_RATIONALE_CHARS = 600;

// ---------------------------------------------------------------------------
// What gets persisted
// ---------------------------------------------------------------------------

/** One finished window. Keys are short: this is jsonb on a hot row. */
export interface StoredWindow {
  /** Window index within the plan. */
  i: number;
  done_at: string;
  fp?: number | null;
  lp?: number | null;
  /** Assignments, already resolved to node and passage ids. */
  a?: { n: string; c: number; r: string; p: string[] }[];
  /** Set when the model's answer failed the contract twice. */
  failed?: string;
}

export interface StoredRun {
  v: 1;
  /** `WindowPlan.hash` — progress from a different plan is not resumed. */
  hash: string;
  windows_total: number;
  started_at: string;
  model: string;
  w: StoredWindow[];
}

/**
 * What replaces `run` once the document is done: how much of it was actually
 * read. The trial-outline lane currently guesses ("more than 200 passages →
 * flag the cite as window-limited"); this is the fact, and it is what that
 * flag should read instead.
 */
export interface Coverage {
  v: 1;
  windows: number;
  failed_windows: number;
  passages: number;
  chars: number;
  first_page: number | null;
  last_page: number | null;
  completed_at: string;
  model: string;
}

// ---------------------------------------------------------------------------
// Injected effects
// ---------------------------------------------------------------------------

export interface WindowCall {
  system: string;
  userContent: string;
  maxTokens: number;
  /** 1 on the first attempt, 2 on the repair — for the spend record. */
  attempt: number;
  documentId: string;
  windowIndex: number;
}

export interface RunDeps {
  /** ALL of the document's passages, in reading order. Never a prefix. */
  fetchPassages(documentId: string): Promise<WindowPassage[]>;
  loadRun(documentId: string): Promise<StoredRun | null>;
  saveRun(documentId: string, run: StoredRun): Promise<void>;
  /** Write the merged rows and swap `run` for `coverage`, atomically enough. */
  finish(documentId: string, result: { rows: MergedAssignment[]; coverage: Coverage }): Promise<void>;
  /** Returns the model's raw tool input. Throws `LlmCallError` on a refusal. */
  callWindow(call: WindowCall): Promise<unknown>;
  now?: () => string;
}

export type DocStatus =
  /** Rows written (or the sentinel set, when nothing fit). */
  | 'classified'
  /** No passages at all — a photo, a video, an image-only scan. */
  | 'no_text'
  /** Some window could not be reached; progress kept, retried next run. */
  | 'incomplete'
  /** The person pressed stop. Progress kept. */
  | 'aborted';

export interface DocOutcome {
  status: DocStatus;
  proposed: number;
  windowsTotal: number;
  windowsCalled: number;
  windowsResumed: number;
  windowsFailed: number;
  /** Plain-language notes, one per window that could not be used. */
  notes: string[];
}

export interface RunDocumentInput {
  doc: { id: string; title: string; doc_type?: string | null };
  nodes: OutlineNode[];
  deps: RunDeps;
  modelId: string;
  signal?: AbortSignal;
  onWindow?: (p: { done: number; total: number; charged: boolean }) => void;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function classifyDocumentWindowed(input: RunDocumentInput): Promise<DocOutcome> {
  const { doc, nodes, deps, modelId, signal } = input;
  const now = deps.now ?? (() => new Date().toISOString());

  const { outline, refToId } = serializeOutline(nodes);
  if (!outline) throw new Error('The tree is empty — generate or add buckets first.');
  const knownRefs = new Set(refToId.keys());
  const knownNodeIds = new Set(refToId.values());

  const passages = await deps.fetchPassages(doc.id);
  const base: DocOutcome = {
    status: 'classified', proposed: 0, windowsTotal: 0,
    windowsCalled: 0, windowsResumed: 0, windowsFailed: 0, notes: [],
  };
  if (!passages.length) return { ...base, status: 'no_text' };

  const plan = planWindows(passages);

  // Resume only a plan that describes the same text. A re-ingested deposition
  // has different passages, so window 3 of the old plan is not window 3 now.
  const prior = await deps.loadRun(doc.id);
  const run: StoredRun = prior && prior.hash === plan.hash && prior.v === 1
    ? { ...prior, windows_total: plan.windows.length, w: [...prior.w] }
    : { v: 1, hash: plan.hash, windows_total: plan.windows.length, started_at: now(), model: modelId, w: [] };

  const doneByIndex = new Map(run.w.map((w) => [w.i, w]));
  const outcome: DocOutcome = { ...base, windowsTotal: plan.windows.length, notes: [] };
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

    let stored: StoredWindow;
    try {
      stored = await runOneWindow({
        doc, plan, window, outline, knownRefs, refToId, deps, modelId, signal, now,
      });
    } catch (err) {
      if (signal?.aborted) return { ...outcome, status: 'aborted' };
      // 402 / 429 / 413: the wallet or the rate window. Everything finished so
      // far is saved; the run stops and the person is told when to come back.
      if (err instanceof LlmCallError && err.isUsagePause) throw err;
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

  const results: WindowResult[] = run.w
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

async function runOneWindow(args: {
  doc: { id: string; title: string; doc_type?: string | null };
  plan: WindowPlan;
  window: WindowPlan['windows'][number];
  outline: string;
  knownRefs: Set<string>;
  refToId: Map<string, string>;
  deps: RunDeps;
  modelId: string;
  signal?: AbortSignal;
  now: () => string;
}): Promise<StoredWindow> {
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
          `the model's answer could not be used (${second.reason}), twice. ` +
          `These pages are not in any bucket; file them by hand, or run again with a different model.`,
      };
    }
    check = second;
  }

  const seen = new Set<string>();
  const assignments: NonNullable<StoredWindow['a']> = [];
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
        .filter((id): id is string => Boolean(id)),
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
