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
import ClaudeConnect from '@/pages/ClaudeConnect';
import AuthCallback from '@/pages/AuthCallback';
import ResetPassword from '@/pages/ResetPassword';

const queryClient = new QueryClient();

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  // TODO: Remove this bypass before production
  const DEV_BYPASS_AUTH = true;

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
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/auth" element={<Auth />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/auth/reset" element={<ResetPassword />} />
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
              <Route path="claude-connect" element={<ClaudeConnect />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
