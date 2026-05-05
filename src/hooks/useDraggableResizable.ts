import { useRef, useEffect, useCallback, useState } from 'react';

// `storageKey` opts the card into persistent pin state. With a key, the card
// remembers (across reloads) whether the user right-clicked to pin it and
// where it was pinned. Without a key, pin still works but is in-memory only.
export function useDraggableResizable(storageKey?: string) {
  const cardRef = useRef<HTMLDivElement>(null);
  const isFullscreen = useRef(false);
  const isPinned = useRef(false);
  const [pinned, setPinned] = useState(false);
  const savedPos = useRef<{ left: string; top: string; width: string; height: string } | null>(null);

  const writePinState = useCallback((card: HTMLDivElement) => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        pinned: true,
        left: card.style.left,
        top: card.style.top,
        width: card.style.width,
        height: card.style.height,
      }));
    } catch {}
  }, [storageKey]);

  const clearPinState = useCallback(() => {
    if (!storageKey) return;
    try { localStorage.removeItem(storageKey); } catch {}
  }, [storageKey]);

  // pin/unpin act on the live DOM as well as the persisted state. They're
  // safe to call from anywhere — the contextmenu handler, dblclick handler,
  // and the PinToggle button all funnel through here.
  const pin = useCallback(() => {
    const card = cardRef.current;
    if (!card || isPinned.current || isFullscreen.current) return;
    const rect = card.getBoundingClientRect();
    card.style.position = 'fixed';
    card.style.left = rect.left + 'px';
    card.style.top = rect.top + 'px';
    card.style.width = rect.width + 'px';
    card.style.margin = '0';
    card.style.zIndex = '30';
    card.style.maxWidth = 'none';
    card.style.cursor = 'default';
    isPinned.current = true;
    setPinned(true);
    writePinState(card);
  }, [writePinState]);

  const unpin = useCallback(() => {
    const card = cardRef.current;
    if (!card || !isPinned.current) return;
    isPinned.current = false;
    setPinned(false);
    card.style.cursor = 'grab';
    clearPinState();
  }, [clearPinState]);

  const togglePin = useCallback(() => {
    if (isPinned.current) unpin();
    else pin();
  }, [pin, unpin]);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    // Restore pinned position from a prior session.
    if (storageKey) {
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          const saved = JSON.parse(raw);
          if (saved && saved.pinned && saved.left && saved.top) {
            card.style.position = 'fixed';
            card.style.left = saved.left;
            card.style.top = saved.top;
            if (saved.width) card.style.width = saved.width;
            if (saved.height) card.style.height = saved.height;
            card.style.margin = '0';
            card.style.zIndex = '30';
            card.style.maxWidth = 'none';
            card.style.cursor = 'default';
            isPinned.current = true;
            setPinned(true);
          }
        }
      } catch {}
    }

    let isDragging = false;
    let isResizing = false;
    let startX = 0, startY = 0, origX = 0, origY = 0, origW = 0, origH = 0;
    let resizeEdge = '';

    const getEdge = (e: PointerEvent) => {
      const rect = card.getBoundingClientRect();
      const margin = 8;
      const right = e.clientX > rect.right - margin;
      const bottom = e.clientY > rect.bottom - margin;
      const left = e.clientX < rect.left + margin;
      const top = e.clientY < rect.top + margin;
      if (right && bottom) return 'se';
      if (left && bottom) return 'sw';
      if (right && top) return 'ne';
      if (left && top) return 'nw';
      if (right) return 'e';
      if (bottom) return 's';
      if (left) return 'w';
      if (top) return 'n';
      return '';
    };

    const cursorMap: Record<string, string> = {
      'n': 'ns-resize', 's': 'ns-resize', 'e': 'ew-resize', 'w': 'ew-resize',
      'ne': 'nesw-resize', 'sw': 'nesw-resize', 'nw': 'nwse-resize', 'se': 'nwse-resize',
    };

    const makeFixed = () => {
      if (card.style.position === 'fixed') return;
      const rect = card.getBoundingClientRect();
      card.style.position = 'fixed';
      card.style.left = rect.left + 'px';
      card.style.top = rect.top + 'px';
      card.style.width = rect.width + 'px';
      card.style.margin = '0';
      card.style.zIndex = '30';
      card.style.maxWidth = 'none';
    };

    const isInteractive = (t: HTMLElement) =>
      t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
      t.closest('button') !== null || t.closest('a') !== null || t.closest('input') !== null ||
      t.closest('textarea') !== null || t.closest('select') !== null ||
      t.isContentEditable || t.closest('[contenteditable="true"]') !== null;

    const onDown = (e: PointerEvent) => {
      if (isPinned.current) return; // pinned cards don't drag or resize
      if (isFullscreen.current) return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'SPAN' || isInteractive(t)) return;

      const edge = getEdge(e);
      startX = e.clientX;
      startY = e.clientY;
      const rect = card.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      origW = rect.width;
      origH = rect.height;

      if (edge) {
        isResizing = true;
        resizeEdge = edge;
        makeFixed();
        card.style.height = origH + 'px';
      } else {
        isDragging = true;
        makeFixed();
        card.style.cursor = 'grabbing';
      }
      e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      if (isDragging) {
        card.style.left = (origX + e.clientX - startX) + 'px';
        card.style.top = (origY + e.clientY - startY) + 'px';
      } else if (isResizing) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (resizeEdge.includes('e')) card.style.width = Math.max(300, origW + dx) + 'px';
        if (resizeEdge.includes('w')) { card.style.width = Math.max(300, origW - dx) + 'px'; card.style.left = (origX + dx) + 'px'; }
        if (resizeEdge.includes('s')) card.style.height = Math.max(200, origH + dy) + 'px';
        if (resizeEdge.includes('n')) { card.style.height = Math.max(200, origH - dy) + 'px'; card.style.top = (origY + dy) + 'px'; }
      } else if (!isFullscreen.current && !isPinned.current) {
        const edge = getEdge(e);
        card.style.cursor = edge ? cursorMap[edge] : 'grab';
      }
    };

    const onUp = () => {
      isDragging = false;
      isResizing = false;
      if (!isFullscreen.current && !isPinned.current) card.style.cursor = 'grab';
    };

    // Right-click pins at current position. Skip when the click is on an
    // interactive element so users can still get the browser context menu
    // on links/buttons if they need it.
    const onContextMenu = (e: MouseEvent) => {
      if (isFullscreen.current) return;
      const t = e.target as HTMLElement;
      if (isInteractive(t)) return;
      e.preventDefault();
      if (isPinned.current) unpin();
      else pin();
    };

    // Double-click unpins. Same interactive-element guard so double-clicks
    // on buttons or text fields don't accidentally release the card.
    const onDoubleClick = (e: MouseEvent) => {
      if (!isPinned.current) return;
      const t = e.target as HTMLElement;
      if (isInteractive(t)) return;
      unpin();
    };

    card.addEventListener('pointerdown', onDown);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    card.addEventListener('contextmenu', onContextMenu);
    card.addEventListener('dblclick', onDoubleClick);

    return () => {
      card.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      card.removeEventListener('contextmenu', onContextMenu);
      card.removeEventListener('dblclick', onDoubleClick);
    };
  }, [storageKey, pin, unpin]);

  const toggleFullscreen = useCallback(() => {
    const card = cardRef.current;
    if (!card) return;

    if (!isFullscreen.current) {
      savedPos.current = {
        left: card.style.left,
        top: card.style.top,
        width: card.style.width,
        height: card.style.height,
      };
      card.style.position = 'fixed';
      card.style.left = '0';
      card.style.top = '0';
      card.style.width = '100vw';
      card.style.height = '100vh';
      card.style.margin = '0';
      card.style.maxWidth = 'none';
      card.style.zIndex = '40';
      card.style.borderRadius = '0';
      card.style.cursor = 'default';
      isFullscreen.current = true;
    } else {
      if (savedPos.current) {
        card.style.left = savedPos.current.left;
        card.style.top = savedPos.current.top;
        card.style.width = savedPos.current.width;
        card.style.height = savedPos.current.height;
      }
      card.style.borderRadius = '';
      card.style.cursor = isPinned.current ? 'default' : 'grab';
      isFullscreen.current = false;
    }
  }, []);

  return { cardRef, toggleFullscreen, pinned, togglePin };
}
