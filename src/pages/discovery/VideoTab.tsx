import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Video, ChevronRight, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { listMatterDocuments } from '@/lib/vault-persist';
import { isVideoFilename, type AnalysisStatus } from '@/lib/video-discovery';

// The Video tab on a matter's Discovery page: every video recording filed in
// the matter, with where its analysis stands, each opening its Video Room.
// Rows come from the documents table under RLS; the analysis status from
// video_analyses under 119's select policy. No API call here.

interface Row { id: string; name: string; sizeBytes: number; status: AnalysisStatus | null }

const STATUS_LABEL: Record<AnalysisStatus, string> = {
  queued: 'queued', running: 'analysing', ready: 'analysed', error: 'analysis failed', held: 'held (sealed)',
};

export default function VideoTab({ matterId, matterKey }: { matterId: string; matterKey: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listMatterDocuments(matterId, { ceiling: 5000 });
        const videos = list.files.filter((f) => isVideoFilename(f.name) || isVideoFilename(f.storagePath));
        const ids = videos.map((v) => v.id);
        const statusById = new Map<string, AnalysisStatus>();
        if (ids.length) {
          const { data, error } = await supabase
            .from('video_analyses')
            .select('document_id, status, created_at')
            .in('document_id', ids)
            .order('created_at', { ascending: false });
          // A database without migration 119 yet: every recording shows as
          // "not analysed" rather than the tab failing wholesale.
          if (error && error.code !== 'PGRST205' && error.code !== '42P01') throw new Error(error.message);
          for (const a of (data ?? []) as { document_id: string; status: AnalysisStatus }[]) {
            if (!statusById.has(a.document_id)) statusById.set(a.document_id, a.status);
          }
        }
        if (cancelled) return;
        setRows(videos.map((v) => ({ id: v.id, name: v.name, sizeBytes: v.sizeBytes, status: statusById.get(v.id) ?? null })));
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Could not list the recordings.');
      }
    })();
    return () => { cancelled = true; };
  }, [matterId]);

  const base = location.pathname.startsWith('/app') ? '/app/discovery/video' : '/discovery/video';

  if (err) return <p className="text-sm text-red-300">{err}</p>;
  if (!rows) return <p className="text-center text-[12px] text-white/40 py-10 inline-flex items-center gap-2 w-full justify-center"><Loader2 size={13} className="animate-spin" /> Looking for recordings…</p>;
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-14 text-center">
        <Video size={30} className="text-white/20 mb-3" strokeWidth={1.5} />
        <p className="text-[13px] text-white/50 max-w-sm">
          No video recordings are filed in this matter yet. Upload one to the Vault (.mp4, .mov, .webm and similar) and it appears here.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-[rgba(255,255,255,0.14)] overflow-hidden divide-y divide-[rgba(255,255,255,0.07)]">
      {rows.map((r) => (
        <div key={r.id} onClick={() => navigate(`${base}/${r.id}?matter=${encodeURIComponent(matterKey)}`)}
          className="px-4 py-3 hover:bg-[rgba(255,255,255,0.04)] transition-colors cursor-pointer group flex items-center gap-3 min-w-0">
          <Video size={15} className="text-[#d4a054] shrink-0" />
          <span className="text-[13.5px] text-[#f5f1e8] font-medium truncate flex-1 min-w-0">{r.name}</span>
          <span className="text-[11px] text-white/45 shrink-0">{(r.sizeBytes / 1e6).toFixed(0)} MB</span>
          <span className={`text-[11px] px-2 py-0.5 rounded border shrink-0 ${
            r.status === 'ready' ? 'border-emerald-400/30 text-emerald-200 bg-emerald-500/10'
              : r.status === 'running' || r.status === 'queued' ? 'border-[#d4a054]/40 text-[#e8b84a] bg-[#d4a054]/10'
                : r.status === 'error' || r.status === 'held' ? 'border-amber-400/30 text-amber-200 bg-amber-500/10'
                  : 'border-white/15 text-white/50'}`}>
            {r.status ? STATUS_LABEL[r.status] : 'not analysed'}
          </span>
          <ChevronRight size={13} className="text-white/30 group-hover:text-[#e8b84a] transition-colors shrink-0" strokeWidth={2} />
        </div>
      ))}
    </div>
  );
}
