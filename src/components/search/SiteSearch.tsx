// Site search — find a DOCUMENT by name, anywhere you can look.
//
// A matter here holds 7,600 documents and an account holds twenty thousand.
// Until now the only way to find one by name was to open its matter, wait for
// the list, and type into a box that filtered the rows the browser happened to
// have loaded. This is one entry, from anywhere: type a few letters, see the
// documents, with the matter each one is in, and press Enter to open it.
//
// It is a docket, not a spotlight: one line per document, the name, then the
// matter, the shelf and the date. No previews, no excerpts, no body text —
// the server has none to give (migration 081 returns metadata only), which is
// also why a sealed matter is in this list, marked, exactly as it is in the
// sidebar and in the Vault's own file list.
//
// The card is draggable and resizable and remembers where it was left, per the
// house rule for cards; right-click pins it in place.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Loader2, X, FileText, Lock, AlertCircle, CornerDownLeft } from 'lucide-react';
import ModalPortal from '@/components/ui/ModalPortal';
import PinToggle from '@/components/ui/PinToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import { useDocumentSearch, TRIGRAM_FLOOR, type DocumentHit } from '@/hooks/useDocumentSearch';
import { CATEGORY_LABEL, isDocumentCategory } from '@/lib/vault-grouping';

const CARD_KEY = 'cs.sitesearch.card';

function hitName(h: DocumentHit): string {
  return h.source_filename || h.title || 'Untitled';
}

function shelfOf(h: DocumentHit): string | null {
  return isDocumentCategory(h.category) ? CATEGORY_LABEL[h.category] : null;
}

function filedOn(h: DocumentHit): string {
  if (!h.created_at) return '';
  const d = new Date(h.created_at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

export default function SiteSearch({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { cardRef, pinned, togglePin } = useDraggableResizable(CARD_KEY);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const cursor = useRef(-1);

  const { query, setQuery, hits, hasMore, page, nextPage, prevPage, searching, error, prefixOnly, clear } =
    useDocumentSearch();

  // The keyboard cursor is drawn straight onto the rows rather than held in
  // React state: it moves on every arrow key, and re-rendering a list of
  // twenty-five rows for a highlight is work nobody asked for.
  const paint = useCallback(() => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-hit]');
    rows?.forEach((el, i) => {
      const on = i === cursor.current;
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      el.classList.toggle('bg-[rgba(232,184,74,0.10)]', on);
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
  }, []);

  useEffect(() => { inputRef.current?.focus(); }, []);
  // A new set of results puts the cursor back at the top rather than leaving
  // it pointing at whatever row happens to be in that position now.
  useEffect(() => { cursor.current = -1; paint(); }, [hits, paint]);

  const open = (h: DocumentHit) => {
    onClose();
    navigate(`/app/document/${h.document_id}`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); if (query) clear(); else onClose(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cursor.current = Math.min(hits.length - 1, cursor.current + 1);
      paint(); return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      cursor.current = Math.max(-1, cursor.current - 1);
      paint(); return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const pick = hits[cursor.current] ?? hits[0];
      if (pick) open(pick);
    }
  };

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[70] bg-black/40 backdrop-blur-[1px] overflow-y-auto"
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div
          ref={cardRef}
          role="dialog"
          aria-label="Find a document"
          className="max-w-2xl mx-auto mt-24 mb-10 rounded-xl border border-[rgba(255,255,255,0.12)] backdrop-blur-[30px] cursor-grab select-none shadow-2xl"
          style={{ backgroundColor: 'rgba(10,10,16,0.97)' }}
        >
          {/* The ribbon: the visible thing you grab. */}
          <div className="flex items-center gap-2 px-3 h-9 border-b border-[rgba(255,255,255,0.08)] rounded-t-xl">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45">
              Find a document
            </span>
            <span className="flex-1" />
            <PinToggle pinned={pinned} onToggle={togglePin} />
            <button
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
              title="Close (Esc)"
              aria-label="Close"
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>

          <div className="px-4 pt-3 pb-1">
            <div className="relative">
              {searching
                ? <Loader2 size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#e8b84a] animate-spin" />
                : <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />}
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Document name, across every matter you can open…"
                aria-label="Document name"
                className="w-full pl-9 pr-9 py-2.5 rounded-lg border border-[rgba(232,184,74,0.25)] bg-[rgba(232,184,74,0.04)] text-[13px] text-white placeholder-white/35 focus:outline-none focus:ring-1 focus:ring-[#e8b84a]"
              />
              {query && (
                <button
                  onClick={() => { clear(); inputRef.current?.focus(); }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-white/40 hover:text-white"
                  aria-label="Clear"
                >
                  <X size={13} />
                </button>
              )}
            </div>

            {prefixOnly && (
              <p className="text-[11px] text-white/45 mt-2">
                Matching the START of a name until you have typed {TRIGRAM_FLOOR} letters.
              </p>
            )}
            {error && (
              <p className="flex items-start gap-2 text-[12px] text-red-400 mt-2">
                <AlertCircle size={13} className="mt-0.5 shrink-0" /> {error}
              </p>
            )}
          </div>

          <div ref={listRef} className="px-2 pb-2 max-h-[52vh] overflow-y-auto" role="listbox" aria-label="Documents">
            {!error && query.trim() && !searching && hits.length === 0 && (
              <p className="px-3 py-3 text-[12px] text-white/50">
                No document is named that. This searches names, not contents — for a phrase inside
                a document, use the search box inside the matter.
              </p>
            )}
            {hits.map((h) => (
              <button
                key={h.document_id}
                data-hit
                role="option"
                aria-selected="false"
                onClick={() => open(h)}
                className="w-full text-left px-3 py-2 rounded-lg hover:bg-[rgba(232,184,74,0.08)] transition-colors group"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <FileText size={12} className="text-[#e8b84a] shrink-0" />
                  <span className="text-[13px] text-white truncate group-hover:text-[#e8b84a] transition-colors">
                    {hitName(h)}
                  </span>
                  {h.sealed && (
                    <Lock size={11} className="text-[#5aa88f] shrink-0" aria-label="Sealed matter" />
                  )}
                </div>
                <div className="flex items-center gap-2 pl-[18px] text-[10px] text-white/45">
                  <span className="truncate">{h.matterspace_name ?? 'Unknown matter'}</span>
                  {shelfOf(h) && <><span className="text-white/20">·</span><span>{shelfOf(h)}</span></>}
                  {filedOn(h) && <><span className="text-white/20">·</span><span>{filedOn(h)}</span></>}
                </div>
              </button>
            ))}
          </div>

          {(page > 0 || hasMore) && (
            <div className="flex items-center gap-3 px-4 py-2 border-t border-[rgba(255,255,255,0.08)]">
              <button
                onClick={prevPage}
                disabled={page === 0}
                className="px-2.5 py-1 rounded text-[11px] border border-[rgba(255,255,255,0.15)] text-white/80 disabled:opacity-30 hover:border-[#e8b84a]/50 transition-colors"
              >
                Back
              </button>
              <button
                onClick={nextPage}
                disabled={!hasMore}
                className="px-2.5 py-1 rounded text-[11px] border border-[rgba(255,255,255,0.15)] text-white/80 disabled:opacity-30 hover:border-[#e8b84a]/50 transition-colors"
              >
                More
              </button>
              <span className="text-[10px] text-white/40">Page {page + 1}</span>
            </div>
          )}

          <div className="flex items-center gap-1.5 px-4 py-2 border-t border-[rgba(255,255,255,0.06)] text-[10px] text-white/35">
            <CornerDownLeft size={10} /> opens · ↑↓ moves · Esc closes · names only, not contents
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

/**
 * The mount point. One element, so the place it is mounted from carries one
 * line: the hotkey is registered here rather than in the host, because the
 * host (the sidebar) is COVERED by the Vault — which is the one screen where
 * finding a document matters most — and a button nobody can reach is not an
 * entry.
 */
export function SiteSearchMount({ collapsed = false }: { collapsed?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!(e.metaKey || e.ctrlKey) || (e.key !== 'k' && e.key !== 'K')) return;
      // Cmd/Ctrl+K belongs to the editor while somebody is typing in it —
      // TipTap uses it for a link, and a browser's own field may too.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      {/* Always rendered, even on a collapsed rail: the button shrinks to its
          icon, and the hotkey listener above must not be unmounted — a
          collapsed rail is exactly when a keyboard entry earns its keep. */}
      <button
        onClick={() => setOpen(true)}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] text-white hover:bg-[rgba(255,255,255,0.04)] transition-colors ${
          collapsed ? 'justify-center' : ''
        }`}
        title="Find a document by name (Ctrl/Cmd + K)"
        aria-label="Find a document"
      >
        <Search size={15} strokeWidth={1.75} className="shrink-0" />
        {!collapsed && (
          <>
            <span className="truncate">Find a document</span>
            <kbd className="ml-auto text-[9px] text-white/30 border border-white/10 rounded px-1 py-px">⌘K</kbd>
          </>
        )}
      </button>
      {open && <SiteSearch onClose={() => setOpen(false)} />}
    </>
  );
}

