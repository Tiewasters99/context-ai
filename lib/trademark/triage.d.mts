// Types for lib/trademark/triage.mjs — what the runs found, deterministically.
import type { ParsedRow } from './parse.mjs';
import type { Procedure } from './procedure.mjs';

export declare const MAX_RUN_ROWS: number;
export interface RunLike {
  id?: string; query_id: string; run_at: string; source: 'manual' | 'export' | 'failed';
  reported_count: number | null; captured_count: number; gap?: boolean; gap_note?: string | null; raw?: ParsedRow[];
}
export interface QueryLike { id: string; seq: number; purpose: string; query?: string }
export interface HitLike {
  serial: string; registration_number?: string | null; mark: string | null; owner?: string | null; status_text?: string | null;
  live?: boolean | null; classes?: string[]; goods_services?: string | null; filing_date?: string | null;
  raw?: Record<string, string>; query_seqs?: number[]; bin?: 'flag' | 'note' | 'dismiss' | null;
}
export interface CollectedHit {
  serial: string; registration_number: string | null; mark: string | null; owner: string | null; status_text: string | null;
  live: boolean | null; classes: string[]; goods_services: string | null; filing_date: string | null;
  raw: Record<string, string>; query_seqs: number[];
}
export function summarizeRun(o: { source: string; reported_count: number | null; rows?: { serial: string }[] }): {
  captured: number; gap: boolean; gapNote: string | null; duplicates: string[];
};
export function latestRuns<R extends RunLike>(runs: R[]): Map<string, R>;
export function selfTestState(queries: QueryLike[], runs: RunLike[], expect?: number): 'passed' | 'failed' | 'not_run';
export const SELF_TEST_FAILED_WARNING: string;
export function isDead(hit: { live?: boolean | null; status?: string | null; status_text?: string | null }): boolean;
export function collectHits(queries: QueryLike[], runs: RunLike[]): CollectedHit[];
export function splitLiveDead<H extends HitLike>(hits: H[]): { live: H[]; dead: H[] };
export function crowdedField(hits: HitLike[], opening: string, searchClasses: string[]): { count: number; serials: string[] };
export function proposeExclusions(q7Marks: string[], opening: string, procedure?: Procedure): {
  distinctWords: number; overThreshold: boolean; proposed: { stem: string; words: number; source: 'default' | 'frequency' }[];
};
export function exclusionCheck(o: { exclusions: string[]; knownMarks?: { name: string }[]; hits?: HitLike[] }): {
  swallowed: { stem: string; name: string; kind: 'known' | 'hit'; serial?: string }[]; rescue: string[];
};
export function gapLines(queries: QueryLike[], runs: RunLike[]): string[];
