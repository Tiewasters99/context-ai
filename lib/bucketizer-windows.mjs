// Whole-document classification: the window plan, the per-window prompt, the
// output contract, and the deterministic merge.
//
// WHERE THIS CAME FROM, AND WHY IT IS IN lib/ NOW
// ---------------------------------------------------------------------------
// This was `src/lib/bucketizer/windows.ts` (PR #168), a browser module. The
// same plan, the same prompt, the same contract and the same merge now have to
// run on the Fly worker as well, because a classification run must survive a
// closed laptop. Duplicating any of it would be the worst possible outcome: a
// run that starts in the tab and finishes on the worker would silently change
// the windows it partitions into (so a resumed window would be a different
// stretch of text), or the words it sends, or the way it folds the answers
// together. So the module moved here and BOTH sides import it —
// `src/lib/bucketizer/windows.ts` is now a one-line re-export.
//
// Nothing about the behaviour changed in the move: the types became JSDoc and
// a `.d.mts`, and that is all. `scripts/_verify-bucketizer-scale.mjs` holds the
// plan, the prompts, the contract and the merge unchanged.
//
// THE BUG THIS REPLACES
// ---------------------------------------------------------------------------
// Until #168 the classifier read `.range(0, 199)` — the first 200 passages of a
// document — and `buildClassifyUserContent` cut that again at 60,000
// characters. For a memo that is the whole document. For Blake Desmond's
// 247-page deposition it is the first thirty-odd pages: the witness was
// bucketed on the reporter's appearance page and the opening of the
// examination, and the testimony the case turns on was never read. The
// document still appeared, confidently, in a bucket — which is worse than
// appearing nowhere, because the tree then *looks* reviewed.
//
// THE SHAPE OF THE FIX
// ---------------------------------------------------------------------------
// Deterministic first, the model only where judgment is needed
// (feedback: agent-economics-deterministic-first):
//
//   1. DETERMINISTIC — partition the document's passages, in sequence order,
//      into windows of a fixed character budget. A PARTITION, not a sample:
//      every passage is in exactly one window, and no window overlaps another.
//      Stride sampling would be cheaper and is not on the table — a transcript
//      read every third page is a transcript nobody read.
//   2. MODEL — one structured call per window, against the same tree, with a
//      header saying which part of which document this is.
//   3. DETERMINISTIC — merge the per-window answers into the document's
//      buckets, carrying the supporting passage ids per bucket.
//
// The merge output keeps `passage_ids` per (document, node), which is the
// column `bucketizer_classifications` already has and the trial-outline spec
// already reads for its page:line cites.
//
// WHY WINDOWS ALSO FIX THE SEALED PATH
// ---------------------------------------------------------------------------
// PR #163 names an open follow-up: the router sizes requests to the model the
// caller NAMED (claude-opus-4-8, a declared 1M window), while a sealed matter
// is actually served by Kimi K2.5, whose window is far smaller — so a large
// sealed pass is rejected by Bedrock and surfaces as `sealed_pen_error`. A
// window here is ~20k input tokens whoever answers it, so the sealed pen is
// never handed a request it cannot hold.
//
// No `node:` imports, deliberately: this module is bundled into the browser.

import { buildRepairContent } from './llm-repair-content.mjs';
import { citePage } from './cite-page.mjs';

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * Characters of document text per window. Equal to the old whole-call budget
 * (`CLASSIFY_INPUT_CHAR_BUDGET`), so a short document is still exactly one
 * call, built exactly as before — the change is invisible until a document is
 * long enough that it used to be cut.
 *
 * ~60k characters is ~20k input tokens, which leaves an Opus-class or Kimi
 * window comfortable rather than full: attention, not just capacity, is what
 * a classification call is spending.
 */
export const WINDOW_CHAR_BUDGET = 60_000;

/**
 * How far the budget is allowed to grow before the window COUNT is allowed to
 * grow instead. A very long document (a 2,000-page production binder) would
 * otherwise be a hundred calls; widening each window first trades a little
 * attention for a lot of cost, up to a point where the sealed pen's context
 * would be at risk. ~150k characters is ~50k tokens.
 */
export const MAX_WINDOW_CHAR_BUDGET = 150_000;

/** Windows to aim for before widening each one. */
export const TARGET_MAX_WINDOWS = 24;

/**
 * Buckets a MERGED document may end up in. The per-window cap stays at
 * `MAX_ASSIGNMENTS_PER_DOC` (6) — that is a judgment about one stretch of
 * text. A 247-page deposition genuinely bears on more than six nodes of a
 * trial tree, so holding the merged document to six would re-introduce, at
 * the merge, exactly the loss the windows removed.
 */
export const MERGED_ASSIGNMENT_CAP = 12;

/** Supporting passages recorded per bucket. `passage_ids` is a uuid[] column. */
export const MERGED_PASSAGE_CAP = 40;

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** 32-bit FNV-1a, hex. Short, stable, and not a security boundary. */
function fnv1a(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// The page a lawyer cites (lib/cite-page.mjs): a measured printed page — a
// transcript's, a Westlaw star page — before the file's own page.
function pageOf(p, end) {
  const w = citePage(p);
  const v = end ? (w.pageEnd ?? w.pageStart) : (w.pageStart ?? w.pageEnd);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Partition a document's passages into windows.
 *
 * Passages arrive in reading order (`sequence_number`, id as tiebreaker) and
 * stay in it. A passage longer than the whole budget gets a window to itself
 * rather than being split or skipped — losing text is the one outcome this
 * module does not permit.
 *
 * The plan's `hash` is its identity over this document's TEXT. Saved progress
 * from a DIFFERENT hash is discarded rather than resumed, because window 3 of
 * the old plan is not window 3 of the new one. Deliberately NOT a function of
 * the tree: the attorney edits node descriptions while a run is going — that
 * is the feature — and a tree edit throwing away four hundred paid windows
 * would be the worst behaviour this module could have. Nodes deleted mid-run
 * are dropped at the merge instead.
 */
export function planWindows(passages, options = {}) {
  const base = options.windowChars ?? WINDOW_CHAR_BUDGET;
  const maxChars = options.maxWindowChars ?? MAX_WINDOW_CHAR_BUDGET;
  const targetWindows = Math.max(1, options.targetMaxWindows ?? TARGET_MAX_WINDOWS);

  const totalChars = passages.reduce((n, p) => n + (p.text?.length ?? 0), 0);

  // Widen before multiplying: aim for `targetWindows`, but never below the
  // base budget (short documents keep the old single-call behaviour) and never
  // above the ceiling (past which more windows is the safer trade).
  const windowChars = Math.min(
    Math.max(base, Math.ceil(totalChars / targetWindows)),
    Math.max(base, maxChars),
  );

  const windows = [];
  let current = [];
  let used = 0;

  const flush = () => {
    if (!current.length) return;
    const first = current[0];
    const last = current[current.length - 1];
    windows.push({
      index: windows.length,
      passages: current,
      chars: used,
      firstPage: pageOf(first, false),
      lastPage: pageOf(last, true),
    });
    current = [];
    used = 0;
  };

  for (const p of passages) {
    const len = p.text?.length ?? 0;
    if (current.length && used + len > windowChars) flush();
    current.push(p);
    used += len;
  }
  flush();

  const first = passages[0];
  const last = passages[passages.length - 1];
  return {
    windows,
    totalPassages: passages.length,
    totalChars,
    windowChars,
    firstPage: first ? pageOf(first, false) : null,
    lastPage: last ? pageOf(last, true) : null,
    hash: fnv1a(
      `v1|${passages.length}|${totalChars}|${windowChars}|${first?.id ?? ''}|${last?.id ?? ''}`,
    ),
  };
}

// ---------------------------------------------------------------------------
// The per-window prompt
// ---------------------------------------------------------------------------

/**
 * The window's own instruction, appended to the shared `CLASSIFY_SYSTEM`.
 *
 * Two things the model must not do with a partial view: guess at what the
 * rest of the document says, and force a fit because "this is a deposition,
 * it must go somewhere". Both produce a confident row a reviewing attorney
 * cannot check against the pages in front of them.
 */
export const WINDOW_SYSTEM_SUFFIX = `
This document is long, so you are reading ONE PART of it. Other parts go to you separately and the answers are merged afterwards.

- Judge only what is in front of you. Do not infer what other parts contain, and do not assign a bucket on the strength of the document's title or type alone.
- If this part genuinely fits no bucket, return an empty list. A part that is front matter, an exhibit index, or a certification usually fits nothing, and saying so is correct — another part will carry the substance.
- Cite the excerpt refs from THIS part that support each assignment.`;

/**
 * Build one window's user content. Mirrors `buildClassifyUserContent`'s shape
 * — outline, then `[Pn]` excerpts — so the model sees the format it is tuned
 * on, plus a header locating this part in the document and page numbers on
 * each excerpt (the merged rationale cites them, and a lawyer reading the
 * bucket needs to know which pages were the reason).
 */
export function buildWindowUserContent(doc, plan, window, outline) {
  const refToPassageId = new Map();
  const parts = [];
  for (let i = 0; i < window.passages.length; i++) {
    const ref = `P${i + 1}`;
    const p = window.passages[i];
    refToPassageId.set(ref, p.id);
    const page = pageOf(p, false);
    parts.push(`[${ref}]${page != null ? ` (p. ${page})` : ''} ${p.text ?? ''}`);
  }

  const total = plan.windows.length;
  const where = total > 1
    ? `\nPart ${window.index + 1} of ${total}${describeRange(window, plan)}.`
    : '';

  const userContent =
    `## Case-theory outline\n${outline}\n\n`
    + `## Document\nTitle: ${doc.title}`
    + `${doc.docType ? `\nType: ${doc.docType}` : ''}${where}\n\n`
    + parts.join('\n\n');

  return { userContent, refToPassageId, chars: userContent.length };
}

function describeRange(window, plan) {
  if (window.firstPage == null) return '';
  const span = window.lastPage != null && window.lastPage !== window.firstPage
    ? `pages ${window.firstPage}–${window.lastPage}`
    : `page ${window.firstPage}`;
  const of = plan.lastPage != null ? ` of ${plan.lastPage}` : '';
  return ` — ${span}${of}`;
}

// ---------------------------------------------------------------------------
// The output contract
// ---------------------------------------------------------------------------

/**
 * Validate a window's structured output before anything is written.
 *
 * A sealed matter is served by Kimi K2.5 rather than the Opus the prompts
 * were tuned on (PR #163: "Kimi K2.5 is not what these features were tuned
 * on"), and a less capable model's failure mode on a forced tool is a
 * plausible-looking object with the wrong shape — `{ buckets: [...] }`,
 * confidence as `"87%"`, refs invented as `"N99"`. None of that may reach the
 * table: a fabricated node ref is a document filed under a bucket nobody
 * chose.
 *
 * `knownRefs` is the ref set the outline actually handed the model. Some
 * unknown refs are dropped (the existing `decodeAssignments` behaviour). ALL
 * of them unknown means the model did not understand the ref scheme, which is
 * a repairable misunderstanding, not a judgment to record.
 */
export function checkWindowContract(raw, knownRefs) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'the answer was not an object' };
  const list = raw.assignments;
  if (!Array.isArray(list)) return { ok: false, reason: 'no "assignments" array' };

  const assignments = [];
  let unknownRefs = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const a = item;
    const ref = typeof a.ref === 'string' ? a.ref.trim() : '';
    if (!ref) continue;
    if (!knownRefs.has(ref)) { unknownRefs += 1; continue; }

    const confidence = Number(a.confidence);
    if (!Number.isFinite(confidence)) {
      return { ok: false, reason: `confidence for ${ref} was not a number` };
    }
    const rationale = typeof a.rationale === 'string' ? a.rationale.trim() : '';
    if (!rationale) return { ok: false, reason: `no rationale for ${ref}` };

    assignments.push({
      ref,
      confidence: Math.max(0, Math.min(1, confidence)),
      rationale,
      passageRefs: Array.isArray(a.passageRefs)
        ? a.passageRefs.filter((r) => typeof r === 'string')
        : [],
    });
  }

  if (!assignments.length && unknownRefs > 0) {
    return { ok: false, reason: `every node ref was invented (${unknownRefs} of them)` };
  }
  return { ok: true, assignments };
}

/**
 * The one repair attempt. Restates the contract in the narrowest possible
 * terms and shows the model what it actually sent. One retry, then the window
 * is reported as failed in plain language — a third try is money spent on the
 * same misunderstanding.
 */
export function buildRepairUserContent(original, reason, sent) {
  // The prose lives in `lib/llm-repair-content.mjs` — the same three-step
  // discipline is used by the tree, the evidence lane and cite-check, and one
  // copy of it is one place to improve it. The text is byte-identical to what
  // this function built before that module existed.
  return buildRepairContent({
    original,
    reason,
    sent,
    shape:
      `{"assignments":[{"ref":"<a ref that appears in the outline above, e.g. N4>",`
      + `"confidence":<a number between 0 and 1>,"rationale":"<one or two sentences>",`
      + `"passageRefs":["<a ref that appears in the excerpts above, e.g. P3>"]}]}`,
    rules:
      `If no bucket fits this part of the document, answer {"assignments":[]}. `
      + `Do not invent refs, and do not write confidence as a percentage or a string.`,
  });
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

/**
 * Fold per-window answers into the document's buckets.
 *
 * Pure and order-independent: the results are sorted by window index first, so
 * the same set of windows merges to byte-identical rows whether they finished
 * in order, out of order, across two sessions with a tab close in between, or
 * across a browser run and a worker run. That is what makes a resumed run and
 * an uninterrupted run the same run.
 *
 * Decisions, and why:
 * - CONFIDENCE is the MAXIMUM across windows, not the mean. A deposition whose
 *   pages 180-195 are squarely about causation belongs in causation; averaging
 *   that against eleven windows of unrelated testimony would bury it, which is
 *   the front-of-document bias this whole change exists to remove.
 * - RATIONALE comes from the window that was most confident, prefixed with the
 *   pages it read, and says how many parts agreed. The attorney confirming the
 *   row can turn to those pages.
 * - PASSAGE IDS are the union in reading order, capped. They are the seed of
 *   per-node passage evidence.
 * - NODES NOT IN `knownNodeIds` are dropped: a bucket deleted while the run
 *   was going does not come back as a row.
 */
export function mergeWindowResults(results, options = { windowsTotal: 0 }) {
  const assignmentCap = options.assignmentCap ?? MERGED_ASSIGNMENT_CAP;
  const passageCap = options.passageCap ?? MERGED_PASSAGE_CAP;
  const known = options.knownNodeIds;
  const ordered = [...results].sort((a, b) => a.index - b.index);

  const byNode = new Map();

  for (const w of ordered) {
    for (const a of w.assignments) {
      if (known && !known.has(a.node_id)) continue;
      let acc = byNode.get(a.node_id);
      if (!acc) {
        acc = {
          node_id: a.node_id,
          best: { confidence: -1, rationale: '', firstPage: null, lastPage: null },
          hits: 0,
          passages: [],
          seen: new Set(),
          firstWindow: w.index,
        };
        byNode.set(a.node_id, acc);
      }
      acc.hits += 1;
      // Strictly greater, so the EARLIEST window wins a tie — deterministic.
      if (a.confidence > acc.best.confidence) {
        acc.best = {
          confidence: a.confidence,
          rationale: a.rationale,
          firstPage: w.firstPage,
          lastPage: w.lastPage,
        };
      }
      for (const pid of a.passage_ids) {
        if (acc.seen.has(pid)) continue;
        acc.seen.add(pid);
        if (acc.passages.length < passageCap) acc.passages.push(pid);
      }
    }
  }

  const windowsTotal = options.windowsTotal || ordered.length;
  const merged = [...byNode.values()].map((acc) => ({
    node_id: acc.node_id,
    confidence: Math.max(0, Math.min(1, acc.best.confidence)),
    rationale: composeRationale(acc.best, acc.hits, windowsTotal),
    passage_ids: acc.passages,
    windowHits: acc.hits,
    windowsTotal,
  }));

  merged.sort((a, b) =>
    (b.confidence - a.confidence)
    || (b.windowHits - a.windowHits)
    || a.node_id.localeCompare(b.node_id));

  return merged.slice(0, assignmentCap);
}

function composeRationale(best, hits, windowsTotal) {
  if (!best.rationale) return null;
  const where = best.firstPage != null
    ? (best.lastPage != null && best.lastPage !== best.firstPage
      ? `pp. ${best.firstPage}–${best.lastPage}`
      : `p. ${best.firstPage}`)
    : null;
  const agreement = windowsTotal > 1 ? ` · ${hits} of ${windowsTotal} parts of this document` : '';
  const head = where ? `${where}: ` : '';
  return `${head}${best.rationale}${agreement}`.slice(0, 2000);
}
