// POST /api/cloud-export
//
// Pushes one Vault document into the user's OneDrive or Dropbox. The sibling
// of api/drive-export.mjs, which stays exactly as it is: Google's path is not
// touched by this file, not refactored into it, and not shared with it. One
// working route is not worth risking to save a hundred lines.
//
// Request body:
//   { service: 'onedrive' | 'dropbox', documentId: uuid }
//   { ..., confirm_leave_seal: true }    after a 409 from the export gate
//
// Response:
//   { ok: true, service, fileId, name, link, folderPath }
//   { error: string, ... }
//
// Auth: Supabase session JWT. RLS gates the documents lookup, so a user can
// only export documents they own. The drive connection is resolved by the same
// user_id on the connections table.
//
// WHERE THE FILE LANDS. Inside the application's own folder — the only place
// either token can reach — under `Contextspaces/<matter name>/<filename>`.
// Names are sanitized (lib/cloud-drives/paths.mjs) and a name already in use
// is never overwritten: OneDrive is asked for `@microsoft.graph.conflictBehavior:
// "rename"`, Dropbox for `mode: "add", autorename: true`.
//
// DORMANT UNTIL REGISTERED. With MS_OAUTH_CLIENT_ID/SECRET or
// DROPBOX_APP_KEY/SECRET absent this answers 503 `not_configured` naming the
// variables, before the session is even read.
//
// Env required on Vercel:
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//   CONNECTIONS_ENC_KEY, and the two variables for whichever service is used.

import { createClient } from '@supabase/supabase-js';

import { decrypt, encrypt } from '../lib/connections-crypto.mjs';
import { applyCors, getDrive, json, notConfigured } from '../lib/cloud-drives/index.mjs';
import { checkExport, sealResult } from '../lib/export-gate.mjs'; // gate:import
import { pathInMatter } from '../lib/storage-path.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// The same ceiling api/drive-export.mjs applies, for the same reason: a single
// export has to finish inside the function's time budget, and downloading from
// storage plus uploading to the provider both take real time.
const MAX_EXPORT_BYTES = 75 * 1024 * 1024; // 75 MB

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  const body = typeof req.body === 'string' ? safeJsonParse(req.body) : (req.body || {});
  const service = typeof body?.service === 'string' ? body.service : '';
  const drive = getDrive(service);
  if (!drive) return json(res, 400, { error: 'unknown_service', service });

  // Before anything else, including the session: an application that has not
  // been registered cannot export, and saying so costs nothing.
  if (!drive.isConfigured()) return notConfigured(res, drive);

  const missing = [];
  if (!SUPABASE_URL) missing.push('VITE_SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) missing.push('VITE_SUPABASE_ANON_KEY');
  if (!SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!process.env.CONNECTIONS_ENC_KEY) missing.push('CONNECTIONS_ENC_KEY');
  if (missing.length) return json(res, 500, { error: 'config_error', missing_env: missing });

  // Auth — forward the user's Supabase access token so RLS does its job.
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !String(authHeader).toLowerCase().startsWith('bearer ')) {
    return json(res, 401, { error: 'missing_bearer' });
  }
  const userToken = String(authHeader).slice(7).trim();
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return json(res, 401, { error: 'invalid_session' });
  const userId = userData.user.id;

  const documentId = body.documentId;
  if (!documentId) return json(res, 400, { error: 'documentId required' });

  // Document lookup — RLS rejects this if the user doesn't have access.
  const { data: doc, error: docErr } = await sb
    .from('documents')
    .select('id, title, source_filename, storage_path, file_size_bytes, matterspace_id')
    .eq('id', documentId)
    .maybeSingle();
  if (docErr) return json(res, 500, { error: `document_lookup: ${docErr.message}` });
  if (!doc) return json(res, 404, { error: 'document_not_found' });
  if (!doc.storage_path) return json(res, 400, { error: 'document_has_no_file' });
  // 097: the stored file must be filed under this document's own matter. A
  // row pointing at another matter's object is refused before the service
  // role reads a byte (lib/storage-path.mjs says why).
  if (!pathInMatter(doc.storage_path, doc.matterspace_id)) return json(res, 409, { error: 'storage_path_mismatch' });
  if (doc.file_size_bytes && doc.file_size_bytes > MAX_EXPORT_BYTES) {
    return json(res, 413, {
      error: 'file_too_large',
      maxBytes: MAX_EXPORT_BYTES,
      actualBytes: doc.file_size_bytes,
    });
  }

  // ── SecureSpace export gate ─────────────────────────────────── gate:start
  // Eden's rule of 2026-09-20: a sealed matter's document may leave, but never
  // silently. Identical placement to api/drive-export.mjs and for the identical
  // reason — this runs BEFORE the connection row is read, before the token
  // refresh, before the matter's name is looked up and before a single byte is
  // downloaded from storage. A 409 here is a promise about the process, not a
  // claim in the prose: nothing was fetched and nothing was sent. The account
  // label goes into the record so the Record says WHICH OneDrive or Dropbox the
  // copy went to; it is a label, never a token.
  const gate = await checkExport({
    supabase: sb,
    userId,
    documentId,
    destination: { service: drive.service, account: await accountLabel(sb, userId, drive.kind) },
    confirmed: body.confirm_leave_seal === true,
  });
  if (!gate.ok) return json(res, gate.status, gate.body);
  // ───────────────────────────────────────────────────────────────── gate:end

  // The drive connection, via the service role (the user was authorized above).
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: conn, error: connErr } = await admin
    .from('connections')
    .select('encrypted_refresh_token, status')
    .eq('user_id', userId)
    .eq('kind', drive.kind)
    .maybeSingle();
  if (connErr) return json(res, 500, { error: `connection_lookup: ${connErr.message}` });
  if (!conn) return json(res, 412, { error: 'cloud_not_connected', service: drive.service });

  let refreshToken;
  try {
    refreshToken = decrypt(conn.encrypted_refresh_token);
  } catch (e) {
    return json(res, 500, { error: `decrypt_failed: ${e.message}` });
  }

  const refreshed = await drive.refresh({ refreshToken });
  if (!refreshed.ok) {
    // A dead grant is a reconnect, not a mystery. Mark the row so the
    // Connections card says "Needs attention" before the next attempt.
    await admin
      .from('connections')
      .update({
        status: 'needs_attention',
        last_error: String(refreshed.error ?? 'token_refresh_failed').slice(0, 200),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId).eq('kind', drive.kind);
    return json(res, 412, { error: 'cloud_needs_reconnect', service: drive.service, detail: refreshed.detail ?? null });
  }
  // Microsoft ROTATES refresh tokens — the one we just used is spent and the
  // new one must replace it, or the connection dies on a later export with
  // nothing to explain it. Dropbox does not rotate and returns null here.
  if (refreshed.refreshToken && refreshed.refreshToken !== refreshToken) {
    await admin
      .from('connections')
      .update({
        encrypted_refresh_token: encrypt(refreshed.refreshToken),
        last_verified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId).eq('kind', drive.kind);
  }

  // The matter's name, for the folder. Best effort and user-scoped: a document
  // whose matter this user cannot read simply lands one level up, under
  // Contextspaces/, rather than failing the export.
  const matterName = await matterNameFor(sb, doc.matterspace_id);

  // Download the blob from Vault storage (service role — the user was already
  // authorized by the documents lookup above).
  const { data: blob, error: dlErr } = await admin.storage
    .from('vault-documents')
    .download(doc.storage_path);
  if (dlErr || !blob) return json(res, 500, { error: `storage_download: ${dlErr?.message ?? 'no_blob'}` });
  const bytes = Buffer.from(await blob.arrayBuffer());
  if (bytes.length > MAX_EXPORT_BYTES) {
    return json(res, 413, { error: 'file_too_large', maxBytes: MAX_EXPORT_BYTES, actualBytes: bytes.length });
  }

  const uploaded = await drive.upload({
    accessToken: refreshed.accessToken,
    matterName,
    filename: doc.source_filename,
    title: doc.title,
    bytes,
  });
  if (!uploaded.ok) {
    return json(res, 502, { error: uploaded.error, service: drive.service, detail: uploaded.detail ?? null });
  }

  return json(res, 200, {
    ok: true,
    service: drive.service,
    label: drive.label,
    fileId: uploaded.fileId,
    name: uploaded.name,
    link: uploaded.link,
    folderPath: uploaded.folderPath,
    ...(uploaded.path ? { path: uploaded.path } : {}),
    ...(sealResult(gate) ? { seal: sealResult(gate) } : {}), // gate:line
  });
}

/**
 * The account a connection is attached to — an email for OneDrive, null for
 * Dropbox (no `account_info.read` scope is requested). Read with the user's
 * own client, so it is a label they can already see on the Connections page.
 */
async function accountLabel(sb, userId, kind) {
  try {
    const { data } = await sb
      .from('connections')
      .select('connected_email')
      .eq('user_id', userId)
      .eq('kind', kind)
      .maybeSingle();
    return data?.connected_email ?? null;
  } catch {
    return null;
  }
}

async function matterNameFor(sb, matterspaceId) {
  if (!matterspaceId) return null;
  try {
    const { data } = await sb
      .from('matterspaces')
      .select('name')
      .eq('id', matterspaceId)
      .maybeSingle();
    return data?.name ?? null;
  } catch {
    return null;
  }
}

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }
