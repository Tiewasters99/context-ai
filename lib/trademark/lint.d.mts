// Types for lib/trademark/lint.mjs — the forbidden-phrase lint.
import type { ForbiddenPhrase } from './procedure.mjs';

export interface LintHit { phrase: string; index: number; sentence: string }
export function forbiddenPhrases(text: string, list?: ForbiddenPhrase[]): LintHit[];
export function lintClean(text: string, list?: ForbiddenPhrase[]): boolean;
export function lintValue(value: unknown, path?: string, list?: ForbiddenPhrase[]): { path: string; phrase: string; sentence: string }[];
