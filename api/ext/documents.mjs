// GET /api/ext/documents?matter=<uuid>
//
// Returns the documents in one matter, for the Chrome extension's
// document picker. Auth: csp_* connector token.

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

  const matterId = (req.query && req.query.matter) || '';
  if (!matterId) return json(res, 400, { error: 'matter param required' });

  // RLS on documents already filters to matters the user has access to.
  // If the user can read the matter they can read its documents; if not,
  // the query returns an empty list and we 404 below.
  const sb = userScopedClient(userId);

  const { data: matter, error: mErr } = await sb
    .from('matterspaces')
    .select('id')
    .eq('id', matterId)
    .maybeSingle();
  if (mErr) return json(res, 500, { error: `matter_lookup: ${mErr.message}` });
  if (!matter) return json(res, 404, { error: 'matter_not_found' });

  const { data, error } = await sb
    .from('documents')
    .select('id, title, source_filename, file_size_bytes, doc_type, processing_status, created_at')
    .eq('matterspace_id', matterId)
    .order('created_at', { ascending: false });
  if (error) return json(res, 500, { error: `query_failed: ${error.message}` });

  return json(res, 200, {
    documents: (data ?? []).map((d) => ({
      id: d.id,
      title: d.title,
      source_filename: d.source_filename,
      file_size_bytes: d.file_size_bytes,
      doc_type: d.doc_type,
      processing_status: d.processing_status,
      created_at: d.created_at,
    })),
  });
}
