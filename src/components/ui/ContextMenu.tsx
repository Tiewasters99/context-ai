// A small right-click menu: opened at the pointer, portalled to <body> so no
// scrolling panel clips it, kept on screen, closed by a click anywhere else,
// Escape, a scroll or a resize. Used by the Vault's Cut / Copy / Paste.

import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label: string;
  /** A short hint on the right ("Ctrl+X"), or a count. */
  hint?: string;
  onSelect: () => void;
  disabled?: boolean;
}

export interface ContextMenuState { x: number; y: number; items: ContextMenuItem[] }

export default function ContextMenu({ menu, onClose }: { menu: ContextMenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Kept on screen: measured once drawn, then nudged in from the edges and
  // shown — straight on the element, before the browser paints.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!menu || !el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4))}px`;
    el.style.visibility = 'visible';
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [menu, onClose]);

  if (!menu) return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[200] min-w-[180px] py-1 rounded-lg border border-white/12 bg-[#16161d] shadow-2xl text-[12.5px]"
      style={{ left: menu.x, top: menu.y, visibility: 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          disabled={it.disabled}
          onClick={() => { onClose(); it.onSelect(); }}
          className="w-full text-left px-3 py-1.5 flex items-center gap-4 text-white/85 hover:bg-[#e8b84a]/15 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <span className="flex-1">{it.label}</span>
          {it.hint && <span className="text-[11px] text-white/40">{it.hint}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
