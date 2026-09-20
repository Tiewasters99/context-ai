import { supabase } from '@/lib/supabase';
import { parseRefusalBody } from '@/lib/llm/refusals';

// Session-authed bridge to /api/sandbox — the server-side document-task
// surface (search, send_to_sandbox, assemble/edit PDFs, decks, charts).
// The server runs the caller's Supabase session, so RLS applies as usual.
//
// Every caller of this function renders what it throws in its own error slot
// (ContentSearch, SandboxPanel, DeckComposerModal, PdfPageEditor), so the
// refusal is turned into a sentence here and no banner is raised — the news
// belongs next to the button that was pressed, and once.
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
  // `body.error` is a machine code — a 402 read as "over_monthly_budget" and a
  // 429 as "over_rate_limit". parseRefusalBody prefers the sentence beside it.
  if (!res.ok) throw new Error(parseRefusalBody(res.status, body, res.headers.get('retry-after')).message);
  return body as T;
}
