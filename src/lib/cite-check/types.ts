// Shared types for the browser cite-check engine. Mirrors the CLI's data
// shapes (cite-check/lib/*.mjs) so the report rendering and the five-level
// flag scheme stay identical across the CLI and the in-app tab.

export type CiteFlag = 'green' | 'lean-green' | 'lean-red' | 'red' | 'blue';

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
  kind: 'format' | 'store' | 'fetch' | 'rate' | 'confidence' | 'pin';
  detail: string;
}

/** Result of checking one citation — the unit the report iterates over. */
export interface CheckResult {
  cite: Cite;
  authority_id: string | null;
  source_label: string;
  source_url: string | null;
  rating: 'high' | 'medium' | 'low';
  justification: string;
  verification_status: 'verified' | 'partial' | 'unverified';
  flags: CheckFlag[];
  flag: CiteFlag;
}

/** Tally of cites by flag — stored on the run row and shown in the header. */
export interface FlagCounts {
  green: number;
  lean_green: number;
  lean_red: number;
  red: number;
  blue: number;
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
};

export const FLAG_LABEL: Record<CiteFlag, string> = {
  green: 'verified — clean',
  'lean-green': 'verified — minor issue',
  'lean-red': 'unverified — model concern',
  red: 'verified mismatch',
  blue: 'westlaw paste needed',
};
