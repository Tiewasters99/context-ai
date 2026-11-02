// A document's versions: the .docx as Word saved it, each time
// (docs/specs/WORD-ROUNDTRIP-2026-11-01.md; migration 127).
//
// One documents row, many objects. `saveDocxVersion` stores the bytes as a
// NEW object under the document, writes the document_versions row, repoints
// the documents row at the new object and has it read again, and tells the
// matter's Record. `createDocxDocument` is the first Save of a document that
// is not in Equazia yet: the documents row, then the same save.

import { supabase } from '@/lib/supabase';
import { triggerIngest } from '@/lib/vault-persist';
import { writeDocxTag } from '@/lib/docx-tag';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface DocumentVersion {
  id: string;
  document_id: string;
  label: string;
  storage_path: string;
  filename: string;
  file_size_bytes: number | null;
  sha256: string | null;
  source: 'word' | 'upload' | 'desk';
  note: string | null;
  created_by: string;
  created_at: string;
}

const COLS = 'id, document_id, label, storage_path, filename, file_size_bytes, sha256, source, note, created_by, created_at';

/** Newest first. An undeployed table (127 not pasted) reads as no versions. */
export async function listVersions(documentId: string): Promise<DocumentVersion[]> {
  const { data, error } = await supabase.from('document_versions').select(COLS)
    .eq('document_id', documentId).order('created_at', { ascending: false }).limit(200);
  if (error) {
    if (tableMissing(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as DocumentVersion[];
}

/** "v.3" after "v.2"; "v.2" for a document with an original and no versions; "v.1" for a new one. */
export function nextVersionLabel(versions: DocumentVersion[], hasOriginal: boolean): string {
  let max = 0;
  for (const v of versions) {
    const m = /^v\.?\s*(\d+)/i.exec(v.label.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  if (max > 0) return `v.${max + 1}`;
  return hasOriginal ? 'v.2' : 'v.1';
}

const NOT_DEPLOYED = 'Versions are not switched on in this database yet (migration 127).';
const tableMissing = (e: { code?: string; message: string }) => e.code === '42P01' || e.code === 'PGRST205' || /document_versions/.test(e.message);

/** Refuse before anything is written when 127 is not pasted: no orphan rows. */
async function ensureVersionsTable(): Promise<void> {
  const { error } = await supabase.from('document_versions').select('id').limit(0);
  if (error && tableMissing(error)) throw new Error(NOT_DEPLOYED);
}

async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

function safeName(name: string): string {
  return name.replace(/[[\]{}]/g, '').replace(/[^\w/!\-.*'() ]/g, '_').replace(/_+/g, '_').trim().replace(/^\.{1,2}$/, '_') || 'file';
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function recordFiled(matterId: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const { record } = await import('../../lib/ledger.mjs');
    const user = (await supabase.auth.getUser()).data.user;
    await record(supabase, { kind: 'file.filed', matterId, actor: { kind: 'user', ref: user?.id ?? null, user_id: user?.id ?? null }, payload });
  } catch (err) {
    console.warn('[versions] file.filed not recorded:', err);
  }
}

export interface SaveVersionInput {
  documentId: string;
  bytes: Uint8Array;
  /** The name Word has for the file; becomes the document's source_filename. */
  filename: string;
  label: string;
  note?: string | null;
  source?: DocumentVersion['source'];
}

/**
 * Store these bytes as the document's newest version. The bytes are tagged
 * with the document's id first, so a copy of the saved file knows its home.
 */
export async function saveDocxVersion(input: SaveVersionInput): Promise<DocumentVersion> {
  const label = input.label.trim().slice(0, 80);
  if (!label) throw new Error('Give the version a label (v.2, as sent, …).');
  await ensureVersionsTable();
  const filename = /\.docx$/i.test(input.filename) ? input.filename : `${input.filename}.docx`;

  // The row as the user: RLS decides it exists; its matter decides the path.
  const { data: row, error: rErr } = await supabase.from('documents')
    .select('id, matterspace_id, storage_path, metadata').eq('id', input.documentId).maybeSingle();
  if (rErr) throw new Error(rErr.message);
  if (!row) throw new Error('This document is not in a matter you can open.');
  const matterId = row.matterspace_id as string;

  const me = (await supabase.auth.getUser()).data.user?.id;
  if (!me) throw new Error('You are signed out. Sign in again to save.');

  const bytes = await writeDocxTag(input.bytes, { documentId: input.documentId, matterId });
  const sha256 = await sha256Hex(bytes);

  // A new object every time (096 refuses an overwrite on a sealed matter);
  // the label and the clock keep the name distinct and readable in the bucket.
  const base = safeName(filename.replace(/\.docx$/i, '')).slice(0, 100);
  const storagePath = `${matterId}/${input.documentId}/${base} (${safeName(label)} ${stamp()}).docx`;
  const { error: upErr } = await supabase.storage.from('vault-documents')
    .upload(storagePath, new Blob([bytes as BlobPart], { type: DOCX_MIME }), { contentType: DOCX_MIME, upsert: false });
  if (upErr) throw new Error(`The file could not be stored: ${upErr.message}`);

  const { data: ver, error: vErr } = await supabase.from('document_versions').insert({
    document_id: input.documentId, label, storage_path: storagePath, filename,
    file_size_bytes: bytes.length, sha256, source: input.source ?? 'word', note: input.note ?? null, created_by: me,
  }).select(COLS).single();
  if (vErr) throw new Error(tableMissing(vErr) ? NOT_DEPLOYED : `The version could not be recorded: ${vErr.message}`);

  // The newest object is the document: where the Reader, search and Confirm look.
  const metadata = { ...((row.metadata as Record<string, unknown> | null) ?? {}), editor: 'word', version_label: label };
  const { error: dErr } = await supabase.from('documents').update({
    storage_path: storagePath, source_filename: filename, file_size_bytes: bytes.length,
    processing_status: 'pending', processing_error: null, metadata,
  }).eq('id', input.documentId);
  if (dErr) throw new Error(`The document could not be updated: ${dErr.message}`);
  await supabase.from('passages').delete().eq('document_id', input.documentId);
  triggerIngest(input.documentId).catch((err) => console.warn('[versions] re-ingest:', err));

  const v = ver as DocumentVersion;
  await recordFiled(matterId, { document_id: input.documentId, version_id: v.id, label, sha256, source: v.source, filename });
  return v;
}

/**
 * The first Save of a document that is not in Equazia yet: a documents row
 * in the matter (title = the file name), then the version. Returns the id.
 */
export async function createDocxDocument(input: { matterId: string; bytes: Uint8Array; filename: string; label: string; docType?: string }): Promise<{ documentId: string; version: DocumentVersion }> {
  const filename = /\.docx$/i.test(input.filename) ? input.filename : `${input.filename}.docx`;
  const title = filename.replace(/\.docx$/i, '').trim() || 'Document from Word';
  const me = (await supabase.auth.getUser()).data.user?.id;
  if (!me) throw new Error('You are signed out. Sign in again to save.');
  await ensureVersionsTable();
  const { data: doc, error } = await supabase.from('documents').insert({
    matterspace_id: input.matterId, title, doc_type: input.docType ?? 'other', source_filename: filename,
    file_size_bytes: input.bytes.length, processing_status: 'pending', created_by: me, metadata: { editor: 'word' },
  }).select('id').single();
  // 53400: the account's storage ceiling (107); its message is for the person.
  if (error) throw new Error(error.code === '53400' ? error.message : `The document could not be created: ${error.message}`);
  const version = await saveDocxVersion({ documentId: doc.id, bytes: input.bytes, filename, label: input.label });
  return { documentId: doc.id, version };
}
