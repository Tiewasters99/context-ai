import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, Plus, ChevronRight } from 'lucide-react';
import {
  createMeeting,
  listMyMeetings,
  type Meeting,
} from '@/lib/meetings/meetings';

// Connect home — the list of meetings the user has captured. This is what
// a Connect-only user lands on after sign-in. The "+ New meeting" button
// creates an unlinked meeting (matterspace_id null — RLS scopes to owner)
// and routes straight into /connect/m/:id.
export default function ConnectMeetings() {
  const navigate = useNavigate();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listMyMeetings();
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
  }, []);

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const m = await createMeeting({});
      navigate(`/connect/m/${m.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create meeting');
      setCreating(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-5 py-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-semibold text-[var(--color-text-bright)] tracking-tight">
          Your meetings
        </h1>
        <button
          onClick={handleCreate}
          disabled={creating}
          className="flex items-center gap-1.5 h-10 px-4 rounded-xl bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-[#1a1408] text-sm font-semibold disabled:opacity-50 transition"
        >
          <Plus size={15} strokeWidth={2.25} />
          {creating ? 'Starting…' : 'New meeting'}
        </button>
      </div>

      {error && (
        <p className="text-[12px] text-red-300 mb-4">{error}</p>
      )}

      {loading && (
        <p className="text-center text-[13px] text-white/40 py-10">Loading…</p>
      )}

      {!loading && meetings.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Mic size={36} className="text-white/15 mb-4" strokeWidth={1.5} />
          <p className="text-[14px] text-white/55 max-w-sm">
            No meetings yet. Tap <span className="text-[var(--color-primary)]">New meeting</span> to start a live transcription.
          </p>
        </div>
      )}

      {!loading && meetings.length > 0 && (
        <div className="rounded-xl border border-[rgba(255,255,255,0.14)] overflow-hidden divide-y divide-[rgba(255,255,255,0.08)] bg-[rgba(10,10,16,0.5)]">
          {meetings.map((m) => (
            <button
              key={m.id}
              onClick={() => navigate(`/connect/m/${m.id}`)}
              className="flex items-center gap-3 w-full px-4 py-3 text-left hover:bg-[rgba(255,255,255,0.04)] transition-colors group"
            >
              <Mic
                size={16}
                className="text-[var(--color-primary)] shrink-0"
                strokeWidth={1.75}
              />
              <div className="flex-1 min-w-0">
                <div className="text-[14px] text-[var(--color-text-bright)] truncate">
                  {m.title || formatDateTime(m.started_at)}
                </div>
                {m.title && (
                  <div className="text-[11px] text-white/40">
                    {formatDateTime(m.started_at)}
                  </div>
                )}
              </div>
              <span className="text-[11px] text-white/35 shrink-0">
                {statusLabel(m)}
              </span>
              <ChevronRight
                size={14}
                className="text-white/30 group-hover:text-[var(--color-primary)] transition-colors"
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
