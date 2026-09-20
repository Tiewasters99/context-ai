// GET /api/ext/matters
//
// Returns the user's matters (id, name, short_code, serverspace name)
// for the Chrome extension's matter picker. Auth: csp_* connector
// token (same format Claude Desktop uses).
//
// SecureSpace, 2026-09-20 — what this endpoint does and does not expose.
// It returns NAMES, never content: no passage text, no bytes, no signed URL.
// An outside AI connector is a different case (lib/mcp-core.mjs hides sealed
// matters from it outright), but the extension is the USER's own tool, signed
// in as them, and hiding their sealed matters from their own picker would only
// send them to the web UI to do the same thing. So the seal is MARKED here,
// not enforced: every matter carries `sealed`, so the extension can badge it
// and warn before the user picks it. Enforcement lives one endpoint over, in
// /api/ext/push-to-drive, which is where bytes actually leave.
//
// The marking fails CLOSED and uses the SERVICE ROLE: an inherited seal from a
// parent matter this user cannot see must still mark the child, and a seal
// lookup that fails marks everything sealed (`seal_status: 'unknown'`) rather
// than quietly reporting a clean bill of health.

import {
  authenticateConnectorToken,
  adminClient,
  userScopedClient,
  corsHeaders,
  json,
  handleAuthError,
} from '../../lib/connector-token-auth.mjs';

import { sealedMatterIds } from '../../lib/ai-tier-policy.mjs';

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });

  let userId;
  try {
    userId = await authenticateConnectorToken(req);
  } catch (err) {
    return handleAuthError(res, err);
  }

  // User-scoped client → RLS on matterspaces filters to the user's
  // matters automatically (membership-based, not owner-column-based).
  const sb = userScopedClient(userId);
  const { data, error } = await sb
    .from('matterspaces')
    .select('id, name, short_code, parent_matterspace_id, serverspace:serverspaces(name)')
    .order('name', { ascending: true });
  if (error) return json(res, 500, { error: `query_failed: ${error.message}` });

  // Which of them are sealed (B or C, inherited)? Service role, so an ancestor
  // the user cannot see still seals its children; unreadable ⇒ all sealed.
  let sealed = null;
  try {
    sealed = await sealedMatterIds(adminClient());
  } catch {
    sealed = null;
  }

  return json(res, 200, {
    seal_status: sealed ? 'ok' : 'unknown',
    matters: (data ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      short_code: m.short_code,
      parent_matterspace_id: m.parent_matterspace_id,
      serverspace_name: (m.serverspace && m.serverspace.name) || null,
      // True means: anything taken out of this matter leaves a seal, and the
      // server will ask before it does.
      sealed: sealed ? sealed.has(m.id) : true,
    })),
  });
}
