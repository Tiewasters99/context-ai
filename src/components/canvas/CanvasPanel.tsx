// One pinned card on the canvas.
//
// The panel supplies the furniture — a ribbon you can grab anywhere along
// its width, resize handles on every edge and corner, a full-screen toggle,
// and the stacking order — and hands the interior to whichever view owns
// that kind of content. The ribbon IS the drag affordance: a wide strip,
// not a grip icon you have to hunt for. A panel behaves like a window:
// size it to half the screen, put a second one beside it, throw one to
// full screen and back — the windowed rect survives the round trip.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pin, Maximize2, Minimize2, ExternalLink, X } from 'lucide-react';
import { CANVAS_FULLSCREEN_Z, MIN_H, MIN_W, type CanvasCard } from '@/lib/canvas';

interface CanvasPanelProps {
  card: CanvasCard;
  /** Stacking order — higher draws in front. */
  zIndex: number;
  stacked: boolean;   // narrow screens: flow in the page instead of floating
  onFocus: () => void;
  onUnpin: () => void;
  onOpenFull: () => void;
  onToggleMax: () => void;
  onRect: (rect: { x: number; y: number; w: number; h: number }) => void;
  children: ReactNode;
}

interface Rect { x: number; y: number; w: number; h: number }

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

type Gesture =
  | { mode: 'move'; startX: number; startY: number; orig: Rect }
  | { mode: 'resize'; edge: Edge; startX: number; startY: number; orig: Rect };

// A panel's ribbon must stay reachable: its top edge never goes under the
// app header, and a panel dragged toward a side keeps a grabbable strip
// on screen.
const TOP_LIMIT = 48;

// The eight resize zones. Edges are slim strips along each side; corners
// are slightly larger squares that win over the edges they overlap because
// they render after them.
const EDGE_HANDLES: { edge: Edge; className: string }[] = [
  { edge: 'n',  className: 'top-0 left-3 right-3 h-1.5 cursor-ns-resize' },
  { edge: 's',  className: 'bottom-0 left-3 right-3 h-1.5 cursor-ns-resize' },
  { edge: 'w',  className: 'left-0 top-3 bottom-3 w-1.5 cursor-ew-resize' },
  { edge: 'e',  className: 'right-0 top-3 bottom-3 w-1.5 cursor-ew-resize' },
  { edge: 'nw', className: 'top-0 left-0 w-3 h-3 cursor-nwse-resize' },
  { edge: 'ne', className: 'top-0 right-0 w-3 h-3 cursor-nesw-resize' },
  { edge: 'sw', className: 'bottom-0 left-0 w-3 h-3 cursor-nesw-resize' },
  { edge: 'se', className: 'bottom-0 right-0 w-4 h-4 cursor-nwse-resize' },
];

export default function CanvasPanel({
  card,
  zIndex,
  stacked,
  onFocus,
  onUnpin,
  onOpenFull,
  onToggleMax,
  onRect,
  children,
}: CanvasPanelProps) {
  // Live rect during a drag. Committing on every pointermove would write to
  // localStorage sixty times a second; the gesture runs locally and the
  // committed rect lands once, on pointerup.
  const [live, setLive] = useState<Rect | null>(null);
  const gesture = useRef<Gesture | null>(null);
  // The committed rect is read from a ref, not from inside a state updater —
  // updaters must stay pure, and React calls them twice in development.
  const liveRef = useRef<Rect | null>(null);

  const rect = live ?? { x: card.x, y: card.y, w: card.w, h: card.h };

  const apply = useCallback((next: Rect) => {
    liveRef.current = next;
    setLive(next);
  }, []);

  const endGesture = useCallback(() => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const final = liveRef.current;
    liveRef.current = null;
    setLive(null);
    if (final) onRect(final);
  }, [onRect]);

  useEffect(() => {
    if (stacked) return;
    const onMove = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      e.preventDefault();
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      const o = g.orig;
      if (g.mode === 'move') {
        // Always leave a strip of the ribbon on screen — a panel dragged off
        // the edge has to stay grabbable.
        const maxX = window.innerWidth - 60;
        const maxY = window.innerHeight - 40;
        apply({
          ...o,
          x: Math.max(-(o.w - 80), Math.min(maxX, o.x + dx)),
          y: Math.max(TOP_LIMIT, Math.min(maxY, o.y + dy)),
        });
      } else {
        // Each grabbed edge follows the pointer; the opposite edge stays
        // anchored, so pulling the left side out doesn't shove the panel.
        let { x, y, w, h } = o;
        if (g.edge.includes('e')) w = Math.max(MIN_W, o.w + dx);
        if (g.edge.includes('w')) {
          const right = o.x + o.w;
          x = Math.min(o.x + dx, right - MIN_W);
          w = right - x;
        }
        if (g.edge.includes('s')) h = Math.max(MIN_H, o.h + dy);
        if (g.edge.includes('n')) {
          const bottom = o.y + o.h;
          y = Math.min(Math.max(TOP_LIMIT, o.y + dy), bottom - MIN_H);
          h = bottom - y;
        }
        apply({ x, y, w, h });
      }
    };
    const onUp = () => endGesture();
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
  }, [stacked, endGesture, apply]);

  const startMove = (e: React.PointerEvent) => {
    if (stacked || card.max) return;
    // Header buttons keep working — only bare ribbon starts a drag.
    if ((e.target as HTMLElement).closest('button')) return;
    onFocus();
    gesture.current = {
      mode: 'move',
      startX: e.clientX,
      startY: e.clientY,
      orig: { x: card.x, y: card.y, w: card.w, h: card.h },
    };
    apply(gesture.current.orig);
    e.preventDefault();
  };

  const startResize = (edge: Edge) => (e: React.PointerEvent) => {
    if (stacked || card.max) return;
    onFocus();
    gesture.current = {
      mode: 'resize',
      edge,
      startX: e.clientX,
      startY: e.clientY,
      orig: { x: card.x, y: card.y, w: card.w, h: card.h },
    };
    apply(gesture.current.orig);
    e.preventDefault();
    e.stopPropagation();
  };

  // Double-click on bare ribbon: the windowing gesture everyone knows.
  const onRibbonDoubleClick = (e: React.MouseEvent) => {
    if (stacked) return;
    if ((e.target as HTMLElement).closest('button')) return;
    onToggleMax();
  };

  const maximized = !stacked && !!card.max;

  const shell = `${maximized ? '' : 'rounded-xl'} border border-[rgba(255,255,255,0.12)] backdrop-blur-[30px] overflow-hidden flex flex-col shadow-[0_18px_50px_rgba(0,0,0,0.55)]`;

  const style: React.CSSProperties = stacked
    ? { backgroundColor: 'rgba(8,8,14,0.92)', maxHeight: '70vh' }
    : maximized
      ? {
          position: 'fixed',
          left: 0,
          top: 0,
          width: '100vw',
          height: '100vh',
          // Above every windowed panel and the route card, below modals.
          zIndex: CANVAS_FULLSCREEN_Z,
          backgroundColor: 'rgba(8,8,14,0.96)',
        }
      : {
          position: 'fixed',
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          zIndex,
          backgroundColor: 'rgba(8,8,14,0.92)',
        };

  return (
    <div
      className={`${shell} ${stacked ? 'mx-3 mb-4' : ''}`}
      style={style}
      onPointerDownCapture={stacked ? undefined : onFocus}
      data-canvas-panel={card.key}
    >
      {/* Ribbon — the whole strip is the drag handle. */}
      <div
        onPointerDown={startMove}
        onDoubleClick={onRibbonDoubleClick}
        className={`flex items-center gap-2 h-9 px-2.5 shrink-0 border-b border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.045)] ${
          stacked || maximized ? '' : 'cursor-grab active:cursor-grabbing select-none'
        }`}
        title={stacked || maximized ? undefined : 'Drag to move · double-click for full screen'}
      >
        <Pin size={12} className="text-[#e8b84a] shrink-0" strokeWidth={2} />
        <span className="text-[12px] text-[#f5f1e8] truncate flex-1 min-w-0">
          {card.title || 'Untitled'}
        </span>
        {!stacked && (
          <button
            onClick={onToggleMax}
            className="p-1 rounded hover:bg-[rgba(255,255,255,0.1)] text-white/55 hover:text-white transition-colors shrink-0"
            title={maximized ? 'Back to its place on the canvas' : 'Full screen'}
          >
            {maximized
              ? <Minimize2 size={12} strokeWidth={2} />
              : <Maximize2 size={12} strokeWidth={2} />}
          </button>
        )}
        <button
          onClick={onOpenFull}
          className="p-1 rounded hover:bg-[rgba(255,255,255,0.1)] text-white/55 hover:text-white transition-colors shrink-0"
          title="Open as a full page (leaves the canvas)"
        >
          <ExternalLink size={12} strokeWidth={2} />
        </button>
        {/* Close is an X, like every other card. The gold pin at the left of
            the ribbon is what says this card is pinned; a second pin icon
            here only made people wonder which one closed it. */}
        <button
          onClick={onUnpin}
          className="p-1 rounded hover:bg-[rgba(255,255,255,0.1)] text-white/55 hover:text-white transition-colors shrink-0"
          title="Close — take this card off the canvas"
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">{children}</div>

      {/* Resize handles on every edge and corner. They render after the
          content so they sit on top of it; the corners render after the
          edges so a corner grab wins where the zones overlap. */}
      {!stacked && !maximized && (
        <>
          {EDGE_HANDLES.map(({ edge, className }) => (
            <div
              key={edge}
              onPointerDown={startResize(edge)}
              className={`absolute ${className}`}
              title={edge === 'se' ? 'Drag to resize' : undefined}
            >
              {edge === 'se' && (
                <div className="absolute bottom-[3px] right-[3px] w-2 h-2 border-r-2 border-b-2 border-white/25 rounded-br-[2px]" />
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
