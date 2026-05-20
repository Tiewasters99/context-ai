// Dashboard widget — upcoming deadlines and events across every matter
// the user can see. Reads matter_events (migration 025) globally,
// filters to not-yet-passed, not-completed, soonest first.

import { useNavigate } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { useMatterEvents } from '@/hooks/useMatterEvents';

const todayStr = () => new Date().toISOString().slice(0, 10);

function formatDate(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export default function UpcomingDeadlines({
  matterNames,
  maxItems = 6,
}: {
  matterNames: Map<string, string>;
  maxItems?: number;
}) {
  const navigate = useNavigate();
  const { data: events = [], isLoading } = useMatterEvents(undefined);

  const today = todayStr();
  const upcoming = events
    .filter((e) => !e.completed_at && e.event_date >= today)
    .sort((a, b) =>
      (a.event_date + (a.event_time ?? '24:00')).localeCompare(
        b.event_date + (b.event_time ?? '24:00'),
      ),
    )
    .slice(0, maxItems);

  if (isLoading) return null;

  if (upcoming.length === 0) {
    return (
      <p className="text-[13px] text-white/40">
        No upcoming deadlines. Add them from any matter's Calendar tab.
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-[rgba(255,255,255,0.14)] overflow-hidden divide-y divide-[rgba(255,255,255,0.06)]">
      {upcoming.map((e) => (
        <button
          key={e.id}
          onClick={() =>
            navigate(`/app/matterspace/${e.matterspace_id}?tab=Calendar`)
          }
          className="flex items-center gap-3 w-full px-4 py-2.5 text-left hover:bg-[rgba(255,255,255,0.04)] transition-colors"
        >
          <CalendarClock
            size={14}
            className="text-[#d4a054] shrink-0"
            strokeWidth={1.75}
          />
          <span className="w-[56px] shrink-0 text-[12px] text-white/60">
            {formatDate(e.event_date)}
          </span>
          <span className="flex-1 min-w-0 text-[13px] text-[#f5f1e8] truncate">
            {e.title}
          </span>
          <span className="text-[11px] text-white/40 shrink-0 truncate max-w-[120px]">
            {matterNames.get(e.matterspace_id) ?? ''}
          </span>
        </button>
      ))}
    </div>
  );
}
