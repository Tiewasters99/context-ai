// Vault persistence: bridges the in-memory VaultFile UI model to Supabase.
//
// When a Vault is opened in matter context (URL ?matter=<short_code|uuid>):
//   - new files uploaded → vault-documents storage + documents row + ingest API
//   - file list hydrates from documents table on mount
//   - status reflects documents.processing_status (extracting → ready)
//
// When a Vault is opened without a matter, none of this runs and the UI
// stays in the original ephemeral mode.

import { supabase } from './supabase';
import type { VaultFile } from './vault-types';
// The pipeline's own accepted-types list and storage cap (lib/ingest-formats.mjs
// is dependency-free and shared with the Node side), so the pre-upload
// refusals here can never drift from what /api/ingest actually handles.
import type { OcrPending } from '../../lib/ingest-formats.mjs';
import { checkUpload, type UploadRefusal } from '../../lib/ingest-formats.mjs';
// Resumable (TUS) uploads for large files (Phase 4): the same dependency-free
// module the Node smoke test drives against the real bucket.
import { uploadResumable, shouldUploadResumable, storageResumeStore, type UploadProgress } from '../../lib/tus-upload.mjs';

export interface MatterRef {
  id: string;
  name: string;
  short_code: string | null;
  cover_url: string | null;
  serverspace_id: string;
  serverspace_name: string;
  parent_matterspace_id: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


// -----------------------------------------------------------------------------
// Resolve the URL's matter param (short_code or UUID) to {id, name, short_code}
// -----------------------------------------------------------------------------

// Transient query failures — most commonly an expired session token being
// refreshed right as the app opens, sometimes a network blip — used to be
// swallowed here and returned as empty/null, which rendered a perfectly
// healthy matter as an EMPTY FOLDER with no error and no retry (reported
// 2026-08-10: "Blue Book / Robert Frost not showing up"). Retry briefly,
// then THROW so callers show a real error instead of a convincing blank.
async function withRetries<T>(
  label: string,
  run: () => PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T | null> {
  let lastMsg = 'unknown error';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600 * attempt));
    const { data, error } = await run();
    if (!error) return data;
    lastMsg = error.message;
    console.error(`${label} (attempt ${attempt + 1}/3):`, error.message);
  }
  throw new Error(`${label}: ${lastMsg}`);
}

type MatterRow = {
  id: string;
  name: string;
  short_code: string | null;
  cover_url: string | null;
  serverspace_id: string;
  parent_matterspace_id: string | null;
  serverspace: { name: string } | null;
};

export async function resolveMatter(key: string): Promise<MatterRef | null> {
  // Pull the serverspace name in the same round-trip so the Vault can
  // render a breadcrumb without a second query.
  const sel = 'id, name, short_code, cover_url, serverspace_id, parent_matterspace_id, serverspace:serverspaces(name)';
  const data = await withRetries<MatterRow>('resolve matter', () =>
    (UUID_RE.test(key)
      ? supabase.from('matterspaces').select(sel).eq('id', key).maybeSingle()
      : supabase.from('matterspaces').select(sel).eq('short_code', key).maybeSingle()
    ) as unknown as PromiseLike<{ data: MatterRow | null; error: { message: string } | null }>,
  );
  if (!data) return null;
  // Supabase types the joined serverspace as an object | null on a non-array FK.
  const serverspace = (data as unknown as { serverspace: { name: string } | null }).serverspace;
  return {
    id: data.id,
    name: data.name,
    short_code: data.short_code,
    cover_url: data.cover_url,
    serverspace_id: data.serverspace_id,
    serverspace_name: serverspace?.name ?? '',
    parent_matterspace_id: data.parent_matterspace_id,
  };
}


// -----------------------------------------------------------------------------
// Hydrate the file list for a matter from the documents table.
// -----------------------------------------------------------------------------
export async function listMatterDocuments(matterspaceId: string): Promise<VaultFile[]> {
  const data = await withRetries('list documents', () =>
    supabase
      .from('documents')
      .select('id, title, source_filename, file_size_bytes, processing_status, processing_error, matterspace_id, storage_path, text_status:metadata->>text_status, ocr_pending:metadata->ocr_pending')
      .eq('matterspace_id', matterspaceId)
      .order('created_at', { ascending: false }),
  );
  return (data || []).map((d) => documentToVaultFile(d));
}

// Hydrate from a set of matter ids (parent + descendants). Each row carries
// matterspace_id + matterspace_name so the Vault file list can group by matter.
export async function listMatterDocumentsRecursive(
  matterIds: string[],
  nameById: Map<string, string>,
): Promise<VaultFile[]> {
  if (matterIds.length === 0) return [];
  const data = await withRetries('list documents', () =>
    supabase
      .from('documents')
      .select('id, title, source_filename, file_size_bytes, processing_status, processing_error, matterspace_id, storage_path, text_status:metadata->>text_status, ocr_pending:metadata->ocr_pending')
      .in('matterspace_id', matterIds)
      .order('created_at', { ascending: false }),
  );
  return (data || []).map((d) => documentToVaultFile(d, nameById.get(d.matterspace_id)));
}

function documentToVaultFile(doc: {
  id: string;
  title: string | null;
  source_filename: string | null;
  file_size_bytes: number | null;
  processing_status: string;
  processing_error: string | null;
  matterspace_id?: string;
  storage_path?: string | null;
  text_status?: string | null;
  /** metadata->ocr_pending arrives typed as Json; narrowed below. */
  ocr_pending?: unknown;
}, matterspace_name?: string): VaultFile {
  const name = doc.source_filename || doc.title || 'Untitled';
  const sizeBytes = doc.file_size_bytes || 0;
  return {
    id: doc.id,
    name,
    path: name,
    sizeBytes,
    size: formatSize(sizeBytes),
    type: name.split('.').pop()?.toLowerCase() ?? 'file',
    // Synthetic File for compatibility with VaultFile's required `file` field.
    // Persistent-mode files don't carry a real File reference because the
    // server already has the bytes; the UI never reads .file in this mode.
    file: new File([], name),
    status: mapStatus(doc.processing_status),
    stage: stageOf(doc.processing_status),
    held: doc.processing_status === 'held' || undefined,
    errorMessage: doc.processing_error ?? undefined,
    matterspace_id: doc.matterspace_id,
    matterspace_name,
    storagePath: doc.storage_path ?? undefined,
    textStatus: doc.processing_status === 'ready' ? (doc.text_status ?? undefined) : undefined,
    ocrPending: doc.processing_status === 'ready' && doc.ocr_pending && typeof doc.ocr_pending === 'object'
      ? (doc.ocr_pending as OcrPending) : undefined,
  };
}

function mapStatus(s: string): VaultFile['status'] {
  if (s === 'ready') return 'indexed';
  if (s === 'error') return 'error';
  // 'held' (lib/seal-pipes.mjs): a SecureSpace refused to send this file to
  // an outside provider. Terminal, with the reason in processing_error —
  // before this it mapped to 'uploading' and spun forever. VaultFile.held
  // travels alongside so the panel can say "Held" and withhold Retry.
  if (s === 'held') return 'error';
  if (s === 'embedding') return 'indexing';
  // pending, extracting, chunking → uploading bucket from the UI's POV; the
  // stage itself travels alongside (stageOf) so the label can say which.
  return 'uploading';
}

// The raw pipeline stage while non-terminal (pending / extracting / chunking /
// embedding — or whatever a newer pipeline writes, shown by name).
function stageOf(s: string): string | undefined {
  if (s === 'ready' || s === 'error' || s === 'held') return undefined;
  return s || undefined;
}

function formatSize(bytes: number): string {
  if (bytes > 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes > 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}


// -----------------------------------------------------------------------------
// Pre-upload admissibility — decided at SELECTION time, before any bytes move.
// Three refusals, each with a message written for the person who chose the
// file: over the storage cap, a type the pipeline cannot read, and a duplicate
// (same matter + filename + size — refused, not linked: Eden's decision,
// 2026-09-04, and the answer names the copy that already exists).
// -----------------------------------------------------------------------------
export type VaultRefusal = UploadRefusal | { code: 'duplicate'; message: string; existingId: string };

export async function checkUploadAdmissible(matter: MatterRef, file: File): Promise<VaultRefusal | null> {
  const local = checkUpload({ name: file.name, size: file.size });
  if (local) return local;
  // Only a copy whose bytes actually landed counts. A row with no storage_path
  // is an upload that never finished (tab closed, network drop); the recovery
  // sweep marks it "upload it again", and refusing that re-upload as a
  // duplicate would be a dead end.
  const { data, error } = await supabase
    .from('documents')
    .select('id, title, created_at, processing_status')
    .eq('matterspace_id', matter.id)
    .eq('source_filename', file.name)
    .eq('file_size_bytes', file.size)
    .not('storage_path', 'is', null)
    .order('created_at', { ascending: true })
    .limit(1);
  // A failed lookup must not block the upload: the server-side paths keep
  // their own guard, and "couldn't check" is not "is a duplicate".
  if (error || !data || data.length === 0) return null;
  const dup = data[0];
  const when = dup.created_at
    ? new Date(dup.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : 'an earlier date';
  const state = dup.processing_status === 'error' ? ' (that copy failed — use Retry on it)' : '';
  return {
    code: 'duplicate',
    existingId: dup.id,
    message: `"${file.name}" is already filed as "${dup.title || file.name}" on ${when}${state}. ` +
      'Use that copy, or delete it first to replace it.',
  };
}


// -----------------------------------------------------------------------------
// Upload a file + create documents row + trigger ingestion.
// Returns the new document id immediately (UI can show "uploading" right away);
// processing happens server-side and the caller polls via watchDocumentStatus.
// -----------------------------------------------------------------------------
export interface PersistOptions {
  /** Upload progress, reported only on the resumable path (files of 50 MB and up). */
  onProgress?: (p: UploadProgress) => void;
}

export async function persistVaultFile(
  matter: MatterRef,
  file: File,
  opts: PersistOptions = {},
): Promise<{ documentId: string; storagePath: string }> {
  const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
  const safeName = sanitizeStorageName(file.name);
  const title = file.name.replace(/\.[^.]+$/, '');

  // 1. Insert documents row to get an id (storage path needs it)
  const { data: doc, error: insErr } = await supabase
    .from('documents')
    .insert({
      matterspace_id: matter.id,
      title,
      doc_type: 'other', // until migration 007 lands with 'book'
      source_filename: file.name,
      file_size_bytes: file.size,
      processing_status: 'pending',
      created_by: (await supabase.auth.getUser()).data.user?.id,
    })
    .select('id')
    .single();
  if (insErr) throw new Error(`create document: ${insErr.message}`);

  // 2. Upload to vault-documents storage. A large file (50 MB and up) goes
  //    up in resumable 6 MB chunks: a dropped connection continues from the
  //    last byte the server has, and a closed tab resumes on the next try
  //    (the upload URL is remembered for a day). Small files keep the one
  //    request they always used.
  const storagePath = `${matter.id}/${doc.id}/${safeName}`;
  const contentType = file.type || mimeFor(ext);
  let upErr: { message: string } | null = null;
  if (shouldUploadResumable(file.size)) {
    try {
      const session = (await supabase.auth.getSession()).data.session;
      if (!session?.access_token) throw new Error('not authenticated');
      await uploadResumable({
        supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? '',
        token: session.access_token,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? null,
        bucket: 'vault-documents',
        objectName: storagePath,
        blob: file,
        contentType,
        lastModified: file.lastModified,
        resumeStore: storageResumeStore(typeof localStorage !== 'undefined' ? localStorage : null),
        onProgress: opts.onProgress,
      });
    } catch (err) {
      upErr = { message: err instanceof Error ? err.message : String(err) };
    }
  } else {
    const { error } = await supabase.storage
      .from('vault-documents')
      .upload(storagePath, file, { contentType, upsert: true });
    upErr = error;
  }
  if (upErr) {
    // Roll back the documents row so the UI doesn't show a broken stub.
    await supabase.from('documents').delete().eq('id', doc.id);
    throw new Error(`upload: ${upErr.message}`);
  }
  await supabase
    .from('documents')
    .update({ storage_path: storagePath })
    .eq('id', doc.id);

  // 3. Fire the server-side ingestion. Don't await the full pipeline — it
  // runs server-side and updates documents.processing_status as it goes.
  // The caller uses watchDocumentStatus() to track progress.
  const session = (await supabase.auth.getSession()).data.session;
  const accessToken = session?.access_token;
  if (!accessToken) {
    throw new Error('not authenticated — cannot trigger ingest');
  }
  // Don't await; the API call can take 30-60s for large docs and we want the
  // UI thread back immediately. Errors are surfaced via document status.
  fetch('/api/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ documentId: doc.id }),
  }).catch((err) => {
    console.error('ingest fetch:', err);
  });

  return { documentId: doc.id, storagePath };
}


// -----------------------------------------------------------------------------
// Poll a document's status until it reaches a terminal state (ready/error).
// Returns a cleanup function that stops the poll early.
// -----------------------------------------------------------------------------
export interface DocumentStatusUpdate {
  status: VaultFile['status'];
  errorMessage?: string;
  /** Raw pipeline stage while non-terminal (see VaultFile.stage). */
  stage?: string;
  /** Recorded reason for a ready document with no text (VaultFile.textStatus). */
  textStatus?: string;
  /** Pages a ready PDF still owes OCR (VaultFile.ocrPending). */
  ocrPending?: OcrPending;
  /** True when the SecureSpace held the document (VaultFile.held). */
  held?: boolean;
}

export function watchDocumentStatus(
  documentId: string,
  onUpdate: (update: DocumentStatusUpdate) => void,
  intervalMs = 2000
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    const { data, error } = await supabase
      .from('documents')
      .select('processing_status, processing_error, text_status:metadata->>text_status, ocr_pending:metadata->ocr_pending')
      .eq('id', documentId)
      .maybeSingle();
    if (stopped) return;
    if (error || !data) {
      onUpdate({ status: 'error', errorMessage: error?.message || 'document disappeared' });
      return;
    }
    const uiStatus = mapStatus(data.processing_status);
    onUpdate({
      status: uiStatus,
      errorMessage: data.processing_error || undefined,
      stage: stageOf(data.processing_status),
      textStatus: data.processing_status === 'ready' ? ((data as { text_status?: string | null }).text_status ?? undefined) : undefined,
      ocrPending: data.processing_status === 'ready' && typeof (data as { ocr_pending?: unknown }).ocr_pending === 'object'
        ? ((data as { ocr_pending?: OcrPending | null }).ocr_pending ?? undefined) : undefined,
      held: data.processing_status === 'held' || undefined,
    });
    if (uiStatus === 'indexed' || uiStatus === 'error') return;
    timer = setTimeout(tick, intervalMs);
  };
  tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}


// -----------------------------------------------------------------------------
// Move a document to a different matter. Calls /api/move-document, which
// performs the multi-step (storage rename, documents row, passages denorm)
// under the user's session token so RLS enforces both matters' membership.
// -----------------------------------------------------------------------------
export async function moveVaultDocument(
  documentId: string,
  newMatterspaceId: string,
): Promise<void> {
  const session = (await supabase.auth.getSession()).data.session;
  const accessToken = session?.access_token;
  if (!accessToken) throw new Error('not authenticated');
  const res = await fetch('/api/move-document', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ documentId, newMatterspaceId }),
  });
  if (!res.ok) {
    let msg = `move failed: ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
}


// -----------------------------------------------------------------------------
// Delete a document: removes documents row (cascades passages) + storage file.
// -----------------------------------------------------------------------------
export async function deleteVaultDocument(documentId: string): Promise<void> {
  // Look up storage_path before delete, since the row is about to vanish.
  const { data: doc } = await supabase
    .from('documents')
    .select('storage_path')
    .eq('id', documentId)
    .maybeSingle();

  const { error } = await supabase.from('documents').delete().eq('id', documentId);
  if (error) throw new Error(`delete document: ${error.message}`);

  if (doc?.storage_path) {
    await supabase.storage.from('vault-documents').remove([doc.storage_path]);
  }
}


// -----------------------------------------------------------------------------
// Open / edit a document's original bytes (persistent mode).
// -----------------------------------------------------------------------------

// Download the original file the user uploaded for this document.
export async function downloadVaultDocument(storagePath: string): Promise<Blob> {
  const { data, error } = await supabase.storage
    .from('vault-documents')
    .download(storagePath);
  if (error || !data) throw new Error(`download: ${error?.message ?? 'no data returned'}`);
  return data;
}

// Overwrite a text document's bytes in storage, then re-run ingestion so the
// search index (passages + embeddings) reflects the edit. Old passages are
// cleared first because the ingest pipeline only inserts. The caller should
// re-subscribe via watchDocumentStatus(documentId) to follow re-indexing.
export async function saveVaultDocumentText(
  documentId: string,
  storagePath: string,
  text: string,
  contentType = 'text/plain',
): Promise<void> {
  const blob = new Blob([text], { type: contentType });
  const { error: upErr } = await supabase.storage
    .from('vault-documents')
    .upload(storagePath, blob, { contentType, upsert: true });
  if (upErr) throw new Error(`save: ${upErr.message}`);

  // Reset the row so /api/ingest doesn't short-circuit on processing_status === 'ready'.
  await supabase
    .from('documents')
    .update({ file_size_bytes: blob.size, processing_status: 'pending', processing_error: null })
    .eq('id', documentId);
  await supabase.from('passages').delete().eq('document_id', documentId);

  triggerIngest(documentId).catch((err) => console.error('re-ingest:', err));
}

// Fire the server-side ingestion pipeline for an already-uploaded document.
// Does not await the full pipeline; progress lands in documents.processing_status.
export async function triggerIngest(documentId: string): Promise<void> {
  const session = (await supabase.auth.getSession()).data.session;
  const accessToken = session?.access_token;
  if (!accessToken) throw new Error('not authenticated — cannot trigger ingest');
  await fetch('/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ documentId }),
  });
}


// -----------------------------------------------------------------------------
// Path/MIME helpers (mirror scripts/ingest.mjs)
// -----------------------------------------------------------------------------
function sanitizeStorageName(name: string): string {
  return name
    .replace(/[\[\]{}]/g, '')
    .replace(/[^\w/!\-.*'() ]/g, '_')
    .replace(/_+/g, '_');
}

function mimeFor(ext: string): string {
  const m: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return m[ext] || 'application/octet-stream';
}
