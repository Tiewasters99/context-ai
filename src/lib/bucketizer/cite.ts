// How a passage becomes a citation — and how the citation degrades when the
// coordinates are not there.
//
// THE STATE OF THE RECORD, 2026-09-20
// ---------------------------------------------------------------------------
// Three facts about this corpus govern everything in this file:
//
//   1. Page:line exists only where the transcript chunker engaged. The Veritext
//      fix (PR #138: middle dots, blank numbered lines, positional numbering)
//      is merged, but NO DEPOSITION HAS BEEN RE-INGESTED since. So the
//      depositions in Fleming today are prose passages with a page and no
//      lines.
//   2. Where the chunker DID number lines positionally, the passage carries
//      `metadata.line_numbers = 'inferred'` — the numbers are the chunker's
//      count down the page, not numbers printed on it. A cite built from them
//      is a cite to a position, and it says so.
//   3. THE PAGE ITSELF. As of 2026-09-19 a full-size transcript's `page_start`
//      is the PDF PAGE INDEX, not the reporter's printed page number; only
//      condensed sheets read a "Page N" marker. An exhibit-wrapped transcript
//      is off by its slip sheet. There is no per-passage flag for this — the
//      detection is unbuilt — so it cannot be marked cite by cite. It is a
//      standing note at the head of any outline that cites a transcript.
//
// A citation that implies more precision than the record has is worse than no
// citation, because it will be typed into a brief. So each tier states its own
// limit on its own line, and no line number is ever synthesized.

import { citePage, type CitePageMetadata } from '../../../lib/cite-page.mjs';

export type CiteTier =
  /** page:line, from line numbers the chunker read off the page. */
  | 'page_line'
  /** page:line, from line numbers counted by position, not printed. */
  | 'page_line_inferred'
  /** A page, and no lines — the state every un-re-ingested deposition is in. */
  | 'page_only'
  /** Not a transcript: a document and a page. */
  | 'document_page'
  /** No page at all. */
  | 'no_page';

export interface CitePassage {
  id: string;
  page_start?: number | null;
  page_end?: number | null;
  line_start?: number | null;
  line_end?: number | null;
  witness_name?: string | null;
  // The page keys lib/cite-page.mjs reads (a transcript's printed page, a
  // Westlaw opinion's star page) beside the line-numbering flag.
  metadata?: (CitePageMetadata & { line_numbers?: string | null }) | null;
}

export interface CiteDocument {
  id: string;
  title: string;
  doc_type?: string | null;
  witness_name?: string | null;
}

export interface Cite {
  /** The citation as it appears in the outline, e.g. `Dep. of Ezekwe 42:11–14`. */
  text: string;
  tier: CiteTier;
  /** One sentence naming this cite's limit, or null when it has none. */
  caveat: string | null;
  page: number | null;
  /** The page the Reader opens (the file's own page), which a printed page is not. */
  readerPage: number | null;
  lineStart: number | null;
  lineEnd: number | null;
  witness: string | null;
  isTranscript: boolean;
}

/** `/app/document/<id>?page=N` — the Reader's page-level deep link. */
export function readerUrl(documentId: string, page: number | null | undefined): string {
  const base = `/app/document/${documentId}`;
  return typeof page === 'number' && Number.isFinite(page) && page > 0
    ? `${base}?page=${page}`
    : base;
}

const TRANSCRIPT_DOC_TYPES = /(depo|transcript|testimony|examination)/i;
const TRANSCRIPT_TITLE = /(\bdep(o|os|osition)?\b|transcript|examination before trial|\bebt\b)/i;

/**
 * Is this passage part of a transcript?
 *
 * The honest answer has to come from several places, because the strongest
 * signal is missing on exactly the documents that matter most. Fleming's
 * depositions were indexed as prose: `doc_type` is "other" and
 * `witness_name` is null on both the document and every passage. Left to the
 * typed columns alone they would cite as ordinary exhibits — "Blake Desmond
 * 10.28.22, p. 61" — with no line-number caveat at all, which is precisely the
 * false confidence this module exists to prevent. The title is the only thing
 * that still says "deposition", so the title counts.
 */
export function isTranscript(passage: CitePassage, doc: CiteDocument): boolean {
  if (passage.witness_name) return true;
  // Line numbers on a passage are only ever set by the transcript chunker
  // (`parseTranscriptPage`), so their presence is a fact about how the
  // document was indexed rather than a guess about what it is. This is the
  // branch that catches a Veritext PDF titled by date and witness — "2026-03-12
  // - PDF - FULL SIZE - RAY OKONKWO, M.D." — which the title pattern below
  // does not match and `doc_type` calls "other".
  if (typeof passage.line_start === 'number' && passage.line_start > 0) return true;
  if (doc.witness_name) return true;
  if (doc.doc_type && TRANSCRIPT_DOC_TYPES.test(doc.doc_type)) return true;
  return TRANSCRIPT_TITLE.test(doc.title ?? '');
}

/** The witness a transcript cite names, or null when nothing records one. */
export function witnessOf(passage: CitePassage, doc: CiteDocument): string | null {
  const raw = passage.witness_name ?? doc.witness_name ?? null;
  if (!raw) return null;
  const trimmed = String(raw).trim();
  return trimmed ? tidyWitness(trimmed) : null;
}

/**
 * "FELIX EZEKWE, M.D." as the chunker read it off the oath page becomes
 * "Ezekwe, M.D.". Surname only, because that is how a deposition is cited; the
 * full name appears once in the witness index.
 */
function tidyWitness(name: string): string {
  const [namePart, ...suffixes] = name.split(',').map((s) => s.trim()).filter(Boolean);
  const words = namePart.split(/\s+/).filter(Boolean);
  const surname = words.length ? words[words.length - 1] : namePart;
  const cased = /^[A-Z][A-Z'’-]+$/.test(surname)
    ? surname.charAt(0) + surname.slice(1).toLowerCase()
    : surname;
  return [cased, ...suffixes].join(', ');
}

/** A document title short enough to sit inside a citation. */
export function shortTitle(title: string, max = 60): string {
  const base = (title ?? '').replace(/\.(pdf|docx?|txt|md)$/i, '').trim() || 'Untitled document';
  return base.length <= max ? base : `${base.slice(0, max - 1).trimEnd()}…`;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const PAGE_ONLY_CAVEAT = 'page only — line numbers unavailable for this transcript';
export const INFERRED_LINES_CAVEAT =
  'line numbers counted by position, not printed on the page';
export const NO_PAGE_CAVEAT = 'no page recorded for this passage';

/**
 * The standing note that heads any outline citing a transcript.
 *
 * It is unconditional on transcripts rather than per-cite because the fact it
 * reports — that a full-size transcript's page number is the PDF's page index,
 * not the reporter's printed page — has no per-passage flag to read. Detecting
 * the printed page per chunk is the next ingestion build; until it lands, the
 * only honest thing to do with a page number in this outline is to say what it
 * is.
 */
export const PDF_INDEX_PAGE_NOTE =
  'Transcript page numbers in this outline are the page index of the PDF as stored, '
  + 'which is not always the page number printed on the reporter\'s transcript. On a '
  + 'full-size transcript the two usually agree; on an exhibit-wrapped copy they are '
  + 'off by the slip sheet, and on a printed-out text file they do not correspond at '
  + 'all. Check each page against the transcript itself before a citation goes into a '
  + 'brief or is read to a witness.';

/**
 * Build the citation for one passage.
 *
 * No branch here invents a coordinate. Where the line numbers are absent the
 * cite stops at the page and says so; where the page is absent it stops at the
 * document and says so.
 */
export function buildCite(passage: CitePassage, doc: CiteDocument): Cite {
  const transcript = isTranscript(passage, doc);
  const witness = witnessOf(passage, doc);
  // Which page to cite is one rule shared with the MCP connector
  // (lib/cite-page.mjs): the reporter's printed page where one was measured —
  // a transcript's, or a Westlaw opinion's star page — else the file's page.
  const where = citePage(passage);
  const pageStart = num(where.pageStart) ?? num(where.pageEnd);
  const pageEnd = num(where.pageEnd) ?? pageStart;
  const readerPage = num(where.readerPage) ?? pageStart;
  const lineStart = num(passage.line_start);
  const lineEnd = num(passage.line_end) ?? lineStart;
  const inferred = passage.metadata?.line_numbers === 'inferred';

  const who = witness ? `Dep. of ${witness}` : shortTitle(doc.title);

  if (pageStart == null) {
    return {
      text: who,
      tier: 'no_page',
      caveat: NO_PAGE_CAVEAT,
      page: null, readerPage: null, lineStart: null, lineEnd: null, witness, isTranscript: transcript,
    };
  }

  if (transcript && lineStart != null) {
    const lines = lineEnd != null && lineEnd !== lineStart
      ? `${lineStart}–${lineEnd}`
      : `${lineStart}`;
    return {
      text: `${who} ${pageStart}:${lines}`,
      tier: inferred ? 'page_line_inferred' : 'page_line',
      caveat: where.caveat ?? (inferred ? INFERRED_LINES_CAVEAT : null),
      page: pageStart, readerPage, lineStart, lineEnd, witness, isTranscript: true,
    };
  }

  if (transcript) {
    return {
      text: `${who}, p. ${pageStart}`,
      tier: 'page_only',
      caveat: where.caveat ?? PAGE_ONLY_CAVEAT,
      page: pageStart, readerPage, lineStart: null, lineEnd: null, witness, isTranscript: true,
    };
  }

  const pages = pageEnd != null && pageEnd !== pageStart
    ? `pp. ${pageStart}–${pageEnd}`
    : `p. ${pageStart}`;
  return {
    text: `${shortTitle(doc.title)}, ${pages}`,
    tier: 'document_page',
    caveat: where.caveat,
    page: pageStart, readerPage, lineStart: null, lineEnd: null, witness, isTranscript: false,
  };
}
