// One pinned card on the canvas.
//
// The panel supplies the furniture — a ribbon you can grab anywhere along
// its width, a corner grip to resize, and the stacking order — and hands the
// interior to whichever view owns that kind of content. The ribbon IS the
// drag affordance: a wide strip, not a grip icon you have to hunt for.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pin, Maximize2 } from 'lucide-react';
import { MIN_H, MIN_W, type CanvasCard } from '@/lib/canvas';

interface CanvasPanelProps {
  card: CanvasCard;
  /** Stacking order — higher draws in front. */
  zIndex: number;
  stacked: boolean;   // narrow screens: flow in the page instead of floating
  onFocus: () => void;
  onUnpin: () => void;
  onOpenFull: () => void;
  onRect: (rect: { x: number; y: number; w: number; h: number }) => void;
  children: ReactNode;
}

type Gesture =
  | { mode: 'move'; startX: number; startY: number; origX: number; origY: number }
  | { mode: 'resize'; startX: number; startY: number; origW: number; origH: number };

export default function CanvasPanel({
  card,
  zIndex,
  stacked,
  onFocus,
  onUnpin,
  onOpenFull,
  onRect,
  children,
}: CanvasPanelProps) {
  // Live rect during a drag. Committing on every pointermove would write to
  // localStorage sixty times a second; the gesture runs locally and the
  // committed rect lands once, on pointerup.
  const [live, setLive] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  // The committed rect is read from a ref, not from inside a state updater —
  // updaters must stay pure, and React calls them twice in development.
  const liveRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const rect = live ?? { x: card.x, y: card.y, w: card.w, h: card.h };

  const apply = useCallback((next: { x: number; y: number; w: number; h: number }) => {
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
      const base = liveRef.current ?? { x: card.x, y: card.y, w: card.w, h: card.h };
      if (g.mode === 'move') {
        // Always leave a strip of the ribbon on screen — a panel dragged off
        // the edge has to stay grabbable.
        const maxX = window.innerWidth - 60;
        const maxY = window.innerHeight - 40;
        apply({
          ...base,
          x: Math.max(-(card.w - 80), Math.min(maxX, g.origX + e.clientX - g.startX)),
          y: Math.max(48, Math.min(maxY, g.origY + e.clientY - g.startY)),
        });
      } else {
        apply({
          ...base,
          w: Math.max(MIN_W, g.origW + e.clientX - g.startX),
          h: Math.max(MIN_H, g.origH + e.clientY - g.startY),
        });
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
  }, [stacked, card.x, card.y, card.w, card.h, endGesture, apply]);

  const startMove = (e: React.PointerEvent) => {
    if (stacked) return;
    // Header buttons keep working — only bare ribbon starts a drag.
    if ((e.target as HTMLElement).closest('button')) return;
    onFocus();
    gesture.current = {
      mode: 'move',
      startX: e.clientX,
      startY: e.clientY,
      origX: card.x,
      origY: card.y,
    };
    apply({ x: card.x, y: card.y, w: card.w, h: card.h });
    e.preventDefault();
  };

  const startResize = (e: React.PointerEvent) => {
    if (stacked) return;
    onFocus();
    gesture.current = {
      mode: 'resize',
      startX: e.clientX,
      startY: e.clientY,
      origW: card.w,
      origH: card.h,
    };
    apply({ x: card.x, y: card.y, w: card.w, h: card.h });
    e.preventDefault();
    e.stopPropagation();
  };

  const shell = 'rounded-xl border border-[rgba(255,255,255,0.12)] backdrop-blur-[30px] overflow-hidden flex flex-col shadow-[0_18px_50px_rgba(0,0,0,0.55)]';

  const style: React.CSSProperties = stacked
    ? { backgroundColor: 'rgba(8,8,14,0.92)', maxHeight: '70vh' }
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
        className={`flex items-center gap-2 h-9 px-2.5 shrink-0 border-b border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.045)] ${
          stacked ? '' : 'cursor-grab active:cursor-grabbing select-none'
        }`}
        title={stacked ? undefined : 'Drag to move'}
      >
        <Pin size={12} className="text-[#e8b84a] shrink-0" strokeWidth={2} />
        <span className="text-[12px] text-[#f5f1e8] truncate flex-1 min-w-0">
          {card.title || 'Untitled'}
        </span>
        <button
          onClick={onOpenFull}
          className="p-1 rounded hover:bg-[rgba(255,255,255,0.1)] text-white/55 hover:text-white transition-colors shrink-0"
          title="Open full size"
        >
          <Maximize2 size={12} strokeWidth={2} />
        </button>
        <button
          onClick={onUnpin}
          className="p-1 rounded hover:bg-[rgba(255,255,255,0.1)] text-[#e8b84a] hover:text-[#f5d178] transition-colors shrink-0"
          title="Unpin — take this card off the canvas"
        >
          <Pin size={12} strokeWidth={2} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">{children}</div>

      {!stacked && (
        <div
          onPointerDown={startResize}
          className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize"
          title="Drag to resize"
        >
          <div className="absolute bottom-[3px] right-[3px] w-2 h-2 border-r-2 border-b-2 border-white/25 rounded-br-[2px]" />
        </div>
      )}
    </div>
  );
}
