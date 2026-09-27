// GET /api/ext/documents?matter=<uuid>
//
// Returns the documents in one matter, for the Chrome extension's
// document picker. Auth: csp_* connector token.
//
// SecureSpace, 2026-09-20 — what this endpoint does and does not expose.
// Titles, filenames, sizes and status. NO passage text, NO page images, NO
// storage path, and NO signed URL: nothing here can be turned into the
// document's content. The bytes leave through /api/ext/push-to-drive, which
// is gated. As on /api/ext/matters, the seal is therefore MARKED rather than
// enforced — the extension is the user's own tool — and the marking fails
// closed: if the tier cannot be read, the matter is reported sealed.
//
// The pause, by contrast, is ENFORCED (099): a paused matter is refused here
// (403 ai_paused), and a pause that cannot be read refuses too (503).

import {
  authenticateConnectorToken,
  userScopedClient,
  corsHeaders,
  json,
  handleAuthError,
  pausedMatterRefusal,
} from '../../lib/connector-token-auth.mjs';

import { fetchMatterTier, isSealedTier } from '../../lib/ai-tier-policy.mjs';

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

  // A paused matter lists nothing to a connected app (migration 070; 099).
  const paused = await pausedMatterRefusal(matterId);
  if (paused) return json(res, paused.status, paused.body);

  const { data, error } = await sb
    .from('documents')
    .select('id, title, source_filename, file_size_bytes, doc_type, processing_status, created_at')
    .eq('matterspace_id', matterId)
    .order('created_at', { ascending: false });
  if (error) return json(res, 500, { error: `query_failed: ${error.message}` });

  // The matter's EFFECTIVE tier, read with the service role — the tier is
  // policy, not content, and an ancestor's seal must reach this listing even
  // when the ancestor itself is invisible to the caller.
  let tier = null;
  let tierKnown = false;
  try {
    tier = await fetchMatterTier(
      process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      matterId,
    );
    tierKnown = Boolean(tier);
  } catch {
    tierKnown = false;
  }
  const sealed = tierKnown ? isSealedTier(tier) : true;

  return json(res, 200, {
    seal_status: tierKnown ? 'ok' : 'unknown',
    ai_tier: tierKnown ? tier : null,
    sealed,
    documents: (data ?? []).map((d) => ({
      sealed,
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
