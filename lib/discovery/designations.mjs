// Confidentiality designations — what the load file's CONFIDENTIALITY column
// says about a produced document.
//
// A designation is a tag that burns words onto the page (is_endorsement) and
// whose words are a protective-order designation. Until 2026-10-11 the worker
// recognised only the word "confidential", so a document endorsed "ATTORNEYS'
// EYES ONLY" carried the words on every page and an empty CONFIDENTIALITY in
// the DAT — the receiving party's review platform would treat it as freely
// shareable. Now the column carries the designation's own words, and when a
// document carries more than one, the most restrictive.
//
// Ranked, most restrictive first. A tag that matches none (e.g. a custom
// "DRAFT" endorsement) still prints, but is not a confidentiality designation.
const RANKS = [
  /attorneys?['’]?\s*eyes\s*only|\bAEO\b|outside\s+counsel(?:'s)?\s+eyes\s+only|highly\s+confidential/i,
  /confidential|restricted/i,
];

/** The rank of one endorsement's words (lower = more restrictive), or -1. */
export function designationRank(text) {
  if (!text) return -1;
  return RANKS.findIndex((re) => re.test(text));
}

/**
 * The CONFIDENTIALITY value for a document: the words of its most restrictive
 * designation, or '' when it carries none.
 * @param {string[]} endorsements  the document's endorsement texts, as burned
 */
export function confidentialityOf(endorsements = []) {
  let best = '';
  let bestRank = Infinity;
  for (const text of endorsements) {
    const r = designationRank(text);
    if (r !== -1 && r < bestRank) { best = text; bestRank = r; }
  }
  return best;
}
