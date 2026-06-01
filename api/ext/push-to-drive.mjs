// POST /api/ext/push-to-drive
// Body: { documentId: uuid, folderName?: "Contextspaces" }
//
// Bridge endpoint for the Chrome extension's Gmail-attach flow.
// Reuses the same Google Drive multipart upload that /api/drive-export
// uses for the web UI button — same drive.file scope, same 75 MB cap,
// same "Contextspaces" folder. Difference is auth: this endpoint
// accepts a csp_* connector token instead of a Supabase session JWT,
// because the extension authenticates via paste-a-token.

import {
  authenticateConnectorToken,
  adminClient,
  corsHeaders,
  json,
  handleAuthError,
} from '../../lib/connector-token-auth.mjs';

import { decrypt } from '../../lib/connections-crypto.mjs';

const GOOGLE_CLIENT_ID = (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
const MAX_EXPORT_BYTES = 75 * 1024 * 1024;

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return json(res, 500, { error: 'google_oauth_not_configured' });
  }

  let userId;
  try {
    userId = await authenticateConnectorToken(req);
  } catch (err) {
    return handleAuthError(res, err);
  }

  const body = typeof req.body === 'string' ? safeJsonParse(req.body) : (req.body || {});
  const documentId = body.documentId;
  const folderName = typeof body.folderName === 'string' ? body.folderName.trim() : 'Contextspaces';
  if (!documentId) return json(res, 400, { error: 'documentId required' });

  const admin = adminClient();

  // Authorize the document — it must belong to a matter owned by this user.
  const { data: doc, error: docErr } = await admin
    .from('documents')
    .select('id, title, source_filename, storage_path, file_size_bytes, matterspace_id')
    .eq('id', documentId)
    .maybeSingle();
  if (docErr) return json(res, 500, { error: `document_lookup: ${docErr.message}` });
  if (!doc) return json(res, 404, { error: 'document_not_found' });
  if (!doc.storage_path) return json(res, 400, { error: 'document_has_no_file' });
  if (doc.file_size_bytes && doc.file_size_bytes > MAX_EXPORT_BYTES) {
    return json(res, 413, { error: 'file_too_large', maxBytes: MAX_EXPORT_BYTES });
  }
  const { data: matter, error: mErr } = await admin
    .from('matterspaces')
    .select('owner_id')
    .eq('id', doc.matterspace_id)
    .maybeSingle();
  if (mErr || !matter || matter.owner_id !== userId) {
    return json(res, 404, { error: 'document_not_found' });
  }

  // Google Drive connection lookup.
  const { data: conn, error: connErr } = await admin
    .from('connections')
    .select('encrypted_refresh_token, status')
    .eq('user_id', userId)
    .eq('kind', 'google_drive')
    .maybeSingle();
  if (connErr) return json(res, 500, { error: `connection_lookup: ${connErr.message}` });
  if (!conn) return json(res, 412, { error: 'drive_not_connected' });

  let refreshToken;
  try { refreshToken = decrypt(conn.encrypted_refresh_token); }
  catch (e) { return json(res, 500, { error: `decrypt_failed: ${e.message}` }); }

  // Refresh access token.
  let accessToken;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    const data = await r.json();
    if (!r.ok || !data.access_token) {
      if (data.error === 'invalid_grant') {
        await admin
          .from('connections')
          .update({ status: 'needs_attention', last_error: 'invalid_grant', updated_at: new Date().toISOString() })
          .eq('user_id', userId).eq('kind', 'google_drive');
        return json(res, 412, { error: 'drive_needs_reconnect' });
      }
      return json(res, 500, { error: `token_refresh: ${data.error || 'unknown'}` });
    }
    accessToken = data.access_token;
  } catch (e) {
    return json(res, 500, { error: `token_refresh_failed: ${e.message}` });
  }

  // Download the blob.
  const { data: blob, error: dlErr } = await admin.storage
    .from('vault-documents')
    .download(doc.storage_path);
  if (dlErr || !blob) return json(res, 500, { error: `storage_download: ${dlErr?.message ?? 'no_blob'}` });
  const bytes = Buffer.from(await blob.arrayBuffer());
  if (bytes.length > MAX_EXPORT_BYTES) {
    return json(res, 413, { error: 'file_too_large', maxBytes: MAX_EXPORT_BYTES });
  }

  // Find-or-create Contextspaces folder.
  let parentFolderId = null;
  if (folderName) {
    try { parentFolderId = await ensureDriveFolder(accessToken, folderName); }
    catch (e) { console.warn('ensureDriveFolder failed:', e.message); }
  }

  const filename = doc.source_filename || `${(doc.title || 'document').replace(/[\\/:*?"<>|]+/g, '_')}`;
  const contentType = mimeFor(filename);

  // Multipart upload.
  const boundary = 'csp_drive_boundary_' + Math.random().toString(36).slice(2);
  const metadata = {
    name: filename,
    ...(parentFolderId ? { parents: [parentFolderId] } : {}),
  };
  const head =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) + `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const multipartBody = Buffer.concat([
    Buffer.from(head, 'utf8'),
    bytes,
    Buffer.from(tail, 'utf8'),
  ]);

  let driveResult;
  try {
    const r = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,webContentLink,name',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': String(multipartBody.length),
        },
        body: multipartBody,
      },
    );
    driveResult = await r.json();
    if (!r.ok || !driveResult.id) {
      return json(res, 500, { error: 'drive_upload_failed', detail: driveResult });
    }
  } catch (e) {
    return json(res, 500, { error: `drive_upload_threw: ${e.message}` });
  }

  return json(res, 200, {
    ok: true,
    driveFileId: driveResult.id,
    webViewLink: driveResult.webViewLink || null,
    name: driveResult.name || filename,
    folderName: parentFolderId ? folderName : null,
  });
}


async function ensureDriveFolder(accessToken, folderName) {
  const safe = folderName.replace(/'/g, "\\'");
  const listUrl = 'https://www.googleapis.com/drive/v3/files?' + new URLSearchParams({
    q: `name='${safe}' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents`,
    fields: 'files(id,name)',
    pageSize: '1',
  }).toString();
  const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const listData = await listResp.json();
  if (listResp.ok && listData.files && listData.files.length) return listData.files[0].id;
  const createResp = await fetch(
    'https://www.googleapis.com/drive/v3/files?fields=id',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
      }),
    },
  );
  const createData = await createResp.json();
  if (!createResp.ok || !createData.id) {
    throw new Error(createData.error?.message || 'folder_create_failed');
  }
  return createData.id;
}

function mimeFor(filename) {
  const ext = filename.toLowerCase().split('.').pop() || '';
  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'doc': return 'application/msword';
    case 'txt': return 'text/plain';
    case 'md': case 'markdown': return 'text/markdown';
    case 'csv': return 'text/csv';
    case 'json': return 'application/json';
    case 'html': case 'htm': return 'text/html';
    case 'epub': return 'application/epub+zip';
    case 'fountain': return 'text/plain';
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    default: return 'application/octet-stream';
  }
}

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }
