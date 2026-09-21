// KEEP OPEN — put this card on the canvas so it stays on screen while you
// open other cards.
//
// This button used to be a pin, and so did the one that fixes a card in
// place. Two buttons, one word, opposite jobs: a user who wanted the card to
// stop moving clicked this, nothing they could see changed (while you are on
// the card's own route the canvas deliberately does not draw a second copy of
// it), and they concluded that pinning was broken. It was not — it was the
// wrong button, wearing the right button's name and glyph.
//
// So: no pin here, in word or in icon. This one says "Keep open" ALWAYS —
// the earlier version dropped the label once anything was on the canvas,
// which is precisely when a bare pin icon is most confusing — and it wears a
// layers glyph, because stacking a second card on screen is what it does.
// The pin, and the word Pin, belong to the fix-in-place control next door.

import { Layers } from 'lucide-react';
import { useOptionalCanvas } from '@/hooks/useCanvas';
import { cardKey, type CanvasCardKind } from '@/lib/canvas';

export default function CanvasPinToggle({
  kind,
  id,
  title,
}: {
  kind: CanvasCardKind;
  id: string | undefined;
  title: string;
}) {
  const canvas = useOptionalCanvas();
  if (!canvas || !id) return null;

  const kept = canvas.isPinned(kind, id);

  // Clicking in the first seconds of a cold load used to lose the card in
  // silence: the canvas had not been read from storage yet, so the save was
  // skipped and the load that followed replaced what you had just added.
  // Until the read lands the button says so instead of lying. `aria-disabled`
  // rather than `disabled`, because a disabled button shows no tooltip — and
  // a dead button with no explanation is the thing being fixed.
  const ready = canvas.hydrated;

  return (
    <button
      onClick={() => {
        if (!ready) return;
        if (kept) canvas.unpin(cardKey(kind, id));
        else canvas.pin({ kind, id, title });
      }}
      aria-disabled={!ready}
      className={`flex items-center gap-1 px-1.5 py-1.5 rounded-md transition-colors ${
        !ready
          ? 'text-white/30 cursor-wait'
          : kept
            ? 'text-[#e8b84a] hover:text-[#f5d178] hover:bg-[rgba(255,255,255,0.08)]'
            : 'text-white/60 hover:text-white hover:bg-[rgba(255,255,255,0.08)]'
      }`}
      title={
        !ready
          ? 'Loading your open cards…'
          : kept
            ? 'Kept open — this card stays on screen while you open others. It does not lock its position — use Pin for that. Click to take it off.'
            : 'Keeps this card on screen while you open others. It does not lock its position — use Pin for that.'
      }
    >
      <Layers size={14} strokeWidth={2} />
      <span className="text-[10px] font-medium">{kept ? 'Kept open' : 'Keep open'}</span>
    </button>
  );
}
