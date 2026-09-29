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

const STOP = new Set(['the', 'of', 'to', 'and', 'a', 'an', 'in', 're', 'for', 'on', 'by', 'v', 'vs', 'see', 'at', 'id', 'supra', 'infra', 'citing', 'quoting']);

/** The cite's words as a name search: null when the words name no court document. */
export function parseDocumentCite(label: string): DocumentCite | null {
  let s = label.replace(/[*_]/g, '').replace(/\s+/g, ' ').trim().replace(/^[("'“‘\s]+|[)"'”’.,;:\s]+$/g, '');
  if (!s) return null;
  let page: number | null = null;
  let paragraph: number | null = null;
  const para = /¶¶?\s*(\d+)/.exec(s);
  if (para) { paragraph = Number(para[1]); s = s.replace(/¶¶?\s*\d+(?:[–-]\d+)?/g, ' '); }
  const at = /\b(?:at|p\.|pp\.|page)\s*(\d{1,4})\b/i.exec(s);
  if (at) { page = Number(at[1]); s = s.replace(/\b(?:at|p\.|pp\.|page)\s*\d{1,4}(?:[–-]\d{1,4})?\b/i, ' '); }
  // a transcript pin "33:2–5" is a page too
  const pl = /\b(\d{1,4}):\d{1,3}(?:[–-]\d{1,3})?\b/.exec(s);
  if (pl && page === null) { page = Number(pl[1]); s = s.replace(/\b\d{1,4}:\d{1,3}(?:[–-]\d{1,3})?\b/, ' '); }
  s = s.replace(/\(\s*[^)]*\d{4}\s*\)/g, ' ');   // a date parenthetical "(Mar. 4, 2026)"
  const tokens = s.split(/\s+/).map((t) => t.replace(/[.,;:()]+$/g, '')).filter(Boolean);
  const words: string[][] = [];
  let isDocument = false;
  for (const t of tokens) {
    const key = t.toLowerCase().replace(/[.'’]/g, '');
    if (!key || STOP.has(key) || /^\d+$/.test(key)) continue;
    const long = DOC_ABBREVIATIONS[key];
    if (long) { isDocument = true; words.push([...new Set([...long, t.replace(/\.$/, '')])]); continue; }
    const acro = ACRONYMS[key];
    if (acro) { words.push([t.replace(/\.$/, ''), ...acro]); continue; }
    if (/^(petition|complaint|affidavit|affirmation|declaration|transcript|deposition|exhibit|memorandum|brief|motion|opposition|stipulation|letter|opinion|order|judgment|answer|certification|subpoena|report|hearing|notice|record|appendix|decision|agreement)s?$/i.test(t)) isDocument = true;
    words.push([t]);
  }
  if (!words.length) return null;
  return { words, page, paragraph, isDocument };
}
