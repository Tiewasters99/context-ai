import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsMobile } from './useIsMobile';

// A launcher is a small fixed control that opens something (the Orchestrator's
// round button in the corner of every screen). It is not a card: it has no
// edges to resize, no pin, no fullscreen. Two gestures only. A press that
// stays put is the click it always was; a press that moves more than a few
// pixels carries the button, and the click it would have ended in is dropped
// (Eden, 2026-11-06: "I'd like the little Orchestrator icon to be draggable").
// A double-click puts it back in its corner.
//
// The position is remembered per `storageKey` across reloads, as the cards'
// positions are, and is kept inside the window: a button left at the right
// edge of a wide screen must not be off the edge of a narrow one. With no
// saved position the button sits wherever its own classes put it, so the
// default corner (and the Vault's higher corner) stays the component's to
// choose. On a phone nothing is bound and nothing is restored, for the same
// reason the cards do not float there.
const DRAG_THRESHOLD = 6;
const EDGE_INSET = 8;

type Saved = { left: number; top: number };

export function useDraggableLauncher(storageKey: string) {
  const isMobile = useIsMobile();
  const ref = useRef<HTMLButtonElement>(null);
  const [placed, setPlaced] = useState<Saved | null>(null);
  // Set during a drag so the click that follows the pointerup is swallowed.
  const dragged = useRef(false);

  const read = useCallback((): Saved | null => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const v = JSON.parse(raw);
      return Number.isFinite(v?.left) && Number.isFinite(v?.top) ? { left: v.left, top: v.top } : null;
    } catch { return null; }
  }, [storageKey]);

  const write = useCallback((v: Saved | null) => {
    try {
      if (v) localStorage.setItem(storageKey, JSON.stringify(v));
      else localStorage.removeItem(storageKey);
    } catch {}
  }, [storageKey]);

  // Keep the whole button on screen.
  const clamp = useCallback((v: Saved, w: number, h: number): Saved => ({
    left: Math.min(Math.max(EDGE_INSET, v.left), Math.max(EDGE_INSET, window.innerWidth - w - EDGE_INSET)),
    top: Math.min(Math.max(EDGE_INSET, v.top), Math.max(EDGE_INSET, window.innerHeight - h - EDGE_INSET)),
  }), []);

  useEffect(() => {
    if (isMobile) { setPlaced(null); return; }
    const saved = read();
    if (!saved) { setPlaced(null); return; }
    const el = ref.current;
    const w = el?.offsetWidth ?? 48;
    const h = el?.offsetHeight ?? 48;
    setPlaced(clamp(saved, w, h));
    const onResize = () => {
      const s = read();
      if (s) setPlaced(clamp(s, ref.current?.offsetWidth ?? 48, ref.current?.offsetHeight ?? 48));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isMobile, read, clamp]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (isMobile || e.button !== 0) return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const origin = { left: rect.left, top: rect.top };
    const w = rect.width, h = rect.height;
    let moving = false;
    let last: Saved | null = null;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!moving) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        moving = true;
        dragged.current = true;
        el.style.cursor = 'grabbing';
        window.getSelection()?.removeAllRanges();
      }
      last = clamp({ left: origin.left + dx, top: origin.top + dy }, w, h);
      setPlaced(last);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      el.style.cursor = '';
      if (moving && last) write(last);
      // The click arrives in the same task as the pointerup; the flag must
      // outlive it and no more.
      setTimeout(() => { dragged.current = false; }, 0);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }, [isMobile, clamp, write]);

  // Wrap the launcher's own click: a drag is not a click.
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (dragged.current) { e.stopPropagation(); e.preventDefault(); }
  }, []);

  const reset = useCallback(() => {
    write(null);
    setPlaced(null);
  }, [write]);

  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    if (isMobile) return;
    e.preventDefault();
    reset();
  }, [isMobile, reset]);

  // With a saved position the corner classes are overridden by explicit
  // coordinates; `bottom`/`right` are cleared so they cannot fight `top`/`left`.
  const style: React.CSSProperties | undefined = placed
    ? { left: placed.left, top: placed.top, right: 'auto', bottom: 'auto' }
    : undefined;

  return { ref, style, placed: placed !== null, onPointerDown, onClickCapture, onDoubleClick, reset };
}
