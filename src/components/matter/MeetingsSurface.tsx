import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Mic, ChevronRight } from 'lucide-react';
import {
  createMeeting,
  listMeetingsForMatter,
  type Meeting,
} from '@/lib/meetings/meetings';

type Props = { matterId: string };

export default function MeetingsSurface({ matterId }: Props) {
  const navigate = useNavigate();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const rows = await listMeetingsForMatter(matterId);
        if (!cancelled) setMeetings(rows);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [matterId]);

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const m = await createMeeting({ matterspaceId: matterId });
      navigate(`/app/m/${m.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create meeting');
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button
          onClick={handleCreate}
          disabled={creating}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[rgba(255,255,255,0.08)] text-[12px] text-white/80 hover:bg-[#1c1c26] hover:text-white transition-colors disabled:opacity-40"
        >
          <Plus size={12} strokeWidth={2} />
          {creating ? 'Starting…' : 'New meeting'}
        </button>
      </div>

      {error && <p className="text-[12px] text-red-300 mb-3">{error}</p>}

      {loading && (
        <p className="text-center text-[12px] text-white/40 py-8">Loading…</p>
      )}

      {!loading && meetings.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Mic size={28} className="text-white/20 mb-3" strokeWidth={1.5} />
          <p className="text-[13px] text-white/50 max-w-xs">
            No meetings yet. Click <span className="text-[#e8b84a]">New meeting</span> to start a live transcription tied to this matter.
          </p>
        </div>
      )}

      {!loading && meetings.length > 0 && (
        <div className="rounded-lg border border-[rgba(255,255,255,0.06)] overflow-hidden divide-y divide-[rgba(255,255,255,0.04)]">
          {meetings.map((m) => (
            <button
              key={m.id}
              onClick={() => navigate(`/app/m/${m.id}`)}
              className="flex items-center gap-3 w-full px-4 py-2.5 text-left hover:bg-[rgba(255,255,255,0.04)] transition-colors group"
            >
              <Mic
                size={14}
                className="text-[#d4a054] shrink-0"
                strokeWidth={1.75}
              />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-[#f5f1e8] truncate">
                  {m.title || formatDateTime(m.started_at)}
                </div>
                {m.title && (
                  <div className="text-[10px] text-white/40">
                    {formatDateTime(m.started_at)}
                  </div>
                )}
              </div>
              <span className="text-[10px] text-white/30 shrink-0">
                {statusLabel(m)}
              </span>
              <ChevronRight
                size={13}
                className="text-white/30 group-hover:text-[#e8b84a] transition-colors"
                strokeWidth={2}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function statusLabel(m: Meeting): string {
  if (m.status === 'active' && !m.ended_at) return 'live';
  if (m.ended_at) {
    const dur = new Date(m.ended_at).getTime() - new Date(m.started_at).getTime();
    const mins = Math.round(dur / 60_000);
    if (mins < 1) return '< 1 min';
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const rem = mins % 60;
    return `${h}h ${rem}m`;
  }
  return m.status;
}
