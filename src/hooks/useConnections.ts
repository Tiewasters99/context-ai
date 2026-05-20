// Reads the connections table (migration 026) — the user's stored
// external integrations (Gmail, later Calendar). Drives the Connections
// surface's per-integration state.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export interface Connection {
  id: string;
  kind: string;
  status: 'connected' | 'needs_attention';
  connected_email: string | null;
  last_error: string | null;
}

export function useConnections() {
  return useQuery({
    queryKey: ['connections'],
    queryFn: async (): Promise<Connection[]> => {
      const { data, error } = await supabase
        .from('connections')
        .select('id, kind, status, connected_email, last_error');
      if (error) throw error;
      return (data ?? []) as Connection[];
    },
  });
}

export function useConnectionsInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['connections'] });
}

// Kicks off the Google OAuth flow for one integration ('gmail' or
// 'google_calendar'): asks the server for the Google authorization URL,
// then redirects the browser to it.
export async function startGoogleConnect(
  kind: 'gmail' | 'google_calendar',
): Promise<void> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');
  const resp = await fetch(
    `/api/google-connect?kind=${encodeURIComponent(kind)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}` },
    },
  );
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || !body.url) {
    throw new Error(body.error || 'Could not start the Google connection');
  }
  window.location.href = body.url;
}

export async function disconnectConnection(id: string): Promise<void> {
  const { error } = await supabase.from('connections').delete().eq('id', id);
  if (error) throw error;
}
