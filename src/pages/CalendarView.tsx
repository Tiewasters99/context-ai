// /app/calendar — the whole calendar in one place: every matter deadline,
// every calendar entry, every list item with a due date, and whatever was
// imported from Google. The same component the matter tab and the list
// overlay use; only the scope differs (none here — everything the user
// can see).

import { useState } from 'react';
import CoverImage from '@/components/layout/CoverImage';
import FullscreenToggle from '@/components/ui/FullscreenToggle';
import PinToggle from '@/components/ui/PinToggle';
import { useDraggableResizable } from '@/hooks/useDraggableResizable';
import ContextspacesCalendar from '@/components/calendar/ContextspacesCalendar';

const COVER_KEY = 'cs.calendar.cover';

export default function CalendarView() {
  const { cardRef, toggleFullscreen, pinned, togglePin } =
    useDraggableResizable('cs.calendar.page');
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
        className="max-w-5xl mx-auto px-8 py-7 rounded-xl backdrop-blur-[30px] border border-[rgba(255,255,255,0.06)] my-8 cursor-grab select-none"
        style={{ backgroundColor: 'rgba(8,8,14,0.8)' }}
      >
        <div className="flex items-center justify-between mb-3 -mt-1">
          <span className="text-[11px] uppercase tracking-wider text-white/35">
            Calendar
          </span>
          <div className="w-10 h-1 rounded-full bg-white/20 hover:bg-white/40 transition-colors" title="Drag to move" />
          <div className="flex items-center gap-1">
            <PinToggle pinned={pinned} onToggle={togglePin} />
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
