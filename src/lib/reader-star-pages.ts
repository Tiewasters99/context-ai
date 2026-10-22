// Star pages in bold (Eden, 10-21: "it is very hard to see the page numbers …
// very frustrating when you are trying to find the page under time pressure",
// cite-checking an appellate brief for a midnight filing). A Westlaw or Lexis
// opinion marks the reporter's page breaks inline — "*146" for the first
// reporter, "**523" for the second — in body type, where they vanish.
//
// Display only: the words are unchanged (a tag around them), so find, the
// relied-on highlight, notes and anchors, which read the rendered TEXT, are
// unaffected, and nothing is re-indexed. A stray "*12" in a non-legal document
// would go bold too; a document needs a few markers before any are marked.

/** Fewer markers than this and the document is not star-paged: leave it alone. */
const MIN_MARKERS = 3;

// A marker: one to three stars and a page number, after a space or an opening
// bracket (or at the start of a text run), before a space or punctuation.
const MARKER = /(^|[\s([>])(\*{1,3}\d{1,5})(?=[\s.,;:)\]<]|$)/g;

/** The HTML with each star-page marker wrapped in <strong class="star-page">. Tags and attributes are never touched. */
export function boldStarPages(html: string): string {
  const parts = html.split(/(<[^>]*>)/);
  let count = 0;
  for (let i = 0; i < parts.length; i += 2) count += (parts[i].match(MARKER) ?? []).length;
  if (count < MIN_MARKERS) return html;
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i]) parts[i] = parts[i].replace(MARKER, '$1<strong class="star-page">$2</strong>');
  }
  return parts.join('');
}
