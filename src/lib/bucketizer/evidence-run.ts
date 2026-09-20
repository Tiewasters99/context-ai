// The evidence pass: from a confirmed classification to the passages that
// support it, and the verbatim span of each.
//
// Every effect arrives as `EvidenceDeps` — reading passages, calling the
// model, writing the rows — so the offline harness can hand this module arrays
// and a counter. It imports nothing under `@/`: Node's type stripping does not
// resolve the alias, and `@/lib/supabase` reads `import.meta.env` at module
// scope. The Supabase-backed deps live in `evidence.ts`, which the harness
// never imports. `classify-run.ts` is built the same way and for the same
// reason.
//
// THE UNIT OF WORK IS A (NODE, DOCUMENT) PAIR, and it is the unit of failure
// too. A pair either yields validated evidence, yields none, or fails with a
// sentence the attorney can read — it never yields a quotation nobody checked.
// A failed pair is recorded as run, so the next pass does not pay for the same
// misunderstanding again; "Retry the failures" clears the mark deliberately.
//
// WHAT IS NEVER DONE HERE
// ---------------------------------------------------------------------------
// The candidate passages are the ones the classifier already recorded on the
// row. This pass does not go looking for more. A pair whose row carries no
// `passage_ids` — every manual classification, and every row written by the
// service-role CLI, which still reads only the first 200 passages — is skipped
// with that said out loud, not quietly filled in from a whole-document read.
// Searching the document for candidates is a different feature (the outline
// spec's "passage-level find evidence for this issue"), it costs a different
// amount of money, and pretending this pass does it would misrepresent how
// much of the record was actually looked at.

import { buildCite, type CiteDocument, type CitePassage } from './cite';
import { describeQuoteRejection, findVerbatim } from './quote';
import {
  EVIDENCE_SYSTEM,
  buildEvidenceRepairContent,
  buildEvidenceUserContent,
  checkEvidenceContract,
  type EvidencePromptNode,
} from './evidence-prompt';
import { LlmCallError } from './llm-error';

/** Output allowance per pair. A dozen quotations and their sentences. */
export const EVIDENCE_MAX_TOKENS = 3_000;

/**
 * Candidate passages sent for one pair.
 *
 * `MERGED_PASSAGE_CAP` is 40, and forty transcript chunks is ~11k characters —
 * comfortably inside one call, and inside the sealed pen's window too.
 */
export const MAX_CANDIDATE_PASSAGES = 40;

export interface EvidencePassageRow extends CitePassage {
  text: string;
  sequence_number?: number | null;
}

export interface EvidencePair {
  /** The `bucketizer_classifications` row this pair comes from. */
  classificationId: string;
  nodeId: string;
  documentId: string;
  documentTitle: string;
  docType: string | null;
  documentWitness?: string | null;
  passageIds: string[];
}

export interface NewEvidenceItem {
  node_id: string;
  document_id: string;
  passage_id: string;
  /** The PASSAGE's characters. Never the model's. */
  quote: string;
  quote_offset: number;
  rationale: string;
  position: number;
}

export interface EvidenceCall {
  system: string;
  userContent: string;
  maxTokens: number;
  /** 1 on the first attempt, 2 on the repair. */
  attempt: number;
  nodeId: string;
  documentId: string;
}

export interface SavePairInput {
  pair: EvidencePair;
  items: NewEvidenceItem[];
  modelId: string;
  /** A sentence when the pair could not be used; null when it ran clean. */
  failed: string | null;
  at: string;
}

export interface EvidenceDeps {
  /** The passages behind `passageIds`, in reading order. */
  fetchPassages(passageIds: string[]): Promise<EvidencePassageRow[]>;
  /** The model's raw tool input. Throws `LlmCallError` on a refusal. */
  call(call: EvidenceCall): Promise<unknown>;
  /** Write the items and mark the pair run, in one step. */
  savePair(input: SavePairInput): Promise<void>;
  now?: () => string;
}

export type PairStatus =
  /** Validated evidence was written. */
  | 'found'
  /** The model read the excerpts and none of them supports the issue. */
  | 'none'
  /** The row records no candidate passages, so there was nothing to read. */
  | 'no_candidates'
  /** The answer could not be used, twice — or every quotation was invented. */
  | 'failed';

export interface PairOutcome {
  status: PairStatus;
  items: number;
  /** Quotations dropped because they are not in the stored passage. */
  dropped: number;
  /** Whether a model call was made (and therefore charged). */
  charged: boolean;
  notes: string[];
}

export interface EvidenceNode extends EvidencePromptNode {
  id: string;
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

/** A confirmed classification row, as the pass needs to see it. */
export interface PairCandidate extends EvidencePair {
  /** Set once a pass has read this pairing. Null means it is still to do. */
  evidenceRunAt: string | null;
  evidenceFailed: string | null;
}

export interface PairPartition {
  todo: EvidencePair[];
  alreadyRun: number;
  failed: number;
  withoutPassages: number;
}

/**
 * Which pairings a pass still has to pay for.
 *
 * Resume is a FACT IN THE DATABASE, not a variable in a loop: a pairing
 * carrying `evidence_run_at` was read, and is skipped. That survives a closed
 * tab, a different browser and a different machine — Eden works from four —
 * and it is the same shape the classifier's per-window record takes
 * (PR #168), for the same reason.
 *
 * A pairing that FAILED also carries the mark, so a second pass does not spend
 * the same money on the same misunderstanding. Clearing it is deliberate:
 * "retry the failures" is a button, not a side effect of pressing run again.
 */
export function partitionPairs(
  candidates: PairCandidate[],
  options: { retryFailed?: boolean } = {},
): PairPartition {
  const todo: EvidencePair[] = [];
  let alreadyRun = 0;
  let failed = 0;
  let withoutPassages = 0;

  for (const c of candidates) {
    if (!c.passageIds.length) withoutPassages += 1;
    if (c.evidenceRunAt) {
      alreadyRun += 1;
      if (c.evidenceFailed) failed += 1;
      if (!(options.retryFailed && c.evidenceFailed)) continue;
    }
    todo.push({
      classificationId: c.classificationId,
      nodeId: c.nodeId,
      documentId: c.documentId,
      documentTitle: c.documentTitle,
      docType: c.docType,
      documentWitness: c.documentWitness ?? null,
      passageIds: c.passageIds,
    });
  }

  return { todo, alreadyRun, failed, withoutPassages };
}

// ---------------------------------------------------------------------------
// One pair
// ---------------------------------------------------------------------------

export async function findEvidenceForPair(input: {
  pair: EvidencePair;
  node: EvidenceNode;
  deps: EvidenceDeps;
  modelId: string;
  signal?: AbortSignal;
}): Promise<PairOutcome> {
  const { pair, node, deps, modelId } = input;
  const now = deps.now ?? (() => new Date().toISOString());
  const notes: string[] = [];
  const where = `${node.label} · ${pair.documentTitle}`;

  if (!pair.passageIds.length) {
    const failed =
      'no candidate passages are recorded on this classification, so there was nothing to read. '
      + 'Re-classify the document to record them.';
    await deps.savePair({ pair, items: [], modelId, failed, at: now() });
    return { status: 'no_candidates', items: 0, dropped: 0, charged: false, notes: [`${where} — ${failed}`] };
  }

  const passages = (await deps.fetchPassages(pair.passageIds.slice(0, MAX_CANDIDATE_PASSAGES)))
    .filter((p) => typeof p.text === 'string' && p.text.trim().length > 0);

  if (!passages.length) {
    const failed =
      'the passages this classification points at no longer hold any text — the document '
      + 'was probably re-ingested, which replaces its passages. Re-classify it.';
    await deps.savePair({ pair, items: [], modelId, failed, at: now() });
    return { status: 'no_candidates', items: 0, dropped: 0, charged: false, notes: [`${where} — ${failed}`] };
  }

  const byId = new Map(passages.map((p) => [p.id, p]));
  const built = buildEvidenceUserContent(
    node,
    { title: pair.documentTitle, docType: pair.docType },
    passages.map((p) => ({
      id: p.id,
      text: p.text,
      page_start: p.page_start,
      line_start: p.line_start,
      line_end: p.line_end,
    })),
  );
  const knownRefs = new Set(built.refToPassageId.keys());

  let raw = await deps.call({
    system: EVIDENCE_SYSTEM,
    userContent: built.userContent,
    maxTokens: EVIDENCE_MAX_TOKENS,
    attempt: 1,
    nodeId: pair.nodeId,
    documentId: pair.documentId,
  });

  let check = checkEvidenceContract(raw, knownRefs);
  if (!check.ok) {
    // One repair. A second misunderstanding of the same contract will not be
    // resolved by a third payment.
    raw = await deps.call({
      system: EVIDENCE_SYSTEM,
      userContent: buildEvidenceRepairContent(built.userContent, check.reason, raw),
      maxTokens: EVIDENCE_MAX_TOKENS,
      attempt: 2,
      nodeId: pair.nodeId,
      documentId: pair.documentId,
    });
    const second = checkEvidenceContract(raw, knownRefs);
    if (!second.ok) {
      const failed =
        `the model's answer could not be used (${second.reason}), twice. `
        + 'No evidence was recorded for this pairing; the documents stay in the bucket.';
      await deps.savePair({ pair, items: [], modelId, failed, at: now() });
      return { status: 'failed', items: 0, dropped: 0, charged: true, notes: [`${where} — ${failed}`] };
    }
    check = second;
  }

  // -------------------------------------------------------------------------
  // Deterministic again: every quotation is found in the stored passage, or it
  // does not exist. Nothing here repairs, trims or re-spaces a quotation.
  // -------------------------------------------------------------------------
  const items: NewEvidenceItem[] = [];
  const usedPassages = new Set<string>();
  let dropped = 0;

  for (const item of check.items) {
    const passageId = built.refToPassageId.get(item.ref);
    const passage = passageId ? byId.get(passageId) : undefined;
    if (!passage || !passageId) { dropped += 1; continue; }
    // One quotation per passage per bucket: the table's key, and the right
    // answer anyway — a second span from the same passage is the same cite.
    if (usedPassages.has(passageId)) continue;

    const found = findVerbatim(passage.text, item.quote);
    if (!found.ok) {
      dropped += 1;
      notes.push(
        `${where} — a quotation attributed to ${citeOf(passage, pair)} was dropped: `
        + `${describeQuoteRejection(found.reason)}.`,
      );
      continue;
    }

    usedPassages.add(passageId);
    items.push({
      node_id: pair.nodeId,
      document_id: pair.documentId,
      passage_id: passageId,
      quote: found.match.quote,
      quote_offset: found.match.offset,
      rationale: item.why.slice(0, 600),
      position: items.length,
    });
  }

  // Every quotation invented is not "no evidence here" — it is an answer that
  // could not be used, and it is recorded as one so the pair can be retried
  // with a different model rather than reading as reviewed and empty.
  if (!items.length && dropped > 0) {
    const failed = dropped === 1
      ? 'the quotation the model gave is not present in the stored passage word for word, '
        + 'so nothing was recorded. Try again, or with another model.'
      : `none of the ${dropped} quotations the model gave is present in the stored passages `
        + 'word for word, so nothing was recorded. Try again, or with another model.';
    await deps.savePair({ pair, items: [], modelId, failed, at: now() });
    return { status: 'failed', items: 0, dropped, charged: true, notes: [`${where} — ${failed}`, ...notes] };
  }

  await deps.savePair({ pair, items, modelId, failed: null, at: now() });
  if (dropped > 0) {
    notes.push(
      `${where} — ${dropped} quotation${dropped === 1 ? ' was' : 's were'} dropped for not matching the stored text.`,
    );
  }
  return {
    status: items.length ? 'found' : 'none',
    items: items.length,
    dropped,
    charged: true,
    notes,
  };
}

function citeOf(passage: EvidencePassageRow, pair: EvidencePair): string {
  const doc: CiteDocument = {
    id: pair.documentId,
    title: pair.documentTitle,
    doc_type: pair.docType,
    witness_name: pair.documentWitness ?? null,
  };
  return buildCite(passage, doc).text;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface EvidenceProgress {
  done: number;
  total: number;
  current: string;
  /** Evidence items written this pass. */
  items: number;
  /** Pairs that read clean and found nothing. */
  empty: number;
  /** Pairs that could not be used. */
  failed: number;
  /** Quotations discarded for not matching the stored passage. */
  dropped: number;
  /** Pairs actually sent to the model — what is being paid for. */
  called: number;
  pausedMessage: string | null;
  retryAfterSeconds: number | null;
  notes: string[];
}

export function emptyEvidenceProgress(total: number): EvidenceProgress {
  return {
    done: 0, total, current: '', items: 0, empty: 0, failed: 0, dropped: 0,
    called: 0, pausedMessage: null, retryAfterSeconds: null, notes: [],
  };
}

/**
 * Run the pass over the pairs handed in.
 *
 * Resume is not a loop variable here: the caller lists only the pairs that
 * have not been run, from the database, so a pass that stopped halfway comes
 * back to exactly what is left — across a different tab, browser or machine.
 *
 * 402 and 429 stop the pass and keep everything written so far, with the
 * server's own sentence. Every other failure is this pair's problem and the
 * pass carries on: one deposition the model will not answer about must not
 * cost the attorney the other ninety.
 */
export async function runEvidencePass(input: {
  pairs: EvidencePair[];
  nodesById: Map<string, EvidenceNode>;
  deps: EvidenceDeps;
  modelId: string;
  signal?: AbortSignal;
  onProgress?: (p: EvidenceProgress) => void;
}): Promise<EvidenceProgress> {
  const progress = emptyEvidenceProgress(input.pairs.length);
  const report = () => input.onProgress?.({ ...progress, notes: [...progress.notes] });

  for (const pair of input.pairs) {
    if (input.signal?.aborted) break;
    const node = input.nodesById.get(pair.nodeId);
    if (!node) { progress.done += 1; continue; }

    progress.current = `${node.label} · ${pair.documentTitle}`;
    report();

    try {
      const outcome = await findEvidenceForPair({
        pair, node, deps: input.deps, modelId: input.modelId, signal: input.signal,
      });
      progress.items += outcome.items;
      progress.dropped += outcome.dropped;
      if (outcome.charged) progress.called += 1;
      if (outcome.status === 'none') progress.empty += 1;
      if (outcome.status === 'failed' || outcome.status === 'no_candidates') progress.failed += 1;
      progress.notes.push(...outcome.notes);
    } catch (err) {
      if (input.signal?.aborted) break;
      if (err instanceof LlmCallError && err.isUsagePause) {
        progress.pausedMessage = err.message;
        progress.retryAfterSeconds = err.retryAfterSeconds;
        report();
        return { ...progress, notes: [...progress.notes] };
      }
      progress.failed += 1;
      progress.notes.push(
        `${progress.current} — could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    progress.done += 1;
    report();
  }

  return { ...progress, notes: [...progress.notes] };
}
