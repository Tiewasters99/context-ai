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
export async function resolveMatter(key: string): Promise<MatterRef | null> {
  // Pull the serverspace name in the same round-trip so the Vault can
  // render a breadcrumb without a second query.
  const sel = 'id, name, short_code, cover_url, serverspace_id, parent_matterspace_id, serverspace:serverspaces(name)';
  const { data } = UUID_RE.test(key)
    ? await supabase.from('matterspaces').select(sel).eq('id', key).maybeSingle()
    : await supabase.from('matterspaces').select(sel).eq('short_code', key).maybeSingle();
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
  const { data, error } = await supabase
    .from('documents')
    .select('id, title, source_filename, file_size_bytes, processing_status, processing_error')
    .eq('matterspace_id', matterspaceId)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('listMatterDocuments:', error.message);
    return [];
  }
  return (data || []).map(documentToVaultFile);
}

function documentToVaultFile(doc: {
  id: string;
  title: string | null;
  source_filename: string | null;
  file_size_bytes: number | null;
  processing_status: string;
  processing_error: string | null;
}): VaultFile {
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
  };
}

function mapStatus(s: string): VaultFile['status'] {
  if (s === 'ready') return 'indexed';
  if (s === 'error') return 'error';
  if (s === 'embedding') return 'indexing';
  // pending, extracting, chunking → uploading bucket from the UI's POV
  return 'uploading';
}

function formatSize(bytes: number): string {
  if (bytes > 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes > 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}


// -----------------------------------------------------------------------------
// Upload a file + create documents row + trigger ingestion.
// Returns the new document id immediately (UI can show "uploading" right away);
// processing happens server-side and the caller polls via watchDocumentStatus.
// -----------------------------------------------------------------------------
export async function persistVaultFile(
  matter: MatterRef,
  file: File
): Promise<{ documentId: string }> {
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

  // 2. Upload to vault-documents storage
  const storagePath = `${matter.id}/${doc.id}/${safeName}`;
  const { error: upErr } = await supabase.storage
    .from('vault-documents')
    .upload(storagePath, file, {
      contentType: file.type || mimeFor(ext),
      upsert: true,
    });
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

  return { documentId: doc.id };
}


// -----------------------------------------------------------------------------
// Poll a document's status until it reaches a terminal state (ready/error).
// Returns a cleanup function that stops the poll early.
// -----------------------------------------------------------------------------
export function watchDocumentStatus(
  documentId: string,
  onUpdate: (status: VaultFile['status'], errorMessage?: string) => void,
  intervalMs = 2000
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    const { data, error } = await supabase
      .from('documents')
      .select('processing_status, processing_error')
      .eq('id', documentId)
      .maybeSingle();
    if (stopped) return;
    if (error || !data) {
      onUpdate('error', error?.message || 'document disappeared');
      return;
    }
    const uiStatus = mapStatus(data.processing_status);
    onUpdate(uiStatus, data.processing_error || undefined);
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
  };
  return m[ext] || 'application/octet-stream';
}
