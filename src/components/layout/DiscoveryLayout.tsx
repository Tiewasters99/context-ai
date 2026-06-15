import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, LogOut } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

// Standalone shell for Discovery as its own product (/discovery), the sibling
// of ConnectLayout. Same auth + database as Contextspaces underneath — but a
// user who lands here (e.g. at discovery.contextspaces.ai) never sees the
// serverspace/matter chrome; Discovery is the whole app.
//
// The SAME Discovery module also runs as a per-matter tab inside Contextspaces
// (/app/discovery) — one codebase, two front doors. Entitlement gating (who is
// allowed into the standalone product vs the full suite) is the next layer and
// would live right here, around <Outlet/>.
export default function DiscoveryLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signOut } = useAuth();
  // On a case ledger or a production review, offer a way back to the dashboard.
  const onDeepPage = /^\/discovery\/(case|production)\b/.test(location.pathname);

  return (
    <div className="flex flex-col h-screen bg-black">
      <header className="flex items-center justify-between h-12 px-4 border-b border-[rgba(255,255,255,0.08)] shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          {onDeepPage ? (
            <button
              onClick={() => navigate('/discovery')}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-[rgba(255,255,255,0.06)] text-white/70 hover:text-white transition-colors"
              aria-label="Back to Discovery"
            >
              <ChevronLeft size={16} strokeWidth={2} />
              <span className="text-[12px] font-medium">Discovery</span>
            </button>
          ) : (
            <Link
              to="/discovery"
              className="flex items-baseline gap-2 min-w-0"
            >
              <span className="font-display text-[15px] tracking-tight text-[var(--color-text-bright)]">
                Discovery
              </span>
              <span className="text-[10px] uppercase tracking-[0.18em] text-white/30 truncate">
                by Contextspaces
              </span>
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
