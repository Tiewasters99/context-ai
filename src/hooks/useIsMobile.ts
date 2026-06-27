import { useState, useEffect } from 'react';

// Single source of truth for "are we on a phone-sized screen?". 768px is
// Tailwind's `md` breakpoint — below it the app switches to its mobile shell:
// the sidebar becomes an off-canvas drawer, content goes full-bleed, and
// draggable/resizable cards stop floating and flow in document order instead.
//
// Backed by matchMedia so it updates live on rotate/resize without a manual
// window-resize listener, and reads the correct value on first paint (no
// desktop-layout flash before hydration).
export function useIsMobile(breakpoint = 768): boolean {
  const query = `(max-width: ${breakpoint - 1}px)`;
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return isMobile;
}
