import { supabase } from '@/lib/supabase';

// Session-authed bridge to /api/sandbox — the server-side document-task
// surface (search, send_to_sandbox, assemble/edit PDFs, decks, charts).
// The server runs the caller's Supabase session, so RLS applies as usual.
export async function sandboxApi<T = Record<string, unknown>>(
  action: string,
  args: Record<string, unknown>,
): Promise<T> {
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) throw new Error('not authenticated');
  const res = await fetch('/api/sandbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, args }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string })?.error || `sandbox api: HTTP ${res.status}`);
  return body as T;
}
