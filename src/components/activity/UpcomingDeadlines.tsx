// Dashboard widget — what is coming, across everything the user can see.
//
// It used to read matter_events alone. It now reads the same merged feed
// the calendar draws from (matter deadlines + calendar entries + list
// item due dates), so the dashboard and the calendar can never disagree.

import { useNavigate } from 'react-router-dom';
import { CalendarClock, ListChecks } from 'lucide-react';
import { useCalendarFeed, todayStr } from '@/hooks/useCalendarEvents';

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
  const { entries, isLoading } = useCalendarFeed();

  const today = todayStr();
  const upcoming = entries
    .filter((e) => !e.done && e.startDate >= today)
    .slice(0, maxItems);

  if (isLoading) return null;

  if (upcoming.length === 0) {
    return (
      <p className="text-[13px] text-white/40">
        Nothing ahead.{' '}
        <button
          onClick={() => navigate('/app/calendar')}
          className="text-[#e8b84a] hover:underline"
        >
          Open the calendar
        </button>{' '}
        to add a deadline or import from Google.
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-[rgba(255,255,255,0.14)] overflow-hidden divide-y divide-[rgba(255,255,255,0.06)]">
      {upcoming.map((e) => {
        const Icon = e.kind === 'list_due' ? ListChecks : CalendarClock;
        const target =
          e.kind === 'list_due' && e.link
            ? e.link
            : e.matterId
              ? `/app/matterspace/${e.matterId}?tab=Calendar`
              : '/app/calendar';
        return (
          <button
            key={e.key}
            onClick={() => navigate(target)}
            className="flex items-center gap-3 w-full px-4 py-2.5 text-left hover:bg-[rgba(255,255,255,0.04)] transition-colors"
          >
            <Icon size={14} className="text-[#d4a054] shrink-0" strokeWidth={1.75} />
            <span className="w-[56px] shrink-0 text-[12px] text-white/60">
              {formatDate(e.startDate)}
            </span>
            <span className="flex-1 min-w-0 text-[13px] text-[#f5f1e8] truncate">
              {e.title}
            </span>
            <span className="text-[11px] text-white/40 shrink-0 truncate max-w-[120px]">
              {e.matterId ? (matterNames.get(e.matterId) ?? '') : e.kind === 'list_due' ? (e.notes ?? '') : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}
