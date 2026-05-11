import { useState, useRef, useCallback, useMemo } from 'react';
import { Upload, FolderOpen, FileText, X, Loader2, CheckCircle, Search, AlertCircle, ChevronDown, ChevronRight, Folder } from 'lucide-react';
import type { VaultFile } from '@/lib/vault-types';

interface ImportPanelProps {
  files: VaultFile[];
  onAddFiles: (files: FileList | File[]) => void;
  onRemoveFile: (id: string) => void;
  /** Open a file in the document reader/editor. */
  onOpenFile?: (file: VaultFile) => void;
}

const statusIcon = {
  uploading: <Loader2 size={14} className="text-[#e8b84a] animate-spin" />,
  indexing: <Loader2 size={14} className="text-[#e8b84a] animate-spin" />,
  indexed: <CheckCircle size={14} className="text-emerald-400" />,
  error: <AlertCircle size={14} className="text-red-400" />,
};

const statusLabel = {
  uploading: 'Uploading...',
  indexing: 'Extracting text...',
  indexed: 'Ready',
  error: 'Error',
};

export default function ImportPanel({ files, onAddFiles, onRemoveFile, onOpenFile }: ImportPanelProps) {
  const [search, setSearch] = useState('');
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

  const totalSize = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  const indexedCount = files.filter((f) => f.status === 'indexed').length;
  const formatSize = (bytes: number) =>
    bytes > 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` :
    bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` :
    `${(bytes / 1024).toFixed(0)} KB`;

  const openable = (file: VaultFile) =>
    !!onOpenFile && (file.status === 'indexed' || file.status === 'error');

  const renderFileRow = (file: VaultFile) => {
    const canOpen = openable(file);
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
      {statusIcon[file.status]}
      <div className="flex-1 min-w-0">
        <p className={`text-[13px] truncate ${canOpen ? 'text-white group-hover:text-[#e8b84a] transition-colors' : 'text-white'}`}>{file.name}</p>
        <p className="text-[10px] text-white/50">
          {file.size} · {file.type.toUpperCase()} · {statusLabel[file.status]}
          {file.textContent && file.status === 'indexed' && (
            <span className="text-white/30 ml-1">· {Math.round(file.textContent.length / 4)} tokens</span>
          )}
        </p>
      </div>
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
        <h2 className="text-[18px] font-semibold text-white mb-1">Import Documents</h2>
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

        {files.length > 0 && (
          <div className="mt-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[11px] font-semibold text-white/80 uppercase tracking-wider">
                Vault Files ({files.length}) · {formatSize(totalSize)} · {indexedCount} ready
              </h3>
            </div>

            {files.length > 5 && (
              <div className="relative mb-3">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search files..."
                  className="w-full pl-9 pr-3 py-2 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] text-[12px] text-white placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-[#e8b84a]"
                />
              </div>
            )}

            {groups ? (
              <div className="space-y-3">
                {groups.map((g) => {
                  const collapsed = collapsedGroups.has(g.id);
                  return (
                    <div key={g.id}>
                      <button
                        onClick={() => toggleGroup(g.id)}
                        className="flex items-center gap-2 w-full text-left mb-1.5 group/header"
                      >
                        {collapsed ? <ChevronRight size={13} className="text-white/50" strokeWidth={2.5} /> : <ChevronDown size={13} className="text-white/50" strokeWidth={2.5} />}
                        <Folder size={13} className="text-[#d4a054]" strokeWidth={1.75} />
                        <span className="text-[12px] font-medium text-[#f5f1e8] group-hover/header:text-[#e8b84a] transition-colors">{g.name}</span>
                        <span className="text-[10px] text-white/30 ml-auto">{g.files.length}</span>
                      </button>
                      {!collapsed && (
                        <div className="space-y-0.5 pl-5">
                          {g.files.map(renderFileRow)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-0.5">
                {filtered.map(renderFileRow)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
