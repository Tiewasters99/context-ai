import { useState, useRef } from 'react';
import { X, Upload, FileText, Bot, Key, FolderOpen, HardDrive, Settings, ArrowLeft, Menu, Music, Image } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import ImportPanel from '@/components/vault/ImportPanel';
import AIWorkbench from '@/components/vault/AIWorkbench';

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
  const [vaultBg, setVaultBg] = useState('black');

  const handleMusicUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (musicRef.current) { musicRef.current.pause(); musicRef.current = null; }
    const url = URL.createObjectURL(file);
    const audio = new Audio(url);
    audio.loop = true;
    audio.volume = 0.5;
    audio.play().catch(() => {
      // Browser blocked autoplay — will play on next toggle click
    });
    musicRef.current = audio;
    setMusicPlaying(true);
  };

  const toggleMusic = () => {
    if (!musicRef.current) { musicInputRef.current?.click(); return; }
    if (musicPlaying) { musicRef.current.pause(); }
    else { musicRef.current.play(); }
    setMusicPlaying(!musicPlaying);
  };

  const handleCoverUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setVaultBg(`url(${url}) center/cover no-repeat`);
  };
  const navigate = useNavigate();

  const handleMenuClick = (view: VaultView) => {
    setActiveView(view);
  };

  const renderContent = () => {
    switch (activeView) {
      case 'import':
        return <ImportPanel />;
      case 'workbench':
        return <AIWorkbench />;
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
    <div className="fixed inset-0 z-50 flex" style={{ background: vaultBg }}>
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
                  className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/50 hover:text-white transition-colors"
                  title="Back to Contextspace"
                >
                  <ArrowLeft size={15} strokeWidth={2} />
                </button>
                <button
                  onClick={() => setMenuOpen(false)}
                  className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/50 hover:text-white transition-colors"
                  title="Collapse menu"
                >
                  <X size={15} strokeWidth={2} />
                </button>
              </div>
            </>
          ) : (
            <button
              onClick={() => setMenuOpen(true)}
              className="mx-auto p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/40 hover:text-white transition-colors"
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
                  <span className="text-[11px] text-white/40 leading-tight">{item.description}</span>
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
                  activeView === item.view ? 'text-[#e8b84a]' : 'text-white/40 group-hover:text-[#e8b84a]'
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
          /* Dark state — just the white dot */
          <div className="flex-1 flex items-center justify-center">
            <button
              onClick={() => { setIlluminated(true); setMenuOpen(true); }}
              className="absolute left-8 top-1/2 -translate-y-1/2 group cursor-pointer"
            >
              <div className="w-3 h-3 rounded-full bg-white/50 group-hover:bg-white group-hover:shadow-[0_0_30px_rgba(255,255,255,0.6)] group-hover:scale-[2] transition-all duration-500" />
            </button>
          </div>
        ) : (
          renderContent()
        )}
      </div>
      {/* Bottom right — music & cover */}
      {illuminated && (
        <div className="fixed bottom-5 right-5 flex items-center gap-2 z-50">
          {vaultBg !== 'black' && (
            <button
              onClick={() => setVaultBg('black')}
              className="p-3 rounded-full hover:bg-[rgba(255,255,255,0.1)] text-white/50 hover:text-white transition-all hover:scale-110"
              title="Remove cover"
            >
              <X size={22} strokeWidth={1.75} />
            </button>
          )}
          <button
            onClick={() => coverInputRef.current?.click()}
            className="p-3 rounded-full hover:bg-[rgba(255,255,255,0.1)] text-white/50 hover:text-white transition-all hover:scale-110"
            title="Set Vault cover"
          >
            <Image size={22} strokeWidth={1.75} />
          </button>
          <button
            onClick={toggleMusic}
            className={`p-3 rounded-full hover:bg-[rgba(255,255,255,0.1)] transition-all hover:scale-110 ${
              musicPlaying ? 'text-[#e8b84a] shadow-[0_0_15px_rgba(232,184,74,0.3)]' : 'text-white/50 hover:text-white'
            }`}
            title={musicPlaying ? 'Pause music' : 'Play background music'}
          >
            <Music size={22} strokeWidth={1.75} />
          </button>
          <input ref={musicInputRef} type="file" accept="audio/*" onChange={handleMusicUpload} className="hidden" />
          <input ref={coverInputRef} type="file" accept="image/*" onChange={handleCoverUpload} className="hidden" />
        </div>
      )}
    </div>
  );
}
