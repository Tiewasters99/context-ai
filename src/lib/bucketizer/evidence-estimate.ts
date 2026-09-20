// What the evidence pass is about to cost, before it starts.
//
// Same rule as the classify estimate (feedback:
// agent-economics-deterministic-first): the run is quoted, it waits for a
// click, and no rate is invented here. `lib/usage-prices.mjs` is the table
// `/api/llm` charges from, imported directly, with `_test-usage-meter.mjs`
// failing the build if it drifts from the pens.
//
// This pass is much smaller than a classify pass, and the arithmetic should
// make that obvious rather than make it sound impressive. One call per
// (issue, document) pairing, over CONFIRMED classifications only, with at most
// forty already-recorded passages in each call. A matter with four hundred
// documents and a seventy-node tree does not produce twenty-eight thousand
// calls: it produces one per pairing the attorney has actually confirmed,
// which on Fleming today is a few hundred.

import { estimateLlmCents } from '../../../lib/usage-prices.mjs';
import { EVIDENCE_MAX_TOKENS, MAX_CANDIDATE_PASSAGES } from './evidence-run';

/**
 * Characters per candidate passage, for pricing before any passage is read.
 *
 * A transcript Q/A chunk measures ~280 characters; a medical-record or brief
 * chunk runs longer. 1,200 is above both, because an estimate that comes in
 * under the truth is the failure mode that matters.
 */
export const ASSUMED_CHARS_PER_PASSAGE = 1_200;

/** Envelope, schema, tool definition, system prompt and the issue text. */
const PER_CALL_OVERHEAD_BYTES = 4_000;

export interface EvidenceEstimatePair {
  nodeId: string;
  documentId: string;
  passageCount: number;
}

export interface EvidenceEstimate {
  /** Pairings that will be sent to the model. */
  pairs: number;
  /** Distinct issues and documents those pairings touch. */
  nodes: number;
  documents: number;
  /** Pairings skipped because the classification records no passages. */
  pairsWithoutPassages: number;
  /** Pairings a previous pass already finished — not charged again. */
  pairsAlreadyRun: number;
  passages: number;
  cents: number;
  modelId: string;
}

export function estimateEvidenceRun(
  pairs: EvidenceEstimatePair[],
  options: {
    modelId: string;
    provider: string;
    /** Pairings already carrying `evidence_run_at`. */
    alreadyRun?: number;
  },
): EvidenceEstimate {
  const nodes = new Set<string>();
  const documents = new Set<string>();
  let withoutPassages = 0;
  let passages = 0;
  let cents = 0;
  let billable = 0;

  for (const pair of pairs) {
    nodes.add(pair.nodeId);
    documents.add(pair.documentId);
    const count = Math.min(Math.max(0, pair.passageCount), MAX_CANDIDATE_PASSAGES);
    if (count === 0) {
      // No candidates, no call — and the dialog says so out loud, because a
      // pairing that is skipped is a pairing the outline will have no quote
      // for, which the attorney needs to know before and not after.
      withoutPassages += 1;
      continue;
    }
    billable += 1;
    passages += count;
    cents += estimateLlmCents({
      provider: options.provider,
      model: options.modelId,
      // Bytes as a NUMBER: the shared estimator reaches for Node's Buffer when
      // handed a string, and this runs in a browser.
      bodyText: count * ASSUMED_CHARS_PER_PASSAGE + PER_CALL_OVERHEAD_BYTES,
      maxOutputTokens: EVIDENCE_MAX_TOKENS,
    });
  }

  return {
    pairs: billable,
    nodes: nodes.size,
    documents: documents.size,
    pairsWithoutPassages: withoutPassages,
    pairsAlreadyRun: options.alreadyRun ?? 0,
    passages,
    cents,
    modelId: options.modelId,
  };
}
