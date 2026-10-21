// Types for lib/trademark/report.mjs — the knockout report.
import type { LintHit } from './lint.mjs';
import type { Procedure } from './procedure.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
export const REPORT_SENTENCE_AI: string;
export const LIMITS_FIXED: readonly string[];
export function cell(v: unknown): string;
export function reportFilename(mark: string, date: string): string;
export function assembleReport(o: {
  clearance: Record<string, any>;
  matter: { name: string };
  preparer: { name: string; initials: string };
  date: string;
  queries: Record<string, any>[];
  runs: Record<string, any>[];
  hits: Record<string, any>[];
  aiUse?: { feature: string; model: string; count: number }[];
  procedureHash: string;
  procedure?: Procedure;
}): string;
export function methodMarkdown(procedure?: Procedure, hash?: string): string[];
export function lintableText(md: string): string;
export function lintReport(md: string): LintHit[];
export function reportHash(md: string): Promise<string>;
export function aiUseFrom(o: { hits?: Record<string, any>[]; clearance?: Record<string, any> }): { feature: string; model: string; count: number }[];
