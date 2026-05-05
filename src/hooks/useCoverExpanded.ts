import { useEffect, useState } from 'react';

// Per-item persistence for the cover image's "full-page background" toggle.
// Key the storage by item id so each page/list/table remembers its own
// choice independently. Pass `undefined` while the item is loading; the
// hook will hold off persistence until a real id arrives.
export function useCoverExpanded(itemId: string | undefined) {
  const storageKey = itemId ? `cs.cover.expanded.${itemId}` : null;
  const [expanded, setExpandedRaw] = useState<boolean>(false);

  // Hydrate whenever the id changes (covers tab switches and navigation
  // between items inside the same view).
  useEffect(() => {
    if (!storageKey) { setExpandedRaw(false); return; }
    try { setExpandedRaw(localStorage.getItem(storageKey) === '1'); } catch {}
  }, [storageKey]);

  const setExpanded = (next: boolean) => {
    setExpandedRaw(next);
    if (!storageKey) return;
    try {
      if (next) localStorage.setItem(storageKey, '1');
      else localStorage.removeItem(storageKey);
    } catch {}
  };

  return [expanded, setExpanded] as const;
}
