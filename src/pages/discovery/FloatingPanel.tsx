import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import PinToggle from '@/components/ui/PinToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';

// Floating glass panel for the Discovery surfaces — draggable from anywhere
// (the ribbon header is the visible affordance), resizable from every edge,
// pinnable (right-click or the pin button), with position persisted per
// storageKey. This is the audio-box ribbon pattern: a clearly visible
// header bar with a grab pill, never a centered fixed-size modal.
export default function FloatingPanel({
  title,
  icon,
  accent = '#d4a054',
  storageKey,
  defaultStyle,
  onClose,
  headerExtra,
  children,
}: {
  title: string;
  icon?: ReactNode;
  accent?: string;
  storageKey?: string;
  defaultStyle?: React.CSSProperties;
  onClose: () => void;
  headerExtra?: ReactNode;
  children: ReactNode;
}) {
  const { cardRef, pinned, togglePin } = useDraggableResizable(storageKey);

  return (
    <div
      ref={cardRef}
      className="fixed z-[45] flex flex-col rounded-xl border border-[rgba(255,255,255,0.12)] shadow-2xl select-none cursor-grab overflow-hidden backdrop-blur-[30px]"
      style={{
        backgroundColor: 'rgba(10,10,16,0.88)',
        width: 380,
        maxHeight: '78vh',
        ...defaultStyle,
      }}
    >
      {/* Ribbon header — the visible drag handle. */}
      <div
        className="shrink-0 px-3 pt-2 pb-2 border-b border-[rgba(255,255,255,0.08)]"
        style={{ background: `linear-gradient(to right, ${accent}1f, transparent 65%)` }}
      >
        <div className="flex justify-center mb-1.5">
          <div className="w-12 h-1 rounded-full bg-white/25 hover:bg-white/45 transition-colors" title="Drag to move" />
        </div>
        <div className="flex items-center gap-2">
          <span style={{ color: accent }} className="shrink-0">{icon}</span>
          <span
            className="flex-1 min-w-0 truncate text-[13px] font-semibold tracking-wide text-[#f5f2ed]"
            style={{ fontFamily: 'Playfair Display Variable, serif', letterSpacing: '0.02em' }}
          >
            {title}
          </span>
          {headerExtra}
          <PinToggle pinned={pinned} onToggle={togglePin} />
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
            title="Close panel"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
    </div>
  );
}
