// What to search the corpus for, given the words a lawyer highlighted in the
// brief. The site search matches document NAMES (migration 081), and a name
// is rarely spelled the way a brief cites it: "28 U.S.C. § 1367" is filed as
// "1367 Supplemental jurisdiction", "Anderson v. Liberty Lobby, Inc., 477 U.S.
// 242, 248" as "Anderson v Liberty Lobby Inc". So the search is for the part a
// name carries: the section number of a statute, the caption of a case.
// Pure; no Supabase.

/** "Morgan v. Allison Crane & Rigging, LLC" → "Morgan v Allison Crane and Rigging LLC". */
export function captionForSearch(caption: string): string {
  return caption
    .replace(/&/g, ' and ')
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The search box's starting text for a highlighted cite. */
export function findQueryFor(selected: string): string {
  const s = selected.replace(/\s+/g, ' ').trim().replace(/^[("'“‘\s]+|[)"'”’.,;:\s]+$/g, '');
  if (!s) return '';
  // A rule of procedure or evidence: "Rule N", the way a rule's text is filed
  // ("Rule 4. Appeal as of Right"). "Fed. R. App. P. 4(a)(1)(A)", "Fed. R.
  // Civ. P. 56(a)", "FRCP 12(b)(6)", "Fed. R. Evid. 803(6)", "L.A.R. 28.1",
  // "Local Rule 7.1" (Eden, 09-27: the FRAP 4 printout was filed as "Rule 4.
  // Appeal as of Right" and the whole cite matched no name).
  const rule = /(?:\bFed\.?\s*R\.?\s*(?:App|Civ|Crim|Evid|Bankr)\.?\s*(?:P\.?)?|\bF\.?R\.?(?:A|C|Cr|E)\.?P?\.?|\bL\.?\s?A\.?\s?R\.?|\bL\.?\s?Civ\.?\s?R\.?|\b(?:Local\s+)?(?:Civil\s+)?Rule)\s*(\d+(?:\.\d+)?)/i.exec(s);
  if (rule) return `Rule ${rule[1]}`;
  // A statute or regulation: its section number ("§ 1367", "28 U.S.C. 1331", "29 C.F.R. § 1630.2").
  const stat = /(?:U\.?\s?S\.?\s?C\.?\s?A?\.?|C\.?\s?F\.?\s?R\.?|§)\s*§*\s*(\d+[a-z]?(?:[.-]\d+[a-z]?)*)/i.exec(s);
  if (stat) return stat[1];
  // A case: the caption, up to the first comma, without italics or "See".
  const cap = /^(?:(?:see|see also|accord|cf\.|but see|e\.g\.,?|compare)\s+)?(.+?\sv\.?\s.+?)(?:,|\s\d|$)/i.exec(s.replace(/[*_]/g, ''));
  if (cap) return captionForSearch(cap[1]);
  return s.slice(0, 120);
}
