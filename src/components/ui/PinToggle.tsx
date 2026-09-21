// PIN — fix this card in place.
//
// There are two things a card can do that both sounded like "pin", and one
// word for both of them taught users that the word means nothing. So the
// word is spoken for: "Pin" is the one in this file, and it means exactly
// what it says — the card stops moving and resizing, and it comes back next
// time exactly where it was left. Keeping a card on screen while you open
// others is a different button that says "Keep open" (CanvasPinToggle).
//
// The label is always on. An icon alone is what made the two indistinguishable.

import { Pin, PinOff } from 'lucide-react';

export default function PinToggle({
  pinned,
  onToggle,
}: {
  pinned: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={`flex items-center gap-1 px-1.5 py-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] transition-colors ${
        pinned ? 'text-[#e8b84a] hover:text-[#f5d178]' : 'text-white/60 hover:text-white'
      }`}
      title={
        pinned
          ? 'Pinned in place — this card will not move or resize, and it reopens right here. Click to unpin (double-clicking the card does the same).'
          : 'Pin this card in place: it stops moving and resizing, and reopens exactly where it is now. It does not keep the card on screen while you open others — use Keep open for that. (Right-clicking the card also pins.)'
      }
    >
      {pinned ? <Pin size={14} strokeWidth={2} /> : <PinOff size={14} strokeWidth={2} />}
      <span className="text-[10px] font-medium">{pinned ? 'Pinned' : 'Pin'}</span>
    </button>
  );
}
