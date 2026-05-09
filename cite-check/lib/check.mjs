// Pipeline orchestrator: for each extracted citation, run existence
// lookup (Contextspaces store → free DBs) and confidence rating, then
// persist verified records. Returns an array of results — one per cite —
// each carrying a flag color (green/yellow/red/blue) the report uses.
//
// Phase 1 deliberately runs a tight five-check pipeline:
//   (1) Bluebook format sanity (lenient: well-known reporter / signal)
//   (2) Existence — store, then free DB (statute or case fetcher)
//   (3) Confidence rating from Anthropic given the source text
//   (4) Pin-cite presence check (warn if specific proposition lacks pin)
//   (5) Doctrinal-context flag (parallel-doctrine cites get yellow)
// Proposition-match against the case's holding is intentionally deferred
// to Phase 1.5 — it requires structured propositions stored on each
// authority record, which only accumulate as we use the system.

import { fetchCase, fetchStatute } from './sources.mjs';
import { rateConfidence } from './anthropic.mjs';

export async function runChecks(cites, { store, anthropicApiKey, onProgress }) {
  const results = [];
  for (let i = 0; i < cites.length; i++) {
    const c = cites[i];
    onProgress?.(i + 1, cites.length, c);
    results.push(await checkOne(c, { store, anthropicApiKey }));
  }
  return results;
}

async function checkOne(cite, { store, anthropicApiKey }) {
  const flags = [];
  let sourceText = null;
  let source_url = null;
  let source_label = 'model recall';
  let authority_id = null;
  let verification_status = 'unverified';
  let cachedProposition = null;

  // ---- 1. Lenient format check ------------------------------------------
  if (!cite.citation_bluebook) flags.push({ kind: 'format', detail: 'Could not normalize citation' });

  // ---- 2. Existence lookup ----------------------------------------------
  let existing = null;
  if (store) {
    try {
      existing = await store.findByCitation(cite.citation_bluebook);
    } catch (err) {
      flags.push({ kind: 'store', detail: `lookup failed: ${err.message}` });
    }
  }

  if (existing) {
    sourceText = existing.full_text;
    source_label = existing.source_provenance ?? 'Contextspaces (cached)';
    source_url = null;
    authority_id = existing.id;
    verification_status = existing.verification_status ?? 'partial';

    // If the user is citing this authority for a proposition we've
    // already analyzed, prefer the stored structured findings (oblique
    // flag, supporting quote, canonical pin) over a fresh rate call.
    if (cite.proposition && store.getMatchingProposition) {
      try {
        cachedProposition = await store.getMatchingProposition(existing.id, cite.proposition);
      } catch {}
    }
  } else {
    // Not yet in store: try free DBs.
    let fetched;
    if (cite.authority_type === 'statute' || cite.authority_type === 'regulation') {
      fetched = await fetchStatute(cite);
    } else if (cite.authority_type === 'case') {
      fetched = await fetchCase(cite);
    } else {
      fetched = { found: false };
    }
    if (fetched.found) {
      sourceText = fetched.full_text;
      source_url = fetched.source_url;
      source_label = fetched.source_label;
      verification_status = 'verified';
    } else {
      flags.push({ kind: 'fetch', detail: 'Not found on free DBs; Westlaw paste needed' });
      verification_status = 'partial';
    }
  }

  // ---- 3. Confidence rating ---------------------------------------------
  let rating = 'medium';
  let justification = '';
  if (cachedProposition) {
    // Use the structured findings from the prior analyze-case run.
    rating = cachedProposition.oblique ? 'medium' : 'high';
    justification = cachedProposition.oblique
      ? `Oblique citation: ${cachedProposition.oblique_explanation ?? 'verified by analyzer; supported by reasoning rather than quotable language.'}`
      : (cachedProposition.supporting_quote
          ? `Verified by analyzer. Supporting quote${cachedProposition.pin_cite ? ` (at ${cachedProposition.pin_cite})` : ''}: "${cachedProposition.supporting_quote.slice(0, 240)}${cachedProposition.supporting_quote.length > 240 ? '…' : ''}"`
          : 'Verified by analyzer.');
  } else {
    try {
      const r = await rateConfidence(cite, sourceText ?? '', { apiKey: anthropicApiKey });
      rating = r.rating;
      justification = r.justification;
    } catch (err) {
      flags.push({ kind: 'rate', detail: `rating failed: ${err.message}` });
    }
  }
  if (rating === 'low') flags.push({ kind: 'confidence', detail: 'Low confidence — likely fabrication or mis-attribution' });

  // ---- 3a. Pin-cite policy ---------------------------------------------
  // Pin cites build trust even for general propositions. Only waive the
  // pin requirement when the cite is genuinely oblique (no specific
  // passage to pin to). Otherwise, suggest the canonical pin if we know
  // it from the analyzer; flag absence regardless.
  const isOblique = cachedProposition?.oblique === true;
  const canonicalPin = cachedProposition?.pin_cite ?? null;
  if (cite.authority_type === 'case' && cite.proposition) {
    if (!cite.pin_cite && !isOblique) {
      flags.push({
        kind: 'pin',
        detail: canonicalPin
          ? `Add pin cite (canonical: ${canonicalPin})`
          : 'Specific proposition without pin cite',
      });
    } else if (cite.pin_cite && canonicalPin && cite.pin_cite !== canonicalPin) {
      flags.push({ kind: 'pin', detail: `Pin mismatch: draft has ${cite.pin_cite}, canonical is ${canonicalPin}` });
    }
  }

  // ---- 4. Persist if (and only if) we have real verification -----------
  // Stub records (model-recall only, no source text) pollute the store
  // and make subsequent runs look "verified (partial)" when nothing was
  // actually checked. Persist only when we have opinion / statutory text
  // we genuinely fetched or analyzed.
  if (!existing && store && sourceText && verification_status === 'verified') {
    try {
      const created = await store.createAuthority({
        citation_bluebook: cite.citation_bluebook,
        case_name: cite.case_name,
        court: cite.court,
        year: cite.year,
        authority_type: cite.authority_type,
        doctrinal_subject: cite.doctrinal_subject ?? [],
        full_text: sourceText,
        source_provenance: source_url ? `${source_label} ${source_url}` : source_label,
        verification_status,
        confidence_rating: rating,
      });
      authority_id = created.id;
      await store.logVerification({
        authority_id: created.id,
        source: source_url ?? source_label,
        notes: justification,
      });
    } catch (err) {
      flags.push({ kind: 'store', detail: `persist failed: ${err.message}` });
    }
  }

  // ---- 5. Flag color (compose into one bucket) --------------------------
  const flag = decideFlag({ verification_status, rating, flags });

  return {
    cite,
    authority_id,
    source_label,
    source_url,
    rating,
    justification,
    verification_status,
    flags,
    flag,
  };
}

// Five-level flag scheme — distinguishes "verified mismatch" (red) from
// "unverified concern" (lean-red) so red is reserved for cases where we
// actually read the source AND the model finds a real problem.
//
//   green       — source verified, model supports, name + pin correct
//   lean-green  — source verified, model supports, but a fixable issue
//                 (pin missing, parallel doctrine, oblique flag from
//                 cached analyzer, etc.)
//   lean-red    — source NOT verified; model recall raises concern. The
//                 cite might be wrong, but we couldn't confirm. Needs a
//                 Westlaw paste before we can claim certainty.
//   red         — source verified AND model identifies a real mismatch.
//                 Reserved for "definitely wrong" with the receipts.
//   blue        — source not available and model is neutral. Pure
//                 "Westlaw paste needed" pile.
function decideFlag({ verification_status, rating, flags }) {
  const verified = verification_status === 'verified';
  const hasFetchFlag = flags.some((f) => f.kind === 'fetch');
  const hasPinFlag = flags.some((f) => f.kind === 'pin');

  // Verified + low rating = real mismatch we caught with our own eyes.
  if (verified && rating === 'low') return 'red';

  // Unverified + low rating = model concern from recall; flag it but
  // don't claim certainty.
  if (!verified && rating === 'low') return 'lean-red';

  // Verified + high rating + no caveats = clean green.
  if (verified && rating === 'high' && !hasPinFlag) return 'green';

  // Verified + supports the proposition but with a caveat (pin missing,
  // medium confidence, parallel doctrine flagged) = lean-green.
  if (verified && (rating === 'high' || rating === 'medium')) return 'lean-green';

  // No source available, no model concern = blue (Westlaw paste pile).
  if (!verified && hasFetchFlag) return 'blue';

  // Catch-all: lean-red (we don't have enough to commit to anything stronger).
  return 'lean-red';
}
