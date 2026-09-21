// Nothing a lawyer types is lost to a refresh, a closed tab, or a navigation.
//
// PR #192 audited what a reload costs today and published the table: the
// Editor's desk persists nothing at all, the Page editor writes to Supabase
// on BLUR only, the Assistant keeps neither the conversation nor the unsent
// question, and there is no `beforeunload` anywhere. This module is the half
// of the answer that has no React in it, so it can be driven by a test
// instead of by a browser:
//
//   1. THE SAVER — a debounced, serialized writer. Typing schedules a save;
//      the save never overlaps another; a failure keeps the work dirty and
//      retries with backoff; an unchanged document is never written at all.
//   2. THE MIRROR — the gap between the keystroke and the server. The
//      document is written to localStorage under a key that carries the USER
//      and the ITEM, and is cleared the moment the server has it. On a shared
//      machine one account's draft can therefore never surface under
//      another's: the key names the owner, and the read checks it again.
//   3. THE REGISTRY — every live saver announces itself here, so one question
//      ("is anything unsaved?") can be asked by the `beforeunload` guard and
//      by the Refresh button on #192's version banner.
//
// Storage is passed in rather than reached for. `localStorage` throws in a
// private window, is absent in a node harness, and is shared with the canvas
// and panel records — so every call is guarded, every write is size-capped,
// and a store that refuses simply means the safety net is thinner, never that
// an editor breaks.

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** The slice of the Web Storage API this module uses. `localStorage` fits. */
export interface KeyStore {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Document drafts (localStorage): survive a refresh AND a closed tab. */
export const DRAFT_PREFIX = 'cs.draft.v1.';
/** Assistant conversations (sessionStorage): this tab, this session, no longer. */
export const CHAT_PREFIX = 'cs.chat.v1.';

/**
 * A draft is a safety net, not a document store. Two megabytes is far more
 * than any brief anyone types in a sitting and far less than the ~5 MB origin
 * budget this shares with the canvas, cover and panel records.
 */
export const MAX_DRAFT_CHARS = 2_000_000;

export function browserLocalStore(): KeyStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // a browser with site data blocked
  }
}

export function browserSessionStore(): KeyStore | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The key carries the user AND the item, in that order.
 *
 * Two accounts on the same laptop is the ordinary case in a law office, and
 * per-matter isolation is the premise the product is sold on. A key that named
 * only the item would hand one lawyer's unsaved page to the next person who
 * signed in on that machine.
 */
export function draftKey(userId: string, itemId: string): string {
  return `${DRAFT_PREFIX}${userId}.${itemId}`;
}

export function chatKey(userId: string, scopeId: string): string {
  return `${CHAT_PREFIX}${userId}.${scopeId}`;
}

export interface DraftRecord<T = unknown> {
  v: 1;
  userId: string;
  itemId: string;
  /** When this draft was mirrored, by the browser's clock. */
  savedAt: number;
  /** `updated_at` of the server copy this draft was typed on top of. */
  baseUpdatedAt: string | null;
  data: T;
}

/** Returns false when the draft could not be kept (no store, quota, too big). */
export function writeDraft<T>(
  store: KeyStore | null,
  record: Omit<DraftRecord<T>, 'v'>,
): boolean {
  if (!store || !record.userId || !record.itemId) return false;
  let payload: string;
  try {
    payload = JSON.stringify({ v: 1, ...record });
  } catch {
    return false; // a value that will not serialize is not a draft
  }
  if (payload.length > MAX_DRAFT_CHARS) return false;
  try {
    store.setItem(draftKey(record.userId, record.itemId), payload);
    return true;
  } catch {
    // Quota. Drop this user's OTHER drafts and try once more: the document in
    // front of them is worth more than the ones they have already left.
    try {
      for (const key of keysWithPrefix(store, `${DRAFT_PREFIX}${record.userId}.`)) {
        if (key !== draftKey(record.userId, record.itemId)) store.removeItem(key);
      }
      store.setItem(draftKey(record.userId, record.itemId), payload);
      return true;
    } catch {
      return false;
    }
  }
}

export function readDraft<T>(
  store: KeyStore | null,
  userId: string | undefined,
  itemId: string | undefined,
): DraftRecord<T> | null {
  if (!store || !userId || !itemId) return null;
  let raw: string | null;
  try {
    raw = store.getItem(draftKey(userId, itemId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DraftRecord<T>;
    // The key already names the owner. Checking the record too means a
    // hand-edited or colliding key still cannot cross an account boundary.
    if (!parsed || parsed.v !== 1 || parsed.userId !== userId || parsed.itemId !== itemId) {
      return null;
    }
    if (typeof parsed.savedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearDraft(
  store: KeyStore | null,
  userId: string | undefined,
  itemId: string | undefined,
): void {
  if (!store || !userId || !itemId) return;
  try {
    store.removeItem(draftKey(userId, itemId));
  } catch {
    /* a store that will not forget is not worth an exception */
  }
}

function keysWithPrefix(store: KeyStore, prefix: string): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(prefix)) out.push(key);
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * Sign-out wipes EVERY account's drafts on this machine, not just the
 * outgoing one's. The next person to sign in here may be a different lawyer
 * at the same firm desk; leaving a predecessor's unsaved page in their browser
 * would be the isolation failure this store exists to prevent. The flush comes
 * first (see AuthContext) — nothing is discarded that the server has not been
 * offered.
 */
export function clearAllDrafts(store: KeyStore | null): number {
  if (!store) return 0;
  let removed = 0;
  for (const key of [
    ...keysWithPrefix(store, DRAFT_PREFIX),
    ...keysWithPrefix(store, CHAT_PREFIX),
  ]) {
    try {
      store.removeItem(key);
      removed += 1;
    } catch {
      /* ignore */
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// The saver
// ---------------------------------------------------------------------------

export interface AutosaveState {
  /** Work exists that the server does not have. */
  dirty: boolean;
  /** A write is on the wire right now. */
  saving: boolean;
  /** When the server last took it. */
  savedAt: number | null;
  /** The last failure, in the words the caller can show. */
  error: string | null;
  /** Consecutive failures — drives the backoff. */
  attempts: number;
}

export const IDLE_STATE: AutosaveState = {
  dirty: false,
  saving: false,
  savedAt: null,
  error: null,
  attempts: 0,
};

/** Idle before a save. Long enough not to write on every keystroke, short
 *  enough that a pause to think is already a save. */
export const AUTOSAVE_DELAY_MS = 1_500;
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 30_000;

export type TimerHandle = ReturnType<typeof setTimeout> | number;

export interface AutosaverOptions<T> {
  /** The write. Rejecting keeps the work dirty; it is never dropped. */
  save: (value: T) => Promise<void>;
  /** Called synchronously on every change — the local mirror. */
  mirror?: (value: T) => void;
  /** Called once the server has it. */
  clearMirror?: () => void;
  delayMs?: number;
  signature?: (value: T) => string;
  onState?: (state: AutosaveState) => void;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
}

export interface Autosaver<T> {
  /** Typing. Schedules a save unless the value is what the server already has. */
  change(value: T): void;
  /** Hydration: this IS the server's copy. No save, no mirror, not dirty. */
  adopt(value: T): void;
  /** Save now. Resolves true when the server has everything. */
  flush(): Promise<boolean>;
  state(): AutosaveState;
  /** Cancel timers. Does NOT flush — the caller decides. */
  dispose(): void;
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error ?? '');
  return text || 'the save did not go through';
}

export function createAutosaver<T>(options: AutosaverOptions<T>): Autosaver<T> {
  const delayMs = options.delayMs ?? AUTOSAVE_DELAY_MS;
  const sign = options.signature ?? ((value: T) => JSON.stringify(value) ?? '');
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms) as TimerHandle);
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let state: AutosaveState = { ...IDLE_STATE };
  let pending: { value: T; sig: string } | null = null;
  let lastSaved: string | null = null;
  let timer: TimerHandle | null = null;
  let inFlight: Promise<void> | null = null;
  let disposed = false;

  const emit = (patch: Partial<AutosaveState>) => {
    state = { ...state, ...patch };
    options.onState?.(state);
  };

  const clearTimer = () => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  };

  const arm = (ms: number) => {
    clearTimer();
    timer = schedule(() => {
      timer = null;
      void run();
    }, ms);
  };

  async function run(): Promise<void> {
    if (disposed) return;
    if (inFlight) return inFlight;
    const job = pending;
    if (!job) return;
    pending = null;
    clearTimer();
    emit({ saving: true });

    const attempt = (async () => {
      try {
        await options.save(job.value);
        lastSaved = job.sig;
        options.clearMirror?.();
        emit({
          saving: false,
          // Anything typed while that write was in flight is still unsaved.
          dirty: pending !== null,
          savedAt: now(),
          error: null,
          attempts: 0,
        });
      } catch (error) {
        // The work stays dirty and stays HERE. If nothing newer arrived while
        // this was failing, the same job goes back on the queue; if something
        // did, it supersedes this one and carries it (the value is whole, not
        // a delta), so the failed job is simply dropped.
        if (!pending) pending = job;
        const attempts = state.attempts + 1;
        emit({ saving: false, dirty: true, error: describe(error), attempts });
        arm(Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS));
      }
    })();

    inFlight = attempt;
    try {
      await attempt;
    } finally {
      inFlight = null;
    }

    // A change that arrived mid-write goes out immediately: it was already
    // debounced once. A change that arrived mid-FAILURE waits for the backoff.
    if (pending && !state.error && !disposed) await run();
  }

  return {
    change(value: T) {
      if (disposed) return;
      const sig = sign(value);
      if (sig === lastSaved && !state.error) {
        // Identical to what the server holds. Not a save, not even a mirror:
        // clicking into a page and out of it must write nothing.
        pending = null;
        clearTimer();
        if (state.dirty) emit({ dirty: false });
        return;
      }
      pending = { value, sig };
      options.mirror?.(value);
      emit({ dirty: true });
      arm(state.error ? Math.min(RETRY_BASE_MS * 2 ** state.attempts, RETRY_MAX_MS) : delayMs);
    },

    adopt(value: T) {
      if (disposed) return;
      lastSaved = sign(value);
      pending = null;
      clearTimer();
      emit({ dirty: false, error: null, attempts: 0 });
    },

    async flush(): Promise<boolean> {
      if (disposed) return !state.dirty;
      clearTimer();
      if (inFlight) await inFlight;
      if (pending) await run();
      return !state.dirty && !state.error;
    },

    state: () => state,

    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}

// ---------------------------------------------------------------------------
// The registry — one question, asked by the guard and by the banner
// ---------------------------------------------------------------------------

export interface UnsavedSource {
  state: () => AutosaveState;
  flush: () => Promise<boolean>;
}

const sources = new Map<string, UnsavedSource>();
const listeners = new Set<() => void>();

export function registerUnsavedSource(id: string, source: UnsavedSource): () => void {
  sources.set(id, source);
  notifyUnsaved();
  return () => {
    sources.delete(id);
    notifyUnsaved();
  };
}

export function notifyUnsaved(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* a listener that throws must not stop the others */
    }
  }
}

export function subscribeUnsaved(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while anything typed is not yet on the server, or is on the wire. */
export function isWorkUnsaved(): boolean {
  for (const source of sources.values()) {
    const state = source.state();
    if (state.dirty || state.saving) return true;
  }
  return false;
}

/** Every live surface, saved now. False if anything is still unsaved after. */
export async function flushAllUnsaved(): Promise<boolean> {
  const results = await Promise.all(
    [...sources.values()].map(async (source) => {
      try {
        return await source.flush();
      } catch {
        return false;
      }
    }),
  );
  return results.every(Boolean);
}

/** Test seam only — the registry is module state. */
export function resetUnsavedRegistry(): void {
  sources.clear();
  listeners.clear();
}

// ---------------------------------------------------------------------------
// What the header says
// ---------------------------------------------------------------------------

export function clockLabel(at: number): string {
  try {
    return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * The quiet line beside the document. Null when there is nothing to say, so
 * the caller keeps whatever it said before (Locked / Editable).
 *
 * A failure says so in plain words and says what is being done about it. It
 * never says "saved".
 */
export function saveStatusLine(state: AutosaveState): string | null {
  if (state.error) return 'Not saved — retrying';
  if (state.saving) return 'Saving…';
  if (state.dirty) return 'Unsaved…';
  if (state.savedAt) return `Saved ${clockLabel(state.savedAt)}`;
  return null;
}

/** The sentence on the restore bar. Both clocks, because they are two clocks. */
export function restoreOfferLine(draftAt: number, serverUpdatedAt?: string | null): string {
  const server = serverUpdatedAt ? Date.parse(serverUpdatedAt) : NaN;
  const tail = Number.isFinite(server) ? ` The saved copy is from ${clockLabel(server)}.` : '';
  return `Unsaved changes from ${clockLabel(draftAt)} were found on this computer.${tail}`;
}

// ---------------------------------------------------------------------------
// The Assistant's conversation, per (user, scope)
// ---------------------------------------------------------------------------

export interface StoredChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ChatRecord {
  v: 1;
  userId: string;
  scopeId: string;
  messages: StoredChatMessage[];
  input: string;
  savedAt: number;
}

/** A panel with no matter is its own scope, and never shares one with a matter. */
export const NO_MATTER_SCOPE = 'no-matter';

export function writeConversation(
  store: KeyStore | null,
  record: Omit<ChatRecord, 'v'>,
): boolean {
  if (!store || !record.userId || !record.scopeId) return false;
  try {
    const payload = JSON.stringify({ v: 1, ...record });
    if (payload.length > MAX_DRAFT_CHARS) return false;
    store.setItem(chatKey(record.userId, record.scopeId), payload);
    return true;
  } catch {
    return false;
  }
}

export function readConversation(
  store: KeyStore | null,
  userId: string | undefined,
  scopeId: string | undefined,
): ChatRecord | null {
  if (!store || !userId || !scopeId) return null;
  try {
    const raw = store.getItem(chatKey(userId, scopeId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChatRecord;
    // One matter's conversation must never appear under another's scope, and
    // one account's must never appear under another's. The key says both; this
    // says them again.
    if (!parsed || parsed.v !== 1) return null;
    if (parsed.userId !== userId || parsed.scopeId !== scopeId) return null;
    if (!Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearConversation(
  store: KeyStore | null,
  userId: string | undefined,
  scopeId: string | undefined,
): void {
  if (!store || !userId || !scopeId) return;
  try {
    store.removeItem(chatKey(userId, scopeId));
  } catch {
    /* ignore */
  }
}
