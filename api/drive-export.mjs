// POST /api/drive-export
//
// Pushes one Vault document into the user's Google Drive. The connected
// google_drive integration (drive.file scope) lets us create files in
// the user's Drive — but never read or touch anything we didn't create.
//
// Request body:
//   { documentId: uuid }            (default: drop in Drive root)
//   { documentId: uuid, folderName: "Contextspaces" }  (optional folder)
//
// Response:
//   { ok: true, driveFileId, webViewLink, name }
//   { error: string }                                  (on failure)
//
// Auth: Supabase session JWT. RLS gates the documents lookup, so a user
// can only export documents they own. The Google Drive connection is
// resolved by the same user_id via the connections table.
//
// Env required on Vercel:
//   VITE_SUPABASE_URL
//   VITE_SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   CONNECTIONS_ENC_KEY

import { createClient } from '@supabase/supabase-js';

import { decrypt } from '../lib/connections-crypto.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();

// Hard cap so a single export can't blow past the Vercel 30s budget —
// downloading from storage + uploading to Drive both take real time.
const MAX_EXPORT_BYTES = 75 * 1024 * 1024; // 75 MB

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  // Env sanity
  const missing = [];
  if (!SUPABASE_URL) missing.push('VITE_SUPABASE_URL');
  if (!SUPABASE_ANON_KEY) missing.push('VITE_SUPABASE_ANON_KEY');
  if (!SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!GOOGLE_CLIENT_ID) missing.push('GOOGLE_OAUTH_CLIENT_ID');
  if (!GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_OAUTH_CLIENT_SECRET');
  if (!process.env.CONNECTIONS_ENC_KEY) missing.push('CONNECTIONS_ENC_KEY');
  if (missing.length) return json(res, 500, { error: 'config_error', missing_env: missing });

  // Auth — forward the user's Supabase access token so RLS does its job.
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return json(res, 401, { error: 'missing_bearer' });
  }
  const userToken = authHeader.slice(7).trim();
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return json(res, 401, { error: 'invalid_session' });
  const userId = userData.user.id;

  // Parse body.
  const body = typeof req.body === 'string' ? safeJsonParse(req.body) : (req.body || {});
  const documentId = body.documentId;
  const folderName = typeof body.folderName === 'string' ? body.folderName.trim() : '';
  if (!documentId) return json(res, 400, { error: 'documentId required' });

  // Document lookup — RLS rejects this if the user doesn't have access.
  const { data: doc, error: docErr } = await sb
    .from('documents')
    .select('id, title, source_filename, storage_path, file_size_bytes')
    .eq('id', documentId)
    .maybeSingle();
  if (docErr) return json(res, 500, { error: `document_lookup: ${docErr.message}` });
  if (!doc) return json(res, 404, { error: 'document_not_found' });
  if (!doc.storage_path) return json(res, 400, { error: 'document_has_no_file' });
  if (doc.file_size_bytes && doc.file_size_bytes > MAX_EXPORT_BYTES) {
    return json(res, 413, {
      error: 'file_too_large',
      maxBytes: MAX_EXPORT_BYTES,
      actualBytes: doc.file_size_bytes,
    });
  }

  // Google Drive connection lookup via service role (RLS would also work
  // but service role is simpler since we already verified the user above).
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: conn, error: connErr } = await admin
    .from('connections')
    .select('encrypted_refresh_token, status')
    .eq('user_id', userId)
    .eq('kind', 'google_drive')
    .maybeSingle();
  if (connErr) return json(res, 500, { error: `connection_lookup: ${connErr.message}` });
  if (!conn) return json(res, 412, { error: 'drive_not_connected' });

  let refreshToken;
  try {
    refreshToken = decrypt(conn.encrypted_refresh_token);
  } catch (e) {
    return json(res, 500, { error: `decrypt_failed: ${e.message}` });
  }

  // Exchange the refresh token for an access token.
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
      // Surface a clear hint when Google says the refresh token is dead.
      const errMsg = data.error || 'token_refresh_failed';
      if (errMsg === 'invalid_grant') {
        await admin
          .from('connections')
          .update({ status: 'needs_attention', last_error: 'invalid_grant', updated_at: new Date().toISOString() })
          .eq('user_id', userId).eq('kind', 'google_drive');
        return json(res, 412, { error: 'drive_needs_reconnect' });
      }
      return json(res, 500, { error: `token_refresh: ${errMsg}` });
    }
    accessToken = data.access_token;
  } catch (e) {
    return json(res, 500, { error: `token_refresh_failed: ${e.message}` });
  }

  // Download the blob from Vault storage (service role — we've already
  // authorized the user via the documents lookup above).
  const { data: blob, error: dlErr } = await admin.storage
    .from('vault-documents')
    .download(doc.storage_path);
  if (dlErr || !blob) return json(res, 500, { error: `storage_download: ${dlErr?.message ?? 'no_blob'}` });
  const bytes = Buffer.from(await blob.arrayBuffer());
  if (bytes.length > MAX_EXPORT_BYTES) {
    return json(res, 413, { error: 'file_too_large', maxBytes: MAX_EXPORT_BYTES, actualBytes: bytes.length });
  }

  // Optional folder — create-or-find under Drive root.
  let parentFolderId = null;
  if (folderName) {
    try {
      parentFolderId = await ensureDriveFolder(accessToken, folderName);
    } catch (e) {
      // Folder creation failure shouldn't block the export — fall back
      // to root so the user still gets the file. Log it on the response
      // so the UI can warn.
      console.warn('ensureDriveFolder failed:', e.message);
    }
  }

  // Determine filename + content type from the source file.
  const filename = doc.source_filename || `${(doc.title || 'document').replace(/[\\/:*?"<>|]+/g, '_')}`;
  const contentType = mimeFor(filename);

  // Multipart upload — single request keeps it inside the 30s budget.
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
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,name',
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


// Find or create a folder under My Drive root, return its id. drive.file
// scope is enough — we can see and manage any folder this app created.
async function ensureDriveFolder(accessToken, folderName) {
  const safe = folderName.replace(/'/g, "\\'");
  const listUrl = 'https://www.googleapis.com/drive/v3/files?' + new URLSearchParams({
    q: `name='${safe}' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents`,
    fields: 'files(id,name)',
    pageSize: '1',
  }).toString();
  const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const listData = await listResp.json();
  if (listResp.ok && listData.files && listData.files.length) {
    return listData.files[0].id;
  }
  const createResp = await fetch(
    'https://www.googleapis.com/drive/v3/files?fields=id',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
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
    case 'svg': return 'image/svg+xml';
    case 'bmp': return 'image/bmp';
    case 'tiff': case 'tif': return 'image/tiff';
    default: return 'application/octet-stream';
  }
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify(obj));
}

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }
