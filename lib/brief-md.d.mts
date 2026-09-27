// Types for lib/brief-md.mjs — the master.md dialect (Brief Desk, spec §3.2).

export interface BriefMark {
  type: 'bold' | 'italic' | 'underline' | 'highlight' | 'flag' | 'cite';
  attrs?: Record<string, unknown>;
}

export interface BriefNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: BriefNode[];
  text?: string;
  marks?: BriefMark[];
}

export interface BriefDoc {
  type: 'doc';
  content: BriefNode[];
}

export const SCHEMA_NAME: 'brief';
export const SCHEMA_VERSION: 1;
export const FLAG_KINDS: readonly ['STAR', 'OPP', 'EDEN', 'verify'];

export function parse(md: string): BriefDoc;
export function parseInline(
  text: string,
  ctx?: { defs: Map<string, string>; used: Set<string> },
  opts?: { noBreaks?: boolean },
): BriefNode[];
export function serialize(doc: BriefDoc | object): string;
export function serializeWithReport(doc: BriefDoc | object): { md: string; losses: string[] };
export function toPlainText(doc: BriefDoc | object): string;
export function emptyBrief(): BriefDoc;
export function footnotesOf(doc: BriefDoc | object): BriefNode[];
