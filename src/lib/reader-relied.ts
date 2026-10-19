// The relied-on words, as DOM Ranges (src/lib/brief/relied-passage.ts picks
// them; this finds them on screen). One walk for a PDF page's text layer and
// a rendered Word file alike.
//
// The text nodes are joined with a space between each: a PDF text layer puts
// each run of a line in its own span with no space between spans, and a Word
// file's paragraphs meet with no space either, so a plain join would read
// "word</span><span>Word" as one word. Offsets still map back to the nodes
// (each piece keeps its own start), so a Range may run across many spans —
// a phrase that wraps a line is lit whole.

import { rangeFromOffsets, type FlatText } from '@/lib/text-anchor';
import { locatePhrase } from '@/lib/brief/relied-passage';

export function flattenSpaced(root: Node): FlatText {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const tag = n.parentElement?.tagName;
      return tag === 'STYLE' || tag === 'SCRIPT' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const pieces: FlatText['pieces'] = [];
  let text = '';
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    pieces.push({ node: n, start: text.length });
    text += n.data + ' ';
  }
  return { text, pieces };
}

/**
 * Each phrase as a Range under `root`, found in order (a later phrase is
 * looked for after the one before it — a transcript's lines, a quote's pieces
 * across an ellipsis). A phrase not found is skipped; the count says so.
 */
export function reliedRanges(root: Node, phrases: string[]): Range[] {
  const flat = flattenSpaced(root);
  const out: Range[] = [];
  let from = 0;
  for (const phrase of phrases) {
    const at = locatePhrase(flat.text, phrase, from) ?? locatePhrase(flat.text, phrase);
    if (!at) continue;
    const r = rangeFromOffsets(flat, at.start, at.end);
    if (r) { out.push(r); from = at.end; }
  }
  return out;
}
