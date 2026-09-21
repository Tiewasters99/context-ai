// Dropbox — the app-folder adapter.
//
// LEAST PRIVILEGE. One scope: `files.content.write`, on an app registered with
// the **App folder** access type. That combination can put a file into the
// app's own folder and do nothing else — it cannot list the folder, cannot
// read a file back, cannot see anything else in the account. (Dropbox
// documents `files.metadata.read` for listing and `files.content.read` for
// downloading, and says nothing about one scope implying another, so none is
// assumed.) `Full Dropbox` is what this integration must never be registered
// as, and a reviewer should treat it as a defect.
//
// Because we cannot list, we cannot check whether a name is taken — so the
// "never overwrite" promise is kept by the provider: `mode: "add"` with
// `autorename: true`, which Dropbox documents as "If there's a conflict, as
// determined by mode, have the Dropbox server try to autorename the file to
// avoid conflict." The response carries the name the file actually got.
//
// THE HEADER TRAP. Upload arguments travel in the `Dropbox-API-Arg` HTTP
// header, and Dropbox documents: "JSON-encoded arguments. Non-ASCII characters
// and 0x7F must use JSON \uXXXX escape sequences to be HTTP-header-safe."
// Matter names here carry em dashes, accents and curly quotes as a matter of
// course, so asciiJson() below is not a nicety — an unescaped header is an
// invalid HTTP request and the export fails at the door.
// (docs.dropboxapi.com/dropbox-api/docs/technical-reference/json-encoding)

import { exportPath, posixPath } from './paths.mjs';

const API = 'https://api.dropboxapi.com';
const CONTENT = 'https://content.dropboxapi.com';

// Dropbox refuses /2/files/upload above 150 MiB and says to use a session
// instead. The export cap is far below that, so this threshold is not the
// provider's limit — it is where we choose to switch, low enough that the
// session path is real code that runs rather than a branch nobody enters.
const SESSION_ABOVE = 32 * 1024 * 1024; // 32 MiB
const CHUNK = 8 * 1024 * 1024; // 8 MiB

const appKey = () => (process.env.DROPBOX_APP_KEY || '').trim();
const appSecret = () => (process.env.DROPBOX_APP_SECRET || '').trim();

export const dropbox = {
  service: 'dropbox',
  kind: 'dropbox',
  label: 'Dropbox',
  party: 'Dropbox',

  // One scope. `account_info.read` would let the card say which Dropbox
  // account the copy lands in; it is deliberately NOT requested, because the
  // account label is a convenience and the scope is not needed to export.
  scopes: ['files.content.write'],
  scopeString() { return this.scopes.join(' '); },

  redirectPath: '/api/dropbox-callback',

  requiredEnv: ['DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET'],
  missingEnv() { return this.requiredEnv.filter((k) => !(process.env[k] || '').trim()); },
  isConfigured() { return this.missingEnv().length === 0; },

  authorizeUrl({ state, codeChallenge, redirectUri }) {
    return 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
      client_id: appKey(),
      response_type: 'code',
      redirect_uri: redirectUri,
      // Without this the grant is `online` and there is no refresh token —
      // the connection would die in four hours. It is an authorize-URL
      // parameter, not an App Console setting.
      token_access_type: 'offline',
      scope: this.scopeString(),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
  },

  async exchangeCode({ code, codeVerifier, redirectUri }) {
    const r = await fetch(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        client_id: appKey(),
        client_secret: appSecret(),
        code_verifier: codeVerifier,
      }).toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: data.error || 'token_exchange_failed', detail: data.error_description };
    }
    if (!data.refresh_token) return { ok: false, error: 'no_refresh_token' };
    return {
      ok: true,
      refreshToken: data.refresh_token,
      accessToken: data.access_token || null,
      scopes: data.scope || this.scopeString(),
      // No account_info.read, so no account label. Null is the truthful
      // answer; the Connections card falls back to its description rather
      // than inventing one.
      account: null,
    };
  },

  async refresh({ refreshToken }) {
    const r = await fetch(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: appKey(),
        client_secret: appSecret(),
      }).toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.access_token) {
      return { ok: false, error: data.error || 'token_refresh_failed', detail: data.error_description };
    }
    // Dropbox does NOT rotate: "This request won't return a new refresh token
    // since refresh tokens don't expire automatically and can be reused
    // repeatedly." So nothing to store back.
    return { ok: true, accessToken: data.access_token, refreshToken: null };
  },

  /**
   * Dropbox does publish a revoke, and it is the strong one: revoking the
   * access token also disables the refresh token it came from. So a
   * disconnect here really does end the app's access, rather than only
   * forgetting it on our side.
   */
  async revoke({ accessToken }) {
    if (!accessToken) return { ok: true, revokedAtProvider: false };
    try {
      const r = await fetch(`${API}/2/auth/token/revoke`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      return { ok: true, revokedAtProvider: r.ok };
    } catch {
      return { ok: true, revokedAtProvider: false };
    }
  },

  async upload({ accessToken, matterName, filename, title, bytes }) {
    const parts = exportPath({ matterName, filename, title });
    const fullPath = posixPath(parts);

    // Best effort, exactly as api/drive-export.mjs treats ensureDriveFolder:
    // if Dropbox creates the parents on upload anyway, these are harmless;
    // if it does not, they are what makes the upload land. Either way a
    // failure here must not be the reason an export stops.
    for (let i = 1; i <= parts.folders.length; i++) {
      await createFolder(accessToken, `/${parts.folders.slice(0, i).join('/')}`);
    }

    const commit = { path: fullPath, mode: 'add', autorename: true, mute: false };
    const result = bytes.length > SESSION_ABOVE
      ? await uploadSession(accessToken, bytes, commit)
      : await uploadSimple(accessToken, bytes, commit);
    if (!result.ok) return { ok: false, error: 'dropbox_upload_failed', detail: result.detail };

    return {
      ok: true,
      fileId: result.body?.id ?? null,
      // Dropbox's own answer, so a rename it applied is what the user is told.
      name: result.body?.name ?? parts.filename,
      // No sharing scope is requested, so there is no link to hand back. The
      // banner names the folder instead of offering a button that cannot work.
      link: null,
      folderPath: parts.folders.join('/'),
      path: result.body?.path_display ?? fullPath,
    };
  },
};

// ── Dropbox helpers ──────────────────────────────────────────────────────────

/**
 * JSON, then every non-ASCII character and 0x7F turned into a \uXXXX escape —
 * the form Dropbox requires of the `Dropbox-API-Arg` header. Exported so the
 * harness can assert it on a matter name with an em dash in it.
 */
export function asciiJson(obj) {
  return JSON.stringify(obj).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

async function rpc(accessToken, path, body) {
  try {
    const r = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const parsed = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, body: parsed };
  } catch (e) {
    return { ok: false, status: 0, body: null, detail: e?.message ?? 'network_error' };
  }
}

async function content(accessToken, path, arg, bytes) {
  try {
    const r = await fetch(`${CONTENT}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/octet-stream',
        'dropbox-api-arg': asciiJson(arg),
      },
      body: bytes,
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* an error page is not JSON */ }
    return { ok: r.ok, status: r.status, body: parsed, detail: r.ok ? null : (parsed?.error_summary ?? text.slice(0, 200)) };
  } catch (e) {
    return { ok: false, status: 0, body: null, detail: e?.message ?? 'network_error' };
  }
}

/** Create one folder, treating "it is already there" as success. */
async function createFolder(accessToken, path) {
  const r = await rpc(accessToken, '/2/files/create_folder_v2', { path, autorename: false });
  if (r.ok) return true;
  // path/conflict/folder — the folder exists, which is the outcome we wanted.
  return typeof r.body?.error_summary === 'string' && r.body.error_summary.startsWith('path/conflict');
}

async function uploadSimple(accessToken, bytes, commit) {
  const r = await content(accessToken, '/2/files/upload', commit, bytes);
  return r.ok ? { ok: true, body: r.body } : { ok: false, detail: r.detail };
}

async function uploadSession(accessToken, bytes, commit) {
  const total = bytes.length;
  const start = await content(accessToken, '/2/files/upload_session/start', { close: false }, bytes.subarray(0, Math.min(CHUNK, total)));
  if (!start.ok || !start.body?.session_id) return { ok: false, detail: start.detail ?? 'session_start_failed' };
  const sessionId = start.body.session_id;
  let offset = Math.min(CHUNK, total);

  while (offset < total) {
    const end = Math.min(offset + CHUNK, total);
    const appended = await content(
      accessToken,
      '/2/files/upload_session/append_v2',
      { cursor: { session_id: sessionId, offset }, close: false },
      bytes.subarray(offset, end),
    );
    if (!appended.ok) return { ok: false, detail: appended.detail ?? 'session_append_failed' };
    offset = end;
  }

  const finished = await content(
    accessToken,
    '/2/files/upload_session/finish',
    { cursor: { session_id: sessionId, offset: total }, commit },
    Buffer.alloc(0),
  );
  if (!finished.ok) return { ok: false, detail: finished.detail ?? 'session_finish_failed' };
  return { ok: true, body: finished.body };
}

export default dropbox;
