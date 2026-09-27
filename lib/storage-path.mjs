// A stored object belongs to the matter its path names — and to no other.
//
// Every object in vault-documents lives at "<matter id>/<document id>/<file>"
// (016's convention). The bucket's own policies judge an object by that first
// segment; everything else judges a document by its row's matterspace_id. The
// two used to be free to disagree, and that is a hole: a member of an open
// matter could insert or edit a documents row there whose storage_path names
// an object in a SEALED matter (or another firm's matter), and every server
// route that reads bytes with the service role — the export routes, ingest,
// the worker, get_media — would fetch that object on the strength of the
// pointer row, with lib/export-gate.mjs judging the seal by the pointer's
// matter. Raw bytes would leave.
//
// ROUND 2 (adversarial review of #249): the first segment alone is not enough.
// storage-js builds `${url}/object/${bucket}/${path}` and Node's fetch
// resolves dot segments as a WHATWG URL does, so "OPEN/../SEALED/doc/file"
// passes a first-segment test and Storage receives the SEALED key; with two
// dot segments it can even change bucket. "%2e%2e" and "..\" do the same. So
// a path is accepted only in its exact canonical shape:
//
//   vault-documents   <lowercase matter uuid>/<segment>/<segment>
//                     (exactly three segments)
//   discovery-files   <lowercase matter uuid>/<production uuid>/<segment>[/…]
//
// and, for both: no empty, "." or ".." segment, no "%", no backslash, no
// control character, and the path must survive a round trip through a URL
// unchanged (belt and braces: whatever a URL parser would rewrite, we refuse).
// The matter segment is compared EXACTLY — never lower-cased — so this agrees
// with migration 097's case-sensitive CHECK.
//
// Migration 097 makes the database refuse such a row (a CHECK on documents
// and on production_items). This is the same rule in code, asked immediately
// before any service-role read, so a route never depends on the constraint
// having been pasted — and a row that somehow predates it is refused rather
// than served.

const UUID_LC = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class StoragePathMismatchError extends Error {
  constructor() {
    super('This document’s stored file is not filed under its own matter, so it was not read.');
    this.name = 'StoragePathMismatchError';
    this.code = 'storage_path_mismatch';
  }
}

/**
 * Every segment is a plain name: no traversal, no encoding, no separators a
 * URL or a filesystem would reinterpret. Returns the segments, or null.
 */
function plainSegments(p) {
  if (typeof p !== 'string' || !p || p.length > 1024) return null;
  if (p.includes('%') || p.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return null;
  const segs = p.split('/');
  for (const s of segs) {
    if (!s || s === '.' || s === '..') return null;
    // Round 3: a segment never starts or ends with whitespace (097's CHECK
    // says the same; a URL parser trims the end of a path).
    if (/^\s|\s$/.test(s)) return null;
  }
  // What a URL parser would do to it (dot segments, '?' and '#', …) must be
  // nothing. The pathname comes back percent-encoded (a space is "%20"), and
  // `p` holds no '%', so decoding recovers `p` exactly when nothing moved.
  try {
    if (decodeURI(new URL(`http://x/${p}`).pathname) !== `/${p}`) return null;
  } catch {
    return null;
  }
  return segs;
}

/** The exact vault shape: <lowercase matter uuid>/<segment>/<segment>. */
export function isCanonicalStoragePath(p) {
  const segs = plainSegments(p);
  return Boolean(segs) && segs.length === 3 && UUID_LC.test(segs[0]);
}

/** The matter a canonical vault path names, or null. */
export function storageMatterOf(storagePath) {
  return isCanonicalStoragePath(storagePath) ? storagePath.split('/')[0] : null;
}

/** Does this path belong to this matter? A null path is no bytes at all: true. */
export function pathInMatter(storagePath, matterId) {
  if (storagePath == null || storagePath === '') return true;
  if (!isCanonicalStoragePath(storagePath) || matterId == null) return false;
  return storagePath.split('/')[0] === String(matterId);
}

/**
 * Throw StoragePathMismatchError unless `storagePath` lives under
 * `matterId`. Call it before ANY service-role read of the object.
 */
export function assertPathInMatter(storagePath, matterId) {
  if (!pathInMatter(storagePath, matterId)) throw new StoragePathMismatchError();
}

/**
 * discovery-files: does this path live inside THIS production of THIS matter
 * — "<matter>/<production>/…", at least one segment below, all plain?
 */
export function pathInProduction(storagePath, matterId, productionId) {
  const segs = plainSegments(storagePath);
  if (!segs || segs.length < 3 || matterId == null || productionId == null) return false;
  return UUID_LC.test(segs[0]) && segs[0] === String(matterId) && segs[1] === String(productionId);
}

export function assertPathInProduction(storagePath, matterId, productionId) {
  if (!pathInProduction(storagePath, matterId, productionId)) throw new StoragePathMismatchError();
}

export function isStoragePathMismatch(err) {
  return err?.code === 'storage_path_mismatch';
}
