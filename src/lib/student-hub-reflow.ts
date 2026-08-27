// Ingested reading text arrives shaped by whatever produced it. A PDF text
// layer hard-wraps at the page's measure and marks no paragraph at all; OCR
// joins its pages with a bare page number sitting between them; a pasted
// chapter keeps the line breaks of wherever it was copied from. Read as-is
// it is a wall. This module puts the paragraphs back.
//
// Page furniture goes too: a bare page number at the edge of a page's block,
// and — on a text long enough to establish the pattern — the running head
// that reappears at the top of every page. A paragraph the page break cut in
// half is joined back across the seam.
//
// Deterministic and idempotent by design — no model call, and safe to run on
// every render and again on the way into an export. The stored row is never
// touched: reflow is a way of displaying the text, not a rewrite of it.

/** A block of at least this many short lines reads as verse, not prose. */
const VERSE_MIN_LINES = 3;
const VERSE_MEDIAN_MAX = 50;
const VERSE_LONGEST_MAX = 65;

/** A sentence-ending line this much shorter than the block's measure is the
 *  last line of a paragraph — hard-wrapped text has no other tell. */
const SHORT_LAST_LINE = 0.7;

/** Page artifacts from PDF text layers and OCR page joins. */
const ARABIC_PAGE = /^\d{1,4}$/;
const ROMAN_PAGE = /^[ivxlcdm]{1,7}$/i;

/** Running heads: a line this short that keeps reappearing (page number set
 *  aside) at the edge of prose blocks is the page's furniture, not its text.
 *  The pattern must be established — enough repeats, over enough of a text of
 *  enough pages — so a short reading never loses a line to a coincidence. */
const HEAD_MAX_LENGTH = 70;
const HEAD_MIN_REPEATS = 3;
const HEAD_MIN_SHARE = 0.4;
const HEAD_MIN_BLOCKS = 5;

/** Terminal punctuation, with any closing quote or bracket after it. */
const SENTENCE_END = /[.!?][)\]'"’”»]*$/;

/** A word broken across the line break: a letter, then the hyphen, at the end. */
const BROKEN_WORD = /[A-Za-zÀ-ÿ]-$/;

/** A line taking up the sentence the previous page left hanging. */
const OPENS_LOWERCASE = /^[a-zà-ÿ]/;

/** Trailing blanks, the non-breaking space included — OCR leaves them everywhere. */
const TRAILING_BLANKS = /[ \t\u00a0]+$/;

/** One paragraph of reflowed text, and where it starts in that string. */
export interface ReadingParagraph {
  text: string;
  start: number;
  verse: boolean;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Short lines, several of them, none of them running long: a stanza. Frost
 *  is a named corpus for the hub, and poetry must come through untouched. */
function isVerse(lines: string[]): boolean {
  if (lines.length < VERSE_MIN_LINES) return false;
  const widths = lines.map((l) => l.trim().length);
  return median(widths) <= VERSE_MEDIAN_MAX && Math.max(...widths) <= VERSE_LONGEST_MAX;
}

const isPageNumberLine = (line: string): boolean => {
  const t = line.trim();
  return ARABIC_PAGE.test(t) || ROMAN_PAGE.test(t);
};

/** The block with the lines its edges can spare shed — never its interior. */
function stripEdges(lines: string[], drop: (line: string) => boolean): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && drop(lines[a])) a += 1;
  while (b > a && drop(lines[b - 1])) b -= 1;
  return lines.slice(a, b);
}

/** A candidate running head, digits set aside so "TENDER IS THE NIGHT 42" and
 *  "TENDER IS THE NIGHT 43" count as the same line. Empty when the line is too
 *  long to be one. */
function headKey(line: string): string {
  const t = line.trim();
  if (!t || t.length > HEAD_MAX_LENGTH) return '';
  return t.replace(/\d+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True when the block's last line stops mid-flow — full width, no sentence
 *  end — which is a page break interrupting a paragraph, not a paragraph
 *  ending. Only a block of several lines can show its own measure. */
function openEnded(lines: string[]): boolean {
  if (lines.length < 2) return false;
  const last = lines[lines.length - 1].trim();
  if (SENTENCE_END.test(last)) return false;
  if (BROKEN_WORD.test(last)) return true;
  const measure = median(lines.slice(0, -1).map((l) => l.trim().length));
  return measure > 0 && last.length >= measure * SHORT_LAST_LINE;
}

/** Join a hard-wrapped block back into its paragraphs. */
function joinProse(lines: string[]): string[] {
  const trimmed = lines.map((l) => l.trim()).filter(Boolean);
  if (trimmed.length <= 1) return trimmed;

  // The block's own measure — the width the text was wrapped at. A block's
  // final line is short by definition and says nothing about that width.
  const measure = median(trimmed.slice(0, -1).map((l) => l.length));

  const paragraphs: string[] = [];
  let current = '';
  trimmed.forEach((line, i) => {
    if (!current) {
      current = line;
    } else if (BROKEN_WORD.test(current)) {
      // A word broken across the break closes up either way. The hyphen goes
      // only when the remainder is lowercase: "con-/tract" is one word,
      // "Anglo-/American" is a compound that keeps the hyphen it was born with.
      current = OPENS_LOWERCASE.test(line) ? current.slice(0, -1) + line : current + line;
    } else {
      current = `${current} ${line}`;
    }
    const last = i === trimmed.length - 1;
    // A break lands only before a line that could open a paragraph — never
    // before one that reads as the middle of a sentence, so that a break kept
    // here is never a join the next pass would want to make.
    if (last || (
      measure > 0
      && line.length < measure * SHORT_LAST_LINE
      && SENTENCE_END.test(line)
      && !OPENS_LOWERCASE.test(trimmed[i + 1])
    )) {
      paragraphs.push(current);
      current = '';
    }
  });
  return paragraphs;
}

/**
 * Reflow raw ingested reading text into real paragraphs. Deterministic and
 * idempotent: reflowReading(reflowReading(x)) === reflowReading(x), because a
 * reflowed paragraph is a single line, a single line passes straight through,
 * and every join this makes is one it would refuse to break.
 */
export function reflowReading(raw: string): string {
  if (!raw) return '';

  const normalized = raw
    .replace(/\r\n?/g, '\n')
    // A form feed is a page break in a text layer; here it is a block boundary.
    .replace(/\f/g, '\n\n')
    .split('\n')
    .map((line) => line.replace(TRAILING_BLANKS, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  // Blocks, with bare page numbers shed from their edges — a text layer
  // leaves "247" as the first or last line of every page's block, and a
  // number alone between blank lines is a block of its own that empties away.
  const blocks: { lines: string[]; verse: boolean }[] = [];
  for (const b of normalized.split(/\n{2,}/)) {
    const lines = stripEdges(b.split('\n').filter((l) => l.trim() !== ''), isPageNumberLine);
    if (lines.length) blocks.push({ lines, verse: isVerse(lines) });
  }

  // Running heads, established across the whole text. Verse blocks neither
  // vote nor lose lines — a villanelle's refrain repeats at stanza edges too,
  // and it is the poem.
  const proseMulti = blocks.filter((b) => !b.verse && b.lines.length >= 2);
  const edgeCounts = new Map<string, number>();
  if (proseMulti.length >= HEAD_MIN_BLOCKS) {
    for (const b of proseMulti) {
      const keys = new Set([headKey(b.lines[0]), headKey(b.lines[b.lines.length - 1])]);
      for (const key of keys) {
        if (key) edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const isRunningHead = (line: string): boolean => {
    const n = edgeCounts.get(headKey(line)) ?? 0;
    return n >= HEAD_MIN_REPEATS && n >= proseMulti.length * HEAD_MIN_SHARE;
  };

  // Assemble. Consecutive prose blocks merge when the seam between them cut a
  // paragraph in half: the earlier block stops mid-flow, or the later one
  // opens lowercase, still inside the sentence the page break interrupted.
  const out: string[] = [];
  let run: string[] | null = null;
  let runOpen = false;
  const flush = () => {
    if (run) out.push(...joinProse(run));
    run = null;
  };
  for (const b of blocks) {
    if (b.verse) {
      flush();
      out.push(b.lines.join('\n'));
      continue;
    }
    const lines = b.lines.length >= 2 ? stripEdges(b.lines, isRunningHead) : b.lines;
    if (!lines.length) continue;
    if (run && (runOpen || OPENS_LOWERCASE.test(lines[0].trim()))) {
      run.push(...lines);
    } else {
      flush();
      run = [...lines];
    }
    runOpen = openEnded(lines);
  }
  flush();
  return out.join('\n\n');
}

/**
 * The reflowed text split for rendering: each entry one paragraph, with its
 * absolute character offset in the reflowed string, so a find-in-the-text
 * match computed on that string can be marked inside the paragraph it fell in.
 */
export function readingParagraphs(reflowed: string): ReadingParagraph[] {
  const out: ReadingParagraph[] = [];
  let start = 0;
  for (const text of reflowed.split('\n\n')) {
    if (text) out.push({ text, start, verse: text.includes('\n') });
    start += text.length + 2;
  }
  return out;
}
