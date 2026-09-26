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
import { effectiveTier } from '@/lib/agent-charters';
import { parse, serialize, emptyBrief, type BriefDoc } from './md';

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

async function recordEvent(kind: 'draft.snapshot' | 'draft.exported', matterId: string, payload: Record<string, unknown>) {
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
// New brief; open an existing document in the desk
// ---------------------------------------------------------------------------
export async function createBrief(matterId: string, title: string, body: BriefDoc = emptyBrief()): Promise<string> {
  const me = await uid();
  const cleanTitle = title.trim() || 'Untitled brief';
  const { data, error } = await supabase
    .from('documents')
    .insert({
      matterspace_id: matterId,
      title: cleanTitle,
      doc_type: 'brief',
      source_filename: `${safeFileTitle(cleanTitle)}.md`,
      file_size_bytes: 0,
      processing_status: 'pending',
      created_by: me,
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

/**
 * A filed brief with no editable body yet: read its file and create one.
 * Word files come in with the loss list (B2); Markdown and plain text through
 * the dialect.
 */
export async function openInDesk(meta: BriefMeta): Promise<{ body: BriefBody; losses: string[] }> {
  if (!meta.storage_path) throw new Error('This document has no file to open yet.');
  const { data: blob, error } = await supabase.storage.from('vault-documents').download(meta.storage_path);
  if (error || !blob) throw new Error(`The file could not be read: ${error?.message ?? 'no data'}`);
  const name = (meta.source_filename ?? meta.storage_path).toLowerCase();
  let doc: BriefDoc;
  let losses: string[] = [];
  if (name.endsWith('.docx')) {
    const { importDocx } = await import('./import-docx');
    ({ doc, losses } = await importDocx(await blob.arrayBuffer()));
  } else if (name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.txt')) {
    doc = parse(await blob.text());
  } else {
    throw new Error('Only Word (.docx), Markdown and text briefs open in the desk. A PDF is a picture of a brief, not its words.');
  }
  const body = await createBody(meta.id, doc);
  return { body, losses };
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
