import { useState } from 'react';
import { Menu, X, Upload, FileText, Bot, Key, FolderOpen, HardDrive, Settings } from 'lucide-react';

const menuItems = [
  { icon: Upload, label: 'Import Documents', description: 'OneDrive, Google Drive, Dropbox, or local files' },
  { icon: FolderOpen, label: 'File Browser', description: 'Browse and manage your imported documents' },
  { icon: Bot, label: 'AI Workbench', description: 'Give instructions to your AI agent' },
  { icon: FileText, label: 'Generated Documents', description: 'View and edit AI-generated output' },
  { icon: Key, label: 'Bring Your Own Key', description: 'Use your own API keys for AI models' },
  { icon: HardDrive, label: 'Storage', description: 'Manage your Vault storage (up to 100GB)' },
  { icon: Settings, label: 'Vault Settings', description: 'Configure models, permissions, and preferences' },
];

export default function Vault() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="fixed inset-0 z-50 bg-black flex">
      {/* Menu panel — slides from left */}
      <div
        className={`h-full flex flex-col border-r border-[rgba(255,255,255,0.06)] transition-all duration-500 ease-in-out overflow-hidden ${
          menuOpen ? 'w-80' : 'w-0'
        }`}
        style={{ backgroundColor: 'rgba(8,8,14,0.95)' }}
      >
        <div className="flex items-center justify-between px-5 h-16 shrink-0 border-b border-[rgba(255,255,255,0.06)]">
          <span className="text-[15px] font-semibold text-white tracking-tight">
            The Vault
          </span>
          <button
            onClick={() => setMenuOpen(false)}
            className="p-1.5 rounded-md hover:bg-[rgba(255,255,255,0.06)] text-white/50 hover:text-white transition-colors"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-3 px-3">
          {menuItems.map((item) => (
            <button
              key={item.label}
              className="flex items-start gap-3 w-full px-3 py-3 rounded-lg text-left hover:bg-[rgba(255,255,255,0.04)] transition-colors group"
            >
              <div className="w-8 h-8 rounded-md bg-[rgba(232,184,74,0.08)] group-hover:bg-[rgba(232,184,74,0.14)] flex items-center justify-center shrink-0 mt-0.5 transition-colors">
                <item.icon size={15} className="text-[#e8b84a]" strokeWidth={1.75} />
              </div>
              <div>
                <span className="text-[13px] font-medium text-white block">{item.label}</span>
                <span className="text-[11px] text-white/40 leading-tight">{item.description}</span>
              </div>
            </button>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-[rgba(255,255,255,0.06)]">
          <div className="flex items-center justify-between text-[11px] text-white/30">
            <span>Storage used</span>
            <span>0 / 5 GB (Free)</span>
          </div>
          <div className="mt-2 h-1 bg-[rgba(255,255,255,0.06)] rounded-full overflow-hidden">
            <div className="h-full w-0 bg-[#e8b84a] rounded-full" />
          </div>
        </div>
      </div>

      {/* Main void */}
      <div className="flex-1 flex items-center justify-center relative">
        {/* Menu toggle — small white dot/button, far left */}
        {!menuOpen && (
          <button
            onClick={() => setMenuOpen(true)}
            className="absolute left-6 top-1/2 -translate-y-1/2 group"
          >
            <div className="w-3 h-3 rounded-full bg-white/20 group-hover:bg-white/60 transition-all duration-300 group-hover:shadow-[0_0_20px_rgba(255,255,255,0.3)] group-hover:scale-150" />
            <span className="absolute left-6 top-1/2 -translate-y-1/2 text-[11px] text-white/0 group-hover:text-white/50 transition-all duration-300 whitespace-nowrap ml-2">
              <Menu size={14} className="inline mr-1" />
              Open Menu
            </span>
          </button>
        )}

        {/* Center message — subtle, appears when nothing is open */}
        {!menuOpen && (
          <div className="text-center animate-pulse">
            <p className="text-[13px] text-white/10 tracking-[0.3em] uppercase font-medium">
              The Vault
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
