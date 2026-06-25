// POST /api/gmail-send
//
// "Email this document" — creates a Gmail DRAFT in the user's mailbox with
// one Vault document attached. We deliberately create a DRAFT (not a sent
// message): the user opens it in Gmail, addresses it, writes their note, and
// sends it themselves. This is the clean replacement for the old Chrome-
// extension "push to Drive then click the Drive icon" dance — the file is
// actually attached to the email.
//
// Request body:
//   { documentId: uuid }
//   { documentId: uuid, subject?: string, body?: string }   (optional prefill)
//
// Response:
//   { ok: true, draftId, name, draftsUrl }
//   { error: string }                                        (on failure)
//
// Auth: Supabase session JWT. RLS gates the documents lookup. The Gmail
// connection (kind 'gmail', gmail.compose scope) is resolved by the same user.
//
// Env required on Vercel:
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, CONNECTIONS_ENC_KEY

import { createClient } from '@supabase/supabase-js';
import { decrypt } from '../lib/connections-crypto.mjs';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();

// Gmail's hard attachment ceiling is 25 MB; base64 inflates ~33%, so the raw
// RFC822 message stays well within Gmail's limits at this cap.
const MAX_EMAIL_BYTES = 25 * 1024 * 1024;

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

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
  const documentId = body?.documentId;
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
  if (doc.file_size_bytes && doc.file_size_bytes > MAX_EMAIL_BYTES) {
    return json(res, 413, { error: 'file_too_large', maxBytes: MAX_EMAIL_BYTES, actualBytes: doc.file_size_bytes });
  }

  // Gmail connection lookup via service role (user already verified above).
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: conn, error: connErr } = await admin
    .from('connections')
    .select('encrypted_refresh_token, status, scopes')
    .eq('user_id', userId)
    .eq('kind', 'gmail')
    .maybeSingle();
  if (connErr) return json(res, 500, { error: `connection_lookup: ${connErr.message}` });
  if (!conn) return json(res, 412, { error: 'gmail_not_connected' });
  // If we recorded the granted scopes and compose isn't among them, the user
  // connected Gmail before the compose upgrade — they must reconnect.
  if (conn.scopes && !/gmail\.compose/.test(conn.scopes)) {
    return json(res, 412, { error: 'gmail_needs_reconnect', reason: 'compose_scope_missing' });
  }

  let refreshToken;
  try { refreshToken = decrypt(conn.encrypted_refresh_token); }
  catch (e) { return json(res, 500, { error: `decrypt_failed: ${e.message}` }); }

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
      const errMsg = data.error || 'token_refresh_failed';
      if (errMsg === 'invalid_grant') {
        await admin.from('connections')
          .update({ status: 'needs_attention', last_error: 'invalid_grant', updated_at: new Date().toISOString() })
          .eq('user_id', userId).eq('kind', 'gmail');
        return json(res, 412, { error: 'gmail_needs_reconnect' });
      }
      return json(res, 500, { error: `token_refresh: ${errMsg}` });
    }
    accessToken = data.access_token;
  } catch (e) {
    return json(res, 500, { error: `token_refresh_failed: ${e.message}` });
  }

  // Download the blob from Vault storage (service role — user already authorized).
  const { data: blob, error: dlErr } = await admin.storage
    .from('vault-documents')
    .download(doc.storage_path);
  if (dlErr || !blob) return json(res, 500, { error: `storage_download: ${dlErr?.message ?? 'no_blob'}` });
  const bytes = Buffer.from(await blob.arrayBuffer());
  if (bytes.length > MAX_EMAIL_BYTES) {
    return json(res, 413, { error: 'file_too_large', maxBytes: MAX_EMAIL_BYTES, actualBytes: bytes.length });
  }

  const filename = (doc.source_filename || `${(doc.title || 'document').replace(/[\\/:*?"<>|]+/g, '_')}`);
  const contentType = mimeFor(filename);
  const subject = (typeof body.subject === 'string' && body.subject.trim())
    ? body.subject.trim()
    : (doc.title || filename);
  const textBody = (typeof body.body === 'string' && body.body)
    ? body.body
    : `Attached: ${filename}\n\n(Exported from Contextspaces.)`;

  // Build the raw RFC822 message: a text part + the document as a base64
  // attachment. No To: header — the user fills in the recipient in Gmail.
  const boundary = 'csp_mail_' + Math.random().toString(36).slice(2);
  const b64 = bytes.toString('base64').replace(/(.{76})/g, '$1\r\n');
  const mime =
    `Subject: ${encodeHeader(subject)}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset="UTF-8"\r\n\r\n` +
    `${textBody}\r\n\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${contentType}; name="${filename}"\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `Content-Disposition: attachment; filename="${filename}"\r\n\r\n` +
    `${b64}\r\n` +
    `--${boundary}--`;

  // uploadType=media: send the raw RFC822 message as the body, which handles
  // attachment sizes far better than base64url-in-JSON.
  let draft;
  try {
    const r = await fetch(
      'https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media&fields=id,message/id',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'message/rfc822' },
        body: mime,
      },
    );
    draft = await r.json();
    if (!r.ok || !draft.id) {
      // 403 with insufficientPermissions => compose scope not actually granted.
      const detailMsg = draft?.error?.message || '';
      if (r.status === 403 && /insufficient|scope|permission/i.test(detailMsg)) {
        return json(res, 412, { error: 'gmail_needs_reconnect', reason: 'compose_scope_missing' });
      }
      return json(res, 500, { error: 'gmail_draft_failed', detail: draft });
    }
  } catch (e) {
    return json(res, 500, { error: `gmail_draft_threw: ${e.message}` });
  }

  return json(res, 200, {
    ok: true,
    draftId: draft.id,
    name: filename,
    // Gmail has no per-draft deep link that reliably opens compose, so point
    // the user at their Drafts — the just-created draft is at the top.
    draftsUrl: 'https://mail.google.com/mail/u/0/#drafts',
  });
}

// RFC 2047 encode a header value if it has non-ASCII chars, so subjects with
// accents/emoji don't corrupt the message.
function encodeHeader(s) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
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
