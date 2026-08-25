// /app/calendar — the whole calendar in one place: every matter deadline,
// every calendar entry, every list item with a due date, and whatever was
// imported from Google. The same component the matter tab and the list
// overlay use; only the scope differs (none here — everything the user
// can see).
//
// Like every other card it can be moved, resized from any edge, taken full
// screen, and pinned to the canvas so it stays up while you work in a list.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import CoverImage from '@/components/layout/CoverImage';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import CanvasPinToggle from '@/components/canvas/CanvasPinToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import ContextspacesCalendar from '@/components/calendar/ContextspacesCalendar';
import { CALENDAR_CARD_ID, type EmbeddableViewProps } from '@/lib/canvas';

const COVER_KEY = 'cs.calendar.cover';

export default function CalendarView({ embedded = false, onClose }: EmbeddableViewProps = {}) {
  const navigate = useNavigate();
  const { cardRef, toggleFullscreen } = useDraggableResizable(
    embedded ? undefined : 'cs.calendar.page',
    { boundToViewport: true },
  );
  const [cover, setCover] = useState<string | null>(() => {
    try { return localStorage.getItem(COVER_KEY); } catch { return null; }
  });

  const handleCover = (url: string | null) => {
    setCover(url);
    try {
      if (url) localStorage.setItem(COVER_KEY, url);
      else localStorage.removeItem(COVER_KEY);
    } catch { /* private mode — the cover is a device-local nicety */ }
  };

  // Inside a canvas panel the panel supplies the frame, ribbon and controls.
  if (embedded) {
    return (
      <div className="px-4 py-3">
        <ContextspacesCalendar />
      </div>
    );
  }

  return (
    <div>
      <CoverImage
        coverUrl={cover}
        onCoverChange={handleCover}
        editable={true}
        persistKey="cs.cover.calendar"
      />

      <div
        ref={cardRef}
        className="max-w-5xl mx-auto px-8 pt-0 pb-7 rounded-xl backdrop-blur-[30px] border border-[rgba(255,255,255,0.06)] my-8 cursor-grab select-none"
        style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
      >
        <div className="md:sticky md:top-0 z-20 flex items-center justify-between -mx-8 px-8 pt-6 pb-3 mb-3 rounded-t-xl border-b border-[rgba(255,255,255,0.08)] bg-[rgba(10,10,18,0.95)] backdrop-blur-[30px]">
          <button
            onClick={() => (onClose ? onClose() : navigate(-1))}
            className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
            title="Back"
          >
            <X size={14} strokeWidth={2} />
          </button>
          <div className="w-10 h-1 rounded-full bg-white/20 hover:bg-white/40 transition-colors" title="Drag to move" />
          <div className="flex items-center gap-1">
            <CanvasPinToggle kind="calendar" id={CALENDAR_CARD_ID} title="Calendar" />
            <FullscreenToggle onToggle={toggleFullscreen} />
          </div>
        </div>

        <h1 className="text-2xl font-bold text-[#f5f2ed] mb-1">Calendar</h1>
        <p className="text-[12px] text-white/45 mb-5">
          Deadlines from every matter, entries you add here, due dates from
          your lists, and anything imported from Google — one sheet.
        </p>

        <ContextspacesCalendar />
      </div>
    </div>
  );
}
