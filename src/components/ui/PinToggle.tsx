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
      className={`p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] transition-colors ${
        pinned ? 'text-[#e8b84a] hover:text-[#f5d178]' : 'text-white/60 hover:text-white'
      }`}
      title={pinned ? 'Unpin (or double-click the card)' : 'Pin in place (or right-click the card)'}
    >
      {pinned ? <Pin size={14} strokeWidth={2} /> : <PinOff size={14} strokeWidth={2} />}
    </button>
  );
}
