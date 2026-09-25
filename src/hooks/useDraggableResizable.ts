import { useRef, useEffect, useCallback, useState } from 'react';
import { useIsMobile } from './useIsMobile';

// Room left above and below a viewport-bound card: the app header plus the
// card's own vertical margin.
const TOP_INSET = 96;

// Stacking contract for cards (see also CANVAS_PANEL_Z in lib/canvas.ts):
//   route card ...................... 12   the card you are reading
//   canvas panels ................... 30+  the cards you pinned to stay on top
//   either one, taken full screen ... 60
//   modals / portals ................ 70   (ModalPortal, pickers)
// The route card sits BELOW pinned panels on purpose: pinning means "keep
// this in front while I work", so a panel must never hide behind the route.
const ROUTE_CARD_Z = 12;
const ROUTE_CARD_FULLSCREEN_Z = 60;

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
// `boundToViewport` is for cards that sit in the page's normal flow (the
// route cards: a list, a page, a matter). Without it a card taller than the
// window has no reachable bottom edge — you can scroll to the bottom of the
// content, but by then the card's header, with its close and pin controls,
// has scrolled off the top. There is no scroll position that shows both. The
// bound caps the card at the window height and lets its own content scroll
// inside, so the frame stays put: all four resize edges and the header are
// on screen at all times. An explicit height from a resize overrides it.
//
// Since 2026-09-25 the bound is ON BY DEFAULT for every card (Eden: "All
// cards throughout should be draggable, resizable along all four edges, and
// pinnable"). The Dashboard's welcome card was 1,309px tall with no bound, so
// its bottom edge sat below the window and could not be grabbed. A card that
// must grow past the window can still pass `{ boundToViewport: false }`.
export function useDraggableResizable(
  storageKey?: string,
  options?: { boundToViewport?: boolean },
) {
  const boundToViewport = options?.boundToViewport !== false;
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
    card.style.zIndex = String(ROUTE_CARD_Z);
    card.style.maxWidth = 'none';
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
      for (const prop of ['position', 'left', 'top', 'width', 'height', 'margin', 'zIndex', 'maxWidth', 'cursor', 'overflowY', 'maxHeight'] as const) {
        card.style[prop] = '';
      }
      return;
    }

    // Per-item storage keys mean this effect re-runs when the user navigates
    // from one list (or page, or table) straight to another: same mounted
    // component, same DOM node, new key. Shed the previous item's inline
    // geometry and flags first, so a card with no saved state of its own
    // opens at its natural default instead of inheriting its predecessor's
    // rect, pin, or fullscreen.
    for (const prop of ['position', 'left', 'top', 'width', 'height', 'margin', 'zIndex', 'maxWidth', 'cursor', 'overflowY', 'borderRadius', 'maxHeight'] as const) {
      card.style[prop] = '';
    }
    isFullscreen.current = false;
    savedPos.current = null;
    if (isPinned.current) {
      isPinned.current = false;
      setPinned(false);
    }

    // Keep the whole frame on screen (see the note on `boundToViewport`).
    // A saved explicit height means the user already chose a size, so the
    // restore below overrides this.
    if (boundToViewport) {
      card.style.maxHeight = `calc(100vh - ${TOP_INSET}px)`;
    }
    // The fixed inset above assumed the card starts just under the app
    // header. It does not when a cover sits above it (180px, plus margin),
    // so the bottom edge — and the two bottom corners — hung below the
    // window, out of reach of a resize (Eden, 2026-09-23, a matter's
    // Calendar tab). Measure where the card really starts, and measure again
    // whenever the page above it changes height (a cover arriving) or the
    // window does. A height the person chose by resizing is left alone.
    const fitToViewport = () => {
      if (!boundToViewport || card.style.height || isFullscreen.current) return;
      const top = Math.max(card.getBoundingClientRect().top, 0);
      card.style.maxHeight = `${Math.max(240, Math.floor(window.innerHeight - top - 16))}px`;
      // Scroll inside only when the content is actually taller than the
      // bound, so a short card — and any menu that pops out of it — is not
      // clipped by an overflow it never needed.
      card.style.overflowY = card.scrollHeight > card.clientHeight + 1 ? 'auto' : '';
    };
    const fitObserver = boundToViewport && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => fitToViewport())
      : null;
    if (fitObserver && card.parentElement) fitObserver.observe(card.parentElement);
    // Content usually arrives after the card mounts (the Dashboard's tiles,
    // a matter's lists). Watch the card's own children, and any added later,
    // so the scroll decision above is made against what is actually there.
    if (fitObserver) for (const child of Array.from(card.children)) fitObserver.observe(child);
    const childWatcher = fitObserver && typeof MutationObserver !== 'undefined'
      ? new MutationObserver((records) => {
          for (const r of records) r.addedNodes.forEach((n) => { if (n instanceof Element) fitObserver.observe(n); });
          fitToViewport();
        })
      : null;
    childWatcher?.observe(card, { childList: true });
    if (boundToViewport) window.addEventListener('resize', fitToViewport);

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
      if (saved.height) {
        card.style.height = saved.height;
        card.style.overflowY = 'auto';
        card.style.maxHeight = 'none';   // an explicit size outranks the viewport bound
      }
      card.style.margin = '0';
      card.style.zIndex = String(ROUTE_CARD_Z);
      card.style.maxWidth = 'none';
      card.style.cursor = saved.pinned ? 'default' : 'grab';
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
      card.style.zIndex = String(ROUTE_CARD_Z);
      card.style.maxWidth = 'none';
    };

    // `data-card-inert` marks a region with pointer gestures of its own (the
    // page grid's tiles drag, right-click and double-click): the card leaves
    // them alone, as it does a button. The listeners here are native and sit
    // on the card, so a React stopPropagation inside it would come too late.
    const isInteractive = (t: HTMLElement) =>
      t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
      t.closest('button') !== null || t.closest('a') !== null || t.closest('input') !== null ||
      t.closest('textarea') !== null || t.closest('select') !== null ||
      t.isContentEditable || t.closest('[contenteditable="true"]') !== null ||
      t.closest('[data-card-inert]') !== null;

    // `data-card-drag-through` marks a region that is nearly all buttons
    // (a calendar: every day is one). Left alone by the rule above, such a
    // card could be grabbed only by its thin top strip, and a right-click
    // anywhere on it could not pin it. Inside the region a press on a button
    // is still a click; a press that MOVES more than a few pixels becomes a
    // drag of the card (and the click it would have ended in is dropped);
    // a right-click pins. Form fields keep their own gestures.
    const inDragThrough = (t: HTMLElement) =>
      t.closest('[data-card-drag-through]') !== null &&
      t.closest('[data-card-inert]') === null &&
      !(t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
        t.closest('input, textarea, select') !== null || t.isContentEditable);
    const DRAG_THRESHOLD = 6;
    let pendingDrag = false;
    let swallowNextClickOnUp = false;
    const swallowNextClick = () => {
      const stop = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
      card.addEventListener('click', stop, { capture: true, once: true });
      // The click, when there is one, arrives in the same task as the
      // pointerup. If the pointer was released somewhere else there is no
      // click at all, and the trap must not wait for the next real one.
      setTimeout(() => card.removeEventListener('click', stop, { capture: true }), 0);
    };

    const onDown = (e: PointerEvent) => {
      if (isPinned.current) return; // pinned cards don't drag or resize
      if (isFullscreen.current) return;
      const t = e.target as HTMLElement;
      // The edge comes first. A card whose rows run the full width (a picker,
      // a member list, a track grid) is buttons wall to wall, and "resizable
      // along all four edges" meant nothing there if a press on a button
      // could never resize: its side edges could be grabbed only beside the
      // header and footer. So within the resize margin a press on a button,
      // link, label or drag-through region resizes the card, and the click it
      // would have ended in is dropped. Text fields keep their own gestures
      // (placing the caret, selecting), and so does a `data-card-inert`
      // region. Away from the edge nothing changes.
      const edgeFirst = e.button === 0 ? getEdge(e) : '';
      const isTextField =
        t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
        t.closest('input, textarea, select') !== null ||
        t.isContentEditable || t.closest('[contenteditable="true"]') !== null;
      const edgeWinsOverTarget =
        edgeFirst !== '' && !isTextField && t.closest('[data-card-inert]') === null;
      if (edgeWinsOverTarget && (t.tagName === 'SPAN' || isInteractive(t))) {
        swallowNextClickOnUp = true;
      } else if (t.tagName === 'SPAN' || isInteractive(t)) {
        if (e.button !== 0 || !inDragThrough(t)) return;
        // Maybe a click, maybe a drag: onMove decides. No preventDefault,
        // so the button still gets its click if the pointer stays put.
        startX = e.clientX;
        startY = e.clientY;
        const r = card.getBoundingClientRect();
        origX = r.left; origY = r.top; origW = r.width; origH = r.height;
        pendingDrag = true;
        return;
      }

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
        card.style.maxHeight = 'none';   // the user is choosing the height now
      } else {
        isDragging = true;
        makeFixed();
        card.style.cursor = 'grabbing';
      }
      e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      if (pendingDrag) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
        // It moved: this press was a drag of the card, not a click.
        pendingDrag = false;
        isDragging = true;
        makeFixed();
        card.style.cursor = 'grabbing';
        window.getSelection()?.removeAllRanges();
        swallowNextClickOnUp = true;
      }
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
      // A card dragged lower (or restored low) must not push its bottom edge
      // off the screen: re-measure the bound where it now sits.
      if (isDragging) fitToViewport();
      if (swallowNextClickOnUp) swallowNextClick();
      swallowNextClickOnUp = false;
      pendingDrag = false;
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
      if (isInteractive(t) && !inDragThrough(t)) return;
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

    fitToViewport();

    return () => {
      card.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      card.removeEventListener('contextmenu', onContextMenu);
      card.removeEventListener('dblclick', onDoubleClick);
      fitObserver?.disconnect();
      childWatcher?.disconnect();
      window.removeEventListener('resize', fitToViewport);
    };
  }, [storageKey, pin, unpin, readState, writeState, isMobile, boundToViewport]);

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
      card.style.zIndex = String(ROUTE_CARD_FULLSCREEN_Z);
      card.style.borderRadius = '0';
      card.style.cursor = 'default';
      card.style.overflowY = 'auto';
      isFullscreen.current = true;
    } else {
      if (savedPos.current) {
        card.style.left = savedPos.current.left;
        card.style.top = savedPos.current.top;
        card.style.width = savedPos.current.width;
        card.style.height = savedPos.current.height;
      }
      // Keep scrolling only if we're returning to an explicitly-sized card.
      card.style.overflowY = savedPos.current?.height ? 'auto' : '';
      card.style.borderRadius = '';
      card.style.cursor = isPinned.current ? 'default' : 'grab';
      isFullscreen.current = false;
    }
  }, []);

  return { cardRef, toggleFullscreen, pinned, togglePin, isMobile };
}
