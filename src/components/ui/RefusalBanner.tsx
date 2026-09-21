import { useState, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import {
  currentServerRefusal,
  dismissServerRefusal,
  subscribeServerRefusal,
} from '@/lib/refusal-bus';
import { dismissUpdateNotice } from '@/lib/app-version';
import { useUpdateNotice, useVersionWatch } from '@/hooks/useAppVersion';
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard';
import { flushAllUnsaved } from '@/lib/draft-store';

// The one place a server refusal is drawn. Mounted once per shell
// (MainLayout, DiscoveryLayout, ConnectLayout) and fed by refusal-bus.ts, so
// a module with no component of its own — an upload, a TTS fetch, a sandbox
// call — can still put a sentence in front of the person.
//
// The look is the Vault's existing floating notice (src/pages/Vault.tsx), not
// a new visual system: same geometry, same two tones, two added. Opaque
// background and a shadow rather than the translucent inline idiom, because
// this lands over whatever route is open — including the Reader's parchment,
// which is light.
//
// Four tones, and which one is used is a claim about what happened:
//
//   warn (gold)   the wallet or the rate window. Nothing is broken; the
//                 product is doing what it was built to do.
//   seal (green)  a SecureSpace refusal. #5aa88f is the seal's own colour
//                 everywhere else in the app, and red here would read as
//                 "something failed" when the seal holding is the feature.
//   err  (red)    anything else — an expired session, a provider error.
//   news (slate)  added 2026-09-20: this tab is running an older bundle than
//                 the one deployed. Nothing failed and nothing is owed — it
//                 is news, so neither gold nor red. The stale-chunk case
//                 borrows the same tone rather than going red, because the
//                 remedy is identical and the person has done nothing wrong.
//
// It is sticky until dismissed. A timer would be kinder to the eye and worse
// for the person: a lawyer who steps away mid-upload has to come back to the
// reason their work stopped, not to a screen that looks fine.
//
// A server refusal and a version notice can both be true at once. The refusal
// wins the one slot: it explains why a step the person just took stopped, and
// "there is a newer build" can wait the minute until it is dismissed.

const TONES = {
  warn: 'bg-[#2a2412] border-[#e8b84a]/40 text-[#f0dfa8]',
  seal: 'bg-[#12211c] border-[#5aa88f]/40 text-[#bfe0d2]',
  err: 'bg-[#2a1214] border-[#f87171]/40 text-[#f8b4b4]',
  news: 'bg-[#171c26] border-[#8aa2c8]/35 text-[#c8d6ec]',
} as const;

const SHELL =
  // inset-x-4 + mx-auto rather than left-1/2 + -translate-x-1/2: a margin is
  // inert on a translate-centred fixed element, so on a 390px phone the pill
  // would render at its full 512px and hang off both edges with the sentence
  // clipped. Identical on a desktop; inside the gutter on a phone.
  'fixed top-16 inset-x-4 mx-auto z-50 flex items-start gap-2 w-fit max-w-lg ' +
  'px-3 py-2 rounded-lg border text-xs leading-snug shadow-xl';

export default function RefusalBanner() {
  const refusal = useSyncExternalStore(
    subscribeServerRefusal,
    currentServerRefusal,
    () => null,
  );
  // Every signed-in shell already mounts this component exactly once, so it
  // is also where the tab learns that it has fallen behind. The hook does no
  // rendering; it only asks /version.json at sensible moments.
  const update = useUpdateNotice();
  useVersionWatch();
  // And, for the same reason, where the browser's leave-confirmation is
  // attached — only ever while something typed is not yet on the server.
  useUnsavedGuard();
  const [refreshBlocked, setRefreshBlocked] = useState(false);

  if (refusal) {
    const tone =
      refusal.kind === 'budget' || refusal.kind === 'rate'
        ? TONES.warn
        : refusal.kind === 'sealed'
          ? TONES.seal
          : TONES.err;

    return (
      <div role="status" aria-live="polite" className={`${SHELL} ${tone}`}>
        <span className="flex-1">{refusal.message}</span>
        <button
          onClick={dismissServerRefusal}
          className="opacity-70 hover:opacity-100 shrink-0 mt-0.5"
          aria-label="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  if (update) {
    // The person chooses the moment — but a Refresh they DID ask for saves
    // first. flushAllUnsaved() is every live editing surface, and a reload
    // only follows if the server actually took the work; if it did not, the
    // banner says so and the tab stays where it is.
    const refresh = async () => {
      setRefreshBlocked(false);
      const saved = await flushAllUnsaved();
      if (!saved) {
        setRefreshBlocked(true);
        return;
      }
      window.location.reload();
    };

    return (
      <div role="status" aria-live="polite" className={`${SHELL} ${TONES.news}`}>
        <span className="flex-1">
          {update.message}
          {refreshBlocked && (
            <span className="block mt-1 text-[#f8b4b4]">
              Not refreshed — some of your work has not saved yet. It is still
              here, and it is still being retried.
            </span>
          )}
        </span>
        <button
          onClick={() => { void refresh(); }}
          className="shrink-0 underline underline-offset-2 decoration-[#8aa2c8]/60 opacity-90 hover:opacity-100"
        >
          Refresh
        </button>
        <button
          onClick={dismissUpdateNotice}
          className="opacity-70 hover:opacity-100 shrink-0 mt-0.5"
          aria-label="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  return null;
}
