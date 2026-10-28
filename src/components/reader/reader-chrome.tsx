import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X, Loader2, Copy, StickyNote, MessageCircle } from 'lucide-react';
import type { PdfOpenProgress } from '@/lib/pdf-source';
import type { AnnotationColor } from '@/lib/document-annotations';
import { ANNOTATION_DOT } from '@/lib/reader-style';
import ModalPortal from '@/components/ui/ModalPortal';

// The pieces of the reading chrome that both readers draw: the PDF book
// (PdfBook.tsx) and the rendered-document path of the document view
// (src/pages/DocumentReader.tsx — Word, text, slides, screenplay, a
// picture). One copy of each, so the two never drift apart. The theme, the
// colours and the shared CSS are in src/lib/reader-style.ts.

/** An action in the phone toolbar's "more" menu. */
export type MoreItem = { icon: React.ReactNode; label: string; run: () => void; disabled?: boolean };

// The card shown while a document opens. A spinner says work is happening;
// the line under it says which work, and how far along when bytes are
// countable. The blank page it replaced read as a failed import — Eden
// waited forty seconds on a scanned book and took it for broken. After a
// while the card says so in words: not failed, just large.
const SLOW_AFTER_MS = 8000;

function fmtMB(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

export function LoadingCard({ title, progress, pageCount }: {
  title: string | null;
  progress: PdfOpenProgress | null;
  pageCount: number | null;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(t);
  }, []);

  let line = 'Finding the file…';
  let fraction: number | null = null;
  if (progress?.stage === 'signing') line = 'Reaching the file…';
  else if (progress?.stage === 'fetching') {
    line = `Opening the first pages of a ${fmtMB(progress.total)} file…`;
  } else if (progress?.stage === 'downloading') {
    if (progress.total) {
      fraction = Math.min(1, progress.loaded / progress.total);
      line = `Downloading ${fmtMB(progress.loaded)} of ${fmtMB(progress.total)}…`;
    } else line = `Downloading… ${fmtMB(progress.loaded)} so far`;
  } else if (progress?.stage === 'opening') {
    line = pageCount ? `Laying out ${pageCount} pages…` : 'Laying out the pages…';
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-16 w-[min(360px,90%)] rounded-xl border border-white/10 bg-black/30 px-6 py-5 text-center shadow-xl backdrop-blur"
    >
      <Loader2 size={28} className="mx-auto animate-spin text-[var(--color-primary)]" aria-hidden="true" />
      <p className="mt-3 text-[14px] font-medium text-white/90 truncate">{title ? `Opening ${title}` : 'Opening document'}</p>
      <p className="mt-1 text-[12.5px] text-white/60">{line}</p>
      {fraction !== null && (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-[var(--color-primary)] transition-[width] duration-300" style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
      )}
      {slow && (
        <p className="mt-3 text-[12px] text-white/50">
          Still working — a large scan can take a minute. It has not failed.
        </p>
      )}
    </div>
  );
}

// The find box in the toolbar: the query, the count (or "Searching…", or
// "Not found" once a search has looked), the arrows and the close. The
// search itself belongs to whoever owns the document; this only draws it.
export function FindBox({
  query,
  onQuery,
  searching,
  matchCount,
  matchIdx,
  searched,
  stepDisabled,
  onPrev,
  onNext,
  onClose,
  isMobile,
}: {
  query: string;
  onQuery: (q: string) => void;
  searching: boolean;
  matchCount: number;
  matchIdx: number;
  /** A find has run for the current query (so "Not found" means it looked). */
  searched: boolean;
  /** Nothing to step to, and nothing typed that has not been searched. */
  stepDisabled: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  isMobile: boolean;
}) {
  return (
    <div className="flex items-center gap-1 flex-1 min-w-0">
      <input
        autoFocus
        type="text"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { if (e.shiftKey) onPrev(); else onNext(); }
          else if (e.key === 'Escape') onClose();
        }}
        placeholder="Find in document…"
        className={`h-8 ${isMobile ? 'flex-1 min-w-0' : 'w-44'} rounded-md bg-[var(--color-surface-raised)] border border-[var(--color-border)] px-2 text-xs text-[var(--color-text-bright)] placeholder:text-white/30 focus:outline-none focus:border-[var(--color-primary)]`}
        // 16px on a phone, so iOS Safari doesn't zoom the page on focus.
        style={isMobile ? { fontSize: 16 } : undefined}
      />
      {searching ? (
        <span className="text-[11px] text-white/55 px-1 whitespace-nowrap">Searching…</span>
      ) : matchCount > 0 ? (
        <span className="text-[11px] text-white/70 tabular-nums px-1 whitespace-nowrap">
          {matchIdx + 1}/{matchCount}
        </span>
      ) : query && searched ? (
        <span className="text-[11px] text-amber-300/80 px-1 whitespace-nowrap">Not found</span>
      ) : null}
      <button
        onClick={onPrev}
        disabled={stepDisabled}
        className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-30"
        title="Previous match"
      >
        <ChevronLeft size={13} />
      </button>
      <button
        onClick={onNext}
        disabled={stepDisabled}
        className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white disabled:opacity-30"
        title="Next match"
      >
        <ChevronRight size={13} />
      </button>
      <button
        onClick={onClose}
        className="h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-white/5 text-white/70 hover:text-white"
        title="Close search"
      >
        <X size={13} />
      </button>
    </div>
  );
}

// The phone toolbar's "more": the actions that do not fit beside the page,
// dropped under the button that opened them. Portalled to <body> and placed
// from the button's rectangle — the toolbar clips its overflow and, with
// its backdrop blur, would contain a fixed child too. Closes on a tap
// anywhere else or on Escape.
export function ReaderMoreMenu({ anchor, items, onClose }: {
  anchor: HTMLElement | null;
  items: MoreItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [anchor, onClose]);
  const rect = anchor?.getBoundingClientRect();
  const top = rect ? rect.bottom + 4 : 56;
  const right = rect ? Math.max(8, window.innerWidth - rect.right) : 8;
  return (
    <ModalPortal>
    <div
      ref={ref}
      role="menu"
      className="fixed z-[80] w-60 py-1 rounded-lg bg-[#1a1a22] border border-white/15 shadow-2xl"
      style={{ top, right }}
    >
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          disabled={it.disabled}
          onClick={() => { it.run(); onClose(); }}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-white/80 hover:text-white hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <span className="shrink-0 opacity-80">{it.icon}</span>
          <span className="flex-1">{it.label}</span>
        </button>
      ))}
    </div>
    </ModalPortal>
  );
}

// The popover over a selection: the four colours, copy, a margin note, and
// a question to the Assistant. Note and Ask show only where the host offers
// them — a reader with no notes and no companion sees the colours and copy.
export function SelectionMenu({
  x,
  y,
  onAsk,
  onPick,
  onCopy,
  onNote,
  onCancel,
}: {
  x: number;
  y: number;
  onAsk?: () => void;
  onPick: (color: AnnotationColor) => void;
  onCopy: () => void;
  onNote?: () => void;
  onCancel: () => void;
}) {
  const colors: AnnotationColor[] = ['gold', 'green', 'pink', 'blue'];
  // Clamp to viewport so the popover doesn't get clipped off the top.
  const top = Math.max(8, y - 44);
  return (
    <div
      className="fixed z-[60] flex items-center gap-1 px-1.5 py-1 rounded-lg bg-[#1a1a22] border border-white/15 shadow-2xl"
      style={{ left: x, top, transform: 'translateX(-50%)' }}
      onMouseDown={(e) => e.preventDefault()} // don't drop the selection on click
    >
      {colors.map((c) => (
        <button
          key={c}
          onClick={() => onPick(c)}
          className="w-5 h-5 rounded-full hover:scale-110 transition"
          style={{ backgroundColor: ANNOTATION_DOT[c] }}
          title={`Highlight ${c}`}
        />
      ))}
      <div className="w-px h-4 bg-white/15 mx-0.5" />
      <button
        onClick={onCopy}
        className="h-5 px-1 inline-flex items-center justify-center rounded text-white/70 hover:text-[#e8b84a] transition"
        title="Copy the selected text"
      >
        <Copy size={14} />
      </button>
      {onNote && (
        <button
          onClick={onNote}
          className="h-5 px-1 inline-flex items-center justify-center rounded text-white/70 hover:text-[#e8b84a] transition"
          title="Add a margin note"
        >
          <StickyNote size={14} />
        </button>
      )}
      {onAsk && (
        <button
          onClick={onAsk}
          className="h-5 px-1 inline-flex items-center gap-1 rounded text-[#e8b84a]/85 hover:text-[#e8b84a] transition text-[11px] font-medium"
          title="Ask the Orchestrator about this passage"
        >
          <MessageCircle size={14} />
          Ask
        </button>
      )}
      <div className="w-px h-4 bg-white/15 mx-0.5" />
      <button
        onClick={onCancel}
        className="w-5 h-5 rounded-full flex items-center justify-center text-white/55 hover:text-white text-[12px] leading-none"
        title="Cancel"
      >
        ×
      </button>
    </div>
  );
}
