// The one judgment step in the evidence lane: given a bucket and a document
// already filed into it, which passages actually support it, and which span of
// each one would a lawyer read out.
//
// Everything around this is deterministic (feedback:
// agent-economics-deterministic-first). The candidate passages are not
// searched for — they are the `passage_ids` the classifier already recorded
// for this (document, node) pair. The quotations are not trusted — every one
// is checked against the stored passage afterwards and dropped if it is not
// there, verbatim. What the model is for is the part no query answers: of
// these twelve passages, which three are the evidence, and where does the
// quotable sentence start and stop.
//
// THE CONTRACT IS STRICT ON PURPOSE. A sealed matter is served by Kimi K2.5
// rather than the Opus these prompts were tuned on (PR #163), and a less
// capable model's failure mode on a forced tool is a plausible-looking object
// with the wrong shape. An unvalidated evidence item is a quotation attributed
// to a witness — the single worst thing this product could emit — so the pair
// fails plainly instead.

import { MAX_QUOTE_CHARS, MIN_QUOTE_CHARS } from './quote';
import { buildRepairContent } from '@/lib/llm/contract';
import { citePage, type CitePageMetadata } from '../../../lib/cite-page.mjs';

export const EVIDENCE_TOOL_NAME = 'submit_supporting_passages';
export const EVIDENCE_TOOL_DESCRIPTION =
  'Submit the passages from this document that support this issue, with the exact words to quote.';

export const EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    evidence: {
      type: 'array',
      description:
        'The passages that genuinely support this issue, strongest first. Empty if none of them do.',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'The excerpt ref, e.g. "P3".' },
          quote: {
            type: 'string',
            description:
              'The exact words to quote, COPIED CHARACTER FOR CHARACTER from that excerpt. '
              + 'It must be a continuous run of text that appears in the excerpt.',
          },
          why: {
            type: 'string',
            description:
              'One sentence: what this quotation establishes about this issue. '
              + 'It is read by an attorney next to the quotation, so it must not repeat it.',
          },
        },
        required: ['ref', 'quote', 'why'],
      },
    },
  },
  required: ['evidence'],
};

export const EVIDENCE_SYSTEM = `You are a trial lawyer pulling the record evidence for one issue in a case outline.

You are given one issue from the case-theory outline and a set of numbered excerpts from ONE document that has already been filed under that issue. Pick the excerpts that actually prove or disprove the issue, and for each one give the exact words you would read aloud.

Rules:
- QUOTE VERBATIM. Copy the quotation character for character out of the excerpt: same words, same spelling, same capitalisation, same punctuation. Do not tidy it, do not correct an obvious typo, do not expand an abbreviation, do not paraphrase, do not join two separate parts of the excerpt with an ellipsis. A quotation that is not present in the excerpt word for word is discarded, and the passage is lost with it.
- Quote a continuous run of at least ${MIN_QUOTE_CHARS} characters and at most ${MAX_QUOTE_CHARS}. Prefer the question and its answer together where the excerpt holds both.
- Choose FEW. Two or three passages that carry the issue beat eight that mention it. An excerpt that merely uses the same words is not evidence.
- If none of these excerpts supports the issue, return an empty list. That is a real and useful answer: it tells the attorney the document was filed under this issue on the strength of something these passages do not contain.
- Never quote from anywhere but the excerpts in front of you, and never write a quotation you have reasoned out rather than read.`;

export interface EvidencePromptPassage {
  id: string;
  text: string;
  page_start?: number | null;
  page_end?: number | null;
  line_start?: number | null;
  line_end?: number | null;
  /** Printed-page keys (lib/cite-page.mjs), when the caller selected them. */
  metadata?: CitePageMetadata | null;
}

export interface EvidencePromptNode {
  label: string;
  kind: string;
  description?: string | null;
  /** Claim → element → subissue, outermost first, for context. */
  ancestors?: { kind: string; label: string }[];
}

export interface EvidencePromptResult {
  userContent: string;
  refToPassageId: Map<string, string>;
}

/**
 * One pair's user content: where this issue sits in the outline, what the
 * attorney says belongs in it, and the candidate excerpts with their
 * coordinates.
 *
 * The coordinates are shown so the model sees the same page a reviewing
 * attorney will turn to. They are NOT how the cite is built — the cite is
 * built from the passage row afterwards, by `buildCite`, so a model that
 * misreads a header cannot move a citation.
 */
export function buildEvidenceUserContent(
  node: EvidencePromptNode,
  doc: { title: string; docType?: string | null },
  passages: EvidencePromptPassage[],
): EvidencePromptResult {
  const refToPassageId = new Map<string, string>();
  const parts: string[] = [];
  for (let i = 0; i < passages.length; i++) {
    const ref = `P${i + 1}`;
    const p = passages[i];
    refToPassageId.set(ref, p.id);
    parts.push(`[${ref}]${coordinates(p)}\n${p.text ?? ''}`);
  }

  const path = (node.ancestors ?? []).map((a) => a.label).concat(node.label).join(' › ');
  const mustProve = node.description?.trim()
    ? `\nWhat belongs here, in the attorney's words: ${node.description.trim()}`
    : '';

  return {
    userContent:
      `## The issue\n${path}\n(${node.kind})${mustProve}\n\n`
      + `## The document\n${doc.title}${doc.docType ? ` (${doc.docType})` : ''}\n\n`
      + `## Excerpts from it\n${parts.join('\n\n')}`,
    refToPassageId,
  };
}

function coordinates(p: EvidencePromptPassage): string {
  const page = Number(citePage(p).pageStart);
  if (!Number.isFinite(page) || page <= 0) return '';
  const l1 = Number(p.line_start);
  if (!Number.isFinite(l1) || l1 <= 0) return ` (p. ${page})`;
  const l2 = Number(p.line_end);
  return Number.isFinite(l2) && l2 > 0 && l2 !== l1
    ? ` (${page}:${l1}–${l2})`
    : ` (${page}:${l1})`;
}

// ---------------------------------------------------------------------------
// The output contract
// ---------------------------------------------------------------------------

export interface RawEvidenceItem {
  ref: string;
  quote: string;
  why: string;
}

export type EvidenceContractCheck =
  | { ok: true; items: RawEvidenceItem[] }
  | { ok: false; reason: string };

/**
 * Validate the SHAPE of the answer. The quotations themselves are checked
 * against the stored passages by the runner — a quotation that does not match
 * is one dropped item, not a broken contract, and the rest of the answer still
 * stands.
 */
export function checkEvidenceContract(
  raw: unknown,
  knownRefs: Set<string>,
): EvidenceContractCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'the answer was not an object' };
  const list = (raw as { evidence?: unknown }).evidence;
  if (!Array.isArray(list)) return { ok: false, reason: 'no "evidence" array' };

  const items: RawEvidenceItem[] = [];
  let unknownRefs = 0;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const ref = typeof e.ref === 'string' ? e.ref.trim() : '';
    if (!ref) continue;
    if (!knownRefs.has(ref)) { unknownRefs += 1; continue; }
    if (typeof e.quote !== 'string') {
      return { ok: false, reason: `the quotation for ${ref} was not a string` };
    }
    const why = typeof e.why === 'string' ? e.why.trim() : '';
    if (!why) return { ok: false, reason: `no explanation for ${ref}` };
    items.push({ ref, quote: e.quote, why });
  }

  // Some invented refs among good ones are dropped. ALL of them invented means
  // the model never understood the ref scheme — repairable, and not a judgment
  // worth recording.
  if (!items.length && unknownRefs > 0) {
    return { ok: false, reason: `every excerpt ref was invented (${unknownRefs} of them)` };
  }
  return { ok: true, items };
}

/** The single repair attempt: the narrowest possible restatement. */
export function buildEvidenceRepairContent(
  original: string,
  reason: string,
  sent: unknown,
): string {
  // The prose moved to `src/lib/llm/contract.ts` when the tree and cite-check
  // gained the same discipline. Byte-identical to what this built before.
  return buildRepairContent({
    original,
    reason,
    sent,
    shape:
      `{"evidence":[{"ref":"<a ref that appears in the excerpts above, e.g. P3>",`
      + `"quote":"<words copied character for character out of that excerpt>",`
      + `"why":"<one sentence>"}]}`,
    rules:
      `If none of the excerpts supports the issue, answer {"evidence":[]}. `
      + `Do not invent refs, and do not write a quotation that is not in the excerpt.`,
  });
}
