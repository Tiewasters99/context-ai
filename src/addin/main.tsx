import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/styles/index.css';
import { AuthProvider } from '@/contexts/AuthContext';
import AddinPane from './AddinPane';

// The Word task pane's own entry (addin.html, served as /addin): sign-in, the
// matter tree and the Brief Desk's confirm pipeline, and none of the
// workspace (docs/specs/WORD-ADDIN-2026-11-01.md). A MemoryRouter because the
// pieces it borrows (the matter tree, later the Reader) reach for router
// hooks; the pane itself has one screen and no URLs.
const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthProvider>
          <AddinPane />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  </StrictMode>,
);
