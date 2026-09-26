// POST /api/document-url — the one door to a sealed matter's bytes
//
// docs/specs/SECURITY-BUILD-2026-09-26.md §S4a. Migration 096 makes the
// storage bucket refuse a signed-in user an object whose matter is sealed
// (effective tier B or C, inherited), so for those documents the browser can
// no longer mint a URL itself. It asks here instead, and this endpoint:
//
//   1. verifies the bearer with Supabase Auth, as every api/ file does, and
//      refuses a token our own MCP server minted for a connector (094 lets
//      those through the step-up gate because the seal governs connectors;
//      this door is for people's browser sessions only);
//   2. finds the document AS THE USER — RLS decides whether it exists for
//      them — and then asks 094's gate out loud, `matter_entry(matter)` as
//      the user. `documents` is not itself step-up gated (094's header), so
//      loading the row proves membership and nothing more; the probe is what
//      turns an aal1 session on a sealed matter into the step-up prompt;
//   3. decides `sealed` with the service role — the same
//      effective_tier_is_sealed the bucket policy asks, so the door and the
//      wall cannot disagree (a caller who cannot see a sealed PARENT must
//      still get the sealed answer — lib/export-gate.mjs's reason);
//   4. mints a 900-second signed URL with the service role;
//   5. writes to the matter's Record, as the user:
//        file.opened   {document_id, title, purpose, sealed: true}  — sealed, either purpose
//        file.exported {document_id, title, destination: 'download'} — any matter, purpose 'download'
//      and on a sealed matter hands the URL over ONLY if every row landed.
//      The order is mint-then-record so that a mint that fails writes
//      nothing, and a record that fails hands out nothing.
//
// What does NOT come here: opening a document to read on an unsealed (Tier A)
// matter. The browser keeps minting those itself and nothing is recorded —
// the spec's choice, and the claims table (§4) says so. A Tier A `read` that
// does arrive here (the client falling back after a refused direct mint) is
// served and recorded nowhere, which is exactly what the direct path does.
//
// Request  { document_id? | path?, bucket?: 'vault-documents' | 'discovery-files',
//            purpose: 'read' | 'download' }
//   vault-documents: document_id, or the document's own storage_path. The
//     URL is always for the ROW's storage_path, never for a path the caller
//     named, and a row whose path points into a different matter is refused.
//   discovery-files: path (production display PDFs, natives, packages have
//     no documents row). The matter is the path's first segment; 030's
//     membership rule (serverspace members) is asked as the user.
// Response { url, expires_in, sealed, recorded, filename }
// Refusals 401 missing_bearer / invalid_session · 403 step_up_required {mode}
//          · 403 browser_sessions_only · 404 not_found · 409 path_mismatch
//          · 503 seal_unresolved / record_failed (nothing handed out)
//
// Plain fetch with an injectable fetchImpl, like api/account-sessions.mjs, so
// scripts/_verify-sealed-download.mjs drives this file against a real
// Postgres with no network.

import {
  json, corsPreflight, bearerFrom, readJsonBody, authUser, jwtClaims, serviceRpc,
  userRpcClient, SUPABASE_URL, ANON_KEY, SERVICE_KEY,
} from '../lib/account-security.mjs';
import { record } from '../lib/ledger.mjs';
import { walkEffectiveTier, isSealedTier } from '../lib/ai-tier-policy.mjs';

export const URL_TTL_SECONDS = 900;
const TIMEOUT_MS = 8000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKETS = new Set(['vault-documents', 'discovery-files']);
const PURPOSES = new Set(['read', 'download']);

const base = () => String(SUPABASE_URL() || '').replace(/\/$/, '');

/** PostgREST's "that function is not in the schema" — the migration is not pasted yet. */
const rpcNotDeployed = (r) => r.status === 404 || r.error === 'PGRST202' || r.error === '42883';

/** The matter an object belongs to: its first path segment (016 / 030 / 096). */
export function matterOfPath(p) {
  const first = String(p ?? '').split('/')[0];
  return UUID_RE.test(first) ? first.toLowerCase() : null;
}

/**
 * A caller-named storage path we are willing to sign: "<matter>/…", no empty
 * or dot segments, no backslashes, nothing that could be read as a second
 * path. Only discovery-files takes one; vault paths come from the row.
 */
export function safeObjectPath(p) {
  if (typeof p !== 'string' || p.length > 1024) return null;
  if (!matterOfPath(p)) return null;
  const segs = p.split('/');
  if (segs.length < 2) return null;
  for (const s of segs) {
    if (!s || s === '.' || s === '..' || /[\\\u0000-\u001f]/.test(s)) return null;
  }
  return p;
}

const basename = (p) => String(p ?? '').split('/').pop() || 'file';

/** A GET against PostgREST as the user: RLS decides what comes back. */
async function userRows(bearer, pathAndQuery, doFetch) {
  try {
    const res = await doFetch(`${base()}/rest/v1/${pathAndQuery}`, {
      headers: { apikey: ANON_KEY(), authorization: `Bearer ${bearer}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, rows: [] };
    return { ok: true, status: res.status, rows: Array.isArray(data) ? data : [] };
  } catch {
    return { ok: false, status: 0, rows: [] };
  }
}

/** A GET against PostgREST as the service role — policy lookups only, never content. */
async function serviceRows(pathAndQuery, doFetch) {
  try {
    const res = await doFetch(`${base()}/rest/v1/${pathAndQuery}`, {
      headers: { apikey: SERVICE_KEY(), authorization: `Bearer ${SERVICE_KEY()}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, rows: [] };
    return { ok: true, rows: Array.isArray(data) ? data : [] };
  } catch {
    return { ok: false, rows: [] };
  }
}

/**
 * Is this matter sealed, as the bucket policy sees it? The 094 helper through
 * the service role; before 094 is pasted, the tier walk the pen gate uses.
 * null = could not tell, which every caller treats as a refusal.
 */
async function isSealedMatter(matterId, doFetch) {
  const r = await serviceRpc('effective_tier_is_sealed', { p_matter: matterId }, { fetchImpl: doFetch });
  if (r.ok && typeof r.data === 'boolean') return r.data;
  if (!r.ok && rpcNotDeployed(r)) {
    try {
      const fetchRow = async (id) => {
        const m = await serviceRows(`matterspaces?select=id,parent_matterspace_id,ai_tier&id=eq.${id}&limit=1`, doFetch);
        if (!m.ok) throw new Error('tier lookup failed');
        return m.rows[0] ?? null;
      };
      const tier = await walkEffectiveTier(fetchRow, matterId);
      return tier == null ? null : isSealedTier(tier);
    } catch {
      return null;
    }
  }
  return null;
}

/** Service-role signed URL, in supabase-js's shape (…/storage/v1/object/sign/…?token=…). */
async function mintSignedUrl(bucket, objectPath, { download = null } = {}, doFetch) {
  const encoded = objectPath.split('/').map(encodeURIComponent).join('/');
  try {
    const res = await doFetch(`${base()}/storage/v1/object/sign/${bucket}/${encoded}`, {
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
    const dl = download ? `&download=${encodeURIComponent(download)}` : '';
    return `${base()}/storage/v1${signed}${dl}`;
  } catch {
    return null;
  }
}

export default async function handler(req, res, deps = {}) {
  const doFetch = deps.fetchImpl || globalThis.fetch;
  if (corsPreflight(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  if (!SUPABASE_URL() || !ANON_KEY() || !SERVICE_KEY()) return json(res, 500, { error: 'config_error' });

  // 1. Who is asking.
  const bearer = bearerFrom(req);
  if (!bearer) return json(res, 401, { error: 'missing_bearer' });
  const user = await authUser(bearer, { fetchImpl: doFetch });
  if (!user) return json(res, 401, { error: 'invalid_session' });
  if (jwtClaims(bearer).cs_via === 'connector') {
    return json(res, 403, { error: 'browser_sessions_only' });
  }

  const body = await readJsonBody(req);
  const purpose = body?.purpose;
  if (!PURPOSES.has(purpose)) return json(res, 400, { error: 'purpose must be read or download' });
  const bucket = body?.bucket ?? 'vault-documents';
  if (!BUCKETS.has(bucket)) return json(res, 400, { error: 'unknown bucket' });

  // 2. What, and whose. Everything the caller cannot see is 'not_found' —
  // the same answer as a document that does not exist.
  let objectPath;
  let matterId;
  let documentId = null;
  let title;
  let filename;

  if (bucket === 'vault-documents') {
    const docId = typeof body?.document_id === 'string' && UUID_RE.test(body.document_id) ? body.document_id : null;
    const byPath = !docId && typeof body?.path === 'string' ? safeObjectPath(body.path) : null;
    if (!docId && !byPath) return json(res, 400, { error: 'document_id or path required' });
    // By path: the convention is <matter>/<document id>/<filename>, so the
    // row is found by its id and must then own exactly this path. (A path
    // that does not follow the convention falls back to an equality match.)
    const idInPath = byPath ? byPath.split('/')[1] : null;
    const filter = docId
      ? `id=eq.${docId}`
      : UUID_RE.test(idInPath ?? '')
        ? `id=eq.${idInPath}`
        : `storage_path=eq.${encodeURIComponent(byPath)}`;
    const r = await userRows(
      bearer,
      `documents?select=id,title,storage_path,matterspace_id,source_filename&${filter}&limit=1`,
      doFetch,
    );
    if (!r.ok) return json(res, 503, { error: 'lookup_failed' });
    const doc = r.rows[0];
    if (!doc || (byPath && doc.storage_path !== byPath)) return json(res, 404, { error: 'not_found' });
    if (!doc.storage_path) return json(res, 404, { error: 'no_stored_file' });
    // The bucket judges an object by its path; the Record files it under the
    // row's matter. They must be the same matter, or a writer in one matter
    // could point a row of theirs at another matter's object and have this
    // endpoint's service role fetch it for them.
    matterId = matterOfPath(doc.storage_path);
    if (!matterId || matterId !== String(doc.matterspace_id).toLowerCase()) {
      return json(res, 409, { error: 'path_mismatch' });
    }
    objectPath = doc.storage_path;
    documentId = doc.id;
    title = doc.title || doc.source_filename || basename(objectPath);
    filename = doc.source_filename || basename(objectPath);
  } else {
    objectPath = safeObjectPath(body?.path);
    if (!objectPath) return json(res, 400, { error: 'path required' });
    matterId = matterOfPath(objectPath);
    // 030's rule, asked as the user: a member of the matter's serverspace.
    const m = await serviceRows(`matterspaces?select=id,serverspace_id&id=eq.${matterId}&limit=1`, doFetch);
    if (!m.ok) return json(res, 503, { error: 'lookup_failed' });
    const ss = m.rows[0]?.serverspace_id;
    if (!ss) return json(res, 404, { error: 'not_found' });
    const member = await userRpcClient(bearer, { fetchImpl: doFetch })
      .rpc('is_serverspace_member', { p_serverspace_id: ss });
    if (member.error) return json(res, 503, { error: 'lookup_failed' });
    if (member.data !== true) return json(res, 404, { error: 'not_found' });
    title = basename(objectPath);
    filename = title;
  }

  // 3. The step-up gate (094), asked out loud. 'none' after a row RLS
  // already showed us cannot happen for a member; it is refused anyway.
  const entry = await userRpcClient(bearer, { fetchImpl: doFetch })
    .rpc('matter_entry', { p_matter: matterId });
  if (entry.error) {
    const notPasted = entry.error.code === 'PGRST202' || entry.error.code === '404' || entry.error.code === '42883';
    if (!notPasted) return json(res, 503, { error: 'seal_unresolved' });
    // 094 not pasted: there is no step-up gate to ask, and no 096 either.
  } else if (entry.data === 'stepup' || entry.data === 'enrol') {
    return json(res, 403, { error: 'step_up_required', mode: entry.data, matter_id: matterId });
  } else if (entry.data !== 'open') {
    return json(res, 404, { error: 'not_found' });
  }

  // 4. Sealed? Fails closed.
  const sealed = await isSealedMatter(matterId, doFetch);
  if (sealed === null) return json(res, 503, { error: 'seal_unresolved' });

  // 5. The URL. A download carries its filename so the browser saves it
  // under the name it was filed with.
  const url = await mintSignedUrl(bucket, objectPath, { download: purpose === 'download' ? filename : null }, doFetch);
  if (!url) return json(res, 404, { error: 'not_found' });

  // 6. The Record. METADATA ONLY: an id, a title, why — never the path, never
  // the URL (its token is a credential for fifteen minutes).
  const ledger = userRpcClient(bearer, { fetchImpl: doFetch });
  const actor = { kind: 'user', ref: user.id, user_id: user.id };
  const where = bucket === 'discovery-files' ? { bucket } : {};
  const rows = [];
  if (sealed) {
    rows.push({
      kind: 'file.opened',
      payload: { document_id: documentId, title, purpose, sealed: true, ...where },
    });
  }
  if (purpose === 'download') {
    rows.push({
      kind: 'file.exported',
      payload: { document_id: documentId, title, destination: 'download', sealed, ...where },
    });
  }

  let recorded = rows.length > 0;
  for (const row of rows) {
    const out = await record(ledger, { kind: row.kind, matterId, actor, payload: row.payload });
    if (!out?.ok) {
      recorded = false;
      // A sealed matter's copy does not leave unrecorded — not even when the
      // ledger is "not deployed", which on a database that has 096 cannot be
      // true. The URL just minted is dropped here, never sent.
      if (sealed) return json(res, 503, { error: 'record_failed' });
      console.warn(`[document-url] ${row.kind} not recorded for an unsealed matter: ${out?.error?.message ?? 'unknown'}`);
    }
  }

  return json(res, 200, { url, expires_in: URL_TTL_SECONDS, sealed, recorded, filename });
}
