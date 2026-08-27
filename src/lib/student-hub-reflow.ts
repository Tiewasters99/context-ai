// Ingested reading text arrives shaped by whatever produced it. A PDF text
// layer hard-wraps at the page's measure and marks no paragraph at all; OCR
// joins its pages with a bare page number sitting between them; a pasted
// chapter keeps the line breaks of wherever it was copied from. Read as-is
// it is a wall. This module puts the paragraphs back.
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

/** Terminal punctuation, with any closing quote or bracket after it. */
const SENTENCE_END = /[.!?][)\]'"’”»]*$/;

/** A word broken across the line break: a letter, then the hyphen, at the end. */
const BROKEN_WORD = /[A-Za-zÀ-ÿ]-$/;

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
      current = /^[a-zà-ÿ]/.test(line) ? current.slice(0, -1) + line : current + line;
    } else {
      current = `${current} ${line}`;
    }
    const last = i === trimmed.length - 1;
    if (last || (measure > 0 && line.length < measure * SHORT_LAST_LINE && SENTENCE_END.test(line))) {
      paragraphs.push(current);
      current = '';
    }
  });
  return paragraphs;
}

/**
 * Reflow raw ingested reading text into real paragraphs. Deterministic and
 * idempotent: reflowReading(reflowReading(x)) === reflowReading(x), because a
 * reflowed paragraph is a single line and a single line passes straight through.
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

  const out: string[] = [];
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    const only = lines[0].trim();
    if (lines.length === 1 && (ARABIC_PAGE.test(only) || ROMAN_PAGE.test(only))) continue;
    if (isVerse(lines)) {
      out.push(lines.join('\n'));
      continue;
    }
    out.push(...joinProse(lines));
  }
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
