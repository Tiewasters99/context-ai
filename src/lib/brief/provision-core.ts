// A statute, rule, regulation or code section the brief cites — by number or
// by NAME — to the strings that find its text inside the record's documents.
// Pure; harness-loadable. The Supabase side is provision-search.ts.
//
// Eden, 09-28, in the Bushell petition: "Administrative Code § 20-393(4)",
// "Charter § 2203(h)(1)", "6 RCNY § 6-02", "CPLR 3001 … 7803(2) … 7805" and
// "the Federal Trade Commission's Holder Rule" all came back "not found",
// though GBL § 771 was found — because its words sit inside a filed
// document, and the desk's fallback searched document NAMES only. So:
//   1. the number in the cite (§ 20-393(4) → "20-393"; CPLR 7803(2) → "7803"),
//   2. for a cite that is a name, the number the BRIEF ITSELF pairs with that
//      name ("the Holder Rule, 16 C.F.R. § 433" — the brief defines its own
//      short names; no guessing),
//   3. the patterns a statute's text carries for that number ("§ 20-393",
//      "Section 2203", "CPLR 7803", "Rule 56"), so "2203" does not match a
//      page number or a year.

export interface ProvisionQuery {
  /** The section number as searched: "20-393", "2203", "433.2", "56"; a session law's chapter ("205"). */
  number: string;
  /**
   * For a session law or local law ("L. 2020, ch. 205", "Local Law 24 of
   * 2019"): the words a document's NAME must all carry, each in any listed
   * form — the year and the chapter, not the chapter alone.
   */
  nameWords?: string[][];
  /** Where the number came from. */
  from: 'cite' | 'brief';
  /** The strings to look for inside document text (case-insensitive). */
  patterns: string[];
  /** The words the name search should use (a document filed as "2203 Powers…"). */
  name: string;
}

const STATUTE_WORDS = /\b(?:U\.?\s?S\.?\s?C\.?|C\.?\s?F\.?\s?R\.?|CPLR|CPL|RCNY|NYCRR|Charter|Admin(?:istrative)?\.?\s+Code|Code|G\.?B\.?L\.?|Gen(?:eral)?\.?\s+Bus(?:iness)?\.?\s+Law|Exec(?:utive)?\.?\s+Law|Penal\s+Law|Labor\s+Law|Ins(?:urance)?\.?\s+Law|Real\s+Prop(?:erty)?\.?\s+Law|Local\s+Law|Rule|Reg(?:ulation)?\.?|Section|§)\b/i;

/** The section number in a cite, without its subdivisions: "§ 20-393(4)" → "20-393"; "7803(2)" → "7803"; "433.2" → "433.2". */
export function sectionNumber(text: string): string | null {
  const s = text.replace(/\s+/g, ' ');
  // after a section sign, "Section", or the body's abbreviation: CPLR 3001, GBL 771, Rule 56
  const m = /(?:§+\s*|\bSections?\s+|\bCPLR\s+|\bCPL\s+|\bG\.?B\.?L\.?\s+§?\s*|\bRule\s+|\bRCNY\s+§?\s*|\bNYCRR\s+§?\s*|\bCharter\s+§?\s*|\bCode\s+§?\s*|\bFed\.?\s*R\.?\s*(?:App|Civ|Crim|Evid|Bankr)\.?\s*(?:P\.?)?\s*|\bF\.?R\.?(?:A|C|Cr|E)\.?P?\.?\s*|\bL\.?\s?A\.?\s?R\.?\s*)(\d+[A-Za-z]?(?:[.-]\d+[A-Za-z]?)*)/i.exec(s);
  if (m) return m[1];
  // "16 C.F.R. 433.2", "28 U.S.C. 1331" (no sign)
  const t = /\b\d+\s+(?:C\.?\s?F\.?\s?R\.?|U\.?\s?S\.?\s?C\.?)\s*(\d+[A-Za-z]?(?:[.-]\d+[A-Za-z]?)*)/i.exec(s);
  if (t) return t[1];
  return null;
}

/** Whether the words look like a statute/rule/regulation cite at all (a case caption is not). */
export function looksLikeProvision(text: string): boolean {
  return STATUTE_WORDS.test(text) && !/\sv\.?\s/.test(text);
}

/**
 * The number the brief pairs with a NAMED provision: for "Holder Rule", the
 * first "…Holder Rule…" in the brief followed within 160 characters by a cite
 * with a number. The name's last two words are the key ("the Federal Trade
 * Commission's Holder Rule" → "Holder Rule").
 */
export function numberFromBrief(name: string, briefText: string): string | null {
  const words = name.replace(/[’']s\b/g, '').replace(/[^\w\s-]/g, ' ').trim().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return null;
  const key = words.slice(-2).join(' ');
  const re = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]{0,160}', 'gi');
  for (const m of briefText.matchAll(re)) {
    const n = sectionNumber(m[0].slice(key.length));
    if (n) return n;
  }
  return null;
}

/** The strings a section's own text carries: enough of them that a bare number does not match a year or a page. */
export function patternsFor(number: string, cite: string): string[] {
  const out = new Set<string>([`§ ${number}`, `§${number}`, `Section ${number}`, `Sec. ${number}`]);
  if (/\bCPLR\b/i.test(cite)) { out.add(`CPLR ${number}`); out.add(`CPLR § ${number}`); }
  if (/\bRule\b/i.test(cite) || /\bF\.?\s?R\.?/i.test(cite)) out.add(`Rule ${number}`);
  if (/\bRCNY\b/i.test(cite) || /\bNYCRR\b/i.test(cite)) out.add(`${number}`.includes('-') ? number : `§ ${number}`);
  // a hyphenated or dotted number is distinctive on its own ("20-393", "433.2", "6-02")
  if (/[.-]/.test(number) && number.length >= 4) out.add(number);
  return [...out];
}

/**
 * A session law or local law — "L. 2020, ch. 205, §§ 1, 3", "Laws of 2020,
 * ch. 205", "Local Law 24 of 2019", "Local Law No. 24 (2019)", "L.L. 2019/024"
 * — is a year and a chapter (or number), never a section (Eden, 09-28: saved
 * as "Local Law 2020, chapter 205"; the Bluebook form found nothing).
 */
export function sessionLaw(cite: string): { year: string; chapter: string; kind: 'session' | 'local' } | null {
  const s = cite.replace(/\s+/g, ' ');
  let m = /\b(?:L\.|Laws?(?:\s+of)?)\s*(\d{4}),?\s*(?:ch|chap|chapter)\.?\s*(\d+)/i.exec(s);
  if (m) return { year: m[1], chapter: m[2], kind: 'session' };
  m = /\bLocal\s+Law\s+(?:No\.?\s*)?(\d+)\s*(?:of|for|\(|,)\s*(\d{4})/i.exec(s);
  if (m) return { year: m[2], chapter: m[1], kind: 'local' };
  m = /\bL\.?L\.?\s*(\d{4})\s*[/-]\s*0*(\d+)/i.exec(s);
  if (m) return { year: m[1], chapter: m[2], kind: 'local' };
  return null;
}

/** What to search for, given the highlighted words and the brief's own text. Null when the words are not a provision. */
export function provisionQuery(label: string, briefText: string): ProvisionQuery | null {
  const cite = label.replace(/\s+/g, ' ').trim().replace(/^[("'“‘\s]+|[)"'”’.,;:\s]+$/g, '');
  if (!cite) return null;
  const sl = sessionLaw(cite);
  if (sl) {
    const ch = sl.chapter.replace(/^0+/, '');
    const chapterForms = sl.kind === 'local'
      ? [`Local Law ${ch}`, `Local Law No. ${ch}`, `L.L. ${sl.year}/${sl.chapter.padStart(3, '0')}`, `Int. ${ch}`, ` ${ch} `, ` ${ch}-`, `_${ch}_`, `${ch} of`]
      : [`ch. ${ch}`, `ch ${ch}`, `chapter ${ch}`, `chap. ${ch}`, ` ${ch} `, `_${ch}_`, `L. ${sl.year}, ch. ${ch}`];
    return {
      number: ch,
      from: 'cite',
      nameWords: [[sl.year], chapterForms],
      patterns: sl.kind === 'local'
        ? [`Local Law ${ch}`, `Local Law No. ${ch}`, `L.L. ${sl.year}/${sl.chapter.padStart(3, '0')}`]
        : [`ch. ${ch}`, `chapter ${ch}`, `L. ${sl.year}, ch. ${ch}`, `Chapter ${ch} of the Laws of ${sl.year}`],
      name: sl.kind === 'local' ? `Local Law ${ch} of ${sl.year}` : `L. ${sl.year}, ch. ${ch}`,
    };
  }
  const own = sectionNumber(cite);
  if (own) return { number: own, from: 'cite', patterns: patternsFor(own, cite), name: own };
  if (!looksLikeProvision(cite) && !/\b(?:Rule|Act|Law|Regulation|Order|Code|Ordinance|Statute)\b/i.test(cite)) return null;
  const fromBrief = numberFromBrief(cite, briefText);
  if (fromBrief) return { number: fromBrief, from: 'brief', patterns: patternsFor(fromBrief, briefText), name: fromBrief };
  // a name with no number anywhere in the brief: search the name's own words
  const key = cite.replace(/^(?:the|a|an)\s+/i, '').replace(/[’']s\b/g, '');
  return { number: '', from: 'cite', patterns: [key], name: key };
}
