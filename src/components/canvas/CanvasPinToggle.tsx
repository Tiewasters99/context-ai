// The pin in a card's header. Pinning puts the card on the canvas, where it
// stays while you open other cards; unpinning takes it off again.
//
// It reads "Pinned" in words when lit because the state matters and a gold
// icon alone does not say what it bought you.

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

  return (
    <button
      onClick={() => (pinned ? canvas.unpin(cardKey(kind, id)) : canvas.pin({ kind, id, title }))}
      className={`flex items-center gap-1 px-1.5 py-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] transition-colors ${
        pinned ? 'text-[#e8b84a] hover:text-[#f5d178]' : 'text-white/60 hover:text-white'
      }`}
      title={
        pinned
          ? 'Pinned to the canvas — it stays open when you open another card. Click to unpin.'
          : 'Pin to the canvas — keep this card open while you open others'
      }
    >
      {pinned ? <Pin size={14} strokeWidth={2} /> : <PinOff size={14} strokeWidth={2} />}
      {pinned && <span className="text-[10px] font-medium">Pinned</span>}
    </button>
  );
}
