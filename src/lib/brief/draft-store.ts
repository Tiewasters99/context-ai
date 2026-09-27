// The Brief Desk's persistence: load, autosave, snapshot, restore, export.
//
// docs/specs/BRIEF-DESK-2026-09-26.md §3.1, §3.2, §3.6. Everything runs under
// the person's own session, so migration 100's RLS decides every write.
//
//   • Autosave writes draft_bodies only, with `updated_at` as an optimistic
//     lock: the update carries `.eq('updated_at', <what this tab loaded>)`,
//     and a save that matches no row is reported as "changed elsewhere" —
//     never an overwrite. The database moves the clock (100's trigger).
//     Autosave records nothing in the Record.
//   • A snapshot freezes body + body_md (the database fingerprints it), writes
//     `draft.snapshot`, and then publishes the text so the rest of the product
//     reads the latest words: body_md goes to a NEW storage object per
//     snapshot (`<matter>/<doc>/brief-<snapshot>.md` — no filed object is
//     ever overwritten; the old objects are the history's bytes), the
//     documents row points at it, and ingestion re-runs. §3.1's "sanctioned
//     overwrite" is therefore not needed.
//   • Export (D1: Markdown and Word) takes a snapshot first and records
//     `draft.exported`. On a SEALED matter it refuses: §3.6 routes a sealed
//     export through a server endpoint and the export gate, which arrive in
//     D4, and a download built in this browser cannot be gated.

import { supabase } from '@/lib/supabase';
import { triggerIngest } from '@/lib/vault-persist';
import { storageObjectBlob } from '@/lib/vault-object';
import { effectiveTier } from '@/lib/agent-charters';
import { serialize, emptyBrief, type BriefDoc } from './md';

export interface BriefMeta {
  id: string;
  title: string;
  matterspace_id: string;
  doc_type: string;
  storage_path: string | null;
  source_filename: string | null;
  metadata: Record<string, unknown> | null;
}

export interface BriefBody {
  body: BriefDoc;
  body_md: string;
  updated_at: string;
}

export interface SnapshotRow {
  id: string;
  label: string | null;
  sha256: string;
  created_at: string;
  created_by: string;
}

export type SaveResult =
  | { ok: true; updated_at: string }
  | { ok: false; conflict: true }
  | { ok: false; conflict?: false; error: string };

const DOC_COLUMNS = 'id, title, matterspace_id, doc_type, storage_path, source_filename, metadata';

async function uid(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  const id = data.user?.id;
  if (!id) throw new Error('You are signed out. Sign in again to keep working on this brief.');
  return id;
}

export async function recordEvent(kind: 'draft.snapshot' | 'draft.exported' | 'cite.checked', matterId: string, payload: Record<string, unknown>) {
  try {
    const { record } = await import('../../../lib/ledger.mjs');
    const user = (await supabase.auth.getUser()).data.user;
    await record(supabase, {
      kind,
      matterId,
      actor: { kind: 'user', ref: user?.id ?? null, user_id: user?.id ?? null },
      payload,
    });
  } catch (err) {
    // The Record is not the brief: a ledger that is not deployed never stops a save.
    console.warn(`[brief] ${kind} not recorded:`, err);
  }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
export async function loadBrief(documentId: string): Promise<{ meta: BriefMeta; body: BriefBody | null }> {
  const { data: meta, error } = await supabase.from('documents').select(DOC_COLUMNS).eq('id', documentId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!meta) throw new Error('This document is not in a matter you can open.');
  const { data: body, error: bErr } = await supabase
    .from('draft_bodies')
    .select('body, body_md, updated_at')
    .eq('document_id', documentId)
    .maybeSingle();
  if (bErr && !/draft_bodies/.test(bErr.message)) throw new Error(bErr.message);
  return { meta: meta as BriefMeta, body: (body as BriefBody | null) ?? null };
}

/** True when a document has an editable body (the Reader redirects to the desk). */
export async function hasDraftBody(documentId: string): Promise<boolean> {
  const { data, error } = await supabase.from('draft_bodies').select('document_id').eq('document_id', documentId).maybeSingle();
  return !error && !!data;
}

// ---------------------------------------------------------------------------
// Create and save
// ---------------------------------------------------------------------------
export async function createBody(documentId: string, body: BriefDoc): Promise<BriefBody> {
  const me = await uid();
  const body_md = serialize(body);
  const { data, error } = await supabase
    .from('draft_bodies')
    .insert({ document_id: documentId, body, body_md, updated_by: me })
    .select('body, body_md, updated_at')
    .single();
  if (error) throw new Error(`The brief could not be opened for editing: ${error.message}`);
  return data as BriefBody;
}

export async function saveBody(documentId: string, body: BriefDoc, expectedUpdatedAt: string): Promise<SaveResult> {
  let me: string;
  try { me = await uid(); } catch (e) { return { ok: false, error: (e as Error).message }; }
  const body_md = serialize(body);
  const { data, error } = await supabase
    .from('draft_bodies')
    .update({ body, body_md, updated_by: me })
    .eq('document_id', documentId)
    .eq('updated_at', expectedUpdatedAt)
    .select('updated_at');
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, conflict: true };
  return { ok: true, updated_at: (data[0] as { updated_at: string }).updated_at };
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------
export async function listSnapshots(documentId: string): Promise<SnapshotRow[]> {
  const { data, error } = await supabase
    .from('draft_snapshots')
    .select('id, label, sha256, created_at, created_by')
    .eq('document_id', documentId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []) as SnapshotRow[];
}

export async function loadSnapshot(snapshotId: string): Promise<{ body: BriefDoc; body_md: string; label: string | null; sha256: string }> {
  const { data, error } = await supabase
    .from('draft_snapshots')
    .select('body, body_md, label, sha256')
    .eq('id', snapshotId)
    .single();
  if (error) throw new Error(error.message);
  return data as { body: BriefDoc; body_md: string; label: string | null; sha256: string };
}

export interface Snapshot { id: string; sha256: string; body_md: string; label: string | null }

/**
 * Freeze the current body. Returns the snapshot; `published` says whether the
 * text reached search and the Reader (a failure there never loses the snapshot).
 */
export async function takeSnapshot(
  meta: BriefMeta,
  body: BriefDoc,
  label: string | null,
): Promise<Snapshot & { published: boolean; publishError?: string }> {
  const me = await uid();
  const body_md = serialize(body);
  const { data, error } = await supabase
    .from('draft_snapshots')
    .insert({ document_id: meta.id, label, body, body_md, sha256: '', created_by: me })
    .select('id, sha256, label')
    .single();
  if (error) throw new Error(`The version could not be saved: ${error.message}`);
  const snap = data as { id: string; sha256: string; label: string | null };
  await recordEvent('draft.snapshot', meta.matterspace_id, {
    document_id: meta.id, snapshot_id: snap.id, sha256: snap.sha256, label: snap.label,
  });
  try {
    await publishSnapshot(meta, snap.id, body_md);
    return { ...snap, body_md, published: true };
  } catch (err) {
    return { ...snap, body_md, published: false, publishError: (err as Error).message };
  }
}

function safeFileTitle(title: string): string {
  return (title || 'Brief').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Brief';
}

/** The latest words, where search, grep, get_passage and the Reader look. */
async function publishSnapshot(meta: BriefMeta, snapshotId: string, bodyMd: string): Promise<void> {
  const blob = new Blob([bodyMd], { type: 'text/markdown' });
  // A NEW object (upsert: false): 096's read policy admits the row this upload
  // writes, so the upload stays direct on sealed matters too. Uploads are not
  // reads; vault-object.ts covers reads.
  const storagePath = `${meta.matterspace_id}/${meta.id}/brief-${snapshotId}.md`;
  const { error: upErr } = await supabase.storage
    .from('vault-documents')
    .upload(storagePath, blob, { contentType: 'text/markdown', upsert: false });
  if (upErr) throw new Error(`upload: ${upErr.message}`);
  const prior = meta.source_filename ?? null;
  const metadata = {
    ...(meta.metadata ?? {}),
    brief_snapshot_id: snapshotId,
    // The name it arrived under (a Word file, say) outlives the switch to .md.
    ...(prior && !/\.md$/i.test(prior) && !(meta.metadata ?? {}).original_filename ? { original_filename: prior } : {}),
  };
  const source_filename = `${safeFileTitle(meta.title)}.md`;
  const { error: docErr } = await supabase
    .from('documents')
    .update({
      storage_path: storagePath,
      source_filename,
      file_size_bytes: blob.size,
      processing_status: 'pending',
      processing_error: null,
      metadata,
    })
    .eq('id', meta.id);
  if (docErr) throw new Error(`document: ${docErr.message}`);
  meta.storage_path = storagePath;
  meta.source_filename = source_filename;
  meta.metadata = metadata;
  // The pipeline only inserts passages; clear the old ones first, as
  // saveVaultDocumentText does.
  await supabase.from('passages').delete().eq('document_id', meta.id);
  await triggerIngest(meta.id);
}

/** Put a snapshot's words back. What it replaces is snapshotted first. */
export async function restoreSnapshot(
  meta: BriefMeta,
  snapshotId: string,
  current: BriefDoc,
  expectedUpdatedAt: string,
): Promise<{ result: SaveResult; body: BriefDoc }> {
  const snap = await loadSnapshot(snapshotId);
  await takeSnapshot(meta, current, `before restoring ${snap.label ?? snap.sha256.slice(0, 8)}`);
  const result = await saveBody(meta.id, snap.body, expectedUpdatedAt);
  return { result, body: snap.body };
}

// ---------------------------------------------------------------------------
// New brief; import one
//
// Every way in ends the same: a NEW brief document in a matter, with its own
// editable body and a first version. A filed document is never turned into a
// draft in place — an opposing brief, a filed copy, a client's original stays
// exactly as it was filed; the brief that opens in the desk is a copy of its
// words, in the SAME matter (so nothing crosses a seal), and says where it came
// from in `metadata.source_document_id`. A file from disk keeps its original
// bytes beside the editable text (`metadata.original_storage_path`).
// ---------------------------------------------------------------------------
export async function createBrief(
  matterId: string,
  title: string,
  body: BriefDoc = emptyBrief(),
  metadata: Record<string, unknown> | null = null,
): Promise<string> {
  const me = await uid();
  const cleanTitle = title.trim() || 'Untitled brief';
  const { data, error } = await supabase
    .from('documents')
    .insert({
      matterspace_id: matterId,
      title: cleanTitle,
      doc_type: 'brief',
      // Shelved with the pleadings (spec §3.1).
      category: 'pleading',
      source_filename: `${safeFileTitle(cleanTitle)}.md`,
      file_size_bytes: 0,
      processing_status: 'pending',
      created_by: me,
      ...(metadata ? { metadata } : {}),
    })
    .select(DOC_COLUMNS)
    .single();
  if (error) throw new Error(`The brief could not be created: ${error.message}`);
  const meta = data as BriefMeta;
  await createBody(meta.id, body);
  // First version at once, so the brief has bytes, a Reader view and search.
  await takeSnapshot(meta, body, 'created');
  return meta.id;
}

export interface RecentBrief {
  id: string;
  title: string;
  matterspace_id: string;
  updated_at: string;
}

/** The briefs you can open, most recently edited first (RLS decides "can"). */
export async function listRecentBriefs(limit = 40): Promise<RecentBrief[]> {
  const { data, error } = await supabase
    .from('draft_bodies')
    .select('document_id, updated_at, documents!inner(title, matterspace_id)')
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  type Row = { document_id: string; updated_at: string; documents: { title: string | null; matterspace_id: string } | { title: string | null; matterspace_id: string }[] };
  return ((data ?? []) as Row[]).map((r) => {
    const d = Array.isArray(r.documents) ? r.documents[0] : r.documents;
    return { id: r.document_id, title: d?.title || 'Untitled brief', matterspace_id: d?.matterspace_id ?? '', updated_at: r.updated_at };
  });
}

export interface ImportResult {
  id: string;
  /** What did not come across (B2), shown once on arrival. */
  losses: string[];
  /** The document already had a body: it was opened, not imported again. */
  existing?: boolean;
}

/** A file from this computer (Downloads, a synced OneDrive folder, a drag onto the desk) → a brief in the matter. */
export async function importBriefFile(matterId: string, file: File): Promise<ImportResult> {
  const { importBytes, titleFrom } = await import('./import');
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    // Windows will not hand over an online-only OneDrive file until it syncs.
    throw new Error(`“${file.name}” could not be read. If it lives in OneDrive, right-click it and choose “Always keep on this device”, then try again.`);
  }
  const { doc, losses } = await importBytes(file.name, bytes);
  const id = await createBrief(matterId, titleFrom(file.name), doc, {
    imported_from: 'file',
    original_filename: file.name,
  });
  // The original, as received, beside the editable text. A failure here never
  // loses the brief; the words are already in it.
  const path = `${matterId}/${id}/original-${safeFileTitle(titleFrom(file.name))}${/\.[a-z0-9]+$/i.exec(file.name)?.[0] ?? ''}`;
  const up = await supabase.storage.from('vault-documents').upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (!up.error) {
    const { data: row } = await supabase.from('documents').select('metadata').eq('id', id).maybeSingle();
    const metadata = { ...((row as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}), original_storage_path: path };
    await supabase.from('documents').update({ metadata }).eq('id', id);
  }
  return { id, losses };
}

/**
 * A document already in Contextspaces → a brief. A document that already has
 * a body just opens. Otherwise a copy of its words becomes a new brief in the
 * document's own matter: a Word, Markdown or text file is read from its file
 * (footnotes and headings survive); anything else (a PDF) from its indexed
 * text, and the brief says so.
 */
export async function importBriefFromDocument(documentId: string): Promise<ImportResult> {
  if (await hasDraftBody(documentId)) return { id: documentId, losses: [], existing: true };
  const { data, error } = await supabase.from('documents').select(DOC_COLUMNS).eq('id', documentId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('This document is not in a matter you can open.');
  const src = data as BriefMeta;
  const { kindOf, importBytes, importIndexedText } = await import('./import');
  const kind = kindOf(src.source_filename ?? src.storage_path ?? '');
  let imported: { doc: BriefDoc; losses: string[] };
  if ((kind === 'docx' || kind === 'md' || kind === 'txt') && src.storage_path) {
    // Through vault-object.ts like every other read (S4a): direct on an
    // unsealed matter; on a sealed one via /api/document-url, which records
    // `file.opened` and asks for the second factor first.
    let blob: Blob;
    try {
      blob = await storageObjectBlob(src.storage_path);
    } catch (e) {
      throw new Error(`The file could not be read: ${e instanceof Error ? e.message : 'no data'}`);
    }
    imported = await importBytes(src.source_filename ?? src.storage_path, await blob.arrayBuffer());
  } else {
    const { loadCorpusDocumentText } = await import('@/lib/cite-check/corpus');
    const { text } = await loadCorpusDocumentText(documentId);
    imported = importIndexedText(text);
  }
  const id = await createBrief(src.matterspace_id, src.title || 'Untitled brief', imported.doc, {
    imported_from: 'contextspaces',
    source_document_id: src.id,
    ...(src.source_filename ? { original_filename: src.source_filename } : {}),
  });
  return { id, losses: imported.losses };
}

// ---------------------------------------------------------------------------
// Export (D1: Markdown and Word; Send to your assistant is D4)
// ---------------------------------------------------------------------------
export async function sealedRefusal(matterId: string): Promise<string | null> {
  const tier = await effectiveTier(matterId).catch(() => null);
  if (tier === 'A') return null;
  if (tier === null) {
    return 'The matter’s seal could not be confirmed, so nothing was exported. Try again in a moment.';
  }
  return 'This matter is sealed. Exports from a sealed matter go through the export gate, which the desk does not have yet; the brief stays in the matter.';
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function exportBrief(
  meta: BriefMeta,
  body: BriefDoc,
  destination: 'md' | 'docx',
): Promise<{ ok: true; snapshot: Snapshot } | { ok: false; message: string }> {
  const refusal = await sealedRefusal(meta.matterspace_id);
  if (refusal) return { ok: false, message: refusal };
  const count = (await listSnapshots(meta.id).catch(() => [])).length;
  const snap = await takeSnapshot(meta, body, `exported as ${destination === 'md' ? 'Markdown' : 'Word'}`);
  const base = `${safeFileTitle(meta.title)} — v${count + 1}`;
  if (destination === 'md') {
    download(new Blob([snap.body_md], { type: 'text/markdown' }), `${base}.md`);
  } else {
    const { briefToDocxBlob } = await import('./export-docx');
    download(await briefToDocxBlob(body, meta.title), `${base}.docx`);
  }
  await recordEvent('draft.exported', meta.matterspace_id, {
    document_id: meta.id, snapshot_id: snap.id, destination,
  });
  return { ok: true, snapshot: snap };
}
