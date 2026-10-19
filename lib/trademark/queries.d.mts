// Types for lib/trademark/queries.mjs — search-term generation.
import type { Procedure } from './procedure.mjs';

export type QueryPurpose =
  | 'selftest' | 'exact' | 'embedded' | 'hinge' | 'variants' | 'stems' | 'endings'
  | 'prefix' | 'prefix_narrowed' | 'known' | 'owner' | 'foreign' | 'rescued' | 'manual';

export interface GeneratedQuery {
  seq: number; purpose: QueryPurpose; query: string; class_filter: string[]; live_only: boolean; generator_version: string;
}
export interface Decomposition {
  opening: string; hinge: string; ending: string; reason?: string;
  foreign?: { word: string; language: string; meaning: string }[]; model?: string;
}
export interface KnownMark { name: string; owner?: string; note?: string }

export const GENERATOR_VERSION: string;
export const MANUAL_SEQ_START: number;
export const FIRST_KNOWN_SEQ: number;
export const TMSEARCH_URL: string;
export function normalizeTerm(s: unknown): string;
export function markWords(mark: unknown): string[];
export function normalizePhrase(s: unknown): string;
export function nameTerm(name: unknown): string;
export function decompositionProblems(mark: string, d: Partial<Decomposition> | null | undefined): string[];
export function variantsOf(word: string, o?: { cap?: number; pairs?: boolean; region?: { minAt?: number; maxEnd?: number } }): string[];
export function classGroup(codes: string[]): string;
export function generateQueries(o: {
  mark: string; decomposition: Decomposition; searchClasses?: string[]; knownMarks?: KnownMark[];
  foreignEquivalents?: string[]; exclusions?: string[] | null; rescued?: string[]; procedure?: Procedure;
}): { queries: GeneratedQuery[]; warnings: string[] };
export function queryProblems(q: string): string[];
export function termMatchesMark(term: string, mark: string): boolean;
export function cmMatches(query: string, mark: string): boolean;
export function planRegeneration(
  existing: { id: string; seq: number; purpose: string; query: string; run_count?: number }[],
  generated: GeneratedQuery[],
): { remove: string[]; insert: GeneratedQuery[]; kept: number };
export function nextManualSeq(existing: { seq: number }[]): number;
