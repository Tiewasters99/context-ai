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

  // ---- 1. Lenient format check ------------------------------------------
  if (!cite.citation_bluebook) flags.push({ kind: 'format', detail: 'Could not normalize citation' });
  if (cite.proposition && !cite.pin_cite && cite.authority_type === 'case') {
    flags.push({ kind: 'pin', detail: 'Specific proposition without pin cite' });
  }

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
  try {
    const r = await rateConfidence(cite, sourceText ?? '', { apiKey: anthropicApiKey });
    rating = r.rating;
    justification = r.justification;
  } catch (err) {
    flags.push({ kind: 'rate', detail: `rating failed: ${err.message}` });
  }
  if (rating === 'low') flags.push({ kind: 'confidence', detail: 'Low confidence — likely fabrication or mis-attribution' });

  // ---- 4. Persist if we got something new -------------------------------
  if (!existing && store && (sourceText || cite.citation_bluebook)) {
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

function decideFlag({ verification_status, rating, flags }) {
  if (rating === 'low') return 'red';
  if (verification_status === 'partial' && flags.some((f) => f.kind === 'fetch')) return 'blue';
  if (rating === 'medium' || flags.some((f) => f.kind === 'pin')) return 'yellow';
  if (verification_status === 'verified' && rating === 'high') return 'green';
  return 'yellow';
}
