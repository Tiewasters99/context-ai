import { useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import {
  currentServerRefusal,
  dismissServerRefusal,
  subscribeServerRefusal,
} from '@/lib/refusal-bus';

// The one place a server refusal is drawn. Mounted once per shell
// (MainLayout, DiscoveryLayout, ConnectLayout) and fed by refusal-bus.ts, so
// a module with no component of its own — an upload, a TTS fetch, a sandbox
// call — can still put a sentence in front of the person.
//
// The look is the Vault's existing floating notice (src/pages/Vault.tsx), not
// a new visual system: same geometry, same two tones, one added. Opaque
// background and a shadow rather than the translucent inline idiom, because
// this lands over whatever route is open — including the Reader's parchment,
// which is light.
//
// Three tones, and which one is used is a claim about what happened:
//
//   warn (gold)   the wallet or the rate window. Nothing is broken; the
//                 product is doing what it was built to do.
//   seal (green)  a SecureSpace refusal. #5aa88f is the seal's own colour
//                 everywhere else in the app, and red here would read as
//                 "something failed" when the seal holding is the feature.
//   err  (red)    anything else — an expired session, a provider error.
//
// It is sticky until dismissed. A timer would be kinder to the eye and worse
// for the person: a lawyer who steps away mid-upload has to come back to the
// reason their work stopped, not to a screen that looks fine.

const TONES = {
  warn: 'bg-[#2a2412] border-[#e8b84a]/40 text-[#f0dfa8]',
  seal: 'bg-[#12211c] border-[#5aa88f]/40 text-[#bfe0d2]',
  err: 'bg-[#2a1214] border-[#f87171]/40 text-[#f8b4b4]',
} as const;

export default function RefusalBanner() {
  const refusal = useSyncExternalStore(
    subscribeServerRefusal,
    currentServerRefusal,
    () => null,
  );
  if (!refusal) return null;

  const tone =
    refusal.kind === 'budget' || refusal.kind === 'rate'
      ? TONES.warn
      : refusal.kind === 'sealed'
        ? TONES.seal
        : TONES.err;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed top-16 left-1/2 -translate-x-1/2 z-50 flex items-start gap-2 max-w-lg mx-4 px-3 py-2 rounded-lg border text-xs leading-snug shadow-xl ${tone}`}
    >
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
