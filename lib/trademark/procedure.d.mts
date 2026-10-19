// Types for lib/trademark/procedure.mjs — the recipe's procedure, as data.

export interface SubstitutionRow { id: string; from: string; to: string[]; tier: number; why: string; initialOnly?: boolean; rule?: string }
export interface ClassNote { code: string; label: string; why: string }
export interface ForbiddenPhrase { phrase: string; why: string; unlessFollowedBy?: string; within?: number }

export interface Procedure {
  substitutions: { version: number; about: string; variantCap: number; stemCap: number; endingCap: number; rows: SubstitutionRow[] };
  endings: { version: number; rule: string; why: string; examples: unknown[] };
  exclusions: { version: number; about: string; reviewThreshold: number; frequencyFloor: number; defaults: Record<string, string[]>; why: Record<string, string> };
  classes: { version: number; about: string; notes: ClassNote[] };
  forbidden: { version: number; about: string; phrases: ForbiddenPhrase[] };
  selftest: { version: number; serial: string; expect: number; why: string };
  syntax: { version: number; source: string; verified: string; rules: string[]; tags: { tag: string; meaning: string }[] };
}

export const GENERATOR_VERSION: string;
export const PROCEDURE: Procedure;
export const PROCEDURE_FILES: readonly string[];
export const HOW_TO_CHANGE: string;
export function canonicalJson(value: unknown): string;
export function procedureText(procedure?: Procedure): string;
export function procedureHash(procedure?: Procedure): Promise<string>;
