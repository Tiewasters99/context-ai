// Hand-written declarations for bucketizer-document.mjs (the SPA's tsconfig
// has allowJs off; the worker consumes the .mjs directly).

import type { OutlineNode } from './bucketizer-core.d.mts';
import type { WindowPassage, MergedAssignment } from './bucketizer-windows.d.mts';

export declare const WINDOW_MAX_TOKENS: number;
export declare const STORED_RATIONALE_CHARS: number;

/** One finished window. Keys are short: this is jsonb on a hot row. */
export interface StoredWindow {
  /** Window index within the plan. */
  i: number;
  done_at: string;
  fp?: number | null;
  lp?: number | null;
  /** Assignments, already resolved to node and passage ids. */
  a?: { n: string; c: number; r: string; p: string[] }[];
  /** Set when the model's answer failed the contract twice. */
  failed?: string;
}

export interface StoredRun {
  v: 1;
  /** `WindowPlan.hash` — progress from a different plan is not resumed. */
  hash: string;
  windows_total: number;
  started_at: string;
  model: string;
  w: StoredWindow[];
}

/**
 * What replaces `run` once the document is done: how much of it was actually
 * read.
 */
export interface Coverage {
  v: 1;
  windows: number;
  failed_windows: number;
  passages: number;
  chars: number;
  first_page: number | null;
  last_page: number | null;
  completed_at: string;
  model: string;
}

export interface WindowCall {
  system: string;
  userContent: string;
  maxTokens: number;
  /** 1 on the first attempt, 2 on the repair — for the spend record. */
  attempt: number;
  documentId: string;
  windowIndex: number;
}

export interface RunDeps {
  /** ALL of the document's passages, in reading order. Never a prefix. */
  fetchPassages(documentId: string): Promise<WindowPassage[]>;
  loadRun(documentId: string): Promise<StoredRun | null>;
  saveRun(documentId: string, run: StoredRun): Promise<void>;
  /** Write the merged rows and swap `run` for `coverage`, atomically enough. */
  finish(
    documentId: string,
    result: { rows: MergedAssignment[]; coverage: Coverage },
  ): Promise<void>;
  /** Returns the model's raw tool input. Throws `LlmCallError` on a refusal. */
  callWindow(call: WindowCall): Promise<unknown>;
  now?: () => string;
}

export type DocStatus =
  /** Rows written (or the sentinel set, when nothing fit). */
  | 'classified'
  /** No passages at all — a photo, a video, an image-only scan. */
  | 'no_text'
  /** Some window could not be reached; progress kept, retried next run. */
  | 'incomplete'
  /** The person pressed stop. Progress kept. */
  | 'aborted';

export interface DocOutcome {
  status: DocStatus;
  proposed: number;
  windowsTotal: number;
  windowsCalled: number;
  windowsResumed: number;
  windowsFailed: number;
  /** Plain-language notes, one per window that could not be used. */
  notes: string[];
}

export interface RunDocumentInput {
  doc: { id: string; title: string; doc_type?: string | null };
  nodes: OutlineNode[];
  deps: RunDeps;
  modelId: string;
  signal?: AbortSignal;
  onWindow?: (p: { done: number; total: number; charged: boolean }) => void;
}

export declare function classifyDocumentWindowed(
  input: RunDocumentInput,
): Promise<DocOutcome>;
