import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { CanvasProvider } from '@/hooks/useCanvas';
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
import CalendarView from '@/pages/CalendarView';
import NotFound from '@/pages/NotFound';
import Vault from '@/pages/Vault';
import DocumentBuilder from '@/pages/DocumentBuilder';
import ProductivitySuite from '@/pages/ProductivitySuite';
import TheOffice from '@/pages/TheOffice';
import EditorRoom from '@/pages/editor/EditorRoom';
import ClaudeConnect from '@/pages/ClaudeConnect';
import GeminiConnect from '@/pages/GeminiConnect';
import GrokConnect from '@/pages/GrokConnect';
import ChatGPTConnect from '@/pages/ChatGPTConnect';
import Connections from '@/pages/Connections';
import Settings from '@/pages/Settings';
import BucketizerHome from '@/pages/BucketizerHome';
import AgentsHome from '@/pages/AgentsHome';
import AgentTasks from '@/pages/AgentTasks';
import MootBench from '@/pages/moot/MootBench';
import MootSession from '@/pages/moot/MootSession';
import HubMenu from '@/pages/student-hub/HubMenu';
import TextView from '@/pages/student-hub/TextView';
import StudentHubHome from '@/pages/student-hub/StudentHubHome';
import StudentHubSession from '@/pages/student-hub/StudentHubSession';
import AddChapter from '@/pages/student-hub/AddChapter';
import MeetingView from '@/pages/MeetingView';
import ConnectLayout from '@/components/layout/ConnectLayout';
import ConnectMeetings from '@/pages/connect/ConnectMeetings';
import DocumentReader from '@/pages/DocumentReader';
import DiscoveryHome from '@/pages/discovery/DiscoveryHome';
import ReviewRoom from '@/pages/discovery/ReviewRoom';
import DiscoveryLayout from '@/components/layout/DiscoveryLayout';
import DiscoveryDashboard from '@/pages/discovery/DiscoveryDashboard';
import MediationCenter from '@/pages/mediation/MediationCenter';
import MediationRegister from '@/pages/mediation/MediationRegister';
import MediationJoin from '@/pages/mediation/MediationJoin';
import MediationCase from '@/pages/mediation/MediationCase';
import AuthCallback from '@/pages/AuthCallback';
import AuthConfirm from '@/pages/AuthConfirm';
import ResetPassword from '@/pages/ResetPassword';
import OAuthAuthorize from '@/pages/OAuthAuthorize';
import { canOpenPath } from '@/lib/plan';

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

// The plan gate. It wraps the three signed-in shells rather than each of the
// forty-odd routes, because what a path costs is decided in one place —
// lib/plan.ts — and asking it here means a new route is reachable by default
// and only becomes gated when someone lists it there.
//
// A path that is open to everyone never waits for the plan: the dashboard, a
// matter, the Vault and the Suite render the moment the session is known, as
// they always have. Only a path that some plan closes has to know the plan
// first — and there it waits rather than guessing, because redirecting on an
// unread plan would bounce a workshop account off its own deep link on every
// cold load.
function PlanRoute({ children }: { children: React.ReactNode }) {
  const { plan, planLoading } = useAuth();
  const location = useLocation();

  if (canOpenPath(location.pathname, 'free')) {
    return <>{children}</>;
  }

  if (planLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!canOpenPath(location.pathname, plan)) {
    return <Navigate to="/app" replace />;
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
          <CanvasProvider>
          <Routes>
            <Route path="/" element={discoveryHost ? <Navigate to="/discovery" replace /> : <Landing />} />
            <Route path="/auth" element={<Auth />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/auth/confirm" element={<AuthConfirm />} />
            <Route path="/auth/reset" element={<ResetPassword />} />
            <Route path="/oauth/authorize" element={<OAuthAuthorize />} />
            <Route
              path="/app"
              element={
                <ProtectedRoute>
                  <PlanRoute>
                    <MainLayout />
                  </PlanRoute>
                </ProtectedRoute>
              }
            >
              <Route index element={<Dashboard />} />
              <Route path="serverspace/:id" element={<ServerspaceView />} />
              <Route path="matterspace/:id" element={<MatterspaceView />} />
              <Route path="page/:id" element={<PageView />} />
              <Route path="list/:id" element={<ListView />} />
              <Route path="table/:id" element={<TableView />} />
              <Route path="calendar" element={<CalendarView />} />
              <Route path="vault" element={<Vault />} />
              <Route path="document-builder" element={<DocumentBuilder />} />
              <Route path="suite" element={<ProductivitySuite />} />
              <Route path="office" element={<TheOffice />} />
              <Route path="editor" element={<EditorRoom />} />
              <Route path="discovery" element={<DiscoveryHome />} />
              <Route path="discovery/production/:id" element={<ReviewRoom />} />
              <Route path="settings" element={<Settings />} />
              <Route path="bucketizer" element={<BucketizerHome />} />
              <Route path="agents" element={<AgentsHome />} />
              <Route path="agent-tasks" element={<AgentTasks />} />
              <Route path="moot-bench" element={<MootBench />} />
              <Route path="moot-bench/:id" element={<MootSession />} />
              <Route path="student-hub" element={<HubMenu />} />
              <Route path="student-hub/texts" element={<TextView />} />
              <Route path="student-hub/shelf" element={<StudentHubHome />} />
              <Route path="student-hub/add" element={<AddChapter />} />
              <Route path="student-hub/:id" element={<StudentHubSession />} />
              <Route path="mediation" element={<MediationCenter />} />
              <Route path="mediation/register" element={<MediationRegister />} />
              <Route path="mediation/join" element={<MediationJoin />} />
              <Route path="mediation/case/:id" element={<MediationCase />} />
              <Route path="connections" element={<Connections />} />
              <Route path="connections/claude" element={<ClaudeConnect />} />
              <Route path="connections/gemini" element={<GeminiConnect />} />
              <Route path="connections/grok" element={<GrokConnect />} />
              <Route path="connections/chatgpt" element={<ChatGPTConnect />} />
              <Route path="m/:id" element={<MeetingView />} />
              <Route path="document/:id" element={<DocumentReader />} />
            </Route>
            <Route
              path="/discovery"
              element={
                <ProtectedRoute>
                  <PlanRoute>
                    <DiscoveryLayout />
                  </PlanRoute>
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
                  <PlanRoute>
                    <ConnectLayout />
                  </PlanRoute>
                </ProtectedRoute>
              }
            >
              <Route index element={<Navigate to="/connect/meetings" replace />} />
              <Route path="meetings" element={<ConnectMeetings />} />
              <Route path="m/:id" element={<MeetingView />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
          </CanvasProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
