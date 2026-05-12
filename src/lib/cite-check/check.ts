// Per-citation check: store lookup → free-DB fetch (via /api/legal-source)
// → confidence rating → five-level flag. Faithful port of the CLI's
// cite-check/lib/check.mjs, including decideFlag's invariant that red only
// fires on a verified mismatch.

import { generateStructured } from '@/lib/llm';
import type { Cite, CheckFlag, CheckResult, CiteFlag } from './types';
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

async function fetchFromFreeDb(cite: Cite, signal?: AbortSignal): Promise<LegalSourceResult> {
  try {
    const res = await fetch('/api/legal-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authority_type: cite.authority_type,
        citation_bluebook: cite.citation_bluebook,
        case_name: cite.case_name,
      }),
      signal,
    });
    if (!res.ok) return { found: false };
    return (await res.json()) as LegalSourceResult;
  } catch {
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

async function rateConfidence(
  cite: Cite,
  sourceText: string,
  opts: { modelId: string; signal?: AbortSignal },
): Promise<{ rating: 'high' | 'medium' | 'low'; justification: string }> {
  const payload = JSON.stringify({
    citation: cite.citation_bluebook,
    proposition: cite.proposition,
    pin_cite: cite.pin_cite,
    source_text_excerpt: (sourceText ?? '').slice(0, 4000),
  });
  const result = await generateStructured<{ rating?: string; justification?: string }>({
    modelId: opts.modelId,
    signal: opts.signal,
    system: RATE_SYSTEM,
    userContent: payload,
    toolName: 'record_rating',
    toolDescription: 'Record the confidence rating for this citation.',
    inputSchema: RATE_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 600,
  });
  const r = result?.rating === 'high' || result?.rating === 'low' ? result.rating : 'medium';
  return { rating: r, justification: result?.justification ?? '' };
}

export async function checkOne(
  cite: Cite,
  opts: { modelId: string; signal?: AbortSignal },
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
      fetched = await fetchFromFreeDb(cite, opts.signal);
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
      rating = r.rating;
      justification = r.justification;
    } catch (err) {
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

  // 4. Persist only when we genuinely fetched source text
  if (!existing && sourceText && verification_status === 'verified') {
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

  const flag = decideFlag({ verification_status, rating, flags });
  return { cite, authority_id, source_label, source_url, rating, justification, verification_status, flags, flag };
}

function decideFlag(args: { verification_status: CheckResult['verification_status']; rating: CheckResult['rating']; flags: CheckFlag[] }): CiteFlag {
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
