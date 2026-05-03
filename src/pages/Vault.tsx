import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { X, Upload, FileText, Bot, Key, FolderOpen, HardDrive, Settings, ArrowLeft, Menu, Music, Image, LayoutGrid, Maximize, Minus, EyeOff, ChevronRight, ChevronDown, Folder, Users } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import ImportPanel from '@/components/vault/ImportPanel';
import AIWorkbench from '@/components/vault/AIWorkbench';
import TemplateLibrary from '@/components/vault/TemplateLibrary';
import type { VaultFile } from '@/lib/vault-types';
import { extractText } from '@/lib/extract';
import {
  resolveMatter,
  listMatterDocuments,
  persistVaultFile,
  watchDocumentStatus,
  deleteVaultDocument,
  type MatterRef,
} from '@/lib/vault-persist';
import { useServerspaces } from '@/hooks/useServerspaces';
import { buildMatterTree, type MatterTreeNode } from '@/lib/matter-tree';

type VaultView = 'home' | 'import' | 'workbench' | 'files' | 'generated' | 'byok' | 'storage' | 'settings';

const menuItems: { icon: typeof Upload; label: string; description: string; view: VaultView }[] = [
  { icon: Upload, label: 'Import Documents', description: 'OneDrive, Google Drive, Dropbox, or local files', view: 'import' },
  { icon: FolderOpen, label: 'File Browser', description: 'Browse and manage your imported documents', view: 'files' },
  { icon: Bot, label: 'AI Workbench', description: 'Give instructions to your AI agent', view: 'workbench' },
  { icon: FileText, label: 'Generated Documents', description: 'View and edit AI-generated output', view: 'generated' },
  { icon: Key, label: 'Bring Your Own Key', description: 'Use your own API keys for AI models', view: 'byok' },
  { icon: HardDrive, label: 'Storage', description: 'Manage your Vault storage (up to 100GB)', view: 'storage' },
  { icon: Settings, label: 'Vault Settings', description: 'Configure models, permissions, and preferences', view: 'settings' },
];

export default function Vault() {
  const [illuminated, setIlluminated] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeView, setActiveView] = useState<VaultView>('home');
  const [musicPlaying, setMusicPlaying] = useState(false);
  const musicRef = useRef<HTMLAudioElement | null>(null);
  const musicInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [coverMode, setCoverMode] = useState<'full' | 'banner' | 'off'>('full');
  const [showTemplates, setShowTemplates] = useState(false);
  const [vaultFiles, setVaultFiles] = useState<VaultFile[]>([]);

  // Matter context: when /app/vault?matter=<short_code|uuid>, the Vault
  // operates in persistent mode — files go through Supabase Storage +
  // documents/passages, and the file list reflects the matter's vault
  // across sessions. Without ?matter=, the Vault is the original ephemeral
  // single-session workspace.
  const [searchParams, setSearchParams] = useSearchParams();
  const matterKey = searchParams.get('matter');
  const [matter, setMatter] = useState<MatterRef | null>(null);
  const [matterError, setMatterError] = useState<string | null>(null);

  // Matter tree state — same shape as the main sidebar so users can
  // switch matters without leaving the Vault.
  const { data: serverspaces = [] } = useServerspaces();
  const [matterTreeOpen, setMatterTreeOpen] = useState(true);
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());
  const [expandedMatters, setExpandedMatters] = useState<Set<string>>(new Set());

  // Keep the active matter's ancestors expanded so the user can see
  // where they are in the tree on first paint.
  useEffect(() => {
    if (!matter) return;
    setExpandedServers((prev) => new Set(prev).add(matter.serverspace_id));
    if (matter.parent_matterspace_id) {
      // Walk up the tree to expand every ancestor matter.
      const found = serverspaces.find((s) => s.id === matter.serverspace_id);
      if (!found) return;
      const byId = new Map(found.matterspaces.map((m) => [m.id, m] as const));
      const ancestors = new Set<string>();
      let cur: string | null = matter.parent_matterspace_id;
      while (cur) {
        ancestors.add(cur);
        cur = byId.get(cur)?.parent_matterspace_id ?? null;
      }
      setExpandedMatters((prev) => {
        const next = new Set(prev);
        for (const id of ancestors) next.add(id);
        return next;
      });
    }
  }, [matter, serverspaces]);

  const toggleSet = (
    setFn: React.Dispatch<React.SetStateAction<Set<string>>>,
    id: string,
  ) => {
    setFn((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const switchToMatter = (shortCodeOrId: string) => {
    setSearchParams({ matter: shortCodeOrId });
  };

  useEffect(() => {
    if (!matterKey) { setMatter(null); setMatterError(null); return; }
    let cancelled = false;
    resolveMatter(matterKey).then((m) => {
      if (cancelled) return;
      if (!m) {
        setMatter(null);
        setMatterError(`No matter found for "${matterKey}"`);
      } else {
        setMatter(m);
        setMatterError(null);
      }
    });
    return () => { cancelled = true; };
  }, [matterKey]);

  // Hydrate the vault file list from the documents table when a matter loads.
  useEffect(() => {
    if (!matter) return;
    let cancelled = false;
    listMatterDocuments(matter.id).then((files) => {
      if (!cancelled) setVaultFiles(files);
    });
    // Resume polling for any docs that are still mid-pipeline (uploading / indexing).
    const cleanups: (() => void)[] = [];
    listMatterDocuments(matter.id).then((files) => {
      if (cancelled) return;
      for (const f of files) {
        if (f.status === 'uploading' || f.status === 'indexing') {
          cleanups.push(
            watchDocumentStatus(f.id, (status) => {
              setVaultFiles((prev) => prev.map((x) => x.id === f.id ? { ...x, status } : x));
            })
          );
        }
      }
    });
    return () => {
      cancelled = true;
      cleanups.forEach((c) => c());
    };
  }, [matter]);

  const formatSize = (bytes: number) =>
    bytes > 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` :
    bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` :
    `${(bytes / 1024).toFixed(0)} KB`;

  const addVaultFiles = useCallback(async (fileList: FileList | File[]) => {
    const arr = Array.from(fileList);

    // Persistent mode — upload + ingest via Supabase, poll for status.
    if (matter) {
      for (const file of arr) {
        try {
          const { documentId } = await persistVaultFile(matter, file);
          const stub: VaultFile = {
            id: documentId,
            name: file.name,
            path: file.name,
            size: formatSize(file.size),
            sizeBytes: file.size,
            type: file.name.split('.').pop()?.toLowerCase() ?? 'file',
            file,
            status: 'uploading',
          };
          setVaultFiles((prev) => [stub, ...prev]);
          // Poll until terminal — self-stops on ready/error.
          watchDocumentStatus(documentId, (status) => {
            setVaultFiles((prev) =>
              prev.map((f) => f.id === documentId ? { ...f, status } : f)
            );
          });
        } catch (err: any) {
          console.error('persistVaultFile:', err.message);
          setVaultFiles((prev) => [{
            id: crypto.randomUUID(),
            name: file.name,
            path: file.name,
            size: formatSize(file.size),
            sizeBytes: file.size,
            type: file.name.split('.').pop()?.toLowerCase() ?? 'file',
            file,
            status: 'error',
            textContent: `[Upload failed: ${err.message}]`,
          }, ...prev]);
        }
      }
      return;
    }

    // Ephemeral mode — original behavior, in-memory only.
    const newFiles: VaultFile[] = arr.map((f) => ({
      id: crypto.randomUUID(),
      name: f.name,
      path: ((f as any).webkitRelativePath as string) || f.name,
      size: formatSize(f.size),
      sizeBytes: f.size,
      type: f.name.split('.').pop()?.toLowerCase() ?? 'file',
      file: f,
      status: 'uploading' as const,
    }));

    setVaultFiles((prev) => [...newFiles, ...prev]);

    for (const nf of newFiles) {
      setVaultFiles((prev) => prev.map((f) => f.id === nf.id ? { ...f, status: 'indexing' } : f));
      try {
        const textContent = await extractText(nf.file);
        setVaultFiles((prev) => prev.map((f) => f.id === nf.id ? { ...f, status: 'indexed', textContent } : f));
      } catch {
        setVaultFiles((prev) => prev.map((f) => f.id === nf.id ? { ...f, status: 'error', textContent: `[Failed to extract text from ${nf.name}]` } : f));
      }
    }
  }, [matter]);

  const removeVaultFile = useCallback((id: string) => {
    if (matter) {
      // Persistent mode — delete from DB + storage. Optimistic UI removal;
      // on error we leave a console message but do not re-add the row.
      deleteVaultDocument(id)
        .then(() => setVaultFiles((prev) => prev.filter((f) => f.id !== id)))
        .catch((err) => {
          console.error('deleteVaultDocument:', err.message);
          setVaultFiles((prev) => prev.filter((f) => f.id !== id));
        });
      return;
    }
    setVaultFiles((prev) => prev.filter((f) => f.id !== id));
  }, [matter]);

  const [bannerY, setBannerY] = useState(50); // vertical position %, 0=top, 100=bottom
  const bannerDragging = useRef(false);
  const bannerStartY = useRef(0);
  const bannerStartPos = useRef(50);

  const musicUrlRef = useRef<string | null>(null);

  // Clean up audio and blob URL on unmount
  useEffect(() => {
    return () => {
      if (musicRef.current) { musicRef.current.pause(); musicRef.current = null; }
      if (musicUrlRef.current) { URL.revokeObjectURL(musicUrlRef.current); musicUrlRef.current = null; }
    };
  }, []);

  const handleMusicUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Tear down previous audio
    if (musicRef.current) { musicRef.current.pause(); musicRef.current = null; }
    if (musicUrlRef.current) { URL.revokeObjectURL(musicUrlRef.current); }
    // Reset the input so re-selecting the same file fires onChange
    e.target.value = '';

    const url = URL.createObjectURL(file);
    musicUrlRef.current = url;
    const audio = new Audio(url);
    audio.loop = true;
    audio.volume = 0.5;

    // Keep state in sync if playback ends or errors
    audio.addEventListener('pause', () => setMusicPlaying(false));
    audio.addEventListener('play', () => setMusicPlaying(true));

    musicRef.current = audio;
    audio.play().then(() => {
      setMusicPlaying(true);
    }).catch(() => {
      // Autoplay blocked — audio is ready, user must click toggle to start
      setMusicPlaying(false);
    });
  };

  const toggleMusic = () => {
    if (!musicRef.current) { musicInputRef.current?.click(); return; }
    if (musicPlaying) {
      musicRef.current.pause();
    } else {
      musicRef.current.play().catch(() => {
        // Still blocked — no state change
      });
    }
  };

  const handleCoverUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setCoverUrl(url);
    setManualCoverOverride(true);
    setCoverMode('full');
    setBannerY(50);
  };

  const cycleCoverMode = () => {
    if (coverMode === 'full') setCoverMode('banner');
    else if (coverMode === 'banner') setCoverMode('off');
    else setCoverMode('full');
  };

  const coverModeIcon = coverMode === 'full' ? Maximize : coverMode === 'banner' ? Minus : EyeOff;
  const coverModeLabel = coverMode === 'full' ? 'Fullscreen cover' : coverMode === 'banner' ? 'Banner cover' : 'Cover hidden';
  const CoverIcon = coverModeIcon;
  const navigate = useNavigate();

  // Effective cover: when a matter is active and has its own cover_url,
  // that overrides the per-session Vault cover. The user can still pick
  // a different cover via the corner controls; manual picks win.
  const [manualCoverOverride, setManualCoverOverride] = useState(false);
  const effectiveCoverUrl = useMemo(() => {
    if (manualCoverOverride && coverUrl) return coverUrl;
    return matter?.cover_url || coverUrl;
  }, [matter, coverUrl, manualCoverOverride]);

  const handleMenuClick = (view: VaultView) => {
    setActiveView(view);
  };

  const renderContent = () => {
    switch (activeView) {
      case 'import':
        return <ImportPanel files={vaultFiles} onAddFiles={addVaultFiles} onRemoveFile={removeVaultFile} />;
      case 'workbench':
        return <AIWorkbench vaultFiles={vaultFiles} />;
      case 'home':
      default:
        return (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center animate-[fadeIn_0.8s_ease-in-out]">
              <p className="text-[22px] text-white tracking-[0.4em] uppercase font-medium mb-4" style={{ textShadow: '0 0 30px rgba(232,184,74,0.2)' }}>
                The Vault<span className="text-[10px] align-super tracking-normal">TM</span>
              </p>
              {matterError ? (
                <p className="text-[13px] text-red-400/80 mb-8">{matterError}</p>
              ) : (
                <p className="text-[14px] text-white mb-8">
                  Your secure AI workspace. Import documents, run agents, generate output.
                </p>
              )}
              <p className="text-[12px] text-white">
                Select an option from the menu to get started
              </p>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: effectiveCoverUrl && coverMode === 'full' ? `url(${effectiveCoverUrl}) center/cover no-repeat` : 'black' }}>
      {/* Banner mode — cover ribbon at top, drag to reposition */}
      {effectiveCoverUrl && coverMode === 'banner' && (
        <div
          className="w-full h-48 shrink-0 overflow-hidden cursor-grab active:cursor-grabbing relative group"
          onPointerDown={(e) => {
            bannerDragging.current = true;
            bannerStartY.current = e.clientY;
            bannerStartPos.current = bannerY;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!bannerDragging.current) return;
            const delta = e.clientY - bannerStartY.current;
            const newY = Math.min(100, Math.max(0, bannerStartPos.current - (delta / 1.5)));
            setBannerY(newY);
          }}
          onPointerUp={() => { bannerDragging.current = false; }}
        >
          <img
            src={effectiveCoverUrl ?? undefined}
            alt=""
            className="w-full h-auto min-h-full object-cover absolute left-0 pointer-events-none select-none"
            draggable={false}
            style={{ top: '0', transform: `translateY(-${bannerY}%)`, maxWidth: '100%', minWidth: '100%' }}
          />
          <div className="absolute inset-x-0 bottom-0 flex justify-center pb-2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            <span className="text-[10px] text-white/50 bg-black/40 px-2 py-0.5 rounded-full">Drag to reposition</span>
          </div>
        </div>
      )}
      <div className="flex-1 flex min-h-0">
      {/* Menu panel */}
      <div
        className={`h-full flex flex-col border-r border-[rgba(255,255,255,0.08)] transition-all duration-700 ease-in-out overflow-hidden shrink-0 ${
          !illuminated ? 'w-0 border-r-0' : menuOpen ? 'w-80' : 'w-14'
        }`}
        style={{ backgroundColor: 'rgba(8,8,14,0.95)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 h-14 shrink-0 border-b border-[rgba(255,255,255,0.08)]">
          {menuOpen ? (
            <>
              <div className="flex flex-col min-w-0">
                <span className="text-[15px] font-semibold text-white tracking-tight">
                  The Vault
                </span>
                {matter && (
                  <span className="text-[11px] text-white/60 truncate">
                    <span className="text-[#e8b84a]/80">{matter.serverspace_name}</span>
                    <span className="mx-1 text-white/30">/</span>
                    {matter.name}
                  </span>
                )}
                {!matter && !matterError && (
                  <span className="text-[11px] text-white/40">Ephemeral session — pick a matter to persist</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => navigate('/app')}
                  className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/80 hover:text-white transition-colors"
                  title="Back to Contextspace"
                >
                  <ArrowLeft size={15} strokeWidth={2} />
                </button>
                <button
                  onClick={() => setMenuOpen(false)}
                  className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/80 hover:text-white transition-colors"
                  title="Collapse menu"
                >
                  <X size={15} strokeWidth={2} />
                </button>
              </div>
            </>
          ) : (
            <button
              onClick={() => setMenuOpen(true)}
              className="mx-auto p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/80 hover:text-white transition-colors"
              title="Open menu"
            >
              <Menu size={18} strokeWidth={1.75} />
            </button>
          )}
        </div>

        {/* Matter tree — expanded */}
        {menuOpen && (
          <div className="border-b border-[rgba(255,255,255,0.06)]">
            <button
              onClick={() => setMatterTreeOpen((v) => !v)}
              className="w-full flex items-center gap-2 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-white/60 hover:text-white hover:bg-[rgba(255,255,255,0.03)] transition-colors"
            >
              <span className="text-[#e8b84a]/80">
                {matterTreeOpen ? <ChevronDown size={12} strokeWidth={2.5} /> : <ChevronRight size={12} strokeWidth={2.5} />}
              </span>
              Matters
              {matter && <span className="ml-auto text-[10px] text-[#e8b84a]/80 normal-case font-normal">in {matter.name}</span>}
            </button>
            {matterTreeOpen && (
              <div className="px-2 pb-2 max-h-[40vh] overflow-y-auto">
                {serverspaces.length === 0 && (
                  <p className="px-3 py-2 text-[11px] text-white/40">Loading…</p>
                )}
                {serverspaces.map((server) => {
                  const isExpanded = expandedServers.has(server.id);
                  const tree = buildMatterTree(server.matterspaces);
                  return (
                    <div key={server.id}>
                      <button
                        onClick={() => toggleSet(setExpandedServers, server.id)}
                        className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-left text-[12px] text-white/80 hover:bg-[rgba(255,255,255,0.04)] transition-colors"
                      >
                        <span className="text-[#e8b84a]/80 w-3 shrink-0">
                          {isExpanded ? <ChevronDown size={11} strokeWidth={2.5} /> : <ChevronRight size={11} strokeWidth={2.5} />}
                        </span>
                        <Users size={12} className="text-[#d4a054] shrink-0" strokeWidth={1.75} />
                        <span className="truncate">{server.name}</span>
                      </button>
                      {isExpanded && tree.length === 0 && (
                        <p className="pl-9 py-1 text-[10px] text-white/30">No matters yet</p>
                      )}
                      {isExpanded && tree.map((node) => (
                        <VaultMatterNode
                          key={node.matter.id}
                          node={node}
                          depth={0}
                          activeMatterId={matter?.id ?? null}
                          expandedMatters={expandedMatters}
                          toggleMatter={(id) => toggleSet(setExpandedMatters, id)}
                          onSelect={(m) => switchToMatter(m.short_code ?? m.id)}
                        />
                      ))}
                    </div>
                  );
                })}
                {matter && (
                  <button
                    onClick={() => setSearchParams({})}
                    className="w-full mt-2 px-2 py-1.5 rounded text-left text-[10px] text-white/40 hover:text-white/70 hover:bg-[rgba(255,255,255,0.03)] transition-colors"
                    title="Exit matter and use the Vault in ephemeral mode"
                  >
                    Exit matter (ephemeral mode)
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Menu items — expanded */}
        {menuOpen && (
          <div className="flex-1 overflow-y-auto py-3 px-3">
            {menuItems.map((item) => (
              <button
                key={item.label}
                onClick={() => handleMenuClick(item.view)}
                className={`flex items-start gap-3 w-full px-3 py-3 rounded-lg text-left transition-colors group ${
                  activeView === item.view ? 'bg-[rgba(232,184,74,0.08)]' : 'hover:bg-[rgba(255,255,255,0.05)]'
                }`}
              >
                <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 mt-0.5 transition-colors ${
                  activeView === item.view ? 'bg-[rgba(232,184,74,0.15)]' : 'bg-[rgba(232,184,74,0.08)] group-hover:bg-[rgba(232,184,74,0.15)]'
                }`}>
                  <item.icon size={15} className="text-[#e8b84a]" strokeWidth={1.75} />
                </div>
                <div>
                  <span className="text-[13px] font-medium text-white block">{item.label}</span>
                  <span className="text-[11px] text-white/80 leading-tight">{item.description}</span>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Menu items — collapsed icons */}
        {!menuOpen && illuminated && (
          <div className="flex-1 overflow-y-auto py-3 px-1.5">
            {menuItems.map((item) => (
              <button
                key={item.label}
                onClick={() => { setMenuOpen(true); handleMenuClick(item.view); }}
                className={`flex items-center justify-center w-full h-10 rounded-md transition-colors group ${
                  activeView === item.view ? 'bg-[rgba(232,184,74,0.08)]' : 'hover:bg-[rgba(255,255,255,0.05)]'
                }`}
                title={item.label}
              >
                <item.icon size={16} className={`transition-colors ${
                  activeView === item.view ? 'text-[#e8b84a]' : 'text-white/80 group-hover:text-[#e8b84a]'
                }`} strokeWidth={1.75} />
              </button>
            ))}
          </div>
        )}

        {/* Storage footer */}
        {menuOpen && (
          <div className="px-4 py-4 border-t border-[rgba(255,255,255,0.08)]">
            <div className="flex items-center justify-between text-[11px] text-white/70">
              <span>Storage used</span>
              <span>0 / 5 GB (Free)</span>
            </div>
            <div className="mt-2 h-1 bg-[rgba(255,255,255,0.06)] rounded-full overflow-hidden">
              <div className="h-full w-0 bg-[#e8b84a] rounded-full" />
            </div>
          </div>
        )}
      </div>

      {/* Main area */}
      <div className="flex-1 flex relative">
        {!illuminated ? (
          /* Dark state — dot with subtle hint */
          <div className="flex-1 flex items-center justify-center">
            <button
              onClick={() => { setIlluminated(true); setMenuOpen(true); }}
              className="absolute left-8 top-1/2 -translate-y-1/2 group cursor-pointer flex items-center gap-3"
            >
              <div className="w-5 h-5 rounded-full bg-white/70 group-hover:bg-white group-hover:shadow-[0_0_40px_rgba(255,255,255,0.8)] group-hover:scale-[1.8] transition-all duration-500" />
              <span className="text-[14px] text-white/70 group-hover:text-white tracking-wide transition-all duration-500 animate-pulse font-medium">
                ← click to enter
              </span>
            </button>
          </div>
        ) : (
          renderContent()
        )}
      </div>
      </div>{/* end inner flex */}
      {/* Bottom right — music & cover */}
      {illuminated && (
        <div className="fixed bottom-5 right-5 flex items-center gap-2 z-50">
          {effectiveCoverUrl && (
            <>
              <button
                onClick={cycleCoverMode}
                className="p-3 rounded-full hover:bg-[rgba(255,255,255,0.1)] text-white/80 hover:text-white transition-all hover:scale-110"
                title={coverModeLabel}
              >
                <CoverIcon size={22} strokeWidth={1.75} />
              </button>
              <button
                onClick={() => { setCoverUrl(null); setManualCoverOverride(true); setCoverMode('full'); }}
                className="p-3 rounded-full hover:bg-[rgba(255,255,255,0.1)] text-white/80 hover:text-white transition-all hover:scale-110"
                title="Remove cover"
              >
                <X size={22} strokeWidth={1.75} />
              </button>
            </>
          )}
          <button
            onClick={() => setShowTemplates(true)}
            className="p-3 rounded-full hover:bg-[rgba(255,255,255,0.1)] text-white/80 hover:text-white transition-all hover:scale-110"
            title="Template library"
          >
            <LayoutGrid size={22} strokeWidth={1.75} />
          </button>
          <button
            onClick={() => coverInputRef.current?.click()}
            className="p-3 rounded-full hover:bg-[rgba(255,255,255,0.1)] text-white/80 hover:text-white transition-all hover:scale-110"
            title="Upload custom cover"
          >
            <Image size={22} strokeWidth={1.75} />
          </button>
          <button
            onClick={toggleMusic}
            className={`p-3 rounded-full hover:bg-[rgba(255,255,255,0.1)] transition-all hover:scale-110 ${
              musicPlaying ? 'text-[#e8b84a] shadow-[0_0_15px_rgba(232,184,74,0.3)]' : 'text-white/80 hover:text-white'
            }`}
            title={musicPlaying ? 'Pause music' : 'Play background music'}
          >
            <Music size={22} strokeWidth={1.75} />
          </button>
          <input ref={musicInputRef} type="file" accept="audio/*" onChange={handleMusicUpload} className="hidden" />
          <input ref={coverInputRef} type="file" accept="image/*" onChange={handleCoverUpload} className="hidden" />
        </div>
      )}
      {showTemplates && (
        <TemplateLibrary
          onSelect={(url) => { setCoverUrl(url); setManualCoverOverride(true); setCoverMode('full'); setBannerY(50); }}
          onClose={() => setShowTemplates(false)}
        />
      )}
    </div>
  );
}


interface VaultMatterNodeProps {
  node: MatterTreeNode;
  depth: number;
  activeMatterId: string | null;
  expandedMatters: Set<string>;
  toggleMatter: (id: string) => void;
  onSelect: (matter: MatterTreeNode['matter']) => void;
}

function VaultMatterNode({
  node,
  depth,
  activeMatterId,
  expandedMatters,
  toggleMatter,
  onSelect,
}: VaultMatterNodeProps) {
  const { matter, children } = node;
  const hasChildren = children.length > 0;
  const isExpanded = expandedMatters.has(matter.id);
  const isActive = activeMatterId === matter.id;
  const indent = 14 + depth * 12;

  return (
    <div>
      <div
        className={`flex items-center gap-1 rounded transition-colors ${
          isActive
            ? 'bg-[rgba(232,184,74,0.12)]'
            : 'hover:bg-[rgba(255,255,255,0.04)]'
        }`}
      >
        {hasChildren ? (
          <button
            onClick={() => toggleMatter(matter.id)}
            className="p-1 text-[#e8b84a]/80 hover:text-[#e8b84a] shrink-0"
          >
            {isExpanded ? <ChevronDown size={11} strokeWidth={2.5} /> : <ChevronRight size={11} strokeWidth={2.5} />}
          </button>
        ) : (
          <span className="w-[19px] shrink-0" />
        )}
        <button
          onClick={() => onSelect(matter)}
          className="flex-1 flex items-center gap-1.5 py-1.5 pr-2 text-left min-w-0"
          style={{ paddingLeft: `${indent - 19}px` }}
          title={matter.name}
        >
          <Folder size={11} className={`shrink-0 ${isActive ? 'text-[#e8b84a]' : 'text-[#d4a054]'}`} strokeWidth={1.75} />
          <span className={`text-[12px] truncate ${isActive ? 'text-[#e8b84a] font-medium' : 'text-white/80'}`}>
            {matter.name}
          </span>
        </button>
      </div>
      {isExpanded && hasChildren && (
        <div>
          {children.map((child) => (
            <VaultMatterNode
              key={child.matter.id}
              node={child}
              depth={depth + 1}
              activeMatterId={activeMatterId}
              expandedMatters={expandedMatters}
              toggleMatter={toggleMatter}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
