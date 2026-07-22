import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FolderTree } from 'lucide-react';
import { useServerspaces } from '@/hooks/useServerspaces';
import BucketizerSurface from '@/components/matter/BucketizerSurface';

// The Bucketizer — a Productivity Suite tool, not a matter feature. Matters
// *call* it: the matter card's Bucketizer tab navigates here with
// ?matter=<id>, and the picker below serves direct visits. The tool then
// operates on that matter's case-theory tree and document corpus.

export default function BucketizerHome() {
  const [searchParams, setSearchParams] = useSearchParams();
  const matterId = searchParams.get('matter') ?? '';

  const { data: serverspaces = [] } = useServerspaces();
  const matterOptions = useMemo(
    () =>
      serverspaces.flatMap((s) =>
        s.matterspaces.map((m) => ({ id: m.id, label: `${s.name} / ${m.name}` })),
      ),
    [serverspaces],
  );

  const selected = matterOptions.find((m) => m.id === matterId);

  // Drop a stale ?matter= that doesn't resolve to an accessible matter.
  useEffect(() => {
    if (matterId && matterOptions.length && !selected) {
      setSearchParams({}, { replace: true });
    }
  }, [matterId, matterOptions.length, selected, setSearchParams]);

  return (
    <div className="max-w-6xl mx-auto px-8 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
        <div>
          <h1 className="font-display text-[28px] tracking-tight text-white flex items-center gap-3">
            <FolderTree className="w-6 h-6 text-[#d4a054]" /> Bucketizer
          </h1>
          <p className="text-[13px] text-white/45 mt-1.5 max-w-xl">
            Your case theory as a living tree — claims, elements to prove, subissues, themes —
            with every document classified into it. AI-proposed, attorney-confirmed.
          </p>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-white/40">Matter</span>
          <select
            value={selected ? matterId : ''}
            onChange={(e) => setSearchParams(e.target.value ? { matter: e.target.value } : {})}
            className="min-w-[260px] rounded-lg border border-white/10 bg-[#14141c] px-3 py-2 text-sm text-zinc-200 focus:border-[#d4a054]/50 focus:outline-none"
          >
            <option value="">Select a matter…</option>
            {matterOptions.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>
      </div>

      {selected ? (
        <BucketizerSurface key={matterId} matterId={matterId} />
      ) : (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] px-6 py-14 text-center">
          <FolderTree className="mx-auto mb-3 w-8 h-8 text-[#d4a054]/60" />
          <p className="text-zinc-300">Pick a matter to open its case-theory tree.</p>
          <p className="mt-1 text-sm text-zinc-500">
            Or open any matter card and press its Bucketizer tab to land here with the matter preloaded.
          </p>
        </div>
      )}
    </div>
  );
}
