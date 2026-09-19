// Carrying an /oauth/authorize request across a Google / Apple sign-in.
//
// A visitor who created their Contextspaces account with Google or Apple has
// no password to type, so the connector consent screen has to send them out
// to their provider and get them back. Supabase returns them to
// /auth/callback — the one return path the Supabase project is configured
// for (src/contexts/AuthContext.tsx uses it for every other SSO sign-in) —
// which is a different route from the one holding the OAuth request. So the
// request itself waits here for the length of the trip: every query
// parameter the client sent, including the PKCE code_challenge and the
// client's `state`, byte for byte.
//
// Open-redirect safety: what is stored is a query string, never a URL, and
// the route it is replayed onto is a hard-coded literal in the caller. A
// tampered value therefore cannot send anyone off-origin — at worst it
// produces the consent screen's own "Invalid request" panel.

const KEY = 'cs.oauth-authorize.pending';

// A sign-in round trip is a couple of minutes at most; the authorization
// code the consent screen goes on to mint lives 60 seconds
// (api/oauth-approve.mjs). Ten minutes is generous and keeps a stale
// request from ambushing a later, unrelated sign-in in the same tab.
const MAX_AGE_MS = 10 * 60 * 1000;

/** The route a parked request is replayed onto. A literal, by design. */
export const AUTHORIZE_PATH = '/oauth/authorize';

/** Park the current authorize request before leaving for the provider. */
export function stashAuthorizeRequest(search: string): void {
  if (!search.startsWith('?')) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ search, at: Date.now() }));
  } catch {
    // Private mode or blocked storage: the trip just won't resume, and the
    // visitor lands in the app instead of back on the consent screen.
  }
}

/**
 * Read and clear a parked authorize request. Returns the query string to
 * append to AUTHORIZE_PATH, or null when there is nothing safe to resume.
 */
export function takeAuthorizeRequest(): string | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const { search, at } = parsed as { search?: unknown; at?: unknown };
  if (typeof search !== 'string' || typeof at !== 'number') return null;
  if (!search.startsWith('?')) return null;
  if (!Number.isFinite(at) || Date.now() - at > MAX_AGE_MS) return null;
  // Without a client_id there is no authorize request to resume.
  if (!new URLSearchParams(search).get('client_id')) return null;

  return search;
}
