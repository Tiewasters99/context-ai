import { useEffect, useMemo, useState } from 'react';
import { HubReader, type ReaderSlide } from '@/components/student-hub/HubReader';
import { reflowReading } from '@/lib/student-hub-reflow';
import { coverForTitle, loadPlates } from '@/lib/cover-plates';

// The Reading Room: the Reader, standing on its own.
//
// One copy, one Reader, many doors. This is the door the office uses. A
// visitor takes a book down from a shelf at /office/ and it opens here, in
// the same Reader the Student Hub reads in — parchment or lamplight,
// Cormorant, a page you turn. It is its own Vite entry (reader.html), so
// the walkable office loads a reader and not the whole workspace, and it
// signs nobody in: everything it shows comes through the public office
// feed, GET /api/office?book=<item id>, which serves text and only text.
// The book stays in the vault; this is the copy left out on the table.
//
// Addressed as /read/<item id> (a Vercel rewrite in production, a small
// middleware under vite dev) or as reader.html?book=<item id>. Framed by
// the office (?embed=1) it speaks to the room with postMessage: `ready`
// once the pages are set, `close` when the visitor puts the book back.

interface BookPage {
  n: number;
  page: number | null;
  text: string;
}

interface Book {
  id: string;
  title: string;
  author: string | null;
  /** A slide deck reads as its slides; everything else as flowing pages. */
  kind?: 'text' | 'slides';
  /** The jacket captured at publish time — the one image the glass lets through. */
  cover?: string | null;
  /** Every page as an image, for a deck saved as PDF — the Reader turns these. */
  images?: string[] | null;
  pages: BookPage[];
  truncated: boolean;
}

type Phase =
  | { state: 'loading' }
  | { state: 'closed'; why: string }
  | { state: 'open'; book: Book; cover: string | null; slides: ReaderSlide[] | null; images: string[] | null };

const query = new URLSearchParams(window.location.search);
const embedded = query.get('embed') === '1' || window.parent !== window;

/** The book this page was opened on: ?book= first, then /read/<id>. */
function requestedBook(): string | null {
  const q = query.get('book');
  if (q) return q;
  const m = window.location.pathname.match(/^\/read\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Where the office feed answers: this origin on contextspaces.ai, production
 *  from anywhere else (the feed is CORS-open by design), or ?api= for a harness. */
const API_BASE = query.get('api')
  ?? (/(^|\.)contextspaces\.ai$/i.test(window.location.hostname) ? '' : 'https://www.contextspaces.ai');

function tellTheOffice(action: 'ready' | 'close'): void {
  if (!embedded) return;
  window.parent.postMessage({ type: 'cs-reader', action }, '*');
}

const TRAIL = 'The rest stays in the vault.';

/** The book's pages as one reading. Prose goes through the same reflow the
 *  hub uses — a PDF text layer's hard wraps, page numbers and running heads
 *  come out, the paragraphs come back. */
function readingText(book: Book): string {
  const text = reflowReading(book.pages.map((p) => p.text ?? '').join('\n\n'));
  return book.truncated ? `${text}\n\n${TRAIL}` : text;
}

/** A deck's passages as slides: ingest indexes one passage per slide, its
 *  lines in order and the speaker notes after a "Notes:" marker. Each
 *  becomes a card the Reader turns like a page. */
function deckSlides(book: Book): ReaderSlide[] {
  const slides = book.pages.map((p, i) => {
    const raw = (p.text ?? '').replace(/\r\n?/g, '\n');
    const at = raw.search(/(^|\n)Notes: /);
    const body = at >= 0 ? raw.slice(0, at) : raw;
    const notes = at >= 0 ? raw.slice(at).replace(/^\n*Notes: /, '').trim() : null;
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    return { num: i + 1, lines, notes: notes || null };
  });

  // A deck's furniture: the slide number the master prints in a corner and
  // the footer it prints on every slide come through the text layer as the
  // last lines of each slide. A bare number at the end goes; so does any
  // line that closes a good share of the slides — established across the
  // deck, so a short deck never loses a real line to a coincidence.
  const key = (l: string) => l.replace(/\d+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const closing = new Map<string, number>();
  for (const s of slides) {
    for (const l of new Set(s.lines.slice(-2).map(key))) {
      if (l) closing.set(l, (closing.get(l) ?? 0) + 1);
    }
  }
  const isFooter = (l: string) => {
    const n = closing.get(key(l)) ?? 0;
    return slides.length >= 5 && n >= 3 && n >= slides.length * 0.4;
  };
  for (const s of slides) {
    let end = s.lines.length;
    while (end > 1 && (/^\d{1,3}$/.test(s.lines[end - 1]) || isFooter(s.lines[end - 1]))) end -= 1;
    s.lines = s.lines.slice(0, end);
    if (!s.lines.length) s.lines = ['—'];
  }
  return slides;
}

async function fetchBook(id: string, signal: AbortSignal): Promise<Book> {
  const r = await fetch(`${API_BASE}/api/office?book=${encodeURIComponent(id)}`, { signal, mode: 'cors' });
  if (r.status === 404) throw new Error('That book is not on the shelves.');
  if (!r.ok) throw new Error('The reading room is closed — try again in a moment.');
  const book = (await r.json()) as Book;
  if (!book.pages?.length && !book.images?.length) throw new Error('This book has no pages the Reader can show.');
  return book;
}

const HALL_CSS = `
.reading-room-hall {
  position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 1.4rem; text-align: center; padding: 0 2rem;
  font-family: 'Cormorant Garamond Variable','Cormorant Garamond',Georgia,serif;
}
.reading-room-hall.parchment {
  background: radial-gradient(ellipse at top, #f2e2ba 0%, #e8d5a0 55%, #d9c17a 100%);
  color: #2a1608;
}
.reading-room-hall.dark {
  background: radial-gradient(ellipse at top, #1a1408 0%, #0e0a04 70%, #080602 100%);
  color: #e6dcc3;
}
.reading-room-line { margin: 0; font-size: clamp(1.2rem, 2.4vw, 1.6rem); font-style: italic; letter-spacing: 0.02em; }
.reading-room-back {
  background: none; border: 1px solid currentColor; color: inherit; font: inherit;
  font-size: 0.85rem; letter-spacing: 0.18em; text-transform: uppercase; padding: 0.6rem 1.4rem;
  border-radius: 999px; cursor: pointer; opacity: 0.75;
}
.reading-room-back:hover { opacity: 1; }
`;

export default function ReadingRoom() {
  const [id] = useState(requestedBook);
  const [phase, setPhase] = useState<Phase>(() => (id ? { state: 'loading' } : { state: 'closed', why: 'No book was named.' }));
  // The hall is lit the way the reader was left, so nothing flashes between them.
  const [theme] = useState<'parchment' | 'dark'>(() => {
    try { return localStorage.getItem('hub-reader-theme') === 'dark' ? 'dark' : 'parchment'; } catch { return 'parchment'; }
  });

  useEffect(() => {
    if (!id) return;
    const ctrl = new AbortController();
    // The plates are fetched alongside the book so a cover is there when
    // the book opens, not a page that appears a moment later. A book wears
    // its own jacket when one was captured, a plate from the library when
    // not; a deck opens on its first slide.
    Promise.all([fetchBook(id, ctrl.signal), loadPlates()])
      .then(([book]) => {
        const deck = book.kind === 'slides';
        const images = book.images?.length ? book.images : null;
        setPhase({
          state: 'open',
          book,
          // Page images are the book itself: the first page is its own cover.
          cover: images ? null : (book.cover ?? (deck ? null : coverForTitle(book.title))),
          slides: deck && !images ? deckSlides(book) : null,
          images,
        });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setPhase({ state: 'closed', why: e instanceof Error ? e.message : 'The reading room is closed.' });
      });
    return () => ctrl.abort();
  }, [id]);

  const book = phase.state === 'open' ? phase.book : null;
  const reflowed = useMemo(
    () => (book && book.kind !== 'slides' && !book.images?.length ? readingText(book) : ''),
    [book],
  );

  useEffect(() => {
    if (!book) return;
    document.title = `${book.title} — The Reading Room`;
  }, [book]);

  const close = () => {
    if (embedded) { tellTheOffice('close'); return; }
    if (window.history.length > 1) window.history.back();
    else window.location.assign('/office/');
  };

  if (phase.state === 'open') {
    const { title, author } = phase.book;
    return (
      <HubReader
        title={author ? `${title} · ${author}` : title}
        reflowed={reflowed}
        pageUrls={phase.images}
        pageTone="print"
        slides={phase.slides}
        coverUrl={phase.cover}
        sessionId={`office-${phase.book.id}`}
        onClose={close}
        onReady={() => tellTheOffice('ready')}
      />
    );
  }

  return (
    <div className={`reading-room-hall ${theme}`} role="status">
      <style>{HALL_CSS}</style>
      <p className="reading-room-line">{phase.state === 'loading' ? 'Taking the book down…' : phase.why}</p>
      {phase.state === 'closed' && (
        <button type="button" className="reading-room-back" onClick={close}>Back to the shelves</button>
      )}
    </div>
  );
}
