import { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import Sidebar from './Sidebar';
import Assistant from '@/components/ai/Assistant';
import AmbientControls from './AmbientControls';

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [assistantOpen, setAssistantOpen] = useState(false);
  // The Vault renders its own full-screen overlay with its own ambient
  // controls, so skip the shared cluster there.
  const onVault = location.pathname.endsWith('/vault');

  return (
    <div className="flex h-screen">
      {!onVault && <AmbientControls />}
      <Sidebar onToggleAssistant={() => setAssistantOpen(!assistantOpen)} assistantOpen={assistantOpen} />

      <div className="flex-1 flex flex-col min-w-0 bg-cover bg-fixed bg-no-repeat" style={{ backgroundColor: '#000000', backgroundImage: "var(--ambient-cover, var(--page-cover, none))", backgroundPosition: 'var(--page-cover-position, center)' }}>
        {/* Top bar */}
        <header className="flex items-center justify-between h-13 px-4 border-b border-[rgba(255,255,255,0.08)] shrink-0 backdrop-blur-[30px]" style={{ backgroundColor: 'rgba(10, 10, 16, 0.65)' }}>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate(-1)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/70 hover:text-white transition-colors"
              aria-label="Go back"
            >
              <ArrowLeft size={18} strokeWidth={2} />
              <span className="text-[13px] font-medium">Back</span>
            </button>
          </div>

          {/* Search and notifications will live here once they exist — an
              unwired button (and a permanently-lit unread dot) erodes trust
              faster than an empty corner does. */}
          <div className="flex items-center gap-0.5" />
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>

      <Assistant isOpen={assistantOpen} onClose={() => setAssistantOpen(false)} />
    </div>
  );
}
