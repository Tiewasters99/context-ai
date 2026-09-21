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

// Kicks off the Google OAuth flow for one integration ('gmail',
// 'google_calendar', or 'google_drive'): asks the server for the Google
// authorization URL, then redirects the browser to it.
export async function startGoogleConnect(
  kind: 'gmail' | 'google_calendar' | 'google_drive',
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

// ---------------------------------------------------------------------------
// The other cloud drives — OneDrive and Dropbox (migration 075)
// ---------------------------------------------------------------------------
// Same connections table, same encrypted refresh token, a different provider
// at the other end. Google's flow above is left exactly as it is; these have
// their own endpoints because their OAuth details differ (PKCE, rotating
// Microsoft refresh tokens, Dropbox's token_access_type=offline).
//
// All of it is DORMANT until the two applications are registered: with the
// keys absent every endpoint answers 503 `not_configured`, and `isCloudDrive
// Configured` below is what lets the Connections card say "Not available yet"
// rather than offering a button that cannot work.

export type CloudDriveService = 'onedrive' | 'dropbox';

const CLOUD_DRIVE_ENDPOINT: Record<CloudDriveService, string> = {
  onedrive: '/api/microsoft-connect',
  dropbox: '/api/dropbox-connect',
};

export const CLOUD_DRIVE_LABEL: Record<CloudDriveService, string> = {
  onedrive: 'OneDrive',
  dropbox: 'Dropbox',
};

/** Has this deployment been given the provider's keys yet? */
export async function isCloudDriveConfigured(
  service: CloudDriveService,
): Promise<boolean> {
  try {
    const resp = await fetch(CLOUD_DRIVE_ENDPOINT[service]);
    if (!resp.ok) return false;
    const body = await resp.json();
    return body?.configured === true;
  } catch {
    return false;
  }
}

/** Asks the server for the provider's authorization URL, then goes there. */
export async function startCloudConnect(service: CloudDriveService): Promise<void> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');
  const resp = await fetch(CLOUD_DRIVE_ENDPOINT[service], {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}` },
    // The PKCE verifier comes back as an HttpOnly cookie on this response, so
    // the request has to be same-origin and credentialed.
    credentials: 'same-origin',
  });
  const body = await resp.json().catch(() => ({}));
  if (resp.status === 503) {
    throw new Error(`${CLOUD_DRIVE_LABEL[service]} is not available yet.`);
  }
  if (!resp.ok || !body.url) {
    throw new Error(body.error || `Could not start the ${CLOUD_DRIVE_LABEL[service]} connection`);
  }
  window.location.href = body.url;
}

/**
 * Disconnect through the server, not with a row delete: Dropbox publishes a
 * revoke endpoint and the refresh token needed to call it is only readable
 * server-side. The row is deleted either way.
 */
export async function disconnectCloudDrive(
  service: CloudDriveService,
): Promise<{ revokedAtProvider: boolean; manageUrl: string | null }> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');
  const resp = await fetch(CLOUD_DRIVE_ENDPOINT[service], {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body.error || 'Could not disconnect');
  return {
    revokedAtProvider: body.revoked_at_provider === true,
    manageUrl: typeof body.manage_url === 'string' ? body.manage_url : null,
  };
}
