// POST /api/editions — the one door to an edition's files
//
// docs/specs/GRAPHEON-READER-2026-10-10.md, "The edition" and "The reader
// app". The `editions` bucket is private and `edition_assets` is readable by
// the publisher alone (migration 112), so a reader who owns a book cannot
// see where its file is, let alone sign a URL for it. They ask here, and
// this endpoint:
//
//   1. verifies the bearer with Supabase Auth, as every api/ file does;
//   2. asks 112's own question AS THE USER — `_edition_can_read(edition)`,
//      SECURITY INVOKER, granted to authenticated: the publisher; or a
//      published free edition; or an unrefunded purchase (withdrawn included,
//      owners keep what they bought). Nothing here restates that rule;
//   3. reads the asset rows with the service role (the table hides them from
//      readers) and mints short-lived signed URLs with the service role.
//
// Actions (request { edition_id, action, ... })
//   book            → { url, expires_in, bytes, mime }   the edition's PDF
//   sign, path      → { url, expires_in }                 one asset by its storage path
//   illustrations   → { illustrations: [...] }            what is laid on the pages, with
//                     each clip's asset (id, storage_path, mime) — the publisher sees every
//                     row, a reader the rows that shipped in a version they can read
//   copy_book, document_id → { asset, title }           the bridge from Contextspaces: a
//                     PDF the caller can open in the Vault, copied server-side into the
//                     edition as its book (publisher only; a sealed matter is refused —
//                     a seal is a promise that nothing leaves)
// Refusals 401 missing_bearer / invalid_session · 403 not_readable / not_publisher / sealed
//          · 404 not_found · 400 bad_request · 500 config_error
//          · 503 storage_unavailable / seal_unresolved / copy_failed
//
// Plain fetch with an injectable fetchImpl, like api/document-url.mjs, so
// scripts/_test-editions-api.mjs drives this file with no network.

import {
  json, corsPreflight, bearerFrom, readJsonBody, authUser, serviceRpc,
  userRpcClient, SUPABASE_URL, ANON_KEY, SERVICE_KEY,
} from '../lib/account-security.mjs';

export const URL_TTL_SECONDS = 3600;
const TIMEOUT_MS = 8000;
const BUCKET = 'editions';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['book', 'sign', 'illustrations', 'copy_book']);
const VAULT_BUCKET = 'vault-documents';

const base = () => String(SUPABASE_URL() || '').replace(/\/$/, '');

/** A storage path we are willing to sign: "<edition>/…", no empty or dot
 *  segments, no backslashes. The asset row is still looked up by it. */
export function pathInEdition(editionId, p) {
  const s = String(p ?? '');
  if (!s || s.includes('\\') || s.length > 512) return false;
  const parts = s.split('/');
  if (parts.length < 2) return false;
  if (parts[0].toLowerCase() !== String(editionId).toLowerCase()) return false;
  return parts.slice(1).every((seg) => seg && seg !== '.' && seg !== '..');
}

/** A PostgREST read as the SERVICE role. */
async function serviceSelect(table, query, doFetch) {
  try {
    const res = await doFetch(`${base()}/rest/v1/${table}?${query}`, {
      headers: { apikey: SERVICE_KEY(), authorization: `Bearer ${SERVICE_KEY()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status, rows: null };
    const rows = await res.json().catch(() => null);
    return { ok: Array.isArray(rows), status: res.status, rows: Array.isArray(rows) ? rows : null };
  } catch {
    return { ok: false, status: 0, rows: null };
  }
}

/** A PostgREST read AS THE USER: RLS decides what exists for them. */
async function userSelect(bearer, table, query, doFetch) {
  try {
    const res = await doFetch(`${base()}/rest/v1/${table}?${query}`, {
      headers: { apikey: ANON_KEY(), authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status, rows: null };
    const rows = await res.json().catch(() => null);
    return { ok: Array.isArray(rows), status: res.status, rows: Array.isArray(rows) ? rows : null };
  } catch {
    return { ok: false, status: 0, rows: null };
  }
}

/** A PostgREST write as the SERVICE role, returning the row. */
async function serviceWrite(method, table, query, body, doFetch) {
  try {
    const res = await doFetch(`${base()}/rest/v1/${table}${query ? `?${query}` : ''}`, {
      method,
      headers: {
        'content-type': 'application/json',
        apikey: SERVICE_KEY(),
        authorization: `Bearer ${SERVICE_KEY()}`,
        prefer: 'return=representation',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, row: null, error: data?.message ?? `write_${res.status}` };
    return { ok: true, status: res.status, row: Array.isArray(data) ? data[0] ?? null : data, error: null };
  } catch (err) {
    return { ok: false, status: 0, row: null, error: err?.message || 'write_unreachable' };
  }
}

/** Is this matter sealed, as the bucket policy sees it (094's helper, service role)?
 *  null = could not tell, which is a refusal. */
async function isSealedMatter(matterId, doFetch) {
  const r = await serviceRpc('effective_tier_is_sealed', { p_matter: matterId }, { fetchImpl: doFetch });
  return r.ok && typeof r.data === 'boolean' ? r.data : null;
}

/** Copy one object between buckets, server-side, with the service role. */
async function copyObject({ fromBucket, fromKey, toBucket, toKey }, doFetch) {
  try {
    const res = await doFetch(`${base()}/storage/v1/object/copy`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SERVICE_KEY(),
        authorization: `Bearer ${SERVICE_KEY()}`,
      },
      body: JSON.stringify({ bucketId: fromBucket, sourceKey: fromKey, destinationBucket: toBucket, destinationKey: toKey }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: data?.message ?? data?.error ?? `copy_${res.status}` };
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err?.message || 'copy_unreachable' };
  }
}

function safeName(name) {
  const printable = Array.from(String(name ?? '')).filter((c) => c.charCodeAt(0) >= 32).join('');
  const cleaned = printable.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned.slice(-120) || 'book.pdf';
}

/** Service-role signed URL, in supabase-js's shape (…/storage/v1/object/sign/…?token=…). */
async function mintSignedUrl(objectPath, doFetch) {
  const encoded = objectPath.split('/').map(encodeURIComponent).join('/');
  try {
    const res = await doFetch(`${base()}/storage/v1/object/sign/${BUCKET}/${encoded}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SERVICE_KEY(),
        authorization: `Bearer ${SERVICE_KEY()}`,
      },
      body: JSON.stringify({ expiresIn: URL_TTL_SECONDS }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    const signed = data?.signedURL ?? data?.signedUrl;
    if (!res.ok || typeof signed !== 'string') return null;
    return `${base()}/storage/v1${signed}`;
  } catch {
    return null;
  }
}

/** An asset row in the shape AnimationLayer / WorkshopPanel read (`media`). */
function mediaOf(asset) {
  if (!asset) return null;
  const name = String(asset.storage_path ?? '').split('/').pop() ?? null;
  return { id: asset.id, title: name ?? asset.id, storage_path: asset.storage_path ?? null, source_filename: name };
}

export default async function handler(req, res, deps = {}) {
  const doFetch = deps.fetchImpl || globalThis.fetch;
  if (corsPreflight(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  if (!SUPABASE_URL() || !ANON_KEY() || !SERVICE_KEY()) return json(res, 500, { error: 'config_error' });

  const bearer = bearerFrom(req);
  if (!bearer) return json(res, 401, { error: 'missing_bearer' });
  const user = await authUser(bearer, { fetchImpl: doFetch });
  if (!user) return json(res, 401, { error: 'invalid_session' });

  const body = await readJsonBody(req);
  const editionId = String(body?.edition_id ?? '').toLowerCase();
  const action = String(body?.action ?? '');
  if (!UUID_RE.test(editionId)) return json(res, 400, { error: 'bad_request', detail: 'edition_id must be a uuid' });
  if (!ACTIONS.has(action)) return json(res, 400, { error: 'bad_request', detail: 'action must be book, sign or illustrations' });

  // 112's question, asked as the user. A false is a refusal; an error is the
  // migration not applied yet, which reads the same from outside.
  const asUser = userRpcClient(bearer, { fetchImpl: doFetch });
  const can = await asUser.rpc('_edition_can_read', { p_edition: editionId });
  if (can.error || can.data !== true) return json(res, 403, { error: 'not_readable' });

  if (action === 'book') {
    const r = await serviceSelect(
      'edition_assets',
      `select=id,storage_path,bytes,mime&edition_id=eq.${editionId}&kind=eq.book&order=created_at.desc&limit=1`,
      doFetch,
    );
    if (!r.ok) return json(res, 503, { error: 'storage_unavailable' });
    const asset = r.rows[0];
    if (!asset?.storage_path) return json(res, 404, { error: 'not_found', detail: 'no book file' });
    const url = await mintSignedUrl(asset.storage_path, doFetch);
    if (!url) return json(res, 503, { error: 'storage_unavailable' });
    return json(res, 200, { url, expires_in: URL_TTL_SECONDS, bytes: asset.bytes ?? null, mime: asset.mime ?? null });
  }

  if (action === 'sign') {
    const path = String(body?.path ?? '');
    if (!pathInEdition(editionId, path)) return json(res, 400, { error: 'bad_request', detail: 'path must be inside the edition' });
    // Only a path the edition's own asset table names: a file dropped in the
    // folder by other means is not an asset.
    const r = await serviceSelect(
      'edition_assets',
      `select=id&edition_id=eq.${editionId}&storage_path=eq.${encodeURIComponent(path)}&limit=1`,
      doFetch,
    );
    if (!r.ok) return json(res, 503, { error: 'storage_unavailable' });
    if (!r.rows[0]) return json(res, 404, { error: 'not_found' });
    const url = await mintSignedUrl(path, doFetch);
    if (!url) return json(res, 503, { error: 'storage_unavailable' });
    return json(res, 200, { url, expires_in: URL_TTL_SECONDS });
  }

  const ed = await serviceSelect('editions', `select=publisher_user_id,version&id=eq.${editionId}&limit=1`, doFetch);
  if (!ed.ok) return json(res, 503, { error: 'storage_unavailable' });
  const edition = ed.rows[0];
  if (!edition) return json(res, 404, { error: 'not_found' });
  const isPublisher = String(edition.publisher_user_id).toLowerCase() === String(user.id).toLowerCase();

  if (action === 'copy_book') {
    // The bridge from Contextspaces (spec: "New edition … pick a book"). The
    // document is read AS THE USER, so RLS says whether it exists for them;
    // the publisher check is the edition's; the seal is asked with the
    // service role, as the bucket policy would, and a sealed matter's file
    // does not leave it. The copy itself is server-side: nothing is
    // downloaded to the phone and uploaded again.
    if (!isPublisher) return json(res, 403, { error: 'not_publisher' });
    const documentId = String(body?.document_id ?? '').toLowerCase();
    if (!UUID_RE.test(documentId)) return json(res, 400, { error: 'bad_request', detail: 'document_id must be a uuid' });
    const d = await userSelect(
      bearer, 'documents',
      `select=id,title,storage_path,file_size_bytes,matterspace_id,source_filename&id=eq.${documentId}&limit=1`,
      doFetch,
    );
    if (!d.ok) return json(res, 503, { error: 'storage_unavailable' });
    const doc = d.rows[0];
    if (!doc?.storage_path) return json(res, 404, { error: 'not_found' });
    const fileName = String(doc.source_filename || doc.storage_path.split('/').pop() || '');
    if (!/\.pdf$/i.test(fileName) && !/\.pdf$/i.test(String(doc.storage_path))) {
      return json(res, 400, { error: 'bad_request', detail: 'only a PDF can be an edition' });
    }
    if (doc.matterspace_id) {
      const sealed = await isSealedMatter(doc.matterspace_id, doFetch);
      if (sealed === null) return json(res, 503, { error: 'seal_unresolved' });
      if (sealed) return json(res, 403, { error: 'sealed' });
    }
    const toKey = `${editionId}/book/${Date.now().toString(36)}-${safeName(fileName)}`;
    const copied = await copyObject({ fromBucket: VAULT_BUCKET, fromKey: doc.storage_path, toBucket: BUCKET, toKey }, doFetch);
    if (!copied.ok) return json(res, 503, { error: 'copy_failed', detail: copied.error });
    const asset = await serviceWrite('POST', 'edition_assets', '', {
      edition_id: editionId, kind: 'book', storage_path: toKey, bytes: doc.file_size_bytes ?? null, mime: 'application/pdf',
    }, doFetch);
    if (!asset.ok || !asset.row) return json(res, 503, { error: 'storage_unavailable', detail: asset.error });
    await serviceWrite('PATCH', 'editions', `id=eq.${editionId}`, { source_document_id: documentId }, doFetch);
    return json(res, 200, { asset: asset.row, title: doc.title ?? null });
  }

  // illustrations: the rows and their clips. Which rows depends on who asks —
  // the publisher sees the draft (every row); a reader, what shipped.
  const versionFilter = isPublisher ? '' : `&version_from=lte.${Number(edition.version) || 0}`;
  const r = await serviceSelect(
    'edition_illustrations',
    `select=id,edition_id,asset_id,user_id,page,rect,turn,loops,label,version_from,created_at,updated_at,` +
      `asset:edition_assets(id,storage_path,mime)` +
      `&edition_id=eq.${editionId}${versionFilter}&order=page.asc,created_at.asc`,
    doFetch,
  );
  if (!r.ok) return json(res, 503, { error: 'storage_unavailable' });
  const illustrations = r.rows.map((row) => ({
    id: row.id,
    document_id: row.edition_id,
    media_document_id: row.asset_id,
    user_id: row.user_id,
    page: row.page,
    rect: row.rect,
    turn: row.turn,
    loops: row.loops,
    label: row.label,
    version_from: row.version_from,
    created_at: row.created_at,
    updated_at: row.updated_at,
    media: mediaOf(row.asset),
  }));
  return json(res, 200, { illustrations, version: edition.version, publisher: isPublisher });
}
