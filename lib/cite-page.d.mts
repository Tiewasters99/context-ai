// Types for lib/cite-page.mjs — the browser bundle imports that module
// directly (src/lib/bucketizer/cite.ts) so the outline and the hosted MCP
// connector share one rule about which page a citation shows.

export type CitePageState = 'printed' | 'pdf_index_declined' | 'unknown';

export const CITE_PAGE_STATE: Readonly<{
  PRINTED: 'printed';
  PDF_INDEX_DECLINED: 'pdf_index_declined';
  UNKNOWN: 'unknown';
}>;

/** What is printed beside a cite whose page is known to be the PDF's index. */
export const PDF_INDEX_CAVEAT: string;

/** The `passages.metadata` keys this rule reads (PRs #138, #141, #205). */
export interface CitePageMetadata {
  printed_page?: number | null;
  printed_page_end?: number | null;
  pdf_page?: number | null;
  page_source?: 'printed' | 'pdf_index' | string | null;
  printed_page_confidence?: 'high' | 'medium' | 'low' | 'none' | string | null;
  printed_page_method?: string | null;
  line_numbers?: string | null;
}

/** The parts of a passage row this rule reads. */
export interface CitePageRow {
  page_start?: number | null;
  page_end?: number | null;
  line_start?: number | null;
  metadata?: CitePageMetadata | string | null;
}

export interface CitePageResult {
  state: CitePageState;
  /** The page(s) to CITE. */
  pageStart: number | null | undefined;
  pageEnd: number | null | undefined;
  /** Always the PDF page — the only number that opens a file. */
  readerPage: number | null | undefined;
  /** One clause naming this cite's limit, or null when it has none. */
  caveat: string | null;
  confidence: string | null;
  method: string | null;
}

export function citePage(row: CitePageRow | null | undefined): CitePageResult;

export interface PageBasis {
  cites: 'printed_page' | 'pdf_page';
  reader_page: number | null | undefined;
  printed_page_confidence?: string;
  printed_page_method?: string;
  caveat?: string;
}

/** The structured half of the same answer; null in the `unknown` state. */
export function pageBasis(where: CitePageResult | null | undefined): PageBasis | null;

/** True only where the line numbers were read off the page, not counted. */
export function hasPrintedLineNumbers(row: CitePageRow | null | undefined): boolean;
