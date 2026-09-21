// Where the Assistant card sits, how big it is, and whether it is pinned —
// one localStorage record, read and written as a whole so a write can never
// drop the half it wasn't thinking about.
//
// The card has its own drag/resize (React state and an explicit box) rather
// than useDraggableResizable, because that hook drives a route card: it forces
// `zIndex: 12` on every makeFixed/pin/restore, and the Assistant panel lives at
// z-50 so it stays usable ABOVE the card you are reading. Adopting the hook
// would drop the panel behind the route card on the first drag. So the panel
// keeps its own gestures and borrows the hook's CONTRACT instead — the same
// merged single-key persistence, the same rule that unpinning keeps the rect,
// the same PinToggle button, and the same silence on a phone.
//
// Storage is best-effort everywhere: a blocked or full store forgets where the
// panel was, and nothing else.

export interface PanelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PanelState {
  /** null = docked to the right edge, the panel's default. */
  box: PanelBox | null;
  /** Pinned: no drag, no resize, and it survives a reload. */
  pinned: boolean;
}

/** The slice of `Storage` this needs — so a test can hand it a plain object. */
export interface MiniStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const PANEL_STATE_KEY = 'cs.assistant.box';

export const DOCKED: PanelState = { box: null, pinned: false };

function isBox(v: unknown): v is PanelBox {
  if (!v || typeof v !== 'object') return false;
  const b = v as Partial<PanelBox>;
  return typeof b.left === 'number' && typeof b.top === 'number';
}

/**
 * Read the panel's remembered layout.
 *
 * Accepts the LEGACY record — a bare `{left,top,width,height}`, which is what
 * every browser that has ever opened this panel has stored — and reports it as
 * an unpinned box. Nobody loses their panel's position to this change.
 */
export function readPanelState(store?: MiniStorage | null, key: string = PANEL_STATE_KEY): PanelState {
  if (!store) return DOCKED;
  try {
    const raw = store.getItem(key);
    if (!raw) return DOCKED;
    const parsed = JSON.parse(raw) as unknown;
    if (isBox(parsed)) return { box: parsed, pinned: false };
    const rec = parsed as { box?: unknown; pinned?: unknown };
    return {
      box: isBox(rec.box) ? rec.box : null,
      pinned: rec.pinned === true,
    };
  } catch {
    return DOCKED;
  }
}

/**
 * Write it back whole. Docked and unpinned is the default, so it is stored as
 * nothing at all rather than as a record saying "nothing".
 */
export function writePanelState(
  store: MiniStorage | null | undefined,
  state: PanelState,
  key: string = PANEL_STATE_KEY,
): void {
  if (!store) return;
  try {
    if (!state.box && !state.pinned) store.removeItem(key);
    else store.setItem(key, JSON.stringify({ box: state.box, pinned: state.pinned }));
  } catch {
    /* a blocked store forgets the place, nothing more */
  }
}

/** localStorage where there is one, and nothing where there is not. */
export function browserStore(): MiniStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
