// Text anchors: where a mark sits in a document that has no pages.
//
// A PDF highlight is a set of rectangles on a numbered page. A Word
// document, a text file or a screenplay renders as flowing HTML, so there
// is nothing fixed to draw a rectangle on. What is fixed is the text. A
// mark there is anchored the way the W3C Web Annotation model anchors one:
//
//   * a position: `start` and `end`, character offsets into the rendered
//     document's text (every text node under the rendered root, joined in
//     document order; the same string the reader's find box searches), and
//   * a quote: the `exact` words, plus up to 32 characters either side
//     (`prefix`, `suffix`).
//
// The position is the fast path. The quote is the check and the fallback:
// when the document is re-indexed or rendered a little differently, the
// offsets drift, and the quote finds the words again. If they are gone,
// the mark is "unplaced": still listed, never painted on the wrong words.
//
// The functions at the top are pure (string in, numbers out) so they can be
// tested offline: scripts/_test-text-anchor.mjs. The DOM helpers below
// them only touch `document` when called.

export type TextAnchor = {
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
};

/** How much context either side of the quote is kept. */
export const ANCHOR_CONTEXT = 32;

/**
 * Build an anchor from offsets into `text`. Whitespace at either edge of
 * the selection is trimmed off first, so a drag that swept up a line break
 * stores the words, not the break. Returns null for an empty selection.
 */
export function anchorFromOffsets(text: string, start: number, end: number): TextAnchor | null {
  let s = Math.max(0, Math.min(start, end, text.length));
  let e = Math.min(text.length, Math.max(start, end, 0));
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  if (e <= s) return null;
  return {
    start: s,
    end: e,
    exact: text.slice(s, e),
    prefix: text.slice(Math.max(0, s - ANCHOR_CONTEXT), s),
    suffix: text.slice(e, e + ANCHOR_CONTEXT),
  };
}

// Characters shared at the END of a and b ("…the plaintiff " vs "plaintiff ").
function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
// Characters shared at the START of a and b.
function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Find where an anchor sits in `text` now.
 *
 * 1. If the words at the stored offsets are still `exact`, that is the answer.
 * 2. Otherwise look for every occurrence of `exact`. Each is scored by how
 *    much of the stored prefix and suffix still surround it; the best score
 *    wins, and a tie goes to the occurrence nearest the stored offset.
 * 3. No occurrence at all: null. The caller lists the mark as unplaced.
 */
export function offsetsFromAnchor(
  text: string,
  anchor: TextAnchor,
): { start: number; end: number } | null {
  const exact = anchor?.exact ?? '';
  if (!exact) return null;
  const { start, end } = anchor;
  if (
    Number.isInteger(start) && Number.isInteger(end) &&
    start >= 0 && end <= text.length && end - start === exact.length &&
    text.slice(start, end) === exact
  ) {
    return { start, end };
  }
  const prefix = anchor.prefix ?? '';
  const suffix = anchor.suffix ?? '';
  let best: { start: number; score: number; dist: number } | null = null;
  for (let at = text.indexOf(exact); at !== -1; at = text.indexOf(exact, at + 1)) {
    const before = text.slice(Math.max(0, at - prefix.length), at);
    const after = text.slice(at + exact.length, at + exact.length + suffix.length);
    const score = commonSuffixLength(before, prefix) + commonPrefixLength(after, suffix);
    const dist = Math.abs(at - (Number.isFinite(start) ? start : 0));
    if (!best || score > best.score || (score === best.score && dist < best.dist)) {
      best = { start: at, score, dist };
    }
  }
  return best ? { start: best.start, end: best.start + exact.length } : null;
}

/** A stored value that looks like an anchor. Rows are data; check them. */
export function isTextAnchor(v: unknown): v is TextAnchor {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.start === 'number' && typeof a.end === 'number' &&
    typeof a.exact === 'string' && a.exact.length > 0
  );
}

// ─────────────────────────────────────────────────────────────────────────
// DOM side. The rendered document's text, as one string, with a map back
// to the text nodes it came from.
// ─────────────────────────────────────────────────────────────────────────

export type FlatText = {
  text: string;
  pieces: { node: Text; start: number }[];
};

/**
 * Join every text node under `root` in document order, skipping <style>
 * and <script>. This is the one text walk the reader's find box and its
 * marks share, so an offset means the same thing to both.
 */
export function flattenText(root: Node): FlatText {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const tag = n.parentElement?.tagName;
      return tag === 'STYLE' || tag === 'SCRIPT' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const pieces: { node: Text; start: number }[] = [];
  let text = '';
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    pieces.push({ node: n, start: text.length });
    text += n.data;
  }
  return { text, pieces };
}

// Index of the last piece starting at or before `offset` (binary search).
function pieceAt(flat: FlatText, offset: number, preferNext: boolean): number {
  const { pieces } = flat;
  let lo = 0;
  let hi = pieces.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const s = pieces[mid].start;
    if (s < offset || (s === offset && preferNext)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** A DOM Range over [start, end) of the flattened text, or null. */
export function rangeFromOffsets(flat: FlatText, start: number, end: number): Range | null {
  if (!flat.pieces.length || start < 0 || end > flat.text.length || end <= start) return null;
  const i = pieceAt(flat, start, true);
  const j = pieceAt(flat, end, false);
  const r = document.createRange();
  r.setStart(flat.pieces[i].node, start - flat.pieces[i].start);
  r.setEnd(flat.pieces[j].node, end - flat.pieces[j].start);
  return r;
}

// Offset in the flattened text of a DOM boundary point. A text-node point
// maps directly; an element point (a triple-click selects a whole
// paragraph that way) is the start of the first text node at or after it.
function offsetOfPoint(flat: FlatText, container: Node, offset: number): number {
  if (container.nodeType === Node.TEXT_NODE) {
    const hit = flat.pieces.find((p) => p.node === container);
    if (hit) return hit.start + Math.min(offset, hit.node.data.length);
  }
  // Anything else, including a point outside `root` (a drag that ran past
  // the end of the document ends in an ancestor): the first text node at or
  // after the point, or the end of the text when there is none.
  const probe = document.createRange();
  probe.setStart(container, offset);
  for (const p of flat.pieces) {
    // comparePoint: -1 = the point is before the probe's boundary.
    if (probe.comparePoint(p.node, 0) >= 0) return p.start;
  }
  return flat.text.length;
}

/**
 * The anchor for a live selection Range inside `root`, clamped to it, or
 * null when the selection holds no text of the document.
 */
export function anchorFromRange(root: Node, range: Range, flat: FlatText = flattenText(root)): TextAnchor | null {
  if (!range.intersectsNode(root)) return null;
  const start = offsetOfPoint(flat, range.startContainer, range.startOffset);
  const end = offsetOfPoint(flat, range.endContainer, range.endOffset);
  return anchorFromOffsets(flat.text, start, end);
}
