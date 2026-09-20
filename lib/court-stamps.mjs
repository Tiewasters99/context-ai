// Court filing stamps — the header line an e-filing system burns onto every
// page of a filed document as REAL digital text:
//
//   Case 2:25-cv-02287-MAK   Document 53   Filed 02/25/26   Page 1 of 2
//   Case: 26-2098   Document: 20-4   Page: 144   Date Filed: 08/13/2026
//   FILED: NEW YORK COUNTY CLERK 01/02/2026 ...   NYSCEF DOC. NO. 5
//
// On a scanned filing that line is the only text the PDF carries, so "the
// page has text" is not "the page was read". Two scanned DeCamara orders
// (ECF 53, ECF 58) were indexed on 2026-05-25 as their stamps and nothing
// else, and read as healthy until 2026-09-18. This module is the one place
// that says whether a piece of extracted text is stamps and nothing more:
// ingest-core uses it so stamps never count as content, and
// scripts/audit-stamp-only.mjs uses it to find the documents indexed that way.
//
// Dependency-free and pure.

// A line that anchors a stamp: it carries a docket number in one of the
// shapes the federal and New York e-filing systems print.
const ANCHOR_LINES = [
  /^case:?\s*\d+:\d{2}-[a-z]{2,4}-\d{2,6}\b/i,           // district: Case 2:25-cv-02287-MAK / Case: 1:20-cv-01234
  /^case:?\s*\d{2}-\d{2,6}\b/i,                          // appellate / bankruptcy: Case: 26-2097 / Case 20-12345-abc
  /^usca\d*\s+(case|appeal)\b/i,                         // USCA Case #20-1234 / USCA4 Appeal: 20-1234
  /^appellate case:\s*\d{2}-\d{2,6}\b/i,                 // 10th Cir.
  /^filed:\s.*\bclerk\b/i,                               // NYSCEF: FILED: NEW YORK COUNTY CLERK 01/02/2026 ...
  /^nyscef doc\.?\s*no\.?\s*\d+/i,                       // NYSCEF DOC. NO. 5 RECEIVED NYSCEF: 01/02/2026
];

// A fragment of a stamp that the text extractor put on a line of its own.
const FRAGMENT_LINES = [
  /^(document|doc\.?|dkt\.?)\s*(#|:)?\s*\d+/i,
  /^(filed|entered|date filed|received nyscef)\b.{0,80}\d{2}\/\d{2}\/\d{2,4}/i,
  /^page:?\s*\d+(\s+of\s+\d+)?\s*(page\s*id\s*#?:?\s*\d+)?$/i,
  /^page\s*id\s*#?:?\s*\d+$/i,
  /^desc\s+main\s+document\b/i,
  /^index no\.?\s*[\w/-]+$/i,
];

const isAnchor = (l) => ANCHOR_LINES.some((re) => re.test(l));

export function isStampLine(line) {
  const l = String(line || '').trim();
  return isAnchor(l) || FRAGMENT_LINES.some((re) => re.test(l));
}

// pdf-parse can put a whole stamp on one line with runs of spaces between its
// fields, and the May 2026 extractor put two pages' stamps on one "page".
// Split a line wherever a new stamp begins so each is judged on its own.
function stampPieces(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => l.split(/\s{2,}(?=case\b|usca|appellate case)/i))
    .map((l) => l.trim())
    .filter(Boolean);
}

// True when every non-blank line is a stamp line and at least one of them
// carries a docket number — so a page reading only "Page 3" is not a stamp,
// and a stamp followed by one real word ("ORDER") is not stamp-only.
export function isStampOnlyText(text) {
  const pieces = stampPieces(text);
  return pieces.length > 0 && pieces.every(isStampLine) && pieces.some(isAnchor);
}

// Characters of real content: a page that is stamps and nothing else counts
// zero. Everything else counts in full — this never trims a typed page.
export function contentChars(pages) {
  return (pages || []).reduce((s, p) => s + (isStampOnlyText(p?.text) ? 0 : String(p?.text || '').trim().length), 0);
}

// The largest N in "Page n of N" — the page count the court stamped.
export function stampedPageCount(text) {
  let max = 0;
  for (const m of String(text || '').matchAll(/page\s*(\d+)\s*of\s*(\d+)/gi)) max = Math.max(max, Number(m[2]));
  return max || null;
}
