import { useEffect, useMemo, useRef, useState } from 'react';
import { FileArchive, FolderInput, Search, FileText, UploadCloud } from 'lucide-react';
import type { MatterRef } from '@/lib/vault-persist';
import {
  enqueueJob, uploadIntakeFile, listMatterDocumentsForProduction, MAX_MATTER_PICK_COUNT,
  type MatterDocumentChoice, type Production,
} from '@/lib/discovery';
import FloatingPanel from './FloatingPanel';

// Adding documents to a production that is not yet stamped: from the matter's
// own Vault (intake_documents, migration 110 — read server-side, nothing
// downloaded) or from the computer (intake_files / intake_zip). Used as the
// second step of New Production, and on its own from the Review Room, so a
// production created with "Skip for now" can still be filled, and one can
// grow before it is stamped.

const inputCls =
  'w-full rounded-md bg-[rgba(18,18,28,0.78)] border border-[rgba(255,255,255,0.1)] px-2.5 py-1.5 text-[12.5px] text-[#f0ebe3] placeholder:text-white/30 focus:outline-none focus:border-[#d4a054]/60 transition-colors';

export function AddDocumentsStep({
  matter,
  production,
  onDone,
  onSkip,
  skipLabel = 'Cancel',
}: {
  matter: MatterRef;
  production: Production;
  onDone: () => void;
  onSkip?: () => void;
  skipLabel?: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  // Documents already filed in this matter (110), or files from the computer.
  // An outgoing production is usually made of the matter's own documents, so
  // it opens on those; an incoming one arrives from outside.
  const [source, setSource] = useState<'matter' | 'computer'>(production.direction === 'outgoing' ? 'matter' : 'computer');
  const [error, setError] = useState<string | null>(null);
  const [matterDocs, setMatterDocs] = useState<MatterDocumentChoice[] | null>(null);
  const [matterDocsTruncated, setMatterDocsTruncated] = useState(false);
  const [matterDocsError, setMatterDocsError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (source !== 'matter' || matterDocs) return;
    let cancelled = false;
    listMatterDocumentsForProduction(matter.id)
      .then(({ docs, truncated }) => { if (!cancelled) { setMatterDocs(docs); setMatterDocsTruncated(truncated); } })
      .catch((e) => { if (!cancelled) setMatterDocsError(e instanceof Error ? e.message : 'Could not list the matter’s documents'); });
    return () => { cancelled = true; };
  }, [source, matterDocs, matter.id]);

  const visibleDocs = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!matterDocs) return [];
    return q
      ? matterDocs.filter((d) => d.title.toLowerCase().includes(q)
        || (d.source_filename ?? '').toLowerCase().includes(q) || (d.folder ?? '').toLowerCase().includes(q))
      : matterDocs;
  }, [matterDocs, filter]);
  const pickableVisible = visibleDocs.filter((d) => !d.blocked);
  const allVisiblePicked = pickableVisible.length > 0 && pickableVisible.every((d) => picked.has(d.id));

  const togglePick = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAllVisible = () => setPicked((prev) => {
    const next = new Set(prev);
    if (allVisiblePicked) for (const d of pickableVisible) next.delete(d.id);
    else for (const d of pickableVisible) next.add(d.id);
    return next;
  });

  const handleAddFromMatter = async () => {
    if (picked.size === 0 || uploading) return;
    if (picked.size > MAX_MATTER_PICK_COUNT) {
      setError(`Choose at most ${MAX_MATTER_PICK_COUNT.toLocaleString()} documents at a time.`);
      return;
    }
    setUploading(true);
    setError(null);
    try {
      // Keep the order the person sees: the list's order, not click order.
      const ids = (matterDocs ?? []).filter((d) => picked.has(d.id)).map((d) => d.id);
      await enqueueJob({
        matterspace_id: matter.id,
        production_id: production.id,
        job_type: 'intake_documents',
        payload: { document_ids: ids, ingest: false },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the documents');
      setUploading(false);
    }
  };

  const addFiles = (list: FileList | File[]) => {
    const arr = Array.from(list);
    setFiles((prev) => {
      const have = new Set(prev.map((f) => f.name + ':' + f.size));
      return [...prev, ...arr.filter((f) => !have.has(f.name + ':' + f.size))];
    });
  };

  const singleZip = files.length === 1 && /\.zip$/i.test(files[0].name);

  const handleIntake = async () => {
    if (files.length === 0 || uploading) return;
    setUploading(true);
    setError(null);
    setUploadedCount(0);
    try {
      const storagePaths: string[] = [];
      for (const f of files) {
        const path = await uploadIntakeFile(matter.id, production.id, f);
        storagePaths.push(path);
        setUploadedCount((n) => n + 1);
      }
      await enqueueJob({
        matterspace_id: matter.id,
        production_id: production.id,
        job_type: singleZip ? 'intake_zip' : 'intake_files',
        payload: { storage_paths: storagePaths, ingest: true },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Intake failed');
      setUploading(false);
    }
  };

  return (
    <div className="px-4 py-4 space-y-3 cursor-default">
      <div className="flex rounded-md border border-[rgba(255,255,255,0.1)] overflow-hidden" role="tablist" aria-label="Where the documents come from">
        {([['matter', 'From this matter'], ['computer', 'From your computer']] as const).map(([v, label]) => (
          <button
            key={v}
            role="tab"
            aria-selected={source === v}
            onClick={() => { setSource(v); setError(null); }}
            disabled={uploading}
            className={`flex-1 py-1.5 text-[11.5px] font-medium transition-colors ${
              source === v
                ? 'bg-[#d4a054]/20 text-[#e8b84a]'
                : 'text-white/55 hover:text-white hover:bg-[rgba(255,255,255,0.04)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {source === 'matter' && (
        <>
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name or folder"
              className={`${inputCls} pl-7`}
            />
          </div>
          {matterDocsError && <p className="text-[11px] text-red-300">{matterDocsError}</p>}
          {!matterDocs && !matterDocsError && (
            <p className="text-[11px] text-white/40 py-4 text-center">Loading the matter&rsquo;s documents…</p>
          )}
          {matterDocs && matterDocs.length === 0 && (
            <p className="text-[11px] text-white/45 py-4 text-center">
              No documents are filed in this matter yet. Use <span className="text-[#e8b84a]">From your computer</span>.
            </p>
          )}
          {matterDocs && matterDocs.length > 0 && (
            <>
              <div className="flex items-center justify-between text-[10.5px] text-white/45">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allVisiblePicked}
                    onChange={toggleAllVisible}
                    disabled={pickableVisible.length === 0 || uploading}
                    className="accent-[#d4a054]"
                  />
                  {filter.trim() ? 'Select all shown' : 'Select all'}
                </label>
                <span className="tabular-nums">{picked.size} of {matterDocs.length} chosen</span>
              </div>
              <div className="max-h-56 overflow-y-auto rounded-md border border-[rgba(255,255,255,0.08)] divide-y divide-[rgba(255,255,255,0.05)]">
                {visibleDocs.map((d) => (
                  <label
                    key={d.id}
                    className={`flex items-center gap-2 px-2.5 py-1.5 ${d.blocked ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer hover:bg-[rgba(255,255,255,0.03)]'}`}
                    title={d.blocked ?? d.source_filename ?? d.title}
                  >
                    <input
                      type="checkbox"
                      checked={picked.has(d.id)}
                      onChange={() => togglePick(d.id)}
                      disabled={Boolean(d.blocked) || uploading}
                      className="accent-[#d4a054] shrink-0"
                    />
                    <FileText size={11} className="text-[#d4a054]/70 shrink-0" />
                    <span className="text-[11px] text-white/75 truncate flex-1">
                      {d.title}
                      {d.folder && <span className="text-white/35"> · {d.folder}</span>}
                    </span>
                    <span className="text-[10px] text-white/35 tabular-nums shrink-0">
                      {d.blocked ?? (d.file_size_bytes != null ? `${(d.file_size_bytes / 1048576).toFixed(1)} MB` : '')}
                    </span>
                  </label>
                ))}
                {visibleDocs.length === 0 && (
                  <p className="text-[11px] text-white/40 px-2.5 py-3 text-center">Nothing matches the filter.</p>
                )}
              </div>
              {matterDocsTruncated && (
                <p className="text-[10.5px] text-amber-300/80">
                  This matter has more documents than the list can show at once. Use the filter to find the rest.
                </p>
              )}
            </>
          )}
          <p className="text-[10.5px] text-white/40 leading-relaxed">
            The documents are copied into this production on the server. Nothing is downloaded to your
            computer, and the originals stay where they are filed.
          </p>
        </>
      )}

      {source === 'computer' && (
        <>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
          onClick={() => fileInputRef.current?.click()}
          className={`rounded-lg border border-dashed px-4 py-7 text-center cursor-pointer transition-colors ${
            dragOver
              ? 'border-[#e8b84a]/70 bg-[#e8b84a]/8'
              : 'border-[rgba(255,255,255,0.18)] hover:border-[#e8b84a]/40 hover:bg-[rgba(255,255,255,0.02)]'
          }`}
        >
          <UploadCloud size={22} className="mx-auto text-white/30 mb-2" strokeWidth={1.5} />
          <p className="text-[12px] text-white/65">
            Drop a production <span className="text-[#e8b84a]">ZIP</span> or individual files here
          </p>
          <p className="text-[10.5px] text-white/35 mt-1">or click to browse</p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
          />
        </div>

        {files.length > 0 && (
          <div className="max-h-36 overflow-y-auto rounded-md border border-[rgba(255,255,255,0.08)] divide-y divide-[rgba(255,255,255,0.05)]">
            {files.map((f, i) => (
              <div key={f.name + i} className="flex items-center gap-2 px-2.5 py-1.5">
                <FileArchive size={11} className="text-[#d4a054]/70 shrink-0" />
                <span className="text-[11px] text-white/75 truncate flex-1">{f.name}</span>
                <span className="text-[10px] text-white/35 tabular-nums shrink-0">
                  {(f.size / 1048576).toFixed(1)} MB
                </span>
                {!uploading && (
                  <button
                    onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="text-white/35 hover:text-white text-[11px] leading-none"
                    title="Remove"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <p className="text-[10.5px] text-white/40 leading-relaxed">
          For files that are not in Contextspaces yet.
          {singleZip ? ' The ZIP will be unpacked automatically.' : ''} Each document will be
          prepared for review and also filed in the matter.
        </p>

        </>
      )}

      {error && <p className="text-[11px] text-red-300">{error}</p>}

      <div className="flex items-center justify-between pt-1">
        <button
          onClick={onSkip ?? onDone}
          className="text-[11.5px] text-white/45 hover:text-white/75 transition-colors"
        >
          {skipLabel}
        </button>
        {source === 'matter' ? (
          <button
            onClick={() => void handleAddFromMatter()}
            disabled={picked.size === 0 || uploading}
            className="px-4 py-1.5 rounded-lg bg-[#e8b84a]/15 hover:bg-[#e8b84a]/25 border border-[#e8b84a]/35 text-[#e8b84a] text-[12px] font-medium transition-colors disabled:opacity-40"
          >
            {uploading ? 'Adding…' : `Add ${picked.size} document${picked.size === 1 ? '' : 's'}`}
          </button>
        ) : (
          <button
            onClick={() => void handleIntake()}
            disabled={files.length === 0 || uploading}
            className="px-4 py-1.5 rounded-lg bg-[#e8b84a]/15 hover:bg-[#e8b84a]/25 border border-[#e8b84a]/35 text-[#e8b84a] text-[12px] font-medium transition-colors disabled:opacity-40"
          >
            {uploading
              ? `Uploading ${uploadedCount}/${files.length}…`
              : singleZip ? 'Upload ZIP' : `Upload ${files.length} file${files.length === 1 ? '' : 's'}`}
          </button>
        )}
      </div>
    </div>
  );
}

/** The same step in its own floating panel (Review Room → Add documents). */
export function AddDocumentsPanel({
  matter,
  production,
  onClose,
  onDone,
}: {
  matter: MatterRef;
  production: Production;
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <FloatingPanel
      title={`Add documents — ${production.name}`}
      icon={<FolderInput size={14} />}
      storageKey="cs.discovery.adddocs"
      defaultStyle={{ right: 48, top: 110, width: 400 }}
      onClose={onClose}
    >
      <AddDocumentsStep matter={matter} production={production} onDone={onDone} onSkip={onClose} skipLabel="Cancel" />
    </FloatingPanel>
  );
}
