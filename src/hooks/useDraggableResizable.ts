import { useRef, useEffect, useCallback } from 'react';

export function useDraggableResizable() {
  const cardRef = useRef<HTMLDivElement>(null);
  const isFullscreen = useRef(false);
  const savedPos = useRef<{ left: string; top: string; width: string; height: string } | null>(null);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;

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

    const onDown = (e: PointerEvent) => {
      if (isFullscreen.current) return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'INPUT' || t.tagName === 'SPAN' ||
          t.closest('button') || t.closest('a') || t.closest('input')) return;

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
      } else if (!isFullscreen.current) {
        const edge = getEdge(e);
        card.style.cursor = edge ? cursorMap[edge] : 'grab';
      }
    };

    const onUp = () => {
      isDragging = false;
      isResizing = false;
      if (!isFullscreen.current) card.style.cursor = 'grab';
    };

    card.addEventListener('pointerdown', onDown);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);

    return () => {
      card.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
  }, []);

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
      card.style.cursor = 'grab';
      isFullscreen.current = false;
    }
  }, []);

  return { cardRef, toggleFullscreen };
}
