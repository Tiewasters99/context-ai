import { Maximize, Minus } from 'lucide-react';

// Toggles the active cover image between banner-strip and full-page
// background. Companion to CoverImage's controlled expansion API. Hidden
// when there's no cover to mode-switch.
export default function CoverModeToggle({
  hasCover,
  expanded,
  onToggle,
}: {
  hasCover: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!hasCover) return null;
  return (
    <button
      onClick={onToggle}
      className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
      title={expanded ? 'Show cover as banner' : 'Use cover as full-page background'}
    >
      {expanded ? <Minus size={14} strokeWidth={2} /> : <Maximize size={14} strokeWidth={2} />}
    </button>
  );
}
