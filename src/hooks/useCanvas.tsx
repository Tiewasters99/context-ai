// Canvas state: which cards are pinned in the space you are currently in,
// where they sit, and in what order they stack.
//
// The provider owns nothing about *rendering* — CanvasLayer does that. It
// owns the list, the persistence, and the rule that a card is pinned once
// (one panel per content item, never two).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from '@/contexts/AuthContext';
import {
  cardKey,
  clampToViewport,
  loadCanvas,
  nextPlacement,
  sameSpace,
  saveCanvas,
  type CanvasCard,
  type CanvasCardKind,
  type CanvasSpace,
} from '@/lib/canvas';

interface CanvasContextValue {
  /** The space whose canvas is on screen. Null until a space is known. */
  space: CanvasSpace | null;
  /** Pinned cards, back to front — the last entry draws on top. */
  cards: CanvasCard[];
  isPinned: (kind: CanvasCardKind, id: string | undefined) => boolean;
  pin: (card: { kind: CanvasCardKind; id: string; title: string }) => void;
  unpin: (key: string) => void;
  /** Bring a card to the front of the stack. */
  raise: (key: string) => void;
  /** Flip a card between full screen and its windowed rect. */
  toggleMax: (key: string) => void;
  setRect: (key: string, rect: { x: number; y: number; w: number; h: number }) => void;
  setTitle: (key: string, title: string) => void;
  /** Called by CanvasLayer as the route changes. */
  setSpace: (space: CanvasSpace | null) => void;
}

const CanvasContext = createContext<CanvasContextValue | undefined>(undefined);

export function CanvasProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [space, setSpaceState] = useState<CanvasSpace | null>(null);
  const [cards, setCards] = useState<CanvasCard[]>([]);

  // Which (user, space) the `cards` in state belong to. Without this, the
  // save effect would write the outgoing space's cards into the incoming
  // space's key on the render where `space` has changed but `cards` has not.
  const ownerRef = useRef<string | null>(null);

  const ownerId = userId && space ? `${userId}::${space.spaceType}:${space.spaceId}` : null;

  // Load when the user or the space changes.
  useEffect(() => {
    if (!userId || !space) {
      ownerRef.current = null;
      setCards([]);
      return;
    }
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const loaded = loadCanvas(userId, space).map((c) => clampToViewport(c, viewport));
    ownerRef.current = ownerId;
    setCards(loaded);
  }, [userId, space, ownerId]);

  // Persist — but only once the loaded set actually belongs to this space.
  useEffect(() => {
    if (!userId || !space) return;
    if (ownerRef.current !== ownerId) return;
    saveCanvas(userId, space, cards);
  }, [cards, userId, space, ownerId]);

  const setSpace = useCallback((next: CanvasSpace | null) => {
    // Routes that carry no space of their own (the dashboard, the Vault)
    // leave the current canvas alone rather than sweeping the desk. It only
    // swaps when you actually walk into a different space.
    setSpaceState((prev) => {
      if (next === null) return prev;
      return sameSpace(prev, next) ? prev : next;
    });
  }, []);

  const isPinned = useCallback(
    (kind: CanvasCardKind, id: string | undefined) =>
      !!id && cards.some((c) => c.key === cardKey(kind, id)),
    [cards],
  );

  const pin = useCallback(
    ({ kind, id, title }: { kind: CanvasCardKind; id: string; title: string }) => {
      setCards((prev) => {
        const key = cardKey(kind, id);
        if (prev.some((c) => c.key === key)) return prev;
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const rect = nextPlacement(kind, prev, viewport);
        return [...prev, { key, kind, id, title, ...rect }];
      });
    },
    [],
  );

  const unpin = useCallback((key: string) => {
    setCards((prev) => prev.filter((c) => c.key !== key));
  }, []);

  const raise = useCallback((key: string) => {
    setCards((prev) => {
      const idx = prev.findIndex((c) => c.key === key);
      if (idx < 0 || idx === prev.length - 1) return prev;
      const next = prev.slice();
      const [card] = next.splice(idx, 1);
      next.push(card);
      return next;
    });
  }, []);

  // The windowed rect is left untouched, so leaving full screen puts the
  // panel back exactly where it was.
  const toggleMax = useCallback((key: string) => {
    setCards((prev) =>
      prev.map((c) => (c.key === key ? { ...c, max: !c.max } : c)),
    );
  }, []);

  const setRect = useCallback(
    (key: string, rect: { x: number; y: number; w: number; h: number }) => {
      setCards((prev) =>
        prev.map((c) => (c.key === key ? { ...c, ...rect } : c)),
      );
    },
    [],
  );

  const setTitle = useCallback((key: string, title: string) => {
    setCards((prev) =>
      prev.map((c) => (c.key === key && c.title !== title ? { ...c, title } : c)),
    );
  }, []);

  const value = useMemo<CanvasContextValue>(
    () => ({ space, cards, isPinned, pin, unpin, raise, toggleMax, setRect, setTitle, setSpace }),
    [space, cards, isPinned, pin, unpin, raise, toggleMax, setRect, setTitle, setSpace],
  );

  return <CanvasContext.Provider value={value}>{children}</CanvasContext.Provider>;
}

export function useCanvas(): CanvasContextValue {
  const ctx = useContext(CanvasContext);
  if (!ctx) throw new Error('useCanvas must be used within a CanvasProvider');
  return ctx;
}

// Views live both on a route and inside a canvas panel. On a route they need
// the pin control; inside a panel they must not offer to pin themselves
// again. This returns null outside a provider so a view can be rendered in
// isolation (tests, Storybook) without exploding.
export function useOptionalCanvas(): CanvasContextValue | null {
  return useContext(CanvasContext) ?? null;
}
