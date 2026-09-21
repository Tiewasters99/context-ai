// OneDrive, through Microsoft Graph — the app-folder adapter.
//
// LEAST PRIVILEGE IS THE WHOLE POINT. The delegated permission requested here
// is `Files.ReadWrite.AppFolder`, which reaches one folder: the folder Graph
// creates for this application and nothing else in the user's drive. It is the
// exact analogue of the `drive.file` scope api/drive-export.mjs already uses
// for Google. `Files.ReadWrite` — the whole drive — is what this file must
// never ask for, and a reviewer should treat its appearance here as a defect.
//
// Two facts from the Microsoft documentation shape the code below, and both
// are easy to get wrong from memory:
//
//   1. Refresh tokens ROTATE. "Replace the old refresh token with this newly
//      acquired refresh token to ensure your refresh tokens remain valid for
//      as long as possible." So refresh() returns the new one and the caller
//      must store it. Google's does not rotate; Dropbox's does not either.
//      (learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
//   2. The chunk PUTs to an upload session's `uploadUrl` must NOT carry an
//      Authorization header: "If you include the Authorization header when
//      issuing the PUT call, it might result in an HTTP 401 Unauthorized
//      response." The URL is pre-authenticated.
//      (learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession)
//
// EVERY upload goes through an upload session, small files included. The
// simple `PUT …:/content` call documents no conflict behaviour, and a PUT to
// an existing path replaces it — which would mean an export silently
// overwriting last week's copy. `createUploadSession` documents
// `@microsoft.graph.conflictBehavior: "fail (default) | replace | rename"`, so
// asking for `rename` is the only documented way to get "never overwrite". One
// extra round trip is a fair price for a promise we can keep.

import { exportPath } from './paths.mjs';

const GRAPH = 'https://graph.microsoft.com/v1.0';

// Multiple of 320 KiB, as Graph requires ("the size of each byte range MUST be
// a multiple of 320 KiB (327,680 bytes)"), and inside the 60 MiB per-request
// ceiling. 10 MiB is the documented sweet spot for a stable connection.
const CHUNK = 10 * 1024 * 1024; // 10 MiB = 327,680 × 32

const clientId = () => (process.env.MS_OAUTH_CLIENT_ID || '').trim();
const clientSecret = () => (process.env.MS_OAUTH_CLIENT_SECRET || '').trim();
const tenant = () => (process.env.MS_OAUTH_TENANT || 'common').trim() || 'common';

const authority = () => `https://login.microsoftonline.com/${encodeURIComponent(tenant())}/oauth2/v2.0`;

export const onedrive = {
  service: 'onedrive',
  kind: 'onedrive',
  label: 'OneDrive',
  party: 'Microsoft',

  // openid + email only so the card can say WHICH account the copy lands in;
  // offline_access for the refresh token; the app folder for the file itself.
  scopes: ['openid', 'email', 'offline_access', 'Files.ReadWrite.AppFolder'],
  scopeString() { return this.scopes.join(' '); },

  redirectPath: '/api/microsoft-callback',

  requiredEnv: ['MS_OAUTH_CLIENT_ID', 'MS_OAUTH_CLIENT_SECRET'],
  missingEnv() { return this.requiredEnv.filter((k) => !(process.env[k] || '').trim()); },
  isConfigured() { return this.missingEnv().length === 0; },

  authorizeUrl({ state, codeChallenge, redirectUri }) {
    return `${authority()}/authorize?` + new URLSearchParams({
      client_id: clientId(),
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: this.scopeString(),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      // Ask every time. A silent re-consent that quietly drops offline_access
      // leaves a connection with no refresh token, which fails a week later
      // with nothing in the logs to say why.
      prompt: 'consent',
    }).toString();
  },

  async exchangeCode({ code, codeVerifier, redirectUri }) {
    const r = await fetch(`${authority()}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        scope: this.scopeString(),
      }).toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: data.error || 'token_exchange_failed', detail: data.error_description };
    }
    if (!data.refresh_token) {
      return { ok: false, error: 'no_refresh_token' };
    }
    return {
      ok: true,
      refreshToken: data.refresh_token,
      accessToken: data.access_token || null,
      scopes: data.scope || this.scopeString(),
      // The id_token came straight from Microsoft over TLS, so reading the
      // claim without re-verifying it is safe — the same thing
      // api/google-callback.mjs does. `email` may be absent even when the
      // scope was granted; the docs say so, so it is treated as optional.
      account: emailFromIdToken(data.id_token),
    };
  },

  async refresh({ refreshToken }) {
    const r = await fetch(`${authority()}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: this.scopeString(),
      }).toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.access_token) {
      return { ok: false, error: data.error || 'token_refresh_failed', detail: data.error_description };
    }
    return {
      ok: true,
      accessToken: data.access_token,
      // ROTATION. Present on every successful refresh when offline_access was
      // granted; the old one is to be discarded.
      refreshToken: data.refresh_token || null,
    };
  },

  /**
   * Microsoft publishes no API that revokes one application's delegated
   * tokens for one user. (`revokeSignInSessions` signs the user out of
   * everything, which is not ours to do.) So the honest answer is: we delete
   * our copy, and we tell the user where the grant itself is removed.
   */
  async revoke() {
    return { ok: true, revokedAtProvider: false, manageUrl: 'https://myapps.microsoft.com' };
  },

  /**
   * Put the bytes in the app folder, under Contextspaces/<matter>/<file>.
   * Never overwrites: the upload session asks for `rename`, so a second copy
   * of the same name lands beside the first with a suffix of Graph's choosing.
   */
  async upload({ accessToken, matterName, filename, title, bytes }) {
    const { folders, filename: safeName } = exportPath({ matterName, filename, title });

    const approot = await graphJson(accessToken, `${GRAPH}/me/drive/special/approot`);
    if (!approot.ok) return { ok: false, error: 'onedrive_approot_failed', detail: approot.detail };
    let parentId = approot.body.id;

    for (const folder of folders) {
      const made = await ensureChildFolder(accessToken, parentId, folder);
      if (!made.ok) return { ok: false, error: 'onedrive_folder_failed', detail: made.detail };
      parentId = made.id;
    }

    const session = await graphJson(
      accessToken,
      `${GRAPH}/me/drive/items/${encodeURIComponent(parentId)}:/${encodePathSegment(safeName)}:/createUploadSession`,
      {
        method: 'POST',
        body: JSON.stringify({
          item: { '@microsoft.graph.conflictBehavior': 'rename', name: safeName },
        }),
      },
    );
    if (!session.ok || !session.body?.uploadUrl) {
      return { ok: false, error: 'onedrive_upload_session_failed', detail: session.detail ?? session.body };
    }

    const item = await putChunks(session.body.uploadUrl, bytes);
    if (!item.ok) return { ok: false, error: 'onedrive_upload_failed', detail: item.detail };

    return {
      ok: true,
      fileId: item.body?.id ?? null,
      // Graph's own answer, which is the name after any rename it applied —
      // so the banner tells the user what the file is actually called.
      name: item.body?.name ?? safeName,
      link: item.body?.webUrl ?? null,
      folderPath: folders.join('/'),
    };
  },
};

// ── Graph helpers ────────────────────────────────────────────────────────────

/**
 * A path component inside a `…/items/{id}:/{path}:/…` address. encodeURIComponent
 * leaves `'`, `(`, `)`, `!`, `*` alone; Graph is content with those, and the
 * characters that would actually break the address are gone before this runs
 * (see lib/cloud-drives/paths.mjs).
 */
function encodePathSegment(s) {
  return encodeURIComponent(s);
}

async function graphJson(accessToken, url, init = {}) {
  let resp;
  try {
    resp = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    });
  } catch (e) {
    return { ok: false, status: 0, detail: e?.message ?? 'network_error' };
  }
  const body = await resp.json().catch(() => null);
  if (!resp.ok) return { ok: false, status: resp.status, body, detail: body?.error?.message ?? `http_${resp.status}` };
  return { ok: true, status: resp.status, body };
}

/**
 * Find-or-create one folder under a known parent. Deliberately NOT
 * conflictBehavior:'rename' — a second export must land in the SAME
 * "Contextspaces" folder, not in "Contextspaces 1". So: look first, create
 * with `fail` second, and treat a lost race (409 nameAlreadyExists) as the
 * folder already being there.
 */
async function ensureChildFolder(accessToken, parentId, name) {
  const childUrl = `${GRAPH}/me/drive/items/${encodeURIComponent(parentId)}:/${encodePathSegment(name)}`;
  const existing = await graphJson(accessToken, childUrl);
  if (existing.ok && existing.body?.id) return { ok: true, id: existing.body.id };
  if (!existing.ok && existing.status !== 404) {
    return { ok: false, detail: existing.detail };
  }

  const created = await graphJson(
    accessToken,
    `${GRAPH}/me/drive/items/${encodeURIComponent(parentId)}/children`,
    {
      method: 'POST',
      body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
    },
  );
  if (created.ok && created.body?.id) return { ok: true, id: created.body.id };
  if (created.status === 409) {
    const again = await graphJson(accessToken, childUrl);
    if (again.ok && again.body?.id) return { ok: true, id: again.body.id };
  }
  return { ok: false, detail: created.detail };
}

/**
 * Upload the bytes to a pre-authenticated session URL. No Authorization
 * header — see the file header. The last chunk's response carries the
 * driveItem; earlier ones answer 202 with the ranges still expected.
 */
async function putChunks(uploadUrl, bytes) {
  const total = bytes.length;
  if (total === 0) {
    // A zero-byte upload session has no range to send. Graph rejects an empty
    // PUT, so say so plainly rather than looping zero times and claiming
    // success for a file that never arrived.
    return { ok: false, detail: 'empty_file' };
  }
  let offset = 0;
  let last = null;
  while (offset < total) {
    const end = Math.min(offset + CHUNK, total);
    const slice = bytes.subarray(offset, end);
    let resp;
    try {
      resp = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'content-length': String(slice.length),
          'content-range': `bytes ${offset}-${end - 1}/${total}`,
        },
        body: slice,
      });
    } catch (e) {
      return { ok: false, detail: e?.message ?? 'network_error' };
    }
    const body = await resp.json().catch(() => null);
    if (!resp.ok) {
      return { ok: false, detail: body?.error?.message ?? `http_${resp.status}` };
    }
    last = body;
    offset = end;
  }
  return { ok: true, body: last };
}

function emailFromIdToken(idToken) {
  try {
    if (!idToken) return null;
    const part = String(idToken).split('.')[1];
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return claims.email || claims.preferred_username || null;
  } catch {
    return null; // the account label is best effort, never load-bearing
  }
}

export default onedrive;
