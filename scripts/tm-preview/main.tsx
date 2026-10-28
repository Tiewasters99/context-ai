// The Trademark tab alone, for the headless check (scripts/_tm-ui-preview.mjs).
// The real components and the real data layer, against a local stub of
// Supabase (PGlite with migrations 121 and 122) and the real /api/trademark
// and /api/sandbox handlers. Never deployed (not a build input).

import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '@/styles/index.css';
import { supabase } from '@/lib/supabase';
import { AuthProvider } from '@/contexts/AuthContext';
import TrademarkTab from '@/components/trademark/TrademarkTab';

const params = new URLSearchParams(location.search);
await supabase.auth.setSession({ access_token: params.get('t') ?? '', refresh_token: 'preview-refresh' });

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>
      <AuthProvider>
        <div className="min-h-screen bg-[var(--color-bg,#0f0f14)] px-4 py-4 sm:px-8">
          <TrademarkTab matterId={params.get('m') ?? ''} matterName="Quorium marks" />
        </div>
      </AuthProvider>
    </MemoryRouter>
  </QueryClientProvider>,
);
