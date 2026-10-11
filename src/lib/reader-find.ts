// The two shapes of a find query, shared by the PDF book (src/components/
// reader/PdfBook.tsx) and the rendered-document path of the document view
// (src/pages/DocumentReader.tsx).

// A find query as a regex: each word literal, any whitespace between words
// (a transcript's text is broken by line; the brief quotes it in one line).
export function phraseRegex(q: string): RegExp {
  const words = q.trim().split(/\s+/).filter(Boolean);
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(words.map(esc).join('\\s+'), 'gi');
}
// The same query for Postgres LIKE: wildcards escaped ("100%" finds "100%"),
// any run of whitespace a wildcard. Wider than the regex; the regex decides.
export function likePattern(q: string): string {
  const words = q.trim().split(/\s+/).filter(Boolean);
  const esc = (w: string) => w.replace(/[%_\\]/g, (c) => '\\' + c);
  return '%' + words.map(esc).join('%') + '%';
}
