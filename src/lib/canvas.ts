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

export type CanvasCardKind = 'list' | 'page' | 'table' | 'document' | 'calendar';

// The calendar is one sheet, not one of many, so it has no row of its own to
// key off. It still needs an id to be a card like any other; this is it.
export const CALENDAR_CARD_ID = 'calendar';

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
  /** Full screen. x/y/w/h keep the windowed rect, so leaving full screen
      returns the panel exactly where it was. */
  max?: boolean;
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

export const CANVAS_KINDS: readonly CanvasCardKind[] = ['list', 'page', 'table', 'document', 'calendar'];

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
  calendar: { w: 560, h: 520 },   // a month grid needs width to stay legible
};

export const MIN_W = 280;
export const MIN_H = 180;

// Pinned panels stack from here, above the route card (12) and below modals
// (70). See the stacking contract in useDraggableResizable.ts. The cap keeps
// a very busy canvas from climbing into the modal layer; past it, panels
// share the top band and the raise-on-focus order still decides among them.
export const CANVAS_PANEL_Z = 30;
export const CANVAS_PANEL_Z_MAX = 55;
export const CANVAS_FULLSCREEN_Z = 60;

export function panelZ(index: number): number {
  return Math.min(CANVAS_PANEL_Z + index, CANVAS_PANEL_Z_MAX);
}

export function defaultSize(kind: CanvasCardKind): { w: number; h: number } {
  return DEFAULT_SIZE[kind];
}

const TOP = 76;      // below the app header
const EDGE = 16;     // inset from the viewport edges
const GAP = 12;      // between tiled cards

type Rect = { x: number; y: number; w: number; h: number };

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Where a newly pinned card lands.
//
// Cards TILE rather than cascade: a new card takes the first free slot in a
// grid, so ten pinned cards are ten usable cards instead of one card with
// nine slivers behind it. Slots fill from the right, because the route card
// you are reading is centred and wide — the first pin lands beside it, not
// on top of it.
//
// When the workspace runs out of room at the card's natural size, the grid
// gets denser (the new card comes in smaller) rather than giving up and
// piling cards in a corner. Only when even the densest grid is full does a
// card cascade off the newest one — and by then the user is well past the
// point where they should be resizing or unpinning something.
export function nextPlacement(
  kind: CanvasCardKind,
  existing: CanvasCard[],
  viewport: { width: number; height: number },
): Rect {
  const natural = defaultSize(kind);
  const availW = Math.max(MIN_W, viewport.width - EDGE * 2);
  const availH = Math.max(MIN_H, viewport.height - TOP - EDGE);

  for (const scale of [1, 0.8, 0.65, 0.5]) {
    const w = Math.max(MIN_W, Math.min(Math.round(natural.w * scale), availW));
    const h = Math.max(MIN_H, Math.min(Math.round(natural.h * scale), availH));
    const cols = Math.max(1, Math.floor((availW + GAP) / (w + GAP)));
    const rows = Math.max(1, Math.floor((availH + GAP) / (h + GAP)));

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // Columns march leftward from the right edge.
        const candidate: Rect = {
          x: viewport.width - EDGE - w - c * (w + GAP),
          y: TOP + r * (h + GAP),
          w,
          h,
        };
        if (candidate.x < EDGE) continue;
        if (!existing.some((e) => overlaps(candidate, e))) {
          return { x: Math.round(candidate.x), y: Math.round(candidate.y), w, h };
        }
      }
    }
  }

  // Every slot taken — step off the newest card so the new one is reachable.
  const width = Math.max(MIN_W, Math.min(natural.w, availW));
  const height = Math.max(MIN_H, Math.min(natural.h, availH));
  const last = existing[existing.length - 1];
  const x = last ? last.x - 30 : viewport.width - EDGE - width;
  const y = last ? last.y + 30 : TOP;
  return {
    x: Math.round(Math.max(EDGE, Math.min(x, viewport.width - 80))),
    y: Math.round(Math.max(TOP, Math.min(y, viewport.height - 60))),
    w: width,
    h: height,
  };
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
        max: (v as { max?: unknown }).max === true,
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
