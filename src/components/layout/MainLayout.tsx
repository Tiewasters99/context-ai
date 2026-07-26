import { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation, NavLink } from 'react-router-dom';
import { ArrowLeft, Menu, Home, DoorOpen, Plug, Bot } from 'lucide-react';
import Sidebar from './Sidebar';
import Assistant from '@/components/ai/Assistant';
import AmbientControls from './AmbientControls';
import { useIsMobile } from '@/hooks/useIsMobile';

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The Vault renders its own full-screen overlay with its own ambient
  // controls, so skip the shared cluster there.
  const onVault = location.pathname.endsWith('/vault');

  // Any navigation closes the mobile drawer — the route change is the
  // user's signal they're done with the menu.
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  return (
    <div className="flex h-screen">
      {!onVault && <AmbientControls />}

      {/* Sidebar: in document flow on desktop; an off-canvas drawer on phones. */}
      {isMobile ? (
        <>
          {drawerOpen && (
            <div
              className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
              onClick={() => setDrawerOpen(false)}
            />
          )}
          <div
            className={`fixed inset-y-0 left-0 z-50 transition-transform duration-300 ease-in-out ${
              drawerOpen ? 'translate-x-0' : '-translate-x-full'
            }`}
          >
            <Sidebar
              isMobile
              onToggleAssistant={() => { setAssistantOpen(!assistantOpen); setDrawerOpen(false); }}
              assistantOpen={assistantOpen}
            />
          </div>
        </>
      ) : (
        <Sidebar onToggleAssistant={() => setAssistantOpen(!assistantOpen)} assistantOpen={assistantOpen} />
      )}

      <div className="flex-1 flex flex-col min-w-0 bg-cover bg-fixed bg-no-repeat" style={{ backgroundColor: '#000000', backgroundImage: "var(--ambient-cover, var(--page-cover, none))", backgroundPosition: 'var(--page-cover-position, center)' }}>
        {/* Top bar */}
        <header className="flex items-center justify-between h-13 px-3 sm:px-4 border-b border-[rgba(255,255,255,0.08)] shrink-0 backdrop-blur-[30px]" style={{ backgroundColor: 'rgba(10, 10, 16, 0.65)' }}>
          <div className="flex items-center gap-1">
            {isMobile && (
              <button
                onClick={() => setDrawerOpen(true)}
                className="p-2 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/80 hover:text-white transition-colors"
                aria-label="Open menu"
              >
                <Menu size={20} strokeWidth={1.75} />
              </button>
            )}
            <button
              onClick={() => navigate(-1)}
              className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/70 hover:text-white transition-colors"
              aria-label="Go back"
            >
              <ArrowLeft size={18} strokeWidth={2} />
              <span className="text-[13px] font-medium">Back</span>
            </button>
          </div>

          {isMobile && (
            <span className="text-[14px] font-semibold text-white tracking-tight truncate px-2">
              Context<span className="text-[#d4a054]">spaces</span>
            </span>
          )}

          {/* Search and notifications will live here once they exist — an
              unwired button (and a permanently-lit unread dot) erodes trust
              faster than an empty corner does. */}
          <div className="flex items-center gap-0.5" />
        </header>

        {/* Content — extra bottom padding on mobile so the fixed tab bar
            never covers the last line of a page. */}
        <main className="flex-1 overflow-y-auto pb-16 md:pb-0">
          <Outlet />
        </main>
      </div>

      {/* Thumb-reachable bottom navigation — phones only. */}
      {isMobile && !onVault && (
        <MobileTabBar onToggleAssistant={() => setAssistantOpen((v) => !v)} assistantOpen={assistantOpen} />
      )}

      <Assistant isOpen={assistantOpen} onClose={() => setAssistantOpen(false)} />
    </div>
  );
}

function MobileTabBar({
  onToggleAssistant,
  assistantOpen,
}: {
  onToggleAssistant: () => void;
  assistantOpen: boolean;
}) {
  const tab = 'flex flex-col items-center justify-center gap-0.5 flex-1 h-full text-[10px] font-medium transition-colors';
  const idle = 'text-white/50';
  const active = 'text-[#e8b84a]';
  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-40 h-14 flex items-stretch border-t border-[rgba(255,255,255,0.1)] backdrop-blur-[30px]"
      style={{ backgroundColor: 'rgba(8, 8, 14, 0.92)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <NavLink to="/app" end className={({ isActive }) => `${tab} ${isActive ? active : idle}`}>
        <Home size={19} strokeWidth={1.75} />
        <span>Home</span>
      </NavLink>
      <NavLink to="/app/vault" className={({ isActive }) => `${tab} ${isActive ? active : idle}`}>
        <DoorOpen size={19} strokeWidth={1.75} />
        <span>Vault</span>
      </NavLink>
      <NavLink to="/app/connections" className={({ isActive }) => `${tab} ${isActive ? active : idle}`}>
        <Plug size={19} strokeWidth={1.75} />
        <span>Connect</span>
      </NavLink>
      <button onClick={onToggleAssistant} className={`${tab} ${assistantOpen ? active : idle}`}>
        <Bot size={19} strokeWidth={1.75} />
        <span>Assistant</span>
      </button>
    </nav>
  );
}
