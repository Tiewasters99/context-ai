import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Upload, FileText, Bot, Key, FolderOpen, HardDrive, Settings, ArrowLeft, Menu, Music, Image, LayoutGrid, Maximize, Minus, EyeOff } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import ImportPanel from '@/components/vault/ImportPanel';
import AIWorkbench from '@/components/vault/AIWorkbench';
import TemplateLibrary from '@/components/vault/TemplateLibrary';
import type { VaultFile } from '@/lib/vault-types';
import { extractText } from '@/lib/extract';

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

  const addVaultFiles = useCallback(async (fileList: FileList | File[]) => {
    const arr = Array.from(fileList);
    const newFiles: VaultFile[] = arr.map((f) => ({
      id: crypto.randomUUID(),
      name: f.name,
      path: ((f as any).webkitRelativePath as string) || f.name,
      size: f.size > 1073741824 ? `${(f.size / 1073741824).toFixed(1)} GB` : f.size > 1048576 ? `${(f.size / 1048576).toFixed(1)} MB` : `${(f.size / 1024).toFixed(0)} KB`,
      sizeBytes: f.size,
      type: f.name.split('.').pop()?.toLowerCase() ?? 'file',
      file: f,
      status: 'uploading' as const,
    }));

    setVaultFiles((prev) => [...newFiles, ...prev]);

    // Extract text from each file
    for (const nf of newFiles) {
      setVaultFiles((prev) => prev.map((f) => f.id === nf.id ? { ...f, status: 'indexing' } : f));
      try {
        const textContent = await extractText(nf.file);
        setVaultFiles((prev) => prev.map((f) => f.id === nf.id ? { ...f, status: 'indexed', textContent } : f));
      } catch {
        setVaultFiles((prev) => prev.map((f) => f.id === nf.id ? { ...f, status: 'error', textContent: `[Failed to extract text from ${nf.name}]` } : f));
      }
    }
  }, []);

  const removeVaultFile = useCallback((id: string) => {
    setVaultFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

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
              <p className="text-[14px] text-white mb-8">
                Your secure AI workspace. Import documents, run agents, generate output.
              </p>
              <p className="text-[12px] text-white">
                Select an option from the menu to get started
              </p>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: coverUrl && coverMode === 'full' ? `url(${coverUrl}) center/cover no-repeat` : 'black' }}>
      {/* Banner mode — cover ribbon at top, drag to reposition */}
      {coverUrl && coverMode === 'banner' && (
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
            src={coverUrl}
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
              <span className="text-[15px] font-semibold text-white tracking-tight">
                The Vault
              </span>
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
          {coverUrl && (
            <>
              <button
                onClick={cycleCoverMode}
                className="p-3 rounded-full hover:bg-[rgba(255,255,255,0.1)] text-white/80 hover:text-white transition-all hover:scale-110"
                title={coverModeLabel}
              >
                <CoverIcon size={22} strokeWidth={1.75} />
              </button>
              <button
                onClick={() => { setCoverUrl(null); setCoverMode('full'); }}
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
          onSelect={(url) => { setCoverUrl(url); setCoverMode('full'); setBannerY(50); }}
          onClose={() => setShowTemplates(false)}
        />
      )}
    </div>
  );
}
