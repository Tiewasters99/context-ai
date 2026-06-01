// GET /api/ext/matters
//
// Returns the user's matters (id, name, short_code, serverspace name)
// for the Chrome extension's matter picker. Auth: csp_* connector
// token (same format Claude Desktop uses).

import {
  authenticateConnectorToken,
  userScopedClient,
  corsHeaders,
  json,
  handleAuthError,
} from '../../lib/connector-token-auth.mjs';

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

  return json(res, 200, {
    matters: (data ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      short_code: m.short_code,
      parent_matterspace_id: m.parent_matterspace_id,
      serverspace_name: (m.serverspace && m.serverspace.name) || null,
    })),
  });
}
