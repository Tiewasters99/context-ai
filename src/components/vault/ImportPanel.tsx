import { useState, useRef, useCallback, useMemo } from 'react';
import { Upload, FolderOpen, FileText, X, Loader2, CheckCircle, Search, AlertCircle, ChevronDown, ChevronRight, Folder, RefreshCw } from 'lucide-react';
import type { VaultFile } from '@/lib/vault-types';
import { describeTextStatus, describeOcrPending } from '../../../lib/ingest-formats.mjs';
import { ingestServiceNotice, type IngestServiceStatus } from '@/lib/ingest-service-notice';
import ContentSearch from './ContentSearch';

interface ImportPanelProps {
  files: VaultFile[];
  onAddFiles: (files: FileList | File[]) => void;
  onRemoveFile: (id: string) => void;
  /** Re-run ingestion for an errored file (persistent mode only). */
  onRetryFile?: (id: string) => void;
  /** Open a file in the document reader/editor. */
  onOpenFile?: (file: VaultFile) => void;
  /** Open a document (by id, from a content-search hit) without leaving this panel. */
  onOpenDocument?: (documentId: string) => void;
  /** Persistent mode: scope content search to this matter tree. */
  matterId?: string;
  /**
   * Whether the ingestion pipeline is actually running (migration 066), or
   * null when it cannot be known — which is the state before 066 is applied,
   * and the state this panel must treat exactly as it treated everything
   * before this prop existed: spinner, no extra words.
   */
  ingestService?: IngestServiceStatus | null;
  /**
   * What the server says this matter tree holds. Equal to `files.length`
   * whenever the list is whole; larger when the paged read stopped at its
   * ceiling. The header shows THIS, because a badge that counts the rows it
   * happens to have is the same silent lie pagination was added to remove.
   */
  totalCount?: number;
  /** Set only when the read was truncated: the sentence the list owes the reader. */
  listNotice?: string | null;
}

/**
 * How many rows are PAINTED at once. The fetch is complete — every row is in
 * `files` and every filter, count and total below is computed over all of
 * them — but a row is about eight DOM nodes with its own drag handlers, and
 * `renderFileRow` is not memoized, so a status tick re-renders every row that
 * is on screen. Twelve thousand of them is roughly a hundred thousand nodes
 * and a tab that stops answering. Nothing is hidden silently: the line under
 * the list says how many of how many are drawn, the filter searches all of
 * them, and "Show more" draws the next batch.
 *
 * Drawing only the rows in the viewport (virtualization) is the right answer
 * and belongs to the planned Vault rebuild, which is replacing this panel.
 */
const RENDER_WINDOW = 500;

const statusIcon = {
  uploading: <Loader2 size={14} className="text-[#e8b84a] animate-spin" />,
  indexing: <Loader2 size={14} className="text-[#e8b84a] animate-spin" />,
  indexed: <CheckCircle size={14} className="text-emerald-400" />,
  error: <AlertCircle size={14} className="text-red-400" />,
};

// What the pipeline is doing, in the words a person would use. Keyed by
// documents.processing_status (VaultFile.stage).
const stageLabel: Record<string, string> = {
  pending: 'queued',
  extracting: 'extracting text',
  chunking: 'splitting into passages',
  embedding: 'indexing for search',
};

// The row's one-line status. Three honest states for a live upload, in order:
//   Uploading…                          — the browser is still sending bytes
//   Uploaded — processing: <stage>      — bytes landed; the server is at work
//   Ready / Stored — <reason> / Error   — terminal
// Before 2026-09-04 everything before 'embedding' read "Uploading..." — for
// as long as forty-five minutes on a big scan, with the bytes long since safe.
function statusLabel(file: VaultFile): string {
  if (file.status === 'indexed') {
    // Pages still awaiting OCR (Phase 2): searchable for the typed pages, so
    // "Ready — 3 pages awaiting OCR"; or, with nothing read yet, "Stored —".
    if (file.ocrPending) {
      const p = describeOcrPending(file.ocrPending);
      if (p) return `${file.textStatus ? 'Stored' : 'Ready'} — ${p.label}`;
    }
    return file.textStatus ? `Stored — ${describeTextStatus(file.textStatus).label}` : 'Ready';
  }
  if (file.status === 'error') return file.held ? 'Held' : file.errorMessage ? 'Failed' : 'Error';
  if (file.errorMessage) return 'Retrying…';
  // Ephemeral mode (no matter): nothing is uploaded anywhere — the browser
  // reads the file itself. Say that, not "Uploading".
  if (!file.matterspace_id) return file.status === 'indexing' ? 'Extracting text…' : 'Queued…';
  // A large file goes up in resumable chunks (Phase 4) and says how far it
  // is; a dropped connection picks up where it stopped, and the number keeps
  // climbing instead of restarting.
  if (!file.storagePath) return file.uploadPct != null ? `Uploading… ${file.uploadPct}%` : 'Uploading…';
  const stage = file.stage ? (stageLabel[file.stage] ?? file.stage) : (file.status === 'indexing' ? 'indexing for search' : 'starting');
  return `Uploaded — processing: ${stage}`;
}

// Translate raw pipeline errors into something a user can act on. The raw
// message is still available on hover (title attr) for debugging.
function friendlyIngestError(msg: string): string {
  // The worker's per-attempt notes ("Attempt 1 of 3 failed — …") and the
  // pipeline's own "Scanned PDF — OCR not configured …" are already written
  // for people, fix included; pass them through untouched.
  if (/^Attempt \d+ of \d+ failed/.test(msg)) return msg;
  if (/OCR not configured/i.test(msg)) return msg;
  const m = msg.toLowerCase();
  if (m.includes('dunning') || m.includes('billing blocked')) {
    return 'Google (Gemini) billing is blocked — pay the past-due balance in Google Cloud; this retries on its own.';
  }
  if (m.includes('no passages extracted')) {
    return 'No readable text found — likely a scanned or image-only file. Retry runs OCR.';
  }
  if (m.includes('statement timeout') || m.includes('timed out') || m.includes('504')) {
    return 'Processing timed out — the file may be very large. Retry, or split it.';
  }
  if (m.includes('embed') && m.includes('token')) {
    return 'File too dense to index in one pass — Retry after the pipeline update.';
  }
  if (m.includes('drm')) return 'This file is DRM-protected and cannot be indexed.';
  if (m.includes('download:')) return 'Stored file could not be read back — try re-uploading.';
  return msg;
}

export default function ImportPanel({ files, onAddFiles, onRemoveFile, onRetryFile, onOpenFile, onOpenDocument, matterId, ingestService = null, totalCount, listNotice }: ImportPanelProps) {
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(RENDER_WINDOW);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const readDirectory = useCallback(async (entry: FileSystemDirectoryEntry): Promise<File[]> => {
    const files: File[] = [];

    const readAllEntries = (dirEntry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> => {
      return new Promise((resolve) => {
        const reader = dirEntry.createReader();
        const allEntries: FileSystemEntry[] = [];
        const readBatch = () => {
          reader.readEntries((entries) => {
            if (entries.length === 0) {
              resolve(allEntries);
            } else {
              allEntries.push(...entries);
              readBatch(); // Keep reading until empty (API returns max 100 per batch)
            }
          }, () => resolve(allEntries)); // On error, return what we have
        };
        readBatch();
      });
    };

    const entries = await readAllEntries(entry);

    for (const child of entries) {
      try {
        if (child.isFile) {
          const file = await new Promise<File>((resolve, reject) =>
            (child as FileSystemFileEntry).file(resolve, reject)
          );
          Object.defineProperty(file, 'webkitRelativePath', { value: child.fullPath.slice(1) });
          files.push(file);
        } else if (child.isDirectory) {
          const subFiles = await readDirectory(child as FileSystemDirectoryEntry);
          files.push(...subFiles);
        }
      } catch {
        // Skip files that can't be read (e.g., system files)
      }
    }
    return files;
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);

    const items = e.dataTransfer.items;
    const dtFiles = e.dataTransfer.files;

    // Try the Entry API first (supports folders)
    if (items && items.length > 0) {
      const entries: FileSystemEntry[] = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }

      if (entries.length > 0) {
        const allFiles: File[] = [];
        for (const entry of entries) {
          if (entry.isFile) {
            const file = await new Promise<File>((resolve) =>
              (entry as FileSystemFileEntry).file(resolve)
            );
            allFiles.push(file);
          } else if (entry.isDirectory) {
            const dirFiles = await readDirectory(entry as FileSystemDirectoryEntry);
            allFiles.push(...dirFiles);
          }
        }
        if (allFiles.length > 0) { onAddFiles(allFiles); return; }
      }
    }

    // Fallback: plain file list (no folder support)
    if (dtFiles && dtFiles.length > 0) {
      onAddFiles(dtFiles);
    }
  }, [onAddFiles, readDirectory]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) onAddFiles(e.target.files);
    e.target.value = '';
  };

  const filtered = search
    ? files.filter((f) => f.name.toLowerCase().includes(search.toLowerCase()))
    : files;

  // Group by matter when persistent-mode files are tagged with matterspace
  // metadata. Multiple distinct matters → render collapsible groups; one
  // matter (or none) → fall back to the flat list. Group order: insertion
  // order of first-seen matter, which mirrors the recency sort from the
  // documents query.
  const groups = useMemo(() => {
    const tagged = filtered.filter((f) => f.matterspace_id);
    if (tagged.length === 0) return null;
    const distinct = new Set(tagged.map((f) => f.matterspace_id));
    if (distinct.size <= 1) return null;
    const map = new Map<string, { name: string; files: VaultFile[] }>();
    for (const f of filtered) {
      const id = f.matterspace_id ?? '__untagged__';
      const name = f.matterspace_name ?? '(unknown matter)';
      if (!map.has(id)) map.set(id, { name, files: [] });
      map.get(id)!.files.push(f);
    }
    return Array.from(map.entries()).map(([id, v]) => ({ id, ...v }));
  }, [filtered]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (id: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // How many rows each group may draw, taken from one shared budget in group
  // order. Every group keeps its header and its TRUE count; only the rows
  // inside are windowed, so no folder ever vanishes from the list.
  const groupTake = useMemo(() => {
    if (!groups) return null;
    let budget = shown;
    const take = new Map<string, number>();
    for (const g of groups) {
      if (collapsedGroups.has(g.id)) { take.set(g.id, 0); continue; }
      const n = Math.min(g.files.length, Math.max(0, budget));
      take.set(g.id, n);
      budget -= n;
    }
    return take;
  }, [groups, shown, collapsedGroups]);

  // Rows actually drawn, and rows there are to draw — the two numbers the
  // "Show more" line reports.
  const drawable = groups
    ? groups.reduce((n, g) => n + (collapsedGroups.has(g.id) ? 0 : g.files.length), 0)
    : filtered.length;
  const drawn = groupTake
    ? groups!.reduce((n, g) => n + (groupTake.get(g.id) ?? 0), 0)
    : Math.min(shown, filtered.length);

  const totalSize = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  const indexedCount = files.filter((f) => f.status === 'indexed').length;
  const formatSize = (bytes: number) =>
    bytes > 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` :
    bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` :
    `${(bytes / 1024).toFixed(0)} KB`;

  const openable = (file: VaultFile) =>
    !!onOpenFile && (file.status === 'indexed' || file.status === 'error');

  // One sentence, computed once for the whole panel: every document waiting on
  // the pipeline is waiting on the same pipeline, so the answer cannot differ
  // between rows. Null while everything is normal, and null whenever the
  // pipeline's state cannot be known — which is what makes this change
  // invisible until migration 066 is applied.
  const serviceNotice = useMemo(() => ingestServiceNotice(ingestService), [ingestService]);

  const renderFileRow = (file: VaultFile) => {
    const canOpen = openable(file);
    // Only on a row that is genuinely waiting on the SERVER: bytes have landed
    // (storagePath) and no terminal state has been reached. A file still
    // uploading from this browser is not the pipeline's business, and an
    // ephemeral no-matter file never reaches the pipeline at all.
    const showServiceNotice = Boolean(
      serviceNotice && file.matterspace_id && file.storagePath &&
      (file.status === 'uploading' || file.status === 'indexing'),
    );
    return (
    <div
      key={file.id}
      draggable={!!file.matterspace_id}
      onDragStart={(e) => {
        if (!file.matterspace_id) return;
        // The Vault rail's matter rows read this on drop and call the
        // move endpoint. Plain JSON over text/plain works across panels
        // without needing a shared DndContext.
        e.dataTransfer.setData(
          'application/x-cs-vault-file',
          JSON.stringify({ docId: file.id, fromMatterId: file.matterspace_id }),
        );
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => { if (canOpen) onOpenFile!(file); }}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[rgba(255,255,255,0.03)] transition-colors group ${
        canOpen ? 'cursor-pointer' : file.matterspace_id ? 'cursor-grab active:cursor-grabbing' : ''
      }`}
      title={canOpen ? 'Open document' : file.matterspace_id ? 'Drag to a matter in the rail to move' : undefined}
    >
      {file.status === 'indexed' && file.textStatus
        ? <CheckCircle size={14} className="text-white/35" />
        : statusIcon[file.status]}
      <div className="flex-1 min-w-0">
        <p className={`text-[13px] truncate ${canOpen ? 'text-white group-hover:text-[#e8b84a] transition-colors' : 'text-white'}`}>{file.name}</p>
        <p
          className="text-[10px] text-white/50"
          title={file.status === 'indexed' ? (file.ocrPending ? describeOcrPending(file.ocrPending)?.detail : file.textStatus ? describeTextStatus(file.textStatus).detail : undefined) : undefined}
        >
          {file.size} · {file.type.toUpperCase()} · {statusLabel(file)}
          {file.textContent && file.status === 'indexed' && (
            <span className="text-white/30 ml-1">· {Math.round(file.textContent.length / 4)} tokens</span>
          )}
        </p>
        {/* Stored on purpose, with no searchable text: say why, in one line,
            instead of a green "Ready" that reads as indexed. */}
        {file.status === 'indexed' && (file.textStatus || file.ocrPending) && (
          <p className="text-[10px] text-white/40 truncate">
            {file.ocrPending ? describeOcrPending(file.ocrPending)?.detail : describeTextStatus(file.textStatus!).detail}
          </p>
        )}
        {file.status === 'error' && file.errorMessage && (
          <p className="text-[10px] text-red-400/90 truncate" title={file.errorMessage}>
            {friendlyIngestError(file.errorMessage)}
          </p>
        )}
        {/* A worker attempt failed and a retry is scheduled: say so, with the
            cause, instead of spinning as "Uploading..." for 45 minutes. */}
        {file.status === 'uploading' && file.errorMessage && (
          <p className="text-[10px] text-[#e8b84a]/80 truncate" title={file.errorMessage}>
            {friendlyIngestError(file.errorMessage)}
          </p>
        )}
        {/* Nothing is processing, or the queue is long: say which, in words,
            rather than spinning. The alternative — an endless spinner — is
            what makes a person delete the document and upload it again, which
            queues a second copy behind the first. Not truncated: this one is
            meant to be read. */}
        {showServiceNotice && (
          <p className={`text-[10px] ${serviceNotice!.tone === 'paused' ? 'text-[#e8b84a]/90' : 'text-white/50'}`}>
            {serviceNotice!.text}
          </p>
        )}
      </div>
      {/* Retry on a failure; Re-run on a document stored without text (so a
          scan can be re-OCR'd once OCR is available) or with pages still
          awaiting OCR. Never on a 'held' row, nor on pages the seal kept in:
          the SecureSpace refused the pipe and would refuse it again. */}
      {onRetryFile && file.matterspace_id && !file.held &&
        (file.status === 'error' ||
          (file.status === 'indexed' && (file.textStatus || (file.ocrPending && !file.ocrPending.held)))) && (
        <button
          onClick={(e) => { e.stopPropagation(); onRetryFile(file.id); }}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold bg-[rgba(232,184,74,0.12)] text-[#e8b84a] hover:bg-[rgba(232,184,74,0.25)] transition-colors"
          title={file.status === 'error' ? 'Re-run ingestion for this document' : 'Run the pipeline again (for example after OCR or transcription was set up)'}
        >
          <RefreshCw size={11} /> {file.status === 'error' ? 'Retry' : 'Re-run'}
        </button>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onRemoveFile(file.id); }}
        className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-[rgba(255,255,255,0.06)] text-white/50 hover:text-white transition-all"
        title="Remove from Vault"
      >
        <X size={12} />
      </button>
    </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="px-6 py-5 border-b border-[rgba(255,255,255,0.08)]">
        <h2 className="text-[18px] font-semibold text-white mb-1">Import/Display Documents</h2>
        <p className="text-[13px] text-white/80">
          Add files and folders. Text is extracted automatically for AI analysis.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`w-full p-8 rounded-lg border-2 border-dashed transition-all flex flex-col items-center gap-4 ${
            dragOver ? 'border-[#e8b84a] bg-[rgba(232,184,74,0.05)]' : 'border-[rgba(255,255,255,0.1)] hover:border-[#e8b84a]/50'
          }`}
        >
          <Upload size={28} className={`transition-colors ${dragOver ? 'text-[#e8b84a]' : 'text-white/60'}`} />
          <p className="text-[14px] text-white/80 text-center">Drop files or folders here</p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#f0c850] hover:bg-[#e8b84a] text-black text-[12px] font-bold transition-colors"
            >
              <FileText size={14} /> Select Files
            </button>
            <button
              onClick={() => folderInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-[rgba(255,255,255,0.15)] hover:border-[#e8b84a]/50 text-white text-[12px] font-medium transition-colors"
            >
              <FolderOpen size={14} /> Select Folder
            </button>
          </div>
          <p className="text-[10px] text-white/40">PDF, DOCX, TXT, CSV, and more — text is extracted for AI context</p>
        </div>
        <input ref={fileInputRef} type="file" multiple onChange={handleFileUpload} className="hidden" />
        {/* @ts-expect-error webkitdirectory is non-standard */}
        <input ref={folderInputRef} type="file" webkitdirectory="" multiple onChange={handleFileUpload} className="hidden" />

        {/* Real content search (hybrid semantic+keyword over the corpus) —
            distinct from the filename filter below the file-list header. */}
        <ContentSearch matterId={matterId} onOpen={onOpenDocument} />

        {files.length > 0 && (
          <div className="mt-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[11px] font-semibold text-white/80 uppercase tracking-wider">
                {/* While the list is whole, `files.length` IS the exact count
                    and it also moves the instant a file is added or removed.
                    Once the read was truncated it is not — then the badge is
                    the server's own count, and the size and "ready" figures
                    are labelled as describing only what was loaded, because
                    "19,980 ready" out of 5,000 rows is the same silent lie
                    pointed the other way. */}
                Vault Files ({((listNotice ? totalCount : undefined) ?? files.length).toLocaleString()})
                {listNotice
                  ? <> · {files.length.toLocaleString()} loaded · {formatSize(totalSize)} · {indexedCount.toLocaleString()} of those ready</>
                  : <> · {formatSize(totalSize)} · {indexedCount.toLocaleString()} ready</>}
              </h3>
            </div>

            {listNotice && (
              <p className="mb-3 text-[11px] text-[#e8b84a]/90">{listNotice}</p>
            )}

            {files.length > 5 && (
              <div className="relative mb-3">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setShown(RENDER_WINDOW); }}
                  placeholder="Search files..."
                  className="w-full pl-9 pr-3 py-2 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[12px] text-white placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-[#e8b84a]"
                />
              </div>
            )}

            {groups ? (
              <div className="space-y-3">
                {groups.map((g) => {
                  const collapsed = collapsedGroups.has(g.id);
                  const take = groupTake?.get(g.id) ?? g.files.length;
                  return (
                    <div key={g.id}>
                      <button
                        onClick={() => toggleGroup(g.id)}
                        className="flex items-center gap-2 w-full text-left mb-1.5 group/header"
                      >
                        {collapsed ? <ChevronRight size={13} className="text-white/50" strokeWidth={2.5} /> : <ChevronDown size={13} className="text-white/50" strokeWidth={2.5} />}
                        <Folder size={13} className="text-[#d4a054]" strokeWidth={1.75} />
                        <span className="text-[12px] font-medium text-[#f5f1e8] group-hover/header:text-[#e8b84a] transition-colors">{g.name}</span>
                        <span className="text-[10px] text-white/30 ml-auto">{g.files.length.toLocaleString()}</span>
                      </button>
                      {!collapsed && (
                        <div className="space-y-0.5 pl-5">
                          {g.files.slice(0, take).map(renderFileRow)}
                          {take < g.files.length && (
                            <p className="pl-3 py-1 text-[10px] text-white/40">
                              {(g.files.length - take).toLocaleString()} more in this folder — Show more below.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-0.5">
                {filtered.slice(0, shown).map(renderFileRow)}
              </div>
            )}

            {/* The rows are all loaded; this is only how many are drawn. The
                count is explicit so nobody reads the bottom of the list as
                the bottom of the matter. */}
            {drawn < drawable && (
              <div className="mt-3 flex items-center gap-3 flex-wrap">
                <button
                  onClick={() => setShown((s) => s + RENDER_WINDOW)}
                  className="px-3 py-1.5 rounded-lg border border-[rgba(255,255,255,0.15)] hover:border-[#e8b84a]/50 text-white text-[11px] font-medium transition-colors"
                >
                  Show more
                </button>
                <span className="text-[11px] text-white/50">
                  Showing {drawn.toLocaleString()} of {drawable.toLocaleString()}
                  {search ? ' matching files' : ' files'} — all of them are loaded; type in Search files… to narrow the list.
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
