// Types for lib/trademark/parse.mjs — manual rows and the export mapper.

export interface ParsedRow {
  serial: string;
  registration_number: string | null;
  mark: string | null;
  owner: string | null;
  status: string | null;
  live: boolean | null;
  classes: string[];
  goods: string | null;
  filing_date: string | null;
  raw: Record<string, string>;
}
export interface ExportPreamble {
  /** The "Search term" line tmsearch writes above the header, or null. */
  searchTerm: string | null;
  /** "Search results from N to M": the exported range, not the reported total. */
  from: number | null;
  to: number | null;
  lines: string[];
}
export interface ExportResult {
  rows: ParsedRow[];
  errors: { line: number; message: string }[];
  unknownHeaders: string[];
  mapped: Record<string, string>;
  preamble: ExportPreamble;
}
export function parsePreamble(rowsAbove: unknown[][]): ExportPreamble;
export function liveFromStatus(status: unknown): boolean | null;
export function normalizeSerial(s: unknown): string | null;
export function parseClasses(s: unknown): string[];
export function normalizeDate(s: unknown): string | null;
export function parseManualRows(text: string): { rows: ParsedRow[]; errors: { line: number; text: string; message: string }[] };
export const HEADER_SYNONYMS: Readonly<Record<string, string[]>>;
export function mapHeaders(headers: string[]): (string | null)[];
export class ExportFormatError extends Error {}
export function mapExportTable(table: unknown[][]): ExportResult;
export function readExportFile(bytes: Uint8Array | ArrayBuffer, filename?: string): Promise<ExportResult>;
