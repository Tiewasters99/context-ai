// The pin in a card's header. Pinning puts the card on the canvas, where it
// stays while you open other cards; unpinning takes it off again.
//
// It reads in words rather than relying on a gold icon, because the icon
// alone never said what pinning bought you. Until the user has pinned
// anything it reads "Keep open" — the instruction, not the mechanism —
// since nothing else in the app tells you that pinning is how you get a
// second card on screen at the same time.

import { Pin, PinOff } from 'lucide-react';
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

  const pinned = canvas.isPinned(kind, id);
  // Once there is something on the canvas the user has learned the gesture,
  // so the button goes quiet again and just shows the pin.
  const teaching = !pinned && canvas.cards.length === 0;

  return (
    <button
      onClick={() => (pinned ? canvas.unpin(cardKey(kind, id)) : canvas.pin({ kind, id, title }))}
      className={`flex items-center gap-1 px-1.5 py-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] transition-colors ${
        pinned ? 'text-[#e8b84a] hover:text-[#f5d178]' : 'text-white/60 hover:text-white'
      }`}
      title={
        pinned
          ? 'Pinned — this card stays on screen while you open others. Click to unpin.'
          : 'Pin this card to keep it on screen while you open others. Pin as many as you like; each one can be moved, resized from any edge, and taken full screen.'
      }
    >
      {pinned ? <Pin size={14} strokeWidth={2} /> : <PinOff size={14} strokeWidth={2} />}
      {pinned && <span className="text-[10px] font-medium">Pinned</span>}
      {teaching && <span className="text-[10px] font-medium">Keep open</span>}
    </button>
  );
}
