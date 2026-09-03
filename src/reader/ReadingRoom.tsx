import { useEffect, useMemo, useState } from 'react';
import { HubReader } from '@/components/student-hub/HubReader';
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
  pages: BookPage[];
  truncated: boolean;
}

type Phase =
  | { state: 'loading' }
  | { state: 'closed'; why: string }
  | { state: 'open'; book: Book; cover: string | null };

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
 *  come out, the paragraphs come back. A deck keeps every slide as its own
 *  block with its lines intact, numbered as the deck numbers them. */
function readingText(book: Book): string {
  let text: string;
  if (book.kind === 'slides') {
    text = book.pages
      .map((p, i) => {
        const lines = (p.text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        return [`Slide ${i + 1}`, ...lines].join('\n');
      })
      .join('\n\n');
  } else {
    text = reflowReading(book.pages.map((p) => p.text ?? '').join('\n\n'));
  }
  return book.truncated ? `${text}\n\n${TRAIL}` : text;
}

async function fetchBook(id: string, signal: AbortSignal): Promise<Book> {
  const r = await fetch(`${API_BASE}/api/office?book=${encodeURIComponent(id)}`, { signal, mode: 'cors' });
  if (r.status === 404) throw new Error('That book is not on the shelves.');
  if (!r.ok) throw new Error('The reading room is closed — try again in a moment.');
  const book = (await r.json()) as Book;
  if (!book.pages?.length) throw new Error('This book has no pages the Reader can show.');
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
    // The plate is fetched alongside the book so the cover is there when
    // the book opens, not a page that appears a moment later.
    Promise.all([fetchBook(id, ctrl.signal), loadPlates()])
      .then(([book]) => setPhase({ state: 'open', book, cover: coverForTitle(book.title) }))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setPhase({ state: 'closed', why: e instanceof Error ? e.message : 'The reading room is closed.' });
      });
    return () => ctrl.abort();
  }, [id]);

  const book = phase.state === 'open' ? phase.book : null;
  const reflowed = useMemo(() => (book ? readingText(book) : ''), [book]);

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
        pageUrls={null}
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
