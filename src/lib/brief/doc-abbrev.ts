// A record document cited by shorthand — "OATH Pet. at 4", "Bushell Aff.
// ¶ 12", "DCWP Compl.", "Hr'g Tr. 33:2" — to the words its NAME in the Vault
// carries (Eden, 09-28: "'Pet.' is a common shorthand for 'Petition' and
// there are only two Petitions in the vault"). Bluebook BT1's court-document
// abbreviations, each with the long forms it stands for, plus the pin the
// cite carries. Pure; harness-loadable.

export interface DocumentCite {
  /** Each entry is one word the name must carry, in any of these forms. */
  words: string[][];
  /** "at 4", "p. 4" → 4; null when the cite pins a paragraph or nothing. */
  page: number | null;
  /** "¶ 12" → 12. */
  paragraph: number | null;
  /** The cite had at least one court-document word (so it IS a document cite). */
  isDocument: boolean;
  /**
   * A case caption's cite ("Del Biaggio v. Bansen, No. A174647, slip op. at
   * 16"): `words` are the parties' names only, and the document words ("Op."
   * → Opinion, Order) only RANK what the names find — a decision is often
   * filed under its caption alone.
   */
  rank?: string[][];
  /** The case's docket number ("A174647", "25-cv-0769"): an identifier on the decision's first page, never a word of its name. */
  docket?: string | null;
  /** A caption's first party's words: what a decision filed under a short name still carries. */
  party?: string[][];
}

/** BT1 abbreviation → long forms (a name may use any). Keys without the period. */
export const DOC_ABBREVIATIONS: Record<string, string[]> = {
  pet: ['Petition', 'Petitioner'],
  compl: ['Complaint'],
  aff: ['Affidavit', 'Affirmation'],
  affirm: ['Affirmation'],
  decl: ['Declaration'],
  tr: ['Transcript'],
  dep: ['Deposition'],
  ex: ['Exhibit'],
  exs: ['Exhibits'],
  mem: ['Memorandum', 'Memo'],
  br: ['Brief'],
  mot: ['Motion'],
  opp: ['Opposition'],
  reply: ['Reply'],
  stip: ['Stipulation'],
  ltr: ['Letter'],
  op: ['Opinion', 'Order'],
  order: ['Order'],
  j: ['Judgment'],
  ans: ['Answer'],
  cert: ['Certification', 'Certificate'],
  subp: ['Subpoena'],
  rpt: ['Report'],
  hrg: ['Hearing'],
  notice: ['Notice'],
  interrog: ['Interrogatories', 'Interrogatory'],
  resp: ['Response', 'Responses'],
  req: ['Request', 'Requests'],
  app: ['Appendix'],
  r: ['Record'],
  osc: ['Order to Show Cause'],
  tro: ['Temporary Restraining Order'],
  verified: ['Verified'],
  am: ['Amended'],
  supp: ['Supplemental', 'Supplement'],
  prop: ['Proposed'],
  sched: ['Scheduling', 'Schedule'],
  agmt: ['Agreement'],
  dec: ['Decision'],
};

/**
 * A pleading a brief defines by initials — "TAC ¶ 55". The initials are never
 * searched as such ("%TAC%" is in "contact"); the name carries the long form,
 * spaced or run together as a docket pull files it ("Thirdamendedcomplaint").
 */
export const PLEADING_INITIALS: Record<string, string[]> = {
  fac: ['First Amended Complaint', 'Firstamendedcomplaint', 'First Am. Compl'],
  sac: ['Second Amended Complaint', 'Secondamendedcomplaint', 'Second Am. Compl'],
  tac: ['Third Amended Complaint', 'Thirdamendedcomplaint', 'Third Am. Compl'],
  '4ac': ['Fourth Amended Complaint', 'Fourthamendedcomplaint', 'Fourth Am. Compl'],
};

/** Agencies and courts a cite names by acronym; a document's name or first page may carry the long form. */
export const ACRONYMS: Record<string, string[]> = {
  oath: ['Office of Administrative Trials and Hearings', 'Office of Administrative Trials & Hearings', 'Administrative Trials'],
  dcwp: ['Department of Consumer and Worker Protection', 'Consumer and Worker Protection'],
  dca: ['Department of Consumer Affairs', 'Consumer Affairs'],
  dohmh: ['Department of Health and Mental Hygiene', 'Health and Mental Hygiene'],
  hpd: ['Housing Preservation and Development'],
  dob: ['Department of Buildings'],
  dep: ['Department of Environmental Protection'],
  dot: ['Department of Transportation'],
  ecb: ['Environmental Control Board'],
  nypd: ['Police Department'],
  ftc: ['Federal Trade Commission'],
  sec: ['Securities and Exchange Commission'],
  eeoc: ['Equal Employment Opportunity Commission'],
  nlrb: ['National Labor Relations Board'],
  dol: ['Department of Labor'],
  ag: ['Attorney General'],
  oag: ['Office of the Attorney General', 'Attorney General'],
  psc: ['Public Service Commission'],
  nyserda: ['Energy Research and Development Authority'],
};

// "slip" of "slip op." (Eden, 10-21: "slip" sent Del Biaggio's cite to the memo
// that cites it — the opinion itself never says "slip")
const STOP = new Set(['the', 'of', 'to', 'and', 'a', 'an', 'in', 're', 'for', 'on', 'by', 'v', 'vs', 'see', 'at', 'id', 'supra', 'infra', 'citing', 'quoting', 'slip']);

// A case's docket number after a bare "No." — "No. A174647", "No. 25-cv-0769-WJM-KAS (MKB)" —
// not an entry ("ECF No. 43", "Doc. No. 330") or an index number, which name a filed paper.
const CASE_NO = /(?<!\b(?:ECF|Doc|Dkt|Docket|Entry|Index|Ind|Idx)\.?\s*)\bNos?\.\s*([A-Za-z]{0,4}\d[\w:.-]*\d(?:-[A-Za-z]{2,4})*|[A-Za-z]{0,4}\d)(?:\s*\([A-Z]{2,5}\))?/;

/** The cite's words as a name search: null when the words name no court document. */
export function parseDocumentCite(label: string): DocumentCite | null {
  let s = label.replace(/[*_]/g, '').replace(/\s+/g, ' ').trim().replace(/^[("'“‘\s]+|[)"'”’.,;:\s]+$/g, '');
  if (!s) return null;
  let page: number | null = null;
  let paragraph: number | null = null;
  // the case number first: "No. 3:26-cv-00250" is not a transcript pin "3:26"
  let docket: string | null = null;
  const no = CASE_NO.exec(s);
  if (no) { docket = no[1]; s = s.replace(no[0], ' '); }
  const para = /¶¶?\s*(\d+)/.exec(s);
  if (para) { paragraph = Number(para[1]); s = s.replace(/¶¶?\s*\d+(?:[–-]\d+)?/g, ' '); }
  const at = /\b(?:at|p\.|pp\.|page)\s*(\d{1,4})\b/i.exec(s);
  if (at) { page = Number(at[1]); s = s.replace(/\b(?:at|p\.|pp\.|page)\s*\d{1,4}(?:[–-]\d{1,4})?\b/i, ' '); }
  // a transcript pin "33:2–5" is a page too
  const pl = /\b(\d{1,4}):\d{1,3}(?:[–-]\d{1,3})?\b/.exec(s);
  if (pl && page === null) { page = Number(pl[1]); s = s.replace(/\b\d{1,4}:\d{1,3}(?:[–-]\d{1,3})?\b/, ' '); }
  s = s.replace(/\(\s*[^)]*\d{4}\s*\)/g, ' ');   // a date parenthetical "(Mar. 4, 2026)"
  // A caption ("X v. Y, …"): the parties name the document; what follows the caption only ranks.
  const cap = /^(.+?\sv\.?\s[^,]+?)(?:,|$)(.*)$/.exec(s);
  if (cap && !/[¶§]/.test(cap[1])) {
    const names = parseWords(cap[1]);
    const rest = parseWords(cap[2]);
    const isDocument = !!docket || /\bslip\s+op\b/i.test(label) || rest.isDocument || names.isDocument;
    // the first party's own name alone, for a decision filed as "Tiekert Order" or
    // "Barteca Order" ("Barteca Holdings LLC"): its longest word that is not a company form
    const own = parseWords(cap[1].split(/\sv\.?\s/)[0]).words
      .filter((w) => w.length === 1 && w[0].length >= 4 && !/^(?:LLC|Inc|Corp|Corporation|Company|Holdings|Ltd|LLP|Group|Partners|City|County|Village|Town|State|People|United|States)$/i.test(w[0]))
      .sort((a, b) => b[0].length - a[0].length);
    const first = own.length ? [own[0]] : [];
    if (names.words.length) return { words: names.words, page, paragraph, isDocument, rank: [...rest.words], docket, party: first };
  }
  const { words, isDocument } = parseWords(s);
  if (!words.length) return null;
  return { words, page, paragraph, isDocument, docket };
}

/** The name words of a cite with its pin taken out, and whether one is a court-document word. */
function parseWords(s: string): { words: string[][]; isDocument: boolean } {
  const tokens = s.split(/\s+/).map((t) => t.replace(/[.,;:()]+$/g, '').replace(/^[(]+/, '')).filter(Boolean);
  const words: string[][] = [];
  let isDocument = false;
  for (const t of tokens) {
    const key = t.toLowerCase().replace(/[.'’]/g, '');
    if (!key || STOP.has(key) || /^[\d–—-]+$/.test(key)) continue;   // "79–84" left of a ¶ list
    const initials = PLEADING_INITIALS[key];
    if (initials) { isDocument = true; words.push(initials); continue; }
    const long = DOC_ABBREVIATIONS[key];
    // The abbreviation itself only when it is a word in its own right: "%Op%"
    // is in "Openingbrief" and "Proposed", and crowded "Fifth Circuit Opinion"
    // out of the twenty names a search returns (10-15, Atkinson).
    if (long) { isDocument = true; const own = t.replace(/\.$/, ''); words.push([...new Set([...long, ...(own.length >= 4 ? [own] : [])])]); continue; }
    const acro = ACRONYMS[key];
    if (acro) { words.push([t.replace(/\.$/, ''), ...acro]); continue; }
    if (/^(petition|complaint|affidavit|affirmation|declaration|transcript|deposition|exhibit|memorandum|brief|motion|opposition|stipulation|letter|opinion|order|judgment|answer|certification|subpoena|report|hearing|notice|record|appendix|decision|agreement)s?$/i.test(t)) isDocument = true;
    words.push([t]);
  }
  return { words, isDocument };
}
