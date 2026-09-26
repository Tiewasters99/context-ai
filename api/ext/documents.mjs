// GET /api/ext/documents?matter=<uuid>
//
// Returns the documents in one matter, for the Chrome extension's
// document picker. Auth: csp_* connector token.
//
// SecureSpace — what this endpoint exposes. Titles, filenames, sizes and
// status; NO passage text, page images, storage path or signed URL. Since 098
// (S1b) a sealed matter's documents are not listed at all: the request is
// refused with the seal's sentence and a tool.invoked {refused:'sealed'} row
// in that matter's Record, as an MCP connector's would be (lib/ext-seal.mjs
// says why the 2026-09-20 "mark, don't enforce" choice was reversed). The tier
// is read with the service role and fails closed. Membership is asked first,
// as the user, so a matter the person cannot reach is "not found" whether or
// not it is sealed.

import {
  authenticateConnectorToken,
  userScopedClient,
  corsHeaders,
  json,
  handleAuthError,
} from '../../lib/connector-token-auth.mjs';

import { fetchMatterTier, isSealedTier } from '../../lib/ai-tier-policy.mjs';
import { recordExtRefusal, sealedRefusal } from '../../lib/ext-seal.mjs';

export default async function handler(req, res, deps = {}) {
  const authenticate = deps.authenticate ?? authenticateConnectorToken;
  const userClient = deps.userClient ?? userScopedClient;
  const tierOf = deps.tierOf ?? ((id) => fetchMatterTier(
    process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    id,
  ));

  corsHeaders(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });

  let userId;
  try {
    userId = await authenticate(req);
  } catch (err) {
    return handleAuthError(res, err);
  }

  const matterId = (req.query && req.query.matter) || '';
  if (!matterId) return json(res, 400, { error: 'matter param required' });

  // RLS on documents already filters to matters the user has access to.
  // If the user can read the matter they can read its documents; if not,
  // the query returns an empty list and we 404 below.
  const sb = userClient(userId);

  const { data: matter, error: mErr } = await sb
    .from('matterspaces')
    .select('id')
    .eq('id', matterId)
    .maybeSingle();
  if (mErr) return json(res, 500, { error: `matter_lookup: ${mErr.message}` });
  if (!matter) return json(res, 404, { error: 'matter_not_found' });

  // The matter's EFFECTIVE tier, read with the service role — an ancestor's
  // seal must reach this listing even when the ancestor itself is invisible
  // to the caller. Unreadable ⇒ refused, never listed.
  let tier;
  try {
    tier = await tierOf(matterId);
  } catch {
    return json(res, 503, { error: 'seal_status_unknown' });
  }
  if (isSealedTier(tier)) {
    await recordExtRefusal(sb, { route: 'ext.documents', matterId, userId });
    return json(res, 403, sealedRefusal());
  }

  const { data, error } = await sb
    .from('documents')
    .select('id, title, source_filename, file_size_bytes, doc_type, processing_status, created_at')
    .eq('matterspace_id', matterId)
    .order('created_at', { ascending: false });
  if (error) return json(res, 500, { error: `query_failed: ${error.message}` });

  return json(res, 200, {
    seal_status: 'ok',
    ai_tier: tier ?? null,
    sealed: false,
    documents: (data ?? []).map((d) => ({
      sealed: false,
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
