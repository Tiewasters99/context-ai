// POST /api/move-document
//
// Reassigns a Vault document to a different matter. Multi-step: storage
// object rename, documents row update, denormalized passages update. Each
// step uses the user's Supabase session so RLS enforces membership in
// both the source and destination matters — a user can only move a doc
// to a matter they belong to. The one exception is the storage rename
// itself (migration 096; see step 1), which is authorized as the user and
// performed with the service role. Failures stop the chain; the row is left
// in whichever consistent state we reached.
//
// Request body: { documentId: uuid, newMatterspaceId: uuid }
// Response:     { ok: true, oldStoragePath, newStoragePath }
//                or { error: string } with status code

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(res, 500, { error: 'config_error' });
  }

  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return json(res, 401, { error: 'missing_bearer' });
  }
  const userToken = authHeader.slice(7).trim();
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const body = typeof req.body === 'string' ? safeJsonParse(req.body) : req.body;
  const documentId = body?.documentId;
  const newMatterspaceId = body?.newMatterspaceId;
  if (!documentId || !newMatterspaceId) {
    return json(res, 400, { error: 'documentId and newMatterspaceId required' });
  }

  // Look up the doc. RLS confirms read access on the source matter.
  const { data: doc, error: docErr } = await sb
    .from('documents')
    .select('id, matterspace_id, storage_path, source_filename')
    .eq('id', documentId)
    .maybeSingle();
  if (docErr) return json(res, 500, { error: `lookup: ${docErr.message}` });
  if (!doc) return json(res, 404, { error: 'document_not_found_or_no_access' });
  if (doc.matterspace_id === newMatterspaceId) {
    return json(res, 200, { ok: true, noop: true });
  }

  // Verify destination matter is reachable. RLS rejects if the user is
  // not a member of the destination serverspace.
  const { data: destMatter, error: destErr } = await sb
    .from('matterspaces')
    .select('id')
    .eq('id', newMatterspaceId)
    .maybeSingle();
  if (destErr) return json(res, 500, { error: `dest lookup: ${destErr.message}` });
  if (!destMatter) return json(res, 403, { error: 'destination_not_found_or_no_access' });

  const oldPath = doc.storage_path;
  let newPath = null;

  // The storage object moves with the service role when it is configured.
  // Since migration 096 the bucket hides an object in a SEALED matter from
  // the user's own JWT (a move is an UPDATE … WHERE name = …, which then
  // matches nothing), so a user-scoped move of a sealed document fails as
  // "Object not found". The authorization 049's storage policy gave is asked
  // here instead, as the user and in the same words: can_write_matter on the
  // source AND the destination.
  const storage = SERVICE_KEY
    ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    : sb;
  if (oldPath && SERVICE_KEY) {
    // The object is judged by ITS path, as the policy judged it. A row whose
    // storage_path points into some other matter is refused outright: the
    // service role must never move an object on the strength of a row.
    const pathMatter = oldPath.split('/')[0];
    if (pathMatter !== doc.matterspace_id) return json(res, 409, { error: 'path_mismatch' });
    for (const m of [pathMatter, newMatterspaceId]) {
      const { data: canWrite, error: cwErr } = await sb.rpc('can_write_matter', { p_matter_id: m });
      if (cwErr) return json(res, 500, { error: `permission check: ${cwErr.message}` });
      if (canWrite !== true) return json(res, 403, { error: 'not_permitted' });
    }
  }

  // 1) Move the storage object (if there is one). The convention is
  //    {matterspace_id}/{document_id}/{filename}.
  if (oldPath) {
    const filename = oldPath.split('/').slice(2).join('/') || (doc.source_filename ?? 'file');
    newPath = `${newMatterspaceId}/${doc.id}/${filename}`;
    const { error: mvErr } = await storage.storage.from('vault-documents').move(oldPath, newPath);
    if (mvErr) return json(res, 500, { error: `storage move: ${mvErr.message}` });
  }

  // 2) Update the documents row. If this fails after the storage move
  //    succeeded, we'd be in an inconsistent state — try to roll storage
  //    back so the row keeps matching its file.
  const { error: docUpdErr } = await sb
    .from('documents')
    .update({
      matterspace_id: newMatterspaceId,
      ...(newPath ? { storage_path: newPath } : {}),
    })
    .eq('id', documentId);
  if (docUpdErr) {
    if (oldPath && newPath) {
      await storage.storage.from('vault-documents').move(newPath, oldPath).catch(() => {});
    }
    return json(res, 500, { error: `documents update: ${docUpdErr.message}` });
  }

  // 3) Update the denormalized matterspace_id on every passage tied to
  //    this document. Passage retrieval scopes by matterspace_id, so the
  //    move isn't visible to MCP / search until this completes.
  const { error: passUpdErr } = await sb
    .from('passages')
    .update({ matterspace_id: newMatterspaceId })
    .eq('document_id', documentId);
  if (passUpdErr) {
    return json(res, 500, { error: `passages update: ${passUpdErr.message} (document moved but passages still scoped to old matter)` });
  }

  return json(res, 200, { ok: true, oldStoragePath: oldPath, newStoragePath: newPath });
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }
