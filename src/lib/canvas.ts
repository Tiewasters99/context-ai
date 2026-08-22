// The canvas: the set of cards a user has pinned so they stay on screen
// while other cards open and close.
//
// Contextspaces cards are routes — /app/list/:id, /app/page/:id, and so on —
// so opening one unmounts the last. That is right for the card you are
// *working* in and wrong for the ones you are *referring* to: pull up the
// Creative list to check it against Business Development and Business
// Development vanishes. Pinning moves a card off the route and onto the
// canvas, where it survives navigation.
//
// v1 keeps the layout in localStorage rather than the database: it is
// per-browser desk furniture, not matter content, and it needs no migration
// or RLS policy to ship. The key is scoped to the user and the space, so two
// people on one machine never inherit each other's desk and one matter's
// pinned cards never surface inside another.

import type { SpaceType } from '@/hooks/useContentItems';

export type CanvasCardKind = 'list' | 'page' | 'table' | 'document';

export interface CanvasSpace {
  spaceId: string;
  spaceType: SpaceType;
}

export interface CanvasCard {
  key: string;   // `${kind}:${id}` — one panel per content item, never two
  kind: CanvasCardKind;
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

// Every view that can appear both on its route and inside a canvas panel
// takes these. Absent them a view behaves exactly as it always has, so the
// route path is unchanged.
export interface EmbeddableViewProps {
  /** Supplied by the canvas; otherwise the view reads :id from the route. */
  id?: string;
  /** Inside a panel: no cover image, no route-card chrome — the panel owns those. */
  embedded?: boolean;
  /** Panel close. Ignored on a route, where Back does the job. */
  onClose?: () => void;
}

export const CANVAS_KINDS: readonly CanvasCardKind[] = ['list', 'page', 'table', 'document'];

export function isCanvasKind(v: unknown): v is CanvasCardKind {
  return typeof v === 'string' && (CANVAS_KINDS as readonly string[]).includes(v);
}

export function cardKey(kind: CanvasCardKind, id: string): string {
  return `${kind}:${id}`;
}

export function sameSpace(a: CanvasSpace | null, b: CanvasSpace | null): boolean {
  if (!a || !b) return a === b;
  return a.spaceId === b.spaceId && a.spaceType === b.spaceType;
}

const VERSION = 'v1';

export function canvasStorageKey(userId: string, space: CanvasSpace): string {
  return `cs.canvas.${VERSION}:${userId}:${space.spaceType}:${space.spaceId}`;
}

// Panels open at a size that suits what they hold: a checklist is narrow,
// a transcript needs room to read.
const DEFAULT_SIZE: Record<CanvasCardKind, { w: number; h: number }> = {
  list:     { w: 400, h: 460 },
  page:     { w: 520, h: 520 },
  table:    { w: 560, h: 440 },
  document: { w: 620, h: 660 },
};

export const MIN_W = 280;
export const MIN_H = 180;

export function defaultSize(kind: CanvasCardKind): { w: number; h: number } {
  return DEFAULT_SIZE[kind];
}

// Where a newly pinned card lands. Route cards are centred and wide, so the
// canvas fills in from the right edge first — on a laptop that is genuine
// side-by-side rather than a card dropped on top of the one you are reading.
// Each further card steps left and down so nothing ever fully covers what is
// already pinned; past the left edge the cascade wraps back to the right.
export function nextPlacement(
  kind: CanvasCardKind,
  existing: CanvasCard[],
  viewport: { width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  const { w, h } = defaultSize(kind);
  const width = Math.min(w, Math.max(MIN_W, viewport.width - 32));
  const height = Math.min(h, Math.max(MIN_H, viewport.height - 120));

  const STEP = 30;
  const TOP = 76;
  const RIGHT_MARGIN = 20;
  const LEFT_LIMIT = 16;

  const n = existing.length;
  const perColumn = Math.max(1, Math.floor((viewport.height - TOP - height - 24) / STEP) + 1);
  const step = n % perColumn;
  const wrap = Math.floor(n / perColumn);

  let x = viewport.width - width - RIGHT_MARGIN - step * STEP - wrap * (STEP * 2);
  let y = TOP + step * STEP;

  // Wrapped past the left edge — start the cascade over at the right.
  if (x < LEFT_LIMIT) {
    x = viewport.width - width - RIGHT_MARGIN - step * STEP;
    if (x < LEFT_LIMIT) x = LEFT_LIMIT;
  }
  y = Math.min(y, Math.max(TOP, viewport.height - height - 24));

  return { x: Math.round(x), y: Math.round(y), w: width, h: height };
}

// Keep a restored card reachable: a layout saved on a wide external monitor
// must not put its only drag handle off the left of a laptop screen.
export function clampToViewport(
  card: CanvasCard,
  viewport: { width: number; height: number },
): CanvasCard {
  const w = Math.max(MIN_W, Math.min(card.w, viewport.width - 16));
  const h = Math.max(MIN_H, Math.min(card.h, viewport.height - 40));
  const x = Math.max(8, Math.min(card.x, viewport.width - 80));
  const y = Math.max(56, Math.min(card.y, viewport.height - 60));
  if (w === card.w && h === card.h && x === card.x && y === card.y) return card;
  return { ...card, w, h, x, y };
}

function isCard(v: unknown): v is CanvasCard {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    isCanvasKind(o.kind) &&
    typeof o.x === 'number' && Number.isFinite(o.x) &&
    typeof o.y === 'number' && Number.isFinite(o.y) &&
    typeof o.w === 'number' && Number.isFinite(o.w) &&
    typeof o.h === 'number' && Number.isFinite(o.h)
  );
}

export function loadCanvas(userId: string, space: CanvasSpace): CanvasCard[] {
  try {
    const raw = localStorage.getItem(canvasStorageKey(userId, space));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { cards?: unknown })?.cards;
    if (!Array.isArray(list)) return [];
    const seen = new Set<string>();
    const out: CanvasCard[] = [];
    for (const v of list) {
      if (!isCard(v)) continue;
      const key = cardKey(v.kind, v.id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        kind: v.kind,
        id: v.id,
        title: typeof v.title === 'string' ? v.title : 'Untitled',
        x: v.x, y: v.y, w: v.w, h: v.h,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function saveCanvas(userId: string, space: CanvasSpace, cards: CanvasCard[]): void {
  try {
    const key = canvasStorageKey(userId, space);
    if (cards.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ cards }));
  } catch {
    // Private mode / quota — the canvas still works for this session.
  }
}
