// GET /api/ext/matters
//
// Returns the user's matters (id, name, short_code, serverspace name)
// for the Chrome extension's matter picker. Auth: csp_* connector
// token (same format Claude Desktop uses).
//
// SecureSpace — what this endpoint exposes. NAMES, never content: no passage
// text, no bytes, no signed URL. Since 098 (S1b) a sealed matter is not listed
// at all — the extension obeys the seal as an MCP connector does
// (lib/ext-seal.mjs says why the 2026-09-20 "mark, don't enforce" choice was
// reversed). The seal is resolved with the SERVICE ROLE, so an inherited seal
// from a parent this user cannot see still hides the child, and it fails
// CLOSED: when the seal cannot be read, nothing is listed (503).

import {
  authenticateConnectorToken,
  adminClient,
  userScopedClient,
  corsHeaders,
  json,
  handleAuthError,
} from '../../lib/connector-token-auth.mjs';

import { sealedMatterIds } from '../../lib/ai-tier-policy.mjs';

export default async function handler(req, res, deps = {}) {
  const authenticate = deps.authenticate ?? authenticateConnectorToken;
  const userClient = deps.userClient ?? userScopedClient;
  const serviceClient = deps.adminClient ?? adminClient;
  const sealedIds = deps.sealedMatterIds ?? sealedMatterIds;

  corsHeaders(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });

  let userId;
  try {
    userId = await authenticate(req);
  } catch (err) {
    return handleAuthError(res, err);
  }

  // User-scoped client → RLS on matterspaces filters to the user's
  // matters automatically (membership-based, not owner-column-based).
  const sb = userClient(userId);
  const { data, error } = await sb
    .from('matterspaces')
    .select('id, name, short_code, parent_matterspace_id, serverspace:serverspaces(name)')
    .order('name', { ascending: true });
  if (error) return json(res, 500, { error: `query_failed: ${error.message}` });

  // Which of them are sealed (B or C, inherited)? Service role, so an ancestor
  // the user cannot see still seals its children. Unreadable ⇒ list nothing.
  let sealed;
  try {
    sealed = await sealedIds(serviceClient());
  } catch {
    return json(res, 503, { error: 'seal_status_unknown' });
  }

  return json(res, 200, {
    seal_status: 'ok',
    matters: (data ?? [])
      .filter((m) => !sealed.has(m.id))
      .map((m) => ({
        id: m.id,
        name: m.name,
        short_code: m.short_code,
        parent_matterspace_id: m.parent_matterspace_id,
        serverspace_name: (m.serverspace && m.serverspace.name) || null,
        // Kept for the extension's badge; a listed matter is never sealed.
        sealed: false,
      })),
  });
}
