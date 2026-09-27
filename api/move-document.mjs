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
// Before anything moves (S4a, after the adversarial review of #247): the
// step-up gate is asked for BOTH matters as the user (094's matter_entry —
// the documents row is not step-up gated, so an aal1 session could otherwise
// carry a sealed document into a matter it can read directly); a document in
// a sealed matter moves only to a matter sealed at least as tightly (S7
// decides anything more); connector-stamped tokens are refused, as at
// /api/document-url; and `file.exported {destination:'move', to_matter}` is
// written on the SOURCE matter's Record — on a sealed source, nothing moves
// unless that row landed.
//
// Request body: { documentId: uuid, newMatterspaceId: uuid }
// Response:     { ok: true, oldStoragePath, newStoragePath }
//                or { error: string } with status code

import { createClient } from '@supabase/supabase-js';
import { jwtClaims } from '../lib/account-security.mjs';
import { isSealedTier } from '../lib/ai-tier-policy.mjs';
import { effectiveTier, entryRefusal, crossingRefusal, recordCrossing } from '../lib/seal-crossing.mjs';
import { pathInMatter } from '../lib/storage-path.mjs';
import { repointDocumentJobs } from '../lib/job-scope.mjs';

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
  // 094 lets a token our own MCP server minted for a connector past the
  // step-up gate (the seal governs connectors). A move can carry a sealed
  // document out of its room, so this door, like /api/document-url, is for
  // people's browser sessions only.
  if (jwtClaims(userToken).cs_via === 'connector') {
    return json(res, 403, { error: 'browser_sessions_only' });
  }
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return json(res, 401, { error: 'invalid_session' });
  const userId = userData.user.id;

  const body = typeof req.body === 'string' ? safeJsonParse(req.body) : req.body;
  const documentId = body?.documentId;
  const newMatterspaceId = body?.newMatterspaceId;
  if (!documentId || !newMatterspaceId) {
    return json(res, 400, { error: 'documentId and newMatterspaceId required' });
  }

  // Look up the doc. RLS confirms read access on the source matter.
  const { data: doc, error: docErr } = await sb
    .from('documents')
    .select('id, title, matterspace_id, storage_path, source_filename')
    .eq('id', documentId)
    .maybeSingle();
  if (docErr) return json(res, 500, { error: `lookup: ${docErr.message}` });
  if (!doc) return json(res, 404, { error: 'document_not_found_or_no_access' });
  if (doc.matterspace_id === newMatterspaceId) {
    return json(res, 200, { ok: true, noop: true });
  }
  // 097: the object is filed under the row's own matter, or nothing moves —
  // the service role below must never move an object on the strength of a
  // row that points somewhere else.
  if (!pathInMatter(doc.storage_path, doc.matterspace_id)) {
    return json(res, 409, { error: 'storage_path_mismatch' });
  }

  // Verify destination matter is reachable. RLS rejects if the user is
  // not a member of the destination serverspace (and, since 094, if it is
  // sealed and this session has not stepped up).
  const { data: destMatter, error: destErr } = await sb
    .from('matterspaces')
    .select('id')
    .eq('id', newMatterspaceId)
    .maybeSingle();
  if (destErr) return json(res, 500, { error: `dest lookup: ${destErr.message}` });

  // THE STEP-UP GATE (094), asked out loud for BOTH ends, as the user. The
  // documents row is not step-up gated (094's header), so reading it proves
  // membership and nothing more; without this an aal1 session could carry a
  // sealed document into a matter it can read directly.
  // (lib/seal-crossing.mjs, shared with the Workbench's /api/sandbox.)
  const gate = await entryRefusal(sb, [doc.matterspace_id, newMatterspaceId]);
  if (gate) return json(res, gate.status, gate.body);
  if (!destMatter) return json(res, 403, { error: 'destination_not_found_or_no_access' });

  // THE SEAL (S4a; S7 decides what may cross a sealed container's edge). A
  // document may move deeper into the seal or sideways within it, never out
  // to anything less sealed. The tiers are read with the service role, so an
  // inherited seal counts even when the parent is invisible to the caller.
  const tierOpts = { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY, userClient: sb };
  const [srcTier, destTier] = await Promise.all(
    [doc.matterspace_id, newMatterspaceId].map((m) => effectiveTier(m, tierOpts)));
  if (!srcTier || !destTier) return json(res, 503, { error: 'seal_unresolved' });
  const sourceSealed = isSealedTier(srcTier);
  const crossing = crossingRefusal(srcTier, destTier, 'move');
  if (crossing) return json(res, crossing.status, crossing.body);

  // 049's storage rule, asked as the user in the same words: may this person
  // write the source AND the destination?
  for (const m of [doc.matterspace_id, newMatterspaceId]) {
    const { data: canWrite, error: cwErr } = await sb.rpc('can_write_matter', { p_matter_id: m });
    if (cwErr) return json(res, 500, { error: `permission check: ${cwErr.message}` });
    if (canWrite !== true) return json(res, 403, { error: 'not_permitted' });
  }

  // THE RECORD, BEFORE ANYTHING MOVES. A move is a copy that leaves its
  // matter, so the source matter's Record says where it went. On a sealed
  // source nothing moves unless the row landed; on an open one a Record that
  // cannot be written is logged and the move goes on (the document stays in
  // the firm, in a matter the person can already open).
  const recorded = await recordCrossing(sb, {
    userId, doc, verb: 'move', toMatter: newMatterspaceId, sealed: sourceSealed,
  });
  if (!recorded.ok) {
    if (sourceSealed) return json(res, 503, { error: 'record_failed' });
    console.warn(`[move-document] file.exported not recorded: ${recorded.error?.message ?? 'unknown'}`);
  }

  const oldPath = doc.storage_path;
  let newPath = null;

  // The storage object moves with the service role when it is configured.
  // Since migration 096 the bucket hides an object in a SEALED matter from
  // the user's own JWT (a move is an UPDATE … WHERE name = …, which then
  // matches nothing), so a user-scoped move of a sealed document fails as
  // "Object not found". Everything above is what authorizes it.
  const storage = SERVICE_KEY
    ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    : sb;

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
  //    Exactly one row, or nothing else happens: RLS turns a caller who may
  //    read the document but not write it into a silent zero-row update, and
  //    step 4 must never re-point a job on the strength of a move that did not
  //    happen (097 round 4 review).
  const { data: updRows, error: docUpdErr } = await sb
    .from('documents')
    .update({
      matterspace_id: newMatterspaceId,
      ...(newPath ? { storage_path: newPath } : {}),
    })
    .eq('id', documentId)
    .select('id');
  if (docUpdErr || updRows?.length !== 1) {
    if (oldPath && newPath) {
      await storage.storage.from('vault-documents').move(newPath, oldPath).catch(() => {});
    }
    return docUpdErr
      ? json(res, 500, { error: `documents update: ${docUpdErr.message}` })
      : json(res, 403, { error: 'not_permitted' });
  }

  // 3) Update the denormalized matterspace_id on every passage tied to
  //    this document. Passage retrieval scopes by matterspace_id, so the
  //    move isn't visible to MCP / search until this completes.
  const { error: passUpdErr } = await sb
    .from('passages')
    .update({ matterspace_id: newMatterspaceId })
    .eq('document_id', documentId);

  // 4) Carry its queued ingest job along (097 round 4). The member cannot
  //    update processing_jobs; the service role can, and the move above was
  //    authorized as the member. Without this a document filed into another
  //    matter tree right after upload would sit 'pending' for ever.
  if (SERVICE_KEY) {
    await repointDocumentJobs(
      createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }),
      [documentId], newMatterspaceId);
  }
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
