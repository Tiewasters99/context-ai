// What a bulk classify is about to cost, before it starts.
//
// Windowing a 483-document matter turns one call per document into several,
// and a change that multiplies a bill is a change that has to say so first.
// The rule (feedback: agent-economics-deterministic-first) is that nobody
// discovers the price afterwards: the run shows documents, windows and
// dollars, and waits for a click.
//
// NO PRICE IS INVENTED HERE. The rates come from `lib/usage-prices.mjs` —
// the same table `/api/llm` charges from, mirrored there from
// `lib/assistant-core.mjs` PENS and `lib/ocr-anthropic.mjs`, with
// `scripts/_test-usage-meter.mjs` failing the build on drift. This module
// only counts windows and bytes.
//
// The estimate errs HIGH, deliberately and in the same direction the server's
// does: characters per page is set at the wordy end, the output allowance is
// charged in full even though a classify answer is a few hundred tokens, and
// per-call cents are rounded up exactly as `estimateLlmCents` rounds them.

import { estimateLlmCents } from '../../../lib/usage-prices.mjs';
import { WINDOW_CHAR_BUDGET, MAX_WINDOW_CHAR_BUDGET, TARGET_MAX_WINDOWS } from './windows';
import { WINDOW_MAX_TOKENS } from './classify-run';

/**
 * Characters of extracted text per page, for turning a page count into a
 * window count before any passage is read.
 *
 * A deposition page is ~1,100 characters (25 lines of testimony); a dense
 * brief or medical record runs to ~2,000. 2,400 is above both, because an
 * estimate that comes in under the truth is the failure mode that matters: a
 * lawyer who was quoted $8 and charged $14 will not use the button again.
 */
export const ASSUMED_CHARS_PER_PAGE = 2_400;

/** Bytes of JSON envelope, schema, tool definition and system prompt per call. */
const PER_CALL_OVERHEAD_BYTES = 3_000;

export interface EstimateDoc {
  id: string;
  title: string;
  page_count?: number | null;
}

export interface RunEstimate {
  documents: number;
  windows: number;
  /** Documents whose page count is unknown; each counted as one window. */
  documentsWithoutPageCount: number;
  /** Documents the windowing will split — the ones that used to be truncated. */
  longDocuments: number;
  /** The largest single document, in windows. */
  largestDocumentWindows: number;
  cents: number;
  modelId: string;
  assumedCharsPerPage: number;
}

/** Windows a document of `pages` pages is expected to need. */
export function windowsForPages(pages: number | null | undefined): number {
  const p = Number(pages);
  if (!Number.isFinite(p) || p <= 0) return 1;
  const chars = p * ASSUMED_CHARS_PER_PAGE;
  // Mirrors planWindows: widen the budget toward the target count first, then
  // add windows once the budget hits its ceiling.
  const windowChars = Math.min(
    Math.max(WINDOW_CHAR_BUDGET, Math.ceil(chars / TARGET_MAX_WINDOWS)),
    Math.max(WINDOW_CHAR_BUDGET, MAX_WINDOW_CHAR_BUDGET),
  );
  return Math.max(1, Math.ceil(chars / windowChars));
}

/**
 * Price a bulk run.
 *
 * `outlineChars` is the serialized tree, which is re-sent with every window —
 * on a 71-node Fleming tree that is ~10 KB a call, and leaving it out would
 * understate a long document by a third.
 */
export function estimateRun(
  docs: EstimateDoc[],
  options: { modelId: string; provider: string; outlineChars: number },
): RunEstimate {
  let windows = 0;
  let withoutPageCount = 0;
  let longDocuments = 0;
  let largest = 0;
  let cents = 0;

  for (const doc of docs) {
    const pages = Number(doc.page_count);
    const known = Number.isFinite(pages) && pages > 0;
    if (!known) withoutPageCount += 1;

    const n = windowsForPages(doc.page_count);
    if (n > 1) longDocuments += 1;
    if (n > largest) largest = n;
    windows += n;

    const chars = known ? pages * ASSUMED_CHARS_PER_PAGE : WINDOW_CHAR_BUDGET;
    const perWindowChars = Math.min(chars, Math.ceil(chars / n) || chars);

    for (let i = 0; i < n; i++) {
      // Bytes, not a string: the shared estimator reaches for Node's Buffer
      // when handed text, and this runs in a browser.
      cents += estimateLlmCents({
        provider: options.provider,
        model: options.modelId,
        bodyText: perWindowChars + options.outlineChars + PER_CALL_OVERHEAD_BYTES,
        maxOutputTokens: WINDOW_MAX_TOKENS,
      });
    }
  }

  return {
    documents: docs.length,
    windows,
    documentsWithoutPageCount: withoutPageCount,
    longDocuments,
    largestDocumentWindows: largest,
    cents,
    modelId: options.modelId,
    assumedCharsPerPage: ASSUMED_CHARS_PER_PAGE,
  };
}

/** `$1.42`, or `under 1¢` — never a bare number of cents. */
export function formatCents(cents: number): string {
  if (cents <= 0) return 'under 1¢';
  if (cents < 100) return `${Math.round(cents)}¢`;
  return `$${(cents / 100).toFixed(2)}`;
}
