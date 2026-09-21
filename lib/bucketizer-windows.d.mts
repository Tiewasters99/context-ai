// Hand-written declarations for bucketizer-windows.mjs (the SPA's tsconfig has
// allowJs off; the worker and the CLI consume the .mjs directly).

export declare const WINDOW_CHAR_BUDGET: number;
export declare const MAX_WINDOW_CHAR_BUDGET: number;
export declare const TARGET_MAX_WINDOWS: number;
export declare const MERGED_ASSIGNMENT_CAP: number;
export declare const MERGED_PASSAGE_CAP: number;
export declare const WINDOW_SYSTEM_SUFFIX: string;

export interface WindowPassage {
  id: string;
  text: string;
  page_start: number | null;
  page_end: number | null;
  sequence_number: number | null;
}

export interface PassageWindow {
  /** 0-based, and the window's identity for resume. */
  index: number;
  passages: WindowPassage[];
  chars: number;
  firstPage: number | null;
  lastPage: number | null;
}

export interface WindowPlan {
  windows: PassageWindow[];
  totalPassages: number;
  totalChars: number;
  /** The budget actually used, after any widening. */
  windowChars: number;
  firstPage: number | null;
  lastPage: number | null;
  /** Identity of this plan over this document's TEXT — never over the tree. */
  hash: string;
}

export declare function planWindows(
  passages: WindowPassage[],
  options?: { windowChars?: number; targetMaxWindows?: number; maxWindowChars?: number },
): WindowPlan;

export interface WindowPromptResult {
  userContent: string;
  refToPassageId: Map<string, string>;
  /** Bytes of the JSON request body attributable to this window's text. */
  chars: number;
}

export declare function buildWindowUserContent(
  doc: { title: string; docType?: string | null },
  plan: WindowPlan,
  window: PassageWindow,
  outline: string,
): WindowPromptResult;

export interface WindowAssignment {
  ref: string;
  confidence: number;
  rationale: string;
  passageRefs: string[];
}

export type ContractCheck =
  | { ok: true; assignments: WindowAssignment[] }
  | { ok: false; reason: string };

export declare function checkWindowContract(raw: unknown, knownRefs: Set<string>): ContractCheck;

export declare function buildRepairUserContent(
  original: string,
  reason: string,
  sent: unknown,
): string;

export interface WindowResult {
  index: number;
  firstPage: number | null;
  lastPage: number | null;
  /** Resolved against real ids: refs are a prompt detail and stop here. */
  assignments: {
    node_id: string;
    confidence: number;
    rationale: string;
    passage_ids: string[];
  }[];
}

export interface MergedAssignment {
  node_id: string;
  confidence: number;
  rationale: string | null;
  passage_ids: string[];
  /** How many windows put the document in this bucket, and out of how many. */
  windowHits: number;
  windowsTotal: number;
}

export declare function mergeWindowResults(
  results: WindowResult[],
  options?: {
    windowsTotal: number;
    knownNodeIds?: Set<string>;
    assignmentCap?: number;
    passageCap?: number;
  },
): MergedAssignment[];
