// Per-citation check: store lookup → free-DB fetch (via /api/legal-source)
// → confidence rating → five-level flag. Faithful port of the CLI's
// cite-check/lib/check.mjs, including decideFlag's invariant that red only
// fires on a verified mismatch.

import { generateStructured } from '@/lib/llm';
import { parseServerRefusal, ServerRefusalError, isFinalRefusal } from '@/lib/llm/refusals';
import {
  buildRepairContent,
  runWithContract,
  trimmedText,
  type ContractAttempt,
  type ContractCheck,
} from '@/lib/llm/contract';
import { UNREADABLE_CHECK_DETAIL, type Cite, type CheckFlag, type CheckResult, type CiteFlag } from './types';
import {
  findByCitation,
  getMatchingProposition,
  createAuthority,
  logVerification,
  type StoredAuthority,
  type StoredProposition,
} from './persist';

interface LegalSourceResult {
  found: boolean;
  full_text?: string | null;
  source_url?: string | null;
  source_label?: string | null;
}


async function fetchFromFreeDb(cite: Cite, signal?: AbortSignal, matterId?: string): Promise<LegalSourceResult> {
  try {
    const res = await fetch('/api/legal-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authority_type: cite.authority_type,
        citation_bluebook: cite.citation_bluebook,
        case_name: cite.case_name,
        // Which authorities a brief leans on is the matter's work product, and
        // this route proxies out to Cornell, eCFR, NY Senate and CourtListener.
        // Bound so a sealed matter's citation list stops at our own server.
        matterId,
      }),
      signal,
    });
    if (!res.ok) {
      const refusal = await parseServerRefusal(res);
      // A refusal is not a miss. "Not found on the free DBs" is a finding
      // about the citation; a spent budget, a full rate window or a sealed
      // matter is a finding about us, and flattening it into found:false
      // would mark every remaining cite "Westlaw paste needed" and hand the
      // lawyer a report that looks complete. Stop the run and say why.
      if (refusal.kind !== 'other') throw new ServerRefusalError(refusal);
      return { found: false };
    }
    return (await res.json()) as LegalSourceResult;
  } catch (err) {
    // Everything else — a network blip, an abort, a malformed body — keeps the
    // old behaviour: this citation is simply unverified and the run goes on.
    if (isFinalRefusal(err)) throw err;
    return { found: false };
  }
}

const RATE_SYSTEM = `You are a careful legal-citation auditor. Given a citation, the proposition the lawyer claims it stands for, and the source text we retrieved, assess whether the citation is real, well-formed, and supports that proposition.

Provide:
  - rating: "high" | "medium" | "low"
  - justification: 1-2 sentences explaining the rating

"high" = real, well-formed, supports the proposition.
"medium" = real and well-formed but the proposition is parallel/distant or the pin is missing.
"low" = likely fabricated, mis-attributed, or the proposition flatly contradicts the source.

If the source text is empty or generic, default to "medium" unless the citation has obvious format problems.`;

const RATE_SCHEMA = {
  type: 'object',
  properties: {
    rating: { type: 'string', enum: ['high', 'medium', 'low'] },
    justification: { type: 'string' },
  },
  required: ['rating', 'justification'],
} as const;

export const RATINGS = ['high', 'medium', 'low'] as const;
export type Rating = (typeof RATINGS)[number];

export interface RatedCite {
  rating: Rating;
  justification: string;
}

/**
 * THE RATING CONTRACT.
 *
 * Three words and a sentence. It was checked with
 * `result?.rating === 'high' || result?.rating === 'low' ? result.rating : 'medium'`
 * — so an answer of `"High"`, `"very high"`, `{}` or `"the citation is sound"`
 * all became **medium**, and "medium" is printed in the report as the model's
 * confidence in a citation the model never rated. On frontier Claude that
 * branch was almost never taken; the sealed pen takes it.
 *
 * Case and surrounding space ARE forgiven: a pen that answered "High " gave
 * the rating, in the format it happened to type. A word that is not one of the
 * three is not forgiven, because there is no honest way to map it.
 */
export function checkRatingContract(raw: unknown): ContractCheck<RatedCite> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'the answer was not an object' };
  }
  const r = raw as Record<string, unknown>;
  const word = trimmedText(r.rating)?.toLowerCase();
  if (!word) return { ok: false, reason: 'no "rating"' };
  if (!(RATINGS as readonly string[]).includes(word)) {
    return { ok: false, reason: `the rating was "${word}" — it must be exactly high, medium or low` };
  }
  const justification = trimmedText(r.justification);
  if (!justification) return { ok: false, reason: 'no "justification" for the rating' };
  return { ok: true, value: { rating: word as Rating, justification } };
}

export function buildRatingRepairContent(original: string, reason: string, sent: unknown): string {
  return buildRepairContent({
    original,
    reason,
    sent,
    shape: `{"rating":"high|medium|low","justification":"<one or two sentences>"}`,
    rules:
      `"rating" must be exactly one of the three words high, medium or low — not a number, `
      + `not a percentage, and not a sentence. If the source text is empty or generic, answer "medium" `
      + `and say so in the justification.`,
  });
}

/**
 * Returns the rating, or `null` when the model could not be held to the
 * contract twice. `null` is a real answer here — "not checked" — and the
 * caller must not turn it into a rating.
 *
 * A refusal (402, 429, a sealed matter's 403, an abort) is NOT caught: those
 * are facts about the server and they stop the run, exactly as before.
 */
async function rateConfidence(
  cite: Cite,
  sourceText: string,
  opts: { modelId: string; signal?: AbortSignal; matterId?: string },
): Promise<RatedCite | null> {
  const payload = JSON.stringify({
    citation: cite.citation_bluebook,
    proposition: cite.proposition,
    pin_cite: cite.pin_cite,
    source_text_excerpt: (sourceText ?? '').slice(0, 4000),
  });
  // The repair turn is the same call with the same 'citecheck.check' label, so
  // it is metered and written to the matter's Record like the first.
  const call = async ({ userContent }: ContractAttempt) => generateStructured<unknown>({
    modelId: opts.modelId,
    signal: opts.signal,
    // The payload carries the proposition verbatim from the draft.
    matterId: opts.matterId,
    feature: 'citecheck.check',
    system: RATE_SYSTEM,
    userContent,
    toolName: 'record_rating',
    toolDescription: 'Record the confidence rating for this citation.',
    inputSchema: RATE_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 600,
  });

  const outcome = await runWithContract<RatedCite>({
    userContent: payload,
    call,
    validate: checkRatingContract,
    repair: buildRatingRepairContent,
  });
  return outcome.ok ? outcome.value : null;
}

export async function checkOne(
  cite: Cite,
  opts: { modelId: string; signal?: AbortSignal; matterId?: string },
): Promise<CheckResult> {
  const flags: CheckFlag[] = [];
  let sourceText: string | null = null;
  let source_url: string | null = null;
  let source_label = 'model recall';
  let authority_id: string | null = null;
  let verification_status: CheckResult['verification_status'] = 'unverified';
  let cachedProposition: StoredProposition | null = null;

  // 1. Format sanity
  if (!cite.citation_bluebook) flags.push({ kind: 'format', detail: 'Could not normalize citation' });

  // 2. Existence lookup — store first, then free DBs
  let existing: StoredAuthority | null = null;
  try {
    existing = await findByCitation(cite.citation_bluebook);
  } catch (err) {
    flags.push({ kind: 'store', detail: `lookup failed: ${(err as Error).message}` });
  }

  if (existing) {
    sourceText = existing.full_text;
    source_label = existing.source_provenance ?? 'Contextspaces (cached)';
    authority_id = existing.id;
    verification_status = (existing.verification_status as CheckResult['verification_status']) ?? 'partial';
    if (cite.proposition) {
      try {
        cachedProposition = await getMatchingProposition(existing.id, cite.proposition);
      } catch { /* non-fatal */ }
    }
  } else {
    let fetched: LegalSourceResult = { found: false };
    if (cite.authority_type === 'statute' || cite.authority_type === 'regulation' || cite.authority_type === 'case' || cite.authority_type === 'rule') {
      fetched = await fetchFromFreeDb(cite, opts.signal, opts.matterId);
    }
    if (fetched.found) {
      sourceText = fetched.full_text ?? null;
      source_url = fetched.source_url ?? null;
      source_label = fetched.source_label ?? 'free legal database';
      verification_status = 'verified';
    } else {
      flags.push({ kind: 'fetch', detail: 'Not found on free DBs; Westlaw paste needed' });
      verification_status = 'partial';
    }
  }

  // 3. Confidence rating
  let rating: CheckResult['rating'] = 'medium';
  let justification = '';
  /** The checker's answer could not be read. Not a finding about the cite. */
  let unreadable = false;
  if (cachedProposition) {
    rating = cachedProposition.oblique ? 'medium' : 'high';
    justification = cachedProposition.oblique
      ? `Oblique citation: ${cachedProposition.oblique_explanation ?? 'verified by analyzer; supported by reasoning rather than quotable language.'}`
      : cachedProposition.supporting_quote
        ? `Verified by analyzer. Supporting quote${cachedProposition.pin_cite ? ` (at ${cachedProposition.pin_cite})` : ''}: "${cachedProposition.supporting_quote.slice(0, 240)}${cachedProposition.supporting_quote.length > 240 ? '…' : ''}"`
        : 'Verified by analyzer.';
  } else {
    try {
      const r = await rateConfidence(cite, sourceText ?? '', opts);
      if (r) {
        rating = r.rating;
        justification = r.justification;
      } else {
        // Validated, repaired once, still unreadable. This citation is NOT
        // checked — not found, not missing, not verified. Saying anything
        // else about it is the lie the report must not tell.
        unreadable = true;
        rating = null;
        justification = '';
        flags.push({ kind: 'unreadable', detail: UNREADABLE_CHECK_DETAIL });
      }
    } catch (err) {
      // A spent wallet, a full rate window or a sealed matter is not a
      // property of this citation: every remaining cite would fail the same
      // way and the report would come out looking complete, with a hundred
      // "rating failed" notes a reader skims past. Stop the run instead.
      if (isFinalRefusal(err)) throw err;
      flags.push({ kind: 'rate', detail: `rating failed: ${(err as Error).message}` });
    }
  }
  if (rating === 'low') flags.push({ kind: 'confidence', detail: 'Low confidence — likely fabrication or mis-attribution' });

  // 3a. Pin-cite policy
  const isOblique = cachedProposition?.oblique === true;
  const canonicalPin = cachedProposition?.pin_cite ?? null;
  if (cite.authority_type === 'case' && cite.proposition) {
    if (!cite.pin_cite && !isOblique) {
      flags.push({ kind: 'pin', detail: canonicalPin ? `Add pin cite (canonical: ${canonicalPin})` : 'Specific proposition without pin cite' });
    } else if (cite.pin_cite && canonicalPin && cite.pin_cite !== canonicalPin) {
      flags.push({ kind: 'pin', detail: `Pin mismatch: draft has ${cite.pin_cite}, canonical is ${canonicalPin}` });
    }
  }

  // 4. Persist only when we genuinely fetched source text AND the citation was
  //    actually checked. An `authorities` row carries `confidence_rating`, and
  //    an authority saved with a rating nobody gave is garbage that outlives
  //    this run: the next brief to cite the same case reads it from the store.
  //    `rating` in the condition is both the type narrowing and the rule: no
  //    authority row is ever written without a rating somebody actually gave.
  if (!existing && sourceText && verification_status === 'verified' && !unreadable && rating) {
    try {
      const created = await createAuthority({
        citation_bluebook: cite.citation_bluebook ?? cite.raw ?? '(unknown citation)',
        case_name: cite.case_name,
        court: cite.court,
        year: cite.year,
        authority_type: cite.authority_type,
        doctrinal_subject: cite.doctrinal_subject,
        full_text: sourceText,
        source_provenance: source_url ? `${source_label} ${source_url}` : source_label,
        verification_status,
        confidence_rating: rating,
      });
      authority_id = created.id;
      await logVerification({ authority_id: created.id, source: source_url ?? source_label, notes: justification });
    } catch (err) {
      flags.push({ kind: 'store', detail: `persist failed: ${(err as Error).message}` });
    }
  }

  const flag = decideFlag({ verification_status, rating, flags, unreadable });
  return { cite, authority_id, source_label, source_url, rating, justification, verification_status, flags, flag };
}

export function decideFlag(args: {
  verification_status: CheckResult['verification_status'];
  rating: CheckResult['rating'];
  flags: CheckFlag[];
  unreadable?: boolean;
}): CiteFlag {
  // FIRST, and before anything the fetch established. A citation whose source
  // text we hold but whose checker we could not read has not been checked; a
  // green on it would be the store's opinion dressed as this run's.
  if (args.unreadable) return 'unchecked';

  const { verification_status, rating, flags } = args;
  const verified = verification_status === 'verified';
  const hasFetchFlag = flags.some((f) => f.kind === 'fetch');
  const hasPinFlag = flags.some((f) => f.kind === 'pin');

  if (verified && rating === 'low') return 'red';
  if (!verified && rating === 'low') return 'lean-red';
  if (verified && rating === 'high' && !hasPinFlag) return 'green';
  if (verified && (rating === 'high' || rating === 'medium')) return 'lean-green';
  if (!verified && hasFetchFlag) return 'blue';
  return 'lean-red';
}
