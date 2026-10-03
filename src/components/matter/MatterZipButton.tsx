// "Download files (.zip)" on the matter's toolbar: every stored file in this
// matter as one archive, made in the browser (lib/matter-zip.ts). The button
// is its own progress line while it runs — "Reading 7 of 15 · JA Vol VII…",
// then "Packing…" — and a Stop. Sub-matters are not included: an appendix set
// is one matter, and a case's whole tree can be gigabytes.

import { useEffect, useRef, useState } from 'react';
import { FolderDown, Loader2, X } from 'lucide-react';
import { downloadMatterZip, type ZipProgress } from '@/lib/matter-zip';

const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(n >= 100 * 1048576 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function MatterZipButton({ matterId, matterName }: { matterId: string; matterName: string }) {
  const [progress, setProgress] = useState<ZipProgress | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const run = async () => {
    if (progress) return;
    setNote(null);
    const ac = new AbortController(); abort.current = ac;
    try {
      const r = await downloadMatterZip({ id: matterId, name: matterName }, setProgress, { signal: ac.signal });
      setNote(r.files
        ? `${r.files} file${r.files === 1 ? '' : 's'}, ${mb(r.bytes)}${r.skipped.length ? `; ${r.skipped.length} without a stored file left out (listed in manifest.txt)` : ''}.`
        : 'This matter has no stored files to download.');
    } catch (e) {
      setNote((e as Error).message === 'Stopped.' ? 'Stopped; nothing was downloaded.' : `The archive could not be made: ${(e as Error).message}`);
    } finally {
      setProgress(null); abort.current = null;
    }
  };

  if (progress) {
    const label = progress.phase === 'listing' ? 'Listing the files…'
      : progress.phase === 'reading' ? `Reading ${progress.done + 1} of ${progress.total}${progress.current ? ` · ${progress.current}` : ''}`
        : progress.phase === 'packing' ? `Packing ${progress.total} files, ${mb(progress.bytes)}…` : 'Done';
    return (
      <span className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[#e8b84a]/30 bg-[#e8b84a]/10 text-[12px] text-[#e8b84a] max-w-[360px]" role="status">
        <Loader2 size={14} className="animate-spin shrink-0" />
        <span className="truncate">{label}</span>
        <button onClick={() => abort.current?.abort()} className="shrink-0 text-[#e8b84a]/70 hover:text-[#e8b84a]" title="Stop" aria-label="Stop the download">
          <X size={13} />
        </button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={() => void run()}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#e8b84a]/10 hover:bg-[#e8b84a]/20 border border-[#e8b84a]/30 text-[#e8b84a] text-[13px] font-medium transition-colors"
        title="Every stored file in this matter (not its sub-matters) as one .zip, made in your browser — for filing or for co-counsel"
        data-testid="matter-zip"
      >
        <FolderDown size={15} strokeWidth={1.75} />
        Download files (.zip)
      </button>
      {note && <span className="text-[12px] text-white/55 max-w-[320px]">{note}</span>}
    </span>
  );
}
