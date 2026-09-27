// Types for the part of lib/bluebook.mjs the browser bundle imports
// (src/lib/brief/resolve.ts): the reporter grammar, so a cite in a brief is
// looked up by the same reporter spelling ingest stored (migration 101).

/** Westlaw's spelling of a reporter → the Bluebook's ("F.Supp.2d" → "F. Supp. 2d"). */
export function normalizeReporter(r: string): string;

export interface ReporterCite {
  volume: number;
  /** As normalizeReporter prints it — the spelling document_citations stores. */
  reporter: string;
  page: number;
  /** The pinpoint that follows the first page, when there is one. */
  pin: number | null;
  pin_end: number | null;
}

/** The first reporter cite in a string, or null (a WL cite, a statute, a name alone). */
export function parseReporterCite(text: string | null | undefined): ReporterCite | null;

/** Every reporter cite in a string, in order; a parallel cite gives more than one. */
export function parseReporterCites(text: string | null | undefined): ReporterCite[];
