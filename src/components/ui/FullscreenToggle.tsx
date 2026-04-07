import { Maximize2, Minimize2 } from 'lucide-react';
import { useState } from 'react';

export default function FullscreenToggle({ onToggle }: { onToggle: () => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <button
      onClick={() => { setExpanded(!expanded); onToggle(); }}
      className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
      title={expanded ? 'Exit fullscreen' : 'Fullscreen'}
    >
      {expanded ? <Minimize2 size={14} strokeWidth={2} /> : <Maximize2 size={14} strokeWidth={2} />}
    </button>
  );
}
