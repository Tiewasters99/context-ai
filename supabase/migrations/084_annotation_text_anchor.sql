-- Context.ai Migration 084: text anchors for marks on documents without pages
--
-- What this is for
-- ---------------------------------------------------------------------------
-- 020 anchored a highlight to a PDF page: a page number plus fractional
-- rectangles over the pdfjs text layer. A Word document, a text or markdown
-- file, or a screenplay renders in the reader as flowing HTML, so there is no
-- page to put a rectangle on, and the reader offered no highlights or margin
-- notes there at all.
--
-- `text_anchor` holds where such a mark sits in the rendered document's text,
-- after the W3C Web Annotation TextPositionSelector + TextQuoteSelector:
--
--   { "start":  int,     -- character offset where the mark begins
--     "end":    int,     -- character offset where it ends (exclusive)
--     "exact":  string,  -- the marked words
--     "prefix": string,  -- up to 32 characters before them
--     "suffix": string } -- up to 32 characters after them
--
-- Offsets count into the text of the rendered document (every text node,
-- joined in document order). The reader tries the offsets first, checks the
-- words there against `exact`, and when they differ (the document was
-- re-indexed or renders slightly differently) finds `exact` again, using
-- prefix/suffix to choose among repeats. A mark it cannot find is listed as
-- unplaced rather than painted on the wrong words. See src/lib/text-anchor.ts.
--
-- Rows written for these documents use page = 1 and rects = '[]'. PDF marks
-- leave text_anchor null and are unaffected.
--
-- What it deliberately does NOT do
-- ---------------------------------------------------------------------------
--   * No RLS change. The column lives on an existing row, and 020/048's
--     policies already decide who may read, write, update and delete it.
--   * No constraint on the JSON's shape. The reader validates what it reads,
--     and a malformed anchor is simply not painted.

alter table public.document_annotations
  add column if not exists text_anchor jsonb;

comment on column public.document_annotations.text_anchor is
  'Anchor for marks on documents without pages (docx, text, markdown, screenplay): '
  '{start, end, exact, prefix, suffix} - character offsets into the rendered text plus the '
  'quoted words and up to 32 chars of context either side (W3C TextPosition + TextQuote '
  'selectors). Null for PDF marks, which use page + rects.';
