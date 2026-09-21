// The React half of draft-store.ts.
//
//   useAutosave        one editing surface's saver: debounced while typing,
//                      flushed on blur, on unmount, on a route change, when
//                      the tab is hidden and on `pagehide`; mirrored to
//                      localStorage under (user, item) the whole time.
//   useUnsavedGuard    the browser's own "leave site?" prompt, attached ONLY
//                      while something is genuinely unsaved. Mounted once per
//                      shell. Never a blanket nag.
//
// The decisions all live next door, in draft-store.ts, where they can be
// tested without a browser. This file is wiring.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IDLE_STATE,
  browserLocalStore,
  clearDraft,
  createAutosaver,
  isWorkUnsaved,
  notifyUnsaved,
  readDraft,
  registerUnsavedSource,
  subscribeUnsaved,
  writeDraft,
  type Autosaver,
  type AutosaveState,
  type DraftRecord,
} from '@/lib/draft-store';

export interface UseAutosaveOptions<T> {
  /** The signed-in account. Without it nothing is mirrored — a draft with no
   *  owner is exactly the thing that must never be written. */
  userId: string | undefined;
  /** What is being edited. One saver per item. */
  itemId: string | undefined;
  /** The write. Rejecting keeps the work dirty; it is retried with backoff. */
  save: (value: T) => Promise<void>;
  /** `updated_at` of the server copy, recorded with the draft for the prompt. */
  baseUpdatedAt?: string | null;
  delayMs?: number;
  /**
   * Mirror to localStorage between keystroke and server. Default true.
   *
   * Off for Lists and Tables: every structural edit there already lands
   * immediately, so the only exposure is the second or so of typing inside
   * one item or one cell, and the flushes below close that window. A mirror
   * with no restore prompt would be a draft nobody is ever offered.
   */
  mirror?: boolean;
}

export interface UseAutosave<T> {
  /** Typing. */
  change: (value: T) => void;
  /** Hydration — this IS the server's copy. */
  adopt: (value: T) => void;
  /** Save now; resolves true when the server has everything. */
  flush: () => Promise<boolean>;
  status: AutosaveState;
  /** A draft left on this computer by this user for this item, if any. */
  draft: DraftRecord<T> | null;
  /** Throw that draft away (the person chose "Discard"). */
  discardDraft: () => void;
}

export function useAutosave<T>({
  userId,
  itemId,
  save,
  baseUpdatedAt = null,
  delayMs,
  mirror = true,
}: UseAutosaveOptions<T>): UseAutosave<T> {
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; });

  const baseRef = useRef(baseUpdatedAt);
  useEffect(() => { baseRef.current = baseUpdatedAt; });

  const store = useMemo(() => browserLocalStore(), []);
  const [status, setStatus] = useState<AutosaveState>(IDLE_STATE);
  const [draftNonce, setDraftNonce] = useState(0);

  // One saver per (user, item). A new item gets a new saver, and the old one
  // is flushed and disposed by the cleanup below — which is what makes
  // navigating from one page to another a save rather than a loss.
  const saver = useMemo(
    () =>
      createAutosaver<T>({
        save: (value) => saveRef.current(value),
        // Synchronous, on every change. By the time `pagehide` fires there is
        // nothing left to mirror — which matters, because a Supabase write
        // started in that handler may never reach the network.
        mirror: (value) => {
          if (!mirror || !userId || !itemId) return;
          writeDraft<T>(store, {
            userId,
            itemId,
            savedAt: Date.now(),
            baseUpdatedAt: baseRef.current,
            data: value,
          });
        },
        clearMirror: () => { if (mirror) clearDraft(store, userId, itemId); },
        delayMs,
        onState: (next) => {
          setStatus(next);
          notifyUnsaved();
        },
      }),
    [store, userId, itemId, delayMs, mirror],
  );

  // NEVER dispose the CURRENT saver in a cleanup.
  //
  // React's StrictMode — which this app mounts in (src/main.tsx) — runs every
  // effect mount → cleanup → mount in development, with the same memoised
  // saver both times. A cleanup that disposed it would hand the re-mounted
  // editor a dead saver: `change()` returns early, nothing is marked dirty,
  // nothing is mirrored, and blur reports success having written nothing. In
  // development every Page, List and Table would silently stop saving.
  //
  // So the PREVIOUS saver is disposed when a new one replaces it, and an
  // unmount only flushes. A saver that outlives its component by a moment and
  // finishes its retry is the behaviour worth having anyway.
  const previousSaver = useRef<Autosaver<T> | null>(null);
  useEffect(() => {
    const previous = previousSaver.current;
    if (previous && previous !== saver) {
      void previous.flush().finally(() => previous.dispose());
    }
    previousSaver.current = saver;
  }, [saver]);

  // Leaving for good — a route change, a closed panel. Both are moments a
  // lawyer expects their typing to have landed.
  useEffect(() => () => { void previousSaver.current?.flush(); }, []);

  useEffect(
    () =>
      registerUnsavedSource(`autosave:${userId ?? '-'}:${itemId ?? '-'}`, {
        state: () => saver.state(),
        flush: () => saver.flush(),
      }),
    [saver, userId, itemId],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHidden = () => {
      // The mirror is already current (it is written on every change), so what
      // is attempted here is the server copy. If the tab dies first, the
      // mirror is the net and the restore prompt is how it comes back.
      if (document.visibilityState === 'hidden') void saver.flush();
    };
    const onPageHide = () => { void saver.flush(); };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [saver]);

  const draft = useMemo(
    () => readDraft<T>(store, userId, itemId),
    // draftNonce re-reads after a discard; the mirror's own writes must NOT
    // re-open the prompt, so nothing else invalidates this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, userId, itemId, draftNonce],
  );

  const discardDraft = useCallback(() => {
    clearDraft(store, userId, itemId);
    setDraftNonce((n) => n + 1);
  }, [store, userId, itemId]);

  const change = useCallback((value: T) => saver.change(value), [saver]);
  const adopt = useCallback((value: T) => saver.adopt(value), [saver]);
  const flush = useCallback(() => saver.flush(), [saver]);

  return { change, adopt, flush, status, draft, discardDraft };
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

type GuardTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/**
 * Attach the browser's leave-confirmation only while work is unsaved, and
 * take it off again the moment the server has it.
 *
 * Written as a plain function over an event target so the rule that matters —
 * the listener is absent when nothing is dirty — is testable without a DOM.
 */
export function createUnsavedGuard(
  target: GuardTarget,
  isDirty: () => boolean = isWorkUnsaved,
): () => void {
  let attached = false;
  const handler = (event: Event) => {
    // The browser shows its own sentence; ours is on the page behind it.
    event.preventDefault();
    (event as BeforeUnloadEvent).returnValue = '';
  };

  const sync = () => {
    const dirty = isDirty();
    if (dirty && !attached) {
      target.addEventListener('beforeunload', handler);
      attached = true;
    } else if (!dirty && attached) {
      target.removeEventListener('beforeunload', handler);
      attached = false;
    }
  };

  const unsubscribe = subscribeUnsaved(sync);
  sync();

  return () => {
    unsubscribe();
    if (attached) {
      target.removeEventListener('beforeunload', handler);
      attached = false;
    }
  };
}

/** Mounted once per shell, beside the version watch. */
export function useUnsavedGuard(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    return createUnsavedGuard(window);
  }, []);
}
