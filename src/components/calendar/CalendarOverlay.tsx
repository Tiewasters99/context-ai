// The calendar as a card you can pull over whatever you were reading —
// used by a list's "Calendar" button. Draggable, resizable and pinnable
// like every other Contextspaces card, with the ribbon handle that makes
// the drag affordance visible.

import { useEffect } from 'react';
import { X } from 'lucide-react';
import ModalPortal from '@/components/ui/ModalPortal';
import PinToggle from '@/components/ui/PinToggle';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import ContextspacesCalendar, {
  type ContextspacesCalendarProps,
} from '@/components/calendar/ContextspacesCalendar';

interface Props extends ContextspacesCalendarProps {
  title?: string;
  subtitle?: string;
  storageKey?: string;
  onClose: () => void;
}

export default function CalendarOverlay({
  title = 'Calendar',
  subtitle,
  storageKey = 'cs.calendar.overlay',
  onClose,
  ...calendarProps
}: Props) {
  const { cardRef, toggleFullscreen, pinned, togglePin } =
    useDraggableResizable(storageKey);

  // Escape closes. The backdrop deliberately does not — the card is
  // draggable, and a stray click outside it should not throw away where
  // the user put it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[60] bg-black/45 backdrop-blur-[2px] overflow-y-auto">
        <div
          ref={cardRef}
          className="max-w-5xl mx-auto my-10 px-6 py-5 rounded-xl border border-[rgba(255,255,255,0.1)] backdrop-blur-[30px] cursor-grab select-none"
          style={{ backgroundColor: 'rgba(10,10,16,0.95)' }}
        >
          <div className="flex items-center justify-between mb-3 -mt-1">
            <button
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
              title="Close"
            >
              <X size={14} strokeWidth={2} />
            </button>
            <div
              className="w-10 h-1 rounded-full bg-white/20 hover:bg-white/40 transition-colors"
              title="Drag to move"
            />
            <div className="flex items-center gap-1">
              <PinToggle pinned={pinned} onToggle={togglePin} />
              <FullscreenToggle onToggle={toggleFullscreen} />
            </div>
          </div>

          <div className="mb-3">
            <h2 className="text-[17px] font-bold text-[#f5f2ed] leading-tight">{title}</h2>
            {subtitle && <p className="text-[11px] text-white/45 mt-0.5">{subtitle}</p>}
          </div>

          <ContextspacesCalendar {...calendarProps} />
        </div>
      </div>
    </ModalPortal>
  );
}
