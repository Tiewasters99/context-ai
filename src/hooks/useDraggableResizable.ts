import { useRef, useEffect, useCallback, useState } from 'react';
import { useIsMobile } from './useIsMobile';

// `storageKey` opts the card into persistent layout state. With a key, the
// card remembers (across reloads) where the user last left it AND whether
// they right-clicked to pin it. Position survives even when unpinned —
// the pin flag just toggles whether drag is locked. Without a key, all
// state is in-memory only.
//
// On phones, dragging a card into place with a thumb is hostile, and a
// position saved on a wide desktop renders the card off-screen. So the
// whole drag/resize/restore machinery is disabled below the mobile
// breakpoint: the card sheds any inline positioning and flows in normal
// document order. Consumers can read the returned `isMobile` to hide the
// drag handle / pin / fullscreen affordances, which mean nothing here.
export function useDraggableResizable(storageKey?: string) {
  const isMobile = useIsMobile();
  const cardRef = useRef<HTMLDivElement>(null);
  const isFullscreen = useRef(false);
  const isPinned = useRef(false);
  const [pinned, setPinned] = useState(false);
  const savedPos = useRef<{ left: string; top: string; width: string; height: string } | null>(null);

  // Single localStorage record per card carrying both the last position
  // and the pinned flag. Writes merge into the existing record so unpin
  // doesn't lose position and a position update doesn't lose pin state.
  const readState = useCallback(() => {
    if (!storageKey) return null;
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? JSON.parse(raw) as {
        pinned?: boolean; left?: string; top?: string; width?: string; height?: string;
      } : null;
    } catch { return null; }
  }, [storageKey]);

  const writeState = useCallback((patch: {
    pinned?: boolean; left?: string; top?: string; width?: string; height?: string;
  }) => {
    if (!storageKey) return;
    try {
      const prev = readState() || {};
      const next = { ...prev, ...patch };
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {}
  }, [storageKey, readState]);

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
    // A fixed card leaves the document flow, so the page scrollbar can no
    // longer reach its content — cap it to the viewport and scroll inside.
    card.style.maxHeight = `calc(100vh - ${Math.max(rect.top, 0) + 12}px)`;
    card.style.overflowY = 'auto';
    card.style.cursor = 'default';
    isPinned.current = true;
    setPinned(true);
    writeState({
      pinned: true,
      left: card.style.left,
      top: card.style.top,
      width: card.style.width,
      height: card.style.height,
    });
  }, [writeState]);

  const unpin = useCallback(() => {
    const card = cardRef.current;
    if (!card || !isPinned.current) return;
    isPinned.current = false;
    setPinned(false);
    card.style.cursor = 'grab';
    // Keep position; just flip the pin flag so the card stays where the
    // user left it but becomes draggable again.
    writeState({ pinned: false });
  }, [writeState]);

  const togglePin = useCallback(() => {
    if (isPinned.current) unpin();
    else pin();
  }, [pin, unpin]);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    // Phone: cards don't float. Strip any inline positioning we (or a
    // prior desktop session restored from localStorage) applied so the
    // card returns to normal flow, and bind no drag/resize listeners.
    if (isMobile) {
      for (const prop of ['position', 'left', 'top', 'width', 'height', 'margin', 'zIndex', 'maxWidth', 'maxHeight', 'cursor', 'overflowY'] as const) {
        card.style[prop] = '';
      }
      return;
    }

    // Once a card is position:fixed it leaves the document flow, so the
    // page's own scrollbar can never reach content below the fold — a
    // dragged card with a long body (e.g. a matter's Pages tab) was simply
    // unscrollable. Every path that fixes a card must therefore cap its
    // height to the viewport and let it scroll internally.
    const capToViewport = () => {
      if (card.style.position !== 'fixed') return;
      const top = parseFloat(card.style.top) || 0;
      card.style.maxHeight = `calc(100vh - ${Math.max(top, 0) + 12}px)`;
      card.style.overflowY = 'auto';
    };

    // Restore last-known position from a prior session. Position is
    // applied even when the card was left unpinned so users come back to
    // exactly where they put it. The pinned flag adds the lock on top.
    const saved = readState();
    if (saved && (saved.left || saved.top)) {
      card.style.position = 'fixed';
      if (saved.left) card.style.left = saved.left;
      if (saved.top) card.style.top = saved.top;
      if (saved.width) card.style.width = saved.width;
      // A restored explicit height must scroll its overflow, or content
      // spills past the card edge (the bug: text escapes a shortened card).
      if (saved.height) card.style.height = saved.height;
      card.style.margin = '0';
      card.style.zIndex = '30';
      card.style.maxWidth = 'none';
      card.style.cursor = saved.pinned ? 'default' : 'grab';
      capToViewport();
      if (saved.pinned) {
        isPinned.current = true;
        setPinned(true);
      }
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
      capToViewport();
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
        // Pin the height and let content scroll within it, so resizing
        // (especially shrinking from the bottom/top) reflows rather than
        // letting items overflow outside the card.
        card.style.height = origH + 'px';
        card.style.overflowY = 'auto';
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
        capToViewport(); // the cap depends on top — keep it live while dragging
      } else if (isResizing) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (resizeEdge.includes('e')) card.style.width = Math.max(300, origW + dx) + 'px';
        if (resizeEdge.includes('w')) { card.style.width = Math.max(300, origW - dx) + 'px'; card.style.left = (origX + dx) + 'px'; }
        if (resizeEdge.includes('s')) card.style.height = Math.max(200, origH + dy) + 'px';
        if (resizeEdge.includes('n')) { card.style.height = Math.max(200, origH - dy) + 'px'; card.style.top = (origY + dy) + 'px'; }
        capToViewport();
      } else if (!isFullscreen.current && !isPinned.current) {
        const edge = getEdge(e);
        card.style.cursor = edge ? cursorMap[edge] : 'grab';
      }
    };

    const onUp = () => {
      // Persist the latest position whenever a drag or resize finishes,
      // so unpinned cards still remember where the user left them.
      if (isDragging || isResizing) {
        writeState({
          left: card.style.left,
          top: card.style.top,
          width: card.style.width,
          height: card.style.height,
        });
      }
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
  }, [storageKey, pin, unpin, readState, writeState, isMobile]);

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
      card.style.maxHeight = 'none';
      card.style.zIndex = '40';
      card.style.borderRadius = '0';
      card.style.cursor = 'default';
      card.style.overflowY = 'auto';
      isFullscreen.current = true;
    } else {
      const sp = savedPos.current;
      if (sp && (sp.left || sp.top)) {
        card.style.left = sp.left;
        card.style.top = sp.top;
        card.style.width = sp.width;
        card.style.height = sp.height;
        // Still fixed — re-cap to the viewport so a long body scrolls
        // inside the card instead of running unreachable past the fold.
        const top = parseFloat(sp.top) || 0;
        card.style.maxHeight = `calc(100vh - ${Math.max(top, 0) + 12}px)`;
        card.style.overflowY = 'auto';
      } else {
        // The card lived in normal document flow before fullscreen —
        // return it there. Leaving position:fixed here stranded the card
        // out of flow with no way to scroll its content.
        for (const prop of ['position', 'left', 'top', 'width', 'height', 'margin', 'zIndex', 'maxWidth', 'maxHeight', 'overflowY'] as const) {
          card.style[prop] = '';
        }
      }
      card.style.borderRadius = '';
      card.style.cursor = isPinned.current ? 'default' : 'grab';
      isFullscreen.current = false;
    }
  }, []);

  return { cardRef, toggleFullscreen, pinned, togglePin, isMobile };
}
