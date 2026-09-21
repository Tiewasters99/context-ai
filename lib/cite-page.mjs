// Which page a citation SHOWS, and which page the Reader OPENS.
//
// One rule, one file, because two things have to agree about it: the hosted
// MCP connector (lib/mcp-core.mjs, what an outside model is told) and the app
// (src/lib/bucketizer/cite.ts, what goes into an outline and then into a
// brief). A transcript cited one way in the connector and another way in the
// outline is the same bug twice.
//
// THE DISTINCTION THIS EXISTS TO KEEP
// ---------------------------------------------------------------------------
// A transcript has two page numbers and they are not the same number:
//
//   the PDF's page INDEX   — the nth sheet of the file. What a viewer's page
//                            box says. What the Reader must be opened at.
//   the PRINTED page       — the number the court reporter printed on the
//                            page. What "Blake Dep. 15:4" means, what opposing
//                            counsel will turn to, what the judge will read.
//
// They agree on a clean transcript and disagree on every exhibit-wrapped copy,
// every second volume, every printed-out text file. Until 2026-09-21 the index
// stored only the PDF index and every cite named it (PR #205's table). #205
// built the detector and writes what it found onto `passages.metadata`; this
// module is the reading rule for those keys.
//
// THREE STATES, AND WHY THE THIRD IS NOT THE SECOND
// ---------------------------------------------------------------------------
//   'printed'              the detector read the reporter's own number with
//                          high confidence. Cite it. Nothing to warn about —
//                          a caveat here would teach the reader to ignore
//                          caveats.
//   'pdf_index_declined'   the detector LOOKED at this page and would not
//                          claim a printed page (a slip sheet, the word index,
//                          the errata, a transcript whose text layer carries
//                          no page numbers). Cite the PDF page and say so, on
//                          that cite.
//   'unknown'              the detector never ran: the passage was indexed
//                          before 2026-09-21, or the document is not a
//                          transcript at all. Nothing is known, so nothing new
//                          is said — this is today's behaviour, unchanged, and
//                          it is what EVERY passage in the corpus is in until
//                          its document is re-indexed.
//
// Collapsing the last two would be the easy mistake: "the detector declined"
// and "the detector never ran" look alike from the outside and are not alike.
// One is a fact about this page; the other is the absence of any fact.
//
// A PRINTED PAGE NEVER APPEARS BESIDE A CAVEAT. That is the invariant. The
// caveat exists to mark a page number that is the file's, not the reporter's;
// printing it next to a number that IS the reporter's would be a lie in the
// safe direction, which is still a lie.
//
// Pure: no I/O, no client, no database. The caller supplies a row that already
// carries `metadata`.

/** @typedef {'printed'|'pdf_index_declined'|'unknown'} CitePageState */

export const CITE_PAGE_STATE = Object.freeze({
  PRINTED: 'printed',
  PDF_INDEX_DECLINED: 'pdf_index_declined',
  UNKNOWN: 'unknown',
});

/**
 * What is printed beside a cite whose page is the PDF's index and is known to
 * be. Short enough to sit inside a citation in parentheses, and it names both
 * halves of the fact: what the number IS, and what was not established.
 */
export const PDF_INDEX_CAVEAT =
  "PDF page; the transcript's printed page was not confirmed";

const isPage = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * `passages.metadata` as the row carries it. jsonb arrives as an object from
 * PostgREST; a string is tolerated because a stub, an export or a hand-rolled
 * client can hand one over, and a citation must not throw over its envelope.
 */
function readMetadata(row) {
  const raw = row?.metadata;
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

/**
 * Decide which page a citation shows, which page the Reader opens, and whether
 * a caveat belongs beside it.
 *
 * @param {object} row a passage row: `page_start`, `page_end`, and `metadata`
 *   when the caller has it. A row with no `metadata` — every passage in the
 *   corpus today — returns `unknown` with the page it already had, so a caller
 *   that routes every cite through this function changes nothing until a
 *   document is re-indexed.
 * @returns {{
 *   state: CitePageState,
 *   pageStart: number|null|undefined,
 *   pageEnd: number|null|undefined,
 *   readerPage: number|null|undefined,
 *   caveat: string|null,
 *   confidence: string|null,
 *   method: string|null,
 * }} `pageStart`/`pageEnd` are the page(s) to CITE; `readerPage` is always the
 *   PDF page, because that is the only number that opens a file.
 */
export function citePage(row) {
  const meta = readMetadata(row);
  // The PDF page is whatever the passage's own page_start has always been,
  // unless the detector recorded one explicitly (condensed sheets, where
  // page_start is the panel's printed page and the sheet's PDF page used to be
  // thrown away entirely).
  const pdfPage = isPage(meta?.pdf_page) ? meta.pdf_page : row?.page_start;

  // Tier 1 — the reporter's own page. Gated on the NUMBER being there, which
  // is the contract docs/TRANSCRIPT_PRINTED_PAGES.md states: chunkPages writes
  // `printed_page` only where it is prepared to stand behind it, and a
  // condensed sheet writes it from the panel's own marker.
  if (isPage(meta?.printed_page)) {
    return {
      state: CITE_PAGE_STATE.PRINTED,
      pageStart: meta.printed_page,
      pageEnd: isPage(meta.printed_page_end) ? meta.printed_page_end : meta.printed_page,
      readerPage: pdfPage,
      caveat: null,
      confidence: typeof meta.printed_page_confidence === 'string' ? meta.printed_page_confidence : null,
      method: typeof meta.printed_page_method === 'string' ? meta.printed_page_method : null,
    };
  }

  // Tier 2 — the detector looked and declined. `printed_page_confidence` is
  // about THIS page, not the document, so a page that fell outside every
  // fitted run reads 'none' even inside a document that scored 'high'. That is
  // what keeps the word "high" from ever appearing next to a caveat.
  if (meta?.page_source === 'pdf_index') {
    return {
      state: CITE_PAGE_STATE.PDF_INDEX_DECLINED,
      pageStart: row?.page_start,
      pageEnd: row?.page_end,
      readerPage: pdfPage,
      caveat: PDF_INDEX_CAVEAT,
      confidence: typeof meta.printed_page_confidence === 'string' ? meta.printed_page_confidence : null,
      method: null,
    };
  }

  // Tier 3 — nothing recorded. The page is returned exactly as the row holds
  // it, including a missing or null `page_end`: this branch is the no-op
  // branch, and a no-op that tidies is not a no-op.
  return {
    state: CITE_PAGE_STATE.UNKNOWN,
    pageStart: row?.page_start,
    pageEnd: row?.page_end,
    readerPage: row?.page_start,
    caveat: null,
    confidence: null,
    method: null,
  };
}

/**
 * The structured half of the same answer, for a caller that returns JSON
 * rather than a sentence — the connector's `page_basis`.
 *
 * `null` in the `unknown` state, deliberately: a result that says nothing new
 * must not grow a key that says "nothing is known", or every passage in the
 * corpus changes shape on the day this ships.
 */
export function pageBasis(where) {
  if (!where || where.state === CITE_PAGE_STATE.UNKNOWN) return null;
  return {
    cites: where.state === CITE_PAGE_STATE.PRINTED ? 'printed_page' : 'pdf_page',
    reader_page: where.readerPage,
    ...(where.confidence ? { printed_page_confidence: where.confidence } : {}),
    ...(where.method ? { printed_page_method: where.method } : {}),
    ...(where.caveat ? { caveat: where.caveat } : {}),
  };
}

/**
 * Do this passage's line numbers name lines the reporter PRINTED?
 *
 * `metadata.line_numbers === 'inferred'` (PR #138/#141) marks numbers the
 * chunker counted down the page because the text layer carried none. They
 * locate a position, not a printed line, so a cite built from them is a cite
 * to a position — and `grep`, which counts newlines inside a passage on top of
 * that, must not present the result as "15:7".
 */
export function hasPrintedLineNumbers(row) {
  if (!isPage(row?.line_start)) return false;
  return readMetadata(row)?.line_numbers !== 'inferred';
}
