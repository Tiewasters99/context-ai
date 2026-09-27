// What to search the corpus for, given the words a lawyer highlighted in the
// brief. The site search matches document NAMES (migration 081), and a name
// is rarely spelled the way a brief cites it: "28 U.S.C. § 1367" is filed as
// "1367 Supplemental jurisdiction", "Anderson v. Liberty Lobby, Inc., 477 U.S.
// 242, 248" as "Anderson v Liberty Lobby Inc". So the search is for the part a
// name carries: the section number of a statute, the caption of a case.
// Pure; no Supabase.

/** The search box's starting text for a highlighted cite. */
export function findQueryFor(selected: string): string {
  const s = selected.replace(/\s+/g, ' ').trim().replace(/^[("'“‘\s]+|[)"'”’.,;:\s]+$/g, '');
  if (!s) return '';
  // A statute or regulation: its section number ("§ 1367", "28 U.S.C. 1331", "29 C.F.R. § 1630.2").
  const stat = /(?:U\.?\s?S\.?\s?C\.?\s?A?\.?|C\.?\s?F\.?\s?R\.?|§)\s*§*\s*(\d+[a-z]?(?:[.-]\d+[a-z]?)*)/i.exec(s);
  if (stat) return stat[1];
  // A case: the caption, up to the first comma, without italics or "See".
  const cap = /^(?:(?:see|see also|accord|cf\.|but see|e\.g\.,?|compare)\s+)?(.+?\sv\.?\s.+?)(?:,|\s\d|$)/i.exec(s.replace(/[*_]/g, ''));
  if (cap) return cap[1].replace(/\s+/g, ' ').trim();
  return s.slice(0, 120);
}
