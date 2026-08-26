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
  loadGlobalCanvas,
  nextPlacement,
  sameSpace,
  saveCanvas,
  saveGlobalCanvas,
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
  // `cards` and the user they were loaded for move together in one state
  // value. Keeping hydration in a ref did not work: both effects run in the
  // same commit, so the load effect set the ref and the save effect then read
  // it alongside the PREVIOUS render's empty `cards` — and an empty save
  // deletes the key, which is what silently ate the pinned calendar.
  const [canvas, setCanvas] = useState<{ hydratedFor: string | null; cards: CanvasCard[] }>(
    { hydratedFor: null, cards: [] },
  );
  const cards = canvas.cards;

  // Every mutator edits the cards inside the single state value, so hydration
  // and cards can never drift apart.
  const editCards = useCallback(
    (fn: (prev: CanvasCard[]) => CanvasCard[]) =>
      setCanvas((prev) => {
        const next = fn(prev.cards);
        return next === prev.cards ? prev : { ...prev, cards: next };
      }),
    [],
  );

  // Which (user, space) the `cards` in state belong to. Without this, the
  // save effect would write the outgoing space's cards into the incoming
  // space's key on the render where `space` has changed but `cards` has not.
  const ownerRef = useRef<string | null>(null);

  const ownerId = userId && space ? `${userId}::${space.spaceType}:${space.spaceId}` : null;

  // Load when the user or the space changes. Global cards (the calendar) are
  // loaded whether or not a space is known, so pinning the calendar from the
  // dashboard — or anywhere with no matter in view — actually sticks.
  useEffect(() => {
    if (!userId) {
      ownerRef.current = null;
      setCanvas({ hydratedFor: null, cards: [] });
      return;
    }
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const globals = loadGlobalCanvas(userId).map((c) => clampToViewport(c, viewport));
    const scoped = space
      ? loadCanvas(userId, space).map((c) => clampToViewport(c, viewport))
      : [];
    ownerRef.current = ownerId;
    setCanvas({ hydratedFor: userId, cards: [...globals, ...scoped] });
  }, [userId, space, ownerId]);

  // Persist. Never write before the load has run for THIS user: on the first
  // commit after sign-in `cards` is still the initial empty array, and an
  // empty save deletes the key outright — which silently ate the pinned
  // calendar on every reload. The space bucket was already protected by the
  // ownerRef check; the global bucket had no equivalent and needed one.
  useEffect(() => {
    if (!userId) return;
    if (canvas.hydratedFor !== userId) return;   // same render as canvas.cards
    saveGlobalCanvas(userId, canvas.cards);
    if (!space) return;
    if (ownerRef.current !== ownerId) return;
    saveCanvas(userId, space, canvas.cards);
  }, [canvas, userId, space, ownerId]);

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
      editCards((prev) => {
        const key = cardKey(kind, id);
        if (prev.some((c) => c.key === key)) return prev;
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const rect = nextPlacement(kind, prev, viewport);
        return [...prev, { key, kind, id, title, ...rect }];
      });
    },
    [editCards],
  );

  const unpin = useCallback((key: string) => {
    editCards((prev) => prev.filter((c) => c.key !== key));
  }, [editCards]);

  const raise = useCallback((key: string) => {
    editCards((prev) => {
      const idx = prev.findIndex((c) => c.key === key);
      if (idx < 0 || idx === prev.length - 1) return prev;
      const next = prev.slice();
      const [card] = next.splice(idx, 1);
      next.push(card);
      return next;
    });
  }, [editCards]);

  // The windowed rect is left untouched, so leaving full screen puts the
  // panel back exactly where it was.
  const toggleMax = useCallback((key: string) => {
    editCards((prev) =>
      prev.map((c) => (c.key === key ? { ...c, max: !c.max } : c)),
    );
  }, [editCards]);

  const setRect = useCallback(
    (key: string, rect: { x: number; y: number; w: number; h: number }) => {
      editCards((prev) =>
        prev.map((c) => (c.key === key ? { ...c, ...rect } : c)),
      );
    },
    [editCards],
  );

  const setTitle = useCallback((key: string, title: string) => {
    editCards((prev) =>
      prev.map((c) => (c.key === key && c.title !== title ? { ...c, title } : c)),
    );
  }, [editCards]);

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
