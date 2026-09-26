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
// Migration 097 makes the database refuse such a row (a CHECK on documents).
// This is the same rule in code, asked immediately before any service-role
// read, so a route never depends on the constraint having been pasted — and
// so a row that somehow predates it is refused rather than served.

export class StoragePathMismatchError extends Error {
  constructor() {
    super('This document’s stored file is filed under a different matter, so it was not read.');
    this.name = 'StoragePathMismatchError';
    this.code = 'storage_path_mismatch';
  }
}

/** The matter a storage path names: its first segment, lower-cased, or null. */
export function storageMatterOf(storagePath) {
  if (typeof storagePath !== 'string' || !storagePath) return null;
  const first = storagePath.split('/')[0];
  return first ? first.toLowerCase() : null;
}

/** Does this path belong to this matter? A null path belongs to nobody's bytes: true. */
export function pathInMatter(storagePath, matterId) {
  if (storagePath == null || storagePath === '') return true;
  const m = storageMatterOf(storagePath);
  return Boolean(m) && matterId != null && m === String(matterId).toLowerCase();
}

/**
 * Throw StoragePathMismatchError unless `storagePath` lives under
 * `matterId`. Call it before ANY service-role read of the object.
 */
export function assertPathInMatter(storagePath, matterId) {
  if (!pathInMatter(storagePath, matterId)) throw new StoragePathMismatchError();
}

export function isStoragePathMismatch(err) {
  return err?.code === 'storage_path_mismatch';
}
