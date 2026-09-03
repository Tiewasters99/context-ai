import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import '@fontsource-variable/cormorant-garamond';
import '@fontsource-variable/cormorant-garamond/wght-italic.css';
import { findQuote, readingParagraphs, type ReadingParagraph } from '@/lib/student-hub-reflow';

// The book, opened. Everywhere else the Student Hub is a law library — flat
// paper, hairline rules, a lawyer's surface. This is the one room that is not:
// parchment or lamplight, Cormorant Garamond, a page you turn. It is the
// Grapheon Reader, brought over whole, and it is deliberately a place you go
// rather than a panel that appears.
//
// The reader sits at z-index 30, below the study panel (40) and the assistant
// (50), so the student's assistant opens above the open book rather than
// behind it. Text readings are paginated here — CSS multi-columns, one column
// per page, stepped horizontally — which is what a book engine does inside
// anyway, and costs no dependency. Scanned readings put their page images in
// the same chrome.

const COLUMN_GAP = 64;
const TEXT_COLUMN_MAX = 620;
const FONT_MIN = 14;
const FONT_MAX = 30;
const SCALE_MIN = 0.8;
const SCALE_MAX = 3;

/** The reference's treatment for a scanned page under lamplight. */
const DARK_PAGE_FILTER = 'invert(0.88) hue-rotate(180deg) sepia(0.15)';

const READER_CSS = `
.hub-reader {
  --hub-reader-serif: 'Cormorant Garamond Variable','Cormorant Garamond',Georgia,serif;
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: text;
  overscroll-behavior: contain;
  transition: background 400ms ease, color 400ms ease;
}
.hub-reader.parchment {
  background: radial-gradient(ellipse at top, #f2e2ba 0%, #e8d5a0 55%, #d9c17a 100%);
  color: #140a02;
}
.hub-reader.dark {
  background: radial-gradient(ellipse at top, #1a1408 0%, #0e0a04 70%, #080602 100%);
  color: #e6dcc3;
}
.hub-reader button { font-family: inherit; color: inherit; }

/* The chrome takes the height its title and citation need — the page box
   below it is measured, not assumed, so it gives back whatever is left.
   The side padding keeps the title clear of the corner controls. */
.hub-reader-chrome {
  text-align: center;
  padding: 0.9rem 9rem 0.5rem;
  flex-shrink: 0;
  max-height: 104px;
  overflow: hidden;
  box-sizing: border-box;
}
/* The title is the book's name over the open page — it must read at a
   glance, in both lights, not whisper. */
.hub-reader-title {
  font-family: var(--hub-reader-serif);
  font-size: clamp(1.25rem, 2vw, 1.6rem);
  font-weight: 600;
  font-style: italic;
  line-height: 1.15;
  margin: 0;
  letter-spacing: 0.02em;
  color: #2a1608;
}
.hub-reader.dark .hub-reader-title {
  color: #f8e8b4;
  font-weight: 700;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.6), 0 0 22px rgba(240, 214, 140, 0.45);
}
/* Top-right corner: the glass and the go-to box, on the page itself. */
.hub-reader-corner {
  position: absolute;
  top: 0.8rem;
  right: 1rem;
  z-index: 26;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.hub-reader-corner-btn {
  width: 40px; height: 40px;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0;
  background: rgba(42, 30, 16, 0.08);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(42, 30, 16, 0.18);
  border-radius: 50%;
  cursor: pointer;
  opacity: 0.75;
  transition: all 180ms ease;
}
.hub-reader.dark .hub-reader-corner-btn { background: rgba(232, 212, 138, 0.08); border-color: rgba(232, 212, 138, 0.18); }
.hub-reader-corner-btn:hover { opacity: 1; background: rgba(42, 30, 16, 0.14); }
.hub-reader.dark .hub-reader-corner-btn:hover { background: rgba(232, 212, 138, 0.14); }
.hub-reader-goto {
  width: 4.6em;
  box-sizing: border-box;
  padding: 0.45rem 0.8rem;
  background: rgba(42, 30, 16, 0.08);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(42, 30, 16, 0.18);
  border-radius: 999px;
  font-family: var(--hub-reader-serif);
  /* 16px so iOS Safari doesn't zoom the page on focus. */
  font-size: 16px;
  font-style: italic;
  text-align: center;
  color: inherit;
  outline: none;
  transition: border-color 180ms ease;
}
.hub-reader.dark .hub-reader-goto { background: rgba(232, 212, 138, 0.08); border-color: rgba(232, 212, 138, 0.18); }
.hub-reader-goto:focus { border-color: rgba(42, 30, 16, 0.45); }
.hub-reader.dark .hub-reader-goto:focus { border-color: rgba(232, 212, 138, 0.5); }
.hub-reader-goto::placeholder { color: inherit; opacity: 0.45; }
.hub-reader-goto::-webkit-outer-spin-button, .hub-reader-goto::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }

.hub-reader-stage { position: relative; flex: 1 1 auto; min-height: 0; }
.hub-reader-area {
  position: absolute;
  left: 0; right: 0; top: 0; bottom: 76px;
  display: flex;
  align-items: stretch;
  justify-content: center;
}

.hub-reader-view { position: relative; overflow: hidden; align-self: center; }
.hub-reader-track {
  position: relative;
  column-fill: auto;
  font-family: var(--hub-reader-serif);
  line-height: 1.75;
  text-rendering: optimizeLegibility;
  transition: transform 260ms ease, opacity 200ms ease;
}
.hub-reader-track p { margin: 0 0 1em; text-align: justify; text-indent: 1.5em; overflow-wrap: break-word; }
.hub-reader-track p.verse { text-align: left; text-indent: 0; white-space: pre-wrap; }
.hub-reader-mark { background: rgba(201, 162, 39, 0.45); color: inherit; padding: 0; }
.hub-reader-mark.active { background: rgba(201, 162, 39, 0.85); }
.hub-reader.dark .hub-reader-mark { background: rgba(232, 212, 138, 0.32); }
.hub-reader.dark .hub-reader-mark.active { background: rgba(232, 212, 138, 0.55); }

.hub-reader-plate { position: absolute; inset: 0; scrollbar-width: thin; }
.hub-reader-plate-inner {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 100%;
  min-height: 100%;
  width: max-content;
  box-sizing: border-box;
}
.hub-reader-plate img {
  display: block;
  border-radius: 2px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
  transition: filter 400ms ease;
}

/* A deck's slide: a card on the page, set in a presentation's own sans —
   the words of the slide, its number in the corner, the notes beneath. */
.hub-reader-slide {
  position: relative;
  box-sizing: border-box;
  margin: 0 auto;
  padding: 2.2em 2.4em 2em;
  background: #fffdf7;
  color: #1a1810;
  border-radius: 6px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
  font-family: system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
  line-height: 1.5;
  text-align: left;
}
.hub-reader.dark .hub-reader-slide { background: #f3ecd8; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6); }
.hub-reader-slide h2 { font-size: 1.5em; font-weight: 700; line-height: 1.2; margin: 0 0 0.6em; }
.hub-reader-slide p { margin: 0.35em 0; }
.hub-reader-slide-num { position: absolute; top: 0.7em; right: 1em; font-size: 0.75em; font-weight: 600; letter-spacing: 0.15em; color: #a08340; }
.hub-reader-slide-notes {
  margin-top: 1.4em;
  padding: 0.8em 1em;
  background: #f3eddc;
  border-left: 3px solid #c9a227;
  font-size: 0.85em;
  color: #5c574a;
  white-space: pre-wrap;
}
.hub-reader-slide-notes strong {
  display: block;
  margin-bottom: 0.3em;
  font-size: 0.85em;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #8a6a1c;
}

.hub-reader-zone { position: absolute; top: 0; bottom: 0; z-index: 10; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.hub-reader-zone.left { left: 0; }
.hub-reader-zone.right { right: 0; }

.hub-reader-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: rgba(42, 30, 16, 0.08);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(42, 30, 16, 0.18);
  border-radius: 50%;
  cursor: pointer;
  z-index: 15;
  opacity: 0.6;
  transition: all 200ms ease;
}
.hub-reader.dark .hub-reader-nav { background: rgba(232, 212, 138, 0.08); border-color: rgba(232, 212, 138, 0.18); }
.hub-reader-nav:hover:not(:disabled) { opacity: 1; background: rgba(42, 30, 16, 0.14); transform: translateY(-50%) scale(1.05); }
.hub-reader.dark .hub-reader-nav:hover:not(:disabled) { background: rgba(232, 212, 138, 0.14); }
.hub-reader-nav:disabled { opacity: 0.15; cursor: default; }
.hub-reader-nav.left { left: clamp(0.75rem, 2vw, 1.5rem); }
.hub-reader-nav.right { right: clamp(0.75rem, 2vw, 1.5rem); }

.hub-reader-pager {
  position: absolute;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 15;
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.35rem 0.85rem;
  background: rgba(42, 30, 16, 0.06);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-radius: 999px;
  border: 1px solid rgba(42, 30, 16, 0.12);
}
.hub-reader.dark .hub-reader-pager { background: rgba(232, 212, 138, 0.06); border-color: rgba(232, 212, 138, 0.15); }
.hub-reader-start {
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: none; border-radius: 50%;
  cursor: pointer; opacity: 0.55; padding: 0;
  transition: all 180ms ease;
}
.hub-reader-start:hover { opacity: 1; background: rgba(42, 30, 16, 0.1); }
.hub-reader.dark .hub-reader-start:hover { background: rgba(232, 212, 138, 0.1); }
.hub-reader-count {
  font-family: var(--hub-reader-serif);
  font-size: 0.9rem;
  font-style: italic;
  letter-spacing: 0.08em;
  opacity: 0.6;
  white-space: nowrap;
}
.hub-reader-sep { opacity: 0.5; margin: 0 0.3em; }
.hub-reader-slider {
  width: clamp(100px, 20vw, 200px);
  height: 3px;
  -webkit-appearance: none;
  appearance: none;
  background: rgba(42, 30, 16, 0.2);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}
.hub-reader.dark .hub-reader-slider { background: rgba(232, 212, 138, 0.2); }
.hub-reader-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px; height: 12px;
  background: #6b4a2a;
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 0 6px rgba(0, 0, 0, 0.3);
}
.hub-reader.dark .hub-reader-slider::-webkit-slider-thumb { background: #e8d48a; box-shadow: 0 0 8px rgba(201, 162, 39, 0.5); }
.hub-reader-slider::-moz-range-thumb {
  width: 12px; height: 12px;
  background: #6b4a2a;
  border: none; border-radius: 50%;
  cursor: pointer;
}
.hub-reader.dark .hub-reader-slider::-moz-range-thumb { background: #e8d48a; }

.hub-reader-controls {
  position: absolute;
  bottom: 1.5rem;
  right: 1.5rem;
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.4rem;
  background: rgba(42, 30, 16, 0.08);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid rgba(42, 30, 16, 0.18);
  border-radius: 999px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
  z-index: 20;
}
.hub-reader.dark .hub-reader-controls { background: rgba(232, 212, 138, 0.08); border-color: rgba(232, 212, 138, 0.18); }
.hub-reader-btn {
  width: 38px; height: 38px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: none; border-radius: 50%;
  cursor: pointer; opacity: 0.75; padding: 0;
  transition: background 180ms ease, transform 180ms ease, opacity 180ms ease;
}
.hub-reader-btn:hover:not(:disabled) { opacity: 1; background: rgba(42, 30, 16, 0.1); }
.hub-reader.dark .hub-reader-btn:hover:not(:disabled) { background: rgba(232, 212, 138, 0.1); }
.hub-reader-btn:disabled { opacity: 0.3; cursor: default; }
.hub-reader-btn.on { opacity: 1; background: rgba(42, 30, 16, 0.14); }
.hub-reader.dark .hub-reader-btn.on { background: rgba(232, 212, 138, 0.14); }
.hub-reader-a-small { font-family: var(--hub-reader-serif); font-size: 0.85rem; font-weight: 500; }
.hub-reader-a-large { font-family: var(--hub-reader-serif); font-size: 1.25rem; font-weight: 500; }
.hub-reader-divider { width: 1px; height: 20px; background: rgba(42, 30, 16, 0.2); margin: 0 0.15rem; }
.hub-reader.dark .hub-reader-divider { background: rgba(232, 212, 138, 0.2); }

.hub-reader-search {
  position: absolute;
  top: 0; right: 0;
  z-index: 25;
  width: 360px;
  max-height: calc(100% - 2rem);
  display: flex;
  flex-direction: column;
  margin: 1rem;
  background: rgba(14, 10, 4, 0.92);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(232, 212, 138, 0.25);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
  animation: hubReaderSlideIn 200ms ease-out;
}
.hub-reader.parchment .hub-reader-search { background: rgba(245, 239, 225, 0.95); border-color: rgba(107, 74, 42, 0.25); }
@keyframes hubReaderSlideIn {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}
.hub-reader-search-bar {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid rgba(232, 212, 138, 0.12);
}
.hub-reader.parchment .hub-reader-search-bar { border-bottom-color: rgba(107, 74, 42, 0.15); }
.hub-reader-search-icon { flex-shrink: 0; color: rgba(232, 212, 138, 0.6); }
.hub-reader.parchment .hub-reader-search-icon { color: rgba(107, 74, 42, 0.5); }
.hub-reader-search-input {
  flex: 1;
  padding: 0.4rem 0;
  font-family: var(--hub-reader-serif);
  /* 16px so iOS Safari doesn't zoom the page on focus. */
  font-size: 16px;
  font-style: italic;
  color: #e6dcc3;
  background: transparent;
  border: none;
  outline: none;
}
.hub-reader.parchment .hub-reader-search-input { color: #2a1e10; }
.hub-reader-search-input::placeholder { color: rgba(230, 217, 168, 0.5); }
.hub-reader.parchment .hub-reader-search-input::placeholder { color: rgba(42, 30, 16, 0.4); }
.hub-reader-search-close {
  width: 32px; height: 32px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: none; border-radius: 50%;
  color: rgba(230, 217, 168, 0.5);
  cursor: pointer; font-size: 1.1rem; padding: 0;
  transition: all 150ms ease;
}
.hub-reader-search-close:hover { color: #f5e29a; background: rgba(232, 212, 138, 0.1); }
.hub-reader.parchment .hub-reader-search-close { color: rgba(42, 30, 16, 0.4); }
.hub-reader-results { max-height: 300px; overflow-y: auto; scrollbar-width: thin; }
.hub-reader-result {
  display: flex; gap: 0.6rem; align-items: flex-start;
  width: 100%;
  padding: 0.6rem 0.85rem;
  background: transparent; border: none;
  border-bottom: 1px solid rgba(232, 212, 138, 0.06);
  text-align: left; cursor: pointer;
  transition: background 150ms ease;
}
.hub-reader-result:hover { background: rgba(232, 212, 138, 0.08); }
.hub-reader.parchment .hub-reader-result:hover { background: rgba(107, 74, 42, 0.08); }
.hub-reader-result-page {
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  color: rgba(201, 162, 39, 0.9);
  flex-shrink: 0;
  padding-top: 0.2rem;
}
.hub-reader-result-text {
  font-family: var(--hub-reader-serif);
  font-size: 0.9rem;
  font-style: italic;
  color: #e6dcc3;
  line-height: 1.4;
}
.hub-reader.parchment .hub-reader-result-text { color: #2a1e10; }
.hub-reader-no-results {
  padding: 1rem;
  font-family: var(--hub-reader-serif);
  font-style: italic;
  font-size: 0.9rem;
  color: rgba(230, 217, 168, 0.5);
  text-align: center;
}
.hub-reader.parchment .hub-reader-no-results { color: rgba(42, 30, 16, 0.5); }

/* On a phone every control is a thumb's target: 44px minimum, the slider
   given its hit area as padding so the track itself stays a hairline. */
@media (max-width: 768px) {
  /* On a phone the title runs the full width beneath the corner buttons
     rather than in the sliver between them — two lines at most, never
     clipped, never four words wide. */
  .hub-reader-chrome { padding: 3.3rem 1.1rem 0.4rem; max-height: 112px; }
  .hub-reader-title { font-size: 1.15rem; line-height: 1.2; }
  .hub-reader-corner { top: 0.45rem; right: 0.45rem; gap: 0.3rem; }
  .hub-reader-corner-btn { width: 44px; height: 44px; }
  .hub-reader-goto { width: 4em; padding: 0.55rem 0.5rem; }
  .hub-reader-area { bottom: 128px; }
  .hub-reader-nav { width: 44px; height: 44px; opacity: 0.7; }
  .hub-reader-nav.left { left: 0.4rem; }
  .hub-reader-nav.right { right: 0.4rem; }
  .hub-reader-controls { bottom: 0.6rem; right: 0.6rem; gap: 0.2rem; padding: 0.3rem; }
  .hub-reader-btn { width: 44px; height: 44px; }
  .hub-reader-pager { bottom: calc(0.6rem + 58px); gap: 0.5rem; padding: 0.3rem 0.7rem; }
  .hub-reader-start, .hub-reader-search-close { width: 44px; height: 44px; }
  .hub-reader-slider { height: 28px; background: transparent; }
  .hub-reader-slider::-webkit-slider-runnable-track { height: 3px; border-radius: 2px; background: rgba(42, 30, 16, 0.2); }
  .hub-reader.dark .hub-reader-slider::-webkit-slider-runnable-track { background: rgba(232, 212, 138, 0.2); }
  .hub-reader-slider::-webkit-slider-thumb { margin-top: -4.5px; }
  .hub-reader-slider::-moz-range-track { height: 3px; border-radius: 2px; background: rgba(42, 30, 16, 0.2); }
  .hub-reader.dark .hub-reader-slider::-moz-range-track { background: rgba(232, 212, 138, 0.2); }
  .hub-reader-result { padding: 0.8rem 0.85rem; }
  .hub-reader-search { width: auto; left: 0; right: 0; margin: 0.5rem; max-height: calc(100% - 1rem); }
}
@media (prefers-reduced-motion: reduce) {
  .hub-reader, .hub-reader-track, .hub-reader-search { transition: none; animation: none; }
}
`;

/** One slide of a deck, read as a page: its lines (the first is the title)
 *  and the speaker notes beneath. */
export interface ReaderSlide {
  num: number;
  lines: string[];
  notes: string | null;
}

export interface HubReaderProps {
  title: string;
  /** The reflowed reading, for a text reading; empty when the reading is paged. */
  reflowed: string;
  /** Signed page-image URLs, for a scanned reading. */
  pageUrls: string[] | null;
  /** A slide deck: one card per page, typeset from the deck's own text —
   *  the office's Reader has the slides' words but never the file. */
  slides?: ReaderSlide[] | null;
  /** The cover plate or first scanned page; null opens the book on page one. */
  coverUrl: string | null;
  sessionId: string;
  onClose: () => void;
  /** The door to the student's assistant; a reader with no assistant — the
   *  office's Reading Room — leaves it out and the button with it. */
  onAskAssistant?: () => void;
  /** Told once, when the pages are set and the book can be read — what a
   *  door that holds a veil over the reader while it typesets waits for. */
  onReady?: () => void;
  /** The assistant's "take me there": a page for a scanned reading, a
   *  verbatim quote to find for a text one. A fresh nonce turns once. */
  turnTo?: { page?: number; quote?: string; nonce: number } | null;
}

/** The paragraph a character offset falls in. */
function paragraphAt(paras: ReadingParagraph[], offset: number): number {
  let lo = 0;
  let hi = paras.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (paras[mid].start <= offset) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return found;
}

/** The paragraph a page opens on — or the last one that started before it. */
function firstParagraphOnPage(map: number[], page: number): number {
  let before = 0;
  for (let i = 0; i < map.length; i += 1) {
    if (map[i] === page) return i;
    if (map[i] < page) before = i;
  }
  return before;
}

function readNumber(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch { /* a blocked store costs a bookmark, nothing more */ }
}

export function HubReader({
  title, reflowed, pageUrls, slides, coverUrl, sessionId, onClose, onAskAssistant, onReady, turnTo,
}: HubReaderProps) {
  // A deck reads like a scanned book — a page is a page, whatever it holds.
  const slideCount = slides?.length ?? 0;
  const bodyCount = pageUrls?.length || slideCount;
  const paged = bodyCount > 0;
  const coverPages = coverUrl ? 1 : 0;
  const posKey = `hub-reader-pos-${sessionId}`;

  const [theme, setTheme] = useState<'parchment' | 'dark'>(
    () => (localStorage.getItem('hub-reader-theme') === 'dark' ? 'dark' : 'parchment'),
  );
  const [fontSize, setFontSize] = useState(() => {
    const n = readNumber('hub-reader-fontsize');
    return n !== null && n >= FONT_MIN && n <= FONT_MAX ? n : 18;
  });
  const [scale, setScale] = useState(1);

  const paras = useMemo(() => readingParagraphs(reflowed), [reflowed]);

  const areaRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Where the student left off: a paragraph index for a text reading, a page
  // number for a scanned one, and -1 for the cover.
  const [restored] = useState(() => readNumber(`hub-reader-pos-${sessionId}`));
  // The paragraph the student is reading, so a repagination puts them back on
  // it rather than on whatever page number they happened to be standing on.
  const anchorRef = useRef(!paged && restored !== null && restored > 0 ? restored : 0);

  const [box, setBox] = useState({ w: 0, h: 0 });
  const [textPages, setTextPages] = useState(1);
  const [pageMap, setPageMap] = useState<number[]>([]);
  const [measured, setMeasured] = useState(false);
  // A text reading opens on its first page and is put right by the first
  // pagination pass, which knows what page the saved paragraph fell on.
  const [page, setPage] = useState(() => {
    if (restored === null || restored < 0) return 0;
    if (!paged) return coverPages;
    return Math.min(coverPages + restored, coverPages + Math.max(1, bodyCount) - 1);
  });

  const narrow = box.w > 0 && box.w < 768;
  const gutter = narrow ? 52 : 72;
  const colW = Math.max(180, Math.min(TEXT_COLUMN_MAX, box.w - gutter * 2));
  const pageH = Math.max(120, box.h);
  const step = colW + COLUMN_GAP;

  const bodyPages = paged ? bodyCount : textPages;
  const total = coverPages + bodyPages;
  const bodyIndex = page - coverPages;
  const onCover = page < coverPages;

  /* ---------------- Preferences ---------------- */

  useEffect(() => { write('hub-reader-theme', theme); }, [theme]);
  useEffect(() => { write('hub-reader-fontsize', String(fontSize)); }, [fontSize]);

  /* ---------------- The book is the whole window ---------------- */

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);

  /* ---------------- Measurement ---------------- */

  // The page box, whenever the window changes shape.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setBox((prev) => (
        prev.w === el.clientWidth && prev.h === el.clientHeight
          ? prev
          : { w: el.clientWidth, h: el.clientHeight }
      ));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The fonts settle the measure; a book typeset in the fallback face and then
  // re-typeset in Cormorant would otherwise keep the fallback's page count.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void document.fonts?.ready.then(() => { if (alive) setFontsReady(true); });
    // A browser with no font-loading API, or a font that never arrives,
    // still gets its book: the fallback face after a beat.
    const fallback = window.setTimeout(() => { if (alive) setFontsReady(true); }, 2500);
    return () => { alive = false; window.clearTimeout(fallback); };
  }, []);

  // Nothing is typeset until the page box and the fonts are known. Laying a
  // whole novel out at the fallback size — ten thousand columns of 120px —
  // and again at the real one is slow enough on a laptop and, on a phone,
  // blocked the box from ever being measured: the reader stayed blank.
  const ready = box.w > 0 && box.h > 0 && fontsReady;

  const readyTold = useRef(false);
  useEffect(() => {
    if (readyTold.current || !(measured || paged)) return;
    readyTold.current = true;
    onReady?.();
  }, [measured, paged, onReady]);

  // Pagination: the text is laid out in one tall column box and read column by
  // column. The count comes from how far the content runs past the page; each
  // paragraph's page comes from where its box landed. Both are read after the
  // browser has laid the page out, never during it.
  useEffect(() => {
    if (paged || !box.w || !box.h) return;
    const frame = requestAnimationFrame(() => {
      const track = trackRef.current;
      if (!track) return;
      const count = Math.max(1, Math.round(track.scrollWidth / step));
      const map: number[] = [];
      track.querySelectorAll<HTMLElement>('[data-para]').forEach((el) => {
        const i = Number(el.dataset.para);
        map[i] = Math.max(0, Math.min(count - 1, Math.round(el.offsetLeft / step)));
      });
      setPageMap(map);
      setTextPages(count);
      setPage((current) => (
        current < coverPages
          ? current
          : coverPages + Math.min(count - 1, map[anchorRef.current] ?? 0)
      ));
      setMeasured(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [paged, paras, fontSize, box.w, box.h, step, coverPages, fontsReady]);

  /* ---------------- Navigation ---------------- */

  const goTo = useCallback((next: number) => {
    const target = Math.max(0, Math.min(total - 1, next));
    setPage(target);
    if (!paged && target >= coverPages) {
      anchorRef.current = firstParagraphOnPage(pageMap, target - coverPages);
    }
    write(posKey, String(
      target < coverPages ? -1 : (paged ? target - coverPages : anchorRef.current),
    ));
  }, [total, paged, coverPages, pageMap, posKey]);

  const forward = useCallback(() => { goTo(page + 1); }, [goTo, page]);
  const back = useCallback(() => { goTo(page - 1); }, [goTo, page]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        || target.isContentEditable)) return;
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); forward(); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); back(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [forward, back, onClose]);

  const adjust = useCallback((delta: number) => {
    if (paged) setScale((s) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round((s + delta * 0.1) * 100) / 100)));
    else setFontSize((f) => Math.min(FONT_MAX, Math.max(FONT_MIN, f + delta)));
  }, [paged]);

  /* ---------------- Go to a page by its number ---------------- */

  const [gotoDraft, setGotoDraft] = useState('');
  const commitGoto = useCallback(() => {
    const n = parseInt(gotoDraft, 10);
    setGotoDraft('');
    if (!Number.isFinite(n)) return;
    goTo(coverPages + Math.max(1, Math.min(bodyPages, n)) - 1);
  }, [gotoDraft, goTo, coverPages, bodyPages]);

  /* ---------------- The assistant turns the pages ---------------- */

  // The passage the assistant turned to, lit briefly so the eye lands on it.
  const [flash, setFlash] = useState<{ at: number; len: number } | null>(null);
  const turnedRef = useRef(0);
  useEffect(() => {
    if (!turnTo || turnTo.nonce === turnedRef.current) return;
    if (turnTo.page == null && (!turnTo.quote || (!paged && !measured))) {
      // A quote needs the pagination in hand first; this re-runs when it lands.
      if (!turnTo.quote || paged) turnedRef.current = turnTo.nonce;
      return;
    }
    const frame = requestAnimationFrame(() => {
      turnedRef.current = turnTo.nonce;
      if (turnTo.page != null) {
        goTo(coverPages + turnTo.page - 1);
        return;
      }
      const found = findQuote(reflowed, turnTo.quote!);
      if (!found) return; // the assistant misquoted; the book stays put
      goTo(coverPages + (pageMap[paragraphAt(paras, found.at)] ?? 0));
      setFlash(found);
    });
    return () => cancelAnimationFrame(frame);
  }, [turnTo, measured, paged, reflowed, paras, pageMap, coverPages, goTo]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 5000);
    return () => clearTimeout(t);
  }, [flash]);

  /* ---------------- Search, over the reflowed text ---------------- */

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [needle, setNeedle] = useState('');
  const [activeHit, setActiveHit] = useState(-1);

  const hits = useMemo(() => {
    const q = needle.trim().toLowerCase();
    if (q.length < 2) return [] as number[];
    const hay = reflowed.toLowerCase();
    const out: number[] = [];
    let from = 0;
    while (out.length < 200) {
      const at = hay.indexOf(q, from);
      if (at === -1) break;
      out.push(at);
      from = at + q.length;
    }
    return out;
  }, [reflowed, needle]);

  const hitLength = needle.trim().length;
  const marking = searchOpen && hitLength >= 2 ? hits : [];

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery('');
    setNeedle('');
    setActiveHit(-1);
  }, []);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  /* ---------------- Render ---------------- */

  const chevron = (d: string) => (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  const indicator = onCover
    ? <>cover</>
    : <>{bodyIndex + 1}<span className="hub-reader-sep">/</span>{bodyPages}</>;

  const paragraphNodes = (p: ReadingParagraph, index: number): ReactNode => {
    // The lit passage the assistant turned to outranks any search marks.
    if (flash && flash.at >= p.start && flash.at < p.start + p.text.length) {
      const from = flash.at - p.start;
      const to = Math.min(p.text.length, from + flash.len);
      return [
        p.text.slice(0, from),
        <mark key={`flash-${index}`} className="hub-reader-mark active">{p.text.slice(from, to)}</mark>,
        p.text.slice(to),
      ];
    }
    if (!marking.length || hitLength < 2) return p.text;
    const end = p.start + p.text.length;
    const nodes: ReactNode[] = [];
    let cursor = 0;
    marking.forEach((at, i) => {
      if (at < p.start || at >= end) return;
      const from = at - p.start;
      nodes.push(p.text.slice(cursor, from));
      nodes.push(
        <mark key={`${index}-${i}`} className={i === activeHit ? 'hub-reader-mark active' : 'hub-reader-mark'}>
          {p.text.slice(from, from + hitLength)}
        </mark>,
      );
      cursor = from + hitLength;
    });
    if (!nodes.length) return p.text;
    nodes.push(p.text.slice(cursor));
    return nodes;
  };

  return (
    <div className={`hub-reader ${theme}`} role="dialog" aria-label={`${title} — the book`}>
      <style>{READER_CSS}</style>

      {/* The title alone, as a book's opened page carries it — no apparatus. */}
      <div className="hub-reader-chrome">
        <h1 className="hub-reader-title">{title}</h1>
      </div>

      {/* Two ways to a place, on the page itself: the glass, and a page
          number typed plain. The search overlay takes the corner over. */}
      {!searchOpen && (
        <div className="hub-reader-corner">
          {!paged && (
            <button
              type="button"
              className="hub-reader-corner-btn"
              onClick={() => setSearchOpen(true)}
              aria-label="Find in this reading"
              title="find in this reading"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
                <path d="M21 21L16.5 16.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          )}
          <input
            className="hub-reader-goto"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={gotoDraft}
            onChange={(e) => setGotoDraft(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitGoto(); (e.target as HTMLInputElement).blur(); }
              if (e.key === 'Escape') { setGotoDraft(''); (e.target as HTMLInputElement).blur(); }
            }}
            placeholder="p. —"
            aria-label="Go to a page by number"
            title="Type a page number and press Enter"
          />
        </div>
      )}

      <div className="hub-reader-stage">
        <div className="hub-reader-area" ref={areaRef}>
          {/* The side margins turn pages too — a wider target than the arrow
              alone on a phone, and clear of the text, so a tap meant for the
              page never steals a selection. */}
          <div
            className="hub-reader-zone left"
            style={{ width: Math.max(44, (box.w - colW) / 2) }}
            onClick={back}
            aria-hidden="true"
          />
          <div
            className="hub-reader-zone right"
            style={{ width: Math.max(44, (box.w - colW) / 2) }}
            onClick={forward}
            aria-hidden="true"
          />

          {!paged && ready && (
            <div
              className="hub-reader-view"
              style={{ width: colW, height: pageH, visibility: onCover ? 'hidden' : 'visible' }}
            >
              <div
                ref={trackRef}
                className="hub-reader-track"
                style={{
                  width: colW,
                  height: pageH,
                  columnWidth: colW,
                  columnGap: COLUMN_GAP,
                  fontSize,
                  opacity: measured ? 1 : 0,
                  transform: `translateX(${-Math.max(0, bodyIndex) * step}px)`,
                }}
              >
                {paras.map((p, i) => (
                  <p key={i} data-para={i} className={p.verse ? 'verse' : undefined}>
                    {paragraphNodes(p, i)}
                  </p>
                ))}
              </div>
            </div>
          )}

          {paged && !onCover && pageUrls && (
            <div className="hub-reader-plate" style={{ overflow: scale > 1 ? 'auto' : 'hidden' }}>
              <div className="hub-reader-plate-inner" style={{ padding: `0 ${gutter}px` }}>
                <img
                  src={pageUrls[Math.max(0, Math.min(pageUrls.length - 1, bodyIndex))]}
                  alt={`Page ${bodyIndex + 1} of the reading`}
                  style={{
                    height: `${scale * 100}%`,
                    width: 'auto',
                    maxWidth: scale <= 1 ? '100%' : 'none',
                    filter: theme === 'dark' ? DARK_PAGE_FILTER : undefined,
                  }}
                />
              </div>
            </div>
          )}

          {paged && !onCover && !pageUrls?.length && slides && slideCount > 0 && (() => {
            const s = slides[Math.max(0, Math.min(slideCount - 1, bodyIndex))];
            return (
              <div className="hub-reader-plate" style={{ overflow: 'auto' }}>
                <div className="hub-reader-plate-inner" style={{ padding: `12px ${gutter}px`, width: '100%' }}>
                  <article
                    className="hub-reader-slide"
                    style={{ width: '100%', maxWidth: 760, fontSize: `${Math.round(16 * scale)}px` }}
                  >
                    <span className="hub-reader-slide-num">{s.num}</span>
                    {s.lines.map((line, i) => (i === 0 ? <h2 key={i}>{line}</h2> : <p key={i}>{line}</p>))}
                    {s.notes && (
                      <aside className="hub-reader-slide-notes">
                        <strong>Speaker notes</strong>
                        {s.notes}
                      </aside>
                    )}
                  </article>
                </div>
              </div>
            );
          })()}

          {onCover && coverUrl && (
            <div className="hub-reader-plate" style={{ overflow: 'hidden' }}>
              <div className="hub-reader-plate-inner" style={{ padding: `0 ${gutter}px` }}>
                <img src={coverUrl} alt={`${title} — the cover`} style={{ maxHeight: pageH, maxWidth: '100%' }} />
              </div>
            </div>
          )}

          <button
            type="button"
            className="hub-reader-nav left"
            onClick={back}
            disabled={page <= 0}
            aria-label="Previous page"
          >
            {chevron('M15 19L8 12L15 5')}
          </button>
          <button
            type="button"
            className="hub-reader-nav right"
            onClick={forward}
            disabled={page >= total - 1}
            aria-label="Next page"
          >
            {chevron('M9 5L16 12L9 19')}
          </button>
        </div>
      </div>

      <div className="hub-reader-pager">
        <button
          type="button"
          className="hub-reader-start"
          onClick={() => goTo(0)}
          title="Back to the beginning"
          aria-label="Back to the beginning"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M19 20L9 12L19 4V20Z" fill="currentColor" />
            <line x1="5" y1="4" x2="5" y2="20" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </button>
        <div className="hub-reader-count">{indicator}</div>
        {total > 1 && (
          <input
            type="range"
            min={0}
            max={total - 1}
            value={page}
            onChange={(e) => goTo(Number(e.target.value))}
            className="hub-reader-slider"
            aria-label="Page slider"
          />
        )}
      </div>

      <div className="hub-reader-controls">
        <button type="button" className="hub-reader-btn" onClick={onClose} aria-label="Close the book" title="close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M19 12H5M5 12L12 19M5 12L12 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="hub-reader-divider" />
        <button
          type="button"
          className="hub-reader-btn"
          onClick={() => adjust(-2)}
          disabled={paged ? scale <= SCALE_MIN : fontSize <= FONT_MIN}
          aria-label={paged ? 'Smaller pages' : 'Smaller type'}
        >
          <span className="hub-reader-a-small">A</span>
        </button>
        <button
          type="button"
          className="hub-reader-btn"
          onClick={() => adjust(2)}
          disabled={paged ? scale >= SCALE_MAX : fontSize >= FONT_MAX}
          aria-label={paged ? 'Larger pages' : 'Larger type'}
        >
          <span className="hub-reader-a-large">A</span>
        </button>
        <div className="hub-reader-divider" />
        <button
          type="button"
          className="hub-reader-btn"
          onClick={() => setTheme((t) => (t === 'parchment' ? 'dark' : 'parchment'))}
          aria-label={theme === 'parchment' ? 'Read by lamplight' : 'Read by daylight'}
          title={theme === 'parchment' ? 'lamplight' : 'daylight'}
        >
          {theme === 'parchment' ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          )}
        </button>
        {!paged && (
          <>
            <div className="hub-reader-divider" />
            <button
              type="button"
              className={searchOpen ? 'hub-reader-btn on' : 'hub-reader-btn'}
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
              aria-label="Find in this reading"
              title="find"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
                <path d="M21 21L16.5 16.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </>
        )}
        {onAskAssistant && (
          <>
            <div className="hub-reader-divider" />
            <button
              type="button"
              className="hub-reader-btn"
              onClick={onAskAssistant}
              aria-label="Ask your assistant about this reading"
              title="ask your assistant"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M21 11.5C21 16.2 16.97 20 12 20c-1.2 0-2.34-.22-3.38-.6L4 21l1.32-3.95C4.48 15.7 4 13.66 4 11.5 4 6.8 8.03 3 13 3s8 3.8 8 8.5z"
                  stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" transform="translate(-1.5 0.5)"
                />
              </svg>
            </button>
          </>
        )}
      </div>

      {searchOpen && (
        <div className="hub-reader-search">
          <div className="hub-reader-search-bar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="hub-reader-search-icon" aria-hidden="true">
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="M21 21L16.5 16.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); setNeedle(query); setActiveHit(-1); }
                if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
              }}
              placeholder="Find in this reading…"
              aria-label="Find in this reading"
              className="hub-reader-search-input"
            />
            <button type="button" onClick={closeSearch} className="hub-reader-search-close" aria-label="Close the search">×</button>
          </div>
          {hits.length > 0 && (
            <div className="hub-reader-results">
              {hits.map((at, i) => {
                const index = paragraphAt(paras, at);
                const target = coverPages + (pageMap[index] ?? 0);
                const from = Math.max(0, at - 40);
                const to = Math.min(reflowed.length, at + hitLength + 40);
                return (
                  <button
                    key={at}
                    type="button"
                    className="hub-reader-result"
                    onClick={() => { setActiveHit(i); goTo(target); }}
                  >
                    <span className="hub-reader-result-page">p.{Math.max(1, target - coverPages + 1)}</span>
                    <span className="hub-reader-result-text">
                      {from > 0 ? '…' : ''}
                      {reflowed.slice(from, at).replace(/\s+/g, ' ')}
                      <mark className="hub-reader-mark">{reflowed.slice(at, at + hitLength)}</mark>
                      {reflowed.slice(at + hitLength, to).replace(/\s+/g, ' ')}
                      {to < reflowed.length ? '…' : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {needle.trim().length >= 2 && hits.length === 0 && (
            <p className="hub-reader-no-results">Nothing found</p>
          )}
        </div>
      )}
    </div>
  );
}
