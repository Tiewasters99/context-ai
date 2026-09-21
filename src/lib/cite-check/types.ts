// Shared types for the browser cite-check engine. Mirrors the CLI's data
// shapes (cite-check/lib/*.mjs) so the report rendering and the five-level
// flag scheme stay identical across the CLI and the in-app tab.

/**
 * 'unchecked' is the sixth flag, and the only one that is a statement about US
 * rather than about the citation.
 *
 * Inside a sealed matter the rating call is answered by the sealed pen, and a
 * pen that cannot be held to {high|medium|low} used to fall through a `?:` to
 * "medium" — a confidence the model never expressed, printed in a report an
 * attorney signs. The near miss is worse: PR #171 found a 402 being flattened
 * into "cite not found", which tells a lawyer a real case does not exist.
 *
 * A citation whose checker could not be read is NOT found, NOT missing and NOT
 * verified. It is not checked, and the report says so in those words.
 */
export type CiteFlag = 'green' | 'lean-green' | 'lean-red' | 'red' | 'blue' | 'unchecked';

export type AuthorityType = 'statute' | 'regulation' | 'case' | 'treatise' | 'rule' | 'other';

/** One citation extracted from a draft, with the surrounding proposition. */
export interface Cite {
  raw: string | null;
  citation_bluebook: string | null;
  case_name: string | null;
  court: string | null;
  year: number | null;
  pin_cite: string | null;
  proposition: string | null;
  signal: string | null;
  authority_type: AuthorityType;
  doctrinal_subject: string[];
  location: string | null;
}

/** A sub-issue surfaced during a single cite's check (pin missing, etc.). */
export interface CheckFlag {
  kind: 'format' | 'store' | 'fetch' | 'rate' | 'confidence' | 'pin' | 'unreadable';
  detail: string;
}

/** The sentence a not-checked citation carries, in the report and on screen. */
export const UNREADABLE_CHECK_DETAIL = 'not checked — the checker’s answer was unreadable';

/** Result of checking one citation — the unit the report iterates over. */
export interface CheckResult {
  cite: Cite;
  authority_id: string | null;
  source_label: string;
  source_url: string | null;
  /** null when the checker's answer could not be read: no rating was given. */
  rating: 'high' | 'medium' | 'low' | null;
  justification: string;
  verification_status: 'verified' | 'partial' | 'unverified';
  flags: CheckFlag[];
  flag: CiteFlag;
}

/**
 * Tally of cites by flag — stored on the run row and shown in the header.
 *
 * Every extracted citation lands in exactly one of these, which is what makes
 * the report's arithmetic checkable: extracted = checked + not checked.
 * `not_checked` is absent on runs from before it existed; read it with `?? 0`.
 */
export interface FlagCounts {
  green: number;
  lean_green: number;
  lean_red: number;
  red: number;
  blue: number;
  not_checked: number;
}

/** Citations that were actually checked — the tally minus the unreadable ones. */
export function citesChecked(counts: FlagCounts): number {
  return counts.green + counts.lean_green + counts.lean_red + counts.red + counts.blue;
}

/** Everything the tally accounts for. Must equal the number extracted. */
export function citesAccountedFor(counts: FlagCounts): number {
  return citesChecked(counts) + (counts.not_checked ?? 0);
}

/**
 * Every result lands in exactly one bucket, so this always sums to
 * `results.length`. That is the arithmetic the report prints and the harness
 * asserts: extracted = checked + not checked, with no residue.
 */
export function tallyFlags(results: CheckResult[]): FlagCounts {
  const c: FlagCounts = { green: 0, lean_green: 0, lean_red: 0, red: 0, blue: 0, not_checked: 0 };
  for (const r of results) {
    if (r.flag === 'green') c.green++;
    else if (r.flag === 'lean-green') c.lean_green++;
    else if (r.flag === 'lean-red') c.lean_red++;
    else if (r.flag === 'red') c.red++;
    else if (r.flag === 'blue') c.blue++;
    else if (r.flag === 'unchecked') c.not_checked++;
  }
  return c;
}

/** The persisted shape of a cite_check_runs.report entry (one per cite). */
export interface ReportEntry {
  citation: string;
  case_name: string | null;
  authority_type: AuthorityType;
  proposition: string | null;
  pin: string | null;
  signal: string | null;
  flag: CiteFlag;
  verification_status: CheckResult['verification_status'];
  rating: CheckResult['rating'];
  source_label: string;
  source_url: string | null;
  note: string;
  flags: CheckFlag[];
  location: string | null;
  authority_id: string | null;
}

export interface RunProgress {
  phase: 'extracting-text' | 'extracting-cites' | 'checking' | 'persisting' | 'done' | 'error';
  /** 1-based index of the cite currently being checked, when phase === 'checking'. */
  index?: number;
  total?: number;
  /** Bluebook citation of the cite currently being checked. */
  current?: string;
  message?: string;
}

export interface RunResult {
  runId: string;
  results: CheckResult[];
  counts: FlagCounts;
  toaMarkdown: string;
  reportMarkdown: string;
}

export const FLAG_GLYPH: Record<CiteFlag, string> = {
  green: '✓',
  'lean-green': '⊕',
  'lean-red': '⊖',
  red: '✗',
  blue: '◇',
  unchecked: '—',
};

export const FLAG_LABEL: Record<CiteFlag, string> = {
  green: 'verified — clean',
  'lean-green': 'verified — minor issue',
  'lean-red': 'unverified — model concern',
  red: 'verified mismatch',
  blue: 'westlaw paste needed',
  unchecked: UNREADABLE_CHECK_DETAIL,
};
