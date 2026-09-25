// Every dialog is a card.
//
// Eden's standing rule (2026-09-25): "All cards throughout should be
// draggable, resizable along all four edges, and pinnable." A dialog is a
// card that happens to arrive over a dimmed page, so it gets the same frame
// as every other card: the house hook (useDraggableResizable) for drag,
// four-edge resize and Pin, and a VISIBLE ribbon header — the grab pill, the
// title, Pin, fullscreen and close — so the drag affordance can be seen
// rather than guessed.
//
// This is the one shell. A dialog supplies its title, a stable storage key
// (`cs.dialog.<name>`, so its position and pin come back next time) and its
// body; it no longer builds its own overlay.
//
// Behaviour every dialog keeps, whatever its body:
//
//   * ESCAPE CLOSES — only the topmost open dialog, and not while `busy`
//     (a save or a delete in flight is not something to walk away from
//     mid-write). A field that handles Escape itself calls preventDefault
//     and is left alone.
//   * THE BACKDROP CLOSES ONLY WHEN THE DIALOG SAYS SO (`closeOnBackdrop`).
//     A dialog holding a half-typed form passes `closeOnBackdrop={!dirty}`:
//     an untouched one still dismisses with a click outside, a typed one
//     never loses its words to a stray click. The close is decided on the
//     press, not the click: a drag that starts on the card and is released
//     over the backdrop fires `click` on the backdrop (their common
//     ancestor), and that must never close the card that was just moved.
//   * FOCUS LANDS IN THE FIRST FIELD, unless the dialog already put it
//     somewhere (children's effects run first).
//   * RESIZING SCROLLS THE BODY, never the frame: the ribbon and the footer
//     stay put. Minimum 300x200 (the hook's floor).
//   * ON A PHONE the hook turns drag off and sheds its inline geometry; the
//     card is full width inside a 12px gutter, capped at the window height.
//
// Not a card: ModalPortal stays a bare portal, because anchored menus and
// popovers (the reader's More menu, a list's date picker) portal through it
// too, and those must not become draggable frames.

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { X } from 'lucide-react';
import ModalPortal from '@/components/ui/ModalPortal';
import PinToggle from '@/components/ui/PinToggle';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';

// The open dialogs, oldest first. Escape belongs to the last one only, so a
// confirmation opened over a picker closes itself and not both.
const openStack: symbol[] = [];

const FIRST_FIELD =
  'input:not([type=hidden]):not([type=file]):not([disabled]), textarea:not([disabled]), select:not([disabled])';

export interface CardDialogProps {
  /** Per-dialog localStorage key for position + pin, e.g. 'cs.dialog.newMatter'. */
  storageKey: string;
  title: ReactNode;
  /** Plain-text name for screen readers when `title` is not a string. */
  label?: string;
  subtitle?: ReactNode;
  icon?: ReactNode;
  /** Extra controls in the ribbon, before Pin / fullscreen / close. */
  actions?: ReactNode;
  onClose: () => void;
  /** Close on a press on the dimmed page. Default false. */
  closeOnBackdrop?: boolean;
  /** Escape closes (the topmost dialog). Default true. */
  closeOnEscape?: boolean;
  /** While true, Escape, the backdrop and the ribbon's X do nothing. */
  busy?: boolean;
  /** Stacking level of the whole overlay (keeps each dialog's old layer). */
  z?: number;
  /** Card width cap in px (the card is otherwise full width). */
  maxWidth?: number;
  /** A fixed height (CSS), for dialogs that are a work surface, not a form. */
  height?: string;
  /** Body classes. Default: padded, scrolling. */
  bodyClassName?: string;
  /** Sticky footer (buttons) — stays visible while the body scrolls. */
  footer?: ReactNode;
  footerClassName?: string;
  /** Focus the first field on open when nothing inside has focus. Default true. */
  autoFocus?: boolean;
  /** Card surface colour. */
  surface?: string;
  children: ReactNode;
}

export default function CardDialog({
  storageKey,
  title,
  label,
  subtitle,
  icon,
  actions,
  onClose,
  closeOnBackdrop = false,
  closeOnEscape = true,
  busy = false,
  z = 60,
  maxWidth = 440,
  height,
  bodyClassName = 'px-5 py-4',
  footer,
  footerClassName = 'px-5 py-3 flex items-center justify-end gap-2',
  autoFocus = true,
  surface = 'rgba(12,12,18,0.98)',
  children,
}: CardDialogProps) {
  const { cardRef, toggleFullscreen, pinned, togglePin, isMobile } = useDraggableResizable(storageKey);

  // Latest values for the listeners below, without re-binding them.
  const live = useRef({ onClose, busy, closeOnEscape, closeOnBackdrop });
  useEffect(() => {
    live.current = { onClose, busy, closeOnEscape, closeOnBackdrop };
  });

  useEffect(() => {
    const me = Symbol('card-dialog');
    openStack.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (openStack[openStack.length - 1] !== me) return;
      const { busy: b, closeOnEscape: esc, onClose: close } = live.current;
      if (!esc || b) return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = openStack.indexOf(me);
      if (i >= 0) openStack.splice(i, 1);
    };
  }, []);

  // First field, unless the dialog already placed the cursor itself. A frame
  // late, so a field that appears once the dialog's first render settles
  // is still there to be found.
  useEffect(() => {
    if (!autoFocus) return;
    const id = requestAnimationFrame(() => {
      const card = cardRef.current;
      if (!card || card.contains(document.activeElement)) return;
      (card.querySelector(FIRST_FIELD) as HTMLElement | null)?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [autoFocus, cardRef]);

  // Backdrop: decided on the press (see the header note on drags).
  const pressedBackdrop = useRef(false);

  const requestClose = () => { if (!busy) onClose(); };

  // The width cap rides in a custom property, not in `max-width`: the hook
  // owns the card's inline geometry (it clears max-width on mount and sets it
  // to none once the card floats), so an inline cap would be wiped and every
  // dialog would open the full width of the window.
  const cardStyle = { backgroundColor: surface, '--card-max-w': `${maxWidth}px` } as CSSProperties;
  if (height) (cardStyle as Record<string, string>)['--card-h'] = height;

  return (
    <ModalPortal>
      <div
        data-card-dialog-backdrop=""
        className="fixed inset-0 flex items-center justify-center bg-black/55 p-3"
        style={{ zIndex: z }}
        onPointerDown={(e) => { pressedBackdrop.current = e.target === e.currentTarget; }}
        onMouseDown={(e) => { pressedBackdrop.current = e.target === e.currentTarget; }}
        onClick={(e) => {
          const pressed = pressedBackdrop.current;
          pressedBackdrop.current = false;
          if (e.target !== e.currentTarget || !pressed) return;
          if (live.current.closeOnBackdrop) requestClose();
        }}
      >
        <div
          ref={cardRef}
          role="dialog"
          aria-modal="true"
          aria-label={label ?? (typeof title === 'string' ? title : undefined)}
          data-card-dialog={storageKey}
          className={`w-full max-w-[var(--card-max-w)] max-h-[calc(100vh-24px)] ${height ? 'h-[var(--card-h)]' : ''} rounded-xl border border-[rgba(255,255,255,0.12)] shadow-2xl overflow-hidden flex flex-col`}
          style={cardStyle}
        >
          {/* Ribbon header — the drag handle. */}
          <div
            data-card-ribbon=""
            className={`shrink-0 border-b border-[rgba(255,255,255,0.08)] px-4 pt-1.5 pb-2.5 ${isMobile ? '' : 'cursor-grab'}`}
          >
            {!isMobile && (
              <div className="flex justify-center mb-1.5">
                <div className="w-12 h-1 rounded-full bg-white/25 hover:bg-white/45 transition-colors" title="Drag to move" />
              </div>
            )}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 pt-0.5">
                <h3 className="text-[15px] font-semibold text-white flex items-center gap-2 leading-snug">
                  {icon}
                  <span className="min-w-0">{title}</span>
                </h3>
                {subtitle && <div className="text-[11.5px] text-white/50 mt-0.5 leading-relaxed">{subtitle}</div>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {actions}
                {!isMobile && <PinToggle pinned={pinned} onToggle={togglePin} />}
                {!isMobile && <FullscreenToggle onToggle={toggleFullscreen} />}
                <button
                  onClick={requestClose}
                  disabled={busy}
                  className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors disabled:opacity-40"
                  title="Close (Esc)"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
          </div>

          <div data-card-body="" className={`flex-1 min-h-0 overflow-y-auto ${bodyClassName}`}>{children}</div>

          {footer && (
            <div className={`shrink-0 border-t border-[rgba(255,255,255,0.08)] ${footerClassName}`}>
              {footer}
            </div>
          )}
        </div>
      </div>
    </ModalPortal>
  );
}
