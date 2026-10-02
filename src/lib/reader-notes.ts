// Word's notes in the Reader (10-02).
/**
 * Word's notes, as mammoth renders them (an <ol> of li#footnote-… at the
 * end), get a heading: at the bottom of a long decision an unlabeled list
 * read as no footnotes at all (Eden, 10-02).
 */
export function labelWordNotes(html: string): string {
  return html
    .replace(/<ol>(\s*)<li id="footnote-/, '<h3 class="reader-notes-heading">Footnotes</h3><ol>$1<li id="footnote-')
    .replace(/<ol>(\s*)<li id="endnote-/, '<h3 class="reader-notes-heading">Endnotes</h3><ol>$1<li id="endnote-');
}
