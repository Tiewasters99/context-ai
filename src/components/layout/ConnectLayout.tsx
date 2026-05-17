import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, LogOut } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

// Standalone shell for the Connect entry into Contextspaces. Designed to
// feel like its own app — no sidebar, no serverspace nav, no ambient
// controls. The auth + database underneath are the same as Contextspaces,
// but a user landing here from the (future) iOS Capacitor wrap never has
// to know.
export default function ConnectLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signOut } = useAuth();
  const onMeetingPage = /^\/connect\/m\//.test(location.pathname);

  return (
    <div className="flex flex-col h-screen bg-black">
      <header className="flex items-center justify-between h-12 px-4 border-b border-[rgba(255,255,255,0.08)] shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          {onMeetingPage ? (
            <button
              onClick={() => navigate('/connect/meetings')}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-[rgba(255,255,255,0.06)] text-white/70 hover:text-white transition-colors"
              aria-label="Back to meetings"
            >
              <ChevronLeft size={16} strokeWidth={2} />
              <span className="text-[12px] font-medium">Meetings</span>
            </button>
          ) : (
            <Link
              to="/connect/meetings"
              className="font-display text-[15px] tracking-tight text-[var(--color-text-bright)]"
            >
              Connect
            </Link>
          )}
        </div>
        <button
          onClick={async () => {
            await signOut();
            navigate('/auth');
          }}
          className="p-2 rounded-md hover:bg-[rgba(255,255,255,0.08)] text-white/60 hover:text-white transition-colors"
          aria-label="Sign out"
          title="Sign out"
        >
          <LogOut size={15} strokeWidth={1.75} />
        </button>
      </header>
      <main className="flex-1 min-h-0 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
