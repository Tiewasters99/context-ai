// The shared activity feed — renders the activity_feed view (migration 024)
// as a day-grouped, clickable stream. Used by the per-matter Updates tab
// (matterId set) and the Dashboard cross-matter feed (matterId undefined,
// matterNames supplied so each row can show which matter it belongs to).

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileText,
  List as ListIcon,
  Table as TableIcon,
  MessageSquare,
  CheckCircle2,
  Mic,
  Activity,
} from 'lucide-react';
import { useActivityFeed, type ActivityEvent } from '@/hooks/useActivityFeed';

interface Props {
  // When set, shows one matter's activity. When omitted, shows the
  // cross-matter feed and uses matterNames to label each row.
  matterId?: string;
  matterNames?: Map<string, string>;
  // Cap the number of rendered rows (the Dashboard shows a short feed).
  maxItems?: number;
}

const ICON: Record<string, typeof FileText> = {
  document_uploaded: FileText,
  page_created: FileText,
  list_created: ListIcon,
  table_created: TableIcon,
  comment_posted: MessageSquare,
  cite_check_completed: CheckCircle2,
  meeting_started: Mic,
  meeting_ended: Mic,
};

export function describe(e: ActivityEvent): string {
  const who = e.actor_name || 'Someone';
  switch (e.event_type) {
    case 'document_uploaded':    return `${who} uploaded ${e.title}`;
    case 'page_created':         return `${who} created the page “${e.title}”`;
    case 'list_created':         return `${who} created the list “${e.title}”`;
    case 'table_created':        return `${who} created the table “${e.title}”`;
    case 'comment_posted':       return `${who} commented: “${e.title}”`;
    case 'cite_check_completed': return `Cite-check completed on ${e.title}`;
    case 'meeting_started':      return `${who} started the meeting “${e.title}”`;
    case 'meeting_ended':        return `Meeting “${e.title}” ended`;
    default:                     return e.title;
  }
}

function routeFor(e: ActivityEvent): string {
  switch (e.event_type) {
    case 'document_uploaded':    return `/app/document/${e.ref_id}`;
    case 'page_created':         return `/app/page/${e.ref_id}`;
    case 'list_created':         return `/app/list/${e.ref_id}`;
    case 'table_created':        return `/app/table/${e.ref_id}`;
    case 'comment_posted':       return `/app/matterspace/${e.matter_id}?tab=Thread`;
    case 'cite_check_completed': return `/app/matterspace/${e.matter_id}?tab=Cite-Check`;
    case 'meeting_started':
    case 'meeting_ended':        return `/app/m/${e.ref_id}`;
    default:                     return `/app/matterspace/${e.matter_id}`;
  }
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dayBucket(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}

export default function ActivityFeed({ matterId, matterNames, maxItems }: Props) {
  const navigate = useNavigate();
  const { data: events = [], isLoading, error } = useActivityFeed(matterId);

  const groups = useMemo(() => {
    const shown = maxItems ? events.slice(0, maxItems) : events;
    const out: { label: string; items: ActivityEvent[] }[] = [];
    for (const e of shown) {
      const label = dayBucket(e.occurred_at);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(e);
      else out.push({ label, items: [e] });
    }
    return out;
  }, [events, maxItems]);

  if (isLoading) {
    return <p className="text-[13px] text-white/40 py-8 text-center">Loading activity…</p>;
  }
  if (error) {
    return (
      <p className="text-[13px] text-red-300 py-8 text-center">
        {error instanceof Error ? error.message : 'Failed to load activity'}
      </p>
    );
  }
  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Activity size={26} className="text-white/20 mb-3" strokeWidth={1.5} />
        <p className="text-[13px] text-white/50">
          No activity yet. Uploads, pages, comments, cite-checks, and meetings show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#8a8693] mb-2 px-1">
            {g.label}
          </div>
          <div className="rounded-lg border border-[rgba(255,255,255,0.14)] overflow-hidden divide-y divide-[rgba(255,255,255,0.06)]">
            {g.items.map((e, i) => {
              const Icon = ICON[e.event_type] ?? Activity;
              const matterLabel =
                !matterId && matterNames ? matterNames.get(e.matter_id) : null;
              return (
                <button
                  key={`${e.event_type}-${e.ref_id}-${e.occurred_at}-${i}`}
                  onClick={() => navigate(routeFor(e))}
                  className="flex items-start gap-3 w-full px-4 py-2.5 text-left hover:bg-[rgba(255,255,255,0.04)] transition-colors"
                >
                  <span className="mt-0.5 w-7 h-7 rounded-full bg-[#d4a054]/10 flex items-center justify-center shrink-0">
                    <Icon size={13} className="text-[#d4a054]" strokeWidth={1.75} />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13px] text-[#f5f1e8] leading-snug truncate">
                      {describe(e)}
                    </span>
                    <span className="text-[11px] text-white/40">
                      {relativeTime(e.occurred_at)}
                      {matterLabel && <> · {matterLabel}</>}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
