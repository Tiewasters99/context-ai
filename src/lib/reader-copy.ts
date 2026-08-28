// Clean copy out of the document reader.
//
// What the reader paints is not what a paste should carry. A PDF's text
// layer is absolutely-positioned span soup — transparent ink, inline
// transforms, search-highlight colors — and Word reproduces every bit of it
// as underlines and colors. So the reader intercepts copy over the text
// layer and hands the clipboard two honest flavors: the selected text
// plain, and the same text as unstyled paragraphs. "Copy the document"
// does the same for the whole file, with the hard line-wraps reflowed into
// flowing paragraphs so the paste reads like a document, not a scan.
//
// The reflow machinery is the student hub's reading reflow — deterministic,
// page-seam-aware, verse-preserving — reused here as the plain text library
// it is.

import { reflowReading, readingParagraphs } from '@/lib/student-hub-reflow';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Selected text as minimal HTML: paragraphs at blank lines, <br> within —
 *  no fonts, no colors, nothing for Word to dress the paste in. */
export function selectionHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/**
 * The copy interception: when the selection lives in the given container,
 * replace the browser's styled fragment with plain text + minimal HTML.
 * Returns true when it intercepted (the caller's JSX needs nothing else).
 */
export function interceptStyledCopy(
  e: { clipboardData: DataTransfer | null; preventDefault(): void },
  container: HTMLElement | null,
): boolean {
  if (!container || !e.clipboardData) return false;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return false;
  const text = sel.toString();
  if (!text) return false;
  e.clipboardData.setData('text/plain', text);
  e.clipboardData.setData('text/html', selectionHtml(text));
  e.preventDefault();
  return true;
}

interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
}
interface PdfPageLike {
  getTextContent(): Promise<{ items: TextItemLike[] }>;
}
interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<unknown>;
}

interface PdfLine {
  text: string;
  y: number | null;
}

function pageLines(items: TextItemLike[]): PdfLine[] {
  const lines: PdfLine[] = [];
  let text = '';
  let y: number | null = null;
  for (const item of items) {
    if (item.str) {
      text += item.str;
      y ??= item.transform?.[5] ?? null;
    }
    if (item.hasEOL) {
      if (text.trim()) lines.push({ text, y });
      text = '';
      y = null;
    }
  }
  if (text.trim()) lines.push({ text, y });
  return lines;
}

/** A candidate header/footer line, digits set aside so "DRAFT — 42" and
 *  "DRAFT — 43" count as the same line; empty when too long to be one. */
function furnitureKey(line: string): string {
  const t = line.trim();
  if (!t || t.length > 72) return '';
  return t.replace(/\d+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const PAGE_NUMBER_LINE = /^(?:-?\s*\d{1,4}\s*-?|[ivxlcdm]{1,8})$/i;

/**
 * One page's lines as text with paragraph breaks put back. A PDF's text
 * stream has no blank lines — paragraph structure is geometry, not
 * characters — so a vertical gap clearly wider than the page's line step
 * (or a jump back up the page: a new column or region) becomes the blank
 * line the reflow needs to see. The step comes in from the caller — read
 * across the whole document, so a sparse or paragraph-heavy page can't
 * skew its own baseline.
 */
function linesWithBreaks(lines: PdfLine[], step: number): string {
  if (!lines.length) return '';
  let out = lines[0].text;
  for (let i = 1; i < lines.length; i += 1) {
    const a = lines[i - 1].y;
    const b = lines[i].y;
    const gap = a !== null && b !== null ? a - b : null;
    const breaks = gap !== null && step > 0 && (gap > step * 1.45 || gap <= 0);
    out += breaks ? '\n\n' : '\n';
    out += lines[i].text;
  }
  return out.trim();
}

/**
 * Every page's text with page furniture gone and paragraph structure
 * recovered, handed to the reflow for the joining it is good at. The
 * furniture pass is the extractor's own because only it still knows the
 * pages: a first or last line whose digit-blind text repeats across most
 * pages is a running head or footer — "CONFIDENTIAL — SUBJECT TO
 * PROTECTIVE ORDER" on every production page goes too — and bare page
 * numbers at the edges go with them.
 */
export async function pdfDocumentText(pdf: PdfDocLike): Promise<string> {
  const pages: PdfLine[][] = [];
  for (let p = 1; p <= pdf.numPages; p += 1) {
    const page = (await pdf.getPage(p)) as PdfPageLike;
    const content = await page.getTextContent();
    pages.push(pageLines(content.items));
  }

  const heads = new Map<string, number>();
  const feet = new Map<string, number>();
  for (const lines of pages) {
    const first = furnitureKey(lines[0]?.text ?? '');
    const last = furnitureKey(lines[lines.length - 1]?.text ?? '');
    if (first) heads.set(first, (heads.get(first) ?? 0) + 1);
    if (last) feet.set(last, (feet.get(last) ?? 0) + 1);
  }
  const need = Math.max(2, Math.ceil(pages.length * 0.6));
  const isFurniture = (line: string, counts: Map<string, number>) => {
    const t = line.trim();
    if (PAGE_NUMBER_LINE.test(t)) return true;
    const key = furnitureKey(t);
    return !!key && (counts.get(key) ?? 0) >= need;
  };

  const kept = pages.map((lines) => {
    let a = 0;
    let b = lines.length;
    while (a < b && isFurniture(lines[a].text, heads)) a += 1;
    while (b > a && isFurniture(lines[b - 1].text, feet)) b -= 1;
    return lines.slice(a, b);
  });

  // The document's usual line step, from the lower quartile of every
  // page's downward gaps — paragraph gaps are the sparse outliers above it.
  const gaps: number[] = [];
  for (const lines of kept) {
    for (let i = 1; i < lines.length; i += 1) {
      const a = lines[i - 1].y;
      const b = lines[i].y;
      if (a !== null && b !== null && a - b > 0) gaps.push(a - b);
    }
  }
  const sorted = gaps.sort((x, z) => x - z);
  const step = sorted.length ? sorted[Math.floor(sorted.length / 4)] : 0;

  const texts = kept.map((lines) => linesWithBreaks(lines, step));
  return reflowReading(texts.filter(Boolean).join('\n\n').trim());
}

/** Reflowed text as minimal HTML — one <p> per paragraph, verse keeping
 *  its own line breaks. */
export function reflowedHtml(reflowed: string): string {
  return readingParagraphs(reflowed)
    .map((p) => `<p>${escapeHtml(p.text).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** The visible text of rendered HTML, for the plain-text flavor. */
export function htmlPlainText(html: string): string {
  const box = document.createElement('div');
  box.innerHTML = html;
  // Block elements read as their own lines.
  box.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, section, aside, br')
    .forEach((el) => {
      if (el.tagName === 'BR') el.replaceWith('\n');
      else el.append('\n');
    });
  return (box.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Both flavors onto the clipboard; falls back to text alone where the
 *  richer write is unavailable. */
export async function writeClipboard(text: string, html: string): Promise<void> {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ]);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}
