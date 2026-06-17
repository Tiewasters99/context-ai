import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import Spinner from '@/components/ui/Spinner';
import Landing from '@/pages/Landing';
import Auth from '@/pages/Auth';
import Dashboard from '@/pages/Dashboard';
import MainLayout from '@/components/layout/MainLayout';
import ServerspaceView from '@/pages/ServerspaceView';
import MatterspaceView from '@/pages/MatterspaceView';
import PageView from '@/pages/PageView';
import ListView from '@/pages/ListView';
import TableView from '@/pages/TableView';
import NotFound from '@/pages/NotFound';
import Vault from '@/pages/Vault';
import DocumentBuilder from '@/pages/DocumentBuilder';
import ProductivitySuite from '@/pages/ProductivitySuite';
import ClaudeConnect from '@/pages/ClaudeConnect';
import GeminiConnect from '@/pages/GeminiConnect';
import GrokConnect from '@/pages/GrokConnect';
import Connections from '@/pages/Connections';
import MeetingView from '@/pages/MeetingView';
import ConnectLayout from '@/components/layout/ConnectLayout';
import ConnectMeetings from '@/pages/connect/ConnectMeetings';
import DocumentReader from '@/pages/DocumentReader';
import DiscoveryHome from '@/pages/discovery/DiscoveryHome';
import ReviewRoom from '@/pages/discovery/ReviewRoom';
import DiscoveryLayout from '@/components/layout/DiscoveryLayout';
import DiscoveryDashboard from '@/pages/discovery/DiscoveryDashboard';
import AuthCallback from '@/pages/AuthCallback';
import ResetPassword from '@/pages/ResetPassword';
import OAuthAuthorize from '@/pages/OAuthAuthorize';

const queryClient = new QueryClient();

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  // Auth bypass for LOCAL DEV ONLY — must stay false in production so the
  // login gate is enforced. Flip to true only on your own machine if needed.
  const DEV_BYPASS_AUTH = false;

  if (loading && !DEV_BYPASS_AUTH) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!user && !DEV_BYPASS_AUTH) {
    return <Navigate to="/auth" replace />;
  }

  return <>{children}</>;
}

export default function App() {
  // Subdomain boot: at discovery.contextspaces.ai the root goes straight into
  // the standalone Discovery product instead of the Contextspaces landing page.
  // Same build, same backend — the host just picks which front door opens.
  const discoveryHost =
    typeof window !== 'undefined' && /^discovery\./i.test(window.location.hostname);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/" element={discoveryHost ? <Navigate to="/discovery" replace /> : <Landing />} />
            <Route path="/auth" element={<Auth />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/auth/reset" element={<ResetPassword />} />
            <Route path="/oauth/authorize" element={<OAuthAuthorize />} />
            <Route
              path="/app"
              element={
                <ProtectedRoute>
                  <MainLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<Dashboard />} />
              <Route path="serverspace/:id" element={<ServerspaceView />} />
              <Route path="matterspace/:id" element={<MatterspaceView />} />
              <Route path="page/:id" element={<PageView />} />
              <Route path="list/:id" element={<ListView />} />
              <Route path="table/:id" element={<TableView />} />
              <Route path="vault" element={<Vault />} />
              <Route path="document-builder" element={<DocumentBuilder />} />
              <Route path="suite" element={<ProductivitySuite />} />
              <Route path="discovery" element={<DiscoveryHome />} />
              <Route path="discovery/production/:id" element={<ReviewRoom />} />
              <Route path="connections" element={<Connections />} />
              <Route path="connections/claude" element={<ClaudeConnect />} />
              <Route path="connections/gemini" element={<GeminiConnect />} />
              <Route path="connections/grok" element={<GrokConnect />} />
              <Route path="m/:id" element={<MeetingView />} />
              <Route path="document/:id" element={<DocumentReader />} />
            </Route>
            <Route
              path="/discovery"
              element={
                <ProtectedRoute>
                  <DiscoveryLayout />
                </ProtectedRoute>
              }
            >
              {/* Product-level overview across all cases */}
              <Route index element={<DiscoveryDashboard />} />
              {/* Per-case ledger + intake — the same component as the /app tab,
                  reads ?matter=<short_code|uuid>, reused inside the standalone shell */}
              <Route path="case" element={<DiscoveryHome />} />
              {/* Production review room — reused */}
              <Route path="production/:id" element={<ReviewRoom />} />
            </Route>
            <Route
              path="/connect"
              element={
                <ProtectedRoute>
                  <ConnectLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<Navigate to="/connect/meetings" replace />} />
              <Route path="meetings" element={<ConnectMeetings />} />
              <Route path="m/:id" element={<MeetingView />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
